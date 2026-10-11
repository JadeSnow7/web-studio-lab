import { initializeSetup } from './state/setup';
import { useEffect, useRef, useState } from 'react';
import { ROUTE_TITLES } from './shell/routes';
import { useStore } from './lib/store';
import { useViewportWidth } from './lib/viewport';
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
import { shellActions, shellStore, initializeShell } from './state/shell';
import { panelMode } from './state/panels';
import { workspaceStore, initializeWorkspace, panes } from './state/workspace';
import { occlusion } from './state/occlusion';
import { spaceActions } from './state/space-ui';
import { startStatusPresentationSync } from './state/status-view';
export function App() {
  const shell = useStore(shellStore, (s) => s);
  const state = useStore(workspaceStore, (s) => s);
  const barriers = useStore(occlusion.store, (s) => s);
  const narrow = useViewportWidth() < 1080;
  const workspace = state.snapshot?.workspaces.find((w) => w.workspaceId === state.selectedId);
  useEffect(() => {
    initializeShell();
    void initializeWorkspace();
    const unsubscribe = initializeSetup();
    const unsyncStatus = startStatusPresentationSync();
    void Promise.all([window.studio.app.getInfo(), window.studio.setup.status()])
      .then(([info, setup]) => {
        if (info.packaged && (setup.stage !== 'ready' || setup.error)) shellActions.navigate('settings');
      })
      .catch((error: unknown) => console.error('安装状态初始化失败', error));
    return () => {
      unsubscribe();
      unsyncStatus();
    };
  }, []);
  useEffect(() => {
    document.title = `${ROUTE_TITLES[shell.route]} · ${workspace?.name ?? '加载空间'} · Web Studio Lab`;
  }, [shell.route, workspace?.name]);
  const theme = workspace?.theme;
  useEffect(() => {
    if (!theme) return;
    const media = window.matchMedia('(prefers-color-scheme: dark)');
    const update = () => {
      document.documentElement.dataset['theme'] = theme === 'system' ? (media.matches ? 'dark' : 'light') : theme;
    };
    update();
    media.addEventListener('change', update);
    return () => media.removeEventListener('change', update);
  }, [theme]);
  useEffect(
    () =>
      window.studio.shell.onCommand((c) => {
        if (c === 'toggle-workshop') void shellActions.toggleWorkshop();
        if (c === 'toggle-right-panel') void shellActions.toggleRightPanel();
        if (c === 'toggle-focus-mode') shellActions.toggleFocus();
        if (c === 'open-settings') shellActions.navigate('settings');
        if (c === 'focus-address') {
          void window.studio.workbench
            .getSnapshot()
            .then((snapshot) => {
              const w = snapshot.workspaces.find((x) => x.workspaceId === snapshot.activeWorkspaceId);
              const pane = w && panes(w.layout).find((x) => x.paneId === w.activePaneId);
              const tab = w?.tabs.find((x) => x.tabId === pane?.tabId);
              if (tab?.targetRef.kind === 'web') document.getElementById(`address-${tab.targetRef.resourceId}`)?.focus();
            })
            .catch((error: unknown) =>
              workspaceStore.set((s) => ({ ...s, error: error instanceof Error ? error.message : String(error) })),
            );
        }
      }),
    [],
  );
  const leftMode = shell.focusMode ? 'collapsed' : panelMode(shell.workshop, narrow);
  const rightMode = shell.focusMode ? 'collapsed' : panelMode(shell.rightPanel, narrow);
  useEffect(() => {
    const dismiss = (event: MouseEvent) => {
      const top = occlusion.top();
      if (top !== 'left' && top !== 'right') return;
      const target = event.target;
      if (!(target instanceof Element)) return;
      // A nested menu/dialog owns dismissal; clicking either pane or its trigger
      // keeps the other pane open so both can be used together.
      if (target.closest('dialog, [role="menu"], .workshop, .right-panel, #left-panel-trigger, #right-panel-trigger')) return;
      const other = top === 'left' ? 'right' : 'left';
      if (occlusion.store.get()[other]) shellActions.closePanel(other, false);
      shellActions.closePanel(top, false);
    };
    // Bubble after React handlers acquire any nested menu/dialog barrier.
    document.addEventListener('click', dismiss);
    return () => document.removeEventListener('click', dismiss);
  }, []);
  useEffect(() => {
    const clearLeft = leftMode !== 'overlay' && shell.workshop.peek;
    const clearRight = rightMode !== 'overlay' && shell.rightPanel.peek;
    if (clearLeft) occlusion.close('left');
    if (clearRight) occlusion.close('right');
    if (clearLeft || clearRight) {
      // A temporary narrow-window peek must not reappear without reacquiring the native-view barrier.
      shellStore.set((s) => ({
        ...s,
        workshop: clearLeft ? { ...s.workshop, peek: false } : s.workshop,
        rightPanel: clearRight ? { ...s.rightPanel, peek: false } : s.rightPanel,
      }));
    }
  }, [leftMode, rightMode, shell.workshop.peek, shell.rightPanel.peek]);
  const occluded = Object.keys(barriers).length > 0;
  // 存储横幅出现时，Toast 整体上移到横幅之上，两者互不遮挡；横幅本身的位置与文案不变。
  const storageError = state.snapshot?.storageError;
  const banner = useRef<HTMLParagraphElement>(null);
  const [bannerHeight, setBannerHeight] = useState(0);
  useEffect(() => {
    const node = banner.current;
    if (!storageError || !node) return;
    // ResizeObserver 在 observe 之后会立即回调一次，所以不需要在 effect 里同步 setState。
    const observer = new ResizeObserver(() => setBannerHeight(Math.ceil(node.getBoundingClientRect().height)));
    observer.observe(node);
    return () => observer.disconnect();
  }, [storageError]);
  return (
    <div
      className="app remake-app"
      style={storageError && bannerHeight ? ({ '--storage-banner-h': `${bannerHeight + 8}px` } as React.CSSProperties) : undefined}
    >
      <TitleBar leftMode={leftMode} rightMode={rightMode} />
      <div className="app-body">
        <Workshop mode={leftMode} />
        <main className="content">
          <div className="page" hidden={shell.route !== 'home'}>
            <HomePage onCreateWorkspace={() => void spaceActions.openEditor({ kind: 'workspace' })} />
          </div>
          <div className="page" hidden={shell.route !== 'space'}>
            <SpacePage active={shell.route === 'space'} occluded={occluded} />
          </div>
          <div className="page" hidden={shell.route !== 'resources'}>
            <ResourcesPage />
          </div>
          <div className="page" hidden={shell.route !== 'conversations'}>
            <ConversationsPage />
          </div>
          <div className="page" hidden={shell.route !== 'tasks'}>
            <TasksPage />
          </div>
          <div className="page" hidden={shell.route !== 'settings'}>
            <SettingsPage />
          </div>
        </main>
        <RightPanel mode={rightMode} />
      </div>
      <ModalLayer />
      <ErrorToasts />
      {storageError ? (
        <p role="alert" className="workspace-error" ref={banner}>
          持久化失败：{storageError}。当前状态仅保留在内存中。
        </p>
      ) : null}
    </div>
  );
}
