import type * as AppServiceModule from './app-service';
import { execFileSync } from 'node:child_process';
import ownedProcess from './edu-owned-process.py?raw';
import appHelper from './app-helper.py?raw';
import { mkdtemp, writeFile, rm } from 'node:fs/promises';
import { createHash, randomUUID } from 'node:crypto';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { EDU_REQUIRED_FILES } from '@wsl/protocol';
import { emptyReferences } from './reference-test-fixture';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { GuestFrame, GuestStart } from './sbx';
import { ChatConversationSchema, type ChatServiceMessage, type ChatServiceRequest } from '@wsl/protocol';

const fixture = vi.hoisted(() => ({
  start: vi.fn(),
  initialize: vi.fn<() => Promise<void>>(async () => undefined),
  availableAfterInitialization: true,
  appShutdown: vi.fn<() => Promise<void>>(async () => undefined),
}));
vi.mock('./sbx', () => ({
  SbxConnection: class {
    private ready = false;
    initialize = async () => {
      await fixture.initialize();
      this.ready = true;
      return this.getStatus();
    };
    getStatus = () => ({
      available: this.ready && fixture.availableAfterInitialization,
      reason: !this.ready ? '正在检查 sbx…' : fixture.availableAfterInitialization ? null : 'offline',
      sandbox: 'fixture',
      version: this.ready ? 'fixture' : null,
      cwd: '/home/agent/workspace',
    });
    getCleanupPending = () => false;
    start = (...args: Parameters<typeof fixture.start>) => {
      if (!this.getStatus().available) throw new Error(this.getStatus().reason!);
      return fixture.start(...args);
    };
    shutdown = async () => undefined;
  },
}));
vi.mock('./app-service', async (original) => {
  const { AppService } = await original<typeof AppServiceModule>();
  return {
    AppService: class extends AppService {
      override shutdown = fixture.appShutdown;
    },
  };
});
vi.mock('./environment-resources', () => ({
  EnvironmentResources: class {
    shutdown = async () => undefined;
  },
}));

const initialArgv = process.argv;
const initialPort = Object.getOwnPropertyDescriptor(process, 'parentPort');
let signalListeners: NodeJS.SignalsListener[] = [];
const roots: string[] = [];
const completions: Promise<ChatServiceMessage>[] = [];
afterEach(async () => {
  await Promise.all(completions.splice(0));
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
  process.argv = initialArgv;
  for (const listener of process.listeners('SIGTERM')) if (!signalListeners.includes(listener)) process.removeListener('SIGTERM', listener);
  if (initialPort) Object.defineProperty(process, 'parentPort', initialPort);
  else Reflect.deleteProperty(process, 'parentPort');
  vi.clearAllMocks();
});
async function host(
  edu = false,
  journal?: string,
  control?: { initializationGate: Promise<void>; owner?: boolean; deferInitialized?: boolean; unavailable?: boolean },
) {
  fixture.availableAfterInitialization = !control?.unavailable;
  fixture.initialize.mockImplementation(async () => {
    if (control) await control.initializationGate;
  });
  vi.resetModules();
  signalListeners = process.listeners('SIGTERM');
  fixture.start.mockImplementation((_request: GuestStart, emit: (frame: GuestFrame) => void) => {
    queueMicrotask(() =>
      emit({
        type: 'output',
        stream: 'stdout',
        data:
          [
            { type: 'thread.started', thread_id: 'history-thread' },
            { type: 'item.completed', item: { id: 'reply', type: 'agent_message', text: 'history' } },
            { type: 'turn.completed' },
          ]
            .map((event) => JSON.stringify(event))
            .join('\n') + '\n',
      }),
    );
    return {
      done: Promise.resolve({ confirmed: true, error: null, exitCode: 0 }),
      close: async () => ({ confirmed: true, error: null, exitCode: 0 }),
    };
  });
  const messages: ChatServiceMessage[] = [];
  const responseWaiters = new Map<string, (message: ChatServiceMessage) => void>();
  const completion = (id: string) => {
    const received = messages.find((message) => (message.type === 'response' || message.type === 'error') && message.id === id);
    if (received) return Promise.resolve(received);
    const pending = new Promise<ChatServiceMessage>((resolve) => responseWaiters.set(id, resolve));
    completions.push(pending);
    return pending;
  };
  let receive!: (event: { data: unknown }) => void;
  Object.defineProperty(process, 'parentPort', {
    configurable: true,
    value: {
      on: (_: string, listener: typeof receive) => {
        receive = listener;
      },
      postMessage: (message: ChatServiceMessage) => {
        messages.push(message);
        if (message.type === 'response' || message.type === 'error') {
          responseWaiters.get(message.id)?.(message);
          responseWaiters.delete(message.id);
        }
      },
    },
  });
  const root = await mkdtemp(path.join(tmpdir(), 'wsl-service-admission-'));
  roots.push(root);
  const appInstanceId = randomUUID();
  const projectId = control ? randomUUID() : 'edu-project';
  let sourceSha256 = '';
  let sourceFiles: { path: string; base64: string }[] = [];
  if (edu) {
    const files = [...EDU_REQUIRED_FILES]
      .sort()
      .map((file) => ({ path: file, sha256: createHash('sha256').update('').digest('hex'), bytes: 0 }));
    const source = {
      repository: { commit: 'a'.repeat(40), dirty: false },
      files,
      sourceSha256: createHash('sha256').update(JSON.stringify(files)).digest('hex'),
    };
    sourceSha256 = source.sourceSha256;
    sourceFiles = files.map(({ path }) => ({ path, base64: '' }));
    await writeFile(
      path.join(root, 'app-registry.json'),
      JSON.stringify({
        version: control?.owner ? 3 : 2,
        sandbox: 'fixture',
        apps: [
          {
            workspaceId: 'taskflow-demo',
            projectId,
            cleanupConfirmed: !control?.owner,
            state: control?.owner ? 'running' : 'stopped',
            ...(control?.owner
              ? {
                  sourceSha256: source.sourceSha256,
                  appInstanceId,
                  url: null,
                  guestPort: null,
                  portPending: false,
                  portRemovalPending: false,
                  port: null,
                  processExpected: true,
                }
              : {}),
            profile: { projectKind: 'edu-web', profileVersion: 1, source },
          },
        ],
      }),
    );
  }
  if (journal !== undefined) await writeFile(path.join(root, 'edu-verification-recovery.json'), journal, { mode: 0o600 });
  process.argv = [initialArgv[0] ?? 'node', 'service', root];
  await import('./index');
  if (!control?.deferInitialized) await vi.waitFor(() => expect(messages.some((message) => message.type === 'initialized')).toBe(true));
  return {
    messages,
    completion,
    root,
    projectId,
    appInstanceId,
    sourceSha256,
    sourceFiles,
    request: (data: ChatServiceRequest) => receive({ data }),
  };
}
const conversationId = 'conv-space-taskflow-demo-impl';
describe('service request cancellation admission', () => {
  it.each(['cancel', 'shutdown'] as const)('%s bypasses queued sends before guest launch', async (method) => {
    const test = await host();
    test.request({ id: 'register', method: 'register', payload: { conversationId, workspaceId: 'taskflow-demo' } });
    test.request({ id: 'send', method: 'send', payload: { conversationId, text: 'pending', references: emptyReferences(conversationId) } });
    test.request(method === 'cancel' ? { id: 'stop', method, payload: { conversationId } } : { id: 'stop', method });
    await vi.waitFor(() => expect(test.messages.some((message) => message.type === 'response' && message.id === 'stop')).toBe(true));
    await vi.waitFor(() =>
      expect(test.messages.some((message) => (message.type === 'response' || message.type === 'error') && message.id === 'send')).toBe(
        true,
      ),
    );
    expect(fixture.start).not.toHaveBeenCalled();
  });
  it('revokes chat admission as soon as shutdown arrives while app cleanup is held', async () => {
    let release: () => void = () => {
      throw new Error('cleanup not entered');
    };
    fixture.appShutdown.mockImplementationOnce(
      () =>
        new Promise<void>((resolve) => {
          release = resolve;
        }),
    );
    const test = await host();
    test.request({
      id: 'send',
      method: 'send',
      payload: { conversationId: 'conv-personal-default', text: 'pending', references: emptyReferences('conv-personal-default') },
    });
    test.request({ id: 'shutdown', method: 'shutdown' });
    await vi.waitFor(() => expect(fixture.appShutdown).toHaveBeenCalledOnce());
    try {
      expect(fixture.start).not.toHaveBeenCalled();
    } finally {
      release();
    }
    await vi.waitFor(() => expect(test.messages.some((message) => message.type === 'response' && message.id === 'shutdown')).toBe(true));
  });
  it.each([false, true])('publishes a new cancelled receipt for queued sends with prior history=%s', async (history) => {
    const test = await host();
    test.request({ id: 'register', method: 'register', payload: { conversationId, workspaceId: 'taskflow-demo' } });
    const response = (id: string) => test.messages.find((message) => message.type === 'response' && message.id === id);
    if (history) {
      test.request({
        id: 'history',
        method: 'send',
        payload: { conversationId, text: 'history', references: emptyReferences(conversationId) },
      });
      await vi.waitFor(() =>
        expect(test.messages.some((message) => message.type === 'event' && message.conversation.state === 'idle')).toBe(true),
      );
    }
    test.request({ id: 'before', method: 'get', payload: { conversationId } });
    await vi.waitFor(() => expect(response('before')).toBeDefined());
    const prior = response('before');
    if (prior?.type !== 'response') throw new Error('missing before receipt');
    const before = ChatConversationSchema.parse(prior.result);
    test.request({
      id: 'queued',
      method: 'send',
      payload: { conversationId, text: 'must not start', references: emptyReferences(conversationId) },
    });
    test.request({ id: 'cancel', method: 'cancel', payload: { conversationId } });
    await vi.waitFor(() => expect(response('cancel')).toBeDefined());
    await vi.waitFor(() => expect(response('queued')).toBeDefined());
    const received = response('queued');
    if (received?.type !== 'response') throw new Error('missing queued receipt');
    const cancelled = ChatConversationSchema.parse(received.result);
    expect(cancelled).toMatchObject({ state: 'cancelled', cleanupPending: false });
    expect(cancelled.seq).toBeGreaterThan(before.seq);
    expect(cancelled.turnId).not.toBe(before.turnId);
    expect(fixture.start).toHaveBeenCalledTimes(history ? 1 : 0);
  });
});

it('rejects a real no-observation-scope send to a registered edu workspace at the service boundary', async () => {
  const test = await host(true);
  test.request({ id: 'register-edu', method: 'register', payload: { conversationId, workspaceId: 'taskflow-demo' } });
  await vi.waitFor(() => expect(test.messages.some((message) => message.type === 'response' && message.id === 'register-edu')).toBe(true));
  test.request({
    id: 'unbound-edu',
    method: 'send',
    payload: { conversationId, text: 'must not reach shared cwd', references: emptyReferences(conversationId, 'taskflow-demo') },
  });
  await vi.waitFor(() =>
    expect(
      test.messages.find((message) => (message.type === 'response' || message.type === 'error') && message.id === 'unbound-edu'),
    ).toMatchObject({ type: 'error', error: expect.stringContaining('frozen candidate workspace') }),
  );
  expect(fixture.start).not.toHaveBeenCalled();
});

it('verification synchronously revokes queued personal sends and terminal/app admissions', async () => {
  const test = await host();
  const personal = 'conv-personal-default';
  test.request({
    id: 'old-send',
    method: 'send',
    payload: { conversationId: personal, text: 'pending', references: emptyReferences(personal) },
  });
  test.request({
    id: 'lease',
    method: 'app.verification.begin',
    payload: { workspaceId: 'space', projectId: randomUUID(), appInstanceId: randomUUID(), sourceSha256: 'a'.repeat(64) },
  });
  test.request({
    id: 'new-send',
    method: 'send',
    payload: { conversationId: personal, text: 'new', references: emptyReferences(personal) },
  });
  test.request({ id: 'terminal', method: 'terminal.open', payload: { resourceId: 'not-open', cols: 80, rows: 24 } });
  test.request({
    id: 'write',
    method: 'terminal.write',
    payload: { resourceId: 'not-open', sessionId: 'session', data: 'echo forbidden' },
  });
  test.request({ id: 'start', method: 'app.start', payload: { workspaceId: 'space', projectId: randomUUID() } });
  await vi.waitFor(() => {
    for (const id of ['old-send', 'new-send', 'terminal', 'write', 'start'])
      expect(test.messages.some((m) => m.type === 'error' && m.id === id && m.error.startsWith('verification_'))).toBe(true);
  });
  expect(fixture.start).not.toHaveBeenCalled();
  expect(test.messages.some((m) => m.type === 'edu-verification-event' && m.status.phase === 'failed' && !m.status.maintenanceLocked)).toBe(
    true,
  );
});

it('invalid startup journal is visibly failed and denies requests before any guest launch', async () => {
  const test = await host(false, '{"unknown":true}');
  expect(test.messages.find((m) => m.type === 'initialized')).toMatchObject({
    type: 'initialized',
    status: { available: false, reason: 'verification_journal_invalid' },
    cleanupPending: true,
  });
  test.request({
    id: 'unsafe-send',
    method: 'send',
    payload: { conversationId: 'conv-personal-default', text: 'must not start', references: emptyReferences('conv-personal-default') },
  });
  test.request({ id: 'unsafe-stop', method: 'app.stop', payload: { workspaceId: 'space', projectId: randomUUID() } });
  await vi.waitFor(() => {
    for (const id of ['unsafe-send', 'unsafe-stop'])
      expect(test.messages.find((m) => m.type === 'error' && m.id === id)).toMatchObject({ error: 'verification_journal_invalid' });
  });
  expect(fixture.start).not.toHaveBeenCalled();
});

function pendingReady() {
  let release!: () => void;
  const promise = new Promise<void>((resolve) => {
    release = resolve;
  });
  return { promise, release };
}
it.each([false, true])(
  'app.stop waits for initialization and settles actual AppService recovery before teardown; nativeFailure=%s',
  async (nativeFailure) => {
    const gate = pendingReady();
    const t = await host(true, undefined, { initializationGate: gate.promise, owner: true, deferInitialized: true });
    const nativeErrors: unknown[] = [];
    fixture.start.mockImplementation((request: GuestStart, emit: (frame: GuestFrame) => void) => {
      if (request.mode !== 'codex') throw new Error('unexpected mode');
      const input = JSON.parse(request.prompt ?? '{}');
      let resolve!: (value: { confirmed: boolean; exitCode: number; error: string | null }) => void;
      const done = new Promise<{ confirmed: boolean; exitCode: number; error: string | null }>((r) => {
        resolve = r;
      });
      const ok = { confirmed: true, exitCode: 0, error: null };
      queueMicrotask(() => {
        try {
          const result =
            input.operation === 'export'
              ? { files: t.sourceFiles }
              : input.operation === 'recover-owned'
                ? {
                    cleanupConfirmed: true,
                    identity: input.owner.identity,
                    sourceSha256: t.sourceSha256,
                    bootId: randomUUID(),
                    leader: { pid: 111, startTicks: '42' },
                    members: [{ pid: 111, startTicks: '42' }],
                  }
                : null;
          expect(result).not.toBeNull();
          let data = 'WSL_APP_RESULT:' + JSON.stringify(result) + '\n';
          if (input.operation === 'recover-owned') {
            const program = `import json,sys,tempfile,uuid\nfrom pathlib import Path\nm={'__name__':'owned_recovery_boundary'}\nexec(compile(${JSON.stringify(ownedProcess)},'<edu-owned-process>','exec'),m)\na={'__name__':'app_helper_boundary'}\nexec(compile(${JSON.stringify(appHelper)},'<app-helper>','exec'),a)\nexpected=json.load(sys.stdin)\nwith tempfile.TemporaryDirectory() as root:\n m['BASE']=Path(root);old=str(uuid.uuid4());current=str(uuid.uuid4());m['boot_identity']=lambda:current\n helper={'pid':110,'startTicks':'41'};leader={'pid':111,'startTicks':'42'}\n path=m['receipt_path'](expected['identity']['appInstanceId'])\n m['atomic'](path,{'schemaVersion':1,**expected,'bootId':old,'helper':helper,'leader':leader,'members':[leader],'cleanupConfirmed':False})\n a['output'](m['reconcile'](expected))\n`;
            data = execFileSync(
              'python3',
              ['-I', '-c', nativeFailure ? "raise RuntimeError('controlled_native_recovery_failure')\n" + program : program],
              { input: JSON.stringify(input.owner), encoding: 'utf8', timeout: 3000 },
            );
          }
          emit({ type: 'output', stream: 'stdout', data });
          if (input.operation === 'export') resolve(ok);
        } catch (error) {
          nativeErrors.push(error);
          emit({ type: 'error', error: 'native recovery fixture failed' });
          resolve({ confirmed: true, exitCode: 1, error: 'native recovery fixture failed' });
        }
      });
      return {
        done,
        close: async () => {
          resolve(ok);
          return done;
        },
      };
    });
    const response = (id: string) => t.messages.find((m) => (m.type === 'response' || m.type === 'error') && m.id === id);
    const completed = t.completion('stop-before-ready');
    try {
      t.request({ id: 'stop-before-ready', method: 'app.stop', payload: { workspaceId: 'taskflow-demo', projectId: t.projectId } });
      t.request({ id: 'status-before-ready', method: 'status' });
      await vi.waitFor(() => expect(response('status-before-ready')).toBeDefined(), { timeout: 100 });
      expect(response('stop-before-ready')).toBeUndefined();
      expect(fixture.start).not.toHaveBeenCalled();
    } finally {
      gate.release();
      // The response is sent after real helper work and registry persistence. Await
      // that completion even if a pre-release assertion fails; do not race rm
      // against writes using waitFor's unrelated default one-second deadline.
      await completed;
    }
    expect(
      response('stop-before-ready'),
      JSON.stringify({
        received: response('stop-before-ready'),
        operations: fixture.start.mock.calls.map(([r]) => JSON.parse((r as GuestStart & { prompt: string }).prompt).operation),
      }),
    ).toMatchObject({
      type: 'response',
      result: nativeFailure
        ? { state: 'failed', cleanupConfirmed: false, error: 'verification_recovery_guest_unconfirmed' }
        : { state: 'stopped', cleanupConfirmed: true },
    });
    expect(nativeErrors).toHaveLength(nativeFailure ? 1 : 0);
    if (nativeFailure) expect((nativeErrors[0] as Error).message).toContain('controlled_native_recovery_failure');
    expect(fixture.start.mock.calls.map(([r]) => JSON.parse((r as GuestStart & { prompt: string }).prompt).operation)).toEqual([
      'export',
      'recover-owned',
    ]);
  },
);
it('pending initialization with an invalid journal rejects stop instead of recovering an owner', async () => {
  const gate = pendingReady();
  const t = await host(true, '{"unknown":true}', { initializationGate: gate.promise, owner: true, deferInitialized: true });
  t.request({ id: 'invalid-stop', method: 'app.stop', payload: { workspaceId: 'taskflow-demo', projectId: t.projectId } });
  gate.release();
  await vi.waitFor(() =>
    expect(t.messages.find((m) => m.type === 'error' && m.id === 'invalid-stop')).toMatchObject({ error: 'verification_journal_invalid' }),
  );
  expect(fixture.start).not.toHaveBeenCalled();
});
it('app.stop permits an initialized unavailable transport for an already stopped owner', async () => {
  const t = await host(true, undefined, { initializationGate: Promise.resolve(), unavailable: true });
  expect(t.messages.find((m) => m.type === 'initialized')).toMatchObject({ status: { available: false, reason: 'offline' } });
  t.request({ id: 'offline-stopped', method: 'app.stop', payload: { workspaceId: 'taskflow-demo', projectId: t.projectId } });
  await vi.waitFor(() =>
    expect(t.messages.find((m) => m.type === 'response' && m.id === 'offline-stopped')).toMatchObject({
      result: { cleanupConfirmed: true },
    }),
  );
  expect(fixture.start).not.toHaveBeenCalled();
});
it('app.stop reaches actual startup cancellation while the build has not returned ready', async () => {
  const t = await host(true, undefined, { initializationGate: Promise.resolve() });
  fixture.start.mockImplementation((request: GuestStart) => {
    expect(JSON.parse((request as GuestStart & { prompt: string }).prompt).operation).toBe('start');
    let resolve!: (value: { confirmed: boolean; exitCode: number; error: null }) => void;
    const done = new Promise<{ confirmed: boolean; exitCode: number; error: null }>((r) => {
      resolve = r;
    });
    return {
      done,
      close: async () => {
        resolve({ confirmed: true, exitCode: 0, error: null });
        return done;
      },
    };
  });
  t.request({ id: 'held-build', method: 'app.start', payload: { workspaceId: 'taskflow-demo', projectId: t.projectId } });
  await vi.waitFor(() => expect(t.messages.some((m) => m.type === 'app-event' && m.snapshot.state === 'starting')).toBe(true));
  t.request({ id: 'cancel-build', method: 'app.stop', payload: { workspaceId: 'taskflow-demo', projectId: t.projectId } });
  await vi.waitFor(
    () =>
      expect(t.messages.find((m) => m.type === 'response' && m.id === 'cancel-build')).toMatchObject({
        result: { state: 'stopped', cleanupConfirmed: true },
      }),
    { timeout: 200 },
  );
  expect(t.messages.some((m) => m.type === 'response' && m.id === 'held-build')).toBe(true);
  expect(fixture.start).toHaveBeenCalledOnce();
});
