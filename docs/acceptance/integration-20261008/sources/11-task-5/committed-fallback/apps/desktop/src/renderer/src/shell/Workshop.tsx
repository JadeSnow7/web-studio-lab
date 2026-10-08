import { useEffect, useRef, type ReactNode } from 'react';
import { Icon } from '../components/Icon';
import { useStore } from '../lib/store';
import { shellActions, shellStore, type WorkshopMode } from '../state/shell';
import { WorkbenchPanel } from '../workbench/WorkbenchPanel';
import { ROUTES } from './routes';

const PEEK_OPEN_DELAY = 160;
const PEEK_CLOSE_DELAY = 300;

function Rail() {
  const route = useStore(shellStore, (s) => s.route);
  const pinned = useStore(shellStore, (s) => s.workshop.pinned);
  return (
    <nav className="rail" aria-label="Workshop 导航">
      {ROUTES.map((item) => (
        <button
          key={item.route}
          type="button"
          className="rail-item"
          aria-current={route === item.route ? 'page' : undefined}
          onClick={() => shellActions.navigate(item.route)}
        >
          <Icon name={item.icon} />
          {item.label}
        </button>
      ))}
      <div className="rail-spacer" />
      <button
        type="button"
        className="icon-btn rail-pin"
        aria-pressed={pinned}
        aria-label={pinned ? '取消固定 Workshop' : '固定 Workshop'}
        title={pinned ? '取消固定：收起后从左边缘悬停或点击把手展开' : '固定：Workshop 占据布局'}
        onClick={() => shellActions.setPinned(!pinned)}
      >
        <Icon name="pin" size={17} />
      </button>
      <button
        type="button"
        className="rail-item"
        aria-current={route === 'settings' ? 'page' : undefined}
        onClick={() => shellActions.navigate('settings')}
      >
        <Icon name="gear" />
        设置
      </button>
    </nav>
  );
}

function WorkshopContent() {
  const route = useStore(shellStore, (s) => s.route);
  return (
    <>
      <Rail />
      {route === 'space' ? <WorkbenchPanel /> : null}
    </>
  );
}

function OverlayWorkshop({ children }: { children: ReactNode }) {
  const ref = useRef<HTMLElement>(null);
  const closeTimer = useRef<number | null>(null);
  const cancelClose = () => {
    if (closeTimer.current !== null) window.clearTimeout(closeTimer.current);
    closeTimer.current = null;
  };
  useEffect(() => cancelClose, []);
  return (
    <aside
      ref={ref}
      className="workshop workshop-overlay"
      aria-label="Workshop（临时展开）"
      onMouseEnter={cancelClose}
      onMouseLeave={() => {
        cancelClose();
        closeTimer.current = window.setTimeout(() => {
          // 焦点仍在面板内（例如正在输入）时不收起。
          if (ref.current?.contains(document.activeElement)) return;
          shellActions.setPeek(false);
        }, PEEK_CLOSE_DELAY);
      }}
      onKeyDown={(event) => {
        if (event.key === 'Escape') shellActions.setPeek(false);
      }}
    >
      {children}
    </aside>
  );
}

function CollapsedEdge() {
  const openTimer = useRef<number | null>(null);
  const clear = () => {
    if (openTimer.current !== null) window.clearTimeout(openTimer.current);
    openTimer.current = null;
  };
  useEffect(() => clear, []);
  return (
    <div
      className="workshop-edge"
      onMouseEnter={() => {
        clear();
        openTimer.current = window.setTimeout(() => shellActions.setPeek(true), PEEK_OPEN_DELAY);
      }}
      onMouseLeave={clear}
    >
      <button
        type="button"
        className="edge-handle"
        aria-label="展开 Workshop"
        title="展开 Workshop（⌘B）"
        onClick={() => shellActions.setPeek(true)}
      />
    </div>
  );
}

export function Workshop({ mode }: { mode: WorkshopMode }) {
  if (mode === 'docked') {
    return (
      <aside className="workshop workshop-docked" aria-label="Workshop">
        <WorkshopContent />
      </aside>
    );
  }
  if (mode === 'overlay') {
    return (
      <>
        <CollapsedEdge />
        <OverlayWorkshop>
          <WorkshopContent />
        </OverlayWorkshop>
      </>
    );
  }
  return <CollapsedEdge />;
}
