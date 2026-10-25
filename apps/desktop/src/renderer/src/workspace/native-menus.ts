import type { MenuAnchor } from '@wsl/protocol';
import { workspaceCommand, workspaceStore, workspaceSwitchPending } from '../state/workspace';
import { spaceActions } from '../state/space-ui';
import { menuView, newTabMenuEffect, openNativeMenu, paneMenuEffect, tabMenuEffect, type CommandEffect } from '../state/native-menu';

/*
 * 标签、窗格与新建标签三类原生菜单的执行（OPS-1 S5）。菜单只返回选择；这里按 state/native-menu.ts 的规则
 * 把选择变成既有命令或展示动作。运行记录、⋯ 与采集接收者菜单依赖所在组件的展示状态，在各自组件里执行。
 */

/**
 * 业务动作按冻结目标的空间执行。目标不是当前空间、或空间切换进行中时，不把它当作新的导航，
 * 以免迟到的选择打断进行中的切换（O08b）。
 */
export function runCommandEffect(effect: CommandEffect) {
  const navigate = !workspaceSwitchPending() && workspaceStore.get().selectedId === effect.workspaceId;
  return workspaceCommand(effect.workspaceId, effect.payload, effect.revision, { navigate });
}

/** 垂直标签的显示顺序（置顶在前），与侧栏一致。 */
function displayedTabIds(workspaceId: string): string[] {
  const tabs = workspaceStore.get().snapshot?.workspaces.find((w) => w.workspaceId === workspaceId)?.tabs ?? [];
  return [...tabs.filter((t) => t.pinned), ...tabs.filter((t) => !t.pinned)].map((t) => t.tabId);
}

/** 关闭标签后触发器随标签消失：焦点移到相邻标签（优先下一个），没有时移到标签列表，而不是落在 body。 */
function focusAfterClose(nextTabId: string | undefined) {
  requestAnimationFrame(() => {
    const active = document.activeElement;
    if (active instanceof HTMLElement && active !== document.body && active.isConnected) return;
    const next = nextTabId ? document.getElementById(`vertical-${nextTabId}`) : null;
    (next ?? document.querySelector<HTMLElement>('nav[aria-label="空间标签"]'))?.focus();
  });
}

/** 垂直标签的「···」或右键菜单。 */
export async function showTabMenu(workspaceId: string, tabId: string, anchor: MenuAnchor): Promise<void> {
  const choice = await openNativeMenu('tab', { workspaceId, tabId, anchor });
  if (choice?.menuId !== 'tab') return;
  const effect = tabMenuEffect(choice, menuView());
  if (!effect) return;
  if (effect.kind === 'command') {
    const order = displayedTabIds(effect.workspaceId);
    const index = order.indexOf(choice.target.tabId);
    const next = order[index + 1] ?? order[index - 1];
    const result = await runCommandEffect(effect);
    if (effect.payload.type === 'closeTab' && result?.ok && workspaceStore.get().selectedId === effect.workspaceId) focusAfterClose(next);
    return;
  }
  // 重命名复用侧栏就地编辑；分组继续使用原有对话框。
  const tab = workspaceStore
    .get()
    .snapshot?.workspaces.find((w) => w.workspaceId === effect.workspaceId)
    ?.tabs.find((t) => t.tabId === effect.tabId);
  if (!tab) return;
  if (effect.kind === 'rename') spaceActions.renameTab(effect.workspaceId, tab.tabId);
  else await spaceActions.openEditor({ kind: 'group', tabId: tab.tabId }, tab.group ?? '');
}

/** 窗格头「窗格操作」（⋯）：分屏、平均分割、关闭窗格。 */
export async function showPaneMenu(workspaceId: string, paneId: string, anchor: MenuAnchor): Promise<void> {
  const choice = await openNativeMenu('pane', { workspaceId, paneId, anchor });
  if (choice?.menuId !== 'pane') return;
  await runCommandEffect(paneMenuEffect(choice));
}

/** 侧栏底部「新建标签」：选择类型后打开预选该类型的创建表单。 */
export async function showNewTabMenu(workspaceId: string, anchor: MenuAnchor): Promise<void> {
  const choice = await openNativeMenu('new-tab', { workspaceId, anchor });
  if (choice?.menuId !== 'new-tab') return;
  const effect = newTabMenuEffect(choice, menuView());
  if (effect)
    await spaceActions.openEditor(
      { kind: 'tab', tabKind: effect.tabKind },
      { web: '新网页', terminal: '终端', session: '会话', file: '文件', ssh: 'SSH' }[effect.tabKind],
    );
}
