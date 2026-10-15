import { catalogForTestSnapshot } from './catalog-test-fixture';
import { describe, expect, it, vi } from 'vitest';
import type { ManagedApp, PageCapture, PreviewState, TerminalSnapshot, WorkbenchCommand, WorkbenchSnapshot } from '@wsl/protocol';
import { WorkbenchApplication } from './application';
import type { WorkbenchRuntime } from './ports';
const state: PreviewState = {
  page: { webContentsId: 1, documentGeneration: 0, url: 'wsl-demo://taskflow/', title: '', partition: 'fixture' },
  loading: false,
  picking: false,
  canGoBack: false,
  canGoForward: false,
  cdp: { state: 'idle' },
  consoleIssueCount: 0,
  pickError: null,
  loadError: null,
  blockedNavigation: null,
};
async function setup() {
  let saved: WorkbenchSnapshot | null = null;
  const published: WorkbenchSnapshot[] = [];
  const runtime = {
    environmentsList: vi.fn().mockResolvedValue([
      {
        environmentId: 'local',
        kind: 'local',
        state: 'configured',
        label: '本机',
        capabilities: { browser: true, files: true, terminal: true },
        reason: null,
      },
      {
        environmentId: 'sandbox',
        kind: 'sandbox',
        state: 'configured',
        label: 'Sandbox',
        capabilities: { browser: false, files: false, terminal: true },
        reason: null,
      },
      {
        environmentId: 'ssh',
        kind: 'ssh',
        state: 'unavailable',
        label: 'SSH',
        capabilities: { browser: false, files: false, terminal: false },
        reason: '未配置',
      },
    ]),
    registerResource: vi.fn(),
    releaseResource: vi.fn(),
    observe: vi.fn(),
    ensureBrowser: vi.fn(),
    browserState: vi.fn(() => state),
    browserAction: vi.fn(),
    terminalOpen: vi.fn(),
  } as unknown as WorkbenchRuntime;
  const app = new WorkbenchApplication(
    {
      appendObservation: vi.fn(async () => crypto.randomUUID()),
      migrationPending: false,
      loadCatalog: catalogForTestSnapshot,
      load: async () => saved,
      save: async (snapshot) => {
        saved = structuredClone(snapshot);
      },
    },
    runtime,
    (event) => published.push(structuredClone(event.snapshot)),
  );
  const workspace = (await app.getSnapshot()).workspaces[0]!;
  const command = (payload: Record<string, unknown>) =>
    app.command({ commandId: crypto.randomUUID(), workspaceId: workspace.workspaceId, ...payload } as WorkbenchCommand);
  return { app, runtime, workspace, command, published };
}
const capture: PageCapture = {
  captureId: 'capture',
  capturedAt: 'fixture',
  page: state.page,
  element: {
    tagName: 'button',
    id: null,
    classes: [],
    role: null,
    ariaLabel: null,
    testId: null,
    text: 'fixture',
    selector: 'button',
    rect: null,
  },
  screenshot: { viewport: 'data:image/png;base64,AA==', element: null },
  consoleIssues: [],
};
const outcome = (session: unknown) =>
  (session as { captureRequest?: { requestId: string; state: string; error: string | null } }).captureRequest;
describe('Main runtime outcome ownership', () => {
  it('reports pending until screenshot completion and publishes completion for exactly that request', async () => {
    const { app, workspace, command } = await setup();
    const r = workspace.resources.find((r) => r.kind === 'web')!;
    const session = workspace.sessions[0]!;
    await command({ type: 'captureContext', resourceId: r.resourceId, sessionId: session.sessionId, requestId: 'request' });
    let snapshot = (await app.getSnapshot()).workspaces[0]!;
    const current = snapshot.resources.find((item) => item.resourceId === r.resourceId)!;
    app.onPreview(r.resourceId, { ...state, picking: false }, current.instanceId, current.generation);
    expect(outcome((await app.getSnapshot()).workspaces[0]!.sessions[0])).toMatchObject({ requestId: 'request', state: 'pending' });
    app.onCapture(r.resourceId, capture, current.instanceId, current.generation, 'request');
    snapshot = (await app.getSnapshot()).workspaces[0]!;
    expect(outcome(snapshot.sessions[0])).toMatchObject({ requestId: 'request', state: 'completed' });
    expect(snapshot.sessions[0]!.context?.captureId).toBe('capture');
  });
  it('keeps an old failure/cancellation from changing the replacement request outcome', async () => {
    const { app, workspace, command } = await setup();
    const r = workspace.resources.find((r) => r.kind === 'web')!;
    const session = workspace.sessions[0]!;
    await command({ type: 'captureContext', resourceId: r.resourceId, sessionId: session.sessionId, requestId: 'old' });
    await command({ type: 'captureContext', resourceId: r.resourceId, sessionId: session.sessionId, requestId: 'new' });
    const current = (await app.getSnapshot()).workspaces[0]!.resources.find((item) => item.resourceId === r.resourceId)!;
    const fail = app.onCaptureError as unknown as (
      resourceId: string,
      requestId: string,
      instanceId: string | null,
      generation: number,
      kind: string,
      error: string,
    ) => void;
    fail.call(app, r.resourceId, 'old', current.instanceId, current.generation, 'failed', 'old failure');
    await command({ type: 'cancelCapture', resourceId: r.resourceId, requestId: 'old' });
    expect(outcome((await app.getSnapshot()).workspaces[0]!.sessions[0])).toMatchObject({
      requestId: 'new',
      state: 'pending',
      error: null,
    });
    await command({ type: 'cancelCapture', resourceId: r.resourceId, requestId: 'new' });
    expect(outcome((await app.getSnapshot()).workspaces[0]!.sessions[0])).toMatchObject({ requestId: 'new', state: 'cancelled' });
  });
  it('preserves confirmed terminal output and cleanup on failure, rejecting duplicate and old sequence updates', async () => {
    const { app, runtime, workspace, command } = await setup();
    const r = workspace.resources.find((r) => r.kind === 'terminal')!;
    const terminal: TerminalSnapshot = {
      sessionId: 'current',
      seq: 10,
      state: 'running',
      output: 'current prompt',
      cleanupPending: true,
      error: null,
      sandbox: 'fixture',
      cwd: '/workspace',
    };
    vi.mocked(runtime.terminalOpen).mockResolvedValue(terminal);
    await command({ type: 'terminalOpen', resourceId: r.resourceId, cols: 80, rows: 24 });
    await vi.waitFor(async () =>
      expect((await app.getSnapshot()).workspaces[0]!.resources.find((x) => x.resourceId === r.resourceId)!.terminal?.state).toBe(
        'running',
      ),
    );
    const binding = vi.mocked(runtime.registerResource).mock.calls[0]![0];
    app.onTerminal(r.resourceId, { ...terminal, seq: 9, sessionId: 'old', output: 'late' }, binding);
    app.onTerminal(r.resourceId, { ...terminal, output: 'duplicate' }, binding);
    let current = (await app.getSnapshot()).workspaces[0]!.resources.find((item) => item.resourceId === r.resourceId)!;
    expect(current.terminal).toEqual(terminal);
    app.onTerminal(r.resourceId, { ...terminal, seq: 11, state: 'failed', error: '未确认远端退出' }, binding);
    current = (await app.getSnapshot()).workspaces[0]!.resources.find((item) => item.resourceId === r.resourceId)!;
    expect(current.terminal).toMatchObject({ output: 'current prompt', cleanupPending: true, error: '未确认远端退出', state: 'failed' });
  });
});

describe('edu page task binding and application', () => {
  it.each([
    'current',
    'noop',
    'receipt-project',
    'receipt-instance',
    'receipt-profile',
    'receipt-source-missing',
    'navigation',
    'instance',
    'candidate',
    'source',
    'cancel',
    'late-navigation',
    'late-cancel',
    'late-stop',
    'late-cancel-idle',
  ])('applies only the confirmed current candidate: %s', async (condition) => {
    const { app, runtime, workspace, command, published } = await setup();
    const sourceFiles = [
      { path: 'admin/src/App.tsx', base64: 'YQ==' },
      { path: 'server/app.py', base64: 'Yg==' },
    ];
    const source = {
      repository: { commit: 'a'.repeat(40), dirty: false },
      sourceSha256: 'b'.repeat(64),
      files: sourceFiles.map((f) => ({ path: f.path, sha256: 'c'.repeat(64), bytes: 1 })),
    };
    runtime.appSelectEduSource = vi.fn(async () => ({ source, files: sourceFiles }));
    let managed: ManagedApp = {
      workspaceId: workspace.workspaceId,
      projectId: crypto.randomUUID(),
      environmentId: 'sandbox',
      state: 'created',
      appInstanceId: null,
      url: null,
      guestCwd: '/guest',
      error: null,
      cleanupConfirmed: true,
    };
    runtime.appImportEdu = vi.fn(
      async (target) =>
        (managed = {
          ...target,
          profile: { projectKind: 'edu-web' as const, profileVersion: 1 as const, source },
          sourceSha256: source.sourceSha256,
          environmentId: 'sandbox',
          state: 'created',
          appInstanceId: null,
          url: null,
          guestCwd: '/guest',
          error: null,
          cleanupConfirmed: true,
        }),
    );
    runtime.appStart = vi.fn(
      async () =>
        (managed = {
          ...managed,
          state: 'running',
          appInstanceId: crypto.randomUUID(),
          url: 'http://127.0.0.1:49152',
          cleanupConfirmed: false,
        }),
    );
    runtime.eduTaskSource = vi.fn(async () => ({
      files: sourceFiles,
      sha256: 'd'.repeat(64),
      profile: { projectKind: 'edu-web' as const, profileVersion: 1 as const, source },
    }));
    let finishPrepare: (() => void) | undefined;
    runtime.eduTaskPrepare = vi.fn(() =>
      condition.startsWith('late-')
        ? new Promise<void>((resolve) => {
            finishPrepare = resolve;
          })
        : Promise.resolve(),
    );
    runtime.eduTaskApply = vi.fn(async () => {
      if (condition === 'source') throw new Error('source changed');
      return {
        ...managed,
        sourceSha256: condition === 'noop' ? 'b'.repeat(64) : 'e'.repeat(64),
        ...(condition === 'receipt-project' ? { projectId: crypto.randomUUID() } : {}),
        ...(condition === 'receipt-instance' ? { appInstanceId: crypto.randomUUID() } : {}),
        ...(condition === 'receipt-profile'
          ? {
              profile: {
                projectKind: 'standard-app' as const,
                profileVersion: 1 as const,
              },
            }
          : {}),
        ...(condition === 'receipt-source-missing' ? { sourceSha256: undefined } : {}),
      };
    });
    runtime.registerSession = vi.fn();
    const sessionId = workspace.sessions[0]!.sessionId;
    const conversation = {
      conversationId: sessionId,
      generation: 'generation',
      turnId: 'turn',
      threadId: 'thread',
      seq: 1,
      state: 'running' as const,
      cleanupPending: true,
      messages: [],
      toolExecutions: [],
      warnings: [],
      error: null,
    };
    runtime.send = vi.fn(async () => conversation);
    runtime.cancel = vi.fn(async () => ({
      ...conversation,
      state: condition === 'late-cancel-idle' ? ('idle' as const) : ('cancelled' as const),
      seq: 2,
      cleanupPending: false,
    }));
    expect((await command({ type: 'importEduApp' })).ok).toBe(true);
    expect((await command({ type: 'startApp' })).ok).toBe(true);
    const w = (await app.getSnapshot()).workspaces[0]!;
    const resource = w.resources.find((r) => r.appProjectId === managed.projectId)!;
    const pageState = { ...state, page: { ...state.page, url: managed.url + '/student' } };
    vi.mocked(runtime.browserState).mockReturnValue(pageState);
    expect((await command({ type: 'captureContext', resourceId: resource.resourceId, sessionId, requestId: 'edu-capture' })).ok).toBe(true);
    const active = (await app.getSnapshot()).workspaces[0]!.resources.find((r) => r.resourceId === resource.resourceId)!;
    app.onCapture(resource.resourceId, { ...capture, page: pageState.page }, active.instanceId, active.generation, 'edu-capture');
    await app.getSnapshot();
    expect(
      (
        await command({
          type: 'confirmTask',
          sessionId,
          goal: 'edit frontend',
          targetRef: { kind: 'web', resourceId: resource.resourceId },
        })
      ).ok,
    ).toBe(true);
    const version = (await app.getSnapshot()).workspaces[0]!.sessions[0]!.taskVersions.at(-1)!;
    expect(version.eduTask).toMatchObject({ projectId: managed.projectId, appInstanceId: managed.appInstanceId, documentGeneration: 0 });
    expect((await command({ type: 'startRun', sessionId, taskVersionId: version.taskVersionId })).ok).toBe(true);
    await vi.waitFor(() => expect(runtime.send).toHaveBeenCalledOnce());
    await app.getSnapshot();
    const run = (await app.getSnapshot()).workspaces[0]!.runs.at(-1)!;
    expect(vi.mocked(runtime.send).mock.calls[0]?.[4]).toEqual(run.eduTask);
    await expect(app.appControlContext(vi.mocked(runtime.send).mock.calls[0]![2]!)).rejects.toThrow('标准应用控制面不可用');
    if (condition === 'navigation')
      vi.mocked(runtime.browserState).mockReturnValue({ ...pageState, page: { ...pageState.page, documentGeneration: 1 } });
    if (condition === 'instance') await app.onApp({ ...managed, state: 'stopped', url: null, cleanupConfirmed: true });
    if (condition === 'cancel') await command({ type: 'cancelRun', runId: run.runId });
    app.onConversation({
      ...conversation,
      state: 'idle',
      seq: 3,
      cleanupPending: false,
      eduCandidateRunId: condition === 'candidate' ? crypto.randomUUID() : run.runId,
    });
    if (condition.startsWith('late-')) {
      await vi.waitFor(() => expect(finishPrepare).toBeTypeOf('function'));
      expect(runtime.eduTaskApply).not.toHaveBeenCalled();
      if (condition === 'late-navigation')
        vi.mocked(runtime.browserState).mockReturnValue({ ...pageState, page: { ...pageState.page, documentGeneration: 1 } });
      if (condition === 'late-cancel' || condition === 'late-cancel-idle') await command({ type: 'cancelRun', runId: run.runId });
      if (condition === 'late-stop') await app.onApp({ ...managed, state: 'stopped', url: null, cleanupConfirmed: true });
      finishPrepare?.();
    }
    await vi.waitFor(async () => {
      const result = (await app.getSnapshot()).workspaces[0]!.runs.at(-1)!;
      expect(result.state).toBe(
        condition === 'current' || condition === 'noop'
          ? 'completed'
          : condition === 'cancel' || condition === 'late-cancel' || condition === 'late-cancel-idle'
            ? 'cancelled'
            : 'failed',
      );
    });
    expect(runtime.eduTaskApply).toHaveBeenCalledTimes(
      condition === 'current' || condition === 'noop' || condition.startsWith('receipt-') || condition === 'source' ? 1 : 0,
    );
    if (condition === 'current' || condition === 'noop') {
      const firstCompleted = published.find((snapshot) =>
        snapshot.workspaces[0]?.runs.some((r) => r.runId === run.runId && r.state === 'completed'),
      )!;
      expect(firstCompleted).toBeDefined();
      const completed = firstCompleted.workspaces[0]!;
      expect(completed.managedApp?.sourceSha256).toBe(condition === 'current' ? 'e'.repeat(64) : 'b'.repeat(64));
      expect(completed.managedApp?.profile).toEqual(managed.profile);
      expect(completed.runs.at(-1)?.eduTask).toEqual(run.eduTask);
      expect(completed.resources.find((r) => r.resourceId === active.resourceId)).toMatchObject({
        resourceId: active.resourceId,
        instanceId: active.instanceId,
        generation: active.generation,
      });
      const fresh = completed.managedApp!;
      const ensureCount = vi.mocked(runtime.ensureBrowser).mock.calls.length;
      await app.onApp(fresh);
      await app.onApp({
        ...fresh,
        appInstanceId: crypto.randomUUID(),
        sourceSha256: 'f'.repeat(64),
      });
      const after = (await app.getSnapshot()).workspaces[0]!;
      expect(after.managedApp?.appInstanceId).toBe(fresh.appInstanceId);
      expect(after.managedApp?.sourceSha256).toBe(fresh.sourceSha256);
      expect(vi.mocked(runtime.ensureBrowser).mock.calls.length).toBe(ensureCount);
      await app.onApp({
        ...fresh,
        state: 'stopped',
        cleanupConfirmed: true,
        url: null,
      });
      await app.onApp(fresh);
      expect((await app.getSnapshot()).workspaces[0]!.managedApp).toMatchObject({
        state: 'stopped',
        appInstanceId: fresh.appInstanceId,
        sourceSha256: fresh.sourceSha256,
      });
    }
    if (condition.startsWith('receipt-')) {
      const after = (await app.getSnapshot()).workspaces[0]!;
      expect(after.managedApp?.appInstanceId).toBe(managed.appInstanceId);
      expect(after.managedApp?.projectId).toBe(managed.projectId);
      expect(after.managedApp?.sourceSha256).not.toBe('e'.repeat(64));
    }
  });
});
