import { describe, expect, it, vi, beforeEach } from 'vitest';
import type { BrowserWindow } from 'electron';
import type { WorkbenchResource } from '@wsl/protocol';
import type { ChatService } from '../chat-service';
import type { WorkbenchApplication } from './application';

const mocks = vi.hoisted(() => ({
  controllers: [] as Array<{
    options: Record<string, unknown>;
    reload: ReturnType<typeof vi.fn>;
    openDevTools: ReturnType<typeof vi.fn>;
    dispose: ReturnType<typeof vi.fn>;
    setLayout: ReturnType<typeof vi.fn>;
    captureResource: ReturnType<typeof vi.fn>;
  }>,
  appendObservation: vi.fn(async () => crypto.randomUUID()),
  load: vi.fn(),
  page: { webContentsId: 42, documentGeneration: 1, url: 'https://example.com/', title: 'fixture', partition: 'fixture' },
}));
vi.mock('electron', () => ({
  session: { fromPartition: () => ({ setPermissionRequestHandler: vi.fn(), setPermissionCheckHandler: vi.fn() }) },
}));
vi.mock('../preview/demo-protocol', () => ({ DEMO_ORIGIN: 'wsl-demo://taskflow', installDemoProtocol: vi.fn() }));
vi.mock('../preview/controller', () => ({
  PreviewController: class {
    reload = vi.fn();
    openDevTools = vi.fn();
    dispose = vi.fn();
    setLayout = vi.fn();
    getState = () => ({ page: mocks.page });
    captureResource = vi.fn();
    constructor(
      _window: unknown,
      readonly options: Record<string, unknown>,
    ) {
      mocks.controllers.push(this);
    }
    load() {
      mocks.load();
    }
  },
}));
import { WorkbenchHost } from './host';
const resource = (id: string): WorkbenchResource => ({
  resourceId: id,
  kind: 'web',
  environmentId: 'local',
  title: id,
  url: 'wsl-demo://taskflow/',
  instanceId: id + '-instance',
  generation: 1,
  preview: null,
  terminal: null,
  unavailableReason: null,
});
beforeEach(() => {
  mocks.controllers.length = 0;
  mocks.load.mockReset();
});
describe('R3/R5 native host migration baseline', () => {
  it('resolves menu reload/devtools from active pane instead of the last layout', async () => {
    const host = new WorkbenchHost({} as BrowserWindow, { setAppListener: vi.fn() } as unknown as ChatService, '/fixture');
    const activeBrowserResourceId = vi.fn((): string | null => 'a');
    host.application = {
      activeBrowserResourceId,
      performActiveBrowserAction: async (action: string) => {
        const id = activeBrowserResourceId();
        if (id) await host.browserAction(id, action);
      },
    } as unknown as WorkbenchApplication;
    host.ensureBrowser('w', resource('a'));
    host.ensureBrowser('w', resource('b'));
    const layout = { bounds: { x: 0, y: 0, width: 100, height: 100 }, visible: true };
    host.browserLayout('a', layout);
    host.browserLayout('b', layout);
    await host.reload();
    await host.openDevTools();
    expect(mocks.controllers[0]!.reload).toHaveBeenCalledOnce();
    expect(mocks.controllers[0]!.openDevTools).toHaveBeenCalledOnce();
    activeBrowserResourceId.mockReturnValue(null);
    await host.reload();
    await host.openDevTools();
    expect(mocks.controllers[1]!.reload).not.toHaveBeenCalled();
  });
  it('forwards focus with immutable workspace/resource/instance/generation ownership', () => {
    const host = new WorkbenchHost({} as BrowserWindow, { setAppListener: vi.fn() } as unknown as ChatService, '/fixture');
    const onBrowserFocus = vi.fn();
    host.application = { onBrowserFocus } as unknown as WorkbenchApplication;
    const r = resource('a');
    host.ensureBrowser('w', r);
    const onFocused = mocks.controllers[0]!.options.onFocused as (() => void) | undefined;
    expect(onFocused).toBeTypeOf('function');
    r.instanceId = 'replacement';
    r.generation = 2;
    onFocused!();
    expect(onBrowserFocus).toHaveBeenCalledWith('w', 'a', 'a-instance', 1);
  });
  it('disposes and removes a controller if initial loading throws, then permits retry', () => {
    const host = new WorkbenchHost({} as BrowserWindow, { setAppListener: vi.fn() } as unknown as ChatService, '/fixture');
    mocks.load.mockImplementationOnce(() => {
      throw new Error('load failed');
    });
    expect(() => host.ensureBrowser('w', resource('a'))).toThrow('load failed');
    expect(mocks.controllers[0]!.dispose).toHaveBeenCalledOnce();
    host.ensureBrowser('w', resource('a'));
    expect(mocks.controllers).toHaveLength(2);
  });
});

describe('public resource Host page identity', () => {
  it('binds capture to the native page at operation start and saves only that returned snapshot', async () => {
    const resourcesSave = vi.fn().mockResolvedValue({ spaceId: 'taskflow-demo', revision: 1, resources: [] });
    const host = new WorkbenchHost({} as BrowserWindow, { resourcesSave, setAppListener: vi.fn() } as unknown as ChatService, '/fixture');
    host.ensureBrowser('taskflow-demo', resource('a'));
    const controller = mocks.controllers[0]!;
    const page = { ...mocks.page };
    let finish!: (snapshot: unknown) => void;
    controller.captureResource.mockImplementation(
      () =>
        new Promise((resolve) => {
          finish = resolve;
        }),
    );
    const pending = host.publicResourcesCapture('a', 'saved-resource');
    expect(controller.captureResource).toHaveBeenCalledWith(page);
    mocks.page = { ...page, documentGeneration: page.documentGeneration + 1 };
    expect(resourcesSave).not.toHaveBeenCalled();
    const captured = { text: 'original page snapshot' };
    finish(captured);
    await pending;
    expect(resourcesSave).toHaveBeenCalledWith('taskflow-demo', captured, 'saved-resource');
  });
  it('does not save when the native controller rejects the page identity after navigation', async () => {
    const resourcesSave = vi.fn();
    const host = new WorkbenchHost({} as BrowserWindow, { resourcesSave, setAppListener: vi.fn() } as unknown as ChatService, '/fixture');
    host.ensureBrowser('taskflow-demo', resource('a'));
    mocks.controllers[0]!.captureResource.mockRejectedValue(new Error('页面已经变化，请重新采集'));
    await expect(host.publicResourcesCapture('a')).rejects.toThrow('页面已经变化');
    expect(resourcesSave).not.toHaveBeenCalled();
  });
});

describe('managed application Browser origin leases', () => {
  it('authorizes only the verified app workspace URL and revokes it on stop', async () => {
    const target = { workspaceId: 'workspace-a', projectId: crypto.randomUUID() };
    const running = {
      ...target,
      environmentId: 'sandbox' as const,
      appInstanceId: crypto.randomUUID(),
      state: 'running' as const,
      url: 'http://127.0.0.1:49152',
      guestCwd: '/guest/app',
      error: null,
      cleanupConfirmed: false,
    };
    const chat = {
      setAppListener: vi.fn(),
      appStart: vi.fn(async () => running),
      appStop: vi.fn(async () => ({ ...running, state: 'stopped', url: null, cleanupConfirmed: true })),
    };
    const host = new WorkbenchHost({} as BrowserWindow, chat as unknown as ChatService, '/fixture');
    const managed = { ...resource('managed'), environmentId: 'sandbox' as const, appProjectId: target.projectId, url: running.url };
    expect(() => host.ensureBrowser(target.workspaceId, managed)).toThrow('应用实例已停止');
    await host.appStart(target);
    expect(() => host.ensureBrowser('workspace-b', managed)).toThrow('应用实例已停止');
    expect(() => host.ensureBrowser(target.workspaceId, { ...managed, url: 'http://127.0.0.1:49153' })).toThrow('应用实例已停止');
    host.ensureBrowser(target.workspaceId, managed);
    expect(mocks.controllers.at(-1)?.options.allowedOrigins).toEqual(['http://127.0.0.1:49152']);
    await host.appStop(target);
    expect(() => host.ensureBrowser(target.workspaceId, managed)).toThrow('应用实例已停止');
    expect(() => host.validateBrowserUrl(running.url)).toThrow();
  });
});
