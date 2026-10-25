import { tabTitle } from '../state/tab-title';
import type { CSSProperties } from 'react';
import type { PaneLayout, WorkspaceSnapshot } from '@wsl/protocol';
import { Icon } from '../components/Icon';
import { workspaceCommand } from '../state/workspace';
import { useStore } from '../lib/store';
import { menuAnchorFromClick, nativeMenuKey, nativeMenuStore } from '../state/native-menu';
import { showPaneMenu } from './native-menus';
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
}: {
  workspace: WorkspaceSnapshot;
  active: boolean;
  occluded: boolean;
  focus: boolean;
  narrow: boolean;
  onFocus: () => void;
}) {
  const layout = geometry(workspace.layout);
  const openMenu = useStore(nativeMenuStore, (s) => s.open);
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
                aria-label={`聚焦窗格 · ${tab ? tabTitle(workspace, tab) : '空窗格'}`}
                onClick={() => setPane(p.paneId)}
              >
                {tab ? <Icon name={icons[tab.targetRef.kind]} /> : null}
                <span>{tab ? tabTitle(workspace, tab) : '空窗格'}</span>
              </button>
              {/* 窗格头只保留标题、专注与更多（OPS-1 S5）：分屏、平均分割、关闭窗格在原生「窗格操作」菜单里。 */}
              <div className="row">
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
                  title="窗格操作"
                  aria-haspopup="menu"
                  aria-expanded={openMenu === nativeMenuKey('pane', { workspaceId: workspace.workspaceId, paneId: p.paneId })}
                  onClick={(event) => void showPaneMenu(workspace.workspaceId, p.paneId, menuAnchorFromClick(event, event.currentTarget))}
                >
                  ···
                </button>
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
    </section>
  );
}
