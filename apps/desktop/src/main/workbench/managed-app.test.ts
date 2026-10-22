import { codexHarnessRuntime } from './harness-test-fixture';
import { catalogForTestSnapshot } from './catalog-test-fixture';
import { randomUUID } from 'node:crypto';
import { describe, expect, it, vi } from 'vitest';
import type { ManagedApp, WorkbenchCommand } from '@wsl/protocol';
import { WorkbenchApplication, validateSnapshot } from './application';
import type { WorkbenchRuntime } from './ports';

async function setup() {
  let instance: ManagedApp | null = null;
  const runtime = {
    ...codexHarnessRuntime,
    appCreate: vi.fn(
      async (target) =>
        (instance = {
          ...target,
          environmentId: 'sandbox',
          appInstanceId: null,
          state: 'created',
          url: null,
          guestCwd: '/guest/project',
          error: null,
          cleanupConfirmed: true,
        }),
    ),
    appStart: vi.fn(
      async () =>
        (instance = {
          ...instance!,
          appInstanceId: randomUUID(),
          state: 'running',
          url: 'http://127.0.0.1:49152',
          cleanupConfirmed: false,
        }),
    ),
    appStop: vi.fn(async () => (instance = { ...instance!, state: 'stopped', url: null, cleanupConfirmed: true })),
    appExport: vi.fn(async () => ({ path: '/exports/project', sha256: 'a'.repeat(64) })),
    releaseAppBrowser: vi.fn(),
    hideBrowsers: vi.fn(),
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
  await app.getSnapshot();
  const send = (type: 'createApp' | 'startApp' | 'stopApp' | 'exportApp', commandId = randomUUID()) =>
    app.command({ type, commandId, workspaceId: 'taskflow-demo' });
  return { app, runtime, send };
}
describe('managed application ownership', () => {
  it('binds a single project, starts a real browser resource, stops its lease and exports source', async () => {
    const { app, runtime, send } = await setup();
    expect((await send('createApp')).ok).toBe(true);
    expect((await send('createApp')).ok).toBe(false);
    const started = await send('startApp');
    expect(started.ok).toBe(true);
    const w = started.snapshot.workspaces[0]!;
    const resource = w.resources.find((r) => r.appProjectId);
    expect(resource).toMatchObject({
      kind: 'web',
      environmentId: 'sandbox',
      url: w.managedApp!.url,
      appProjectId: w.managedApp!.projectId,
    });
    await send('stopApp');
    expect(runtime.releaseAppBrowser).toHaveBeenCalledWith(resource!.resourceId);
    expect((await app.getSnapshot()).workspaces[0]!.managedApp).toMatchObject({ state: 'stopped', cleanupConfirmed: true });
    await send('exportApp');
    expect((await app.getSnapshot()).workspaces[0]!.appExport?.path).toBe('/exports/project');
  });
  it('deduplicates inflight commands and rejects identity reuse across command types', async () => {
    const { runtime, send } = await setup();
    const id = randomUUID();
    const results = await Promise.all([send('createApp', id), send('createApp', id)]);
    expect(results.every((r) => r.ok)).toBe(true);
    expect(runtime.appCreate).toHaveBeenCalledTimes(1);
    expect((await send('startApp', id)).ok).toBe(false);
  });
  it('allows stop while startup is pending and ignores the late started result', async () => {
    const { app, runtime, send } = await setup();
    await send('createApp');
    let finish!: (app: ManagedApp) => void;
    let entered!: () => void;
    const called = new Promise<void>((resolve) => (entered = resolve));
    runtime.appStart = vi.fn(() => {
      entered();
      return new Promise<ManagedApp>((resolve) => (finish = resolve));
    });
    const pending = send('startApp');
    await called;
    const snapshot = (await app.getSnapshot()).workspaces[0]!.managedApp!;
    await send('stopApp');
    finish({ ...snapshot, state: 'running', appInstanceId: randomUUID(), url: 'http://127.0.0.1:49153' });
    await pending;
    const w = (await app.getSnapshot()).workspaces[0]!;
    expect(w.managedApp?.state).toBe('stopped');
    expect(w.resources.some((r) => r.appProjectId)).toBe(false);
  });
  it('records unexpected exit only for the current app identity', async () => {
    const { app, send } = await setup();
    await send('createApp');
    await send('startApp');
    const current = (await app.getSnapshot()).workspaces[0]!.managedApp!;
    await app.onApp({ ...current, appInstanceId: 'old', state: 'failed', url: null });
    expect((await app.getSnapshot()).workspaces[0]!.managedApp?.state).toBe('running');
    await app.onApp({ ...current, state: 'failed', url: null, error: 'process exited', cleanupConfirmed: true });
    const w = (await app.getSnapshot()).workspaces[0]!;
    expect(w.managedApp?.state).toBe('failed');
    expect(w.resources.find((r) => r.appProjectId)?.unavailableReason).toBe('process exited');
  });
  it('rejects nonexistent workspace before creating any service', async () => {
    const { app, runtime } = await setup();
    const result = await app.command({ type: 'createApp', workspaceId: 'foreign', commandId: randomUUID() } as WorkbenchCommand);
    expect(result.ok).toBe(false);
    expect(runtime.appCreate).not.toHaveBeenCalled();
  });
});

describe('application initialization event race', () => {
  it('does not publish created from an intermediate event while the create command owns completion', async () => {
    const { app, runtime, send } = await setup();
    let finish!: (app: ManagedApp) => void;
    let created!: ManagedApp;
    let entered!: () => void;
    const called = new Promise<void>((resolve) => (entered = resolve));
    runtime.appCreate = vi.fn((target) => {
      created = {
        ...target,
        environmentId: 'sandbox',
        appInstanceId: null,
        state: 'created',
        url: null,
        guestCwd: '/guest/project',
        error: null,
        cleanupConfirmed: false,
      };
      entered();
      return new Promise<ManagedApp>((resolve) => (finish = resolve));
    });
    const pending = send('createApp');
    await called;
    await app.onApp(created);
    expect((await app.getSnapshot()).workspaces[0]!.managedApp?.state).toBe('starting');
    runtime.appStart = vi.fn(async () => ({
      ...created,
      state: 'running' as const,
      appInstanceId: randomUUID(),
      url: 'http://127.0.0.1:49152',
    }));
    finish({ ...created, cleanupConfirmed: true });
    await pending;
    expect((await app.getSnapshot()).workspaces[0]!.managedApp?.state).toBe('created');
    expect((await send('startApp')).ok).toBe(true);
  });
});

it.each(['confirmed', 'unknown', 'wrong-project'] as const)('restores app cleanup from service authority only: %s', async (kind) => {
  const { app, runtime, send } = await setup();
  await send('createApp');
  await send('startApp');
  const saved = structuredClone(await app.getSnapshot());
  const previous = saved.workspaces[0]!.managedApp!;
  runtime.validateBrowserUrl = vi.fn();
  runtime.appGet = vi.fn(async (): Promise<ManagedApp> => ({
    ...previous,
    projectId: kind === 'wrong-project' ? 'other-project' : previous.projectId,
    appInstanceId: null,
    state: kind === 'unknown' ? 'failed' : 'stopped',
    url: null,
    cleanupConfirmed: kind !== 'unknown',
  }));
  const restored = new WorkbenchApplication(
    {
      migrationPending: false,
      loadCatalog: catalogForTestSnapshot,
      load: async () => saved,
      save: async () => undefined,
      appendObservation: async () => '',
    },
    runtime,
    vi.fn(),
  );
  const result = (await restored.getSnapshot()).workspaces[0]!.managedApp!;
  expect(runtime.appGet).toHaveBeenCalledWith({ workspaceId: 'taskflow-demo', projectId: previous.projectId });
  expect(result.cleanupConfirmed).toBe(kind === 'confirmed');
  expect(result.state).toBe(kind === 'confirmed' ? 'stopped' : 'failed');
  expect(result.url).toBeNull();
  expect(runtime.appStart).toHaveBeenCalledTimes(1); // initial run only; recovery never replays
});

describe('space App description', () => {
  it('creates an independent stable identity and edits metadata without replacing the running instance or browser', async () => {
    const { app, send, runtime } = await setup();
    const created = await app.command({
      type: 'createApp',
      commandId: randomUUID(),
      workspaceId: 'taskflow-demo',
      name: '任务板',
      description: '团队待办',
    });
    expect(created.ok).toBe(true);
    const description = created.snapshot.workspaces[0]!.app!;
    expect(description).toMatchObject({ workspaceId: 'taskflow-demo', name: '任务板', description: '团队待办', revision: 0 });
    expect(description.appId).not.toBe(description.projectId);
    await send('startApp');
    const before = (await app.getSnapshot()).workspaces[0]!;
    const result = await app.command({
      type: 'updateApp',
      commandId: randomUUID(),
      workspaceId: before.workspaceId,
      appId: description.appId,
      expectedAppRevision: 0,
      name: '工作板',
      description: '新的说明',
    });
    expect(result.ok).toBe(true);
    const after = result.snapshot.workspaces[0]!;
    expect(after.app).toEqual({ ...description, name: '工作板', description: '新的说明', revision: 1 });
    expect(after.managedApp).toEqual(before.managedApp);
    const browser = after.resources.find((r) => r.appProjectId)!;
    expect(browser).toEqual({ ...before.resources.find((r) => r.appProjectId), title: '工作板' });
    expect(runtime.releaseAppBrowser).not.toHaveBeenCalled();
    expect(runtime.appStart).toHaveBeenCalledTimes(1);
    const stale = await app.command({
      type: 'updateApp',
      commandId: randomUUID(),
      workspaceId: before.workspaceId,
      appId: description.appId,
      expectedAppRevision: 0,
      name: '旧修改',
      description: '',
    });
    expect(stale).toMatchObject({ ok: false, error: { code: 'conflict' } });
    const other = await app.command({ type: 'createWorkspace', commandId: randomUUID(), workspaceId: 'another', name: '其他空间' });
    expect(other.ok).toBe(true);
    expect(
      await app.command({
        type: 'updateApp',
        commandId: randomUUID(),
        workspaceId: 'another',
        appId: description.appId,
        expectedAppRevision: 1,
        name: '误写',
        description: '',
      }),
    ).toMatchObject({ ok: false, error: { code: 'denied' } });
  });
  it('keeps the registered App and project identity when creation reports failure, without replaying create', async () => {
    const { app, runtime, send } = await setup();
    runtime.appCreate = vi.fn(async (target) => ({
      ...target,
      environmentId: 'sandbox',
      appInstanceId: null,
      state: 'failed',
      url: null,
      guestCwd: '/guest/partial',
      error: 'fixture source write failed',
      cleanupConfirmed: true,
    }));
    const id = randomUUID();
    expect(await send('createApp', id)).toMatchObject({ ok: false, error: { message: 'fixture source write failed' } });
    const owner = (await app.getSnapshot()).workspaces[0]!;
    expect(owner.app?.projectId).toBe(owner.managedApp?.projectId);
    expect(await send('createApp', id)).toMatchObject({ ok: false });
    expect(await send('createApp')).toMatchObject({ ok: false });
    expect((await app.getSnapshot()).workspaces[0]!.app).toEqual(owner.app);
    expect(runtime.appCreate).toHaveBeenCalledTimes(1);
  });
});

it('freezes the App project and native page element, omits large screenshots from task text and rejects stale pages', async () => {
  const { app, runtime, send } = await setup();
  runtime.environmentsList = vi.fn().mockResolvedValue([]);
  runtime.registerSession = vi.fn();
  runtime.ensureBrowser = vi.fn();
  runtime.browserAction = vi.fn();
  runtime.send = vi.fn().mockRejectedValue(new Error('fixture runner deliberately unavailable'));
  const page = { webContentsId: 42, documentGeneration: 7, url: 'http://127.0.0.1:49152', title: 'App 页面', partition: 'preview' };
  runtime.browserState = vi.fn().mockReturnValue({
    page,
    loading: false,
    canGoBack: false,
    canGoForward: false,
    picking: false,
    cdp: { state: 'attached' },
    consoleIssueCount: 0,
    loadError: null,
    blockedNavigation: null,
    pickError: null,
  });
  await send('createApp');
  await send('startApp');
  let owner = (await app.getSnapshot()).workspaces[0]!;
  const browser = owner.resources.find((r) => r.appProjectId)!;
  const session = owner.sessions[0]!;
  const requestId = randomUUID();
  expect(
    (
      await app.command({
        type: 'captureContext',
        commandId: randomUUID(),
        workspaceId: owner.workspaceId,
        resourceId: browser.resourceId,
        sessionId: session.sessionId,
        requestId,
      })
    ).ok,
  ).toBe(true);
  owner = (await app.getSnapshot()).workspaces[0]!;
  const current = owner.resources.find((r) => r.resourceId === browser.resourceId)!;
  const capture = {
    captureId: randomUUID(),
    capturedAt: '2026-10-10T00:00:00Z',
    page,
    element: {
      tagName: 'button',
      id: 'add',
      classes: ['primary'],
      role: 'button',
      ariaLabel: '添加任务',
      testId: 'add-task',
      text: '添加',
      selector: '#app > button#add',
      rect: { x: 1, y: 2, width: 100, height: 30 },
    },
    screenshot: { viewport: 'data:image/png;base64,' + 'A'.repeat(100000), element: null },
    consoleIssues: [],
  };
  app.onCapture(browser.resourceId, capture, 'stale-instance', current.generation, requestId);
  expect((await app.getSnapshot()).workspaces[0]!.sessions[0]!.context).toBeNull();
  app.onCapture(browser.resourceId, capture, current.instanceId, current.generation, requestId);
  expect((await app.getSnapshot()).workspaces[0]!.sessions[0]!.context?.page.webContentsId).toBe(42);
  const targetRef = { kind: 'web' as const, resourceId: browser.resourceId };
  const confirmed = await app.command({
    type: 'confirmTask',
    commandId: randomUUID(),
    workspaceId: owner.workspaceId,
    sessionId: session.sessionId,
    targetRef,
    goal: '将添加按钮改为新建任务',
  });
  expect(confirmed.ok).toBe(true);
  const version = confirmed.snapshot.workspaces[0]!.sessions[0]!.taskVersions.at(-1)!;
  expect(version.appTarget).toMatchObject({ appId: owner.app!.appId, projectId: owner.app!.projectId, guestCwd: '/guest/project' });
  const forged = structuredClone(confirmed.snapshot);
  forged.workspaces[0]!.sessions[0]!.taskVersions.at(-1)!.appTarget!.workspaceId = 'another-space';
  expect(() => validateSnapshot(forged)).toThrow('任务 App 工程');
  expect(
    (
      await app.command({
        type: 'startRun',
        commandId: randomUUID(),
        workspaceId: owner.workspaceId,
        sessionId: session.sessionId,
        taskVersionId: version.taskVersionId,
      })
    ).ok,
  ).toBe(true);
  const prompt = vi.mocked(runtime.send).mock.calls[0]![1];
  expect(prompt).toContain('#app > button#add');
  expect(prompt).toContain('add-task');
  expect(prompt).toContain('/guest/project');
  expect(prompt).toContain('不授予权限');
  expect(prompt).not.toContain('data:image');
  expect(prompt.length).toBeLessThan(32000);
  vi.mocked(runtime.browserState).mockReturnValue({
    ...runtime.browserState(browser.resourceId),
    page: { ...page, documentGeneration: 8 },
  });
  expect(
    await app.command({
      type: 'startRun',
      commandId: randomUUID(),
      workspaceId: owner.workspaceId,
      sessionId: session.sessionId,
      taskVersionId: version.taskVersionId,
    }),
  ).toMatchObject({ ok: false, error: { code: 'conflict' } });
  expect(runtime.send).toHaveBeenCalledTimes(1);
});

it('rejects an oversized combined task before recording a run or invoking the runner', async () => {
  const { app, runtime } = await setup();
  runtime.environmentsList = vi.fn().mockResolvedValue([]);
  runtime.send = vi.fn();
  const owner = (await app.getSnapshot()).workspaces[0]!;
  const sessionId = owner.sessions[0]!.sessionId;
  const confirmed = await app.command({
    type: 'confirmTask',
    commandId: randomUUID(),
    workspaceId: owner.workspaceId,
    sessionId,
    targetRef: null,
    goal: '目'.repeat(32000),
  });
  expect(confirmed.ok).toBe(true);
  const taskVersionId = confirmed.snapshot.workspaces[0]!.sessions[0]!.taskVersions.at(-1)!.taskVersionId;
  expect(
    await app.command({ type: 'startRun', commandId: randomUUID(), workspaceId: owner.workspaceId, sessionId, taskVersionId }),
  ).toMatchObject({ ok: false, error: { code: 'invalid_input' } });
  expect((await app.getSnapshot()).workspaces[0]!.runs).toHaveLength(0);
  expect(runtime.send).not.toHaveBeenCalled();
});
