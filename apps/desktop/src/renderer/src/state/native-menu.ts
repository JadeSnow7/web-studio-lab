import type { MenuAnchor, NativeMenuChoice, NativeMenuContext, NativeMenuId, WorkbenchSnapshot, WorkbenchTab } from '@wsl/protocol';
import { createStore, useStore } from '../lib/store';
import { reportError } from './errors';
import { workspaceCommandsSettled, workspaceStore, workspaceSwitchPending, type WorkspaceCommandPayload } from './workspace';
import type { RunView } from '../workspace/RunDetails';

/*
 * 原生菜单（OPS-1 S5）的 renderer 一侧：只提交菜单类型与身份上下文，拿到 Main 返回的选择与冻结目标后决定动作。
 * 菜单本身不执行业务：业务动作调用既有 workbench / 资源命令，并使用冻结目标里的空间（不是当前活动空间）；
 * 依赖布局或排序的动作带上菜单打开时的空间版本，布局已变时由 Main 以版本冲突拒绝；
 * 只影响展示的动作（打开表单、切换视图等）在空间已切换或切换进行中时丢弃（O08b）。
 */

type Choice<M extends NativeMenuId> = Extract<NativeMenuChoice, { menuId: M }>;
/** 计算动作所需的 renderer 视图：Main 快照投影、当前选中的空间，以及空间切换是否进行中。 */
export interface MenuView {
  snapshot: WorkbenchSnapshot | null;
  selectedId: string | null;
  switching?: boolean;
}
/** 当前的 renderer 视图（执行菜单选择时读取）。 */
export function menuView(): MenuView {
  const { snapshot, selectedId } = workspaceStore.get();
  return { snapshot, selectedId, switching: workspaceSwitchPending() };
}
export interface CommandEffect {
  kind: 'command';
  workspaceId: string;
  payload: WorkspaceCommandPayload;
  /** 菜单打开时的空间版本：带上它的命令在布局 / 排序已变化时被 Main 以版本冲突拒绝。 */
  revision?: number;
}

/** 由 click 打开：Enter / 空格触发的 click（detail = 0）定位在触发元素下方，鼠标点击定位在指针处（R3）。 */
export function menuAnchorFromClick(
  event: { detail: number; clientX: number; clientY: number },
  element: { getBoundingClientRect(): { x: number; y: number; width: number; height: number } },
): MenuAnchor {
  if (event.detail === 0) {
    const { x, y, width, height } = element.getBoundingClientRect();
    return { x, y, width, height };
  }
  return menuAnchorFromPointer(event);
}
/** 右键打开：定位在指针处。 */
export function menuAnchorFromPointer(event: { clientX: number; clientY: number }): MenuAnchor {
  return { x: event.clientX, y: event.clientY, width: 0, height: 0 };
}

/** 哪个触发器的菜单正在等待选择（展示状态，供各触发器的 aria-expanded 使用）。 */
export const nativeMenuStore = createStore<{ open: string | null }>({ open: null });
/** 触发器身份：菜单类型 + 空间 + 菜单作用的对象。 */
export function nativeMenuKey<M extends NativeMenuId>(menuId: M, context: NativeMenuContext<M>): string {
  const owner =
    'tabId' in context
      ? context.tabId
      : 'paneId' in context
        ? context.paneId
        : 'sessionId' in context
          ? context.sessionId
          : 'resourceId' in context
            ? context.resourceId
            : '';
  return `${menuId}:${context.workspaceId}:${owner}`;
}
/** 该触发器的菜单是否正在打开（用于 aria-expanded）。 */
export function useNativeMenuExpanded(key: string): boolean {
  return useStore(nativeMenuStore, (s) => s.open === key);
}

/**
 * 请求 Main 弹出原生菜单；被拒绝或失败时登记一次界面错误并按取消处理。
 * 同一时刻只等待一个菜单：前一个菜单尚未结束时（如连点触发器）新的请求不再发出。
 * 请求前先等本 renderer 对该空间已发出的命令有结果，Main 冻结的版本才包含它们。标记在 finally 中清除，不会卡住。
 */
export async function openNativeMenu<M extends NativeMenuId>(menuId: M, context: NativeMenuContext<M>): Promise<NativeMenuChoice | null> {
  if (nativeMenuStore.get().open !== null) return null;
  const key = nativeMenuKey(menuId, context);
  nativeMenuStore.set(() => ({ open: key }));
  try {
    await workspaceCommandsSettled(context.workspaceId);
    return await window.studio.shell.showMenu(menuId, context);
  } catch (error) {
    reportError('打开菜单', error);
    return null;
  } finally {
    nativeMenuStore.set((s) => (s.open === key ? { open: null } : s));
  }
}

/** 展示动作只在冻结目标仍是当前空间、且没有空间切换进行中时执行。 */
const sameSpace = (view: MenuView, workspaceId: string) =>
  !view.switching && view.selectedId === workspaceId && (view.snapshot === null || view.snapshot.activeWorkspaceId === workspaceId);

export function tabMenuEffect(
  choice: Choice<'tab'>,
  view: MenuView,
): CommandEffect | { kind: 'rename' | 'group'; workspaceId: string; tabId: string } | null {
  const { workspaceId, tabId, paneId, revision } = choice.target;
  const command = (payload: WorkspaceCommandPayload, frozen?: number): CommandEffect => ({
    kind: 'command',
    workspaceId,
    payload,
    ...(frozen === undefined ? {} : { revision: frozen }),
  });
  switch (choice.itemId) {
    case 'pin':
    case 'unpin':
      return command({ type: 'updateTab', tabId, pinned: choice.itemId === 'pin' });
    case 'ungroup':
      return command({ type: 'updateTab', tabId, group: null });
    case 'close-tab':
      return command({ type: 'closeTab', tabId });
    case 'move-up':
    case 'move-down': {
      const tabs: WorkbenchTab[] = view.snapshot?.workspaces.find((w) => w.workspaceId === workspaceId)?.tabs ?? [];
      const ids = tabs.map((tab) => tab.tabId);
      const from = ids.indexOf(tabId);
      const to = from + (choice.itemId === 'move-up' ? -1 : 1);
      const moving = ids[from];
      const neighbour = ids[to];
      if (from < 0 || moving === undefined || neighbour === undefined) return null;
      return command(
        { type: 'reorderTabs', tabIds: ids.map((id, index) => (index === from ? neighbour : index === to ? moving : id)) },
        revision,
      );
    }
    case 'open-right':
    case 'open-below':
      return command({ type: 'splitPane', paneId, direction: choice.itemId === 'open-right' ? 'horizontal' : 'vertical', tabId }, revision);
    case 'rename':
      return sameSpace(view, workspaceId) ? { kind: 'rename', workspaceId, tabId } : null;
    case 'set-group':
      return sameSpace(view, workspaceId) ? { kind: 'group', workspaceId, tabId } : null;
  }
}

/** 窗格动作都依赖布局：一律带菜单打开时的版本，按冻结目标的空间执行。 */
export function paneMenuEffect(choice: Choice<'pane'>): CommandEffect {
  const { workspaceId, paneId, revision } = choice.target;
  const payload: WorkspaceCommandPayload =
    choice.itemId === 'split-right'
      ? { type: 'splitPane', paneId, direction: 'horizontal' }
      : choice.itemId === 'split-below'
        ? { type: 'splitPane', paneId, direction: 'vertical' }
        : choice.itemId === 'equalize'
          ? { type: 'setRatio', paneId, ratio: 0.5 }
          : { type: 'closePane', paneId };
  return { kind: 'command', workspaceId, payload, revision };
}

export function runRecordsMenuEffect(choice: Choice<'run-records'>, view: MenuView): { kind: 'view'; view: RunView } | null {
  return sameSpace(view, choice.target.workspaceId) ? { kind: 'view', view: choice.itemId } : null;
}

export type CatalogEffectPayload =
  | { type: 'bookmarkRuntimeResource'; workspaceId: string; runtimeResourceId: string }
  | { type: 'captureResourceRevision'; workspaceId: string; runtimeResourceId: string };
export function webMoreMenuEffect(
  choice: Choice<'web-more'>,
  view: MenuView,
):
  | { kind: 'catalog'; action: 'bookmark' | 'snapshot'; payload: CatalogEffectPayload }
  | { kind: 'manage-app' | 'show-resources'; workspaceId: string }
  | null {
  const { workspaceId, resourceId } = choice.target;
  switch (choice.itemId) {
    case 'bookmark':
      return {
        kind: 'catalog',
        action: 'bookmark',
        payload: { type: 'bookmarkRuntimeResource', workspaceId, runtimeResourceId: resourceId },
      };
    case 'snapshot':
      return {
        kind: 'catalog',
        action: 'snapshot',
        payload: { type: 'captureResourceRevision', workspaceId, runtimeResourceId: resourceId },
      };
    case 'manage-app':
    case 'show-resources':
      return sameSpace(view, workspaceId) ? { kind: choice.itemId, workspaceId } : null;
  }
}

/**
 * 采集接收者（OPS-1 S1）：选择会话只设定之后采集的接收者（显式选择，展示状态）；「新建会话」新建一个不占用窗格的会话并设为接收者；
 * 「打开接收会话」定位它。都不开始采集（采集由「选择元素」发起）。空间已切换时都丢弃。
 */
export function captureReceiverMenuEffect(
  choice: Choice<'capture-receiver'>,
  view: MenuView,
):
  | { kind: 'choose'; workspaceId: string; resourceId: string; sessionId: string }
  | { kind: 'create'; workspaceId: string; resourceId: string }
  | { kind: 'open'; workspaceId: string; sessionId: string }
  | null {
  const { workspaceId, resourceId, sessionId } = choice.target;
  if (!sameSpace(view, workspaceId)) return null;
  if (choice.itemId === 'new-session') return { kind: 'create', workspaceId, resourceId };
  if (sessionId === null) return null;
  return choice.itemId === 'session' ? { kind: 'choose', workspaceId, resourceId, sessionId } : { kind: 'open', workspaceId, sessionId };
}

export function newTabMenuEffect(
  choice: Choice<'new-tab'>,
  view: MenuView,
): { kind: 'create'; workspaceId: string; tabKind: Choice<'new-tab'>['itemId'] } | null {
  return sameSpace(view, choice.target.workspaceId)
    ? { kind: 'create', workspaceId: choice.target.workspaceId, tabKind: choice.itemId }
    : null;
}
