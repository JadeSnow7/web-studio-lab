import { EventEmitter } from 'node:events';
import type { BrowserWindow } from 'electron';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { extractPublicDocument, type PublicDocument } from './public-document';
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
      loadURL: vi.fn(),
      stop: vi.fn(),
      close: vi.fn(),
      navigationHistory: { canGoBack: () => false, canGoForward: () => false },
    });
    constructor() {
      mocks.views.push(this);
    }
    setVisible = vi.fn();
    setBackgroundColor = vi.fn();
    setBounds = vi.fn();
  },
}));
import { PreviewController } from './controller';

function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (error: Error) => void;
  const promise = new Promise<T>((yes, no) => {
    resolve = yes;
    reject = no;
  });
  return { promise, resolve, reject };
}
type TestContents = EventEmitter & {
  url: string;
  title: string;
  loading: boolean;
  loadURL: ReturnType<typeof vi.fn>;
  stop: ReturnType<typeof vi.fn<() => void>>;
  close: ReturnType<typeof vi.fn<() => void>>;
  session: { protocol: { handle: ReturnType<typeof vi.fn> } };
};
const controllers: PreviewController[] = [];
const url = 'https://example.com/article';
function document(text = 'Frozen actual response', requested = url, final = requested): PublicDocument {
  return extractPublicDocument(Buffer.from(`<title>Public</title><body>${text}</body>`), requested, final);
}
function setup() {
  const window = Object.assign(new EventEmitter(), {
    visible: true,
    minimized: false,
    isVisible() {
      return this.visible;
    },
    isMinimized() {
      return this.minimized;
    },
    contentView: { addChildView: vi.fn(), removeChildView: vi.fn() },
  });
  const controller = new PreviewController(window as unknown as BrowserWindow, {
    partition: 'public-open',
    homeUrl: url,
    allowedOrigins: [],
    onState: vi.fn(),
    onCaptured: vi.fn(),
  });
  controllers.push(controller);
  const wc = (mocks.views.at(-1) as { webContents: TestContents }).webContents;
  const handler = wc.session.protocol.handle.mock.calls[0]?.[1] as (request: Request) => Promise<Response>;
  let current: { stopped: boolean; abort: ReturnType<typeof deferred<void>> } | null = null;
  wc.loadURL.mockImplementation((target: string) => {
    const owned = { stopped: false, abort: deferred<void>() };
    current = owned;
    wc.loading = true;
    wc.emit('did-start-navigation', { isMainFrame: true, isSameDocument: false, url: target });
    const load = (async () => {
      let displayed = target;
      let response = await handler(new Request(displayed));
      if (response.status === 302 && !owned.stopped) {
        displayed = response.headers.get('location') ?? '';
        wc.emit('will-redirect', { url: displayed, preventDefault: vi.fn() });
        response = await handler(new Request(displayed));
      }
      if (owned.stopped) return;
      if (response.status !== 200) throw new Error('ERR_FAILED');
      const html = await response.text();
      if (owned.stopped) return;
      wc.url = displayed;
      wc.title = /<title>(.*?)<\/title>/.exec(html)?.[1] ?? '';
      wc.emit('did-navigate');
    })();
    return Promise.race([load, owned.abort.promise]).finally(() => {
      if (current === owned) current = null;
      wc.loading = false;
      wc.emit('did-stop-loading');
    });
  });
  wc.stop.mockImplementation(() => {
    if (!current) return;
    current.stopped = true;
    current.abort.reject(Object.assign(new Error('ERR_ABORTED'), { errno: -3 }));
  });
  wc.close.mockImplementation(() => {
    wc.stop();
    wc.emit('destroyed');
  });
  function layout(visible = true, width = 600) {
    controller.setLayout({ visible, bounds: { x: 0, y: 0, width, height: 400 } });
  }
  return { controller, wc, window, layout, handler };
}
beforeEach(() => {
  mocks.views.length = 0;
  mocks.fetch.mockReset();
});
afterEach(() => {
  for (const controller of controllers.splice(0)) controller.dispose();
  vi.useRealTimers();
});

describe('owned visible public research read', () => {
  it('waits for positive visible layout, then captures exactly the response shown, without a second fetch', async () => {
    const { controller, wc, layout } = setup();
    const actual = document();
    mocks.fetch.mockResolvedValueOnce(actual);
    const result = controller.openPublicDocument(`${url}#ignored`, new AbortController().signal);
    layout(false);
    layout(true, 0);
    await Promise.resolve();
    expect(wc.loadURL).not.toHaveBeenCalled();
    expect(mocks.fetch).not.toHaveBeenCalled();
    layout();
    expect(await result).toMatchObject({ ...actual, page: { url, title: 'Public', documentGeneration: 1 } });
    expect(wc.loadURL).toHaveBeenCalledExactlyOnceWith(url);
    expect(mocks.fetch).toHaveBeenCalledOnce();
  });

  it('waits for the main window to become visible and preserves the same redirect response', async () => {
    const { controller, window, layout } = setup();
    window.visible = false;
    layout();
    const actual = document('Redirected actual response', url, 'https://example.com/final');
    mocks.fetch.mockResolvedValueOnce(actual);
    const result = controller.openPublicDocument(url, new AbortController().signal);
    await Promise.resolve();
    expect(mocks.fetch).not.toHaveBeenCalled();
    window.visible = true;
    window.emit('show');
    expect(await result).toMatchObject({ ...actual, page: { url: actual.url } });
    expect(mocks.fetch).toHaveBeenCalledOnce();
    expect(window.listenerCount('show')).toBe(0);
  });

  it('cancels before layout without dispatching any load or fetch', async () => {
    const { controller, wc, layout } = setup();
    const abort = new AbortController();
    const result = controller.openPublicDocument(url, abort.signal);
    const rejected = expect(result).rejects.toMatchObject({ code: 'cancelled' });
    abort.abort();
    layout();
    await rejected;
    expect(wc.loadURL).not.toHaveBeenCalled();
    expect(mocks.fetch).not.toHaveBeenCalled();
  });

  it('rejects a pre-aborted signal and destruction before layout without dispatching', async () => {
    const { controller, wc } = setup();
    const abort = new AbortController();
    abort.abort();
    await expect(controller.openPublicDocument(url, abort.signal)).rejects.toMatchObject({ code: 'cancelled' });
    const pending = controller.openPublicDocument(url, new AbortController().signal);
    const rejected = expect(pending).rejects.toMatchObject({ code: 'stale' });
    controller.dispose();
    await rejected;
    expect(wc.loadURL).not.toHaveBeenCalled();
    expect(mocks.fetch).not.toHaveBeenCalled();
  });

  it('does not return a snapshot if the displayed identity changes while capture settles', async () => {
    const { controller, wc, layout } = setup();
    layout();
    mocks.fetch.mockResolvedValueOnce(document());
    const capture = controller.captureResource.bind(controller);
    vi.spyOn(controller, 'captureResource').mockImplementationOnce(async (page) => {
      const snapshot = await capture(page);
      wc.title = 'Replaced title';
      wc.emit('page-title-updated');
      return snapshot;
    });
    await expect(controller.openPublicDocument(url, new AbortController().signal)).rejects.toMatchObject({ code: 'stale' });
  });

  it('abort waits for its actual broker read to settle even after the native load has stopped', async () => {
    const { controller, wc, layout } = setup();
    layout();
    const fetch = deferred<PublicDocument>();
    mocks.fetch.mockReturnValueOnce(fetch.promise);
    const abort = new AbortController();
    const result = controller.openPublicDocument(url, abort.signal);
    const settled = vi.fn();
    void result.then(settled, settled);
    await vi.waitFor(() => expect(mocks.fetch).toHaveBeenCalledOnce());
    const requestSignal = mocks.fetch.mock.calls[0]?.[2] as AbortSignal;
    abort.abort();
    await vi.waitFor(() => expect(wc.stop).toHaveBeenCalledOnce());
    expect(requestSignal.aborted).toBe(true);
    expect(settled).not.toHaveBeenCalled();
    fetch.resolve(document());
    await expect(result).rejects.toMatchObject({ code: 'cancelled' });
    await expect(controller.captureResource(controller.pageIdentity())).rejects.toThrow();
  });

  it.each(['hidden layout', 'minimized window', 'destroyed view', 'same-document navigation'] as const)(
    'rejects %s while reading and drains the late response',
    async (change) => {
      const { controller, wc, window, layout } = setup();
      layout();
      const fetch = deferred<PublicDocument>();
      mocks.fetch.mockReturnValueOnce(fetch.promise);
      const result = controller.openPublicDocument(url, new AbortController().signal);
      const rejected = expect(result).rejects.toMatchObject({ code: 'stale' });
      await vi.waitFor(() => expect(mocks.fetch).toHaveBeenCalledOnce());
      if (change === 'hidden layout') layout(false);
      if (change === 'minimized window') {
        window.minimized = true;
        window.emit('minimize');
      }
      if (change === 'destroyed view') controller.dispose();
      if (change === 'same-document navigation') {
        wc.emit('did-navigate-in-page', {}, `${url}#other`, true);
        wc.stop();
      }
      fetch.resolve(document());
      await rejected;
    },
  );

  it('does not stop a later user navigation when the old run is aborted; old late bytes cannot become its capture', async () => {
    const { controller, wc, layout } = setup();
    layout();
    const oldFetch = deferred<PublicDocument>();
    const newFetch = deferred<PublicDocument>();
    mocks.fetch.mockReturnValueOnce(oldFetch.promise).mockReturnValueOnce(newFetch.promise);
    const abort = new AbortController();
    const old = controller.openPublicDocument(url, abort.signal);
    const rejected = expect(old).rejects.toMatchObject({ code: 'stale' });
    await vi.waitFor(() => expect(mocks.fetch).toHaveBeenCalledOnce());
    const next = controller.navigate('https://example.com/user');
    await vi.waitFor(() => expect(mocks.fetch).toHaveBeenCalledTimes(2));
    expect(wc.stop).toHaveBeenCalledOnce();
    abort.abort();
    oldFetch.resolve(document('old bytes'));
    await rejected;
    expect(wc.stop).toHaveBeenCalledOnce();
    newFetch.resolve(document('user document', 'https://example.com/user'));
    await next;
    expect((await controller.captureResource(controller.pageIdentity())).text).toBe('user document');
  });

  it('rejects an external same-URL navigation instead of adopting it as the research response', async () => {
    const { controller, wc, layout } = setup();
    layout();
    const fetch = deferred<PublicDocument>();
    mocks.fetch.mockReturnValueOnce(fetch.promise);
    const result = controller.openPublicDocument(url, new AbortController().signal);
    const rejected = expect(result).rejects.toMatchObject({ code: 'stale' });
    await vi.waitFor(() => expect(mocks.fetch).toHaveBeenCalledOnce());
    wc.emit('will-navigate', { url, preventDefault: vi.fn() });
    wc.emit('did-start-navigation', { url, isMainFrame: true, isSameDocument: false });
    fetch.resolve(document('replaced'));
    await rejected;
  });

  it('uses one 20 second deadline including visibility and still drains a timed-out fetch', async () => {
    vi.useFakeTimers();
    const { controller, layout } = setup();
    const fetch = deferred<PublicDocument>();
    mocks.fetch.mockReturnValueOnce(fetch.promise);
    const result = controller.openPublicDocument(url, new AbortController().signal);
    const rejected = expect(result).rejects.toMatchObject({ code: 'timeout' });
    const settled = vi.fn();
    void result.then(settled, settled);
    await vi.advanceTimersByTimeAsync(19000);
    expect(mocks.fetch).not.toHaveBeenCalled();
    layout();
    await vi.advanceTimersByTimeAsync(0);
    expect(mocks.fetch).toHaveBeenCalledOnce();
    await vi.advanceTimersByTimeAsync(1000);
    expect(settled).not.toHaveBeenCalled();
    fetch.resolve(document());
    await rejected;
  });

  it('reports a blocked broker response and never returns an older page or fabricated body', async () => {
    const { controller, layout } = setup();
    layout();
    mocks.fetch.mockRejectedValueOnce(new Error('DNS 包含私网地址'));
    await expect(controller.openPublicDocument(url, new AbortController().signal)).rejects.toMatchObject({
      code: 'blocked',
      message: 'DNS 包含私网地址',
    });
    expect(mocks.fetch).toHaveBeenCalledOnce();
  });
});
