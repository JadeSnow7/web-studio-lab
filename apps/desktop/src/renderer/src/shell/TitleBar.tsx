import { Icon } from '../components/Icon';
import { Shape } from '../components/Status';
import { BrandLogo } from '../components/BrandLogo';
import { useStore } from '../lib/store';
import { shellActions, shellStore } from '../state/shell';
import { useTitlebarStatus, type StatusView } from '../state/status-view';
import { workspaceStore } from '../state/workspace';
import { spaceActions } from '../state/space-ui';
import type { PanelMode } from '../state/panels';
import { ROUTE_TITLES } from './routes';
/**
 * 标题栏的持续条件按钮：普通按钮（不带 live region）。可访问名称只含可见文本；
 * 完整 label + detail 放在按钮外的 sr-only 描述节点里（aria-describedby），并作为 title 供悬停。
 */
function TitlebarStatus({ view, text, extra, onClick }: { view: StatusView; text: string; extra?: string; onClick: () => void }) {
  const full = [view.label, view.detail, extra].filter(Boolean).join(' · ');
  const describedBy = `titlebar-status-${view.key.replace(/[^a-z0-9]+/gi, '-')}`;
  return (
    <>
      <button
        type="button"
        className="chip chip-button titlebar-status"
        data-phase={view.phase}
        data-status={`${view.domain}:${view.phase}`}
        data-status-key={view.key}
        data-status-channel={view.channel}
        title={full}
        aria-describedby={describedBy}
        onClick={onClick}
      >
        <Shape phase={view.phase} />
        <span className="status-text-line">{text}</span>
      </button>
      <span id={describedBy} className="sr-only">
        {full}
      </span>
    </>
  );
}

export function TitleBar({ leftMode, rightMode }: { leftMode: PanelMode; rightMode: PanelMode }) {
  const route = useStore(shellStore, (s) => s.route);
  const focused = useStore(shellStore, (s) => s.focusMode);
  const state = useStore(workspaceStore, (s) => s);
  const workspace = state.snapshot?.workspaces.find((w) => w.workspaceId === state.selectedId);
  // 健康与读取中都不外露；持续存在的全局 problem 才在标题栏出现，点击进入设置页。
  const { chat, setup, moreSetup } = useTitlebarStatus();
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
        {chat ? <TitlebarStatus view={chat} text={`Codex CLI · ${chat.label}`} onClick={() => shellActions.navigate('settings')} /> : null}
        {setup ? (
          <TitlebarStatus
            view={setup}
            text={`环境 · ${setup.label}`}
            extra={moreSetup > 0 ? `另有 ${moreSetup} 项` : undefined}
            onClick={() => shellActions.navigate('settings')}
          />
        ) : null}
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
