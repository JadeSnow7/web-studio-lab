import { createTab } from '../state/new-tab';
import { useEffect, type ReactNode } from 'react';
import { occlusion } from '../state/occlusion';
import { Icon } from '../components/Icon';
import { useStore } from '../lib/store';
import { shellActions, shellStore, type WorkshopMode } from '../state/shell';
import { Sidebar } from '../workspace/Sidebar';
import { workspaceStore } from '../state/workspace';
import { spaceActions } from '../state/space-ui';
import { showNewTabMenu, showTabMenu } from '../workspace/native-menus';
import { ROUTES } from './routes';

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
        title={pinned ? '取消固定：收起后点击标题栏标识展开' : '固定：Workshop 占据布局'}
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
  const state = useStore(workspaceStore, (s) => s);
  const panel = useStore(shellStore, (s) => s.workshop);
  const workspace = state.snapshot?.workspaces.find((w) => w.workspaceId === state.selectedId);
  return (
    <>
      <Rail />
      {route === 'space' ? (
        <Sidebar
          key={workspace?.workspaceId}
          workspace={workspace}
          peek={panel.peek}
          onCreateTab={(tabKind) => void createTab(tabKind)}
          onNewTabMenu={(anchor) => workspace && void showNewTabMenu(workspace.workspaceId, anchor)}
          onApp={() => workspace && void spaceActions.openApp(workspace.workspaceId)}
          onSwitcher={() => void spaceActions.openSwitcher()}
          onTabMenu={(tabId, anchor) => workspace && void showTabMenu(workspace.workspaceId, tabId, anchor)}
          onClosePeek={() => shellActions.closePanel('left')}
        />
      ) : null}
    </>
  );
}

function OverlayWorkshop({ children }: { children: ReactNode }) {
  useEffect(() => {
    const escape = (event: KeyboardEvent) => {
      if (!event.defaultPrevented && event.key === 'Escape' && occlusion.top() === 'left' && !document.querySelector('dialog[open]')) {
        event.preventDefault();
        shellActions.closePanel('left');
      }
    };
    window.addEventListener('keydown', escape);
    return () => window.removeEventListener('keydown', escape);
  }, []);
  return (
    <aside className="workshop workshop-overlay" aria-label="Workshop（临时展开）">
      {children}
    </aside>
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
      <OverlayWorkshop>
        <WorkshopContent />
      </OverlayWorkshop>
    );
  }
  return null;
}
