import { EventEmitter } from 'node:events';
import type { BrowserWindow } from 'electron';
import type { PageCapture } from '@wsl/protocol';
import { beforeEach, describe, expect, it, vi } from 'vitest';
const mocks = vi.hoisted(() => ({
  views: [] as unknown[],
  tools: [] as Array<
    EventEmitter & {
      webContents: EventEmitter & { id: number; isDestroyed(): boolean };
      destroy: ReturnType<typeof vi.fn>;
      isDestroyed(): boolean;
    }
  >,
  screenshot: vi.fn(),
}));
vi.mock('./element-summary', () => ({
  readElementSummary: vi.fn(async () => ({
    tagName: 'BUTTON',
    id: null,
    classes: [],
    role: null,
    ariaLabel: null,
    testId: null,
    text: 'fixture',
    selector: 'button',
    rect: null,
  })),
}));
vi.mock('electron', () => ({
  BrowserWindow: class extends EventEmitter {
    private destroyed = false;
    private frontendDestroyed = false;
    webContents = Object.assign(new EventEmitter(), { id: 99 + mocks.tools.length, isDestroyed: () => this.frontendDestroyed });
    show = vi.fn();
    focus = vi.fn();
    isDestroyed = () => this.destroyed;
    destroy = vi.fn(() => {
      this.webContents.emit('destroyed');
      this.emit('closed');
    });
    constructor() {
      super();
      this.webContents.on('destroyed', () => {
        this.frontendDestroyed = true;
      });
      this.on('closed', () => {
        this.destroyed = true;
      });
      mocks.tools.push(this);
    }
  },
  WebContentsView: class {
    webContents = Object.assign(new EventEmitter(), {
      id: 42,
      getURL: () => 'wsl-demo://taskflow/',
      getTitle: () => 'fixture',
      isLoading: () => false,
      session: {
        webRequest: { onBeforeRequest: vi.fn() },
        protocol: { handle: vi.fn(), unhandle: vi.fn() },
        on: vi.fn(),
        removeListener: vi.fn(),
      },
      debugger: Object.assign(new EventEmitter(), { isAttached: () => true, sendCommand: vi.fn(async () => ({})), detach: vi.fn() }),
      navigationHistory: { canGoBack: () => false, canGoForward: () => false },
      setWindowOpenHandler: vi.fn(),
      focus: vi.fn(),
      capturePage: mocks.screenshot,
      close: vi.fn(),
      setDevToolsWebContents: vi.fn(),
      openDevTools: vi.fn(),
    });
    constructor() {
      mocks.views.push(this);
    }
    setVisible = vi.fn();
    setBackgroundColor = vi.fn();
    setBounds = vi.fn();
    getBounds = () => ({ x: 0, y: 0, width: 100, height: 100 });
  },
}));
import { PreviewController } from './controller';
function setup() {
  const onCaptured = vi.fn();
  const onCaptureError = vi.fn();
  const onFocused = vi.fn();
  const controller = new PreviewController(
    { contentView: { addChildView: vi.fn(), removeChildView: vi.fn() } } as unknown as BrowserWindow,
    {
      partition: 'fixture',
      homeUrl: 'wsl-demo://taskflow/',
      allowedOrigins: ['wsl-demo://taskflow'],
      onState: vi.fn(),
      onCaptured,
      onCaptureError,
      onFocused,
    } as ConstructorParameters<typeof PreviewController>[1],
  );
  const view = mocks.views.at(-1) as {
    webContents: EventEmitter & {
      debugger: EventEmitter;
      setDevToolsWebContents: ReturnType<typeof vi.fn>;
      openDevTools: ReturnType<typeof vi.fn>;
      session: { webRequest: { onBeforeRequest: ReturnType<typeof vi.fn> } };
    };
  };
  controller.setLayout({ bounds: { x: 0, y: 0, width: 100, height: 100 }, visible: true });
  const pick = controller.startPick as unknown as (requestId: string) => Promise<void>;
  const inspect = () => view.webContents.debugger.emit('message', {}, 'Overlay.inspectNodeRequested', { backendNodeId: 1 });
  return { controller, view, onCaptured, onCaptureError, onFocused, pick: (id: string) => pick.call(controller, id), inspect };
}
const image = { toDataURL: () => 'data:image/png;base64,AA==', isEmpty: () => false };
beforeEach(() => {
  mocks.views.length = 0;
  mocks.tools.length = 0;
  mocks.screenshot.mockReset();
});
describe('R3/R4 controller request ownership baseline', () => {
  it('forwards native focus without layout updates manufacturing focus', () => {
    const { controller, view, onFocused } = setup();
    expect(onFocused).not.toHaveBeenCalled();
    view.webContents.emit('focus');
    expect(onFocused).toHaveBeenCalledOnce();
    controller.setLayout({ bounds: { x: 0, y: 0, width: 200, height: 100 }, visible: true });
    expect(onFocused).toHaveBeenCalledOnce();
  });
  it('ignores an old screenshot success after a replacement request and preserves new pick state', async () => {
    const { controller, pick, inspect, onCaptured } = setup();
    let finish!: (value: typeof image) => void;
    mocks.screenshot
      .mockImplementationOnce(
        () =>
          new Promise((resolve) => {
            finish = resolve;
          }),
      )
      .mockResolvedValue(image);
    await pick('old');
    inspect();
    await vi.waitFor(() => expect(mocks.screenshot).toHaveBeenCalledOnce());
    await pick('new');
    finish(image);
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(onCaptured).not.toHaveBeenCalled();
    expect(controller.getState().picking).toBe(true);
    inspect();
    await vi.waitFor(() => expect(onCaptured).toHaveBeenCalledOnce());
    expect(onCaptured).toHaveBeenCalledWith(expect.objectContaining({ captureId: expect.any(String) }) as PageCapture, 'new');
  });
  it('ignores an old screenshot failure after replacement without clearing or failing the new pick', async () => {
    const { controller, pick, inspect, onCaptureError } = setup();
    let fail!: (error: Error) => void;
    mocks.screenshot.mockImplementationOnce(
      () =>
        new Promise((_resolve, reject) => {
          fail = reject;
        }),
    );
    await pick('old');
    inspect();
    await vi.waitFor(() => expect(mocks.screenshot).toHaveBeenCalledOnce());
    await pick('new');
    fail(new Error('old screenshot failed'));
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(onCaptureError).not.toHaveBeenCalled();
    expect(controller.getState().pickError).toBeNull();
    expect(controller.getState().picking).toBe(true);
  });
  it.each(['cancel', 'navigation', 'dispose'])('invalidates in-flight capture on %s before screenshot completion', async (action) => {
    const { controller, view, pick, inspect, onCaptured } = setup();
    let finish!: (value: typeof image) => void;
    mocks.screenshot.mockImplementationOnce(
      () =>
        new Promise((resolve) => {
          finish = resolve;
        }),
    );
    await pick('old');
    inspect();
    await vi.waitFor(() => expect(mocks.screenshot).toHaveBeenCalledOnce());
    if (action === 'cancel') await controller.cancelPick();
    else if (action === 'navigation') view.webContents.emit('did-start-navigation', { isMainFrame: true, isSameDocument: false });
    else controller.dispose();
    finish(image);
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(onCaptured).not.toHaveBeenCalled();
  });
});

describe('R4 deferred inspect exit ownership', () => {
  it('does not report an old cancellation exit failure on a newer pick', async () => {
    const { controller, view, pick } = setup();
    const debuggerApi = view.webContents.debugger as unknown as { sendCommand: ReturnType<typeof vi.fn> };
    let fail!: (error: Error) => void;
    debuggerApi.sendCommand.mockImplementation((method: string, params: { mode?: string } | undefined) =>
      method === 'Overlay.setInspectMode' && params?.mode === 'none'
        ? new Promise((_resolve, reject) => {
            fail = reject;
          })
        : Promise.resolve({}),
    );
    await pick('old');
    await controller.cancelPick();
    await pick('new');
    fail(new Error('old exit failed'));
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(controller.getState().pickError).toBeNull();
    expect(controller.getState().picking).toBe(true);
  });
});

describe('R3 DevTools close boundary', () => {
  const bundledRequestAllowed = (view: ReturnType<typeof setup>['view'], id: number) => {
    const callback = vi.fn();
    view.webContents.session.webRequest.onBeforeRequest.mock.calls[0]![0](
      { webContentsId: id, method: 'GET', url: 'devtools://devtools/bundled/devtools_app.html', resourceType: 'mainFrame' },
      callback,
    );
    return callback.mock.calls[0]![0].cancel === false;
  };

  it('establishes owner identity before loading, reuses an open frontend, and disposes it', async () => {
    const { controller, view } = setup();
    const contents = view.webContents;
    contents.openDevTools.mockImplementation(() => expect(bundledRequestAllowed(view, mocks.tools.at(-1)!.webContents.id)).toBe(true));
    await controller.openDevTools();
    const tools = mocks.tools.at(-1)!;
    expect(contents.setDevToolsWebContents).toHaveBeenCalledWith(tools.webContents);
    expect(contents.setDevToolsWebContents.mock.invocationCallOrder[0]).toBeLessThan(contents.openDevTools.mock.invocationCallOrder[0]!);
    await controller.openDevTools();
    expect(contents.openDevTools).toHaveBeenCalledOnce();
    expect(mocks.tools).toHaveLength(1);
    controller.dispose();
    expect(tools.destroy).toHaveBeenCalledOnce();
  });

  it.each([
    ['destroyed', 'window', 'owner'],
    ['window', 'owner'],
    ['owner', 'window'],
  ])('waits for both close signals in order %j', async (...order) => {
    const { controller, view } = setup();
    await controller.openDevTools();
    const old = mocks.tools[0]!;
    const oldId = old.webContents.id;
    const signal = (event: string) => {
      if (event === 'destroyed') old.webContents.emit('destroyed');
      else if (event === 'window') old.emit('closed');
      else view.webContents.emit('devtools-closed');
    };
    signal(order[0]!);
    const completed = vi.fn();
    const opening = Promise.resolve(controller.openDevTools()).then(completed);
    await Promise.resolve();
    expect(completed).not.toHaveBeenCalled();
    expect(mocks.tools).toHaveLength(1);
    Object.defineProperty(old.webContents, 'id', {
      get: () => {
        throw new Error('Destroyed native wrapper accessed');
      },
    });
    expect(bundledRequestAllowed(view, oldId)).toBe(false);
    for (const event of order.slice(1, -1)) {
      signal(event);
      await Promise.resolve();
      expect(completed).not.toHaveBeenCalled();
      expect(mocks.tools).toHaveLength(1);
    }
    signal(order.at(-1)!);
    await opening;
    expect(mocks.tools).toHaveLength(2);
    const replacement = mocks.tools[1]!;
    expect(replacement.webContents.id).not.toBe(oldId);
    expect(view.webContents.setDevToolsWebContents).toHaveBeenLastCalledWith(replacement.webContents);
    expect(bundledRequestAllowed(view, replacement.webContents.id)).toBe(true);
    expect(bundledRequestAllowed(view, oldId)).toBe(false);
    controller.dispose();
  });

  it('coalesces two opens while closing and ignores late callbacks from the old frontend', async () => {
    const { controller, view } = setup();
    await controller.openDevTools();
    const old = mocks.tools[0]!;
    const lateWindowClosed = old.listeners('closed').at(-1)!;
    const lateOwnerClosed = view.webContents.listeners('devtools-closed').at(-1)!;
    old.emit('closed');
    const first = controller.openDevTools();
    const second = controller.openDevTools();
    expect(mocks.tools).toHaveLength(1);
    view.webContents.emit('devtools-closed');
    await Promise.all([first, second]);
    expect(mocks.tools).toHaveLength(2);
    expect(view.webContents.openDevTools).toHaveBeenCalledTimes(2);
    lateWindowClosed();
    lateOwnerClosed();
    await controller.openDevTools();
    expect(mocks.tools).toHaveLength(2);
    expect(bundledRequestAllowed(view, mocks.tools[1]!.webContents.id)).toBe(true);
    expect(view.webContents.listenerCount('devtools-closed')).toBe(1);
    controller.dispose();
  });

  it('settles pending opens on dispose without reviving a frontend after late close signals', async () => {
    const { controller, view } = setup();
    await controller.openDevTools();
    const old = mocks.tools[0]!;
    const lateWindowClosed = old.listeners('closed').at(-1)!;
    const lateOwnerClosed = view.webContents.listeners('devtools-closed').at(-1)!;
    old.webContents.emit('destroyed');
    const first = controller.openDevTools();
    const second = controller.openDevTools();
    controller.dispose();
    await Promise.all([first, second]);
    lateWindowClosed();
    lateOwnerClosed?.();
    await controller.openDevTools();
    expect(mocks.tools).toHaveLength(1);
    expect(view.webContents.openDevTools).toHaveBeenCalledOnce();
    expect(view.webContents.listenerCount('devtools-closed')).toBe(0);
    expect(view.webContents.listenerCount('focus')).toBe(1);
  });
});
