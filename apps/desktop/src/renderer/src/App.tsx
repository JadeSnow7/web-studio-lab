import { useEffect } from 'react';
import { ROUTE_TITLES } from './shell/routes';
import { useStore } from './lib/store';
import { NARROW_BREAKPOINT, useViewportWidth } from './lib/viewport';
import { ConversationsPage } from './pages/ConversationsPage';
import { HomePage } from './pages/HomePage';
import { ResourcesPage } from './pages/ResourcesPage';
import { SettingsPage } from './pages/SettingsPage';
import { SpacePage } from './pages/SpacePage';
import { TasksPage } from './pages/TasksPage';
import { ErrorToasts, ModalLayer } from './shell/Overlays';
import { RightPanel } from './shell/RightPanel';
import { TitleBar } from './shell/TitleBar';
import { Workshop } from './shell/Workshop';
import { shellStore, workshopMode } from './state/shell';
import { uiStore } from './state/ui';

/**
 * 全局壳：标题栏（标签 / 页面标题）、Workshop、内容区与右侧通信栏。
 * 六个页面始终挂载、按路由显示，页面切换不丢失输入与 Browser 区现场。
 */
export function App() {
  const route = useStore(shellStore, (s) => s.route);
  useEffect(() => {
    document.title = `${ROUTE_TITLES[route]} · Web Studio Lab`;
  }, [route]);
  const workshop = useStore(shellStore, (s) => s.workshop);
  const rightOpen = useStore(shellStore, (s) => s.rightPanel.open);
  const modalOpen = useStore(uiStore, (s) => s.modal !== null);
  const narrow = useViewportWidth() < NARROW_BREAKPOINT;

  const mode = workshopMode(workshop);
  const rightMode = !rightOpen ? 'closed' : narrow ? 'overlay' : 'docked';
  // 原生页面视图总在 renderer 之上：任何覆盖到内容区的浮层都要先让它让位。
  const occluded = mode === 'overlay' || rightMode === 'overlay' || modalOpen;

  return (
    <div className="app">
      <TitleBar />
      <div className="app-body">
        <Workshop mode={mode} />
        <main className="content">
          <div className="page" hidden={route !== 'home'}>
            <HomePage />
          </div>
          <div className="page" hidden={route !== 'space'}>
            <SpacePage active={route === 'space'} occluded={occluded} />
          </div>
          <div className="page" hidden={route !== 'resources'}>
            <ResourcesPage />
          </div>
          <div className="page" hidden={route !== 'conversations'}>
            <ConversationsPage />
          </div>
          <div className="page" hidden={route !== 'tasks'}>
            <TasksPage />
          </div>
          <div className="page" hidden={route !== 'settings'}>
            <SettingsPage />
          </div>
        </main>
        {rightMode !== 'closed' ? <RightPanel overlay={rightMode === 'overlay'} /> : null}
      </div>
      <ModalLayer />
      <ErrorToasts />
    </div>
  );
}
