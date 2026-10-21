import { createHash, randomUUID } from 'node:crypto';
import { EventEmitter } from 'node:events';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { tmpdir } from 'node:os';
import { BrowserWindow, dialog } from 'electron';
import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  MOTA_REQUIRED_FILES,
  MOTA_PLAY_SCOPE,
  MOTA_MAP_WRITE_SCOPE,
  WorkbenchCommandSchema,
  MotaEditorResultSchema,
  WorkbenchRunSchema,
  type ChatConversation,
  type MotaControlRequest,
  type ManagedApp,
  type PreviewState,
  type WorkbenchSnapshot,
} from '@wsl/protocol';
import { ChatService } from '../chat-service';
import { WorkbenchApplication, validateSnapshot } from './application';
import { WorkbenchHost } from './host';
import { catalogForTestSnapshot } from './catalog-test-fixture';
import type { AppControl } from './app-control';
import { RunDispatchFailure, type MotaEditorNativePort, type MotaEditorServicePort } from './ports';
import { MotaEditorAssets } from '../mota-editor/assets';
import { MotaEditorController } from '../mota-editor/controller';
import { createOcclusion } from '../../renderer/src/state/occlusion';
import { panes } from './layout';

vi.mock('electron', () => ({
  app: {},
  BrowserWindow: class {
    visible = true;
    minimized = false;
    isDestroyed = () => false;
    isVisible = () => this.visible;
    isMinimized = () => this.minimized;
    contentView = { addChildView: vi.fn(), removeChildView: vi.fn() };
  },
  WebContentsView: class {
    webContents = new (class extends EventEmitter {
      id = 43;
      mainFrame = { url: '', processId: 3, routingId: 4, detached: false };
      getURL = () => this.mainFrame.url;
      isDestroyed = () => false;
      send = vi.fn();
      setWindowOpenHandler = vi.fn();
      loadURL = vi.fn(async (url: string) => {
        this.emit('did-start-navigation');
        this.mainFrame.url = url;
        this.emit('did-finish-load');
      });
    })();
    setBounds = vi.fn();
  },
  dialog: { showOpenDialog: vi.fn() },
  session: {
    fromPartition: () => ({
      setPermissionRequestHandler: vi.fn(),
      setPermissionCheckHandler: vi.fn(),
      on: vi.fn(),
      webRequest: { onBeforeRequest: vi.fn() },
    }),
  },
}));
vi.mock('../preview/demo-protocol', () => ({ DEMO_ORIGIN: 'wsl-demo://taskflow', installDemoProtocol: vi.fn() }));
vi.mock('../preview/app-ui', () => ({
  AppUiDriver: class {
    dispose = vi.fn();
    motaState = vi.fn();
    motaAct = vi.fn();
    snapshot = vi.fn();
    act = vi.fn();
    query = vi.fn();
    bridge = vi.fn();
  },
}));
vi.mock('../preview/controller', () => ({
  PreviewController: class {
    private url: string;
    constructor(_window: unknown, options: { homeUrl: string }) {
      this.url = options.homeUrl;
    }
    load = vi.fn();
    dispose = vi.fn();
    setLayout = vi.fn();
    hasEduAudio = () => false;
    navigate = vi.fn(async (url: string) => {
      this.url = url;
    });
    getState = (): PreviewState => ({
      page: { webContentsId: 42, documentGeneration: 0, url: this.url, title: 'Mota', partition: 'fixture' },
      loading: false,
      picking: false,
      canGoBack: false,
      canGoForward: false,
      consoleIssueCount: 0,
      cdp: { state: 'attached' },
      pickError: null,
      loadError: null,
      blockedNavigation: null,
    });
    pageIdentity = () => this.getState().page;
    getCdpState = () => ({ state: 'attached' });
    isPicking = () => false;
    agentControl = { state: () => ({ state: 'idle', runId: null, since: null, lastAction: null }), begin: vi.fn(), release: vi.fn() };
  },
}));
const roots: string[] = [];
afterEach(async () => {
  vi.restoreAllMocks();
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});
const required = <T>(value: T | null | undefined): T => {
  if (value == null) throw new Error('missing fixture value');
  return value;
};
function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((done) => {
    resolve = done;
  });
  return { promise, resolve };
}
async function fixture() {
  const root = await mkdtemp(path.join(tmpdir(), 'wsl-mota-main-'));
  roots.push(root);
  for (const file of MOTA_REQUIRED_FILES) {
    await mkdir(path.dirname(path.join(root, file)), { recursive: true });
    await writeFile(path.join(root, file), 'fixture source for ' + file);
  }
  vi.mocked(dialog.showOpenDialog).mockResolvedValue({ canceled: false, filePaths: [root] });
  const chat = vi.mockObject(ChatService.prototype);
  let current: ManagedApp | undefined;
  let listener: ((app: ManagedApp) => void) | undefined;
  let starts = 0;
  chat.setAppListener.mockImplementation((value) => {
    listener = value;
  });
  chat.environmentsList.mockResolvedValue([]);
  chat.registerResource.mockResolvedValue(undefined);
  chat.appImportSource.mockImplementation(async (input) => {
    if (!('profile' in input) || input.profile !== 'mota-web') throw new Error('expected explicit mota import');
    current = {
      workspaceId: input.workspaceId,
      projectId: input.projectId,
      profile: { projectKind: 'mota-web', profileVersion: 1, source: input.source },
      sourceSha256: input.source.sourceSha256,
      environmentId: 'sandbox',
      appInstanceId: null,
      state: 'created',
      url: null,
      guestCwd: '/guest/owned-mota',
      error: null,
      cleanupConfirmed: true,
    };
    return { app: current, outcome: 'imported', retryable: false, errorCode: null };
  });
  const start = async (): Promise<ManagedApp> =>
    (current = {
      ...required(current),
      state: 'running',
      appInstanceId: randomUUID(),
      url: `http://127.0.0.1:${49152 + starts++}`,
      cleanupConfirmed: false,
    });
  chat.appStart.mockImplementation(start);
  chat.appStop.mockImplementation(async () => (current = { ...required(current), state: 'stopped', url: null, cleanupConfirmed: true }));
  chat.appGet.mockImplementation(async () => required(current));
  chat.appCancelImport.mockResolvedValue({ app: null, outcome: 'cancelled', retryable: false, errorCode: null });
  const window = new BrowserWindow();
  const host = new WorkbenchHost(window, chat, '/unused-demo');
  const browserAction = vi.spyOn(host, 'browserAction');
  const release = vi.spyOn(host, 'releaseAppBrowser');
  let durable: WorkbenchSnapshot | null = null;
  const save = vi.fn(async (snapshot: WorkbenchSnapshot) => {
    durable = structuredClone(snapshot);
  });
  const editorPorts = {
    ensureMotaEditor: vi.fn<MotaEditorNativePort['ensureMotaEditor']>(),
    motaEditorFacts: vi.fn<MotaEditorNativePort['motaEditorFacts']>(() => null),
    motaEditorLayout: vi.fn<MotaEditorNativePort['motaEditorLayout']>(),
    motaEditorVisibility: vi.fn<MotaEditorNativePort['motaEditorVisibility']>(),
    releaseMotaEditor: vi.fn(),
    motaEditorRequest: vi.fn<MotaEditorServicePort['motaEditorRequest']>(async () => {
      throw new Error('No native editor transport in this lifecycle fixture');
    }),
  } satisfies MotaEditorNativePort & MotaEditorServicePort;
  const app = new WorkbenchApplication(
    { migrationPending: false, load: async () => null, loadCatalog: catalogForTestSnapshot, save, appendObservation: async () => '' },
    host,
    vi.fn(),
    { ports: editorPorts, store: { load: async () => [], save: async () => undefined } },
  );
  host.application = app;
  await app.getSnapshot();
  const command = (input: Record<string, unknown>) =>
    app.command(
      WorkbenchCommandSchema.parse({
        commandId: randomUUID(),
        workspaceId: 'taskflow-demo',
        ...input,
      }),
    );
  const owner = async () => required((await app.getSnapshot()).workspaces.find((w) => w.workspaceId === 'taskflow-demo'));
  const preview = () => command({ type: 'previewAppImport' });
  const confirm = async () => {
    const view = required((await owner()).appImport);
    return command({ type: 'confirmAppImport', previewId: view.previewId, sourceSha256: required(view.preview).sourceSha256 });
  };
  const imported = async () => {
    expect((await preview()).ok).toBe(true);
    expect((await confirm()).ok).toBe(true);
  };
  return {
    root,
    chat,
    host,
    window,
    app,
    command,
    owner,
    preview,
    confirm,
    imported,
    start,
    save,
    release,
    browserAction,
    editorPorts,
    durable: () => durable,
    emit: (value: ManagedApp) => required(listener)(value),
  };
}

// Real Main queue and native controller; only Electron objects, assets and private service replies are synthetic.
async function activeEditor(f: Awaited<ReturnType<typeof fixture>>) {
  await f.imported();
  expect((await f.command({ type: 'openAppPage', page: 'editor' })).ok).toBe(true);
  const space = await f.owner();
  const resource = required(space.resources.find((entry) => entry.appPage === 'editor'));
  const files = ['LICENSES.txt', 'editor.css', 'editor.js', 'index.html'].map((name) => ({
    path: name,
    length: name.length,
    sha256: createHash('sha256').update(name).digest('hex'),
  }));
  const assets = new MotaEditorAssets('/not-read-in-queue-unit', {
    schemaVersion: 1,
    version: createHash('sha256').update(JSON.stringify(files)).digest('hex'),
    files,
  });
  vi.spyOn(assets, 'validate').mockResolvedValue();
  vi.spyOn(assets, 'install').mockImplementation(() => undefined);
  const owner = new MotaEditorController(
    f.window,
    space.workspaceId,
    resource,
    required(space.managedApp),
    space.theme,
    assets,
    '/preload/mota-editor.js',
    (facts) => f.app.onMotaEditorFacts(facts),
  );
  f.editorPorts.motaEditorFacts.mockImplementation(() => owner.getFacts());
  f.editorPorts.ensureMotaEditor.mockImplementation((workspaceId, resource, app, theme) => owner.update(workspaceId, resource, app, theme));
  f.editorPorts.motaEditorLayout.mockImplementation((_id, layout) => owner.layout(layout));
  f.editorPorts.motaEditorVisibility.mockImplementation((_id, visible, projection) => owner.visibility(visible, projection));
  f.editorPorts.motaEditorRequest.mockImplementation(async (request) =>
    MotaEditorResultSchema.parse({
      binding: request.binding,
      editorSessionId: request.editorSessionId,
      requestId: request.requestId,
      method: request.method,
      ok: true,
      data:
        request.method === 'editor.read'
          ? { content: null, contentHash: null, contentLength: 0 }
          : request.method === 'editor.revoke'
            ? { discarded: true, settled: true, operation: null }
            : request.method === 'editor.stage' || request.method === 'editor.commit'
              ? {
                  requestId: request.requestId,
                  status: request.method === 'editor.stage' ? 'staged' : 'committed',
                  error: null,
                  receipt:
                    request.method === 'editor.commit'
                      ? {
                          ...request.input,
                          editorSessionId: request.editorSessionId,
                          requestId: request.requestId,
                          afterHash: request.input.contentHash,
                          durabilityError: null,
                        }
                      : null,
                }
              : {},
    }),
  );
  const status = () => f.app.motaEditorOperationStatus(resource.resourceId, { sessionIndex: null, requestId: randomUUID() });
  const layout = { visible: true, bounds: { x: 0, y: 0, width: 300, height: 200 } };
  await vi.waitFor(() => expect(owner.getFacts().trusted).toBe(true));
  expect((await f.command({ type: 'browserLayout', resourceId: resource.resourceId, layout })).ok).toBe(true);
  await vi.waitFor(async () => expect((await status()).state).toBe('active'));
  const index = required((await status()).sessionIndex);
  const read = (sessionIndex = index) =>
    f.app.readMotaEditorFile(resource.resourceId, { sessionIndex, requestId: randomUUID(), file: '_server/config.json' });
  const save = (sessionIndex = index) =>
    f.app.saveMotaEditorFile(resource.resourceId, {
      sessionIndex,
      requestId: randomUUID(),
      file: '_server/config.json',
      expectedHash: null,
      content: '{}',
    });
  await read();
  return { owner, resource, layout, status, index, read, save };
}

describe('Mota native import and Main page lifecycle', () => {
  it.each([false, true])('R6 admission compatibility preserves pane-limit errors with owned Mota editor=%s', async (owned) => {
    const f = await fixture();
    for (let count = 1; count < 4; count++) {
      const space = await f.owner();
      expect((await f.command({ type: 'splitPane', paneId: space.activePaneId, direction: 'horizontal' })).ok).toBe(true);
    }
    const e = owned ? await activeEditor(f) : null;
    const before = await f.owner();
    const calls = f.editorPorts.motaEditorRequest.mock.calls.length;
    const result = await f.command({
      type: 'splitPane',
      paneId: before.activePaneId,
      direction: 'vertical',
      expectedRevision: before.revision,
    });
    expect(result).toMatchObject({ ok: false, error: { code: 'pane_limit', message: 'pane_limit: 最多显示四个窗格' } });
    expect(panes((await f.owner()).layout)).toHaveLength(4);
    expect((await f.owner()).revision).toBe(before.revision);
    expect(f.editorPorts.motaEditorRequest.mock.calls).toHaveLength(calls);
    if (e) {
      expect((await e.status()).sessionIndex).toBe(e.index);
      expect((await e.save()).operation.status).toBe('committed');
    }
  });
  it('R6 admission compatibility allows overlay hiding for the window-selected non-Mota workspace', async () => {
    const f = await fixture();
    const selected = (await f.owner()).workspaceId;
    expect((await f.command({ type: 'createWorkspace', workspaceId: 'other-app-space', name: 'Other App' })).ok).toBe(true);
    const hide = vi.spyOn(f.host, 'hideBrowsers');
    const barrier = createOcclusion(async () => (await f.command({ type: 'hideBrowsers', workspaceId: selected })).ok);
    expect(await barrier.open('space-app')).toBe(true);
    expect(barrier.visible('space-app')).toBe(true);
    expect(hide).toHaveBeenCalledTimes(1);
    expect((await f.app.getSnapshot()).activeWorkspaceId).toBe('other-app-space');
    expect((await f.owner()).managedApp).toBeUndefined();
    expect(f.editorPorts.motaEditorRequest).not.toHaveBeenCalled();
  });
  it('R6 admission compatibility validates background hide then revokes all affected editors before the queue', async () => {
    const f = await fixture();
    expect((await f.command({ type: 'createWorkspace', workspaceId: 'other-app-space', name: 'Other App' })).ok).toBe(true);
    expect((await f.command({ type: 'switchWorkspace' })).ok).toBe(true);
    const e = await activeEditor(f);
    const hide = vi.spyOn(f.host, 'hideBrowsers').mockImplementation(() => e.owner.visibility(false));
    const calls = f.editorPorts.motaEditorRequest.mock.calls.length;
    expect(await f.command({ type: 'hideBrowsers', workspaceId: 'forged-workspace' })).toMatchObject({ ok: false });
    const other = required((await f.app.getSnapshot()).workspaces.find((entry) => entry.workspaceId === 'other-app-space'));
    expect(await f.command({ type: 'hideBrowsers', workspaceId: other.workspaceId, expectedRevision: other.revision + 1 })).toMatchObject({
      ok: false,
    });
    expect(f.editorPorts.motaEditorRequest.mock.calls).toHaveLength(calls);
    expect((await e.status()).state).toBe('active');
    const held = deferred<void>();
    const saving = deferred<void>();
    f.save.mockImplementationOnce(async () => {
      saving.resolve();
      await held.promise;
    });
    const queued = f.command({ type: 'renameWorkspace', name: 'held hide queue' });
    await saving.promise;
    const layout = f.command({ type: 'browserLayout', resourceId: e.resource.resourceId, layout: e.layout });
    const opens = f.editorPorts.motaEditorRequest.mock.calls.filter(([request]) => request.method === 'editor.open').length;
    const hiding = f.command({ type: 'hideBrowsers', workspaceId: other.workspaceId, expectedRevision: other.revision });
    try {
      await expect(e.save()).rejects.toThrow('revoked');
      expect(hide).not.toHaveBeenCalled();
      expect(f.editorPorts.motaEditorRequest.mock.calls.some(([request]) => request.method === 'editor.stage')).toBe(false);
    } finally {
      held.resolve();
      await Promise.all([queued, layout, hiding]);
    }
    expect((await hiding).ok).toBe(true);
    expect((await queued).ok).toBe(true);
    expect((await layout).ok).toBe(true);
    expect(hide).toHaveBeenCalledTimes(1);
    expect((await e.status()).state).toBe('revoked');
    expect(f.editorPorts.motaEditorRequest.mock.calls.filter(([request]) => request.method === 'editor.open')).toHaveLength(opens);
    expect((await f.app.getSnapshot()).activeWorkspaceId).toBe('taskflow-demo');
  });
  it.each(['hidden', 'minimized'] as const)('keeps a queued visible layout revoked while the native host is %s', async (state) => {
    const f = await fixture();
    const e = await activeEditor(f);
    const held = deferred<void>();
    const saving = deferred<void>();
    f.save.mockImplementationOnce(async () => {
      saving.resolve();
      await held.promise;
    });
    const queued = f.command({ type: 'renameWorkspace', name: 'held native visibility queue' });
    await saving.promise;
    const layout = f.command({ type: 'browserLayout', resourceId: e.resource.resourceId, layout: e.layout });
    const window = f.window as unknown as { visible: boolean; minimized: boolean };
    if (state === 'hidden') window.visible = false;
    else window.minimized = true;
    e.owner.visibility(false);
    const opens = f.editorPorts.motaEditorRequest.mock.calls.filter(([request]) => request.method === 'editor.open').length;
    held.resolve();
    expect((await queued).ok).toBe(true);
    expect((await layout).ok).toBe(true);
    await f.app.openMotaEditor(e.resource.resourceId);
    expect(e.owner.getFacts().visible).toBe(false);
    expect((await e.status()).state).toBe('revoked');
    expect(f.editorPorts.motaEditorRequest.mock.calls.filter(([request]) => request.method === 'editor.open')).toHaveLength(opens);
    await expect(e.read()).rejects.toThrow('revoked');
    await expect(e.save()).rejects.toThrow('revoked');
    expect(f.editorPorts.motaEditorRequest.mock.calls.some(([request]) => request.method === 'editor.stage')).toBe(false);
    window.visible = true;
    window.minimized = false;
    await f.app.openMotaEditor(e.resource.resourceId);
    expect((await e.status()).state).toBe('revoked');
    expect((await f.command({ type: 'browserLayout', resourceId: e.resource.resourceId, layout: e.layout })).ok).toBe(true);
    await vi.waitFor(async () => expect((await e.status()).state).toBe('active'));
    const fresh = required((await e.status()).sessionIndex);
    expect(fresh).not.toBe(e.index);
    await expect(e.read()).rejects.toThrow('revoked');
    await expect(e.save(fresh)).rejects.toThrow('source_changed');
    await e.read(fresh);
    expect((await e.save(fresh)).operation.status).toBe('committed');
  });
  it('rejects a cross-version locator before revoking another workspace editor or changing its read baseline', async () => {
    const f = await fixture();
    expect((await f.command({ type: 'createWorkspace', workspaceId: 'locator', name: 'Locator' })).ok).toBe(true);
    expect((await f.command({ type: 'createTab', workspaceId: 'locator', kind: 'session', title: 'Locator session' })).ok).toBe(true);
    const locator = required((await f.app.getSnapshot()).workspaces.find((entry) => entry.workspaceId === 'locator'));
    const session = required(locator.sessions[0]);
    for (const goal of ['version A', 'version B'])
      expect(
        (await f.command({ type: 'confirmTask', workspaceId: locator.workspaceId, sessionId: session.sessionId, goal, targetRef: null }))
          .ok,
      ).toBe(true);
    // A completed historical run needs no executor/model; its relationship remains real Main state.
    const state = (f.app as unknown as { snapshot: WorkbenchSnapshot }).snapshot;
    const target = required(state.workspaces.find((entry) => entry.workspaceId === locator.workspaceId));
    const versions = required(target.sessions[0]).taskVersions;
    const versionA = required(versions[0]);
    const versionB = required(versions[1]);
    const run = WorkbenchRunSchema.parse({
      runId: randomUUID(),
      workspaceId: target.workspaceId,
      sessionId: session.sessionId,
      taskVersionId: versionA.taskVersionId,
      targetRef: null,
      state: 'completed',
      startedAt: '2026-10-19T00:00:00Z',
      endedAt: '2026-10-19T00:00:01Z',
      error: null,
      candidateId: randomUUID(),
      validation: { state: 'not_run', applicability: 'unknown', reason: null },
      review: null,
    });
    target.runs.push(run);
    expect((await f.command({ type: 'switchWorkspace' })).ok).toBe(true);
    const e = await activeEditor(f);
    const before = await e.status();
    const calls = f.editorPorts.motaEditorRequest.mock.calls.length;
    const locate = (taskVersionId: string) =>
      f.command({
        type: 'locateSession',
        workspaceId: locator.workspaceId,
        sessionId: session.sessionId,
        taskVersionId,
        runId: run.runId,
      });
    const invalid = await locate(versionB.taskVersionId);
    expect(invalid.ok).toBe(false);
    expect(invalid.ok ? null : invalid.error.message).toContain('执行不属于指定会话或任务版本');
    expect(invalid.snapshot.activeWorkspaceId).toBe('taskflow-demo');
    expect(f.editorPorts.motaEditorRequest.mock.calls).toHaveLength(calls);
    expect(await e.status()).toEqual(before);
    // A save succeeds using the pre-rejection read, without a new read or grant.
    expect((await e.save()).operation.status).toBe('committed');
    expect(f.editorPorts.motaEditorRequest.mock.calls.filter(([request]) => request.method === 'editor.read')).toHaveLength(1);
    expect((await locate(versionA.taskVersionId)).ok).toBe(true);
    expect((await e.status()).state).toBe('revoked');
    expect(f.editorPorts.motaEditorRequest.mock.calls.filter(([request]) => request.method === 'editor.revoke')).toHaveLength(1);
    await expect(e.read()).rejects.toThrow('revoked');
  });
  it('validates close admission before queued work and revokes saving while the metadata queue is held', async () => {
    const f = await fixture();
    await f.imported();
    await f.command({ type: 'openAppPage', page: 'editor' });
    const space = await f.owner();
    const resource = required(space.resources.find((entry) => entry.appPage === 'editor'));
    const tab = required(space.tabs.find((entry) => entry.targetRef.resourceId === resource.resourceId));
    const facts = {
      workspaceId: space.workspaceId,
      projectId: required(space.managedApp).projectId,
      appInstanceId: required(required(space.managedApp).appInstanceId),
      resourceId: resource.resourceId,
      resourceInstanceId: required(resource.instanceId),
      resourceGeneration: resource.generation,
      browserInstanceId: 'native-editor',
      browserGeneration: 1,
      webContentsId: 42,
      processId: 3,
      routingId: 4,
      documentGeneration: 1,
      navigationEpoch: 1,
      url: 'wsl-editor://mota/index.html',
      assetVersion: 'a'.repeat(64),
      manifestDigest: 'b'.repeat(64),
      trusted: true,
      visible: true,
      destroyed: false,
      theme: 'light' as const,
    };
    f.editorPorts.motaEditorFacts.mockReturnValue(facts);
    f.editorPorts.motaEditorRequest.mockImplementation(async (request) =>
      MotaEditorResultSchema.parse({
        binding: request.binding,
        editorSessionId: request.editorSessionId,
        requestId: request.requestId,
        method: request.method,
        ok: true,
        data:
          request.method === 'editor.read'
            ? { content: null, contentHash: null, contentLength: 0 }
            : request.method === 'editor.revoke'
              ? { discarded: true, settled: true, operation: null }
              : {},
      }),
    );
    await f.app.openMotaEditor(resource.resourceId);
    await vi.waitFor(async () =>
      expect((await f.app.motaEditorOperationStatus(resource.resourceId, { sessionIndex: null, requestId: randomUUID() })).state).toBe(
        'active',
      ),
    );
    const index = required(
      (await f.app.motaEditorOperationStatus(resource.resourceId, { sessionIndex: null, requestId: randomUUID() })).sessionIndex,
    );
    await f.app.readMotaEditorFile(resource.resourceId, { sessionIndex: index, file: '_server/config.json', requestId: randomUUID() });
    expect((await f.command({ type: 'closeTab', tabId: 'forged-tab' })).ok).toBe(false);
    expect((await f.app.motaEditorOperationStatus(resource.resourceId, { sessionIndex: index, requestId: randomUUID() })).state).toBe(
      'active',
    );
    const held = deferred<void>();
    const saving = deferred<void>();
    f.save.mockImplementationOnce(async () => {
      saving.resolve();
      await held.promise;
    });
    const queued = f.command({ type: 'renameWorkspace', name: 'held queue' });
    await saving.promise;
    const closing = f.command({ type: 'closeTab', tabId: tab.tabId });
    const save = f.app.saveMotaEditorFile(resource.resourceId, {
      sessionIndex: index,
      file: '_server/config.json',
      requestId: randomUUID(),
      expectedHash: null,
      content: '{}',
    });
    await expect(save).rejects.toThrow('revoked');
    expect(f.editorPorts.motaEditorRequest.mock.calls.some(([request]) => request.method === 'editor.stage')).toBe(false);
    held.resolve();
    expect((await queued).ok).toBe(true);
    expect((await closing).ok).toBe(true);
  });
  it('previews statically, then publishes one project with two stable independent resources', async () => {
    const f = await fixture();
    expect((await f.preview()).ok).toBe(true);
    const checked = await f.owner();
    expect(checked.appImport?.preview).toMatchObject({ profile: 'mota-web', fileCount: MOTA_REQUIRED_FILES.length });
    expect(checked.managedApp).toBeFalsy();
    expect(f.chat.appImportSource).not.toHaveBeenCalled();
    expect(f.chat.appStart).not.toHaveBeenCalled();
    expect(JSON.stringify(checked.appImport)).not.toContain(f.root);
    expect((await f.confirm()).ok).toBe(true);
    const space = await f.owner();
    const resources = space.resources.filter((r) => r.appProjectId === space.managedApp?.projectId);
    expect(resources).toHaveLength(2);
    expect(resources.map((r) => r.appPage).sort()).toEqual(['editor', 'game']);
    expect(new Set(resources.map((r) => r.resourceId)).size).toBe(2);
    expect(new Set(resources.map((r) => r.instanceId)).size).toBe(2);
    for (const resource of resources)
      expect(resource.url).toBe(resource.appPage === 'editor' ? 'wsl-editor://mota/index.html' : 'http://127.0.0.1:49152/index.html');
    expect(f.chat.appImportSource.mock.calls[0]?.[0]).toMatchObject({ profile: 'mota-web', projectId: space.managedApp?.projectId });
    expect(JSON.stringify(f.durable())).not.toMatch(/fixture source for|"base64":/);
    validateSnapshot(await f.app.getSnapshot());
  });
  it('repeated page opens only focus, and closing a view keeps its resource and running App', async () => {
    const f = await fixture();
    await f.imported();
    const initial = await f.owner();
    const editor = required(initial.resources.find((r) => r.appPage === 'editor'));
    expect((await f.command({ type: 'openAppPage', page: 'editor' })).ok).toBe(true);
    expect((await f.command({ type: 'openAppPage', page: 'editor' })).ok).toBe(true);
    let space = await f.owner();
    expect(space.tabs.filter((tab) => tab.targetRef.resourceId === editor.resourceId)).toHaveLength(1);
    expect(f.app.activeBrowserResourceId()).toBe(editor.resourceId);
    expect(f.browserAction).not.toHaveBeenCalled();
    const tab = required(space.tabs.find((item) => item.targetRef.resourceId === editor.resourceId));
    await f.command({ type: 'closeTab', tabId: tab.tabId });
    space = await f.owner();
    expect(space.managedApp?.state).toBe('running');
    expect(space.resources.find((r) => r.resourceId === editor.resourceId)?.instanceId).toBe(editor.instanceId);
    expect(f.chat.appStop).not.toHaveBeenCalled();
    expect((await f.command({ type: 'openAppPage', page: 'editor' })).ok).toBe(true);
    expect((await f.owner()).tabs.filter((item) => item.targetRef.resourceId === editor.resourceId)).toHaveLength(1);
    expect(f.browserAction).not.toHaveBeenCalled();
  });
  it('rebinds both roles on restart and rejects a late event from the old App instance', async () => {
    const f = await fixture();
    await f.imported();
    await f.command({ type: 'openAppPage', page: 'editor' });
    const before = await f.owner();
    const old = required(before.managedApp);
    expect((await f.command({ type: 'stopApp' })).ok).toBe(true);
    const stopped = await f.owner();
    expect(
      stopped.resources.filter((r) => r.appProjectId === old.projectId).every((r) => r.instanceId === null && r.preview === null),
    ).toBe(true);
    expect((await f.command({ type: 'startApp' })).ok).toBe(true);
    const restarted = await f.owner();
    for (const previous of before.resources.filter((r) => r.appProjectId === old.projectId)) {
      const resource = required(restarted.resources.find((r) => r.resourceId === previous.resourceId));
      expect(resource.appPage).toBe(previous.appPage);
      expect(resource.instanceId).not.toBe(previous.instanceId);
      expect(resource.generation).toBeGreaterThan(previous.generation);
      expect(resource.url).toBe(resource.appPage === 'editor' ? 'wsl-editor://mota/index.html' : 'http://127.0.0.1:49153/index.html');
      expect(f.release).toHaveBeenCalledWith(resource.resourceId);
    }
    f.emit({ ...old, state: 'stopped', url: null, cleanupConfirmed: true });
    expect((await f.owner()).managedApp?.appInstanceId).toBe(restarted.managedApp?.appInstanceId);
    expect((await f.owner()).resources.filter((r) => r.appProjectId === old.projectId).every((r) => r.instanceId !== null)).toBe(true);
    expect(f.app.activeBrowserResourceId()).toBe(before.resources.find((r) => r.appPage === 'editor')?.resourceId);
  });
  it('rejects source changes between preview and confirmation before any guest request', async () => {
    const f = await fixture();
    expect((await f.preview()).ok).toBe(true);
    await writeFile(path.join(f.root, 'project/floors/MT1.js'), 'changed after preview');
    expect((await f.confirm()).ok).toBe(false);
    expect((await f.owner()).appImport?.error?.code).toBe('source_changed');
    expect(f.chat.appImportSource).not.toHaveBeenCalled();
    expect(f.chat.appStart).not.toHaveBeenCalled();
  });
  it('cancels the checked preview without creating a project or calling the guest', async () => {
    const f = await fixture();
    expect((await f.preview()).ok).toBe(true);
    const checked = required((await f.owner()).appImport);
    expect((await f.command({ type: 'cancelAppImport', previewId: checked.previewId })).ok).toBe(true);
    const space = await f.owner();
    expect(space.appImport?.phase).toBe('cancelled');
    expect(space.managedApp).toBeFalsy();
    expect(space.resources.some((resource) => resource.appProjectId)).toBe(false);
    expect(f.chat.appImportSource).not.toHaveBeenCalled();
    expect(f.chat.appStart).not.toHaveBeenCalled();
    expect(f.chat.appCancelImport).not.toHaveBeenCalled();
  });
  it('requires explicit game permission and keeps standard control and old export unavailable', async () => {
    const f = await fixture();
    await f.imported();
    const space = await f.owner();
    const task = await f.command({
      type: 'confirmTask',
      sessionId: required(space.sessions[0]).sessionId,
      goal: 'play',
      targetRef: null,
      allowedScopes: [],
    });
    expect(task).toMatchObject({ ok: false, error: { code: 'denied', message: expect.stringContaining('允许 AI 操作游戏') } });
    const exported = await f.command({ type: 'exportApp' });
    expect(exported).toMatchObject({ ok: false, error: { code: 'unsupported', message: expect.stringContaining('暂不支持源码导出') } });
    expect(() => f.host.appUi(required(space.resources.find((r) => r.appPage === 'editor')).resourceId)).toThrow('不是当前运行');
    const gameUi = f.host.appUi(required(space.resources.find((r) => r.appPage === 'game')).resourceId);
    expect(() => gameUi.bridge({ op: 'describe' }, new AbortController().signal)).toThrow('禁止通用');
    expect(f.chat.send).not.toHaveBeenCalled();
    expect(f.chat.appExport).not.toHaveBeenCalled();
    expect((await f.command({ type: 'openAppPage', page: 'student' })).ok).toBe(false);
  });
  it('does not steal focus when an explicit restart finishes after a tab change', async () => {
    const f = await fixture();
    await f.imported();
    await f.command({ type: 'openAppPage', page: 'game' });
    await f.command({ type: 'stopApp' });
    const gate = deferred<ManagedApp>();
    f.chat.appStart.mockReturnValueOnce(gate.promise);
    const restarting = f.command({ type: 'startApp' });
    await vi.waitFor(() => expect(f.chat.appStart).toHaveBeenCalledTimes(2));
    const sessionTab = required((await f.owner()).tabs.find((tab) => tab.targetRef.kind === 'session'));
    await f.command({ type: 'activateTab', tabId: sessionTab.tabId });
    gate.resolve(await f.start());
    expect((await restarting).ok).toBe(true);
    expect(f.app.activeBrowserResourceId()).toBeNull();
    expect((await f.owner()).managedApp?.state).toBe('running');
  });
});

function modelConversation(id: string, state: ChatConversation['state'], seq = 1): ChatConversation {
  return {
    conversationId: id,
    state,
    seq,
    generation: 'mota-generation',
    turnId: 'mota-turn',
    threadId: null,
    messages: [],
    toolExecutions: [],
    warnings: [],
    error: null,
    cleanupPending: state === 'running',
  };
}
async function motaTaskFixture(scopes = [MOTA_PLAY_SCOPE]) {
  const f = await fixture();
  await f.imported();
  const space = await f.owner();
  const sessionId = required(space.sessions[0]).sessionId;
  const game = required(space.resources.find((r) => r.appPage === 'game'));
  const control = {
    ready: vi.fn(),
    hasPending: () => false,
    canRetryCleanup: () => false,
    isReconciling: () => false,
    releaseRun: vi.fn(),
    settleRun: vi.fn<() => Promise<void>>(async () => undefined),
    reconcileRun: vi.fn(),
    confirmStopped: vi.fn(),
  };
  f.app.setAppControl(control as unknown as AppControl);
  f.chat.send.mockImplementation(async (id) => modelConversation(id, 'running'));
  f.chat.cancel.mockImplementation(async (id) => modelConversation(id, 'cancelled', 10));
  f.chat.motaControl.mockImplementation(async (request) => {
    if (request.method !== 'release') throw new Error('unexpected test method');
    return {
      type: 'mota-control-result',
      requestId: request.requestId,
      binding: request.binding,
      method: 'release',
      ok: true,
      data: { settled: true },
    };
  });
  const confirm = (target = game.resourceId, allowedScopes = scopes) =>
    f.command({
      type: 'confirmTask',
      sessionId,
      targetRef: { kind: 'web', resourceId: target },
      goal: 'Use the game tools',
      allowedScopes,
    });
  const launch = async () => {
    expect((await confirm()).ok).toBe(true);
    const version = required((await f.owner()).sessions[0]?.taskVersions.at(-1));
    expect((await f.command({ type: 'startRun', sessionId, taskVersionId: version.taskVersionId })).ok).toBe(true);
    const scope = required(f.chat.send.mock.calls.at(-1)?.[2]);
    const run = required((await f.owner()).runs.at(-1));
    return { scope, run, version };
  };
  return { ...f, game, sessionId, control, confirm, launch };
}

describe('Mota confirmed game task ownership', () => {
  it('requires play scope and the game resource, freezing a game binding without DOM capture', async () => {
    const f = await motaTaskFixture();
    expect((await f.confirm(f.game.resourceId, [])).ok).toBe(false);
    expect((await f.confirm(required((await f.owner()).resources.find((r) => r.appPage === 'editor')).resourceId)).ok).toBe(false);
    const { run, version, scope } = await f.launch();
    expect(version.capture).toBeNull();
    expect(version.motaTask).toMatchObject({ resourceId: f.game.resourceId, documentGeneration: 0 });
    expect(run).toMatchObject({
      motaCleanupPending: true,
      sourceChange: { state: 'unavailable', reason: expect.stringContaining('独立操作回执') },
    });
    expect(f.chat.send.mock.calls[0]?.[5]).toEqual(run.motaTask);
    expect(f.chat.appSourceSnapshot).not.toHaveBeenCalled();
    expect(f.chat.send.mock.calls[0]?.[1]).not.toContain('/guest/owned-mota');
    expect(await f.app.appControlContext(scope)).toMatchObject({ browser: { resourceId: f.game.resourceId }, allowsMotaMapWrite: false });
  });
  it('rejects external refresh, but accepts only the explicit new-game document transition and leaves TaskVersion frozen', async () => {
    const f = await motaTaskFixture();
    const { run, scope, version } = await f.launch();
    const original = f.host.browserState(f.game.resourceId);
    vi.spyOn(f.host, 'browserState').mockImplementation((id) => ({
      ...original,
      page: { ...original.page, documentGeneration: id === f.game.resourceId ? 1 : 0 },
    }));
    await expect(f.app.appControlContext(scope)).rejects.toThrow('重新确认');
    await expect(f.app.motaDocumentChanged(required(run.motaTask), 7, 1)).rejects.toThrow('接续归属');
    await f.app.motaDocumentChanged(required(run.motaTask), 0, 1);
    expect(await f.app.appControlContext(scope)).toMatchObject({ motaTask: { documentGeneration: 0 } });
    expect((await f.owner()).runs.at(-1)?.motaDocumentGeneration).toBe(1);
    expect((await f.owner()).sessions[0]?.taskVersions.at(-1)).toEqual(version);
    await expect(f.app.motaDocumentChanged(required(run.motaTask), 0, 1)).rejects.toThrow('接续归属');
  });
  it('does not reuse an old confirmed version after an external refresh or an App restart', async () => {
    const f = await motaTaskFixture();
    expect((await f.confirm()).ok).toBe(true);
    const version = required((await f.owner()).sessions[0]?.taskVersions.at(-1));
    const original = f.host.browserState(f.game.resourceId);
    const spy = vi.spyOn(f.host, 'browserState').mockReturnValue({ ...original, page: { ...original.page, documentGeneration: 2 } });
    expect((await f.command({ type: 'startRun', sessionId: f.sessionId, taskVersionId: version.taskVersionId })).ok).toBe(false);
    spy.mockRestore();
    await f.command({ type: 'stopApp' });
    await f.command({ type: 'startApp' });
    expect((await f.command({ type: 'startRun', sessionId: f.sessionId, taskVersionId: version.taskVersionId })).ok).toBe(false);
    expect(f.chat.send).not.toHaveBeenCalled();
  });
  it('waits for native input cleanup before releasing the run lease, and preserves unknown cleanup', async () => {
    const f = await motaTaskFixture();
    const { run } = await f.launch();
    const native = deferred<void>();
    f.control.settleRun.mockReturnValue(native.promise);
    f.chat.motaControl.mockRejectedValueOnce(new Error('lost lease reply'));
    f.app.onConversation(modelConversation(f.sessionId, 'idle', 3));
    await vi.waitFor(() => expect(f.control.settleRun).toHaveBeenCalledWith(run.runId));
    expect(f.chat.motaControl).not.toHaveBeenCalled();
    native.resolve();
    await vi.waitFor(async () =>
      expect((await f.owner()).runs.at(-1)).toMatchObject({ state: 'cancelling', motaCleanupPending: true, cleanupRetryAvailable: true }),
    );
    expect(f.durable()?.workspaces[0]?.runs.at(-1)?.motaCleanupPending).toBe(true);
  });
  it('requires map scope independently and persists the operation before dispatch and its exact receipt after', async () => {
    const f = await motaTaskFixture([MOTA_PLAY_SCOPE, MOTA_MAP_WRITE_SCOPE]);
    const { run } = await f.launch();
    const operationId = randomUUID();
    const request: MotaControlRequest = {
      type: 'mota-control',
      requestId: randomUUID(),
      binding: required(run.motaTask),
      method: 'map.set',
      input: { operationId, expectedSha256: 'a'.repeat(64), x: 6, y: 10 },
    };
    f.chat.motaControl.mockImplementationOnce(async (input) => {
      expect(f.durable()?.workspaces[0]?.runs.at(-1)?.motaMapOperations).toEqual([{ operationId, receipt: null }]);
      return {
        type: 'mota-control-result',
        requestId: input.requestId,
        binding: input.binding,
        method: 'map.set',
        ok: true,
        data: {
          operationId,
          floorId: 'MT1',
          beforeSha256: 'a'.repeat(64),
          afterSha256: 'b'.repeat(64),
          change: { x: 6, y: 10, before: 0, after: 53 },
        },
      };
    });
    expect((await f.app.motaControlForRun(request, new AbortController().signal)).ok).toBe(true);
    expect(f.durable()?.workspaces[0]?.runs.at(-1)?.motaMapOperations?.[0]?.receipt?.afterSha256).toBe('b'.repeat(64));
    const noWrite = await motaTaskFixture();
    const second = await noWrite.launch();
    await expect(
      noWrite.app.motaControlForRun({ ...request, binding: required(second.run.motaTask) }, new AbortController().signal),
    ).rejects.toThrow('未授予地图');
    expect(noWrite.chat.motaControl).not.toHaveBeenCalled();
  });
  it('revalidates the document after persistence and sends no map write after navigation', async () => {
    const f = await motaTaskFixture([MOTA_PLAY_SCOPE, MOTA_MAP_WRITE_SCOPE]);
    const { run } = await f.launch();
    const gate = deferred<void>();
    const originalSave = required(f.save.getMockImplementation());
    f.save.mockImplementationOnce(async (snapshot) => {
      await gate.promise;
      await originalSave(snapshot);
    });
    const request: MotaControlRequest = {
      type: 'mota-control',
      requestId: randomUUID(),
      binding: required(run.motaTask),
      method: 'map.set',
      input: { operationId: randomUUID(), expectedSha256: 'a'.repeat(64), x: 6, y: 10 },
    };
    const before = f.save.mock.calls.length;
    const pending = f.app.motaControlForRun(request, new AbortController().signal);
    const rejected = expect(pending).rejects.toThrow('重新确认');
    await vi.waitFor(() => expect(f.save.mock.calls.length).toBeGreaterThan(before));
    const page = f.host.browserState(f.game.resourceId);
    vi.spyOn(f.host, 'browserState').mockReturnValue({ ...page, page: { ...page.page, documentGeneration: 1 } });
    gate.resolve();
    await rejected;
    expect(f.chat.motaControl).not.toHaveBeenCalled();
    expect((await f.owner()).runs.at(-1)?.motaMapOperations?.[0]?.error).toContain('未派发');
  });
  it('keeps an unknown map operation locked and never replays it or releases its lease', async () => {
    const f = await motaTaskFixture([MOTA_PLAY_SCOPE, MOTA_MAP_WRITE_SCOPE]);
    const { run } = await f.launch();
    const operationId = randomUUID();
    const request: MotaControlRequest = {
      type: 'mota-control',
      requestId: randomUUID(),
      binding: required(run.motaTask),
      method: 'map.set',
      input: { operationId, expectedSha256: 'a'.repeat(64), x: 6, y: 10 },
    };
    f.chat.motaControl.mockRejectedValueOnce(new Error('lost applied receipt'));
    await expect(f.app.motaControlForRun(request, new AbortController().signal)).rejects.toThrow('lost applied');
    f.chat.motaControl.mockImplementation(async (input) => {
      if (input.method !== 'operation.read') throw new Error('must not release or replay');
      return {
        type: 'mota-control-result',
        requestId: input.requestId,
        binding: input.binding,
        method: 'operation.read',
        ok: true,
        data: { operationId, status: 'unknown', receipt: null },
      };
    });
    f.app.onConversation(modelConversation(f.sessionId, 'idle', 3));
    await vi.waitFor(async () =>
      expect((await f.owner()).runs.at(-1)).toMatchObject({
        state: 'cancelling',
        motaCleanupPending: true,
        cleanupRetryAvailable: true,
        error: expect.stringContaining(operationId),
      }),
    );
    expect(f.chat.motaControl.mock.calls.map(([input]) => input.method)).toEqual(['map.set', 'operation.read']);
    expect((await f.command({ type: 'stopApp' })).ok).toBe(false);
    expect(f.chat.appStop).not.toHaveBeenCalled();
    expect((await f.confirm()).ok).toBe(true);
    const blockedVersion = required((await f.owner()).sessions[0]?.taskVersions.at(-1));
    expect((await f.command({ type: 'startRun', sessionId: f.sessionId, taskVersionId: blockedVersion.taskVersionId })).ok).toBe(false);
  });
  it('stops a running game only after its native inputs, lease and model have settled', async () => {
    const f = await motaTaskFixture();
    await f.launch();
    const native = deferred<void>();
    f.control.settleRun.mockReturnValue(native.promise);
    const stopping = f.command({ type: 'stopApp' });
    await vi.waitFor(() => expect(f.control.settleRun).toHaveBeenCalledOnce());
    expect(f.chat.appStop).not.toHaveBeenCalled();
    native.resolve();
    const stopped = await stopping;
    expect(stopped.ok ? null : stopped.error).toBeNull();
    expect(f.chat.cancel).toHaveBeenCalledOnce();
    expect(f.chat.motaControl.mock.calls.map(([input]) => input.method)).toEqual(['release']);
    expect((await f.owner()).runs.at(-1)).toMatchObject({ state: 'cancelled', motaCleanupPending: false, cleanupPending: false });
  });
  it.each([
    { request: 'cancelRun', cleanupOrder: 'model-first' },
    { request: 'cancelRun', cleanupOrder: 'lease-first' },
    { request: 'stopApp', cleanupOrder: 'model-first' },
    { request: 'stopApp', cleanupOrder: 'lease-first' },
  ] as const)('preserves policy_violation failure after $request with $cleanupOrder cleanup', async ({ request, cleanupOrder }) => {
    const f = await motaTaskFixture();
    const { run } = await f.launch();
    const policyError = 'policy_violation: Mota run emitted forbidden native tool command_execution';
    const failed = { ...modelConversation(f.sessionId, 'failed', 3), error: policyError };
    const native = deferred<void>();
    const model = deferred<ChatConversation>();
    f.control.settleRun.mockReturnValue(native.promise);
    f.chat.cancel.mockReturnValue(model.promise);
    f.app.onConversation({ ...failed, seq: 2, cleanupPending: true });
    await vi.waitFor(async () =>
      expect((await f.owner()).runs.at(-1)).toMatchObject({
        state: 'cancelling',
        executorState: { state: 'failed', cleanupPending: true },
        motaCleanupPending: true,
        cleanupPending: true,
        error: policyError,
        endedAt: null,
      }),
    );
    expect(f.control.settleRun).not.toHaveBeenCalled();
    const requested = f.command(request === 'cancelRun' ? { type: request, runId: run.runId } : { type: request });
    await vi.waitFor(() => expect(f.control.settleRun).toHaveBeenCalledWith(run.runId));
    await vi.waitFor(() => expect(f.chat.cancel).toHaveBeenCalledWith(f.sessionId));
    expect(f.chat.motaControl).not.toHaveBeenCalled();
    expect(f.control.releaseRun).not.toHaveBeenCalled();
    expect(f.chat.appStop).not.toHaveBeenCalled();
    if (cleanupOrder === 'model-first') {
      model.resolve(failed);
      await vi.waitFor(async () =>
        expect((await f.owner()).runs.at(-1)).toMatchObject({
          state: 'cancelling',
          executorState: { state: 'failed', cleanupPending: false },
          motaCleanupPending: true,
          cleanupPending: true,
          error: policyError,
          endedAt: null,
        }),
      );
      expect(f.chat.motaControl).not.toHaveBeenCalled();
      native.resolve();
    } else {
      native.resolve();
      await vi.waitFor(async () =>
        expect((await f.owner()).runs.at(-1)).toMatchObject({
          state: 'cancelling',
          executorState: { state: 'failed', cleanupPending: true },
          motaCleanupPending: false,
          cleanupPending: true,
          error: policyError,
          endedAt: null,
        }),
      );
      expect(f.control.releaseRun).not.toHaveBeenCalled();
      expect(f.chat.appStop).not.toHaveBeenCalled();
      model.resolve(failed);
    }
    expect((await requested).ok).toBe(true);
    await vi.waitFor(async () => expect((await f.owner()).runs.at(-1)?.cleanupPending).toBe(false));
    expect((await f.owner()).runs.at(-1)).toMatchObject({
      state: 'failed',
      executorState: { state: 'failed', cleanupPending: false },
      motaCancelRequested: true,
      motaCleanupPending: false,
      cleanupPending: false,
      error: policyError,
      endedAt: expect.any(String),
    });
    expect(f.durable()?.workspaces[0]?.runs.at(-1)?.state).toBe('failed');
    expect(f.chat.motaControl.mock.calls.map(([input]) => input.method)).toEqual(['release']);
    expect(f.control.releaseRun).toHaveBeenCalledWith(run.runId);
    expect(f.chat.appStop).toHaveBeenCalledTimes(request === 'stopApp' ? 1 : 0);
  });
  it('retains policy_violation and release failure while blocking controls, then retries without losing map receipts', async () => {
    const f = await motaTaskFixture([MOTA_PLAY_SCOPE, MOTA_MAP_WRITE_SCOPE]);
    const { run, scope, version } = await f.launch();
    const release = required(f.chat.motaControl.getMockImplementation());
    const receipt = {
      operationId: randomUUID(),
      floorId: 'MT1',
      beforeSha256: 'a'.repeat(64),
      afterSha256: 'b'.repeat(64),
      change: { x: 6, y: 10, before: 0, after: 53 },
    } as const;
    const request: MotaControlRequest = {
      type: 'mota-control',
      requestId: randomUUID(),
      binding: required(run.motaTask),
      method: 'map.set',
      input: { operationId: receipt.operationId, expectedSha256: receipt.beforeSha256, x: 6, y: 10 },
    };
    f.chat.motaControl.mockImplementationOnce(async (input) => ({
      type: 'mota-control-result',
      requestId: input.requestId,
      binding: input.binding,
      method: 'map.set',
      ok: true,
      data: receipt,
    }));
    expect((await f.app.motaControlForRun(request, new AbortController().signal)).ok).toBe(true);
    const operations = [{ operationId: receipt.operationId, receipt }];
    expect(f.durable()?.workspaces[0]?.runs.at(-1)?.motaMapOperations).toEqual(operations);
    const policyError = 'policy_violation: Mota run emitted forbidden native tool command_execution';
    const cleanupError = 'lost lease release acknowledgement';
    const native = deferred<void>();
    f.control.settleRun.mockReturnValue(native.promise);
    f.chat.motaControl.mockRejectedValue(new Error(cleanupError));
    f.app.onConversation({ ...modelConversation(f.sessionId, 'failed', 3), error: policyError });
    await vi.waitFor(() => expect(f.control.settleRun).toHaveBeenCalledWith(run.runId));
    expect(f.chat.motaControl.mock.calls.map(([input]) => input.method)).toEqual(['map.set']);
    native.resolve();
    await vi.waitFor(async () => expect((await f.owner()).runs.at(-1)?.cleanupRetryAvailable).toBe(true));
    const blocked = required((await f.owner()).runs.at(-1));
    expect(blocked).toMatchObject({
      state: 'cancelling',
      executorState: { state: 'failed', cleanupPending: false },
      motaCleanupPending: true,
      cleanupPending: true,
      endedAt: null,
      motaMapOperations: operations,
    });
    expect(blocked.error).toContain(policyError);
    expect(blocked.error).toContain(cleanupError);
    expect(f.durable()?.workspaces[0]?.runs.at(-1)?.error).toBe(blocked.error);
    expect(f.control.releaseRun).not.toHaveBeenCalled();
    await expect(f.app.appControlContext(scope)).rejects.toThrow('控制面不可用');
    expect((await f.command({ type: 'stopApp' })).ok).toBe(false);
    expect((await f.command({ type: 'startApp' })).ok).toBe(false);
    expect((await f.command({ type: 'startRun', sessionId: f.sessionId, taskVersionId: version.taskVersionId })).ok).toBe(false);
    expect(f.chat.appStop).not.toHaveBeenCalled();
    expect(f.chat.appStart).toHaveBeenCalledOnce();
    expect(f.chat.send).toHaveBeenCalledOnce();
    expect(f.chat.cancel).not.toHaveBeenCalled();
    const stillBlocked = required((await f.owner()).runs.at(-1));
    expect(stillBlocked).toMatchObject({
      motaCancelRequested: true,
      motaCleanupPending: true,
      cleanupPending: true,
      cleanupRetryAvailable: true,
      motaMapOperations: operations,
    });
    expect(stillBlocked.error).toContain(policyError);
    expect(stillBlocked.error).toContain(cleanupError);
    expect(f.control.releaseRun).not.toHaveBeenCalled();
    f.chat.motaControl.mockImplementation(release);
    expect((await f.command({ type: 'reconcileRunCleanup', runId: run.runId })).ok).toBe(true);
    expect((await f.owner()).runs.at(-1)).toMatchObject({
      state: 'failed',
      executorState: { state: 'failed', cleanupPending: false },
      motaCancelRequested: true,
      motaCleanupPending: false,
      cleanupPending: false,
      cleanupRetryAvailable: false,
      error: expect.stringContaining(policyError),
      endedAt: expect.any(String),
      motaMapOperations: operations,
    });
    expect(f.durable()?.workspaces[0]?.runs.at(-1)).toMatchObject({ state: 'failed', motaMapOperations: operations });
    expect(f.chat.motaControl.mock.calls.map(([input]) => input.method)).toEqual(['map.set', 'release', 'release', 'release']);
    expect(f.chat.motaControl.mock.calls.every(([input]) => input.binding.runId === run.runId)).toBe(true);
    expect(f.control.releaseRun).toHaveBeenCalledWith(run.runId);
    expect(f.chat.appStop).not.toHaveBeenCalled();
  });
  it('retains policy_violation when explicit model cancellation rejects before cleanup confirmation', async () => {
    const f = await motaTaskFixture();
    const { run, scope } = await f.launch();
    const policyError = 'policy_violation: Mota run emitted forbidden native tool command_execution';
    const cleanupError = 'model process cleanup acknowledgement lost';
    const native = deferred<void>();
    f.control.settleRun.mockReturnValue(native.promise);
    f.chat.cancel.mockRejectedValue(new Error(cleanupError));
    f.app.onConversation({ ...modelConversation(f.sessionId, 'failed', 2), error: policyError, cleanupPending: true });
    await vi.waitFor(async () => expect((await f.owner()).runs.at(-1)?.executorState).toEqual({ state: 'failed', cleanupPending: true }));
    expect((await f.command({ type: 'cancelRun', runId: run.runId })).ok).toBe(true);
    await vi.waitFor(async () => expect((await f.owner()).runs.at(-1)?.error).toContain(cleanupError));
    const pending = required((await f.owner()).runs.at(-1));
    expect(pending).toMatchObject({
      state: 'cancelling',
      executorState: { state: 'failed', cleanupPending: true },
      motaCleanupPending: true,
      cleanupPending: true,
      endedAt: null,
    });
    expect(pending.error).toContain(policyError);
    expect(f.durable()?.workspaces[0]?.runs.at(-1)?.error).toBe(pending.error);
    await expect(f.app.appControlContext(scope)).rejects.toThrow('控制面不可用');
    expect(f.control.releaseRun).not.toHaveBeenCalled();
    native.resolve();
    await vi.waitFor(async () => expect((await f.owner()).runs.at(-1)?.motaCleanupPending).toBe(false));
    expect((await f.owner()).runs.at(-1)).toMatchObject({
      state: 'cancelling',
      executorState: { state: 'failed', cleanupPending: true },
      cleanupPending: true,
      error: pending.error,
      endedAt: null,
    });
    expect(f.control.releaseRun).not.toHaveBeenCalled();
    f.app.onConversation({ ...modelConversation(f.sessionId, 'failed', 3), error: policyError });
    await vi.waitFor(async () => expect((await f.owner()).runs.at(-1)?.cleanupPending).toBe(false));
    expect((await f.owner()).runs.at(-1)).toMatchObject({
      state: 'failed',
      executorState: { state: 'failed', cleanupPending: false },
      error: policyError,
      motaCleanupPending: false,
    });
    expect(f.chat.motaControl.mock.calls.map(([input]) => input.method)).toEqual(['release']);
    expect(f.control.releaseRun).toHaveBeenCalledWith(run.runId);
  });
  it('retains policy_violation in repeated App cleanup diagnostics until model cleanup is confirmed', async () => {
    const f = await motaTaskFixture();
    const { run, scope } = await f.launch();
    const policyError = 'policy_violation: Mota run emitted forbidden native tool command_execution';
    const native = deferred<void>();
    f.control.settleRun.mockReturnValue(native.promise);
    f.chat.cancel.mockResolvedValue({ ...modelConversation(f.sessionId, 'failed', 3), error: policyError });
    f.app.onConversation({ ...modelConversation(f.sessionId, 'failed', 2), error: policyError, cleanupPending: true });
    await vi.waitFor(async () => expect((await f.owner()).runs.at(-1)?.executorState).toEqual({ state: 'failed', cleanupPending: true }));
    f.app.onAppCleanupChanged(scope.workspaceId, run.runId);
    await vi.waitFor(async () => expect((await f.owner()).runs.at(-1)?.error).toContain('模型进程清理未确认'));
    const pending = required((await f.owner()).runs.at(-1));
    expect(pending).toMatchObject({
      state: 'cancelling',
      executorState: { state: 'failed', cleanupPending: true },
      motaCleanupPending: true,
      cleanupPending: true,
      endedAt: null,
      conversation: { error: pending.error },
    });
    expect(pending.error).toContain(policyError);
    expect((await f.owner()).sessions.find((session) => session.sessionId === f.sessionId)?.conversation?.error).toBe(pending.error);
    expect(f.durable()?.workspaces[0]?.runs.at(-1)?.error).toBe(pending.error);
    f.app.onAppCleanupChanged(scope.workspaceId, run.runId);
    expect((await f.owner()).runs.at(-1)?.error).toBe(pending.error);
    await expect(f.app.appControlContext(scope)).rejects.toThrow('控制面不可用');
    expect(f.control.releaseRun).not.toHaveBeenCalled();
    expect((await f.command({ type: 'cancelRun', runId: run.runId })).ok).toBe(true);
    await vi.waitFor(async () =>
      expect((await f.owner()).runs.at(-1)).toMatchObject({
        executorState: { state: 'failed', cleanupPending: false },
        motaCleanupPending: true,
        cleanupPending: true,
      }),
    );
    native.resolve();
    await vi.waitFor(async () => expect((await f.owner()).runs.at(-1)?.cleanupPending).toBe(false));
    expect((await f.owner()).runs.at(-1)).toMatchObject({ state: 'failed', error: policyError, motaCleanupPending: false });
    expect(f.chat.motaControl.mock.calls.map(([input]) => input.method)).toEqual(['release']);
    expect(f.control.releaseRun).toHaveBeenCalledWith(run.runId);
  });
  it.each([
    { state: 'cancelled', error: null },
    { state: 'failed', error: 'model transport failed during cancellation' },
  ] as const)('keeps intentional cancellation cancelled for a non-policy $state receipt', async ({ state, error }) => {
    const f = await motaTaskFixture();
    const { run } = await f.launch();
    const native = deferred<void>();
    f.control.settleRun.mockReturnValue(native.promise);
    f.chat.cancel.mockResolvedValue({ ...modelConversation(f.sessionId, state, 10), error });
    expect((await f.command({ type: 'cancelRun', runId: run.runId })).ok).toBe(true);
    await vi.waitFor(async () =>
      expect((await f.owner()).runs.at(-1)).toMatchObject({
        state: 'cancelling',
        executorState: { state, cleanupPending: false },
        motaCleanupPending: true,
      }),
    );
    native.resolve();
    await vi.waitFor(async () => expect((await f.owner()).runs.at(-1)?.cleanupPending).toBe(false));
    expect((await f.owner()).runs.at(-1)).toMatchObject({
      state: 'cancelled',
      motaCleanupPending: false,
      cleanupPending: false,
      error,
    });
  });
  it('ignores late success for the same execution binding after a policy_violation terminal failure', async () => {
    const f = await motaTaskFixture();
    const { run } = await f.launch();
    const policyError = 'policy_violation: Mota run emitted forbidden native tool command_execution';
    f.app.onConversation({ ...modelConversation(f.sessionId, 'failed', 3), error: policyError });
    await vi.waitFor(async () => expect((await f.owner()).runs.at(-1)?.cleanupPending).toBe(false));
    const before = await f.owner();
    const failed = required(before.runs.at(-1));
    const conversation = required(before.sessions.find((session) => session.sessionId === f.sessionId)).conversation;
    expect(failed).toMatchObject({ state: 'failed', error: policyError, motaCleanupPending: false });
    const success = modelConversation(f.sessionId, 'idle', 100);
    expect(failed.executionBinding).toEqual({ generation: success.generation, turnId: success.turnId });
    f.app.onConversation(success);
    const after = await f.owner();
    expect(after.runs.at(-1)).toEqual(failed);
    expect(after.sessions.find((session) => session.sessionId === f.sessionId)?.conversation).toEqual(conversation);
    expect(f.durable()?.workspaces[0]?.runs.at(-1)?.state).toBe('failed');
    expect(f.chat.motaControl.mock.calls.map(([input]) => input.method)).toEqual(['release']);
    expect(f.control.releaseRun).toHaveBeenCalledWith(run.runId);
  });
  it('allows two authorized new games, then requires a new confirmation for the next run', async () => {
    const f = await motaTaskFixture();
    const { run, scope, version } = await f.launch();
    const original = f.host.browserState(f.game.resourceId);
    let generation = 1;
    vi.spyOn(f.host, 'browserState').mockImplementation(() => ({
      ...original,
      page: { ...original.page, documentGeneration: generation },
    }));
    await f.app.motaDocumentChanged(required(run.motaTask), 0, 1);
    generation = 2;
    await f.app.motaDocumentChanged(required(run.motaTask), 1, 2);
    expect(await f.app.appControlContext(scope)).toMatchObject({ runId: run.runId });
    f.app.onConversation(modelConversation(f.sessionId, 'idle', 3));
    await vi.waitFor(async () => expect((await f.owner()).runs.at(-1)?.state).toBe('completed'));
    expect((await f.command({ type: 'startRun', sessionId: f.sessionId, taskVersionId: version.taskVersionId })).ok).toBe(false);
    expect((await f.confirm()).ok).toBe(true);
    expect((await f.owner()).sessions[0]?.taskVersions.at(-1)?.motaTask?.documentGeneration).toBe(2);
  });
  it('preserves unresolved Mota ownership across restart without replaying actions', async () => {
    const f = await motaTaskFixture();
    await f.launch();
    f.chat.motaControl.mockRejectedValue(new Error('transport disconnected'));
    f.app.onConversation(modelConversation(f.sessionId, 'idle', 3));
    await vi.waitFor(async () => expect((await f.owner()).runs.at(-1)?.cleanupRetryAvailable).toBe(true));
    const saved = required(f.durable());
    const priorCalls = f.chat.motaControl.mock.calls.length;
    const restored = new WorkbenchApplication(
      {
        migrationPending: false,
        load: async () => saved,
        loadCatalog: catalogForTestSnapshot,
        save: async () => undefined,
        appendObservation: async () => '',
      },
      f.host,
      vi.fn(),
      { ports: f.editorPorts, store: { load: async () => [], save: async () => undefined } },
    );
    const snapshot = await restored.getSnapshot();
    expect(snapshot.workspaces[0]?.runs.at(-1)).toMatchObject({
      motaCleanupPending: true,
      cleanupPending: true,
      cleanupRetryAvailable: true,
      state: 'cancelling',
    });
    expect(f.chat.motaControl).toHaveBeenCalledTimes(priorCalls);
    expect(f.chat.send).toHaveBeenCalledOnce();
  });
  it('releases a typed pre-model rejection without inventing a model cleanup obligation', async () => {
    const f = await motaTaskFixture();
    f.chat.send.mockRejectedValueOnce(new RunDispatchFailure('trusted pre-model rejection', false, false));
    expect((await f.confirm()).ok).toBe(true);
    const version = required((await f.owner()).sessions[0]?.taskVersions.at(-1));
    await f.command({ type: 'startRun', sessionId: f.sessionId, taskVersionId: version.taskVersionId });
    await vi.waitFor(async () =>
      expect((await f.owner()).runs.at(-1)).toMatchObject({
        state: 'failed',
        cleanupPending: false,
        motaCleanupPending: false,
        error: 'trusted pre-model rejection',
      }),
    );
    expect(f.chat.cancel).not.toHaveBeenCalled();
    expect(f.chat.motaControl.mock.calls.map(([input]) => input.method)).toEqual(['release']);
  });
  it('does not accept a release acknowledgement for another request or binding', async () => {
    const f = await motaTaskFixture();
    await f.launch();
    f.chat.motaControl.mockImplementationOnce(async (request) => ({
      type: 'mota-control-result',
      requestId: randomUUID(),
      binding: request.binding,
      method: 'release',
      ok: true,
      data: { settled: true },
    }));
    f.app.onConversation(modelConversation(f.sessionId, 'idle', 3));
    await vi.waitFor(async () =>
      expect((await f.owner()).runs.at(-1)).toMatchObject({
        state: 'cancelling',
        motaCleanupPending: true,
        cleanupPending: true,
        error: expect.stringContaining('回执归属不匹配'),
      }),
    );
  });
});
