import { codexHarnessRuntime } from './harness-test-fixture';
import { catalogForTestSnapshot } from './catalog-test-fixture';
import { randomUUID } from 'node:crypto';
import { describe, expect, it, vi } from 'vitest';
import type { ChatConversation, ManagedApp, ObservationTurnScope, WorkbenchCommand } from '@wsl/protocol';
import { WorkbenchApplication } from './application';
import type { WorkbenchRuntime } from './ports';
import type { AppControl } from './app-control';
import { AppControlFailure } from './app-control-failure';

function conversation(id: string, state: ChatConversation['state']): ChatConversation {
  return {
    conversationId: id,
    generation: 'g',
    seq: 1,
    turnId: 't',
    threadId: 'th',
    state,
    messages: [],
    toolExecutions: [],
    warnings: [],
    cleanupPending: state === 'running',
    error: null,
  };
}

async function setup(allowedScopes: string[]) {
  let instance: ManagedApp | null = null;
  let starts = 0;
  const runtime = {
    ...codexHarnessRuntime,
    environmentsList: vi.fn().mockResolvedValue([]),
    registerResource: vi.fn(),
    releaseResource: vi.fn(),
    observe: vi.fn(),
    registerSession: vi.fn(),
    captureResource: vi.fn(),
    validateBrowserUrl: vi.fn(),
    ensureBrowser: vi.fn(),
    browserState: vi.fn(() => ({
      page: { webContentsId: 1, documentGeneration: 0, url: 'http://127.0.0.1:49152', title: 'App', partition: 'test' },
      loading: false,
      canGoBack: false,
      canGoForward: false,
      picking: false,
      cdp: { state: 'attached' },
      consoleIssueCount: 0,
      loadError: null,
      blockedNavigation: null,
      pickError: null,
    })),
    browserLayout: vi.fn(),
    browserAction: vi.fn(),
    hideBrowsers: vi.fn(),
    terminalOpen: vi.fn(),
    terminalWrite: vi.fn(),
    terminalResize: vi.fn(),
    terminalStop: vi.fn(),
    send: vi.fn(async (id: string) => conversation(id, 'running')),
    cancel: vi.fn(async (id: string) => conversation(id, 'cancelled')),
    releaseAppBrowser: vi.fn(),
    appCreate: vi.fn(
      async (target) =>
        (instance = {
          ...target,
          environmentId: 'sandbox',
          appInstanceId: null,
          state: 'created',
          url: null,
          guestCwd: '/g',
          error: null,
          cleanupConfirmed: true,
        }),
    ),
    appStop: vi.fn(
      async () =>
        (instance = {
          ...instance!,
          state: 'stopped',
          url: null,
          cleanupConfirmed: true,
        }),
    ),
    appStart: vi.fn(
      async () =>
        (instance = {
          ...instance!,
          appInstanceId: 'app-instance-' + ++starts,
          state: 'running',
          url: 'http://127.0.0.1:49152',
          cleanupConfirmed: false,
        }),
    ),
  } as unknown as WorkbenchRuntime;
  const app = new WorkbenchApplication(
    {
      migrationPending: false,
      loadCatalog: catalogForTestSnapshot,
      load: async () => null,
      save: async () => undefined,
      appendObservation: async () => '',
    },
    runtime,
    vi.fn(),
  );
  const control = {
    ready: vi.fn(async () => undefined),
    hasPending: vi.fn(() => false),
    isReconciling: vi.fn(() => false),
    canRetryCleanup: vi.fn(() => true),
    confirmStopped: vi.fn(async () => undefined),
    reconcileRun: vi.fn(async () => undefined),
    releaseRun: vi.fn(),
    call: vi.fn(),
  };
  app.setAppControl(control as unknown as AppControl);
  await app.getSnapshot();
  const command = (payload: Record<string, unknown>) =>
    app.command({ workspaceId: 'taskflow-demo', commandId: randomUUID(), ...payload } as WorkbenchCommand);
  expect((await command({ type: 'createApp' })).ok).toBe(true);
  expect((await command({ type: 'startApp' })).ok).toBe(true);
  const w = (await app.getSnapshot()).workspaces[0]!;
  const sessionId = w.sessions[0]!.sessionId;
  expect(
    (await command({ type: 'confirmTask', sessionId, goal: '修改欢迎语', targetRef: null, appId: null, captureId: null, allowedScopes }))
      .ok,
  ).toBe(true);
  const version = (await app.getSnapshot()).workspaces[0]!.sessions[0]!.taskVersions.at(-1)!;
  expect((await command({ type: 'startRun', sessionId, taskVersionId: version.taskVersionId })).ok).toBe(true);
  const scope = vi.mocked(runtime.send).mock.calls[0]![2] as ObservationTurnScope;
  return { app, runtime, control, scope, sessionId, command };
}
const failure = async (work: Promise<unknown>) => {
  try {
    await work;
    return 'ok';
  } catch (error) {
    return error instanceof AppControlFailure ? error.code : String(error);
  }
};

describe('control-plane authorization context', () => {
  it('derives app, browser and reset authorization only from the frozen active run', async () => {
    const { app, scope } = await setup(['app.data.reset', 'ui']);
    const context = await app.appControlContext(scope);
    expect(context).toMatchObject({
      workspaceId: 'taskflow-demo',
      runId: scope.runId,
      allowsReset: true,
      app: { appInstanceId: 'app-instance-1', state: 'running' },
    });
    const resource = (await app.getSnapshot()).workspaces[0]!.resources.find((item) => item.appProjectId === context.app!.projectId)!;
    expect(context.browser?.resourceId).toBe(resource.resourceId);
    expect(await failure(app.appControlContext({ ...scope, sessionId: 'other-session' }))).toBe('no_active_run');
    expect(await failure(app.appControlContext({ ...scope, runId: 'forged-run' }))).toBe('no_active_run');
  });
  it('without the user marker reset is not authorized', async () => {
    const { app, scope } = await setup(['ui']);
    expect((await app.appControlContext(scope)).allowsReset).toBe(false);
  });
  it('run end releases the control plane and later calls see no active run', async () => {
    const { app, scope, sessionId, control } = await setup([]);
    app.onConversation({ ...conversation(sessionId, 'idle'), seq: 5 });
    await app.getSnapshot();
    expect(control.releaseRun).toHaveBeenCalledWith(scope.runId);
    expect(await failure(app.appControlContext(scope))).toBe('no_active_run');
  });
  it('a cancelling run cannot use the control plane', async () => {
    const { app, scope, command } = await setup([]);
    const pending = command({ type: 'cancelRun', runId: scope.runId });
    await vi.waitFor(async () => expect((await app.getSnapshot()).workspaces[0]!.runs[0]!.state).not.toBe('running'));
    expect(await failure(app.appControlContext(scope))).toBe('no_active_run');
    await pending;
  });
});

describe('control-plane restart preserves user navigation', () => {
  it('does not replace the active session pane when the App restarts', async () => {
    const { app, command, sessionId } = await setup([]);
    expect((await command({ type: 'locateSession', sessionId })).ok).toBe(true);
    const before = (await app.getSnapshot()).workspaces[0]!;
    app.restartAppForControl(before.workspaceId, before.managedApp!.appInstanceId!);
    await vi.waitFor(async () => expect((await app.getSnapshot()).workspaces[0]!.managedApp?.appInstanceId).toBe('app-instance-2'));
    const after = (await app.getSnapshot()).workspaces[0]!;
    expect(after.layout).toEqual(before.layout);
    expect(after.activePaneId).toBe(before.activePaneId);
  });

  it('keeps navigation made by the user while the restart is pending', async () => {
    const { app, command, runtime, sessionId } = await setup([]);
    expect((await command({ type: 'locateSession', sessionId })).ok).toBe(true);
    const before = (await app.getSnapshot()).workspaces[0]!;
    let complete!: (app: ManagedApp) => void;
    vi.mocked(runtime.appStart!).mockImplementationOnce(
      () =>
        new Promise<ManagedApp>((resolve) => {
          complete = resolve;
        }),
    );
    app.restartAppForControl(before.workspaceId, before.managedApp!.appInstanceId!);
    await vi.waitFor(() => expect(runtime.appStart).toHaveBeenCalledTimes(2));
    expect((await command({ type: 'createTab', kind: 'session', title: '用户中途打开的会话' })).ok).toBe(true);
    const navigated = (await app.getSnapshot()).workspaces[0]!;
    complete({ ...before.managedApp!, appInstanceId: 'app-instance-2' });
    await vi.waitFor(async () => expect((await app.getSnapshot()).workspaces[0]!.managedApp?.appInstanceId).toBe('app-instance-2'));
    const after = (await app.getSnapshot()).workspaces[0]!;
    expect(after.layout).toEqual(navigated.layout);
    expect(after.activePaneId).toBe(navigated.activePaneId);
  });

  it('recreates the browser through the runtime without activating its tab', async () => {
    const { app, command, runtime, sessionId } = await setup([]);
    expect((await command({ type: 'locateSession', sessionId })).ok).toBe(true);
    const before = (await app.getSnapshot()).workspaces[0]!;
    app.restartAppForControl(before.workspaceId, before.managedApp!.appInstanceId!);
    await vi.waitFor(async () => expect((await app.getSnapshot()).workspaces[0]!.managedApp?.appInstanceId).toBe('app-instance-2'));
    const resource = (await app.getSnapshot()).workspaces[0]!.resources.find((r) => r.appProjectId === before.managedApp!.projectId)!;
    expect(resource.instanceId).toEqual(expect.any(String));
    expect(runtime.ensureBrowser).toHaveBeenCalledWith(
      before.workspaceId,
      expect.objectContaining({ resourceId: resource.resourceId, instanceId: resource.instanceId }),
    );
  });

  it('still opens the App tab for an explicit user start', async () => {
    const { app, command, sessionId } = await setup([]);
    expect((await command({ type: 'stopApp' })).ok).toBe(true);
    expect((await command({ type: 'locateSession', sessionId })).ok).toBe(true);
    const before = (await app.getSnapshot()).workspaces[0]!;
    expect((await command({ type: 'startApp' })).ok).toBe(true);
    const after = (await app.getSnapshot()).workspaces[0]!;
    const resource = after.resources.find((r) => r.appProjectId === after.managedApp!.projectId)!;
    const tab = after.tabs.find((t) => t.targetRef.resourceId === resource.resourceId)!;
    expect(after.layout).not.toEqual(before.layout);
    expect(JSON.stringify(after.layout)).toContain(tab.tabId);
  });
});

describe('run cleanup aggregation', () => {
  it('keeps model terminal state cancelling until manual reconciliation resolves the owned App operation', async () => {
    const { app, control, scope, sessionId, command } = await setup([]);
    control.hasPending.mockReturnValue(true);
    app.onConversation({ ...conversation(sessionId, 'cancelled'), seq: 5 });
    let run = (await app.getSnapshot()).workspaces[0]!.runs.find((item) => item.runId === scope.runId)!;
    expect(run).toMatchObject({
      state: 'cancelling',
      endedAt: null,
      cleanupPending: true,
      appCleanupPending: true,
      conversation: { state: 'cancelling', cleanupPending: true },
      executorState: { state: 'cancelled', cleanupPending: false },
    });
    expect((await app.getSnapshot()).workspaces[0]!.sessions.find((item) => item.sessionId === sessionId)!.conversation).toMatchObject({
      state: 'cancelling',
      cleanupPending: true,
    });
    expect((await command({ type: 'startApp' })).ok).toBe(false);
    expect((await command({ type: 'exportApp' })).ok).toBe(false);
    control.reconcileRun.mockImplementation(async () => {
      control.hasPending.mockReturnValue(false);
      app.onAppCleanupChanged(scope.workspaceId, scope.runId);
    });
    expect((await command({ type: 'reconcileRunCleanup', runId: scope.runId })).ok).toBe(true);
    run = (await app.getSnapshot()).workspaces[0]!.runs.find((item) => item.runId === scope.runId)!;
    expect(run).toMatchObject({ state: 'cancelled', cleanupPending: false });
    expect(run.endedAt).not.toBeNull();
  });
});

describe('executor cleanup facts', () => {
  it('does not claim the model stopped while an App operation is pending and model is still running', async () => {
    const { app, control, scope, sessionId } = await setup([]);
    control.hasPending.mockReturnValue(true);
    app.onConversation({ ...conversation(sessionId, 'running'), seq: 5 });
    app.onAppCleanupChanged(scope.workspaceId, scope.runId);
    const run = (await app.getSnapshot()).workspaces[0]!.runs.find((item) => item.runId === scope.runId)!;
    expect(run).toMatchObject({ state: 'running', appCleanupPending: true, executorState: { state: 'running', cleanupPending: true } });
  });
  it('does not complete cancellation when the model process cleanup itself remains unknown', async () => {
    const { app, scope, sessionId } = await setup([]);
    app.onConversation({ ...conversation(sessionId, 'failed'), seq: 5, cleanupPending: true });
    app.onAppCleanupChanged(scope.workspaceId, scope.runId);
    const run = (await app.getSnapshot()).workspaces[0]!.runs.find((item) => item.runId === scope.runId)!;
    expect(run).toMatchObject({
      state: 'cancelling',
      endedAt: null,
      cleanupPending: true,
      appCleanupPending: false,
      conversation: { state: 'cancelling', cleanupPending: true },
      executorState: { state: 'failed', cleanupPending: true },
    });
  });
});

describe('pending cleanup recovery', () => {
  it('restores unknown cleanup without replay and allows reconciliation without an active scope', async () => {
    const initial = await setup([]);
    initial.control.hasPending.mockReturnValue(true);
    initial.app.onConversation({ ...conversation(initial.sessionId, 'cancelled'), seq: 5 });
    const saved = await initial.app.getSnapshot();
    const runtime = initial.runtime;
    const sendsBefore = vi.mocked(runtime.send).mock.calls.length;
    const recovered = new WorkbenchApplication(
      {
        migrationPending: false,
        loadCatalog: catalogForTestSnapshot,
        load: async () => structuredClone(saved),
        save: async () => undefined,
        appendObservation: async () => '',
      },
      runtime,
      vi.fn(),
    );
    const control = {
      ready: vi.fn(async () => undefined),
      hasPending: vi.fn(() => true),
      isReconciling: vi.fn(() => false),
      canRetryCleanup: vi.fn(() => true),
      releaseRun: vi.fn(),
      call: vi.fn(),
      confirmStopped: vi.fn(),
      reconcileRun: vi.fn(async () => undefined),
    };
    recovered.setAppControl(control as unknown as AppControl);
    let run = (await recovered.getSnapshot()).workspaces[0]!.runs.find((item) => item.runId === initial.scope.runId)!;
    expect(run).toMatchObject({ state: 'cancelling', endedAt: null, cleanupPending: true, appCleanupPending: true });
    expect(vi.mocked(runtime.send).mock.calls).toHaveLength(sendsBefore);
    expect(await failure(recovered.appControlContext(initial.scope))).toBe('no_active_run');
    control.reconcileRun.mockImplementation(async () => {
      control.hasPending.mockReturnValue(false);
      recovered.onAppCleanupChanged(initial.scope.workspaceId, initial.scope.runId);
    });
    const result = await recovered.command({
      workspaceId: initial.scope.workspaceId,
      commandId: randomUUID(),
      type: 'reconcileRunCleanup',
      runId: initial.scope.runId,
    });
    expect(result.ok).toBe(true);
    expect(control.reconcileRun).toHaveBeenCalledWith(initial.scope.workspaceId, initial.scope.runId);
    run = (await recovered.getSnapshot()).workspaces[0]!.runs.find((item) => item.runId === initial.scope.runId)!;
    expect(run).toMatchObject({ state: 'cancelled', cleanupPending: false });
  });
});

describe('recovered executor cleanup remains unverified', () => {
  it.each(['running', 'legacy_missing_executor'])('does not infer model exit from an App terminal receipt for %s', async (variant) => {
    const initial = await setup([]);
    initial.control.hasPending.mockReturnValue(true);
    initial.app.onConversation({ ...conversation(initial.sessionId, 'running'), seq: 5 });
    const saved = await initial.app.getSnapshot();
    const savedRun = saved.workspaces[0]!.runs.find((item) => item.runId === initial.scope.runId)!;
    if (variant === 'legacy_missing_executor') {
      delete savedRun.executorState;
      savedRun.conversation = { ...savedRun.conversation!, state: 'cancelled', cleanupPending: false };
      const session = saved.workspaces[0]!.sessions.find((item) => item.sessionId === initial.sessionId)!;
      session.conversation = { ...session.conversation!, state: 'cancelled', cleanupPending: false };
    }
    const recovered = new WorkbenchApplication(
      {
        migrationPending: false,
        loadCatalog: catalogForTestSnapshot,
        load: async () => structuredClone(saved),
        save: async () => undefined,
        appendObservation: async () => '',
      },
      initial.runtime,
      vi.fn(),
    );
    const control = {
      ready: vi.fn(async () => undefined),
      hasPending: vi.fn(() => true),
      isReconciling: vi.fn(() => false),
      canRetryCleanup: vi.fn(() => true),
      releaseRun: vi.fn(),
      call: vi.fn(),
      confirmStopped: vi.fn(),
      reconcileRun: vi.fn(async () => undefined),
    };
    recovered.setAppControl(control as unknown as AppControl);
    let workspace = (await recovered.getSnapshot()).workspaces[0]!;
    let run = workspace.runs.find((item) => item.runId === initial.scope.runId)!;
    expect(run).toMatchObject({
      state: 'cancelling',
      endedAt: null,
      cleanupPending: true,
      appCleanupPending: true,
      error: expect.stringContaining('旧模型进程清理未确认'),
    });
    control.reconcileRun.mockImplementation(async () => {
      control.hasPending.mockReturnValue(false);
      recovered.onAppCleanupChanged(initial.scope.workspaceId, initial.scope.runId);
    });
    expect(
      (
        await recovered.command({
          workspaceId: initial.scope.workspaceId,
          commandId: randomUUID(),
          type: 'reconcileRunCleanup',
          runId: initial.scope.runId,
        })
      ).ok,
    ).toBe(true);
    workspace = (await recovered.getSnapshot()).workspaces[0]!;
    run = workspace.runs.find((item) => item.runId === initial.scope.runId)!;
    expect(control.hasPending()).toBe(false);
    expect(run).toMatchObject({
      state: 'cancelling',
      endedAt: null,
      cleanupPending: true,
      appCleanupPending: false,
      error: expect.stringContaining('旧模型进程清理未确认'),
      conversation: { state: 'cancelling', cleanupPending: true },
    });
    expect(workspace.sessions.find((item) => item.sessionId === initial.sessionId)!.conversation).toMatchObject({
      state: 'cancelling',
      cleanupPending: true,
      error: expect.stringContaining('旧模型进程清理未确认'),
    });
    expect(control.releaseRun).not.toHaveBeenCalled();
  });
});
