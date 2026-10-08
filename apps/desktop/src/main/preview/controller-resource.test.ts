import { EventEmitter } from 'node:events';
import type { BrowserWindow } from 'electron';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { extractPublicDocument } from './public-document';
import type * as PublicDocumentModule from './public-document';

const mocks = vi.hoisted(() => ({ fetch: vi.fn(), views: [] as unknown[] }));
vi.mock('./public-document', async (original) => ({
  ...(await original<typeof PublicDocumentModule>()),
  fetchPublicDocument: mocks.fetch,
}));
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
      setWindowOpenHandler: vi.fn(),
      loadURL: vi.fn(async () => undefined),
      navigationHistory: { canGoBack: () => false, canGoForward: () => false },
      close: vi.fn(),
    });
    constructor(readonly settings: unknown) {
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
  const handler = view.webContents.session.protocol.handle.mock.calls[0]![1] as (request: Request) => Promise<Response>;
  async function commit(url: string, title: string, text: string) {
    view.webContents.emit('did-start-navigation', { isMainFrame: true, isSameDocument: false });
    mocks.fetch.mockResolvedValueOnce(extractPublicDocument(Buffer.from(`<title>${title}</title><body>${text}</body>`), url, url));
    const response = await handler(new Request(url));
    expect(response.status).toBe(200);
    view.webContents.url = url;
    view.webContents.title = title;
    view.webContents.loading = false;
    view.webContents.emit('did-navigate');
  }
  return { controller, view, handler, commit };
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
    view.webContents.emit('will-frame-navigate', { isMainFrame: false, preventDefault });
    expect(preventDefault).toHaveBeenCalledOnce();
  });
  it('公开地址栏 fragment 规范化后再导航，标题空白与浏览器一致', async () => {
    const { controller, view, handler } = setup();
    await controller.navigate('https://example.com/#section');
    expect(view.webContents.loadURL).toHaveBeenCalledWith('https://example.com/');
    mocks.fetch.mockResolvedValueOnce(
      extractPublicDocument(Buffer.from('<title>A\n B</title><body>text</body>'), 'https://example.com/', 'https://example.com/'),
    );
    await handler(new Request('https://example.com/'));
    view.webContents.url = 'https://example.com/';
    view.webContents.title = 'A B';
    view.webContents.emit('did-navigate');
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
    await expect(controller.captureResource(identity)).rejects.toThrow('等待公开文档成功加载');
  });
  it('保留同次 broker 的失败原因，原生其他地址或新导航失败仍更新', async () => {
    const { controller, view, handler } = setup();
    view.webContents.emit('did-start-navigation', { isMainFrame: true, isSameDocument: false });
    mocks.fetch.mockRejectedValueOnce(new Error('DNS 包含私网地址，已阻止连接'));
    await handler(new Request('https://example.com/'));
    expect(controller.getState().loadError?.description).toContain('DNS 包含私网');
    view.webContents.emit('did-fail-load', {}, -2, 'ERR_FAILED', 'https://example.com/', true);
    expect(controller.getState().loadError?.description).toContain('DNS 包含私网');
    view.webContents.emit('did-fail-load', {}, -105, 'ERR_NAME_NOT_RESOLVED', 'https://docs.docker.com/', true);
    expect(controller.getState().loadError?.description).toBe('ERR_NAME_NOT_RESOLVED');
    view.webContents.emit('did-start-navigation', { isMainFrame: true, isSameDocument: false });
    view.webContents.emit('did-fail-load', {}, -2, 'NEW_NATIVE_FAILURE', 'https://example.com/', true);
    expect(controller.getState().loadError?.description).toBe('NEW_NATIVE_FAILURE');
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
