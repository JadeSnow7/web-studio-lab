import { reorderTabIds } from './presentation';
import { useState } from 'react';
import type { WorkspaceSnapshot } from '@wsl/protocol';
import { Icon } from '../components/Icon';
import { command, panes, workspaceStore } from '../state/workspace';
import { useStore } from '../lib/store';
import { useCatalogMutation } from '../state/catalog';
import { spaceUiStore } from '../state/space-ui';
import { resourceIcons as icons } from './icons';
export function Sidebar({
  workspace,
  peek,
  onCreateTab,
  onSwitcher,
  onApp,
  onTabMenu,
  onClosePeek,
}: {
  workspace: WorkspaceSnapshot | undefined;
  peek: boolean;
  onCreateTab: (kind?: 'web' | 'terminal' | 'session') => void;
  onApp: () => void;
  onSwitcher: () => void;
  onTabMenu: (tabId: string) => void;
  onClosePeek: () => void;
}) {
  const [dragged, setDragged] = useState<string | null>(null),
    [drop, setDrop] = useState<string | null>(null);
  const catalog = useStore(workspaceStore, (s) => s.snapshot?.catalog);
  const expanded = useStore(spaceUiStore, (s) => s.resourcesWorkspaceId === workspace?.workspaceId);
  const [choice, setChoice] = useState('');
  const action = useCatalogMutation();
  const items = workspace?.tabs ?? [];
  const ordered = [...items.filter((t) => t.pinned), ...items.filter((t) => !t.pinned)];
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
      <nav aria-label="空间标签" className="vertical-tabs">
        <p className="muted small">活跃标签</p>
        {ordered.map((tab, index) => {
          const p = workspace ? panes(workspace.layout).find((p) => p.tabId === tab.tabId) : undefined;
          const active = p?.paneId === workspace?.activePaneId;
          const r = workspace?.resources.find((r) => r.resourceId === tab.targetRef.resourceId);
          const session = workspace?.sessions.find((s) => s.resourceId === tab.targetRef.resourceId);
          const run = workspace?.runs.filter((r) => r.sessionId === session?.sessionId).at(-1);
          return (
            <div
              key={tab.tabId}
              className={`vertical-tab ${active ? 'is-active' : ''} ${drop === tab.tabId ? 'drop-target' : ''}`}
              draggable
              onDragStart={() => setDragged(tab.tabId)}
              onDragEnd={() => {
                setDragged(null);
                setDrop(null);
              }}
              onDragOver={(e) => {
                e.preventDefault();
                setDrop(tab.tabId);
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
              <button
                type="button"
                className="vertical-tab-main"
                aria-label={tab.title}
                aria-current={active ? 'page' : undefined}
                title={tab.title}
                onClick={() => {
                  void command({ type: 'activateTab', tabId: tab.tabId });
                  if (peek) {
                    onClosePeek();
                  }
                }}
                onKeyDown={(e) => {
                  if (e.nativeEvent.isComposing) return;
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
                  <span>{tab.title}</span>
                  {tab.group ? <small>{tab.group}</small> : null}
                </span>
                {tab.pinned ? <span aria-label="已固定">⌖</span> : null}
                {p && !active ? <small>已显示</small> : null}
                {run?.state === 'running' ? <small>执行中</small> : r?.terminal?.state === 'running' ? <small>已连接</small> : null}
              </button>
              <button type="button" className="icon-btn tab-actions" aria-label={`${tab.title}操作`} onClick={() => onTabMenu(tab.tabId)}>
                ···
              </button>
            </div>
          );
        })}
        {!ordered.length ? <p className="workspace-empty">空间还没有标签。</p> : null}
        <details className="background-resources">
          <summary>后台资源 / 已关闭标签</summary>
          {workspace?.resources
            .filter((r) => !items.some((t) => t.targetRef.resourceId === r.resourceId))
            .map((r) => (
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
      <button type="button" className="btn new-tab-button" onClick={() => onCreateTab()}>
        <Icon name="plus" />
        新建标签
      </button>
      <div className="sidebar-footer">
        <button type="button" className="btn btn-ghost" onClick={() => onSwitcher()}>
          搜索空间或标签
        </button>
        <span className="muted small">关闭窗格保留标签 · 隐藏继续运行</span>
      </div>
    </section>
  );
}
