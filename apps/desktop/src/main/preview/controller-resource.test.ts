import { EventEmitter } from 'node:events';
import type { BrowserWindow } from 'electron';
import { beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({ fetch: vi.fn(), views: [] as unknown[] }));
vi.mock('electron', () => ({
  WebContentsView: class {
    webContents = Object.assign(new EventEmitter(), {
      id: 42,
      url: '',
      title: '',
      loading: false,
      session: {
        webRequest: { onBeforeRequest: vi.fn() },
        protocol: { handle: vi.fn(), unhandle: vi.fn() },
        on: vi.fn(),
        removeListener: vi.fn(),
      },
      debugger: Object.assign(new EventEmitter(), { isAttached: () => false }),
      getURL() {
        return this.url;
      },
      getTitle() {
        return this.title;
      },
      isLoading() {
        return this.loading;
      },
      executeJavaScriptInIsolatedWorld: mocks.fetch,
      setWindowOpenHandler: vi.fn(),
      loadURL: vi.fn(async () => undefined),
      navigationHistory: { canGoBack: () => false, canGoForward: () => false },
      close: vi.fn(),
    });
    constructor(readonly settings: unknown) {
      this.webContents.loadURL.mockImplementation(async () => {
        this.webContents.emit('did-stop-loading');
      });
      mocks.views.push(this);
    }
    setVisible = vi.fn();
    setBackgroundColor = vi.fn();
  },
}));
import { PreviewController } from './controller';

type TestView = {
  settings: { webPreferences: Record<string, unknown> };
  webContents: EventEmitter & {
    url: string;
    title: string;
    loading: boolean;
    loadURL: ReturnType<typeof vi.fn>;
    session: { protocol: { handle: ReturnType<typeof vi.fn> } };
  };
};
function setup() {
  const controller = new PreviewController(
    { contentView: { addChildView: vi.fn(), removeChildView: vi.fn() } } as unknown as BrowserWindow,
    {
      partition: 'test-preview',
      homeUrl: 'wsl-demo://taskflow/',
      allowedOrigins: ['wsl-demo://taskflow'],
      onState: vi.fn(),
      onCaptured: vi.fn(),
    },
  );
  const view = mocks.views.at(-1) as TestView;
  async function commit(url: string, title: string, text: string) {
    view.webContents.emit('did-start-navigation', { isMainFrame: true, isSameDocument: false });
    mocks.fetch.mockResolvedValue({ title, text, truncated: false });
    view.webContents.url = url;
    view.webContents.title = title;
    view.webContents.loading = false;
    view.webContents.emit('did-navigate');
  }
  return { controller, view, commit };
}

beforeEach(() => {
  mocks.views.length = 0;
  mocks.fetch.mockReset();
});
describe('当前公开文档身份绑定', () => {
  it('公开页面保持无 preload 的 sandbox 与隔离，不扩大窗口或子框架权限', () => {
    const { view } = setup();
    expect(view.settings.webPreferences).toMatchObject({
      sandbox: true,
      contextIsolation: true,
      webSecurity: true,
      nodeIntegration: false,
    });
    expect(view.settings.webPreferences).not.toHaveProperty('preload');
    const preventDefault = vi.fn();
    view.webContents.emit('will-frame-navigate', { url: 'https://example.com/', isMainFrame: false, preventDefault });
    expect(preventDefault).not.toHaveBeenCalled();
    view.webContents.emit('will-frame-navigate', { url: 'file:///etc/passwd', isMainFrame: false, preventDefault });
    expect(preventDefault).toHaveBeenCalledOnce();
  });
  it('HTTP addresses retain hash and rendered title', async () => {
    const { controller, view, commit } = setup();
    await controller.navigate('http://localhost:3210/#section');
    expect(view.webContents.loadURL).toHaveBeenCalledWith('http://localhost:3210/#section');
    await commit('http://localhost:3210/#section', 'A B', 'text');
    expect((await controller.captureResource(controller.pageIdentity())).title).toBe('A B');
  });
  it('只能捕获当前已成功显示的公开文档；同 URL 新文档也使旧身份失效', async () => {
    const { controller, commit } = setup();
    await commit('https://example.com/', 'Example', 'version one');
    const identity = controller.pageIdentity();
    const first = await controller.captureResource(identity);
    expect(first.text).toBe('version one');
    expect(first.page.url).toBe(first.url);
    expect(first.page.title).toBe(first.title);
    await commit('https://example.com/', 'Example', 'version two');
    await expect(controller.captureResource(identity)).rejects.toThrow('页面已经变化');
    expect((await controller.captureResource(controller.pageIdentity())).text).toBe('version two');
  });
  it('导航开始但 URL 与文档代次尚未改变时，不能保存旧正文', async () => {
    const { controller, view, commit } = setup();
    await commit('https://example.com/', 'Example', 'old body');
    const identity = controller.pageIdentity();
    view.webContents.emit('did-start-navigation', { isMainFrame: true, isSameDocument: false });
    expect(controller.pageIdentity()).toEqual(identity);
    await expect(controller.captureResource(identity)).rejects.toThrow('等待网页成功加载');
  });
  it('rejects a capture completing after navigation begins', async () => {
    const { controller, view, commit } = setup();
    await commit('https://example.com/', 'Example', 'old');
    let resolve!: (value: { title: string; text: string; truncated: boolean }) => void;
    mocks.fetch.mockImplementationOnce(
      () =>
        new Promise((done) => {
          resolve = done;
        }),
    );
    const result = controller.captureResource(controller.pageIdentity());
    view.webContents.emit('did-start-navigation', { isMainFrame: true, isSameDocument: false });
    resolve({ title: 'Example', text: 'old', truncated: false });
    await expect(result).rejects.toThrow('页面已经变化');
  });
  it('keeps the displayed page capturable after rejecting an OS protocol navigation', async () => {
    const { controller, view, commit } = setup();
    await commit('https://example.com/', 'Example', 'body');
    view.webContents.emit('did-start-navigation', { isMainFrame: true, isSameDocument: false });
    const preventDefault = vi.fn();
    view.webContents.emit('will-navigate', { url: 'custom://external', preventDefault });
    expect(preventDefault).toHaveBeenCalledOnce();
    expect((await controller.captureResource(controller.pageIdentity())).text).toBe('body');
  });
  it('rejects oversized or malformed isolated-world payloads at the boundary', async () => {
    const { controller, commit } = setup();
    await commit('https://example.com/', 'Example', 'body');
    for (const value of [null, { title: 'Example', text: 'x'.repeat(65541), truncated: true }, { title: 'Example', text: 'body' }]) {
      mocks.fetch.mockResolvedValueOnce(value);
      await expect(controller.captureResource(controller.pageIdentity())).rejects.toThrow('采集结果无效');
    }
  });
  it('加载失败、演示页面、标题不匹配和被销毁文档均不能挂载', async () => {
    const { controller, view, commit } = setup();
    await expect(controller.captureResource(controller.pageIdentity())).rejects.toThrow();
    await commit('https://example.com/', 'Example', 'body');
    view.webContents.title = 'Changed';
    await expect(controller.captureResource(controller.pageIdentity())).rejects.toThrow('页面已经变化');
    view.webContents.title = 'Example';
    view.webContents.emit('did-fail-load', {}, -1, 'load failed', 'https://example.com/', true);
    await expect(controller.captureResource(controller.pageIdentity())).rejects.toThrow();
    controller.dispose();
    await expect(controller.captureResource(controller.pageIdentity())).rejects.toThrow();
  });
});
