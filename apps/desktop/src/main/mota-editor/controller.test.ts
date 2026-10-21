import { EventEmitter } from 'node:events';
import { createHash, randomUUID } from 'node:crypto';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { BrowserWindow, IpcMainInvokeEvent } from 'electron';
import type { ManagedApp, MotaEditorProjection, WorkbenchResource } from '@wsl/protocol';
import { MotaEditorAssets } from './assets';
import { MotaEditorController } from './controller';
const native = vi.hoisted(() => ({
  preferences: vi.fn(),
  partition: vi.fn(),
  permission: vi.fn(),
  check: vi.fn(),
  download: vi.fn(),
  request: vi.fn(),
  contents: [] as unknown[],
}));
vi.mock('electron', () => ({
  session: {
    fromPartition: (partition: string) => {
      native.partition(partition);
      return {
        setPermissionRequestHandler: native.permission,
        setPermissionCheckHandler: native.check,
        on: native.download,
        webRequest: { onBeforeRequest: native.request },
      };
    },
  },
  WebContentsView: class {
    webContents = new (class extends EventEmitter {
      id = 42;
      destroyed = false;
      url = '';
      mainFrame = { url: '', processId: 3, routingId: 4, detached: false };
      getURL = () => this.url;
      isDestroyed = () => this.destroyed;
      send = vi.fn();
      setWindowOpenHandler = vi.fn();
      loadURL = vi.fn(async (url: string) => {
        this.emit('did-start-navigation');
        this.url = url;
        this.mainFrame.url = url;
        this.emit('did-finish-load');
      });
      close = vi.fn(() => {
        this.destroyed = true;
        this.emit('destroyed');
      });
    })();
    setBounds = vi.fn();
    constructor(options: unknown) {
      native.preferences(options);
      native.contents.push(this.webContents);
    }
  },
}));
const hash = (text: string) => createHash('sha256').update(text).digest('hex');
function fixture(validation: Promise<void> = Promise.resolve()) {
  const files = ['LICENSES.txt', 'editor.css', 'editor.js', 'index.html'].map((name) => ({
    path: name,
    length: name.length,
    sha256: hash(name),
  }));
  const assets = new MotaEditorAssets('/not-read-in-native-unit', { schemaVersion: 1, version: hash(JSON.stringify(files)), files });
  vi.spyOn(assets, 'validate').mockReturnValue(validation);
  let invalidAssets: (() => void) | undefined;
  vi.spyOn(assets, 'install').mockImplementation((_target, failure) => {
    invalidAssets = failure;
  });
  const window = {
    visible: true,
    minimized: false,
    destroyed: false,
    isVisible: () => window.visible,
    isMinimized: () => window.minimized,
    isDestroyed: () => window.destroyed,
    contentView: { addChildView: vi.fn(), removeChildView: vi.fn() },
  };
  const resource = { resourceId: 'editor', instanceId: 'resource-instance', generation: 1 } as WorkbenchResource;
  const app = { projectId: randomUUID(), appInstanceId: 'existing-app' } as ManagedApp;
  const changed = vi.fn();
  const owner = new MotaEditorController(
    window as unknown as BrowserWindow,
    'space',
    resource,
    app,
    'dark',
    assets,
    '/preload/mota-editor.js',
    changed,
  );
  return { owner, changed, window, app, resource, invalidAssets: () => invalidAssets!() };
}
function clearNativeContents(owner: MotaEditorController) {
  const wc = owner.view.webContents;
  // Electron clears the View getter before notifying the captured WebContents listeners.
  Object.defineProperty(owner.view, 'webContents', { value: undefined });
  Object.assign(wc, { destroyed: true });
  Object.defineProperty(wc, 'mainFrame', {
    get: () => {
      throw new Error('destroyed WebContents has no live mainFrame');
    },
  });
  Object.defineProperty(wc, 'getURL', {
    value: () => {
      throw new Error('destroyed WebContents has no live URL');
    },
  });
  return wc as unknown as EventEmitter;
}
beforeEach(() => {
  vi.clearAllMocks();
  native.contents.length = 0;
});
describe('dedicated editor native owner (synthetic Electron)', () => {
  it.each([false, true])('survives a cleared native View getter before destroyed (dispose pending: %s)', async (disposePending) => {
    const f = fixture();
    await vi.waitFor(() => expect(f.owner.getFacts().trusted).toBe(true));
    const wc = f.owner.view.webContents;
    const event = { sender: wc, senderFrame: wc.mainFrame } as IpcMainInvokeEvent;
    const layout = { visible: true, bounds: { x: 0, y: 0, width: 300, height: 200 } };
    const projection: MotaEditorProjection = { sessionIndex: null, state: 'revoked', theme: 'dark', error: null, operations: [] };
    f.owner.layout(layout);
    vi.mocked(wc.close).mockImplementation(() => {});
    if (disposePending) f.owner.dispose();
    const epoch = f.owner.getFacts().navigationEpoch;
    const emitter = clearNativeContents(f.owner);
    expect(() => emitter.emit('destroyed')).not.toThrow();
    expect(f.changed.mock.calls.at(-1)?.[0]).toMatchObject({
      destroyed: true,
      trusted: false,
      visible: false,
      navigationEpoch: epoch + 1,
    });
    expect(f.owner.getFacts()).toMatchObject({ destroyed: true, trusted: false, visible: false });
    expect(f.owner.accepts(event)).toBe(false);
    f.window.contentView.addChildView.mockClear();
    vi.mocked(f.owner.view.setBounds).mockClear();
    f.owner.update('space', f.resource, f.app, 'warm');
    f.owner.layout(layout);
    f.owner.visibility(true, projection);
    const preventDefault = vi.fn();
    for (const name of ['did-start-navigation', 'did-fail-load', 'render-process-gone', 'will-navigate', 'did-finish-load']) {
      expect(() => emitter.emit(name, { preventDefault })).not.toThrow();
    }
    f.invalidAssets();
    f.owner.dispose();
    f.owner.dispose();
    expect(() => emitter.emit('destroyed')).not.toThrow();
    expect(() => emitter.emit('did-finish-load')).not.toThrow();
    expect(f.owner.accepts(event)).toBe(false);
    expect(f.owner.getFacts()).toMatchObject({ destroyed: true, trusted: false, visible: false });
    expect(f.window.contentView.addChildView).not.toHaveBeenCalled();
    expect(f.owner.view.setBounds).not.toHaveBeenCalled();
    expect(wc.loadURL).toHaveBeenCalledTimes(1);
    expect(wc.send).not.toHaveBeenCalled();
    expect(wc.close).toHaveBeenCalledTimes(disposePending ? 1 : 0);
  });
  it('does not load after native destruction while asset validation is pending', async () => {
    let validated!: () => void;
    const f = fixture(new Promise<void>((resolve) => (validated = resolve)));
    const wc = f.owner.view.webContents;
    const emitter = clearNativeContents(f.owner);
    expect(() => emitter.emit('destroyed')).not.toThrow();
    validated();
    await Promise.resolve();
    await Promise.resolve();
    expect(wc.loadURL).not.toHaveBeenCalled();
    expect(f.owner.getFacts()).toMatchObject({ destroyed: true, trusted: false, visible: false });
    f.owner.dispose();
    expect(wc.close).not.toHaveBeenCalled();
  });
  it('revokes before asynchronous native close and cannot reattach or trust a late load', async () => {
    const f = fixture();
    await vi.waitFor(() => expect(f.owner.getFacts().trusted).toBe(true));
    const wc = f.owner.view.webContents;
    const event = { sender: wc, senderFrame: wc.mainFrame } as IpcMainInvokeEvent;
    const layout = { visible: true, bounds: { x: 0, y: 0, width: 300, height: 200 } };
    f.owner.layout(layout);
    const epoch = f.owner.getFacts().navigationEpoch;
    const atClose = vi.fn();
    vi.mocked(wc.close).mockImplementation(() => {
      atClose(f.owner.getFacts(), f.owner.accepts(event));
      // Leave native destruction pending, as real Electron can after close() returns.
    });
    f.owner.dispose();
    expect(atClose).toHaveBeenCalledWith(
      expect.objectContaining({ trusted: false, visible: false, destroyed: false, navigationEpoch: epoch + 1 }),
      false,
    );
    expect(f.window.contentView.removeChildView).toHaveBeenCalledWith(f.owner.view);
    expect(f.changed.mock.calls.at(-1)?.[0]).toMatchObject({ trusted: false, visible: false });
    f.window.contentView.addChildView.mockClear();
    (native.contents[0] as EventEmitter).emit('did-finish-load');
    f.owner.layout(layout);
    f.owner.visibility(true);
    f.owner.dispose();
    expect(wc.close).toHaveBeenCalledTimes(1);
    expect(wc.loadURL).toHaveBeenCalledTimes(1);
    expect(f.window.contentView.addChildView).not.toHaveBeenCalled();
    expect(f.owner.getFacts()).toMatchObject({ trusted: false, visible: false, destroyed: false });
    expect(f.owner.accepts(event)).toBe(false);
    Object.assign(wc, { destroyed: true });
    (native.contents[0] as EventEmitter).emit('destroyed');
    expect(f.owner.getFacts()).toMatchObject({ trusted: false, visible: false, destroyed: true });
  });
  it('does not start a late asset-validated load after disposal', async () => {
    let validated!: () => void;
    const f = fixture(new Promise<void>((resolve) => (validated = resolve)));
    f.owner.dispose();
    validated();
    await Promise.resolve();
    expect(f.owner.view.webContents.loadURL).not.toHaveBeenCalled();
    expect(f.owner.getFacts()).toMatchObject({ trusted: false, visible: false, destroyed: true });
  });
  it.each(['hidden', 'minimized', 'destroyed'] as const)('observes current %s host state before its visibility event', async (state) => {
    const f = fixture();
    await vi.waitFor(() => expect(f.owner.getFacts().trusted).toBe(true));
    const layout = { visible: true, bounds: { x: 0, y: 0, width: 300, height: 200 } };
    f.owner.layout(layout);
    expect(f.owner.getFacts().visible).toBe(true);
    if (state === 'hidden') f.window.visible = false;
    else f.window[state] = true;
    expect(f.owner.getFacts().visible).toBe(false);
    f.owner.visibility(false);
    f.window.contentView.addChildView.mockClear();
    f.owner.layout(layout);
    f.owner.visibility(true);
    expect(f.owner.getFacts().visible).toBe(false);
    expect(f.window.contentView.addChildView).not.toHaveBeenCalled();
    f.window.visible = true;
    f.window.minimized = false;
    f.window.destroyed = false;
    expect(f.owner.getFacts().visible).toBe(false);
    f.owner.layout(layout);
    expect(f.owner.getFacts().visible).toBe(true);
  });
  it('uses a nonpersistent sandboxed partition and retains the same View through hide and App restart', async () => {
    const f = fixture();
    await vi.waitFor(() => expect(f.owner.getFacts().trusted).toBe(true));
    expect(native.preferences).toHaveBeenCalledWith({
      webPreferences: expect.objectContaining({
        sandbox: true,
        contextIsolation: true,
        nodeIntegration: false,
        preload: '/preload/mota-editor.js',
      }),
    });
    expect(native.partition).toHaveBeenCalledWith('mota-editor-resource-instance-1');
    const view = f.owner.view;
    f.owner.layout({ visible: true, bounds: { x: 1, y: 2, width: 300, height: 200 } });
    f.owner.visibility(false, { sessionIndex: null, state: 'revoked', theme: 'dark', error: null, operations: [] });
    expect(view.webContents.send).toHaveBeenCalledWith('mota-editor:status', {
      sessionIndex: null,
      state: 'revoked',
      theme: 'dark',
      error: null,
      operations: [],
    });
    f.owner.update('space', { ...f.resource, instanceId: 'new-resource', generation: 3 }, { ...f.app, appInstanceId: 'new-app' }, 'warm');
    expect(f.owner.view).toBe(view);
    expect(view.webContents.isDestroyed()).toBe(false);
    expect(f.owner.getFacts()).toMatchObject({
      appInstanceId: 'new-app',
      resourceInstanceId: 'new-resource',
      theme: 'warm',
      visible: false,
    });
    expect(view.webContents.loadURL).toHaveBeenCalledTimes(1);
    expect(f.window.contentView.removeChildView).toHaveBeenCalledWith(view);
  });
  it.each([
    'did-start-navigation',
    'did-fail-load',
    'did-navigate-in-page',
    'render-process-gone',
    'will-navigate',
    'will-frame-navigate',
    'will-redirect',
  ])('reports synchronous revocation on %s including failed/denied navigation', async (name) => {
    const f = fixture();
    await vi.waitFor(() => expect(f.owner.getFacts().trusted).toBe(true));
    const wc = native.contents[0] as EventEmitter;
    const preventDefault = vi.fn();
    const before = f.owner.getFacts().navigationEpoch;
    wc.emit(name, { preventDefault });
    expect(f.owner.getFacts().trusted).toBe(false);
    expect(f.owner.getFacts().navigationEpoch).toBeGreaterThan(before);
    expect(f.changed.mock.calls.at(-1)?.[0].trusted).toBe(false);
    if (name.startsWith('will-')) expect(preventDefault).toHaveBeenCalled();
  });
  it('requires actual registered sender and exact current top frame, never an equal-looking frame', async () => {
    const f = fixture();
    await vi.waitFor(() => expect(f.owner.getFacts().trusted).toBe(true));
    const wc = f.owner.view.webContents;
    const event = { sender: wc, senderFrame: wc.mainFrame } as IpcMainInvokeEvent;
    expect(f.owner.accepts(event)).toBe(true);
    expect(f.owner.accepts({ ...event, senderFrame: { ...wc.mainFrame } } as IpcMainInvokeEvent)).toBe(false);
    expect(f.owner.accepts({ ...event, sender: { ...wc } } as IpcMainInvokeEvent)).toBe(false);
    const frame = wc.mainFrame;
    for (const url of [
      'about:blank',
      'about:srcdoc',
      'wsl-editor://mota/other.html',
      'wsl-editor://mota/index.html?q=1',
      'wsl-editor://mota/index.html#x',
    ]) {
      Object.assign(frame, { url });
      expect(f.owner.accepts(event)).toBe(false);
    }
    Object.assign(frame, { url: 'wsl-editor://mota/index.html', routingId: 99 });
    expect(f.owner.accepts(event)).toBe(false);
    f.owner.dispose();
    expect(f.owner.accepts(event)).toBe(false);
  });
  it('cannot reactivate after asset failure even if a same-URL load event arrives', async () => {
    const f = fixture();
    await vi.waitFor(() => expect(f.owner.getFacts().trusted).toBe(true));
    f.invalidAssets();
    (native.contents[0] as EventEmitter).emit('did-finish-load');
    expect(f.owner.getFacts().trusted).toBe(false);
  });
});
