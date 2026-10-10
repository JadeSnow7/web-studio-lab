import { Icon } from '../components/Icon';
import { BrandLogo } from '../components/BrandLogo';
import { useStore } from '../lib/store';
import { chatStore } from '../state/chat';
import { shellActions, shellStore } from '../state/shell';
import { workspaceStore } from '../state/workspace';
import { spaceActions } from '../state/space-ui';
import type { PanelMode } from '../state/panels';
import { ROUTE_TITLES } from './routes';
export function TitleBar({ leftMode, rightMode }: { leftMode: PanelMode; rightMode: PanelMode }) {
  const route = useStore(shellStore, (s) => s.route);
  const focused = useStore(shellStore, (s) => s.focusMode);
  const state = useStore(workspaceStore, (s) => s);
  const workspace = state.snapshot?.workspaces.find((w) => w.workspaceId === state.selectedId);
  const chat = useStore(chatStore, (s) => s.status);
  const unread = state.snapshot?.notifications.filter((n) => !n.readAt).length ?? 0;
  const leftLabel = leftMode === 'collapsed' ? '展开 Workshop' : '收起 Workshop';
  return (
    <header className="titlebar">
      <div className="traffic-space" aria-hidden="true" />
      <button
        type="button"
        id="left-panel-trigger"
        className="icon-btn titlebar-panel-trigger no-drag"
        aria-label={leftLabel}
        aria-expanded={leftMode !== 'collapsed'}
        title={`${leftLabel}（⌘B）`}
        onClick={() => void shellActions.toggleWorkshop()}
      >
        <BrandLogo size={24} />
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
        <button
          id="right-panel-trigger"
          type="button"
          className="icon-btn titlebar-panel-trigger"
          aria-label={`通知 · ${unread} 条未读`}
          aria-expanded={rightMode !== 'collapsed'}
          title={`${rightMode === 'collapsed' ? '展开' : '收起'}通知（⌥⌘B）`}
          onClick={() => void shellActions.toggleRightPanel()}
        >
          <Icon name="bell" size={18} />
          {unread > 0 ? (
            <span className="notification-badge" aria-hidden="true">
              {unread}
            </span>
          ) : null}
        </button>
      </div>
    </header>
  );
}
