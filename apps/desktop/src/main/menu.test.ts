import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { BrowserWindow, MenuItemConstructorOptions, PopupOptions } from 'electron';
import { installAppMenu, nativeMenuHost } from './menu';

/*
 * 原生菜单的生产宿主（OPS-1 S5）：菜单必须弹在工作台窗口上，坐标与关闭回调原样转交；
 * 窗口关闭、页面导航或 renderer 退出时通知服务；关闭时对同一窗口调用 closePopup。
 */

type FakeMenu = { template: MenuItemConstructorOptions[]; popup: ReturnType<typeof vi.fn>; closePopup: ReturnType<typeof vi.fn> };
const focused = vi.hoisted(() => ({ window: null as BrowserWindow | null }));
const built = vi.hoisted(() => [] as FakeMenu[]);
vi.mock('electron', () => ({
  BrowserWindow: { getFocusedWindow: () => focused.window },
  app: { name: 'Web Studio Lab' },
  Menu: {
    buildFromTemplate: (template: MenuItemConstructorOptions[]) => {
      const menu = { template, popup: vi.fn(), closePopup: vi.fn() };
      built.push(menu);
      return menu;
    },
    setApplicationMenu: vi.fn(),
  },
}));
vi.mock('./ipc', () => ({ sendToRenderer: vi.fn() }));

type Listener = (...args: unknown[]) => void;
function fakeWindow() {
  const windowListeners = new Map<string, Listener[]>();
  const contentsListeners = new Map<string, Listener[]>();
  const on = (map: Map<string, Listener[]>) => (event: string, listener: Listener) => {
    map.set(event, [...(map.get(event) ?? []), listener]);
  };
  const state = { destroyed: false };
  const window = {
    isDestroyed: () => state.destroyed,
    getContentSize: () => [1280, 800],
    on: on(windowListeners),
    close: vi.fn(),
    webContents: { on: on(contentsListeners), focus: vi.fn(), openDevTools: vi.fn() },
  };
  const emit = (map: Map<string, Listener[]>, event: string, ...args: unknown[]) =>
    map.get(event)?.forEach((listener) => listener(...args));
  return {
    window: window as unknown as BrowserWindow,
    state,
    emitWindow: (event: string, ...args: unknown[]) => emit(windowListeners, event, ...args),
    emitContents: (event: string, ...args: unknown[]) => emit(contentsListeners, event, ...args),
  };
}

beforeEach(() => {
  built.length = 0;
});

describe('nativeMenuHost', () => {
  it('在工作台窗口上弹出：window、坐标原样转交；关闭回调先释放引用再通知服务', () => {
    const { window } = fakeWindow();
    const host = nativeMenuHost(window);
    const callback = vi.fn();
    host.popup([{ label: '网页' }], { x: 12, y: 34, callback });
    expect(built).toHaveLength(1);
    expect(built[0]!.template).toEqual([{ label: '网页' }]);
    const options = built[0]!.popup.mock.calls[0]![0] as PopupOptions;
    expect(options.window).toBe(window);
    expect(options).toMatchObject({ x: 12, y: 34 });
    expect(callback).not.toHaveBeenCalled();
    options.callback?.();
    expect(callback).toHaveBeenCalledTimes(1);
    // 已关闭的菜单不再被 close() 关闭。
    host.close();
    expect(built[0]!.closePopup).not.toHaveBeenCalled();
  });

  it('close() 对仍打开的菜单调用 closePopup(工作台窗口)', () => {
    const { window } = fakeWindow();
    const host = nativeMenuHost(window);
    host.popup([{ label: '日志' }], { callback: vi.fn() });
    host.close();
    expect(built[0]!.closePopup).toHaveBeenCalledWith(window);
    host.close();
    expect(built[0]!.closePopup).toHaveBeenCalledTimes(1);
  });

  it('内容区尺寸来自窗口；窗口已销毁时没有尺寸，且拒绝弹出', () => {
    const { window, state } = fakeWindow();
    const host = nativeMenuHost(window);
    expect(host.contentSize()).toEqual({ width: 1280, height: 800 });
    state.destroyed = true;
    expect(host.contentSize()).toBeNull();
    expect(() => host.popup([{ label: 'x' }], { callback: vi.fn() })).toThrow('工作台窗口已关闭');
    expect(built).toHaveLength(0);
  });

  it('窗口关闭、renderer 退出、主框架跨文档导航时通知；同文档导航与子 frame 导航不通知', () => {
    const { window, emitWindow, emitContents } = fakeWindow();
    const host = nativeMenuHost(window);
    const listener = vi.fn();
    host.onInvalidated(listener);
    emitContents('did-start-navigation', { isMainFrame: true, isSameDocument: true });
    emitContents('did-start-navigation', { isMainFrame: false, isSameDocument: false });
    expect(listener).not.toHaveBeenCalled();
    emitContents('did-start-navigation', { isMainFrame: true, isSameDocument: false });
    expect(listener).toHaveBeenCalledTimes(1);
    emitContents('render-process-gone', {}, {}, { reason: 'crashed' });
    expect(listener).toHaveBeenCalledTimes(2);
    emitWindow('closed');
    expect(listener).toHaveBeenCalledTimes(3);
  });
});

function menuItems(template: MenuItemConstructorOptions[]): MenuItemConstructorOptions[] {
  return template.flatMap((item) => [item, ...(Array.isArray(item.submenu) ? menuItems(item.submenu) : [])]);
}
describe('OPS B5 focused-window accelerators', () => {
  it('all application accelerators ignore another focused window, including reload/devtools/diagnostic', async () => {
    const { window } = fakeWindow();
    const preview = { reload: vi.fn(), openDevTools: vi.fn(), nativeFocus: vi.fn(() => null) };
    const { sendToRenderer } = await import('./ipc');
    vi.mocked(sendToRenderer).mockClear();
    installAppMenu(window, preview, { debugStatus: true });
    focused.window = null;
    const items = menuItems(built.at(-1)?.template ?? []);
    for (const item of items.filter((item) => item.accelerator && item.click)) Reflect.apply(item.click!, null, []);
    expect(sendToRenderer).not.toHaveBeenCalled();
    expect(preview.reload).not.toHaveBeenCalled();
    expect(preview.openDevTools).not.toHaveBeenCalled();
    expect(window.close).not.toHaveBeenCalled();
  });
  it('freezes native focus without moving it; CmdW closes a tab and ShiftCmdW alone closes the window', async () => {
    const { window } = fakeWindow();
    const nativeBrowser = { workspaceId: 'w', resourceId: 'page', webContentsId: 42, documentGeneration: 1 };
    const preview = { reload: vi.fn(), openDevTools: vi.fn(), nativeFocus: () => nativeBrowser };
    const { sendToRenderer } = await import('./ipc');
    vi.mocked(sendToRenderer).mockClear();
    focused.window = window;
    installAppMenu(window, preview);
    const items = menuItems(built.at(-1)?.template ?? []);
    const commands = items.filter((item) => item.accelerator && item.click);
    expect(commands.map((item) => item.accelerator)).toEqual(
      expect.arrayContaining([
        'CmdOrCtrl+T',
        'CmdOrCtrl+W',
        'CmdOrCtrl+Shift+W',
        'CmdOrCtrl+K',
        'CmdOrCtrl+E',
        'CmdOrCtrl+\\',
        'CmdOrCtrl+.',
        ...Array.from({ length: 9 }, (_, i) => `CmdOrCtrl+${i + 1}`),
      ]),
    );
    expect(items.some((item) => item.role === 'windowMenu')).toBe(false);
    for (const item of commands.filter((item) => item.accelerator === 'CmdOrCtrl+W' || item.accelerator === 'CmdOrCtrl+E'))
      Reflect.apply(item.click!, null, []);
    expect(sendToRenderer).toHaveBeenCalledWith(window, 'shell:command', { command: 'close-tab', nativeBrowser });
    expect(sendToRenderer).toHaveBeenCalledWith(window, 'shell:command', { command: 'toggle-capture', nativeBrowser });
    expect(window.webContents.focus).not.toHaveBeenCalled();
    expect(window.close).not.toHaveBeenCalled();
    const close = commands.find((item) => item.accelerator === 'CmdOrCtrl+Shift+W');
    if (!close?.click) throw new Error('missing close window menu item');
    Reflect.apply(close.click, null, []);
    expect(window.close).toHaveBeenCalledTimes(1);
  });
});
