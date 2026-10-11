import { EventEmitter } from 'node:events';
import type { BrowserWindow } from 'electron';
import { beforeEach, describe, expect, it, vi } from 'vitest';
const mocks = vi.hoisted(() => ({ views: [] as unknown[] }));
vi.mock('electron', () => ({
  WebContentsView: class {
    webContents = Object.assign(new EventEmitter(), {
      id: 42,
      getURL: () => 'wsl-demo://taskflow/index.html',
      getTitle: () => 'Test',
      isLoading: () => false,
      session: {
        webRequest: { onBeforeRequest: vi.fn() },
        protocol: { handle: vi.fn(), unhandle: vi.fn() },
        on: vi.fn(),
        removeListener: vi.fn(),
      },
      debugger: Object.assign(new EventEmitter(), { isAttached: () => false }),
      navigationHistory: { canGoBack: () => false, canGoForward: () => false },
      setWindowOpenHandler: vi.fn(),
      loadURL: vi.fn(),
      reload: vi.fn(),
      stop: vi.fn(),
      close: vi.fn(),
    });
    constructor() {
      mocks.views.push(this);
    }
    setVisible = vi.fn();
    setBackgroundColor = vi.fn();
  },
}));
import { PreviewController } from './controller';
function setup() {
  const onState = vi.fn();
  const controller = new PreviewController(
    { contentView: { addChildView: vi.fn(), removeChildView: vi.fn() } } as unknown as BrowserWindow,
    {
      partition: 'navigation-fixture',
      homeUrl: 'wsl-demo://taskflow/index.html',
      allowedOrigins: ['wsl-demo://taskflow'],
      onState,
      onCaptured: vi.fn(),
    },
  );
  const wc = (
    mocks.views.at(-1) as {
      webContents: {
        loadURL: ReturnType<typeof vi.fn>;
        stop: ReturnType<typeof vi.fn>;
        emit: (event: string, ...args: unknown[]) => boolean;
        reload: ReturnType<typeof vi.fn>;
      };
    }
  ).webContents;
  wc.loadURL.mockImplementation(async () => {
    wc.emit('did-stop-loading');
  });
  wc.reload.mockImplementation(() => {
    wc.emit('did-stop-loading');
  });
  return { controller, wc, onState };
}
function pending() {
  let resolve!: () => void;
  let reject!: (error: unknown) => void;
  const promise = new Promise<void>((success, failure) => {
    resolve = success;
    reject = failure;
  });
  return { promise, resolve, reject };
}
const aborted = () => Object.assign(new Error('ERR_ABORTED'), { code: 'ERR_ABORTED', errno: -3 });
beforeEach(() => {
  mocks.views.length = 0;
});
describe('native load request ownership', () => {
  it('settles an initial load before installing the new loadURL observer, avoiding cross-request rejection', async () => {
    const { controller, wc } = setup();
    const initial = pending();
    let initialActive = true;
    void initial.promise.then(
      () => {
        initialActive = false;
      },
      () => {
        initialActive = false;
      },
    );
    wc.loadURL
      .mockImplementationOnce(() => initial.promise)
      .mockImplementationOnce(() =>
        initialActive
          ? Promise.reject(Object.assign(new Error("(-3) loading 'wsl-demo://taskflow/index.html'"), { code: '', errno: -3 }))
          : (wc.emit('did-stop-loading'), Promise.resolve()),
      );
    wc.stop.mockImplementation(() => {
      initial.reject(aborted());
      queueMicrotask(() => wc.emit('did-stop-loading'));
    });
    controller.load();
    await expect(controller.navigate('wsl-demo://taskflow/members.html')).resolves.toBeUndefined();
    expect(wc.stop).toHaveBeenCalledOnce();
    expect(controller.getState().loadError).toBeNull();
  });
  it('propagates a current ERR_ABORTED and non-abort failures instead of manufacturing success', async () => {
    const { controller, wc } = setup();
    for (const error of [aborted(), new Error('network failed')]) {
      wc.loadURL.mockImplementationOnce(async () => {
        wc.emit('did-stop-loading');
        throw error;
      });
      await expect(controller.navigate('wsl-demo://taskflow/members.html')).rejects.toBe(error);
    }
  });
  it('retains a superseded non-abort error on its original caller while the next request proceeds', async () => {
    const { controller, wc } = setup();
    const initial = pending();
    wc.loadURL.mockImplementationOnce(() => initial.promise);
    const error = new Error('network failed');
    wc.stop.mockImplementation(() => {
      initial.reject(error);
      queueMicrotask(() => wc.emit('did-stop-loading'));
    });
    const first = controller.navigate('wsl-demo://taskflow/index.html');
    const rejected = expect(first).rejects.toBe(error);
    await expect(controller.navigate('wsl-demo://taskflow/members.html')).resolves.toBeUndefined();
    await rejected;
  });
  it('waits for the late old failure and stop event after the old promise settles', async () => {
    const { controller, wc } = setup();
    const initial = pending();
    wc.loadURL.mockImplementationOnce(() => initial.promise);
    wc.stop.mockImplementation(() => initial.reject(aborted()));
    controller.load();
    const next = controller.navigate('wsl-demo://taskflow/members.html');
    await vi.waitFor(() => expect(wc.stop).toHaveBeenCalledOnce());
    expect(wc.loadURL).toHaveBeenCalledTimes(1);
    wc.emit('did-fail-load', {}, -3, 'ERR_ABORTED', 'wsl-demo://taskflow/index.html', true);
    expect(wc.loadURL).toHaveBeenCalledTimes(1);
    wc.emit('did-stop-loading');
    await next;
    expect(wc.loadURL).toHaveBeenCalledTimes(2);
    expect(controller.getState().loadError).toBeNull();
  });
  it('coalesces waiting requests and coordinates reload without overlapping loads', async () => {
    const { controller, wc } = setup();
    const initial = pending();
    wc.loadURL.mockImplementationOnce(() => initial.promise);
    wc.stop.mockImplementation(() => initial.reject(aborted()));
    controller.load();
    const skipped = controller.navigate('wsl-demo://taskflow/members.html');
    const reload = controller.reload();
    expect(wc.reload).not.toHaveBeenCalled();
    wc.emit('did-stop-loading');
    await Promise.all([skipped, reload]);
    expect(wc.loadURL).toHaveBeenCalledTimes(1);
    expect(wc.reload).toHaveBeenCalledOnce();
  });
  it('releases a waiting navigation on disposal without creating another native load', async () => {
    const { controller, wc, onState } = setup();
    const initial = pending();
    wc.loadURL.mockImplementationOnce(() => initial.promise);
    wc.stop.mockImplementation(() => initial.reject(aborted()));
    controller.load();
    const next = controller.navigate('wsl-demo://taskflow/members.html');
    controller.dispose();
    const count = onState.mock.calls.length;
    await expect(next).rejects.toThrow('网页实例已销毁');
    expect(wc.loadURL).toHaveBeenCalledTimes(1);
    expect(onState).toHaveBeenCalledTimes(count);
  });
  it('rejects a current load completing after disposal and does not broadcast late state', async () => {
    const { controller, wc, onState } = setup();
    const current = pending();
    wc.loadURL.mockImplementationOnce(() => current.promise);
    const result = controller.navigate('wsl-demo://taskflow/members.html');
    controller.dispose();
    const count = onState.mock.calls.length;
    current.resolve();
    await expect(result).rejects.toThrow('网页实例已销毁');
    expect(onState).toHaveBeenCalledTimes(count);
  });
});
