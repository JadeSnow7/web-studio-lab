import { catalogForTestSnapshot } from './catalog-test-fixture';
import { randomUUID } from 'node:crypto';
import { describe, expect, it, vi } from 'vitest';
import type { AppImportOutcome, AppTarget, EduImport, ManagedApp, WorkbenchCommand } from '@wsl/protocol';
import { WorkbenchApplication, validateSnapshot } from './application';
import type { AppImportSelection, WorkbenchRuntime } from './ports';

const eduInput: Pick<EduImport, 'source' | 'files'> = {
  source: {
    repository: { commit: 'a'.repeat(40), dirty: false },
    sourceSha256: 'b'.repeat(64),
    files: [{ path: 'server/app.py', sha256: 'c'.repeat(64), bytes: 4 }],
  },
  files: [{ path: 'server/app.py', base64: 'dGVzdA==' }],
};
function eduSelection(): AppImportSelection {
  return {
    ...structuredClone(eduInput),
    preview: {
      name: 'edu-web',
      profile: 'edu-web',
      profileVersion: 1,
      repository: structuredClone(eduInput.source.repository),
      sourceSha256: eduInput.source.sourceSha256,
      fileCount: eduInput.files.length,
      totalBytes: eduInput.source.files.reduce((total, file) => total + file.bytes, 0),
      warnings: [],
    },
    revalidate: vi.fn(async () => structuredClone(eduInput)),
  };
}
async function setup() {
  let instance: ManagedApp | null = null;
  const runtime = {
    appSelectImportSource: vi.fn(async () => eduSelection()),
    appImportSource: vi.fn(async (target: AppTarget, source: Pick<EduImport, 'source' | 'files'>): Promise<AppImportOutcome> => {
      instance = {
        ...target,
        profile: { projectKind: 'edu-web', profileVersion: 1, source: source.source },
        sourceSha256: source.source.sourceSha256,
        environmentId: 'sandbox',
        appInstanceId: null,
        state: 'created',
        url: null,
        guestCwd: '/guest/edu-project',
        error: null,
        cleanupConfirmed: true,
      };
      return { app: instance, outcome: 'imported', retryable: false, errorCode: null };
    }),
    appCancelImport: vi.fn(async (): Promise<AppImportOutcome> => ({
      app: null,
      outcome: 'cancelled',
      retryable: false,
      errorCode: null,
    })),
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
    ensureBrowser: vi.fn(),
    browserState: vi.fn(() => null),
    browserLayout: vi.fn(),
    browserAction: vi.fn(async () => undefined),
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
  const send = (type: 'createApp' | 'importEduApp' | 'startApp' | 'stopApp' | 'exportApp', commandId = randomUUID()) =>
    app.command({ type, commandId, workspaceId: 'taskflow-demo' });
  const confirmImport = async (commandId = randomUUID()) => {
    const view = (await app.getSnapshot()).workspaces[0]!.appImport!;
    return app.command({
      type: 'confirmAppImport',
      commandId,
      workspaceId: 'taskflow-demo',
      previewId: view.previewId,
      sourceSha256: view.preview!.sourceSha256,
    });
  };
  return { app, runtime, send, confirmImport };
}
describe('Main-owned edu import', () => {
  it('creates one real project binding from selected source instead of a stored URL or standard template', async () => {
    const { app, runtime, send, confirmImport } = await setup();
    const id = randomUUID();
    const results = await Promise.all([send('importEduApp', id), send('importEduApp', id)]);
    expect(results.every((result) => result.ok)).toBe(true);
    expect(runtime.appSelectImportSource).toHaveBeenCalledTimes(1);
    expect(runtime.appImportSource).not.toHaveBeenCalled();
    expect(runtime.appStart).not.toHaveBeenCalled();
    const confirmationId = randomUUID();
    expect((await Promise.all([confirmImport(confirmationId), confirmImport(confirmationId)])).every((result) => result.ok)).toBe(true);
    expect(runtime.appImportSource).toHaveBeenCalledTimes(1);
    expect(runtime.appCreate).not.toHaveBeenCalled();
    const imported = (await app.getSnapshot()).workspaces[0]!.managedApp!;
    expect(imported).toMatchObject({ state: 'running', profile: { projectKind: 'edu-web', profileVersion: 1, source: eduInput.source } });
    expect((await send('createApp')).ok).toBe(false);
    expect(runtime.appStart).toHaveBeenCalledTimes(1);
    const running = (await app.getSnapshot()).workspaces[0]!;
    expect(running.resources.find((resource) => resource.appProjectId === imported.projectId)).toMatchObject({
      kind: 'web',
      environmentId: 'sandbox',
      title: 'edu-web',
    });
  });
  it('navigates between named edu pages through the owned browser resource and rejects a stopped app', async () => {
    const { app, runtime, send, confirmImport } = await setup();
    await send('importEduApp');
    expect((await confirmImport()).ok).toBe(true);
    const current = (await app.getSnapshot()).workspaces[0]!;
    const resource = current.resources.find((item) => item.appProjectId === current.managedApp?.projectId)!;
    for (const page of ['student', 'admin'] as const) {
      const result = await app.command({ type: 'openAppPage', commandId: randomUUID(), workspaceId: current.workspaceId, page });
      expect(result.ok).toBe(true);
      expect(runtime.browserAction).toHaveBeenLastCalledWith(
        resource.resourceId,
        'navigate',
        current.managedApp!.url + (page === 'student' ? '/student' : '/'),
      );
    }
    await send('stopApp');
    expect(
      (await app.command({ type: 'openAppPage', commandId: randomUUID(), workspaceId: current.workspaceId, page: 'student' })).ok,
    ).toBe(false);
    expect(runtime.browserAction).toHaveBeenCalledTimes(2);
  });
  it('leaves an empty workspace unbound when the native picker is cancelled', async () => {
    const { app, runtime, send } = await setup();
    runtime.appSelectImportSource = vi.fn(async () => null);
    expect((await send('importEduApp')).ok).toBe(true);
    expect(runtime.appSelectImportSource).toHaveBeenCalledTimes(1);
    expect((await app.getSnapshot()).workspaces[0]!.managedApp).toBeFalsy();
    expect(runtime.appImportSource).not.toHaveBeenCalled();
    expect((await send('createApp')).ok).toBe(true);
  });
  it('waits for source acquisition cancellation and never imports a late result', async () => {
    const { app, runtime, send } = await setup();
    let release!: (source: AppImportSelection) => void;
    let signal!: AbortSignal;
    runtime.appSelectImportSource = vi.fn((scope: AbortSignal) => {
      signal = scope;
      return new Promise<AppImportSelection>((resolve) => {
        release = resolve;
      });
    });
    const importing = send('importEduApp');
    await vi.waitFor(() => expect(runtime.appSelectImportSource).toHaveBeenCalledTimes(1));
    expect((await send('createApp')).ok).toBe(false);
    let cancelled = false;
    const previewId = (await app.getSnapshot()).workspaces[0]!.appImport!.previewId;
    const cancelling = app
      .command({ type: 'cancelAppImport', commandId: randomUUID(), workspaceId: 'taskflow-demo', previewId })
      .then((result) => {
        cancelled = true;
        return result;
      });
    await vi.waitFor(() => expect(signal.aborted).toBe(true));
    expect(cancelled).toBe(false);
    release(eduSelection());
    const previewResult = await importing;
    expect(previewResult.ok).toBe(true);
    expect((await cancelling).ok).toBe(true);
    expect((await app.getSnapshot()).workspaces[0]!.appImport).toMatchObject({
      phase: 'cancelled',
      published: false,
      canCancel: false,
      canRetry: false,
    });
    expect(runtime.appImportSource).not.toHaveBeenCalled();
    expect(runtime.appStop).not.toHaveBeenCalled();
    expect((await app.getSnapshot()).workspaces[0]!.managedApp).toBeFalsy();
  });
  it('does not accept an event that replaces the imported profile for the same process identity', async () => {
    const { app, send, confirmImport } = await setup();
    await send('importEduApp');
    expect((await confirmImport()).ok).toBe(true);
    const current = (await app.getSnapshot()).workspaces[0]!.managedApp!;
    expect(current).toMatchObject({ state: 'running', profile: { projectKind: 'edu-web' } });
    await app.onApp({ ...current, profile: { projectKind: 'standard-app', profileVersion: 1 }, state: 'failed', url: null });
    expect((await app.getSnapshot()).workspaces[0]!.managedApp).toEqual(current);
  });
});

describe('managed application ownership', () => {
  it.each(['stopped', 'failed'] as const)(
    'treats passive layout for a %s App as a no-op, not an attempt to acquire another browser lease',
    async (state) => {
      const { app, runtime, send } = await setup();
      await send('createApp');
      await send('startApp');
      const running = (await app.getSnapshot()).workspaces[0]!;
      const resource = running.resources.find((item) => item.appProjectId === running.managedApp?.projectId)!;
      if (state === 'stopped') await send('stopApp');
      else await app.onApp({ ...running.managedApp!, state, url: null, error: 'fixture failure', cleanupConfirmed: true });
      runtime.ensureBrowser = vi.fn(() => {
        throw new Error('unavailable: app lease is not running');
      });
      for (const visible of [true, false]) {
        const result = await app.command({
          type: 'browserLayout',
          workspaceId: running.workspaceId,
          resourceId: resource.resourceId,
          commandId: randomUUID(),
          layout: { visible, bounds: { x: 0, y: 0, width: 100, height: 100 } },
        });
        expect(result.ok).toBe(true);
      }
      expect(runtime.ensureBrowser).not.toHaveBeenCalled();
      expect(runtime.browserLayout).not.toHaveBeenCalled();
      expect(
        (
          await app.command({
            type: 'browserAction',
            workspaceId: running.workspaceId,
            resourceId: resource.resourceId,
            commandId: randomUUID(),
            action: 'reload',
          })
        ).ok,
      ).toBe(false);
    },
  );
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
  it.each(['running', 'starting', 'stopping', 'failed'] as const)('preserves a confirmed stop despite a late %s event', async (state) => {
    const { app, send } = await setup();
    await send('createApp');
    await send('startApp');
    const previous = (await app.getSnapshot()).workspaces[0]!.managedApp!;
    await send('stopApp');
    const stopped = (await app.getSnapshot()).workspaces[0]!.managedApp!;
    await app.onApp({ ...previous, state });
    expect((await app.getSnapshot()).workspaces[0]!.managedApp).toEqual(stopped);
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

describe('edu metadata and default execution compatibility', () => {
  it('imports a real App descriptor and refuses default shared-workspace execution', async () => {
    const { app, runtime, send, confirmImport } = await setup();
    runtime.environmentsList = vi.fn(async () => []);
    runtime.send = vi.fn();
    expect((await send('importEduApp')).ok).toBe(true);
    expect((await confirmImport()).ok).toBe(true);
    const workspace = (await app.getSnapshot()).workspaces[0]!;
    expect(workspace.app).toMatchObject({
      workspaceId: workspace.workspaceId,
      projectId: workspace.managedApp!.projectId,
      name: 'edu-web',
      revision: 0,
    });
    validateSnapshot(await app.getSnapshot());
    const session = workspace.sessions[0]!;
    await app.command({
      type: 'confirmTask',
      commandId: randomUUID(),
      workspaceId: workspace.workspaceId,
      sessionId: session.sessionId,
      goal: 'edit',
      targetRef: null,
    });
    const version = (await app.getSnapshot()).workspaces[0]!.sessions[0]!.taskVersions.at(-1)!;
    const result = await app.command({
      type: 'startRun',
      commandId: randomUUID(),
      workspaceId: workspace.workspaceId,
      sessionId: session.sessionId,
      taskVersionId: version.taskVersionId,
    });
    expect(result).toMatchObject({ ok: false, error: { code: 'denied' } });
    expect(runtime.appCreate).not.toHaveBeenCalled();
    expect(runtime.send).not.toHaveBeenCalled();
  });
});
