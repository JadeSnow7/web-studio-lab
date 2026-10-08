import { describe, expect, it, vi } from 'vitest';
import type { PreviewState, WorkbenchCommand, WorkbenchSnapshot } from '@wsl/protocol';
import { WorkbenchApplication } from './application';
import { WorkbenchHost } from './host';
import type { BrowserWindow } from 'electron';
import type { ChatService } from '../chat-service';
vi.mock('electron', () => ({
  session: { fromPartition: () => ({ setPermissionRequestHandler: vi.fn(), setPermissionCheckHandler: vi.fn() }) },
}));
vi.mock('../preview/demo-protocol', () => ({ DEMO_ORIGIN: 'wsl-demo://taskflow', installDemoProtocol: vi.fn() }));
const browsers = vi.hoisted(() => ({ reloads: [] as Array<ReturnType<typeof vi.fn>> }));
vi.mock('../preview/controller', () => ({
  PreviewController: class {
    reload = vi.fn();
    openDevTools = vi.fn();
    setLayout = vi.fn();
    load = vi.fn();
    constructor() {
      browsers.reloads.push(this.reload);
    }
    getState = () => ({
      page: { webContentsId: 1, documentGeneration: 0, url: 'wsl-demo://taskflow/', title: '', partition: 'fixture' },
      loading: false,
      picking: false,
    });
  },
}));
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
  const runtime = {
    publicResourcesList: vi.fn().mockResolvedValue({ spaceId: 'taskflow-demo', revision: 0, resources: [] }),
    ensureBrowser: vi.fn(),
    browserState: () => state,
    browserLayout: vi.fn(),
    browserAction: vi.fn(),
    hideBrowsers: vi.fn(),
    validateBrowserUrl: vi.fn(),
  } as unknown as WorkbenchRuntime;
  const app = new WorkbenchApplication(
    {
      load: async () => saved,
      save: async (snapshot) => {
        saved = structuredClone(snapshot);
      },
    },
    runtime,
    vi.fn(),
  );
  await app.getSnapshot();
  const command = (payload: Record<string, unknown>) =>
    app.command({ commandId: crypto.randomUUID(), workspaceId: 'taskflow-demo', ...payload } as WorkbenchCommand);
  return { app, runtime, command };
}
describe('migration review followup baseline', () => {
  it('R6 reload returns local snapshot while public resource refresh stays pending', async () => {
    const { app, runtime } = await setup();
    await new Promise((resolve) => setTimeout(resolve, 0));
    vi.mocked(runtime.publicResourcesList).mockImplementation(() => new Promise(() => {}));
    const result = await Promise.race([app.retryInitialization(), new Promise<null>((resolve) => setTimeout(() => resolve(null), 50))]);
    expect(result?.activeWorkspaceId).toBe('taskflow-demo');
  });
  it('R3 reloads the just-focused native browser without an intervening snapshot drain', async () => {
    browsers.reloads.length = 0;
    const host = new WorkbenchHost(
      {} as BrowserWindow,
      { resourcesList: async () => ({ spaceId: 'taskflow-demo', revision: 0, resources: [] }) } as unknown as ChatService,
      '/fixture',
    );
    const app = new WorkbenchApplication({ load: async () => null, save: async () => {} }, host, vi.fn());
    host.application = app;
    const command = (payload: Record<string, unknown>) =>
      app.command({ commandId: crypto.randomUUID(), workspaceId: 'taskflow-demo', ...payload } as WorkbenchCommand);
    await app.getSnapshot();
    const w = (await app.getSnapshot()).workspaces[0]!;
    const first = w.tabs.find((t) => t.targetRef.kind === 'web')!;
    await command({ type: 'createTab', kind: 'web', title: 'second', url: 'wsl-demo://taskflow/' });
    const second = (await app.getSnapshot()).workspaces[0]!.resources.find(
      (r) => r.kind === 'web' && r.resourceId !== first.targetRef.resourceId,
    )!;
    await command({
      type: 'browserLayout',
      resourceId: second.resourceId,
      layout: { bounds: { x: 100, y: 0, width: 100, height: 100 }, visible: true },
    });
    await command({ type: 'splitPane', paneId: w.activePaneId, direction: 'horizontal', tabId: first.tabId });
    await command({
      type: 'browserLayout',
      resourceId: first.targetRef.resourceId,
      layout: { bounds: { x: 0, y: 0, width: 100, height: 100 }, visible: true },
    });
    const snapshot = (await app.getSnapshot()).workspaces[0]!;
    const r = snapshot.resources.find((r) => r.resourceId === first.targetRef.resourceId)!;
    const otherPane = snapshot.layout.kind === 'split' && snapshot.layout.first.kind === 'pane' ? snapshot.layout.first.paneId : '';
    await command({ type: 'focusPane', paneId: otherPane });
    expect(app.activeBrowserResourceId()).not.toBe(r.resourceId);
    app.onBrowserFocus(w.workspaceId, r.resourceId, r.instanceId, r.generation);
    await host.reload();
    expect(browsers.reloads[1]).toHaveBeenCalledOnce();
    expect(browsers.reloads[0]).not.toHaveBeenCalled();
  });
});
