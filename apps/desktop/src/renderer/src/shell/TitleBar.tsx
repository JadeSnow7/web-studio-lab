import { Icon } from '../components/Icon';
import { useStore } from '../lib/store';
import { chatStore } from '../state/chat';
import { shellActions, shellStore } from '../state/shell';
import { workspaceStore } from '../state/workspace';
import { spaceActions } from '../state/space-ui';
import { ROUTE_TITLES } from './routes';
export function TitleBar() {
  const route = useStore(shellStore, (s) => s.route);
  const focused = useStore(shellStore, (s) => s.focusMode);
  const state = useStore(workspaceStore, (s) => s);
  const workspace = state.snapshot?.workspaces.find((w) => w.workspaceId === state.selectedId);
  const chat = useStore(chatStore, (s) => s.status);
  return (
    <header className="titlebar">
      <div className="traffic-space" aria-hidden="true" />
      <button
        type="button"
        className="icon-btn no-drag"
        aria-label="显示或隐藏 Workshop（⌘B）"
        onClick={() => void shellActions.toggleWorkshop()}
      >
        <Icon name="sidebar" size={17} />
      </button>
      {route === 'space' ? (
        <button
          type="button"
          className="space-switch-button no-drag"
          aria-label="切换空间"
          disabled={!workspace}
          onClick={() => void spaceActions.openSwitcher()}
        >
          <span className="space-symbol">▦</span>
          <strong>{workspace?.name ?? '加载空间…'}</strong>
          <span>⌄</span>
        </button>
      ) : (
        <div className="titlebar-title">
          <strong>{ROUTE_TITLES[route]}</strong>
          <span className="muted">空间现场在后台保留</span>
        </div>
      )}
      <div className="titlebar-right no-drag">
        {focused ? (
          <button type="button" className="btn" onClick={shellActions.toggleFocus}>
            恢复布局
          </button>
        ) : null}
        <button type="button" className="chip chip-button" onClick={() => shellActions.navigate('settings')}>
          <span className="shape shape-dashed" aria-hidden="true" />
          {chat ? `Codex CLI · ${chat.available ? '对话已连接' : '对话不可用'}` : '读取对话状态…'}
        </button>
      </div>
    </header>
  );
}
