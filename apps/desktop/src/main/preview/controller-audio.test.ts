import { EventEmitter } from 'node:events';
import { randomUUID } from 'node:crypto';
import type { BrowserWindow } from 'electron';
import { describe, expect, it, vi } from 'vitest';
const mocks = vi.hoisted(() => ({ views: [] as unknown[] }));
vi.mock('electron', () => ({
  WebContentsView: class {
    webContents = Object.assign(new EventEmitter(), {
      id: 42,
      isDestroyed: () => false,
      getURL: vi.fn(() => ''),
      getTitle: () => 'Student',
      isLoading: () => false,
      session: {
        webRequest: { onBeforeRequest: vi.fn() },
        protocol: { handle: vi.fn(), unhandle: vi.fn() },
        on: vi.fn(),
        removeListener: vi.fn(),
        setPermissionCheckHandler: vi.fn(),
        setPermissionRequestHandler: vi.fn(),
      },
      debugger: Object.assign(new EventEmitter(), { isAttached: () => true, attach: vi.fn(), detach: vi.fn(), sendCommand: vi.fn() }),
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
    setBounds = vi.fn();
  },
}));
import { PreviewController } from './controller';
function setup() {
  let active = true;
  const window = {
    isDestroyed: () => false,
    isVisible: () => true,
    isMinimized: () => false,
    contentView: { addChildView: vi.fn(), removeChildView: vi.fn() },
  } as unknown as BrowserWindow;
  const onState = vi.fn();
  const preview = new PreviewController(window, {
    partition: 'audio-unit',
    homeUrl: 'http://127.0.0.1:8000/student',
    allowedOrigins: ['http://127.0.0.1:8000'],
    onState,
    onCaptured: vi.fn(),
    eduAudio: () =>
      active
        ? {
            workspaceId: 'w',
            resourceId: 'r',
            instanceId: 'i',
            instanceGeneration: 1,
            appInstanceId: 'app',
            origin: 'http://127.0.0.1:8000',
            activeWorkspace: true,
            running: true,
          }
        : null,
  });
  const wc = (
    mocks.views.at(-1) as {
      webContents: EventEmitter & {
        id: number;
        getURL: ReturnType<typeof vi.fn<() => string>>;
        loadURL: ReturnType<typeof vi.fn>;
        close: ReturnType<typeof vi.fn>;
        debugger: EventEmitter & { sendCommand: ReturnType<typeof vi.fn> };
        session: { setPermissionCheckHandler: ReturnType<typeof vi.fn>; setPermissionRequestHandler: ReturnType<typeof vi.fn> };
      };
    }
  ).webContents;
  const receipt = { documentId: randomUUID(), epoch: 1, tracks: 1, ended: 1, pending: 0 };
  wc.debugger.sendCommand.mockResolvedValue({ result: { value: receipt } });
  wc.loadURL.mockImplementation(async (url: string) => {
    wc.getURL.mockReturnValue(url);
    wc.emit('did-navigate');
    wc.emit('did-stop-loading');
  });
  const check = (change: Record<string, unknown> = {}) =>
    (wc.session.setPermissionCheckHandler.mock.calls[0]![0] as (...args: unknown[]) => boolean)(wc, 'media', 'http://127.0.0.1:8000', {
      isMainFrame: true,
      requestingUrl: wc.getURL(),
      mediaType: 'audio',
      ...change,
    });
  const request = (change: Record<string, unknown> = {}) => {
    const callback = vi.fn();
    (wc.session.setPermissionRequestHandler.mock.calls[0]![0] as (...args: unknown[]) => void)(wc, 'media', callback, {
      isMainFrame: true,
      requestingUrl: wc.getURL(),
      mediaTypes: ['audio'],
      ...change,
    });
    return callback.mock.calls[0]![0];
  };
  const show = async () => {
    await preview.navigate('http://127.0.0.1:8000/student');
    preview.setLayout({ visible: true, bounds: { x: 0, y: 0, width: 600, height: 400 } });
    await vi.waitFor(() => expect(check()).toBe(true));
  };
  return {
    preview,
    wc,
    receipt,
    check,
    request,
    show,
    onState,
    revoke: () => {
      active = false;
    },
  };
}
describe('edu preview audio admission and cleanup', () => {
  it('request/check share current main-frame audio eligibility and revoke stale instances', async () => {
    const t = setup();
    await t.show();
    expect(t.request()).toBe(true);
    expect(t.check({ isMainFrame: false })).toBe(false);
    expect(t.request({ isMainFrame: false })).toBe(false);
    expect(t.check({ mediaType: 'video' })).toBe(false);
    expect(t.request({ mediaTypes: ['audio', 'video'] })).toBe(false);
    t.wc.getURL.mockReturnValue('http://127.0.0.1:8000/admin');
    expect(t.request()).toBe(false);
    expect(t.check()).toBe(false);
    t.wc.getURL.mockReturnValue('http://127.0.0.1:8000/student');
    t.revoke();
    expect(t.check()).toBe(false);
    expect(t.request()).toBe(false);
    await t.preview.closeWithAudioCleanup();
  });
  it('revokes before awaiting old-context proof and navigates once only after proof', async () => {
    const t = setup();
    await t.show();
    let finish!: (result: unknown) => void;
    t.wc.debugger.sendCommand.mockImplementation((method: string, params?: { expression?: string }) =>
      method === 'Runtime.evaluate' && params?.expression?.includes('.stop()')
        ? new Promise((resolve) => {
            finish = resolve;
          })
        : Promise.resolve({ result: { value: t.receipt } }),
    );
    t.wc.loadURL.mockClear();
    const prevent = vi.fn();
    t.wc.emit('will-navigate', { url: 'http://127.0.0.1:8000/admin', preventDefault: prevent });
    expect(prevent).toHaveBeenCalledOnce();
    expect(t.check()).toBe(false);
    await vi.waitFor(() => expect(finish).toBeTypeOf('function'));
    expect(t.wc.loadURL).not.toHaveBeenCalled();
    finish({ result: { value: t.receipt } });
    await vi.waitFor(() => expect(t.wc.loadURL).toHaveBeenCalledExactlyOnceWith('http://127.0.0.1:8000/admin'));
  });
  it('hiding synchronously denies requests and verifies stop; disposal waits for proof', async () => {
    const t = setup();
    await t.show();
    t.preview.setLayout({ visible: false, bounds: { x: 0, y: 0, width: 600, height: 400 } });
    expect(t.check()).toBe(false);
    expect(t.request()).toBe(false);
    await t.preview.closeWithAudioCleanup();
    expect(t.wc.debugger.sendCommand.mock.calls.some((call) => String(call[1]?.expression).includes('.stop()'))).toBe(true);
    expect(t.wc.close).toHaveBeenCalledOnce();
  });
  it('same-document changes revoke immediately and preserve the cleanup document identity', async () => {
    const t = setup();
    await t.show();
    const before = t.preview.getState().page.documentGeneration;
    t.wc.emit('did-navigate-in-page', {}, 'http://127.0.0.1:8000/student#next', true);
    expect(t.check()).toBe(false);
    expect(t.preview.getState().page.documentGeneration).toBe(before + 1);
    await vi.waitFor(() => expect(t.check()).toBe(true));
    await t.preview.closeWithAudioCleanup();
  });
  it('destroys and reports failure at the deadline when native cleanup never replies', async () => {
    const t = setup();
    await t.show();
    vi.useFakeTimers();
    try {
      t.wc.debugger.sendCommand.mockImplementation(() => new Promise(() => {}));
      const failed = expect(t.preview.closeWithAudioCleanup()).rejects.toThrow('截止时间已到');
      await vi.advanceTimersByTimeAsync(2000);
      await failed;
      expect(t.wc.close).toHaveBeenCalledOnce();
      expect(t.onState.mock.calls.at(-1)![0].loadError.description).toContain('截止时间已到');
    } finally {
      vi.useRealTimers();
    }
  });
  it('unended or missing actual track proof emits an error and destroys preview without successful cleanup', async () => {
    const t = setup();
    await t.show();
    t.wc.debugger.sendCommand.mockResolvedValue({ result: { value: { ...t.receipt, ended: 0 } } });
    await expect(t.preview.closeWithAudioCleanup()).rejects.toThrow('实际音轨结束未确认');
    expect(t.wc.close).toHaveBeenCalledOnce();
    expect(t.onState.mock.calls.at(-1)![0].loadError.description).toContain('录音清理未确认');
    expect(t.check()).toBe(false);
  });
});
