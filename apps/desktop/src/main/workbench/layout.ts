import type { PaneLayout } from '@wsl/protocol';
export type Pane = Extract<PaneLayout, { kind: 'pane' }>;
export function panes(layout: PaneLayout): Pane[] {
  return layout.kind === 'pane' ? [layout] : [...panes(layout.first), ...panes(layout.second)];
}
function replace(layout: PaneLayout, paneId: string, transform: (pane: Pane) => PaneLayout): PaneLayout {
  if (layout.kind === 'pane') return layout.paneId === paneId ? transform(layout) : layout;
  return { ...layout, first: replace(layout.first, paneId, transform), second: replace(layout.second, paneId, transform) };
}
export function activateTab(layout: PaneLayout, paneId: string, tabId: string): { layout: PaneLayout; activePaneId: string } {
  const current = panes(layout).find((pane) => pane.tabId === tabId);
  if (current) return { layout, activePaneId: current.paneId };
  if (!panes(layout).some((pane) => pane.paneId === paneId)) throw new Error('not_found: 窗格不存在');
  return { layout: replace(layout, paneId, (pane) => ({ ...pane, tabId })), activePaneId: paneId };
}
export function splitPane(
  layout: PaneLayout,
  paneId: string,
  direction: 'horizontal' | 'vertical',
  newPaneId: string,
  tabId: string | null,
): PaneLayout {
  const leaves = panes(layout);
  if (leaves.length >= 4) throw new Error('pane_limit: 最多显示四个窗格');
  if (!leaves.some((pane) => pane.paneId === paneId)) throw new Error('not_found: 窗格不存在');
  if (tabId && leaves.some((pane) => pane.tabId === tabId)) throw new Error('conflict: 标签已在其他窗格显示');
  return replace(layout, paneId, (pane) => ({
    kind: 'split',
    direction,
    ratio: 0.5,
    first: pane,
    second: { kind: 'pane', paneId: newPaneId, tabId },
  }));
}
export function closePane(layout: PaneLayout, paneId: string): PaneLayout {
  if (layout.kind === 'pane') return layout.paneId === paneId ? { ...layout, tabId: null } : layout;
  if (layout.first.kind === 'pane' && layout.first.paneId === paneId) return layout.second;
  if (layout.second.kind === 'pane' && layout.second.paneId === paneId) return layout.first;
  return { ...layout, first: closePane(layout.first, paneId), second: closePane(layout.second, paneId) };
}
export function closeTab(layout: PaneLayout, tabId: string): PaneLayout {
  if (layout.kind === 'pane') return layout.tabId === tabId ? { ...layout, tabId: null } : layout;
  return { ...layout, first: closeTab(layout.first, tabId), second: closeTab(layout.second, tabId) };
}
export function setRatio(layout: PaneLayout, paneId: string, ratio: number): PaneLayout {
  if (layout.kind === 'pane') return layout;
  if (
    (layout.first.kind === 'pane' && layout.first.paneId === paneId) ||
    (layout.second.kind === 'pane' && layout.second.paneId === paneId)
  )
    return { ...layout, ratio };
  return { ...layout, first: setRatio(layout.first, paneId, ratio), second: setRatio(layout.second, paneId, ratio) };
}
