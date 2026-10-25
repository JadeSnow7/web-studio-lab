import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { IpcMainInvokeEvent, MenuItemConstructorOptions } from 'electron';
import { NativeMenuChoiceSchema, ShowMenuRequestSchema, type WorkbenchSnapshot } from '@wsl/protocol';
import { registerIpc, type IpcDeps } from './ipc';
import type { TrustedRenderer } from './ipc-guard';
import { NativeMenuService, type NativeMenuPopupOptions } from './native-menu';

/*
 * OPS-1 S5 / O08b：`shell:show-menu` 在 IPC 边界核对可信来源并严格校验菜单类型与上下文；
 * 非法请求不进入菜单服务，也不显示菜单。
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
const mainContents = { mainFrame: frame };
const trustedEvent = { sender: mainContents, senderFrame: frame } as unknown as IpcMainInvokeEvent;

const snapshot: WorkbenchSnapshot = {
  appInstanceId: 'app',
  storageError: null,
  activeWorkspaceId: 'A',
  seq: 1,
  workspaces: [
    {
      workspaceId: 'A',
      name: '空间 A',
      revision: 2,
      tabs: [
        { tabId: 'tab-1', title: '网页', pinned: false, group: null, targetRef: { kind: 'web', resourceId: 'web-1' }, autoTitle: false },
      ],
      resources: [],
      layout: { kind: 'pane', paneId: 'pane-1', tabId: 'tab-1' },
      activePaneId: 'pane-1',
      sessions: [],
      runs: [],
      fileHints: [],
      observations: [],
      theme: 'light',
    },
  ],
  environments: [],
  notificationReadReceipts: [],
  notifications: [],
};

let popups: Array<{ template: MenuItemConstructorOptions[]; options: NativeMenuPopupOptions }>;
beforeEach(() => {
  handlers.clear();
  popups = [];
  const menus = new NativeMenuService({
    host: {
      contentSize: () => ({ width: 1200, height: 800 }),
      popup: (template, options) => popups.push({ template, options }),
      close: () => undefined,
      onInvalidated: () => undefined,
    },
    snapshot: async () => structuredClone(snapshot),
  });
  registerIpc({
    window: { isDestroyed: () => false, webContents: mainContents },
    chat: {},
    trusted: FILE,
    menus,
  } as unknown as IpcDeps);
});
const invoke = (request: unknown, event: IpcMainInvokeEvent = trustedEvent) =>
  Promise.resolve().then(() => handlers.get('shell:show-menu')!(event, request));

describe('shell:show-menu 边界（O08b）', () => {
  it('通道已注册；合法请求显示菜单，click 后返回经响应 schema 校验的选择', async () => {
    expect(handlers.has('shell:show-menu')).toBe(true);
    const result = invoke({ menuId: 'new-tab', context: { workspaceId: 'A', anchor: { x: 10, y: 20, width: 30, height: 10 } } });
    await vi.waitFor(() => expect(popups).toHaveLength(1));
    expect(popups[0]!.options).toMatchObject({ x: 10, y: 30 });
    (popups[0]!.template.find((item) => item.label === '终端')!.click as () => void)();
    const choice = await result;
    expect(NativeMenuChoiceSchema.parse(choice)).toEqual({ menuId: 'new-tab', itemId: 'terminal', target: { workspaceId: 'A' } });
  });

  it('同一窗口同时只有一个菜单：前一个未决时第二个请求以 conflict 拒绝，且不再弹出', async () => {
    const first = invoke({ menuId: 'new-tab', context: { workspaceId: 'A' } });
    await vi.waitFor(() => expect(popups).toHaveLength(1));
    await expect(invoke({ menuId: 'tab', context: { workspaceId: 'A', tabId: 'tab-1' } })).rejects.toThrow(/conflict/);
    expect(popups).toHaveLength(1);
    popups[0]!.options.callback();
    await expect(first).resolves.toBeNull();
    // 前一个结束后可以再打开。
    void invoke({ menuId: 'new-tab', context: { workspaceId: 'A' } });
    await vi.waitFor(() => expect(popups).toHaveLength(2));
  });

  it('关闭而未选择时返回 null', async () => {
    const result = invoke({ menuId: 'tab', context: { workspaceId: 'A', tabId: 'tab-1' } });
    await vi.waitFor(() => expect(popups).toHaveLength(1));
    popups[0]!.options.callback();
    await expect(result).resolves.toBeNull();
  });

  it.each([
    // 同一工作台 webContents 里的子 frame（地址可信，但不是顶层 frame）。
    ['子 frame', { sender: mainContents, senderFrame: { url: FILE.url } }],
    // Browser 区网页自己的 webContents。
    ['Browser 区网页', { sender: { mainFrame: { url: 'https://example.com/' } }, senderFrame: { url: 'https://example.com/' } }],
  ])('非可信来源（%s）被拒绝且不显示菜单', async (_name, event) => {
    const forged = event as unknown as IpcMainInvokeEvent;
    await expect(invoke({ menuId: 'new-tab', context: { workspaceId: 'A' } }, forged)).rejects.toThrow('拒绝来自非工作台页面的 IPC 请求');
    expect(popups).toHaveLength(0);
  });

  it.each([
    ['未知 menuId', { menuId: 'debug', context: { workspaceId: 'A' } }],
    ['缺少 context', { menuId: 'new-tab' }],
    ['上下文混用其他菜单的字段', { menuId: 'new-tab', context: { workspaceId: 'A', tabId: 'tab-1' } }],
    ['renderer 注入菜单文字', { menuId: 'tab', context: { workspaceId: 'A', tabId: 'tab-1', label: '删除全部' } }],
    ['renderer 注入菜单项', { menuId: 'new-tab', context: { workspaceId: 'A', items: [{ id: 'x', label: 'x' }] } }],
    ['请求顶层多余字段', { menuId: 'new-tab', context: { workspaceId: 'A' }, itemId: 'web' }],
    ['锚点不是有限数', { menuId: 'new-tab', context: { workspaceId: 'A', anchor: { x: Number.NaN, y: 0, width: 0, height: 0 } } }],
    ['锚点多余字段', { menuId: 'new-tab', context: { workspaceId: 'A', anchor: { x: 0, y: 0, width: 0, height: 0, screen: 1 } } }],
    ['采集接收者缺少 receiverSessionId', { menuId: 'capture-receiver', context: { workspaceId: 'A', resourceId: 'web-1' } }],
  ])('schema 拒绝：%s', async (_name, value) => {
    expect(ShowMenuRequestSchema.safeParse(value).success).toBe(false);
    await expect(invoke(value)).rejects.toThrow();
    expect(popups).toHaveLength(0);
  });

  it('他空间或未知身份在 Main 快照核对时被拒绝，不显示菜单', async () => {
    await expect(invoke({ menuId: 'tab', context: { workspaceId: 'A', tabId: 'tab-elsewhere' } })).rejects.toThrow(/not_found/);
    await expect(invoke({ menuId: 'pane', context: { workspaceId: 'Z', paneId: 'pane-1' } })).rejects.toThrow(/not_found/);
    expect(popups).toHaveLength(0);
  });

  it('响应 schema 只接受协议内固定的 itemId 与严格目标', () => {
    expect(
      NativeMenuChoiceSchema.safeParse({
        menuId: 'tab',
        itemId: 'delete-all',
        target: { workspaceId: 'A', tabId: 't', paneId: 'p', revision: 1 },
      }).success,
    ).toBe(false);
    expect(
      NativeMenuChoiceSchema.safeParse({ menuId: 'new-tab', itemId: 'web', target: { workspaceId: 'A', tabId: 'extra' } }).success,
    ).toBe(false);
  });
});
