import { useLayoutEffect, useRef, useState } from 'react';
import type { WorkbenchTab, WorkspaceSnapshot } from '@wsl/protocol';
import { Icon } from '../components/Icon';
import { switchWorkspace } from '../state/workspace';
import { resourceIcons as icons } from './icons';
export function SpaceSwitcher({
  open,
  workspaces,
  selectedId,
  onClose,
  onExpand,
  onCreate,
  onManage,
}: {
  open: boolean;
  workspaces: WorkspaceSnapshot[];
  selectedId: string | null;
  onClose: () => void;
  onExpand: () => void;
  onCreate: () => void;
  onManage: () => void;
}) {
  const dialog = useRef<HTMLDialogElement>(null),
    search = useRef<HTMLInputElement>(null);
  const [query, setQuery] = useState('');
  useLayoutEffect(() => {
    if (open) {
      dialog.current?.showModal();
      search.current?.focus();
    } else dialog.current?.close();
  }, [open]);
  const closeSwitcher = () => {
    dialog.current?.close();
    setQuery('');
    onClose();
  };
  const filtered =
    workspaces
      .flatMap((w) => [{ workspace: w, tab: null as WorkbenchTab | null }, ...w.tabs.map((t) => ({ workspace: w, tab: t }))])
      .filter((x) =>
        query ? `${x.workspace.name} ${x.tab?.title ?? ''}`.toLocaleLowerCase().includes(query.toLocaleLowerCase()) : !x.tab,
      ) ?? [];
  if (!query) filtered.sort((a, b) => Number(b.workspace.workspaceId === selectedId) - Number(a.workspace.workspaceId === selectedId));
  return (
    <dialog
      ref={dialog}
      className="space-switcher"
      aria-label="切换空间"
      onCancel={(e) => {
        e.preventDefault();
        closeSwitcher();
      }}
      onClick={(e) => {
        if (e.target === e.currentTarget) closeSwitcher();
      }}
    >
      <div className="row space-between">
        <h2>切换空间</h2>
        <button type="button" className="icon-btn" aria-label="关闭空间切换器" onClick={closeSwitcher}>
          ×
        </button>
      </div>
      <div className="switcher-search">
        <input
          ref={search}
          aria-label="搜索空间或标签"
          placeholder="搜索空间或标签"
          value={query}
          onChange={(e) => setQuery(e.target.value)}
        />
        {query ? (
          <button
            type="button"
            className="icon-btn"
            aria-label="清除搜索"
            onClick={() => {
              setQuery('');
              search.current?.focus();
            }}
          >
            ×
          </button>
        ) : null}
      </div>
      <div className="switcher-results">
        {filtered.length ? (
          filtered.flatMap(({ workspace: w, tab }) => [
            ...(!query &&
            (w.workspaceId === selectedId ||
              filtered.find((item) => item.workspace.workspaceId !== selectedId)?.workspace.workspaceId === w.workspaceId)
              ? [
                  <p className="muted small" key={`${w.workspaceId}:heading`}>
                    {w.workspaceId === selectedId
                      ? '当前空间'
                      : filtered.find((item) => item.workspace.workspaceId !== selectedId)?.workspace.workspaceId === w.workspaceId
                        ? '最近使用'
                        : ''}
                  </p>,
                ]
              : []),
            <button
              type="button"
              key={`${w.workspaceId}:${tab?.tabId ?? 'workspace'}`}
              className={`switcher-item ${w.workspaceId === selectedId && !tab ? 'current' : ''}`}
              onClick={() => {
                void switchWorkspace(w.workspaceId, tab?.tabId);
                closeSwitcher();
              }}
            >
              <span className="space-symbol">{tab ? <Icon name={icons[tab.targetRef.kind]} /> : '▦'}</span>
              <span>
                <strong>{tab?.title ?? w.name}</strong>
                <small>
                  {tab
                    ? w.name
                    : `${w.tabs.length} 个标签 · ${w.runs.filter((r) => r.state === 'running').length} 个运行中 · ${w.runs.filter((r) => r.state === 'completed' && !r.review).length} 个待审阅`}
                </small>
              </span>
              {w.workspaceId === selectedId && !tab ? <span>✓</span> : null}
            </button>,
          ])
        ) : (
          <p className="workspace-empty">没有匹配的空间或标签</p>
        )}
      </div>
      <button
        type="button"
        className="btn"
        onClick={() => {
          closeSwitcher();
          onExpand();
        }}
      >
        展开当前空间
      </button>
      <div className="switcher-footer">
        <button
          type="button"
          className="btn"
          onClick={() => {
            onCreate();
          }}
        >
          新建空间
        </button>
        <button
          type="button"
          className="btn"
          onClick={() => {
            onManage();
          }}
        >
          管理空间
        </button>
      </div>
    </dialog>
  );
}
