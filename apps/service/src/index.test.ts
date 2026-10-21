import type * as AppServiceModule from './app-service';
import type { EnvironmentResources } from './environment-resources';
import type { CodexChat } from './codex-chat';
import type { MaintenanceGate } from './maintenance-gate';
import type { TerminalSnapshot } from '@wsl/protocol';
import type * as SbxModule from './sbx';
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
  environmentList: vi.fn<EnvironmentResources['list']>(),
  resourceRegister: vi.fn<EnvironmentResources['register']>(),
  resourceRelease: vi.fn<EnvironmentResources['release']>(),
  observe: vi.fn<EnvironmentResources['observe']>(),
  identity: vi.fn<EnvironmentResources['identity']>(),
  terminalSnapshot: vi.fn<EnvironmentResources['terminalSnapshot']>(),
  openTerminal: vi.fn<EnvironmentResources['openTerminal']>(),
  terminal: vi.fn<(identity: Parameters<EnvironmentResources['terminal']>[0]) => void>(),
  terminalWrite: vi.fn<(sessionId: string, data: string) => void>(),
  terminalResize: vi.fn<(sessionId: string, cols: number, rows: number) => void>(),
  terminalClose: vi.fn<(sessionId: string) => Promise<TerminalSnapshot>>(),
  appShutdown: vi.fn<() => Promise<void>>(async () => undefined),
}));
vi.mock('./sbx', async (original) => {
  const { SbxConnection } = await original<typeof SbxModule>();
  return {
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
      assertMotaCapability = SbxConnection.prototype.assertMotaCapability;
      getCleanupPending = () => false;
      start = (...args: Parameters<typeof fixture.start>) => {
        if (!this.getStatus().available) throw new Error(this.getStatus().reason!);
        return fixture.start(...args);
      };
      shutdown = async () => undefined;
    },
  };
});
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
    list = fixture.environmentList;
    register = fixture.resourceRegister;
    release = fixture.resourceRelease;
    observe = fixture.observe;
    identity = fixture.identity;
    terminalSnapshot = fixture.terminalSnapshot;
    openTerminal = fixture.openTerminal;
    terminal(identity: Parameters<EnvironmentResources['terminal']>[0]) {
      fixture.terminal(identity);
      return { write: fixture.terminalWrite, resize: fixture.terminalResize, close: fixture.terminalClose };
    }
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
  beforeImport?: () => Promise<void>,
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
  await beforeImport?.();
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
it('research bridge checks the complete reply context and propagates cancellation to Main', async () => {
  const test = await host();
  let emit!: (frame: GuestFrame) => void;
  let settle!: (value: { confirmed: boolean; error: null; exitCode: number }) => void;
  const done = new Promise((resolve) => {
    settle = resolve;
  });
  const write = vi.fn();
  fixture.start.mockImplementation((_request: GuestStart, handler: (frame: GuestFrame) => void) => {
    emit = handler;
    return {
      done,
      write,
      close: async () => {
        const result = { confirmed: true, error: null, exitCode: 0 };
        settle(result);
        return result;
      },
    };
  });
  const references = emptyReferences(conversationId);
  const grant = {
    grantId: randomUUID(),
    accountId: references.accountId,
    workspaceId: 'taskflow-demo',
    sessionId: conversationId,
    taskVersionId: 'task',
    runId: 'research-run',
    mode: 'live' as const,
    purpose: 'public-web-research' as const,
    grantedAt: '2026-10-15T00:00:00.000Z',
  };
  test.request({ id: 'research-register', method: 'register', payload: { conversationId, workspaceId: grant.workspaceId } });
  await test.completion('research-register');
  test.request({
    id: 'research-send',
    method: 'send',
    payload: {
      conversationId,
      text: 'research',
      references,
      researchGrant: grant,
      observationScope: { workspaceId: grant.workspaceId, sessionId: conversationId, runId: grant.runId, sources: [] },
    },
  });
  const sent = await test.completion('research-send');
  expect(sent.type).toBe('response');
  emit({ type: 'observation-call', id: randomUUID(), tool: 'research.open', args: { url: 'https://example.com/' } });
  await vi.waitFor(() => expect(test.messages.some((m) => m.type === 'research-call')).toBe(true));
  const call = test.messages.find((m) => m.type === 'research-call');
  if (!call || call.type !== 'research-call') throw new Error('missing research call');
  const result = { ok: false as const, tool: call.tool, error: { code: 'blocked' as const, message: 'HTTP 403' } };
  test.request({
    id: 'research-wrong',
    method: 'research.reply',
    payload: { callId: call.callId, context: { ...call.context, turnId: 'foreign' }, result },
  });
  expect((await test.completion('research-wrong')).type).toBe('error');
  expect(write).not.toHaveBeenCalled();
  test.request({ id: 'research-right', method: 'research.reply', payload: { callId: call.callId, context: call.context, result } });
  await test.completion('research-right');
  await vi.waitFor(() => expect(write).toHaveBeenCalledWith({ type: 'observation-result', id: call.callId, result }));
  const pendingId = randomUUID();
  emit({ type: 'observation-call', id: pendingId, tool: 'research.open', args: { url: 'https://example.com/' } });
  await vi.waitFor(() => expect(test.messages.some((m) => m.type === 'research-call' && m.callId === pendingId)).toBe(true));
  test.request({ id: 'research-stop', method: 'cancel', payload: { conversationId } });
  await test.completion('research-stop');
  expect(test.messages).toContainEqual({ type: 'research-abort', callId: pendingId });
});
it('R4 rejects unverified Mota native capability before acquiring a lease or invoking chat.send', async () => {
  const test = await host();
  test.request({ id: 'mota-native-register', method: 'register', payload: { conversationId, workspaceId: 'taskflow-demo' } });
  await test.completion('mota-native-register');
  const binding = {
    workspaceId: 'taskflow-demo',
    environmentId: 'sandbox' as const,
    projectId: randomUUID(),
    appInstanceId: randomUUID(),
    runId: randomUUID(),
    sessionId: conversationId,
    resourceId: 'game',
    browserInstanceId: 'browser',
    browserGeneration: 0,
    webContentsId: 1,
    documentGeneration: 0,
  };
  const { AppService } = await import('./app-service');
  const { CodexChat } = await import('./codex-chat');
  const admission = vi.spyOn(AppService.prototype, 'assertTaskAdmission').mockResolvedValue(undefined);
  const active = vi.spyOn(AppService.prototype, 'assertMotaTaskActive').mockImplementation(() => undefined);
  const control = vi.spyOn(AppService.prototype, 'motaControl').mockImplementation(async (request) => ({
    type: 'mota-control-result',
    requestId: request.requestId,
    binding: request.binding,
    method: 'acquire',
    ok: true,
    data: { settled: true },
  }));
  const sending = vi.spyOn(CodexChat.prototype, 'send');
  try {
    test.request({
      id: 'mota-native-denied',
      method: 'send',
      payload: {
        conversationId,
        text: 'restricted game',
        references: emptyReferences(conversationId, binding.workspaceId),
        observationScope: { workspaceId: binding.workspaceId, sessionId: conversationId, runId: binding.runId, sources: [] },
        motaTask: binding,
      },
    });
    expect(await test.completion('mota-native-denied')).toMatchObject({
      type: 'response',
      result: {
        kind: 'mota-task-dispatch-rejected',
        executorStarted: false,
        binding,
        error: expect.stringContaining('mota_native_tools_unverified'),
      },
    });
    expect(control).not.toHaveBeenCalled();
    expect(sending).not.toHaveBeenCalled();
    expect(fixture.start).not.toHaveBeenCalled();
  } finally {
    admission.mockRestore();
    active.mockRestore();
    control.mockRestore();
    sending.mockRestore();
  }
});

it.each([false, true])('Mota rejection proves no executor only before chat.send boundary: invoked=%s', async (invoked) => {
  const test = await host();
  const binding = {
    workspaceId: 'taskflow-demo',
    environmentId: 'sandbox' as const,
    projectId: randomUUID(),
    appInstanceId: randomUUID(),
    runId: randomUUID(),
    sessionId: conversationId,
    resourceId: 'game',
    browserInstanceId: 'browser',
    browserGeneration: 0,
    webContentsId: 1,
    documentGeneration: 0,
  };
  const { AppService } = await import('./app-service');
  const { CodexChat } = await import('./codex-chat');
  const admission = vi.spyOn(AppService.prototype, 'assertTaskAdmission');
  const active = vi.spyOn(AppService.prototype, 'assertMotaTaskActive').mockImplementation(() => undefined);
  const control = vi.spyOn(AppService.prototype, 'motaControl').mockImplementation(async (request) => ({
    type: 'mota-control-result',
    requestId: request.requestId,
    binding: request.binding,
    method: 'acquire',
    ok: true,
    data: { settled: true },
  }));
  const capability = vi.spyOn(CodexChat.prototype, 'assertMotaCapability').mockImplementation(() => undefined);
  const sending = vi.spyOn(CodexChat.prototype, 'send').mockRejectedValueOnce(new Error('model dispatch unknown'));
  if (invoked) admission.mockResolvedValueOnce(undefined);
  else admission.mockRejectedValueOnce(new Error('live app required'));
  try {
    test.request({
      id: 'mota-dispatch',
      method: 'send',
      payload: {
        conversationId,
        text: 'read bound Mota state',
        references: emptyReferences(conversationId, binding.workspaceId),
        observationScope: { workspaceId: binding.workspaceId, sessionId: conversationId, runId: binding.runId, sources: [] },
        motaTask: binding,
      },
    });
    const result = await test.completion('mota-dispatch');
    if (invoked) {
      expect(result).toMatchObject({ type: 'error', error: 'model dispatch unknown' });
      expect(sending).toHaveBeenCalledOnce();
    } else {
      expect(result).toEqual({
        type: 'response',
        id: 'mota-dispatch',
        result: { kind: 'mota-task-dispatch-rejected', conversationId, binding, executorStarted: false, error: 'live app required' },
      });
      expect(sending).not.toHaveBeenCalled();
      expect(control).not.toHaveBeenCalled();
    }
  } finally {
    admission.mockRestore();
    active.mockRestore();
    control.mockRestore();
    sending.mockRestore();
    capability.mockRestore();
  }
});
function importRequest() {
  const files = [...EDU_REQUIRED_FILES].sort().map((file) => ({ path: file, base64: '' }));
  const metadata = files.map((file) => ({ path: file.path, sha256: createHash('sha256').update('').digest('hex'), bytes: 0 }));
  return {
    workspaceId: 'import-space',
    projectId: randomUUID(),
    importOperationId: randomUUID(),
    files,
    source: {
      repository: { commit: 'a'.repeat(40), dirty: false },
      files: metadata,
      sourceSha256: createHash('sha256').update(JSON.stringify(metadata)).digest('hex'),
    },
  };
}
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

it('routes source confirmation through the import transaction and returns its typed receipt', async () => {
  const test = await host();
  const payload = importRequest();
  fixture.start.mockImplementation((start: GuestStart, emit: (frame: GuestFrame) => void) => {
    if (start.mode !== 'codex') throw new Error('unexpected mode');
    const input = JSON.parse(start.prompt ?? '{}');
    expect(input.operation).toBe('import-source');
    queueMicrotask(() =>
      emit({
        type: 'output',
        stream: 'stdout',
        data:
          'WSL_APP_RESULT:' +
          JSON.stringify({
            importOperationId: input.importOperationId,
            outcome: 'imported',
            retryable: false,
            errorCode: null,
            profile: input.profile,
            sourceSha256: input.profile.source.sourceSha256,
          }) +
          '\n',
      }),
    );
    return {
      done: Promise.resolve({ confirmed: true, error: null, exitCode: 0 }),
      close: async () => ({ confirmed: true, error: null, exitCode: 0 }),
    };
  });
  test.request({ id: 'source-import', method: 'app.importSource', payload });
  await vi.waitFor(() =>
    expect(test.messages.find((message) => message.type === 'response' && message.id === 'source-import')).toMatchObject({
      result: { outcome: 'imported', app: { projectId: payload.projectId, state: 'created' } },
    }),
  );
  expect(fixture.start).toHaveBeenCalledOnce();
});

it('allows import cancellation while a startup admission journal blocks new imports', async () => {
  const test = await host(false, '{"unknown":true}');
  const payload = importRequest();
  fixture.start.mockImplementation((start: GuestStart, emit: (frame: GuestFrame) => void) => {
    if (start.mode !== 'codex') throw new Error('unexpected mode');
    const input = JSON.parse(start.prompt ?? '{}');
    expect(input.operation).toBe('reconcile-import');
    expect(input.cancel).toBe(true);
    queueMicrotask(() =>
      emit({
        type: 'output',
        stream: 'stdout',
        data:
          'WSL_APP_RESULT:' +
          JSON.stringify({
            importOperationId: input.importOperationId,
            outcome: 'cancelled',
            retryable: false,
            errorCode: null,
          }) +
          '\n',
      }),
    );
    return {
      done: Promise.resolve({ confirmed: true, error: null, exitCode: 0 }),
      close: async () => ({ confirmed: true, error: null, exitCode: 0 }),
    };
  });
  test.request({ id: 'source-import', method: 'app.importSource', payload });
  test.request({
    id: 'source-cancel',
    method: 'app.cancelImport',
    payload: { workspaceId: payload.workspaceId, projectId: payload.projectId, importOperationId: payload.importOperationId },
  });
  await vi.waitFor(() => {
    expect(test.messages.find((message) => message.type === 'error' && message.id === 'source-import')).toMatchObject({
      error: 'verification_journal_invalid',
    });
    expect(test.messages.find((message) => message.type === 'response' && message.id === 'source-cancel')).toMatchObject({
      result: { app: null, outcome: 'cancelled', retryable: false },
    });
  });
  expect(fixture.start).toHaveBeenCalledOnce();
});

it('returns bound prepare/apply/cancel failures instead of losing cleanup facts in transport errors', async () => {
  const test = await host();
  const source = importRequest().source;
  const binding = {
    runId: randomUUID(),
    workspaceId: 'taskflow-demo',
    projectId: randomUUID(),
    appInstanceId: randomUUID(),
    resourceId: 'web',
    instanceId: 'browser',
    generation: 1,
    webContentsId: 1,
    documentGeneration: 1,
    sourceSha256: source.sourceSha256,
    protectedFiles: source.files,
  };
  test.request({ id: 'missing-candidate', method: 'app.prepareEduTask', payload: binding });
  expect(await test.completion('missing-candidate')).toMatchObject({
    type: 'response',
    result: {
      binding,
      operation: 'prepare',
      ok: false,
      cleanupConfirmed: true,
      error: expect.any(String),
    },
  });
  test.request({ id: 'cancel-candidate', method: 'app.cancelEduTask', payload: binding });
  expect(await test.completion('cancel-candidate')).toMatchObject({
    type: 'response',
    result: {
      binding,
      operation: 'cancel',
      ok: true,
      cleanupConfirmed: true,
    },
  });
  const foreign = { ...binding, appInstanceId: randomUUID() };
  test.request({ id: 'foreign-apply', method: 'app.applyEduTask', payload: foreign });
  expect(await test.completion('foreign-apply')).toMatchObject({
    type: 'response',
    result: {
      binding: foreign,
      operation: 'apply',
      ok: false,
      cleanupConfirmed: false,
    },
  });
  expect(fixture.start).not.toHaveBeenCalled();
});

it('cancels an admitted edu send before initialization and refuses an unknown old run', async () => {
  let release!: () => void;
  const gate = new Promise<void>((resolve) => {
    release = resolve;
  });
  const test = await host(true, undefined, { initializationGate: gate, deferInitialized: true });
  const binding = {
    runId: randomUUID(),
    workspaceId: 'taskflow-demo',
    projectId: test.projectId,
    appInstanceId: test.appInstanceId,
    resourceId: 'web',
    instanceId: 'browser',
    generation: 1,
    webContentsId: 1,
    documentGeneration: 1,
    sourceSha256: test.sourceSha256,
    protectedFiles: test.sourceFiles.map((file) => ({ path: file.path, sha256: createHash('sha256').update('').digest('hex'), bytes: 0 })),
  };
  try {
    test.request({ id: 'register-queued-edu', method: 'register', payload: { conversationId, workspaceId: binding.workspaceId } });
    test.request({
      id: 'queued-edu',
      method: 'send',
      payload: {
        conversationId,
        text: 'must not dispatch',
        references: emptyReferences(conversationId, binding.workspaceId),
        eduTask: binding,
      },
    });
    test.request({ id: 'cancel-queued-edu', method: 'app.cancelEduTask', payload: binding });
    expect(await test.completion('cancel-queued-edu')).toMatchObject({
      type: 'response',
      result: {
        binding,
        operation: 'cancel',
        ok: true,
        cleanupConfirmed: true,
      },
    });
    const old = { ...binding, runId: randomUUID() };
    test.request({ id: 'cancel-old-edu', method: 'app.cancelEduTask', payload: old });
    expect(await test.completion('cancel-old-edu')).toMatchObject({
      type: 'response',
      result: {
        binding: old,
        operation: 'cancel',
        ok: false,
        cleanupConfirmed: false,
      },
    });
  } finally {
    release();
  }
  expect(await test.completion('queued-edu')).toMatchObject({
    type: 'response',
    result: {
      kind: 'edu-task-dispatch-rejected',
      conversationId,
      binding,
      executorStarted: false,
      error: expect.stringContaining('cancelled'),
    },
  });
  expect(fixture.start).not.toHaveBeenCalled();
});

it('ordinary cancel waits for the pending edu source helper before publishing cancelled', async () => {
  const test = await host(true, undefined, { initializationGate: Promise.resolve() });
  const { AppService } = await import('./app-service');
  const binding = {
    runId: randomUUID(),
    workspaceId: 'taskflow-demo',
    projectId: test.projectId,
    appInstanceId: test.appInstanceId,
    resourceId: 'web',
    instanceId: 'browser',
    generation: 1,
    webContentsId: 1,
    documentGeneration: 1,
    sourceSha256: test.sourceSha256,
    protectedFiles: test.sourceFiles.map((file) => ({ path: file.path, sha256: createHash('sha256').update('').digest('hex'), bytes: 0 })),
  };
  let rejectSource!: (error: Error) => void;
  let release!: () => void;
  const source = new Promise<never>((_resolve, reject) => {
    rejectSource = reject;
  });
  const cleanup = new Promise<void>((resolve) => {
    release = resolve;
  });
  const sourceSpy = vi.spyOn(AppService.prototype, 'taskSource').mockImplementation(() => source);
  const cancelSpy = vi.spyOn(AppService.prototype, 'cancelEduTask').mockImplementation(async (received) => {
    await cleanup;
    rejectSource(new Error('edu_task_cancelled'));
    return { binding: received, operation: 'cancel', ok: true, cleanupConfirmed: true };
  });
  try {
    test.request({ id: 'register-source-cancel', method: 'register', payload: { conversationId, workspaceId: binding.workspaceId } });
    test.request({
      id: 'source-send',
      method: 'send',
      payload: {
        conversationId,
        text: 'pending source',
        references: emptyReferences(conversationId, binding.workspaceId),
        eduTask: binding,
      },
    });
    await vi.waitFor(() => expect(sourceSpy).toHaveBeenCalledWith(binding));
    test.request({ id: 'source-cancel', method: 'cancel', payload: { conversationId } });
    await vi.waitFor(() => expect(cancelSpy).toHaveBeenCalledWith(binding));
    expect(test.messages.some((message) => message.type === 'event' && message.conversation.state === 'cancelled')).toBe(false);
    expect(test.messages.some((message) => message.type === 'response' && message.id === 'source-cancel')).toBe(false);
    release();
    expect(await test.completion('source-cancel')).toMatchObject({
      type: 'response',
      result: { state: 'cancelled', cleanupPending: false },
    });
    await test.completion('source-send');
    expect(fixture.start).not.toHaveBeenCalled();
  } finally {
    release();
    sourceSpy.mockRestore();
    cancelSpy.mockRestore();
  }
});

it.each([false, true])(
  'reports pre-model edu rejection independently of old conversation history; chat.send invoked=%s',
  async (invoked) => {
    const test = await host();
    test.request({ id: 'register-rejection', method: 'register', payload: { conversationId, workspaceId: 'taskflow-demo' } });
    test.request({
      id: 'prior-history',
      method: 'send',
      payload: {
        conversationId,
        text: 'prior history',
        references: emptyReferences(conversationId, 'taskflow-demo'),
      },
    });
    await test.completion('prior-history');
    await vi.waitFor(() =>
      expect(test.messages.some((message) => message.type === 'event' && message.conversation.state === 'idle')).toBe(true),
    );
    const selected = importRequest();
    const binding = {
      runId: randomUUID(),
      workspaceId: 'taskflow-demo',
      projectId: selected.projectId,
      appInstanceId: randomUUID(),
      resourceId: 'web',
      instanceId: 'browser',
      generation: 1,
      webContentsId: 1,
      documentGeneration: 1,
      sourceSha256: selected.source.sourceSha256,
      protectedFiles: selected.source.files,
    };
    const { AppService } = await import('./app-service');
    const { CodexChat } = await import('./codex-chat');
    const source = vi.spyOn(AppService.prototype, 'taskSource');
    const sending = vi.spyOn(CodexChat.prototype, 'send').mockRejectedValueOnce(new Error('transport may have dispatched'));
    if (invoked) source.mockResolvedValueOnce({ runId: binding.runId, files: selected.files });
    else source.mockRejectedValueOnce(new Error('conflict: edu task source changed'));
    try {
      test.request({
        id: 'rejected-source',
        method: 'send',
        payload: {
          conversationId,
          text: 'changed source',
          references: emptyReferences(conversationId, binding.workspaceId),
          eduTask: binding,
        },
      });
      const result = await test.completion('rejected-source');
      if (invoked) {
        expect(result).toMatchObject({ type: 'error', error: 'transport may have dispatched' });
        expect(sending).toHaveBeenCalledOnce();
      } else {
        expect(result).toEqual({
          type: 'response',
          id: 'rejected-source',
          result: {
            kind: 'edu-task-dispatch-rejected',
            conversationId,
            binding,
            executorStarted: false,
            error: 'conflict: edu task source changed',
          },
        });
        expect(sending).not.toHaveBeenCalled();
        // An independent exact helper receipt is still required; the rejection
        // must not smuggle a cleanupConfirmed field into the dispatch fact.
        test.request({ id: 'reconcile-rejected-source', method: 'app.cancelEduTask', payload: binding });
        expect(await test.completion('reconcile-rejected-source')).toMatchObject({
          type: 'response',
          result: {
            binding,
            operation: 'cancel',
            ok: true,
            cleanupConfirmed: true,
          },
        });
      }
      expect(fixture.start).toHaveBeenCalledOnce();
    } finally {
      source.mockRestore();
      sending.mockRestore();
    }
  },
);

// These contracts exercise the process boundary while the original switch owns routing.
describe('P3 parentPort route contracts', () => {
  const identity = {
    workspaceId: 'route-space',
    environmentId: 'sandbox',
    resourceId: 'route-terminal',
    kind: 'terminal' as const,
    instanceId: 'route-instance',
    instanceGeneration: 3,
  };
  const snapshot = {
    seq: 7,
    sessionId: 'route-session',
    sandbox: 'fixture',
    cwd: '/workspace',
    state: 'running' as const,
    output: 'route-output',
    cleanupPending: false,
    error: null,
  };
  const observation = {
    requestId: 'route-observation',
    workspaceId: identity.workspaceId,
    sessionId: 'route-session',
    runId: 'route-run',
    target: identity,
    tool: 'terminal.read_screen' as const,
    args: { maxLines: 17 },
  };
  const observed = { error: 'unavailable' as const, message: 'route capture result' };
  async function response(test: Awaited<ReturnType<typeof host>>, request: ChatServiceRequest, result: unknown) {
    test.request(request);
    expect(await test.completion(request.id)).toEqual({ type: 'response', id: request.id, result });
    expect(
      test.messages.filter((message) => (message.type === 'response' || message.type === 'error') && message.id === request.id),
    ).toHaveLength(1);
  }
  it('environments.list forwards once and correlates its result', async () => {
    const test = await host();
    const list = [
      {
        environmentId: 'sandbox' as const,
        kind: 'sandbox' as const,
        label: 'route sandbox',
        state: 'configured' as const,
        reason: null,
        capabilities: { files: false, terminal: true, browser: false },
      },
    ];
    fixture.environmentList.mockReturnValueOnce(list);
    await response(test, { id: 'route-list', method: 'environments.list' }, list);
    expect(fixture.environmentList).toHaveBeenCalledExactlyOnceWith();
  });
  it.each(['resource.register', 'resource.release'] as const)('%s forwards the complete identity once', async (method) => {
    const test = await host();
    const operation = method === 'resource.register' ? fixture.resourceRegister : fixture.resourceRelease;
    operation.mockResolvedValueOnce(undefined);
    const payload = { ...identity, kind: 'file' as const };
    await response(test, { id: method, method, payload }, null);
    expect(operation).toHaveBeenCalledExactlyOnceWith(payload);
    expect(method === 'resource.register' ? fixture.resourceRelease : fixture.resourceRegister).not.toHaveBeenCalled();
  });
  it('terminal.get reads the top-level resourceId and returns one snapshot', async () => {
    const test = await host();
    fixture.identity.mockReturnValueOnce(identity);
    fixture.terminalSnapshot.mockReturnValueOnce(snapshot);
    await response(test, { id: 'route-get', method: 'terminal.get', resourceId: identity.resourceId }, snapshot);
    expect(fixture.identity).toHaveBeenCalledExactlyOnceWith(identity.resourceId);
    expect(fixture.terminalSnapshot).toHaveBeenCalledExactlyOnceWith(identity);
    expect(fixture.terminal).not.toHaveBeenCalled();
  });
  it('terminal.open waits for sandbox readiness then allows admission and forwards dimensions once', async () => {
    let releaseReady: () => void = () => {
      throw new Error('missing ready gate');
    };
    const initializationGate = new Promise<void>((resolve) => {
      releaseReady = resolve;
    });
    const test = await host(false, undefined, { initializationGate, deferInitialized: true });
    fixture.identity.mockReturnValueOnce(identity);
    fixture.openTerminal.mockResolvedValueOnce(snapshot);
    const request: ChatServiceRequest = {
      id: 'route-open',
      method: 'terminal.open',
      payload: { resourceId: identity.resourceId, cols: 93, rows: 31 },
    };
    test.request(request);
    expect(fixture.openTerminal).not.toHaveBeenCalled();
    expect(test.messages.some((message) => message.type === 'initialized')).toBe(false);
    releaseReady();
    expect(await test.completion(request.id)).toEqual({ type: 'response', id: request.id, result: snapshot });
    expect(
      test.messages.filter((message) => (message.type === 'response' || message.type === 'error') && message.id === request.id),
    ).toHaveLength(1);
    expect(fixture.identity).toHaveBeenCalledExactlyOnceWith(identity.resourceId);
    expect(fixture.openTerminal).toHaveBeenCalledExactlyOnceWith(identity, 93, 31);
  });
  it.each(['terminal.write', 'terminal.resize', 'terminal.close'] as const)('%s forwards to the owned terminal once', async (method) => {
    const test = await host();
    fixture.identity.mockReturnValueOnce(identity);
    if (method === 'terminal.close') fixture.terminalClose.mockResolvedValueOnce(snapshot);
    const target = { resourceId: identity.resourceId, sessionId: 'owned-terminal-session' };
    const request: ChatServiceRequest =
      method === 'terminal.write'
        ? { id: method, method, payload: { ...target, data: 'printf route\n' } }
        : method === 'terminal.resize'
          ? { id: method, method, payload: { ...target, cols: 101, rows: 37 } }
          : { id: method, method, payload: target };
    await response(test, request, method === 'terminal.close' ? snapshot : null);
    expect(fixture.identity).toHaveBeenCalledExactlyOnceWith(identity.resourceId);
    expect(fixture.terminal).toHaveBeenCalledExactlyOnceWith(identity);
    expect(fixture.terminalWrite).toHaveBeenCalledTimes(method === 'terminal.write' ? 1 : 0);
    expect(fixture.terminalResize).toHaveBeenCalledTimes(method === 'terminal.resize' ? 1 : 0);
    expect(fixture.terminalClose).toHaveBeenCalledTimes(method === 'terminal.close' ? 1 : 0);
    if (method === 'terminal.write') expect(fixture.terminalWrite).toHaveBeenCalledWith(target.sessionId, 'printf route\n');
    if (method === 'terminal.resize') expect(fixture.terminalResize).toHaveBeenCalledWith(target.sessionId, 101, 37);
    if (method === 'terminal.close') expect(fixture.terminalClose).toHaveBeenCalledWith(target.sessionId);
  });
  it('observation.read forwards payload and a live signal once', async () => {
    const test = await host();
    fixture.observe.mockResolvedValueOnce(observed);
    await response(test, { id: 'route-read', method: 'observation.read', payload: observation }, observed);
    expect(fixture.observe).toHaveBeenCalledExactlyOnceWith(observation, expect.any(AbortSignal));
    expect(fixture.observe.mock.calls[0]?.[1]?.aborted).toBe(false);
  });
  it.each(['observation.cancel', 'shutdown'] as const)('%s aborts a pending read through the same owned map', async (method) => {
    const test = await host();
    let signal: AbortSignal | undefined;
    const aborted = vi.fn();
    fixture.observe.mockImplementationOnce(
      (_payload, currentSignal) =>
        new Promise((resolve) => {
          if (!currentSignal) throw new Error('missing observation signal');
          signal = currentSignal;
          currentSignal.addEventListener(
            'abort',
            () => {
              aborted();
              resolve({ error: 'cancelled', message: 'route aborted' });
            },
            { once: true },
          );
        }),
    );
    test.request({ id: 'pending-read', method: 'observation.read', payload: observation });
    expect(fixture.observe).toHaveBeenCalledExactlyOnceWith(observation, expect.any(AbortSignal));
    expect(signal?.aborted).toBe(false);
    await response(test, { id: 'unrelated-cancel', method: 'observation.cancel', payload: { requestId: 'foreign-observation' } }, null);
    expect(signal?.aborted).toBe(false);
    expect(aborted).not.toHaveBeenCalled();
    test.request({ id: 'duplicate-read', method: 'observation.read', payload: observation });
    expect(await test.completion('duplicate-read')).toEqual({
      type: 'error',
      id: 'duplicate-read',
      error: 'Duplicate observation request',
    });
    expect(fixture.observe).toHaveBeenCalledTimes(1);
    await response(
      test,
      method === 'shutdown' ? { id: 'abort-read', method } : { id: 'abort-read', method, payload: { requestId: observation.requestId } },
      null,
    );
    expect(signal?.aborted).toBe(true);
    expect(aborted).toHaveBeenCalledOnce();
    expect(await test.completion('pending-read')).toEqual({
      type: 'response',
      id: 'pending-read',
      result: { error: 'cancelled', message: 'route aborted' },
    });
    if (method === 'observation.cancel') {
      fixture.observe.mockResolvedValueOnce(observed);
      await response(test, { id: 'reused-read', method: 'observation.read', payload: observation }, observed);
      expect(fixture.observe).toHaveBeenCalledTimes(2);
      const replacement = fixture.observe.mock.calls[1]?.[1];
      expect(replacement).toBeInstanceOf(AbortSignal);
      expect(replacement).not.toBe(signal);
      expect(replacement?.aborted).toBe(false);
    }
  });
  it('terminal.open rechecks admission after sandbox readiness resumes', async () => {
    let releaseReady: () => void = () => {
      throw new Error('missing ready gate');
    };
    const initializationGate = new Promise<void>((resolve) => {
      releaseReady = resolve;
    });
    const admissionOwners = new Set<MaintenanceGate>();
    const test = await host(false, undefined, { initializationGate, deferInitialized: true }, async () => {
      const { MaintenanceGate } = await import('./maintenance-gate');
      const original = MaintenanceGate.prototype.admission;
      vi.spyOn(MaintenanceGate.prototype, 'admission').mockImplementation(function (this: MaintenanceGate) {
        admissionOwners.add(this);
        return original.call(this);
      });
    });
    fixture.identity.mockReturnValueOnce(identity);
    try {
      test.request({ id: 'revoked-open', method: 'terminal.open', payload: { resourceId: identity.resourceId, cols: 83, rows: 27 } });
      expect(fixture.identity).toHaveBeenCalledExactlyOnceWith(identity.resourceId);
      expect(fixture.openTerminal).not.toHaveBeenCalled();
      const maintenance = [...admissionOwners][0];
      if (!maintenance) throw new Error('request never acquired admission');
      maintenance.acquire();
      releaseReady();
      expect(await test.completion('revoked-open')).toEqual({
        type: 'error',
        id: 'revoked-open',
        error: 'verification_maintenance_locked',
      });
      expect(fixture.openTerminal).not.toHaveBeenCalled();
      maintenance.release();
    } finally {
      releaseReady();
      vi.restoreAllMocks();
    }
  });
  it.each(['observation.reply', 'app.reply', 'research.reply'] as const)(
    '%s resolves only its matching pending receiver once',
    async (method) => {
      let observationReader: Parameters<CodexChat['setObservationReader']>[0] | undefined;
      let appReader: Parameters<CodexChat['setAppControlReader']>[0] | undefined;
      let researchReader: Parameters<CodexChat['setResearchReader']>[0] | undefined;
      const test = await host(false, undefined, undefined, async () => {
        const { CodexChat } = await import('./codex-chat');
        vi.spyOn(CodexChat.prototype, 'setObservationReader').mockImplementation((reader) => {
          observationReader = reader;
        });
        vi.spyOn(CodexChat.prototype, 'setAppControlReader').mockImplementation((reader) => {
          appReader = reader;
        });
        vi.spyOn(CodexChat.prototype, 'setResearchReader').mockImplementation((reader) => {
          researchReader = reader;
        });
      });
      const scope = { workspaceId: identity.workspaceId, sessionId: 'route-session', runId: 'route-run', sources: [] };
      const signal = new AbortController();
      const settled = [vi.fn(), vi.fn()];
      const pending: Promise<unknown>[] = [];
      const callIds: string[] = [];
      const context = {
        grant: {
          grantId: randomUUID(),
          accountId: 'route-account',
          workspaceId: scope.workspaceId,
          sessionId: scope.sessionId,
          taskVersionId: 'route-task',
          runId: scope.runId,
          mode: 'live' as const,
          purpose: 'public-web-research' as const,
          grantedAt: '2026-10-18T00:00:00.000Z',
        },
        generation: 'route-generation',
        turnId: 'route-turn',
      };
      try {
        for (const receiver of settled) {
          let waiting: Promise<unknown>;
          if (method === 'observation.reply') {
            if (!observationReader) throw new Error('missing observation reader');
            waiting = observationReader(scope, 'workspace.list_sources', {}, signal.signal);
          } else if (method === 'app.reply') {
            if (!appReader) throw new Error('missing app reader');
            waiting = appReader(scope, 'app.status', {}, signal.signal);
          } else {
            if (!researchReader) throw new Error('missing research reader');
            waiting = researchReader(
              { callId: randomUUID(), context, tool: 'research.open', args: { url: 'https://example.com/' } },
              signal.signal,
            );
          }
          pending.push(waiting.then(receiver));
        }
        for (const message of test.messages) {
          if (method === 'observation.reply' && message.type === 'observation-call') callIds.push(message.id);
          if (method === 'app.reply' && message.type === 'app-call') callIds.push(message.id);
          if (method === 'research.reply' && message.type === 'research-call') callIds.push(message.callId);
        }
        expect(callIds).toHaveLength(2);
        const [firstId, secondId] = callIds;
        if (!firstId || !secondId) throw new Error('missing forwarded calls');
        const result =
          method === 'observation.reply'
            ? observed
            : {
                ok: false as const,
                tool: method === 'app.reply' ? ('app.status' as const) : ('research.open' as const),
                error: { code: 'cancelled' as const, message: 'route reply' },
              };
        if (method === 'research.reply') {
          test.request({
            id: 'invalid-reply',
            method,
            payload: {
              callId: firstId,
              context: { ...context, turnId: 'foreign-turn' },
              result: { ok: false, tool: 'research.open', error: { code: 'cancelled', message: 'route reply' } },
            },
          });
          expect(await test.completion('invalid-reply')).toEqual({
            type: 'error',
            id: 'invalid-reply',
            error: 'Research reply does not match its owned call',
          });
          expect(settled[0]).not.toHaveBeenCalled();
          expect(settled[1]).not.toHaveBeenCalled();
        }
        const reply = (id: string, callId: string): ChatServiceRequest =>
          method === 'observation.reply'
            ? { id, method, payload: { callId, result: observed } }
            : method === 'app.reply'
              ? {
                  id,
                  method,
                  payload: { callId, result: { ok: false, tool: 'app.status', error: { code: 'cancelled', message: 'route reply' } } },
                }
              : {
                  id,
                  method,
                  payload: {
                    callId,
                    context,
                    result: { ok: false, tool: 'research.open', error: { code: 'cancelled', message: 'route reply' } },
                  },
                };
        await response(test, reply('unknown-reply', randomUUID()), null);
        expect(settled[0]).not.toHaveBeenCalled();
        expect(settled[1]).not.toHaveBeenCalled();
        await response(test, reply('first-reply', firstId), null);
        await pending[0];
        expect(settled[0]).toHaveBeenCalledExactlyOnceWith(method === 'research.reply' ? { callId: firstId, context, result } : result);
        expect(settled[1]).not.toHaveBeenCalled();
        await response(test, reply('duplicate-reply', firstId), null);
        expect(settled[0]).toHaveBeenCalledOnce();
        expect(settled[1]).not.toHaveBeenCalled();
        await response(test, reply('second-reply', secondId), null);
        await pending[1];
        expect(settled[1]).toHaveBeenCalledExactlyOnceWith(method === 'research.reply' ? { callId: secondId, context, result } : result);
        signal.abort();
        expect(
          test.messages.filter(
            (message) =>
              ((message.type === 'observation-abort' || message.type === 'app-abort') && callIds.includes(message.id)) ||
              (message.type === 'research-abort' && callIds.includes(message.callId)),
          ),
        ).toEqual([]);
      } finally {
        signal.abort();
        await Promise.all(pending);
        vi.restoreAllMocks();
      }
    },
  );
});
