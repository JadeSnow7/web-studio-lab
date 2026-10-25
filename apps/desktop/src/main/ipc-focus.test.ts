import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { IpcMainInvokeEvent } from 'electron';
import { registerIpc, type IpcDeps } from './ipc';
import type { TrustedRenderer } from './ipc-guard';

/*
 * OPS-1 R9（B3）：采集完成并展开接收会话后，renderer 经 `shell.focusWorkbench` 请 Main 先把键盘焦点从原生网页
 * 交回工作台页面（`window.webContents.focus()`），再自己聚焦会话输入框。通道没有参数；来源照常核对；
 * 窗口不在前台或已销毁时不抢焦点并如实返回 false。
 */

const handlers = vi.hoisted(() => new Map<string, (event: IpcMainInvokeEvent, request: unknown) => unknown>());
vi.mock('electron', () => ({
  app: { getVersion: () => '0.0.0-test', isPackaged: false },
  dialog: {},
  ipcMain: {
    handle: (channel: string, handler: (event: IpcMainInvokeEvent, request: unknown) => unknown) => handlers.set(channel, handler),
    removeHandler: (channel: string) => handlers.delete(channel),
  },
}));

const FILE: TrustedRenderer = { kind: 'file', url: 'file:///renderer/index.html' };
const frame = { url: FILE.url };
let state: { destroyed: boolean; focused: boolean };
let focus: ReturnType<typeof vi.fn<() => void>>;
const mainContents = { mainFrame: frame, focus: () => focus() };
const trustedEvent = { sender: mainContents, senderFrame: frame } as unknown as IpcMainInvokeEvent;
const guestFrame = { url: 'wsl-demo://taskflow/index.html' };
const guestEvent = { sender: { mainFrame: guestFrame }, senderFrame: guestFrame } as unknown as IpcMainInvokeEvent;

beforeEach(() => {
  handlers.clear();
  state = { destroyed: false, focused: true };
  focus = vi.fn<() => void>();
  registerIpc({
    window: { isDestroyed: () => state.destroyed, isFocused: () => state.focused, webContents: mainContents },
    chat: {},
    trusted: FILE,
  } as unknown as IpcDeps);
});
const invoke = (request: unknown, event: IpcMainInvokeEvent = trustedEvent) =>
  Promise.resolve().then(() => handlers.get('shell:focus-workbench')!(event, request));

describe('shell:focus-workbench（R9）', () => {
  it('窗口在前台：聚焦工作台页面并返回 true', async () => {
    await expect(invoke(undefined)).resolves.toBe(true);
    expect(focus).toHaveBeenCalledTimes(1);
  });
  it('窗口不在前台：不抢焦点，返回 false；窗口已销毁时来源核对即拒绝', async () => {
    state.focused = false;
    await expect(invoke(undefined)).resolves.toBe(false);
    state.destroyed = true;
    await expect(invoke(undefined)).rejects.toThrow('拒绝来自非工作台页面的 IPC 请求');
    expect(focus).not.toHaveBeenCalled();
  });
  it('非工作台页面（如原生网页）发来的请求与带参数的请求被拒绝，不改变焦点', async () => {
    await expect(invoke(undefined, guestEvent)).rejects.toThrow('拒绝来自非工作台页面的 IPC 请求');
    await expect(invoke({ sessionId: 'x' })).rejects.toThrow();
    expect(focus).not.toHaveBeenCalled();
  });
});

describe('B5 browser focus IPC boundaries', () => {
  it('rejects foreign senders and malformed focus identities before invoking the owner', async () => {
    const restore = vi.fn().mockResolvedValue(true);
    registerIpc({
      window: { isDestroyed: () => false, isFocused: () => true, webContents: mainContents },
      trusted: FILE,
      chat: {},
      browserFocus: { nativeFocus: () => null, restoreBrowserFocus: restore },
    } as unknown as IpcDeps);
    const handler = handlers.get('shell:restore-browser-focus');
    if (!handler) throw new Error('missing focus restoration handler');
    await expect(
      Promise.resolve().then(() => handler(guestEvent, { workspaceId: 'w', resourceId: 'page', webContentsId: 2, documentGeneration: 1 })),
    ).rejects.toThrow('拒绝来自非工作台页面的 IPC 请求');
    await expect(
      Promise.resolve().then(() => handler(trustedEvent, { workspaceId: 'w', resourceId: 'page', webContentsId: -1 })),
    ).rejects.toThrow();
    expect(restore).not.toHaveBeenCalled();
  });
  it('returns owner refusal for stale or invisible identities and has no silent unconfigured fallback', async () => {
    const handler = handlers.get('shell:native-focus');
    if (!handler) throw new Error('missing native focus query');
    await expect(Promise.resolve().then(() => handler(trustedEvent, undefined))).rejects.toThrow('原生焦点服务不可用');
    const restore = vi.fn().mockResolvedValue(false);
    registerIpc({
      window: { isDestroyed: () => false, isFocused: () => false, webContents: mainContents },
      trusted: FILE,
      chat: {},
      browserFocus: { nativeFocus: () => null, restoreBrowserFocus: restore },
    } as unknown as IpcDeps);
    const restoreHandler = handlers.get('shell:restore-browser-focus');
    if (!restoreHandler) throw new Error('missing restore');
    const identity = { workspaceId: 'w', resourceId: 'page', webContentsId: 2, documentGeneration: 1 };
    await expect(restoreHandler(trustedEvent, identity)).resolves.toBe(false);
    expect(restore).toHaveBeenCalledWith(identity);
  });
});
