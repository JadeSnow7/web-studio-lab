import type { MenuItemConstructorOptions } from 'electron';
import {
  NativeMenuChoiceSchema,
  type MenuAnchor,
  type NativeMenuChoice,
  type ShowMenuRequest,
  type WorkbenchSnapshot,
  type WorkspaceSnapshot,
} from '@wsl/protocol';
import { panes } from './workbench/layout';

/**
 * Main 原生菜单（OPS-1 S5）：按 Main 当前快照构建菜单，经 Electron `Menu.popup()` 展示，
 * 返回所选菜单项与冻结的目标，取消返回 null。菜单本身不执行业务，renderer 拿到选择后调用既有命令。
 */

export interface NativeMenuPopupOptions {
  /** 窗口内容区坐标；缺省时由系统放在指针处。 */
  x?: number;
  y?: number;
  /** 菜单关闭时调用（选择或取消都会调用；macOS 上可能早于菜单项的 click）。 */
  callback: () => void;
}

/** 展示菜单的宿主：生产环境是 BrowserWindow + Menu（menu.ts），单测用假宿主记录模板与弹出选项。 */
export interface NativeMenuHost {
  /** 窗口内容区大小（与 renderer 的 CSS 像素同一坐标系）；窗口已销毁时为 null。 */
  contentSize(): { width: number; height: number } | null;
  popup(template: MenuItemConstructorOptions[], options: NativeMenuPopupOptions): void;
  /** 关闭当前弹出的菜单（没有时不做任何事）。 */
  close(): void;
  /** 窗口关闭、工作台页面重新加载 / 导航或 renderer 进程退出时调用：此后不会再有菜单结果送达原页面。 */
  onInvalidated(listener: () => void): void;
}

/** checked：作为单选项显示并标出当前项（运行记录的当前视图、采集菜单的当前接收会话）。 */
type Entry = { label: string; enabled: boolean; checked?: boolean; choice: NativeMenuChoice } | 'separator';

/** 四窗格上限，与 workbench/layout.ts 的 splitPane 一致。 */
const MAX_PANES = 4;

function reject(code: 'not_found' | 'denied', message: string): never {
  throw new Error(`${code}: ${message}`);
}

/** 在给定空间内查找；找不到时区分“属于其他空间”（denied）与“不存在”（not_found）。 */
function owned<T>(
  snapshot: WorkbenchSnapshot,
  workspace: WorkspaceSnapshot,
  find: (w: WorkspaceSnapshot) => T | undefined,
  what: string,
): T {
  const found = find(workspace);
  if (found !== undefined) return found;
  if (snapshot.workspaces.some((other) => other.workspaceId !== workspace.workspaceId && find(other) !== undefined))
    reject('denied', `${what}不属于此空间`);
  return reject('not_found', `${what}不存在`);
}

/** 按 Main 快照核对上下文身份并构建菜单条目；身份不属于该空间、空间不是活动空间或不存在时拒绝。 */
export function buildNativeMenu(snapshot: WorkbenchSnapshot, request: ShowMenuRequest): Entry[] {
  const workspace = snapshot.workspaces.find((w) => w.workspaceId === request.context.workspaceId);
  if (!workspace) return reject('not_found', '空间不存在');
  if (snapshot.activeWorkspaceId !== workspace.workspaceId) reject('denied', '只能为活动空间打开菜单');
  const { workspaceId, revision } = workspace;
  const leaves = panes(workspace.layout);
  switch (request.menuId) {
    case 'tab': {
      const tab = owned(snapshot, workspace, (w) => w.tabs.find((t) => t.tabId === request.context.tabId), '标签');
      const index = workspace.tabs.indexOf(tab);
      const target = { workspaceId, tabId: tab.tabId, paneId: workspace.activePaneId, revision };
      const item = (itemId: Extract<NativeMenuChoice, { menuId: 'tab' }>['itemId'], label: string, enabled = true): Entry => ({
        label,
        enabled,
        choice: { menuId: 'tab', itemId, target },
      });
      // 已在某个窗格显示的标签不能再在旁边打开（splitPane 会以冲突拒绝）；四窗格时不能再分屏。
      const openBeside = leaves.length < MAX_PANES && !leaves.some((pane) => pane.tabId === tab.tabId);
      return [
        tab.pinned ? item('unpin', '取消置顶') : item('pin', '置顶标签'),
        item('rename', '重命名'),
        item('set-group', '设置分组'),
        item('ungroup', '移出分组', tab.group !== null),
        'separator',
        item('move-up', '向上移动', index > 0),
        item('move-down', '向下移动', index < workspace.tabs.length - 1),
        'separator',
        item('open-right', '在右侧打开', openBeside),
        item('open-below', '在下方打开', openBeside),
        'separator',
        item('close-tab', '关闭标签（保留后台执行）'),
      ];
    }
    case 'pane': {
      const pane = owned(snapshot, workspace, (w) => panes(w.layout).find((p) => p.paneId === request.context.paneId), '窗格');
      const target = { workspaceId, paneId: pane.paneId, revision };
      const item = (itemId: Extract<NativeMenuChoice, { menuId: 'pane' }>['itemId'], label: string, enabled: boolean): Entry => ({
        label,
        enabled,
        choice: { menuId: 'pane', itemId, target },
      });
      const split = leaves.length < MAX_PANES;
      return [
        item('split-right', '左右分屏', split),
        item('split-below', '上下分屏', split),
        item('equalize', '平均分割', leaves.length > 1),
        'separator',
        item('close-pane', '关闭窗格（标签保留）', leaves.length > 1),
      ];
    }
    case 'run-records': {
      const session = owned(snapshot, workspace, (w) => w.sessions.find((s) => s.sessionId === request.context.sessionId), '会话');
      const target = { workspaceId, sessionId: session.sessionId };
      const { current } = request.context;
      return (
        [
          ['log', '日志'],
          ['diff', 'diff'],
          ['report', '报告'],
        ] as const
      ).map(([itemId, label]) => ({
        label,
        enabled: true,
        checked: current === itemId,
        choice: { menuId: 'run-records', itemId, target },
      }));
    }
    case 'web-more': {
      const resource = owned(
        snapshot,
        workspace,
        (w) => w.resources.find((r) => r.resourceId === request.context.resourceId && r.kind === 'web'),
        '网页',
      );
      const target = { workspaceId, resourceId: resource.resourceId };
      const item = (itemId: Extract<NativeMenuChoice, { menuId: 'web-more' }>['itemId'], label: string, enabled = true): Entry => ({
        label,
        enabled,
        choice: { menuId: 'web-more', itemId, target },
      });
      if (resource.appProjectId) return [item('manage-app', '管理 App')];
      const page = resource.preview;
      return [
        item('bookmark', '收藏到资源'),
        item('snapshot', '保存正文快照', !!resource.instanceId && !page?.loading && !page?.loadError),
        item('show-resources', '查看空间资源'),
      ];
    }
    case 'capture-receiver': {
      const { receiverSessionId } = request.context;
      const resource = owned(
        snapshot,
        workspace,
        (w) => w.resources.find((r) => r.resourceId === request.context.resourceId && r.kind === 'web'),
        '网页',
      );
      const receiver =
        receiverSessionId === null
          ? null
          : owned(snapshot, workspace, (w) => w.sessions.find((s) => s.sessionId === receiverSessionId), '接收会话');
      // OPS-1 S1：选择只设定之后采集的接收者（采集由「选择元素」发起），所以条目不随网页是否可采集而禁用。
      // 只列标签仍打开的会话：标签已关闭的会话不作为接收者（与 renderer 的默认接收者规则一致）。
      const open = workspace.sessions.filter((session) => workspace.tabs.some((tab) => tab.targetRef.resourceId === session.resourceId));
      const choice = (
        itemId: Extract<NativeMenuChoice, { menuId: 'capture-receiver' }>['itemId'],
        sessionId: string | null,
      ): NativeMenuChoice => ({ menuId: 'capture-receiver', itemId, target: { workspaceId, resourceId: resource.resourceId, sessionId } });
      return [
        ...open.map((session): Entry => ({
          label: session.title,
          enabled: true,
          checked: session.sessionId === receiver?.sessionId,
          choice: choice('session', session.sessionId),
        })),
        'separator',
        { label: '新建会话', enabled: true, choice: choice('new-session', null) },
        ...(receiver ? [{ label: '打开接收会话', enabled: true, choice: choice('open-receiver', receiver.sessionId) }] : []),
      ];
    }
    case 'new-tab':
      return (
        [
          ['web', '网页'],
          ['terminal', '终端'],
          ['session', 'Agent 会话'],
          ['file', '文件'],
          ['ssh', 'SSH'],
        ] as const
      ).map(([itemId, label]) => ({ label, enabled: true, choice: { menuId: 'new-tab', itemId, target: { workspaceId } } }));
  }
}

/** 弹出位置：锚点左下角（鼠标打开时即指针位置），限制在窗口内容区内并取整。 */
export function menuPosition(anchor: MenuAnchor | undefined, size: { width: number; height: number } | null): { x?: number; y?: number } {
  if (!anchor || !size) return {};
  const clamp = (value: number, extent: number) => Math.min(Math.max(0, Math.round(value)), Math.max(0, Math.floor(extent) - 1));
  return { x: clamp(anchor.x, size.width), y: clamp(anchor.y + anchor.height, size.height) };
}

/** 关闭回调到达后延后一个 tick（一个宏任务）再判定取消（R3）：macOS 上关闭回调可能早于菜单项的 click。 */
const deferCancel = (settle: () => void) => {
  setTimeout(settle, 0);
};

export class NativeMenuService {
  /** 每个窗口同时至多一个菜单：从收到请求起到结果决定前都占用。 */
  private pending: { cancel: () => void } | null = null;

  constructor(
    private readonly deps: {
      host: NativeMenuHost;
      /** Main 当前的工作台快照（不等待命令队列，见 WorkbenchApplication.currentSnapshot）。 */
      snapshot: () => Promise<WorkbenchSnapshot>;
    },
  ) {
    deps.host.onInvalidated(() => this.cancelPending());
  }

  /** 关闭仍打开的菜单并以 null 结束其请求；页面已经不在时，renderer 的“菜单进行中”标记不会因此卡住。 */
  cancelPending(): void {
    this.pending?.cancel();
  }

  async show(request: ShowMenuRequest): Promise<NativeMenuChoice | null> {
    if (this.pending) throw new Error('conflict: 已有菜单打开');
    let cancelled = false;
    const pending = {
      cancel: () => {
        cancelled = true;
      },
    };
    this.pending = pending;
    const release = () => {
      if (this.pending === pending) this.pending = null;
    };
    try {
      const entries = buildNativeMenu(await this.deps.snapshot(), request);
      if (cancelled) {
        release();
        return null;
      }
      const position = menuPosition(request.context.anchor, this.deps.host.contentSize());
      return await new Promise<NativeMenuChoice | null>((resolve, rejectChoice) => {
        // 结果只决定一次：先到的 click 决定选择；只有关闭回调时，延后一个 tick 仍没有 click 才是取消。
        let settled = false;
        const settle = (choice: NativeMenuChoice | null) => {
          if (settled) return;
          let parsed: NativeMenuChoice | null;
          try {
            parsed = choice === null ? null : NativeMenuChoiceSchema.parse(structuredClone(choice));
          } catch (error) {
            settled = true;
            release();
            rejectChoice(error);
            return;
          }
          settled = true;
          release();
          resolve(parsed);
        };
        pending.cancel = () => {
          this.deps.host.close();
          settle(null);
        };
        const template = entries.map((entry): MenuItemConstructorOptions => {
          if (entry === 'separator') return { type: 'separator' };
          return {
            label: entry.label,
            enabled: entry.enabled,
            ...(entry.checked === undefined ? {} : { type: 'radio' as const, checked: entry.checked }),
            // 系统不会为禁用项调用 click；这里再挡一次，禁用项不产生选择。
            click: () => {
              if (entry.enabled) settle(entry.choice);
            },
          };
        });
        this.deps.host.popup(template, { ...position, callback: () => deferCancel(() => settle(null)) });
      });
    } finally {
      release();
    }
  }
}
