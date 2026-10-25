import { tabTitle } from '../state/tab-title';
import { spaceActions } from '../state/space-ui';
import { TabRename } from './TabRename';
import { reorderTabIds } from './presentation';
import { useEffect, useRef, useState, type ReactNode } from 'react';
import type { MenuAnchor, WorkspaceSnapshot } from '@wsl/protocol';
import { Icon } from '../components/Icon';
import { StatusDot } from '../components/Status';
import { beginNavigation, isCurrentNavigation, command, panes, workspaceCommand, workspaceStore } from '../state/workspace';
import { useStore } from '../lib/store';
import { useCatalogMutation } from '../state/catalog';
import { spaceUiStore } from '../state/space-ui';
import { useTabStatus, type TabTarget } from '../state/status-view';
import { menuAnchorFromClick, menuAnchorFromPointer, nativeMenuKey, nativeMenuStore } from '../state/native-menu';
import { resourceIcons as icons } from './icons';
/**
 * 标签行尾状态点：状态与「什么时候画」都由展示层决定（tabStatus），这里只负责画；没有可画的状态时不占位。
 * 描述节点只在有状态点时才存在，所以 aria-describedby 也只在有状态点时设置——由子函数在拿到 view 后决定。
 */
function WithTabStatus({
  id,
  target,
  children,
}: {
  id: string;
  target: TabTarget;
  children: (describedBy: string | undefined, dot: ReactNode) => ReactNode;
}) {
  const view = useTabStatus(target);
  if (!view) return <>{children(undefined, null)}</>;
  return (
    <>
      {children(
        id,
        <span id={id} className="tab-status">
          <StatusDot view={view} />
        </span>,
      )}
    </>
  );
}

export function Sidebar({
  workspace,
  peek,
  onCreateTab,
  onNewTabMenu,
  onSwitcher,
  onApp,
  onTabMenu,
  onClosePeek,
}: {
  workspace: WorkspaceSnapshot | undefined;
  peek: boolean;
  onCreateTab: (kind: 'web' | 'terminal' | 'session') => void;
  /** 底部「新建标签」：原生菜单列出全部类型（OPS-1 S5）。 */
  onNewTabMenu: (anchor: MenuAnchor) => void;
  onApp: () => void;
  onSwitcher: () => void;
  /** 标签菜单（原生菜单）：由「···」或右键打开。 */
  onTabMenu: (tabId: string, anchor: MenuAnchor) => void;
  onClosePeek: () => void;
}) {
  const activation = useRef<ReturnType<typeof command> | null>(null);
  const closeTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const cancelPeekClose = () => {
    if (closeTimer.current) clearTimeout(closeTimer.current);
    closeTimer.current = null;
  };
  const [dragged, setDragged] = useState<string | null>(null),
    [drop, setDrop] = useState<string | null>(null);
  useEffect(
    () => () => {
      cancelPeekClose();
      spaceActions.closeRename();
    },
    [workspace?.workspaceId],
  );
  const catalog = useStore(workspaceStore, (s) => s.snapshot?.catalog);
  const expanded = useStore(spaceUiStore, (s) => s.resourcesWorkspaceId === workspace?.workspaceId);
  const [choice, setChoice] = useState('');
  const action = useCatalogMutation();
  const openMenu = useStore(nativeMenuStore, (s) => s.open);
  const renaming = useStore(spaceUiStore, (s) => s.renaming);
  useEffect(() => {
    if (renaming || openMenu || !peek) cancelPeekClose();
  }, [renaming, openMenu, peek]);
  const items = workspace?.tabs ?? [];
  const ordered = [...items.filter((t) => t.pinned), ...items.filter((t) => !t.pinned)];
  const background = workspace?.resources.filter((r) => !items.some((t) => t.targetRef.resourceId === r.resourceId)) ?? [];
  return (
    <section className="workspace-sidebar" aria-label="空间导航">
      <div className="sidebar-heading">
        <strong title={workspace?.name}>{workspace?.name}</strong>
        <div className="sidebar-create-actions" role="group" aria-label="新建空间资源">
          {(
            [
              ['web', 'globe', '新建网页'],
              ['terminal', 'terminal', '新建终端'],
              ['session', 'chat', '新建会话'],
            ] as const
          ).map(([kind, icon, label]) => (
            <button
              key={kind}
              type="button"
              className="icon-btn"
              aria-label={label}
              title={label}
              disabled={!workspace}
              onClick={() => onCreateTab(kind)}
            >
              <Icon name={icon} size={16} />
            </button>
          ))}
          <button
            type="button"
            className="icon-btn"
            aria-label={workspace?.managedApp ? '管理 App' : '新建 App'}
            title={workspace?.managedApp ? '管理 App' : '新建 App'}
            disabled={!workspace}
            onClick={onApp}
          >
            <Icon name="space" size={16} />
          </button>
        </div>
      </div>
      {/* tabIndex=-1：用菜单关闭标签后焦点可回到标签列表（不进入 Tab 顺序）。 */}
      <nav aria-label="空间标签" className="vertical-tabs" tabIndex={-1}>
        <p className="muted small">活跃标签</p>
        {ordered.map((tab, index) => {
          const title = workspace ? tabTitle(workspace, tab) : tab.title;
          const editing = renaming?.workspaceId === workspace?.workspaceId && renaming?.tabId === tab.tabId;
          const p = workspace ? panes(workspace.layout).find((p) => p.tabId === tab.tabId) : undefined;
          const active = p?.paneId === workspace?.activePaneId;
          const sessionId = workspace?.sessions.find((s) => s.resourceId === tab.targetRef.resourceId)?.sessionId;
          const statusId = `vertical-status-${tab.tabId}`;
          return (
            <div
              key={tab.tabId}
              className={`vertical-tab ${active ? 'is-active' : ''} ${drop === tab.tabId ? 'drop-target' : ''}`}
              draggable={!editing}
              onDragStart={() => setDragged(tab.tabId)}
              onDragEnd={() => {
                setDragged(null);
                setDrop(null);
              }}
              onDragOver={(e) => {
                e.preventDefault();
                setDrop(tab.tabId);
              }}
              onContextMenu={(e) => {
                e.preventDefault();
                onTabMenu(tab.tabId, menuAnchorFromPointer(e));
              }}
              onDrop={(e) => {
                e.preventDefault();
                if (dragged && dragged !== tab.tabId) {
                  const ids = reorderTabIds(
                    items.map((t) => t.tabId),
                    dragged,
                    tab.tabId,
                  );
                  void command({ type: 'reorderTabs', tabIds: ids });
                }
                setDrop(null);
                setDragged(null);
              }}
            >
              {editing && workspace ? (
                <TabRename
                  key={tab.tabId}
                  workspaceId={workspace.workspaceId}
                  tabId={tab.tabId}
                  title={title}
                  revision={workspace.revision}
                />
              ) : (
                <>
                  <WithTabStatus id={statusId} target={{ ...tab.targetRef, sessionId }}>
                    {(describedBy, dot) => (
                      <button
                        type="button"
                        className="vertical-tab-main"
                        aria-label={title}
                        aria-current={active ? 'page' : undefined}
                        title={title}
                        aria-describedby={describedBy}
                        onDoubleClick={async (event) => {
                          cancelPeekClose();
                          const control = event.currentTarget;
                          const navigation = beginNavigation();
                          const pending = activation.current;
                          let revoked = false;
                          const intent = new AbortController();
                          const outside = (event: Event) => {
                            if (event.target instanceof Node && !control.contains(event.target)) revoked = true;
                          };
                          window.addEventListener('pointerdown', outside, { capture: true, signal: intent.signal });
                          window.addEventListener('focusin', outside, { signal: intent.signal });
                          window.addEventListener(
                            'blur',
                            () => {
                              revoked = true;
                            },
                            { signal: intent.signal },
                          );
                          try {
                            const result = await pending;
                            const current = workspaceStore.get();
                            const target = current.snapshot?.workspaces.find((item) => item.workspaceId === workspace?.workspaceId);
                            if (
                              result?.ok &&
                              workspace &&
                              !revoked &&
                              isCurrentNavigation(navigation) &&
                              document.hasFocus() &&
                              current.selectedId === workspace.workspaceId &&
                              control.isConnected &&
                              document.activeElement === control &&
                              target &&
                              panes(target.layout).find((pane) => pane.paneId === target.activePaneId)?.tabId === tab.tabId
                            )
                              spaceActions.renameTab(workspace.workspaceId, tab.tabId);
                          } finally {
                            intent.abort();
                          }
                        }}
                        onClick={(event) => {
                          if (event.detail !== 2) activation.current = command({ type: 'activateTab', tabId: tab.tabId });
                          if (peek) {
                            cancelPeekClose();
                            if (event.detail === 0) onClosePeek();
                            else if (event.detail === 1)
                              closeTimer.current = setTimeout(() => {
                                closeTimer.current = null;
                                const ui = spaceUiStore.get();
                                if (
                                  workspaceStore.get().selectedId === workspace?.workspaceId &&
                                  !ui.renaming &&
                                  !ui.editor &&
                                  !ui.switcher &&
                                  !ui.appEditor &&
                                  !ui.appWorkspaceId
                                )
                                  onClosePeek();
                              }, 500);
                          }
                        }}
                        onKeyDown={(e) => {
                          if (e.nativeEvent.isComposing || e.keyCode === 229) return;
                          if (e.key === 'F2' && workspace) {
                            cancelPeekClose();
                            e.preventDefault();
                            spaceActions.renameTab(workspace.workspaceId, tab.tabId);
                            return;
                          }
                          const next =
                            e.key === 'ArrowDown'
                              ? index + 1
                              : e.key === 'ArrowUp'
                                ? index - 1
                                : e.key === 'Home'
                                  ? 0
                                  : e.key === 'End'
                                    ? ordered.length - 1
                                    : null;
                          if (next !== null) {
                            e.preventDefault();
                            document.getElementById(`vertical-${ordered[(next + ordered.length) % ordered.length]!.tabId}`)?.focus();
                          }
                        }}
                        id={`vertical-${tab.tabId}`}
                      >
                        <Icon name={icons[tab.targetRef.kind]} />
                        <span className="tab-description">
                          <span>{title}</span>
                          {tab.group ? <small>{tab.group}</small> : null}
                        </span>
                        {tab.pinned ? <span aria-label="已固定">⌖</span> : null}
                        {dot}
                      </button>
                    )}
                  </WithTabStatus>
                  <button
                    type="button"
                    className="icon-btn tab-actions"
                    aria-label={`${title}操作`}
                    aria-haspopup="menu"
                    aria-expanded={
                      !!workspace && openMenu === nativeMenuKey('tab', { workspaceId: workspace.workspaceId, tabId: tab.tabId })
                    }
                    onClick={(e) => onTabMenu(tab.tabId, menuAnchorFromClick(e, e.currentTarget))}
                  >
                    ···
                  </button>
                  <button
                    type="button"
                    className="icon-btn tab-close"
                    aria-label={`关闭标签 · ${title}`}
                    title="关闭标签（保留实例）"
                    draggable={false}
                    onPointerDown={(event) => event.stopPropagation()}
                    onDragStart={(event) => {
                      event.preventDefault();
                      event.stopPropagation();
                    }}
                    onClick={async (event) => {
                      event.stopPropagation();
                      if (!workspace) return;
                      const result = await workspaceCommand(workspace.workspaceId, { type: 'closeTab', tabId: tab.tabId });
                      if (result?.ok && workspaceStore.get().selectedId === workspace.workspaceId)
                        requestAnimationFrame(() => {
                          if (workspaceStore.get().selectedId !== workspace.workspaceId) return;
                          const focused = document.activeElement;
                          if (focused instanceof HTMLElement && focused !== document.body && focused.isConnected) return;
                          const next = ordered[index + 1] ?? ordered[index - 1];
                          (next
                            ? document.getElementById(`vertical-${next.tabId}`)
                            : document.querySelector<HTMLElement>('nav[aria-label="空间标签"]')
                          )?.focus();
                        });
                    }}
                  >
                    ×
                  </button>
                </>
              )}
            </div>
          );
        })}
        {!ordered.length ? <p className="workspace-empty">空间还没有标签。</p> : null}
        {background.length ? (
          <details className="background-resources">
            <summary>
              <span>后台资源 / 已关闭标签</span>
              <span className="count">· {background.length}</span>
            </summary>
            {background.map((r) => (
              <div key={r.resourceId} className="stack-8">
                <span className="resource-location">
                  {r.title} · {r.instanceId ? '实例保留' : '无运行实例'}
                </span>
                <div className="row wrap gap-8">
                  <button
                    type="button"
                    className="btn"
                    aria-label={`${r.title} · 重新打开`}
                    onClick={() => void command({ type: 'openTab', resourceId: r.resourceId })}
                  >
                    重新打开
                  </button>
                  {r.instanceId ? (
                    <button
                      type="button"
                      className="btn"
                      onClick={() => void command({ type: 'stopInstance', resourceId: r.resourceId, instanceId: r.instanceId! })}
                    >
                      {r.kind === 'web' ? '关闭网页实例' : r.kind === 'file' ? '关闭文件观察' : '停止实例'}
                    </button>
                  ) : null}
                </div>
              </div>
            ))}
          </details>
        ) : null}
      </nav>
      {workspace && catalog ? (
        <details
          className="space-resource-section"
          open={expanded}
          onToggle={(event) => {
            const open = event.currentTarget.open;
            spaceUiStore.set((s) => ({
              ...s,
              resourcesWorkspaceId: open
                ? workspace.workspaceId
                : s.resourcesWorkspaceId === workspace.workspaceId
                  ? null
                  : s.resourcesWorkspaceId,
            }));
          }}
        >
          <summary id="space-resources-summary" tabIndex={0}>
            空间资源 · {catalog.links.filter((link) => link.workspaceId === workspace.workspaceId).length}
          </summary>
          <p className="muted small">连接不打开页面，不自动提供给会话。</p>
          <label className="field">
            连接收藏
            <select aria-label="连接收藏" disabled={action.busy} value={choice} onChange={(e) => setChoice(e.target.value)}>
              <option value="">选择已有收藏</option>
              {catalog.resources
                .filter(
                  (item) =>
                    catalog.library.some((entry) => entry.resourceId === item.resourceId) &&
                    !catalog.links.some((link) => link.workspaceId === workspace.workspaceId && link.resourceId === item.resourceId),
                )
                .map((item) => (
                  <option key={item.resourceId} value={item.resourceId}>
                    {item.title}
                  </option>
                ))}
            </select>
          </label>
          <button
            type="button"
            className="btn"
            disabled={!choice || action.busy}
            onClick={async () => {
              if (
                await action.mutate(
                  { type: 'connectResource', workspaceId: workspace.workspaceId, resourceId: choice },
                  '已连接，尚未打开。',
                )
              )
                setChoice('');
            }}
          >
            连接到本空间
          </button>
          {catalog.links
            .filter((link) => link.workspaceId === workspace.workspaceId)
            .map((link) => {
              const item = catalog.resources.find((item) => item.resourceId === link.resourceId)!;
              const saved = catalog.library.some((entry) => entry.resourceId === item.resourceId);
              return (
                <article key={item.resourceId} className="space-resource-row">
                  <strong className="resource-location">{item.title}</strong>
                  <p className="muted small">
                    {saved ? '收藏连接' : '本空间资源 · 未收藏'} ·{' '}
                    {item.descriptor.kind === 'web' ? '网页' : item.descriptor.kind === 'document' ? '文档' : '开发资源'}
                  </p>
                  <div className="row wrap gap-8">
                    <button
                      type="button"
                      className="btn"
                      disabled={action.busy}
                      onClick={() =>
                        void action.mutate(
                          { type: 'openCatalogResource', workspaceId: workspace.workspaceId, resourceId: item.resourceId },
                          '已打开空间标签。',
                        )
                      }
                    >
                      打开
                    </button>
                    {!saved ? (
                      <button
                        type="button"
                        className="btn"
                        disabled={action.busy}
                        onClick={() =>
                          void action.mutate({ type: 'bookmarkResource', resourceId: item.resourceId }, '已收藏，空间连接保留。')
                        }
                      >
                        收藏
                      </button>
                    ) : null}
                    <button
                      type="button"
                      className="btn"
                      disabled={action.busy}
                      onClick={() =>
                        void action.mutate(
                          { type: 'disconnectResource', workspaceId: workspace.workspaceId, resourceId: item.resourceId },
                          '已解除空间连接，账户资源保留。',
                        )
                      }
                    >
                      解除连接
                    </button>
                  </div>
                  <label className="field">
                    会话参考
                    <select
                      aria-label={`${item.title}会话参考`}
                      disabled={action.busy}
                      value={link.referenceVersion ?? ''}
                      onChange={(e) =>
                        void action.mutate(
                          {
                            type: 'selectReference',
                            workspaceId: workspace.workspaceId,
                            resourceId: item.resourceId,
                            version: e.target.value ? Number(e.target.value) : null,
                          },
                          '空间会话参考已更新，仅影响之后的任务。',
                        )
                      }
                    >
                      <option value="">不作为参考</option>
                      {item.versions.map((version) => (
                        <option key={version} value={version}>
                          v{version}
                        </option>
                      ))}
                    </select>
                  </label>
                  {!item.versions.length ? <p className="muted small">未保存正文快照</p> : null}
                </article>
              );
            })}
          {action.error ? <p role="alert">{action.error}</p> : null}
          {action.notice ? <p role="status">{action.notice}</p> : null}
        </details>
      ) : null}
      <button
        type="button"
        className="btn new-tab-button"
        aria-haspopup="menu"
        aria-expanded={!!workspace && openMenu === nativeMenuKey('new-tab', { workspaceId: workspace.workspaceId })}
        disabled={!workspace}
        onClick={(e) => onNewTabMenu(menuAnchorFromClick(e, e.currentTarget))}
      >
        <Icon name="plus" />
        新建标签
      </button>
      <div className="sidebar-footer">
        <button type="button" className="btn btn-ghost" onClick={() => onSwitcher()}>
          搜索空间或标签
        </button>
      </div>
    </section>
  );
}
