import { afterEach, describe, expect, it, vi } from 'vitest';
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
  type EduTaskBinding,
  type EduTaskOperationResult,
  type ManagedApp,
  type PreviewState,
  type WorkbenchSnapshot,
} from '@wsl/protocol';
import { WorkbenchApplication } from './application';
import { FileWorkbenchRepository, type WorkbenchRepository } from './repository';
import { RunDispatchFailure, type WorkbenchRuntime } from './ports';
import { catalogForTestSnapshot } from './catalog-test-fixture';

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

async function fixture(edu = false) {
  let saved: WorkbenchSnapshot | null = null;
  const apps = new Map<string, ManagedApp>();
  const turns = new Map<string, ChatConversation>();
  const eduBindings = new Map<string, EduTaskBinding>();
  let eduText = 'before';
  const eduFiles = () => [
    { path: 'admin/src/App.tsx', base64: Buffer.from(eduText).toString('base64') },
    { path: 'server/app.py', base64: Buffer.from('protected').toString('base64') },
  ];
  const initialFiles = eduFiles();
  const metadata = initialFiles.map((file) => ({
    path: file.path,
    bytes: Buffer.from(file.base64, 'base64').length,
    sha256: createHash('sha256').update(Buffer.from(file.base64, 'base64')).digest('hex'),
  }));
  const eduSource = {
    repository: { commit: 'a'.repeat(40), dirty: false },
    sourceSha256: createHash('sha256').update(JSON.stringify(metadata)).digest('hex'),
    files: metadata,
  };
  const profile = { projectKind: 'edu-web' as const, profileVersion: 1 as const, source: eduSource };
  const snapshots = vi.fn(async (target: AppTarget, _signal: AbortSignal): Promise<AppSourceSnapshotResult> =>
    edu
      ? {
          ok: true,
          cleanupConfirmed: true,
          snapshot: {
            ...target,
            files: eduFiles().map((file) => ({ ...file, mode: '100644' as const })),
            totalBytes: eduFiles().reduce((sum, file) => sum + Buffer.from(file.base64, 'base64').length, 0),
          },
        }
      : source(target),
  );
  const send = vi.fn<WorkbenchRuntime['send']>(async (sessionId, _text, _scope, _references, binding) => {
    if (binding) eduBindings.set(sessionId, binding);
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
  const eduPrepare = vi.fn(async (binding: EduTaskBinding): Promise<EduTaskOperationResult> => ({
    binding,
    operation: 'prepare',
    ok: true,
    cleanupConfirmed: true,
  }));
  const applied = (binding: EduTaskBinding): EduTaskOperationResult => {
    eduText = 'after';
    const app = { ...required(apps.get(binding.projectId)), sourceSha256: 'e'.repeat(64) };
    apps.set(binding.projectId, app);
    return { binding, operation: 'apply', ok: true, cleanupConfirmed: true, app };
  };
  const eduApply = vi.fn(async (binding: EduTaskBinding): Promise<EduTaskOperationResult> => applied(binding));
  const eduCancel = vi.fn(async (binding: EduTaskBinding): Promise<EduTaskOperationResult> => ({
    binding,
    operation: 'cancel',
    ok: true,
    cleanupConfirmed: true,
  }));
  const runtime: WorkbenchRuntime = {
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
  if (edu) {
    runtime.appSelectImportSource = async () => ({
      source: eduSource,
      files: initialFiles,
      preview: {
        name: 'edu',
        profile: 'edu-web',
        profileVersion: 1,
        repository: eduSource.repository,
        sourceSha256: eduSource.sourceSha256,
        fileCount: initialFiles.length,
        totalBytes: metadata.reduce((sum, file) => sum + file.bytes, 0),
        warnings: [],
      },
      revalidate: async () => ({ source: eduSource, files: initialFiles }),
    });
    runtime.appImportSource = async (target) => {
      const app: ManagedApp = {
        ...target,
        profile,
        sourceSha256: eduSource.sourceSha256,
        environmentId: 'sandbox',
        appInstanceId: null,
        state: 'created',
        url: null,
        guestCwd: `/home/agent/workspace/.wsl-apps/${target.projectId}`,
        error: null,
        cleanupConfirmed: true,
      };
      apps.set(target.projectId, app);
      return { app, outcome: 'imported', retryable: false, errorCode: null };
    };
    runtime.appCancelImport = async () => ({ app: null, outcome: 'cancelled', retryable: false, errorCode: null });
    runtime.eduTaskSource = async () => ({ profile, files: eduFiles(), sha256: eduSource.sourceSha256 });
    runtime.eduTaskPrepare = eduPrepare;
    runtime.eduTaskApply = eduApply;
    runtime.eduTaskCancel = eduCancel;
  }
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
    if (edu) {
      expect((await command({ type: 'previewAppImport' }, workspaceId)).ok).toBe(true);
      const preview = required((await owner(workspaceId)).appImport);
      expect(
        (
          await command(
            { type: 'confirmAppImport', previewId: preview.previewId, sourceSha256: preview.preview?.sourceSha256 },
            workspaceId,
          )
        ).ok,
      ).toBe(true);
      expect((await command({ type: 'openAppPage', page: 'admin' }, workspaceId)).ok).toBe(true);
    } else {
      expect((await command({ type: 'createApp' }, workspaceId)).ok).toBe(true);
      expect((await command({ type: 'startApp' }, workspaceId)).ok).toBe(true);
    }
    let space = await owner(workspaceId);
    const session = required(space.sessions[0]);
    const browser = required(space.resources.find((resource) => resource.appProjectId));
    const requestId = randomUUID();
    expect(
      (await command({ type: 'captureContext', sessionId: session.sessionId, resourceId: browser.resourceId, requestId }, workspaceId)).ok,
    ).toBe(true);
    space = await owner(workspaceId);
    const current = required(space.resources.find((resource) => resource.resourceId === browser.resourceId));
    app.onCapture(
      browser.resourceId,
      {
        captureId: randomUUID(),
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
        ...(state === 'idle' && eduBindings.has(session.sessionId) ? { eduCandidateRunId: eduBindings.get(session.sessionId)!.runId } : {}),
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
    eduPrepare,
    eduApply,
    eduCancel,
    applied,
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

describe('edu writeback and source evidence share one cleanup boundary', () => {
  it('captures after applied bytes only, and keeps the project locked through the host diff write', async () => {
    const f = await fixture(true);
    const p = await f.prepare();
    await p.start();
    const prepare = deferred<EduTaskOperationResult>();
    const apply = deferred<EduTaskOperationResult>();
    const capture = deferred<CapturedSourceChange>();
    f.eduPrepare.mockReturnValueOnce(prepare.promise);
    f.eduApply.mockReturnValueOnce(apply.promise);
    f.capture.mockReturnValueOnce(capture.promise);
    p.finish();
    await vi.waitFor(() => expect(f.eduPrepare).toHaveBeenCalledOnce());
    expect(f.snapshots).toHaveBeenCalledOnce();
    expect((await f.command({ type: 'createWorkspace', name: 'independent' }, 'other')).ok).toBe(true);
    const binding = required(f.eduPrepare.mock.calls[0])[0];
    prepare.resolve({ binding, operation: 'prepare', ok: true, cleanupConfirmed: true });
    await vi.waitFor(() => expect(f.eduApply).toHaveBeenCalledOnce());
    expect(f.snapshots).toHaveBeenCalledOnce();
    expect((await p.start()).ok).toBe(false);
    apply.resolve(f.applied(binding));
    await vi.waitFor(() => expect(f.capture).toHaveBeenCalledOnce());
    const after = required(f.capture.mock.calls[0])[2];
    expect(Buffer.from(required(after.files.find((file) => file.path === 'admin/src/App.tsx')).base64, 'base64').toString()).toBe('after');
    expect((await f.owner()).managedApp?.sourceSha256).toBe('e'.repeat(64));
    expect((await p.start()).ok).toBe(false);
    capture.resolve(captured);
    await vi.waitFor(async () => expect((await p.run()).sourceChange?.state).toBe('captured'));
    expect((await p.run()).state).toBe('completed');
    expect((await p.run()).cleanupPending).toBe(false);
    expect((await p.start()).ok).toBe(true);
    p.finish();
    await vi.waitFor(async () => expect((await p.run()).sourceChange?.state).toBe('captured'));
  });
  it.each(['prepare', 'apply'] as const)(
    'cancel during %s waits for both operation and cleanup, preserving actual writes and cancelled outcome',
    async (stage) => {
      const f = await fixture(true);
      const p = await f.prepare();
      await p.start();
      const operation = deferred<EduTaskOperationResult>();
      const cleanup = deferred<EduTaskOperationResult>();
      (stage === 'prepare' ? f.eduPrepare : f.eduApply).mockReturnValueOnce(operation.promise);
      f.eduCancel.mockReturnValueOnce(cleanup.promise);
      p.finish();
      const operationMock = stage === 'prepare' ? f.eduPrepare : f.eduApply;
      await vi.waitFor(() => expect(operationMock).toHaveBeenCalledOnce());
      const binding = required(operationMock.mock.calls[0])[0];
      expect((await f.command({ type: 'cancelRun', runId: binding.runId })).ok).toBe(true);
      await vi.waitFor(() => expect(f.eduCancel).toHaveBeenCalledOnce());
      cleanup.resolve({ binding, operation: 'cancel', ok: true, cleanupConfirmed: true });
      await f.app.getSnapshot();
      expect(f.snapshots).toHaveBeenCalledOnce();
      expect((await p.start()).ok).toBe(false);
      expect(f.cancel).not.toHaveBeenCalled(); // Model already ended; never stop the running App.
      operation.resolve(stage === 'apply' ? f.applied(binding) : { binding, operation: 'prepare', ok: true, cleanupConfirmed: true });
      await vi.waitFor(async () => expect((await p.run()).sourceChange?.state).toBe('captured'));
      expect((await p.run()).state).toBe('cancelled');
      expect((await p.run()).executorState).toEqual({ state: 'idle', cleanupPending: false });
      expect((await f.owner()).managedApp?.state).toBe('running');
      expect(f.eduApply).toHaveBeenCalledTimes(stage === 'apply' ? 1 : 0);
      const after = required(f.capture.mock.calls[0])[2];
      expect(Buffer.from(required(after.files.find((file) => file.path === 'admin/src/App.tsx')).base64, 'base64').toString()).toBe(
        stage === 'apply' ? 'after' : 'before',
      );
    },
  );
  it('keeps unknown apply cleanup locked until an explicit matching cleanup succeeds', async () => {
    const f = await fixture(true);
    const p = await f.prepare();
    await p.start();
    f.eduApply.mockImplementationOnce(async (binding) => ({
      binding,
      operation: 'apply',
      ok: false,
      cleanupConfirmed: false,
      error: 'apply helper exit unknown',
    }));
    f.eduCancel.mockImplementationOnce(async (binding) => ({
      binding,
      operation: 'cancel',
      ok: false,
      cleanupConfirmed: false,
      error: 'cleanup still unknown',
    }));
    p.finish();
    await vi.waitFor(async () => expect((await p.run()).eduTaskCleanupPending).toBe(true));
    await vi.waitFor(() => expect(f.eduApply).toHaveBeenCalledOnce());
    const run = await p.run();
    await f.command({ type: 'cancelRun', runId: run.runId });
    await vi.waitFor(async () => expect((await p.run()).error).toContain('cleanup still unknown'));
    expect(f.snapshots).toHaveBeenCalledOnce();
    expect((await p.start()).ok).toBe(false);
    await f.command({ type: 'cancelRun', runId: run.runId });
    await vi.waitFor(async () => expect((await p.run()).sourceChange?.state).toBe('captured'));
    expect((await p.run()).eduTaskCleanupPending).toBe(false);
    expect((await p.run()).state).toBe('cancelled');
  });
  it('does not dispatch prepare after its durable intent fails to save', async () => {
    const f = await fixture(true);
    const p = await f.prepare();
    await p.start();
    f.save.mockRejectedValueOnce(new Error('prepare intent disk failure'));
    p.finish();
    await vi.waitFor(async () => expect((await p.run()).sourceChange?.state).toBe('captured'));
    expect((await p.run()).state).toBe('failed');
    expect((await p.run()).error).toContain('prepare intent disk failure');
    expect(f.eduPrepare).not.toHaveBeenCalled();
    expect(f.eduApply).not.toHaveBeenCalled();
    expect((await f.owner()).managedApp?.sourceSha256).not.toBe('e'.repeat(64));
  });
  it('cancels a pending send source helper as well as the executor, before after capture', async () => {
    const f = await fixture(true);
    const p = await f.prepare();
    const send = deferred<ChatConversation>();
    const originalSend = required(f.send.getMockImplementation());
    let receipt: ChatConversation | undefined;
    f.send.mockImplementationOnce(async (...args) => {
      receipt = await originalSend(...args);
      return send.promise;
    });
    const cleanup = deferred<EduTaskOperationResult>();
    f.eduCancel.mockReturnValueOnce(cleanup.promise);
    const launching = p.start();
    await vi.waitFor(() => expect(f.send).toHaveBeenCalledOnce());
    const run = await p.run();
    expect(run.eduTaskCleanupPending).toBe(true);
    expect(required(f.saved()).workspaces[0]?.runs.at(-1)?.eduTaskCleanupPending).toBe(true);
    await f.command({ type: 'cancelRun', runId: run.runId });
    await vi.waitFor(() => expect(f.cancel).toHaveBeenCalledOnce());
    await vi.waitFor(() => expect(f.eduCancel).toHaveBeenCalledOnce());
    expect(f.snapshots).toHaveBeenCalledOnce();
    expect((await p.start()).ok).toBe(false);
    const binding = required(f.eduCancel.mock.calls[0])[0];
    cleanup.resolve({ binding, operation: 'cancel', ok: true, cleanupConfirmed: true });
    send.resolve(required(receipt));
    await launching;
    await vi.waitFor(async () => expect((await p.run()).sourceChange?.state).toBe('captured'));
    expect((await p.run()).state).toBe('cancelled');
    expect(f.eduPrepare).not.toHaveBeenCalled();
    expect(f.eduApply).not.toHaveBeenCalled();
  });
  it.each([true, false])('only skips edu cleanup for explicitly undispatched send failures: %s', async (knownNotSent) => {
    const f = await fixture(true);
    const p = await f.prepare();
    f.send.mockRejectedValueOnce(new RunDispatchFailure('send refused', false, knownNotSent));
    const cleanup = deferred<EduTaskOperationResult>();
    f.eduCancel.mockReturnValueOnce(cleanup.promise);
    await p.start();
    if (!knownNotSent) {
      await vi.waitFor(() => expect(f.eduCancel).toHaveBeenCalledOnce());
      expect((await p.run()).eduTaskCleanupPending).toBe(true);
      expect((await p.start()).ok).toBe(false);
      expect(f.snapshots).toHaveBeenCalledOnce();
      const binding = required(f.eduCancel.mock.calls[0])[0];
      cleanup.resolve({ binding, operation: 'cancel', ok: true, cleanupConfirmed: true });
    } else expect(f.eduCancel).not.toHaveBeenCalled();
    await vi.waitFor(async () => expect((await p.run()).sourceChange?.state).toBe('captured'));
    expect((await p.run()).state).toBe('failed');
    expect((await p.run()).eduTaskCleanupPending).toBe(false);
    expect((await p.run()).error).toContain('send refused');
    expect(f.eduPrepare).not.toHaveBeenCalled();
    expect(f.eduApply).not.toHaveBeenCalled();
  });
  it('settles a second pre-model rejection despite same-sequence idle history, only after its own edu cleanup', async () => {
    const f = await fixture(true);
    const p = await f.prepare();
    await p.start();
    p.finish();
    await vi.waitFor(async () => expect((await p.run()).sourceChange?.state).toBe('captured'));
    const firstRun = await p.run();
    const oldIdle = required((await f.owner()).sessions[0]?.conversation);
    expect(oldIdle.state).toBe('idle');
    expect(oldIdle.cleanupPending).toBe(false);
    // A service cancel with no new executor would return exactly this old
    // conversation. Its seq cannot prove anything about the new run's helper.
    f.cancel.mockResolvedValueOnce(oldIdle);
    f.send.mockRejectedValueOnce(new RunDispatchFailure('confirmed source changed before model dispatch', false, false));
    const cleanup = deferred<EduTaskOperationResult>();
    f.eduCancel.mockReturnValueOnce(cleanup.promise);
    await p.start();
    await vi.waitFor(() => expect(f.eduCancel).toHaveBeenCalledOnce());
    const rejected = await p.run();
    expect(rejected.runId).not.toBe(firstRun.runId);
    expect(rejected.executorState).toEqual({ state: 'failed', cleanupPending: false });
    expect(rejected.eduTaskCleanupPending).toBe(true);
    expect(f.snapshots).toHaveBeenCalledTimes(3); // First before/after, then second before only.
    f.app.onConversation(oldIdle);
    await f.app.getSnapshot();
    expect((await p.run()).eduTaskCleanupPending).toBe(true);
    expect((await p.start()).ok).toBe(false);
    const binding = required(f.eduCancel.mock.calls[0])[0];
    expect(binding.runId).toBe(rejected.runId);
    cleanup.resolve({ binding, operation: 'cancel', ok: true, cleanupConfirmed: true });
    await vi.waitFor(async () => expect((await p.run()).sourceChange?.state).toBe('captured'));
    expect((await p.run()).state).toBe('failed');
    expect((await p.run()).cleanupPending).toBe(false);
    expect((await p.run()).error).toContain('source changed');
    expect(f.cancel).not.toHaveBeenCalled();
    expect(f.snapshots).toHaveBeenCalledTimes(4);
    expect(f.eduPrepare).toHaveBeenCalledOnce();
    expect(f.eduApply).toHaveBeenCalledOnce();
  });
});
