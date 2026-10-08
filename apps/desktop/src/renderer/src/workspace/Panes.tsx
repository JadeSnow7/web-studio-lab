import { useCallback, useEffect, useRef, useState, type CSSProperties } from 'react';
import type { PaneLayout, WorkspaceSnapshot } from '@wsl/protocol';
import { Icon } from '../components/Icon';
import { occlusion } from '../state/occlusion';
import { workspaceCommand } from '../state/workspace';
import { Files } from './Files';
import { Browser } from './Browser';
import { Terminal } from './Terminal';
import { Session } from './Session';
import { resourceIcons as icons } from './icons';
function geometry(
  layout: PaneLayout,
  x = 0,
  y = 0,
  width = 100,
  height = 100,
): Array<{ paneId: string; tabId: string | null; style: CSSProperties }> {
  if (layout.kind === 'pane')
    return [
      { paneId: layout.paneId, tabId: layout.tabId, style: { left: `${x}%`, top: `${y}%`, width: `${width}%`, height: `${height}%` } },
    ];
  return layout.direction === 'horizontal'
    ? [
        ...geometry(layout.first, x, y, width * layout.ratio, height),
        ...geometry(layout.second, x + width * layout.ratio, y, width * (1 - layout.ratio), height),
      ]
    : [
        ...geometry(layout.first, x, y, width, height * layout.ratio),
        ...geometry(layout.second, x, y + height * layout.ratio, width, height * (1 - layout.ratio)),
      ];
}
export function WorkspaceContent({
  workspace,
  active,
  occluded,
  focus,
  narrow,
  onFocus,
  onOverlay,
}: {
  workspace: WorkspaceSnapshot;
  active: boolean;
  occluded: boolean;
  focus: boolean;
  narrow: boolean;
  onFocus: () => void;
  onOverlay: (open: boolean) => Promise<boolean>;
}) {
  const layout = geometry(workspace.layout);
  const [menu, setMenu] = useState<string | null>(null);
  const menuTrigger = useRef<HTMLButtonElement | null>(null);
  const closeMenu = useCallback(() => {
    setMenu(null);
    void onOverlay(false);
    const remainingSource = occlusion.top();
    requestAnimationFrame(() => {
      if (occlusion.top() === remainingSource) menuTrigger.current?.focus();
    });
  }, [onOverlay]);
  useEffect(() => {
    if (!active && menu) {
      requestAnimationFrame(() => setMenu(null));
      void onOverlay(false);
    }
    if (!active) return;
    const escape = (event: KeyboardEvent) => {
      if (!event.defaultPrevented && event.key === 'Escape' && occlusion.top() === 'pane-menu' && !document.querySelector('dialog[open]')) {
        event.preventDefault();
        closeMenu();
      }
    };
    if (menu) requestAnimationFrame(() => document.querySelector<HTMLElement>('.pane-menu [role="menuitem"]')?.focus());
    window.addEventListener('keydown', escape);
    return () => window.removeEventListener('keydown', escape);
  }, [active, menu, closeMenu, onOverlay]);
  const activePane = layout.find((p) => p.paneId === workspace.activePaneId)!;
  const displayed = (p: typeof activePane) => active && (!(focus || narrow) || p.paneId === activePane.paneId);
  const style = (p: typeof activePane) => (focus || narrow ? { left: 0, top: 0, width: '100%', height: '100%' } : p.style);
  const setPane = (paneId: string) => void workspaceCommand(workspace.workspaceId, { type: 'focusPane', paneId });
  return (
    <section className="workspace-panes" aria-label={`${workspace.name}工作现场`} hidden={!active}>
      {layout.map((p) => {
        const tab = workspace.tabs.find((t) => t.tabId === p.tabId);
        return (
          <section
            key={p.paneId}
            className={`workspace-pane ${p.paneId === workspace.activePaneId ? 'pane-active' : ''}`}
            data-pane-id={p.paneId}
            style={style(p)}
            hidden={!displayed(p)}
            onPointerDown={() => {
              if (p.paneId !== workspace.activePaneId) setPane(p.paneId);
            }}
          >
            <header className="pane-header">
              <button
                type="button"
                className="pane-title"
                aria-label={`聚焦窗格 · ${tab?.title ?? '空窗格'}`}
                onClick={() => setPane(p.paneId)}
              >
                {tab ? <Icon name={icons[tab.targetRef.kind]} /> : null}
                <span>{tab?.title ?? '空窗格'}</span>
              </button>
              <div className="row">
                <button
                  type="button"
                  className="icon-btn"
                  aria-label="左右分屏"
                  title="左右分屏"
                  onClick={() =>
                    void workspaceCommand(workspace.workspaceId, { type: 'splitPane', paneId: p.paneId, direction: 'horizontal' })
                  }
                >
                  ◫
                </button>
                <button
                  type="button"
                  className="icon-btn"
                  aria-label="上下分屏"
                  title="上下分屏"
                  onClick={() =>
                    void workspaceCommand(workspace.workspaceId, { type: 'splitPane', paneId: p.paneId, direction: 'vertical' })
                  }
                >
                  ⬒
                </button>
                <button
                  type="button"
                  className="icon-btn"
                  aria-label={focus ? '退出专注模式' : '专注当前窗格'}
                  title="专注当前窗格"
                  onClick={() => {
                    setPane(p.paneId);
                    onFocus();
                  }}
                >
                  ⤢
                </button>
                <button
                  type="button"
                  className="icon-btn"
                  aria-label="窗格操作"
                  onClick={async (event) => {
                    menuTrigger.current = event.currentTarget;
                    if (!(await onOverlay(menu === null))) return;
                    setMenu(menu ? null : p.paneId);
                  }}
                >
                  ···
                </button>
                {layout.length > 1 ? (
                  <button
                    type="button"
                    className="icon-btn"
                    aria-label="关闭窗格"
                    title="关闭窗格（标签保留）"
                    onClick={() => void workspaceCommand(workspace.workspaceId, { type: 'closePane', paneId: p.paneId })}
                  >
                    ×
                  </button>
                ) : null}
              </div>
            </header>
            {!tab ? <div className="workspace-empty">选择左侧标签，在此打开内容。</div> : null}
          </section>
        );
      })}
      {workspace.tabs.map((tab) => {
        const pane = layout.find((p) => p.tabId === tab.tabId);
        const visible = !!pane && displayed(pane);
        const resource = workspace.resources.find((r) => r.resourceId === tab.targetRef.resourceId);
        const session = workspace.sessions.find((s) => s.resourceId === tab.targetRef.resourceId);
        return (
          <div
            key={tab.tabId}
            className="pane-content-slot"
            style={pane ? style(pane) : {}}
            hidden={!visible}
            onPointerDown={() => {
              if (pane && pane.paneId !== workspace.activePaneId) setPane(pane.paneId);
            }}
          >
            {resource?.kind === 'web' ? (
              <Browser workspaceId={workspace.workspaceId} resource={resource} visible={visible} occluded={occluded} />
            ) : resource?.kind === 'terminal' || resource?.kind === 'ssh' ? (
              <Terminal
                workspaceId={workspace.workspaceId}
                resource={resource}
                visible={visible}
                active={visible && pane?.paneId === workspace.activePaneId}
                occluded={occluded}
                theme={workspace.theme}
              />
            ) : resource?.kind === 'file' ? (
              <Files workspace={workspace} resource={resource} />
            ) : session ? (
              <Session workspace={workspace} session={session} />
            ) : (
              <div className="workspace-empty">
                <h2>{tab.title}</h2>
                <p>{resource?.unavailableReason ?? '没有可用的内容适配器。'}</p>
              </div>
            )}
          </div>
        );
      })}
      {menu ? (
        <div className="pane-menu" role="menu" aria-label="窗格操作">
          <button
            type="button"
            role="menuitem"
            onClick={() => {
              void workspaceCommand(workspace.workspaceId, { type: 'setRatio', paneId: menu, ratio: 0.5 });
              closeMenu();
            }}
          >
            平均分割
          </button>
          <button
            type="button"
            role="menuitem"
            onClick={() => {
              closeMenu();
            }}
          >
            关闭菜单
          </button>
        </div>
      ) : null}
    </section>
  );
}
