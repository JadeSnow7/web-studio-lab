import { useEffect, useLayoutEffect, useRef, useState } from 'react';
import type { WorkspaceSnapshot } from '@wsl/protocol';
import { Icon } from '../components/Icon';
import { switchWorkspace } from '../state/workspace';
import { paletteEntries, type PaletteEntry } from '../state/command-palette';
import { locateSession } from '../state/location';
import { createWebTab } from '../state/shortcuts';
import { shellActions } from '../state/shell';
import { selectedWorkspace, workspaceCommand } from '../state/workspace';
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
  onClose: (restoreFocus?: boolean) => void;
  onExpand: () => void;
  onCreate: () => void;
  onManage: () => void;
}) {
  const dialog = useRef<HTMLDialogElement>(null),
    search = useRef<HTMLInputElement>(null);
  const [query, setQuery] = useState('');
  const [selected, setSelected] = useState(0);
  useLayoutEffect(() => {
    if (open) {
      dialog.current?.showModal();
      search.current?.focus();
    } else dialog.current?.close();
  }, [open]);
  const closeSwitcher = (restoreFocus = true) => {
    dialog.current?.close();
    setQuery('');
    setSelected(0);
    onClose(restoreFocus);
  };
  const filtered = paletteEntries(workspaces, query);
  if (!query)
    filtered.sort(
      (a, b) =>
        Number(b.kind === 'workspace' && b.workspaceId === selectedId) - Number(a.kind === 'workspace' && a.workspaceId === selectedId),
    );
  useEffect(() => {
    document.getElementById(`command-result-${selected}`)?.scrollIntoView({ block: 'nearest' });
  }, [selected, query]);
  const execute = async (entry: PaletteEntry) => {
    closeSwitcher(false);
    if (entry.kind === 'workspace' || entry.kind === 'tab') {
      if (await switchWorkspace(entry.workspaceId, entry.kind === 'tab' ? entry.tabId : undefined)) shellActions.navigate('space');
    } else if (entry.kind === 'session' || entry.kind === 'run') {
      await locateSession({
        workspaceId: entry.workspaceId,
        sessionId: entry.sessionId,
        ...(entry.kind === 'run'
          ? { runId: entry.runId, taskVersionId: entry.taskVersionId, view: 'log' as const }
          : { view: 'conversation' as const }),
      });
    } else if (entry.command === 'new-web-tab') await createWebTab();
    else if (entry.command === 'settings') shellActions.navigate('settings');
    else {
      const workspace = selectedWorkspace();
      const themes = ['light', 'dark', 'warm'] as const;
      if (workspace)
        await workspaceCommand(workspace.workspaceId, {
          type: 'setPreferences',
          theme: themes[(themes.indexOf(workspace.theme === 'system' ? 'light' : workspace.theme) + 1) % themes.length],
        });
    }
  };
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
        <button type="button" className="icon-btn" aria-label="关闭空间切换器" onClick={() => closeSwitcher()}>
          ×
        </button>
      </div>
      <div className="switcher-search">
        <input
          ref={search}
          aria-label="搜索空间或标签"
          title="搜索空间、标签、会话、运行和命令"
          aria-controls="command-results"
          aria-activedescendant={filtered[selected] ? `command-result-${selected}` : undefined}
          placeholder="搜索空间、标签、会话、运行或命令"
          value={query}
          onChange={(e) => {
            setQuery(e.target.value);
            setSelected(0);
          }}
          onKeyDown={(event) => {
            if (event.nativeEvent.isComposing || event.keyCode === 229) return;
            if (event.key === 'ArrowDown' || event.key === 'ArrowUp') {
              event.preventDefault();
              setSelected((index) => Math.max(0, Math.min(filtered.length - 1, index + (event.key === 'ArrowDown' ? 1 : -1))));
            } else if (event.key === 'Enter' && filtered[selected]) {
              event.preventDefault();
              void execute(filtered[selected]);
            }
          }}
        />
        {query ? (
          <button
            type="button"
            className="icon-btn"
            aria-label="清除搜索"
            onClick={() => {
              setQuery('');
              setSelected(0);
              search.current?.focus();
            }}
          >
            ×
          </button>
        ) : null}
      </div>
      <div className="switcher-results" id="command-results" aria-label="命令与搜索结果">
        {filtered.length ? (
          filtered.map((entry, index) => (
            <button
              type="button"
              aria-current={selected === index ? true : undefined}
              id={`command-result-${index}`}
              key={`${entry.kind}:${entry.id}`}
              className={`switcher-item ${selected === index ? 'current' : ''}`}
              onClick={() => void execute(entry)}
            >
              <span className="space-symbol">
                <Icon name={entry.kind === 'run' ? 'play' : entry.kind === 'session' ? 'chat' : 'search'} />
              </span>
              <span>
                <strong>{entry.label}</strong>
                <small>{entry.detail}</small>
              </span>
            </button>
          ))
        ) : (
          <p className="workspace-empty">没有匹配的空间或标签、会话、运行或命令</p>
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
