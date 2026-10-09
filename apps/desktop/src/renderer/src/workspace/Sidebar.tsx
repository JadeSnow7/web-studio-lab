import { reorderTabIds } from './presentation';
import { useState } from 'react';
import type { WorkspaceSnapshot } from '@wsl/protocol';
import { Icon } from '../components/Icon';
import { command, panes } from '../state/workspace';
import { resourceIcons as icons } from './icons';
export function Sidebar({
  workspace,
  peek,
  onCreateTab,
  onSwitcher,
  onTabMenu,
  onClosePeek,
}: {
  workspace: WorkspaceSnapshot | undefined;
  peek: boolean;
  onCreateTab: () => void;
  onSwitcher: () => void;
  onTabMenu: (tabId: string) => void;
  onClosePeek: () => void;
}) {
  const [dragged, setDragged] = useState<string | null>(null),
    [drop, setDrop] = useState<string | null>(null);
  const items = workspace?.tabs ?? [];
  const ordered = [...items.filter((t) => t.pinned), ...items.filter((t) => !t.pinned)];
  return (
    <section className="workspace-sidebar" aria-label="空间导航">
      <div className="sidebar-heading">
        <strong>{workspace?.name}</strong>
        <span className="muted small">空间标签</span>
      </div>
      <nav aria-label="空间标签" className="vertical-tabs">
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
              <button
                type="button"
                className="btn"
                key={r.resourceId}
                onClick={() => void command({ type: 'openTab', resourceId: r.resourceId })}
              >
                {r.title} · 重新打开
              </button>
            ))}
        </details>
      </nav>
      {workspace ? (
        <section className="managed-app-controls" aria-label="标准应用服务">
          <strong>标准应用</strong>
          {workspace.managedApp ? (
            <>
              <p className="muted small" role="status">
                {
                  {
                    created: '已创建',
                    starting: '正在准备应用…',
                    running: '运行中',
                    stopping: '正在停止…',
                    stopped: '已停止',
                    failed: '操作失败',
                  }[workspace.managedApp.state]
                }
              </p>
              <div className="row gap-8">
                <button
                  type="button"
                  className="btn"
                  disabled={
                    !workspace.managedApp.cleanupConfirmed || ['starting', 'running', 'stopping'].includes(workspace.managedApp.state)
                  }
                  onClick={() => void command({ type: 'startApp' })}
                >
                  启动应用
                </button>
                <button
                  type="button"
                  className="btn"
                  disabled={!['starting', 'running', 'failed'].includes(workspace.managedApp.state)}
                  onClick={() => void command({ type: 'stopApp' })}
                >
                  {workspace.managedApp.state === 'starting' ? '取消启动' : '停止应用'}
                </button>
              </div>
              <button
                type="button"
                className="btn btn-ghost"
                disabled={
                  !workspace.managedApp.cleanupConfirmed || ['starting', 'running', 'stopping'].includes(workspace.managedApp.state)
                }
                onClick={() => void command({ type: 'exportApp' })}
              >
                导出源码
              </button>
              {workspace.managedApp.error ? (
                <p className="small" role="alert">
                  {workspace.managedApp.error}
                </p>
              ) : null}
              {workspace.appExport ? (
                <p className="muted small" style={{ overflowWrap: 'anywhere' }}>
                  源码已导出：{workspace.appExport.path}
                  <br />
                  SHA256：{workspace.appExport.sha256}
                </p>
              ) : null}
            </>
          ) : (
            <>
              <p className="muted small">在沙箱创建 React 全栈工程。</p>
              <button type="button" className="btn" onClick={() => void command({ type: 'createApp' })}>
                创建标准应用
              </button>
            </>
          )}
        </section>
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
