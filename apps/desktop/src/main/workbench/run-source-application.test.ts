import { codexHarnessRuntime } from './harness-test-fixture';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createHash, randomUUID } from 'node:crypto';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import path from 'node:path';
import { tmpdir } from 'node:os';
import {
  WorkbenchCommandSchema,
  type AppSourceSnapshot,
  type AppSourceSnapshotResult,
  type AppTarget,
  type CapturedSourceChange,
  type ChatConversation,
  type ManagedApp,
  type PreviewState,
  type WorkbenchSnapshot,
} from '@wsl/protocol';
import { WorkbenchApplication } from './application';
import { FileWorkbenchRepository, type WorkbenchRepository } from './repository';
import { RunDispatchFailure, type WorkbenchRuntime } from './ports';
import { catalogForTestSnapshot } from './catalog-test-fixture';

const serviceMock = vi.hoisted(() => ({ callbacks: new Map<string, (value: unknown) => void>(), postMessage: vi.fn() }));
vi.mock('electron', () => ({
  app: { isPackaged: false, getAppPath: () => '/desktop', getPath: () => '/user-data' },
  utilityProcess: {
    fork: () => ({
      once: (name: string, callback: (value: unknown) => void) => serviceMock.callbacks.set(name, callback),
      on: (name: string, callback: (value: unknown) => void) => {
        serviceMock.callbacks.set(name, callback);
        if (name === 'message')
          callback({
            type: 'initialized',
            status: { available: true, reason: null, version: 'fixture', sandbox: 'fixture', cwd: '/home/agent/workspace', harnesses: [] },
            cleanupPending: false,
          });
      },
      postMessage: serviceMock.postMessage,
      kill: vi.fn(),
    }),
  },
}));
import { ChatService } from '../chat-service';
beforeEach(() => {
  serviceMock.callbacks.clear();
  serviceMock.postMessage.mockClear();
});

function deferred<T>() {
  let complete: ((value: T) => void) | undefined;
  const promise = new Promise<T>((resolve) => {
    complete = resolve;
  });
  return {
    promise,
    resolve(value: T) {
      if (!complete) throw new Error('uninitialized fixture promise');
      complete(value);
    },
  };
}
const roots: string[] = [];
afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});
const required = <T>(value: T | null | undefined): T => {
  if (value == null) throw new Error('missing fixture value');
  return value;
};
const baseTree = 'a'.repeat(40);
const patch = 'diff --git a/button.ts b/button.ts\n--- a/button.ts\n+++ b/button.ts\n@@ -1 +1 @@\n-old\n+new\n';
const captured: CapturedSourceChange = {
  state: 'captured',
  baseTree,
  afterTree: 'b'.repeat(40),
  files: [{ path: 'button.ts', change: 'modified', additions: 1, deletions: 1, binary: false }],
  additions: 1,
  deletions: 1,
  truncated: false,
  patchSha256: createHash('sha256').update(patch).digest('hex'),
};
const source = (target: AppTarget): Extract<AppSourceSnapshotResult, { ok: true }> => ({
  ok: true,
  cleanupConfirmed: true,
  snapshot: {
    ...target,
    files: [{ path: 'button.ts', mode: '100644', base64: Buffer.from('text\n').toString('base64') }],
    totalBytes: 5,
  },
});
const page: PreviewState = {
  page: { webContentsId: 42, documentGeneration: 0, url: 'http://127.0.0.1:49152', title: 'App', partition: 'fixture' },
  loading: false,
  picking: false,
  canGoBack: false,
  canGoForward: false,
  consoleIssueCount: 0,
  cdp: { state: 'attached' },
  pickError: null,
  loadError: null,
  blockedNavigation: null,
};
const unused = async (): Promise<never> => {
  throw new Error('unexpected runtime operation');
};

async function fixture() {
  let saved: WorkbenchSnapshot | null = null;
  const apps = new Map<string, ManagedApp>();
  const turns = new Map<string, ChatConversation>();
  const snapshots = vi.fn(async (target: AppTarget, _signal: AbortSignal): Promise<AppSourceSnapshotResult> => source(target));
  const send = vi.fn<WorkbenchRuntime['send']>(async (sessionId) => {
    const turn: ChatConversation = {
      conversationId: sessionId,
      generation: 'generation',
      turnId: randomUUID(),
      seq: (turns.get(sessionId)?.seq ?? 0) + 1,
      threadId: 'thread',
      state: 'running',
      messages: [],
      toolExecutions: [],
      warnings: [],
      cleanupPending: true,
      error: null,
    };
    turns.set(sessionId, turn);
    return turn;
  });
  const register = vi.fn(async (): Promise<void> => undefined);
  const cancel = vi.fn(async (sessionId: string): Promise<ChatConversation> => {
    const turn = required(turns.get(sessionId));
    const result = { ...turn, state: 'cancelled' as const, cleanupPending: false, seq: turn.seq + 1 };
    turns.set(sessionId, result);
    return result;
  });
  const runtime: WorkbenchRuntime = {
    ...codexHarnessRuntime,
    appSourceSnapshot: snapshots,
    appCreate: async (target) => {
      const app: ManagedApp = {
        ...target,
        environmentId: 'sandbox',
        appInstanceId: null,
        state: 'created',
        url: null,
        guestCwd: `/home/agent/workspace/.wsl-apps/${target.projectId}`,
        error: null,
        cleanupConfirmed: true,
      };
      apps.set(target.projectId, app);
      return app;
    },
    appStart: async (target) => {
      const app: ManagedApp = {
        ...required(apps.get(target.projectId)),
        appInstanceId: randomUUID(),
        state: 'running',
        url: page.page.url,
        cleanupConfirmed: false,
      };
      apps.set(target.projectId, app);
      return app;
    },
    appGet: async (target) => ({
      ...required(apps.get(target.projectId)),
      state: 'stopped',
      url: null,
      appInstanceId: null,
      cleanupConfirmed: true,
    }),
    environmentsList: async () => [],
    registerSession: register,
    send,
    cancel,
    registerResource: async () => undefined,
    releaseResource: async () => undefined,
    observe: unused,
    captureResource: unused,
    validateBrowserUrl: () => undefined,
    ensureBrowser: () => undefined,
    browserState: () => page,
    browserLayout: () => undefined,
    browserAction: () => undefined,
    hideBrowsers: () => undefined,
    terminalOpen: unused,
    terminalStop: unused,
    terminalWrite: unused,
    terminalResize: unused,
  };
  const baseline = vi.fn(async (_runId: string, _snapshot: AppSourceSnapshot, _signal: AbortSignal) => ({ baseTree }));
  const capture = vi.fn(async (_runId: string, _baseTree: string, _snapshot: AppSourceSnapshot, _signal: AbortSignal) =>
    structuredClone(captured),
  );
  const readPatch = vi.fn(async () => patch);
  const save = vi.fn(async (snapshot: WorkbenchSnapshot) => {
    saved = structuredClone(snapshot);
  });
  const repository: WorkbenchRepository = {
    migrationPending: false,
    load: async () => saved,
    loadCatalog: catalogForTestSnapshot,
    save,
    appendObservation: unused,
    createSourceBaseline: baseline,
    captureSourceChange: capture,
    readRunPatch: readPatch,
  };
  const app = new WorkbenchApplication(repository, runtime, vi.fn());
  await app.getSnapshot();
  const command = (data: Record<string, unknown>, workspaceId = 'taskflow-demo') =>
    app.command(WorkbenchCommandSchema.parse({ commandId: randomUUID(), workspaceId, ...data }));
  const owner = async (workspaceId = 'taskflow-demo') =>
    required((await app.getSnapshot()).workspaces.find((space) => space.workspaceId === workspaceId));
  const prepare = async (workspaceId = 'taskflow-demo') => {
    if (workspaceId !== 'taskflow-demo') {
      expect((await command({ type: 'createWorkspace', name: workspaceId }, workspaceId)).ok).toBe(true);
      expect((await command({ type: 'createTab', kind: 'session', title: 'Independent session' }, workspaceId)).ok).toBe(true);
    }
    expect((await command({ type: 'createApp' }, workspaceId)).ok).toBe(true);
    expect((await command({ type: 'startApp' }, workspaceId)).ok).toBe(true);
    let space = await owner(workspaceId);
    const session = required(space.sessions[0]);
    const browser = required(space.resources.find((resource) => resource.appProjectId));
    const requestId = randomUUID();
    expect(
      (await command({ type: 'captureContext', sessionId: session.sessionId, resourceId: browser.resourceId, requestId }, workspaceId)).ok,
    ).toBe(true);
    space = await owner(workspaceId);
    const current = required(space.resources.find((resource) => resource.resourceId === browser.resourceId));
    const captureId = randomUUID();
    app.onCapture(
      browser.resourceId,
      {
        captureId,
        capturedAt: 'fixture',
        page: page.page,
        element: {
          tagName: 'button',
          id: null,
          classes: [],
          role: 'button',
          ariaLabel: null,
          testId: 'button',
          text: 'old',
          selector: 'button',
          rect: null,
        },
        screenshot: { viewport: 'data:image/png;base64,AA==', element: null },
        consoleIssues: [],
      },
      current.instanceId,
      current.generation,
      requestId,
    );
    await app.getSnapshot();
    expect(
      (
        await command(
          {
            type: 'confirmTask',
            sessionId: session.sessionId,
            goal: 'change button',
            targetRef: { kind: 'web', resourceId: browser.resourceId },
            appId: required(space.app).appId,
            captureId,
          },
          workspaceId,
        )
      ).ok,
    ).toBe(true);
    space = await owner(workspaceId);
    const version = required(required(space.sessions[0]).taskVersions[0]);
    const start = () => command({ type: 'startRun', sessionId: session.sessionId, taskVersionId: version.taskVersionId }, workspaceId);
    const run = async () => required((await owner(workspaceId)).runs.at(-1));
    const finish = (state: 'idle' | 'failed' | 'cancelled' = 'idle', cleanupPending = false) => {
      const before = required(turns.get(session.sessionId));
      const conversation = {
        ...before,
        state,
        cleanupPending,
        seq: before.seq + 1,
      };
      turns.set(session.sessionId, conversation);
      app.onConversation(conversation);
      return conversation;
    };
    return { space, session, version, start, run, finish };
  };
  return {
    app,
    runtime,
    repository,
    command,
    owner,
    prepare,
    snapshots,
    send,
    register,
    cancel,
    baseline,
    capture,
    readPatch,
    save,
    saved: () => saved,
  };
}

describe('Main source evidence lifecycle', () => {
  it('persists the host baseline before dispatch and never gives host evidence to guest', async () => {
    const f = await fixture();
    const p = await f.prepare();
    const gate = deferred<AppSourceSnapshotResult>();
    f.snapshots.mockReturnValueOnce(gate.promise);
    const launching = p.start();
    await vi.waitFor(() => expect(f.snapshots).toHaveBeenCalledOnce());
    expect((await p.run()).state).toBe('starting');
    expect(f.send).not.toHaveBeenCalled();
    expect((await f.command({ type: 'createWorkspace', name: 'independent' }, 'other')).ok).toBe(true);
    gate.resolve(source(required(f.snapshots.mock.calls[0])[0]));
    await launching;
    const run = await p.run();
    expect(run.sourceChange).toEqual({ state: 'baseline', baseTree });
    expect(
      f.save.mock.calls.some(([snapshot]) =>
        snapshot.workspaces.some((space) => space.runs.some((item) => item.runId === run.runId && item.sourceChange?.state === 'baseline')),
      ),
    ).toBe(true);
    expect(f.baseline.mock.invocationCallOrder[0]).toBeLessThan(required(f.send.mock.invocationCallOrder[0]));
    const payload = JSON.stringify(f.send.mock.calls);
    expect(payload).not.toContain(baseTree);
    expect(payload).not.toContain('source.patch');
    p.finish();
    await vi.waitFor(async () => expect((await p.run()).sourceChange?.state).toBe('captured'));
    expect((await p.run()).validation.state).toBe('not_run');
    expect((await p.run()).review).toBeNull();
  });
  it.each(['guest', 'host'])('baseline %s failure does not block the model', async (kind) => {
    const f = await fixture();
    const p = await f.prepare();
    if (kind === 'guest')
      f.snapshots.mockImplementationOnce(async (target) => ({
        ok: false,
        target,
        cleanupConfirmed: true,
        error: 'snapshot budget exceeded',
      }));
    else f.baseline.mockRejectedValueOnce(new Error('宿主 Git 不可用'));
    expect((await p.start()).ok).toBe(true);
    expect(f.send).toHaveBeenCalledOnce();
    expect((await p.run()).sourceChange).toMatchObject({ state: 'unavailable', reason: expect.stringContaining('基线') });
    p.finish();
    await f.app.getSnapshot();
    expect(f.capture).not.toHaveBeenCalled();
  });
  it('never dispatches a model on an explicitly unconfirmed baseline helper receipt', async () => {
    const f = await fixture();
    const p = await f.prepare();
    f.snapshots.mockImplementationOnce(async (target) => ({
      ok: false,
      target,
      cleanupConfirmed: false,
      error: 'synthetic collector failure',
    }));
    await p.start();
    expect(f.send).not.toHaveBeenCalled();
    expect(await p.run()).toMatchObject({
      state: 'cancelling',
      cleanupPending: true,
      sourceCleanupPending: true,
      executorState: { cleanupPending: false },
    });
    expect(await p.start()).toMatchObject({ ok: false, error: { code: 'conflict' } });
    expect(await f.command({ type: 'startApp' })).toMatchObject({ ok: false, error: { code: 'conflict' } });
    await expect(f.app.shutdown()).rejects.toThrow('清理未确认');
    expect(f.cancel).not.toHaveBeenCalled();
  });
  it.each(['idle', 'failed', 'cancelled'] as const)(
    'captures confirmed %s termination, including changes on cancellation',
    async (state) => {
      const f = await fixture();
      const p = await f.prepare();
      await p.start();
      if (state === 'cancelled') await f.command({ type: 'cancelRun', runId: (await p.run()).runId });
      else p.finish(state);
      await vi.waitFor(async () => expect((await p.run()).sourceChange).toEqual(captured));
      expect((await p.run()).state).toBe(state === 'idle' ? 'completed' : state);
      expect(f.snapshots).toHaveBeenCalledTimes(2);
      expect(f.capture).toHaveBeenCalledOnce();
    },
  );
  it('waits for model cleanup confirmation and ignores App-only cleanup as proof of executor exit', async () => {
    const f = await fixture();
    const p = await f.prepare();
    await p.start();
    p.finish('failed', true);
    const run = await p.run();
    expect(run.state).toBe('cancelling');
    f.app.onAppCleanupChanged(run.workspaceId, run.runId);
    await f.app.getSnapshot();
    expect(f.snapshots).toHaveBeenCalledOnce();
    expect(f.capture).not.toHaveBeenCalled();
    p.finish('failed', false);
    await vi.waitFor(async () => expect((await p.run()).sourceChange?.state).toBe('captured'));
  });
  it('cancels during registration, releases an undispatched project and discards late registration without poisoning a newer run', async () => {
    const f = await fixture();
    const p = await f.prepare();
    const gate = deferred<void>();
    f.register.mockReturnValueOnce(gate.promise);
    const first = p.start();
    await vi.waitFor(() => expect(f.register).toHaveBeenCalledOnce());
    const old = await p.run();
    await f.command({ type: 'cancelRun', runId: old.runId });
    expect((await p.run()).state).toBe('cancelled');
    await p.start();
    const current = await p.run();
    gate.resolve();
    await first;
    expect((await p.run()).runId).toBe(current.runId);
    expect((await p.run()).state).toBe('running');
    expect(f.send).toHaveBeenCalledOnce();
    expect(f.baseline).toHaveBeenCalledOnce();
    p.finish();
    await vi.waitFor(async () => expect((await p.run()).sourceChange?.state).toBe('captured'));
  });
  it('keeps a source-helper cleanup failure visible after baseline cancellation without dispatching', async () => {
    const f = await fixture();
    const p = await f.prepare();
    f.snapshots.mockImplementationOnce(
      (_target, signal) =>
        new Promise<AppSourceSnapshotResult>((_resolve, reject) => {
          signal.addEventListener('abort', () => reject(new Error('源码 helper 清理未确认')), { once: true });
        }),
    );
    const first = p.start();
    await vi.waitFor(() => expect(f.snapshots).toHaveBeenCalledOnce());
    await f.command({ type: 'cancelRun', runId: (await p.run()).runId });
    await first;
    expect((await p.run()).sourceChange).toMatchObject({ state: 'unavailable', reason: expect.stringContaining('清理未确认') });
    expect(f.send).not.toHaveBeenCalled();
    expect(f.baseline).not.toHaveBeenCalled();
    expect(await p.run()).toMatchObject({ state: 'cancelling', cleanupPending: true, sourceCleanupPending: true, endedAt: null });
    expect(await p.start()).toMatchObject({ ok: false, error: { code: 'conflict' } });
    await expect(f.app.shutdown()).rejects.toThrow('清理未确认');
  });
  it('cancels an inflight baseline, rejects a racing run and never accepts a late raw snapshot as baseline', async () => {
    const f = await fixture();
    const p = await f.prepare();
    const gate = deferred<AppSourceSnapshotResult>();
    f.snapshots.mockReturnValueOnce(gate.promise);
    const first = p.start();
    await vi.waitFor(() => expect(f.snapshots).toHaveBeenCalledOnce());
    const old = await p.run();
    await f.command({ type: 'cancelRun', runId: old.runId });
    expect(required(f.snapshots.mock.calls[0])[1].aborted).toBe(true);
    expect(await p.start()).toMatchObject({ ok: false, error: { code: 'conflict' } });
    gate.resolve(source(required(f.snapshots.mock.calls[0])[0]));
    await first;
    expect(f.send).not.toHaveBeenCalled();
    expect(f.baseline).not.toHaveBeenCalled();
    expect((await p.run()).sourceChange?.state).toBe('unavailable');
    expect((await p.start()).ok).toBe(true);
    expect(f.send).toHaveBeenCalledOnce();
    p.finish();
    await vi.waitFor(async () => expect((await p.run()).sourceChange?.state).toBe('captured'));
  });
  it('keeps cancellation pending until the owned source receipt arrives, even after an App-only cleanup receipt', async () => {
    const f = await fixture();
    const p = await f.prepare();
    const gate = deferred<AppSourceSnapshotResult>();
    f.snapshots.mockReturnValueOnce(gate.promise);
    const first = p.start();
    await vi.waitFor(() => expect(f.snapshots).toHaveBeenCalledOnce());
    try {
      const run = await p.run();
      await f.command({ type: 'cancelRun', runId: run.runId });
      f.app.onAppCleanupChanged(run.workspaceId, run.runId);
      expect(await p.run()).toMatchObject({ state: 'cancelling', cleanupPending: true, sourceCleanupPending: true, endedAt: null });
      expect(await p.start()).toMatchObject({ ok: false, error: { code: 'conflict' } });
      expect(f.cancel).not.toHaveBeenCalled();
    } finally {
      gate.resolve(source(required(f.snapshots.mock.calls[0])[0]));
      await first;
    }
    expect(await p.run()).toMatchObject({ state: 'cancelled', cleanupPending: false, sourceCleanupPending: false });
    await expect(f.app.shutdown()).resolves.toBeUndefined();
  });
  it.each(['receipt', 'transport'])(
    'keeps final source %s uncertainty gated, independent of App cleanup and other projects',
    async (kind) => {
      const f = await fixture();
      const p = await f.prepare();
      const other = await f.prepare('independent-source');
      await p.start();
      if (kind === 'receipt')
        f.snapshots.mockImplementationOnce(async (target) => ({
          ok: false,
          target,
          cleanupConfirmed: false,
          error: 'synthetic failure with no cleanup keywords',
        }));
      else f.snapshots.mockRejectedValueOnce(new Error('synthetic source transport lost'));
      p.finish();
      await vi.waitFor(async () => expect((await p.run()).sourceChange?.state).toBe('unavailable'));
      const run = await p.run();
      f.app.onAppCleanupChanged(run.workspaceId, run.runId);
      expect(await p.run()).toMatchObject({ state: 'completed', cleanupPending: true, sourceCleanupPending: true });
      expect(await p.start()).toMatchObject({ ok: false, error: { code: 'conflict' } });
      expect((await other.start()).ok).toBe(true);
      other.finish();
      await vi.waitFor(async () => expect((await other.run()).sourceChange?.state).toBe('captured'));
      expect((await p.run()).validation.state).toBe('not_run');
      expect((await p.run()).review).toBeNull();
      await expect(f.app.shutdown()).rejects.toThrow('清理未确认');
      expect(f.cancel).not.toHaveBeenCalled();
    },
  );
  it('does not confirm cancellation when the ending source helper cleanup is unknown', async () => {
    const f = await fixture();
    const p = await f.prepare();
    await p.start();
    f.snapshots.mockImplementationOnce(async (target) => ({ ok: false, target, cleanupConfirmed: false, error: 'synthetic' }));
    p.finish('cancelled');
    await vi.waitFor(async () => expect((await p.run()).sourceChange?.state).toBe('unavailable'));
    expect(await p.run()).toMatchObject({
      state: 'cancelling',
      endedAt: null,
      sourceCleanupPending: true,
      cleanupPending: true,
      executorState: { state: 'cancelled', cleanupPending: false },
    });
    f.app.onAppCleanupChanged((await p.run()).workspaceId, (await p.run()).runId);
    expect(await p.start()).toMatchObject({ ok: false, error: { code: 'conflict' } });
    await expect(f.app.shutdown()).rejects.toThrow('清理未确认');
    expect(f.cancel).not.toHaveBeenCalled();
  });
  it('does not rewrite a completed execution or its review when ending-source cleanup becomes unknown', async () => {
    const f = await fixture();
    const p = await f.prepare();
    await p.start();
    const ending = deferred<AppSourceSnapshotResult>();
    f.snapshots.mockReturnValueOnce(ending.promise);
    p.finish();
    await vi.waitFor(() => expect(f.snapshots).toHaveBeenCalledTimes(2));
    const run = await p.run();
    expect(
      (await f.command({ type: 'recordReview', runId: run.runId, candidateId: run.candidateId, decision: 'changes_requested' })).ok,
    ).toBe(true);
    ending.resolve({ ok: false, target: required(f.snapshots.mock.calls[1])[0], cleanupConfirmed: false, error: 'synthetic' });
    await vi.waitFor(async () => expect((await p.run()).sourceChange?.state).toBe('unavailable'));
    expect(await p.run()).toMatchObject({
      state: 'completed',
      sourceCleanupPending: true,
      cleanupPending: true,
      executorState: { state: 'idle', cleanupPending: false },
      review: { decision: 'changes_requested' },
    });
    const restored = new WorkbenchApplication(f.repository, f.runtime, vi.fn());
    await expect(restored.getSnapshot()).resolves.toMatchObject({
      workspaces: expect.arrayContaining([
        expect.objectContaining({
          runs: expect.arrayContaining([expect.objectContaining({ runId: run.runId, state: 'completed', sourceCleanupPending: true })]),
        }),
      ]),
    });
    await expect(restored.shutdown()).rejects.toThrow('清理未确认');
  });
  it('persists unresolved source cleanup through schema4 restart without replay or App-only clearance', async () => {
    const f = await fixture();
    const p = await f.prepare();
    await p.start();
    f.snapshots.mockRejectedValueOnce(new Error('synthetic source transport lost'));
    p.finish();
    await vi.waitFor(async () => expect((await p.run()).sourceChange?.state).toBe('unavailable'));
    const run = await p.run();
    const root = await mkdtemp(path.join(tmpdir(), 'wsl-source-unresolved-'));
    roots.push(root);
    const file = path.join(root, 'workbench.json');
    const snapshot = required(f.saved());
    await new FileWorkbenchRepository(file).save(snapshot, await catalogForTestSnapshot(snapshot));
    const restored = new WorkbenchApplication(new FileWorkbenchRepository(file), f.runtime, vi.fn());
    await restored.getSnapshot();
    restored.onAppCleanupChanged(run.workspaceId, run.runId);
    const savedRun = required(required((await restored.getSnapshot()).workspaces[0]).runs[0]);
    expect(savedRun).toMatchObject({ state: 'completed', sourceCleanupPending: true, cleanupPending: true, endedAt: run.endedAt });
    expect(savedRun.error).toContain('源码');
    expect(f.snapshots).toHaveBeenCalledTimes(2);
    expect(f.send).toHaveBeenCalledOnce();
    expect(
      await restored.command(
        WorkbenchCommandSchema.parse({
          type: 'startRun',
          commandId: randomUUID(),
          workspaceId: run.workspaceId,
          sessionId: run.sessionId,
          taskVersionId: run.taskVersionId,
        }),
      ),
    ).toMatchObject({ ok: false, error: { code: 'conflict' } });
    expect(
      await restored.command(
        WorkbenchCommandSchema.parse({
          type: 'startApp',
          commandId: randomUUID(),
          workspaceId: run.workspaceId,
        }),
      ),
    ).toMatchObject({ ok: false, error: { code: 'conflict' } });
    await expect(restored.shutdown()).rejects.toThrow('清理未确认');
    expect(f.cancel).not.toHaveBeenCalled();
  });
  it('captures a rejected undispatched send, but not a transport failure with unknown cleanup', async () => {
    const f = await fixture();
    const p = await f.prepare();
    f.send.mockRejectedValueOnce(new Error('admission rejected'));
    await p.start();
    await vi.waitFor(async () => expect((await p.run()).sourceChange?.state).toBe('captured'));
    expect((await p.run()).state).toBe('failed');
    f.send.mockRejectedValueOnce(new RunDispatchFailure('transport disconnected', true));
    await p.start();
    expect((await p.run()).state).toBe('cancelling');
    expect((await p.run()).executorState?.cleanupPending).toBe(true);
    expect(f.capture).toHaveBeenCalledOnce();
  });
  it.each(['disconnect', 'rejection'] as const)('pending send + idle query keeps source/project cleanup causal: %s', async (outcome) => {
    const f = await fixture();
    const p = await f.prepare();
    const service = new ChatService((conversation) => f.app.onConversation(conversation), vi.fn());
    f.send.mockImplementation((...args) => service.send(...args));
    const starting = p.start();
    await vi.waitFor(() => expect(f.send).toHaveBeenCalledOnce());
    const sendRequest = required(serviceMock.postMessage.mock.calls.find(([request]) => request.method === 'send'))[0];
    const querying = service.get(p.session.sessionId);
    const query = required(serviceMock.postMessage.mock.calls.at(-1))[0];
    serviceMock.callbacks.get('message')?.({
      type: 'response',
      id: query.id,
      result: {
        conversationId: p.session.sessionId,
        generation: 'generation',
        seq: 0,
        threadId: null,
        turnId: null,
        state: 'idle',
        messages: [],
        toolExecutions: [],
        warnings: [],
        cleanupPending: false,
        error: null,
      },
    });
    await querying;
    if (outcome === 'disconnect') {
      // Reproduce the production failure fallback: no ending helper was sent, so
      // that helper's cleanup=true must not erase the unresolved model dispatch.
      f.snapshots.mockImplementation((target, signal) => service.appSourceSnapshot(target, signal));
      serviceMock.callbacks.get('exit')?.(1);
    } else serviceMock.callbacks.get('message')?.({ type: 'error', id: sendRequest.id, error: 'admission rejected' });
    await starting;
    const managedApp = required((await f.owner()).managedApp);
    await f.app.onApp({ ...managedApp, state: 'stopped', url: null, cleanupConfirmed: true });
    if (outcome === 'disconnect') {
      await vi.waitFor(async () => expect((await p.run()).state).toBe('cancelling'));
      expect(await p.run()).toMatchObject({
        cleanupPending: true,
        executorState: { cleanupPending: true },
        sourceChange: { state: 'baseline', baseTree },
      });
      expect(f.snapshots).toHaveBeenCalledOnce();
      expect(f.capture).not.toHaveBeenCalled();
      expect(await p.start()).toMatchObject({ ok: false, error: { code: 'conflict' } });
      expect(await f.command({ type: 'startApp' })).toMatchObject({
        ok: false,
        error: { code: 'conflict', message: expect.stringContaining('清理未确认') },
      });
      await expect(f.app.shutdown()).rejects.toThrow('清理未确认');
      await expect(service.shutdown()).rejects.toThrow('清理未确认');
    } else {
      await vi.waitFor(async () => expect((await p.run()).sourceChange?.state).toBe('captured'));
      expect(await p.run()).toMatchObject({ state: 'failed', cleanupPending: false, executorState: { cleanupPending: false } });
      expect(f.capture).toHaveBeenCalledOnce();
      expect((await f.command({ type: 'startApp' })).ok).toBe(true);
      expect(service.writeHolder()).toBeNull();
      serviceMock.callbacks.get('exit')?.(0);
      await expect(service.shutdown()).resolves.toBeUndefined();
    }
  });
  it.each(['disconnect', 'rejection', 'ack'] as const)(
    'does not finalize a cancelled run before its own send receipt: %s',
    async (outcome) => {
      const f = await fixture();
      const p = await f.prepare();
      const service = new ChatService((conversation) => f.app.onConversation(conversation), vi.fn());
      f.send.mockImplementation((...args) => service.send(...args));
      f.cancel.mockImplementation((...args) => service.cancel(...args));
      f.runtime.writeHolder = () => service.writeHolder();
      const starting = p.start();
      try {
        await vi.waitFor(() => expect(f.send).toHaveBeenCalledOnce());
        const sendRequest = required(serviceMock.postMessage.mock.calls.find(([request]) => request.method === 'send'))[0];
        const runId = (await p.run()).runId;
        await f.command({ type: 'cancelRun', runId });
        await vi.waitFor(() => expect(f.cancel).toHaveBeenCalledOnce());
        const cancelRequest = required(serviceMock.postMessage.mock.calls.find(([request]) => request.method === 'cancel'))[0];
        const clean: ChatConversation = {
          conversationId: p.session.sessionId,
          generation: 'generation',
          turnId: 'cancel-before-send-ack',
          seq: 2,
          threadId: null,
          state: 'cancelled',
          messages: [],
          toolExecutions: [],
          warnings: [],
          cleanupPending: false,
          error: null,
        };
        serviceMock.callbacks.get('message')?.({ type: 'response', id: cancelRequest.id, result: clean });
        await required(f.cancel.mock.results[0]).value;
        expect(await p.run()).toMatchObject({ state: 'cancelling', cleanupPending: true, endedAt: null });
        expect(f.snapshots).toHaveBeenCalledOnce();
        expect(f.capture).not.toHaveBeenCalled();
        expect(service.writeHolder()).toBe(p.session.sessionId);
        const managedApp = required((await f.owner()).managedApp);
        await f.app.onApp({ ...managedApp, state: 'stopped', url: null, cleanupConfirmed: true });
        expect(await f.command({ type: 'startApp' })).toMatchObject({ ok: false, error: { code: 'conflict' } });
        if (outcome === 'disconnect') serviceMock.callbacks.get('exit')?.(1);
        else if (outcome === 'rejection')
          serviceMock.callbacks.get('message')?.({ type: 'error', id: sendRequest.id, error: 'admission rejected' });
        else
          serviceMock.callbacks.get('message')?.({
            type: 'response',
            id: sendRequest.id,
            result: { ...clean, seq: 1, state: 'running', cleanupPending: true },
          });
        await starting;
        if (outcome === 'disconnect') {
          expect(await p.run()).toMatchObject({
            state: 'cancelling',
            cleanupPending: true,
            endedAt: null,
            sourceChange: { state: 'baseline', baseTree },
          });
          // A later event cannot manufacture the missing send receipt.
          serviceMock.callbacks.get('message')?.({ type: 'event', conversation: { ...clean, seq: 3 } });
          expect((await p.run()).cleanupPending).toBe(true);
          expect(f.capture).not.toHaveBeenCalled();
          expect(f.snapshots).toHaveBeenCalledOnce();
          expect(await p.start()).toMatchObject({ ok: false, error: { code: 'conflict' } });
          expect(await f.command({ type: 'startApp' })).toMatchObject({ ok: false, error: { code: 'conflict' } });
          await expect(f.app.shutdown()).rejects.toThrow('清理未确认');
          await expect(service.shutdown()).rejects.toThrow('清理未确认');
        } else {
          await vi.waitFor(async () => expect((await p.run()).sourceChange?.state).toBe('captured'));
          expect(await p.run()).toMatchObject({ state: 'cancelled', cleanupPending: false });
          expect(f.capture).toHaveBeenCalledOnce();
          expect(service.writeHolder()).toBeNull();
          // Stopping the app invalidated the old page instance. Restore a real
          // public-command capture/confirmation before checking the next run.
          expect((await f.command({ type: 'startApp' })).ok).toBe(true);
          const browser = required((await f.owner()).resources.find((resource) => resource.appProjectId));
          const requestId = randomUUID();
          expect(
            (await f.command({ type: 'captureContext', sessionId: p.session.sessionId, resourceId: browser.resourceId, requestId })).ok,
          ).toBe(true);
          const currentBrowser = required((await f.owner()).resources.find((resource) => resource.resourceId === browser.resourceId));
          f.app.onCapture(
            browser.resourceId,
            { ...required(p.version.capture), captureId: randomUUID() },
            currentBrowser.instanceId,
            currentBrowser.generation,
            requestId,
          );
          await f.app.getSnapshot();
          expect(
            (
              await f.command({
                type: 'confirmTask',
                sessionId: p.session.sessionId,
                goal: 'next run',
                targetRef: { kind: 'web', resourceId: browser.resourceId },
              })
            ).ok,
          ).toBe(true);
          const nextVersion = required(
            required((await f.owner()).sessions.find((session) => session.sessionId === p.session.sessionId)).taskVersions.at(-1),
          );
          f.send.mockImplementation(async (sessionId) => ({
            ...clean,
            conversationId: sessionId,
            turnId: 'new-turn',
            seq: 4,
            state: 'running',
            cleanupPending: true,
          }));
          const restarted = await f.command({ type: 'startRun', sessionId: p.session.sessionId, taskVersionId: nextVersion.taskVersionId });
          expect(restarted.ok, JSON.stringify(restarted.ok ? null : restarted.error)).toBe(true);
          serviceMock.callbacks.get('message')?.({ type: 'event', conversation: { ...clean, seq: 999 } });
          expect(await p.run()).toMatchObject({ state: 'running', executionBinding: { turnId: 'new-turn' } });
          f.app.onConversation({ ...clean, turnId: 'new-turn', seq: 5 });
          await vi.waitFor(async () => expect((await p.run()).sourceChange?.state).toBe('captured'));
          expect(f.capture).toHaveBeenCalledTimes(2);
          const restoredApp = required((await f.owner()).managedApp);
          await f.app.onApp({ ...restoredApp, state: 'stopped', url: null, cleanupConfirmed: true });
          const appRestart = await f.command({ type: 'startApp' });
          expect(appRestart.ok, JSON.stringify(appRestart.ok ? null : appRestart.error)).toBe(true);
        }
      } finally {
        serviceMock.callbacks.get('exit')?.(1);
        await starting;
        await service.shutdown().catch(() => undefined);
      }
    },
  );
  it('binds a cancelled pending send to its ACK before accepting later cleanup events', async () => {
    const f = await fixture();
    const p = await f.prepare();
    const service = new ChatService((conversation) => f.app.onConversation(conversation), vi.fn());
    f.send.mockImplementation((...args) => service.send(...args));
    f.cancel.mockImplementation((...args) => service.cancel(...args));
    const starting = p.start();
    try {
      await vi.waitFor(() => expect(f.send).toHaveBeenCalledOnce());
      const sendRequest = required(serviceMock.postMessage.mock.calls.find(([request]) => request.method === 'send'))[0];
      await f.command({ type: 'cancelRun', runId: (await p.run()).runId });
      await vi.waitFor(() => expect(f.cancel).toHaveBeenCalledOnce());
      const cancelRequest = required(serviceMock.postMessage.mock.calls.find(([request]) => request.method === 'cancel'))[0];
      const old: ChatConversation = {
        conversationId: p.session.sessionId,
        generation: 'generation',
        turnId: 'old-turn',
        seq: 2,
        threadId: null,
        state: 'cancelled',
        messages: [],
        toolExecutions: [],
        warnings: [],
        cleanupPending: false,
        error: null,
      };
      // Both a terminal event and cancellation ACK can refer to the prior turn.
      serviceMock.callbacks.get('message')?.({ type: 'event', conversation: old });
      serviceMock.callbacks.get('message')?.({ type: 'response', id: cancelRequest.id, result: old });
      await required(f.cancel.mock.results[0]).value;
      expect(await p.run()).toMatchObject({ state: 'cancelling', cleanupPending: true, endedAt: null });
      expect(f.capture).not.toHaveBeenCalled();
      const owned = { ...old, turnId: 'owned-turn', seq: 3, state: 'running' as const, cleanupPending: true };
      serviceMock.callbacks.get('message')?.({ type: 'response', id: sendRequest.id, result: owned });
      await starting;
      expect(await p.run()).toMatchObject({ state: 'cancelling', cleanupPending: true, executionBinding: { turnId: 'owned-turn' } });
      serviceMock.callbacks.get('message')?.({ type: 'event', conversation: { ...old, seq: 4 } });
      expect(await p.run()).toMatchObject({ state: 'cancelling', cleanupPending: true, executionBinding: { turnId: 'owned-turn' } });
      expect(f.capture).not.toHaveBeenCalled();
      serviceMock.callbacks.get('message')?.({
        type: 'event',
        conversation: { ...owned, seq: 5, state: 'cancelled', cleanupPending: false },
      });
      await vi.waitFor(async () => expect((await p.run()).sourceChange?.state).toBe('captured'));
      expect(await p.run()).toMatchObject({ state: 'cancelled', cleanupPending: false });
      expect(f.capture).toHaveBeenCalledOnce();
    } finally {
      serviceMock.callbacks.get('exit')?.(1);
      await starting;
      await service.shutdown().catch(() => undefined);
    }
  });
  it('retains a baseline saved during cancellation and still captures its ending state', async () => {
    const f = await fixture();
    const p = await f.prepare();
    const gate = deferred<{ baseTree: string }>();
    f.baseline.mockReturnValueOnce(gate.promise);
    const starting = p.start();
    await vi.waitFor(() => expect(f.baseline).toHaveBeenCalledOnce());
    await f.command({ type: 'cancelRun', runId: (await p.run()).runId });
    gate.resolve({ baseTree });
    await starting;
    await vi.waitFor(async () => expect((await p.run()).sourceChange?.state).toBe('captured'));
    expect((await p.run()).state).toBe('cancelled');
    expect(f.send).not.toHaveBeenCalled();
  });
  it('protects the same project through ending capture but lets another workspace progress, dropping old turn receipts', async () => {
    const f = await fixture();
    const first = await f.prepare();
    const other = await f.prepare('independent');
    await first.start();
    const ending = deferred<AppSourceSnapshotResult>();
    f.snapshots.mockReturnValueOnce(ending.promise);
    const oldReceipt = first.finish();
    await vi.waitFor(() => expect(f.snapshots).toHaveBeenCalledTimes(2));
    expect(await first.start()).toMatchObject({ ok: false, error: { code: 'conflict' } });
    expect((await other.start()).ok).toBe(true);
    other.finish();
    await vi.waitFor(async () => expect((await other.run()).sourceChange?.state).toBe('captured'));
    ending.resolve(source(required(f.snapshots.mock.calls[1])[0]));
    await vi.waitFor(async () => expect((await first.run()).sourceChange?.state).toBe('captured'));
    await first.start();
    const newest = await first.run();
    f.app.onConversation({ ...oldReceipt, seq: 999 });
    expect((await first.run()).executionBinding).toEqual(newest.executionBinding);
    expect((await first.run()).state).toBe('running');
    first.finish();
    await vi.waitFor(async () => expect((await first.run()).sourceChange?.state).toBe('captured'));
  });
  it('ignores a late cancellation ACK after the old turn ended and a newer same-project run started', async () => {
    const f = await fixture();
    const p = await f.prepare();
    await p.start();
    const cancellation = deferred<ChatConversation>();
    f.cancel.mockReturnValueOnce(cancellation.promise);
    await f.command({ type: 'cancelRun', runId: (await p.run()).runId });
    await vi.waitFor(() => expect(f.cancel).toHaveBeenCalledOnce());
    const oldReceipt = p.finish('cancelled');
    await vi.waitFor(async () => expect((await p.run()).sourceChange?.state).toBe('captured'));
    await p.start();
    const current = await p.run();
    cancellation.resolve({ ...oldReceipt, seq: 999 });
    await f.app.getSnapshot();
    expect((await p.run()).executionBinding).toEqual(current.executionBinding);
    expect((await p.run()).sourceChange).toEqual({ state: 'baseline', baseTree });
    expect((await p.run()).state).toBe('running');
    p.finish();
    await vi.waitFor(async () => expect((await p.run()).sourceChange?.state).toBe('captured'));
  });
  it('rejects a service snapshot for a different project before storing its baseline', async () => {
    const f = await fixture();
    const p = await f.prepare();
    f.snapshots.mockImplementationOnce(async (target) => source({ ...target, projectId: randomUUID() }));
    await p.start();
    expect(f.baseline).not.toHaveBeenCalled();
    expect((await p.run()).sourceChange).toMatchObject({ state: 'unavailable', reason: expect.stringContaining('归属') });
    expect(f.send).not.toHaveBeenCalled();
    expect(await p.run()).toMatchObject({ state: 'cancelling', cleanupPending: true, sourceCleanupPending: true });
    await expect(f.app.shutdown()).rejects.toThrow('清理未确认');
  });
  it('marks capture failure unavailable and does not change review or validation', async () => {
    const f = await fixture();
    const p = await f.prepare();
    await p.start();
    f.capture.mockRejectedValueOnce(new Error('exclusive patch write failed'));
    p.finish();
    await vi.waitFor(async () => expect((await p.run()).sourceChange?.state).toBe('unavailable'));
    expect((await p.run()).validation).toEqual({ state: 'not_run', applicability: 'unknown', reason: null });
    expect((await p.run()).review).toBeNull();
  });
  it('checks run/workspace ownership and patch hashes before returning a narrow result', async () => {
    const f = await fixture();
    const p = await f.prepare();
    await p.start();
    const runId = (await p.run()).runId;
    await expect(f.app.runPatch('taskflow-demo', runId)).rejects.toThrow('没有已采集');
    p.finish();
    await vi.waitFor(async () => expect((await p.run()).sourceChange?.state).toBe('captured'));
    await f.command({ type: 'createWorkspace', name: 'Other' }, 'other');
    await expect(f.app.runPatch('other', runId)).rejects.toThrow();
    await expect(f.app.runPatch('taskflow-demo', '../escape')).rejects.toThrow();
    expect(f.readPatch).not.toHaveBeenCalled();
    expect(await f.app.runPatch('taskflow-demo', runId)).toEqual({
      workspaceId: 'taskflow-demo',
      runId,
      patchSha256: captured.patchSha256,
      patch,
    });
    f.readPatch.mockResolvedValueOnce('corrupt');
    await expect(f.app.runPatch('taskflow-demo', runId)).rejects.toThrow('SHA-256');
  });
  it('shutdown cancels the model and waits for ending capture instead of dropping its promise', async () => {
    const f = await fixture();
    const p = await f.prepare();
    await p.start();
    const gate = deferred<AppSourceSnapshotResult>();
    f.snapshots.mockReturnValueOnce(gate.promise);
    const closing = f.app.shutdown();
    let ended = false;
    void closing.then(() => {
      ended = true;
    });
    await vi.waitFor(() => expect(f.snapshots).toHaveBeenCalledTimes(2));
    expect(ended).toBe(false);
    expect((await p.start()).ok).toBe(false);
    gate.resolve(source(required(f.snapshots.mock.calls[1])[0]));
    await closing;
    expect((await p.run()).sourceChange?.state).toBe('captured');
    expect((await p.run()).state).toBe('cancelled');
  });
  it('does not invent owned work or block service cleanup when initialization metadata cannot be read', async () => {
    const f = await fixture();
    const broken: WorkbenchRepository = {
      ...f.repository,
      load: async () => {
        throw new Error('unreadable workbench');
      },
    };
    const unopened = new WorkbenchApplication(broken, f.runtime, vi.fn());
    await expect(unopened.getSnapshot()).rejects.toThrow('unreadable workbench');
    await expect(unopened.shutdown()).resolves.toBeUndefined();
    expect(f.cancel).not.toHaveBeenCalled();
    expect(f.snapshots).not.toHaveBeenCalled();
  });
  it('persists unavailable rather than capturing or claiming success when shutdown cannot confirm the model', async () => {
    const f = await fixture();
    const p = await f.prepare();
    await p.start();
    const pending = p.finish('failed', true);
    f.cancel.mockResolvedValueOnce({ ...pending, seq: pending.seq + 1 });
    await expect(f.app.shutdown()).rejects.toThrow('清理未确认');
    expect((await p.run()).sourceChange).toEqual({ state: 'unavailable', reason: '退出前未完成采集：执行器或所属操作清理未确认' });
    expect(f.capture).not.toHaveBeenCalled();
  });
  it('recovers an interrupted starting run with no completed baseline without collecting again', async () => {
    const f = await fixture();
    const p = await f.prepare();
    await p.start();
    const snapshot = required(f.saved());
    const savedRun = required(required(snapshot.workspaces[0]).runs[0]);
    savedRun.state = 'starting';
    delete savedRun.sourceChange;
    const recovered = await new WorkbenchApplication(f.repository, f.runtime, vi.fn()).getSnapshot();
    expect(required(required(recovered.workspaces[0]).runs[0]).sourceChange).toEqual({ state: 'unavailable', reason: '重启前未完成采集' });
    expect(f.snapshots).toHaveBeenCalledOnce();
    p.finish();
    await vi.waitFor(async () => expect((await p.run()).sourceChange?.state).toBe('captured'));
  });
  it('recovers unfinished baseline once, never recollects, and reads old schema4 without rewriting', async () => {
    const f = await fixture();
    const p = await f.prepare();
    await p.start();
    p.finish();
    await vi.waitFor(async () => expect((await p.run()).sourceChange?.state).toBe('captured'));
    const snapshot = required(f.saved());
    const run = required(required(snapshot.workspaces[0]).runs[0]);
    run.sourceChange = { state: 'baseline', baseTree };
    const root = await mkdtemp(path.join(tmpdir(), 'wsl-source-recovery-'));
    roots.push(root);
    const file = path.join(root, 'workbench.json');
    const repository = new FileWorkbenchRepository(file);
    await repository.save(snapshot, await catalogForTestSnapshot(snapshot));
    const restored = new WorkbenchApplication(new FileWorkbenchRepository(file), f.runtime, vi.fn());
    const result = await restored.getSnapshot();
    expect(required(required(result.workspaces[0]).runs[0]).sourceChange).toEqual({ state: 'unavailable', reason: '重启前未完成采集' });
    expect(f.snapshots).toHaveBeenCalledTimes(2);
    const bytes = await readFile(file, 'utf8');
    await new WorkbenchApplication(new FileWorkbenchRepository(file), f.runtime, vi.fn()).getSnapshot();
    expect(await readFile(file, 'utf8')).toBe(bytes);
    delete run.sourceChange;
    delete run.sourceCleanupPending;
    await new FileWorkbenchRepository(file).save(snapshot, await catalogForTestSnapshot(snapshot));
    const old = await readFile(file, 'utf8');
    const legacy = await new WorkbenchApplication(new FileWorkbenchRepository(file), f.runtime, vi.fn()).getSnapshot();
    expect(required(required(legacy.workspaces[0]).runs[0])).not.toHaveProperty('sourceChange');
    expect(await readFile(file, 'utf8')).toBe(old);
  });
});

describe('source project recovery admission', () => {
  it('retains an unconfirmed persisted executor across restart without replay or new project writes', async () => {
    const f = await fixture();
    const p = await f.prepare();
    await p.start();
    const saved = required(f.saved());
    const oldRun = required(saved.workspaces[0]?.runs.at(-1));
    expect(oldRun.executorState).toMatchObject({ state: 'running', cleanupPending: true });
    expect(oldRun.sourceCleanupPending).toBe(false);
    const calls = { snapshots: f.snapshots.mock.calls.length, sends: f.send.mock.calls.length, cancels: f.cancel.mock.calls.length };
    const restored = new WorkbenchApplication({ ...f.repository, load: async () => structuredClone(saved) }, f.runtime, vi.fn());
    const restoredRun = required((await restored.getSnapshot()).workspaces[0]?.runs.at(-1));
    expect(restoredRun).toMatchObject({
      state: 'cancelling',
      cleanupPending: true,
      executorState: { state: 'running', cleanupPending: true },
    });
    expect(restoredRun.error).toContain('旧模型');
    const rejected = await restored.command({
      type: 'startRun',
      commandId: randomUUID(),
      workspaceId: oldRun.workspaceId,
      sessionId: oldRun.sessionId,
      taskVersionId: oldRun.taskVersionId,
    });
    expect(rejected).toMatchObject({ ok: false, error: { code: 'conflict', message: expect.stringContaining('项目') } });
    const startApp = await restored.command({ type: 'startApp', commandId: randomUUID(), workspaceId: oldRun.workspaceId });
    expect(startApp).toMatchObject({ ok: false, error: { code: 'conflict', message: expect.stringContaining('清理') } });
    await expect(restored.shutdown()).rejects.toThrow('清理未确认');
    expect(f.snapshots).toHaveBeenCalledTimes(calls.snapshots);
    expect(f.send).toHaveBeenCalledTimes(calls.sends);
    expect(f.cancel).toHaveBeenCalledTimes(calls.cancels);
  });
});

describe('source evidence durable publication', () => {
  it('does not dispatch a source helper when its durable intent cannot be saved', async () => {
    const f = await fixture();
    const p = await f.prepare();
    const original = required(f.save.getMockImplementation());
    f.save.mockImplementation(async (snapshot) => {
      if (snapshot.workspaces.some((space) => space.runs.some((run) => run.sourceCleanupPending)))
        throw new Error('synthetic intent write failure');
      return original(snapshot);
    });
    await p.start();
    expect(f.snapshots).not.toHaveBeenCalled();
    expect(f.baseline).not.toHaveBeenCalled();
    expect(await p.run()).toMatchObject({
      sourceChange: { state: 'unavailable', reason: expect.stringContaining('intent write failure') },
      sourceCleanupPending: undefined,
    });
    p.finish();
    await f.app.getSnapshot();
    expect(f.capture).not.toHaveBeenCalled();
  });
  it('does not advertise captured evidence when its metadata publication fails, preserving execution and review', async () => {
    const f = await fixture();
    const p = await f.prepare();
    await p.start();
    const original = required(f.save.getMockImplementation());
    f.save.mockImplementation(async (snapshot) => {
      if (snapshot.workspaces.some((space) => space.runs.some((run) => run.sourceChange?.state === 'captured')))
        throw new Error('synthetic capture metadata write failure');
      return original(snapshot);
    });
    p.finish();
    await vi.waitFor(async () =>
      expect((await p.run()).sourceChange).toMatchObject({
        state: 'unavailable',
        reason: expect.stringContaining('capture metadata write failure'),
      }),
    );
    expect(await p.run()).toMatchObject({
      state: 'completed',
      review: null,
      validation: { state: 'not_run' },
      sourceCleanupPending: false,
    });
    expect(required(f.saved()).workspaces[0]?.runs.at(-1)?.sourceChange?.state).toBe('unavailable');
    await expect(f.app.runPatch((await p.run()).workspaceId, (await p.run()).runId)).rejects.toThrow('没有已采集');
  });
});
