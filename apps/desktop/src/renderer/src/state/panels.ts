export interface PanelState {
  pinned: boolean;
  hidden: boolean;
  peek: boolean;
}
export type PanelMode = 'docked' | 'overlay' | 'collapsed';
export interface Panels {
  left: PanelState;
  right: PanelState;
}
export function panelMode(panel: PanelState, narrow: boolean): PanelMode {
  if (panel.pinned && !panel.hidden && !narrow) return 'docked';
  return panel.peek ? 'overlay' : 'collapsed';
}
export function closePanel(panel: PanelState): PanelState {
  return { ...panel, hidden: true, peek: false };
}
export function togglePanel(panel: PanelState, narrow: boolean): PanelState {
  if (panelMode(panel, narrow) !== 'collapsed') return closePanel(panel);
  return panel.pinned && !narrow ? { ...panel, hidden: false, peek: false } : { ...panel, peek: true };
}
export function pinPanel(_panel: PanelState, pinned: boolean): PanelState {
  return { pinned, hidden: false, peek: false };
}
export function persistPanels(panels: Panels): string {
  return JSON.stringify({ leftPinned: panels.left.pinned, rightPinned: panels.right.pinned });
}
export function restorePanels(raw: string | null): Panels {
  const stored: unknown = raw === null ? { leftPinned: true, rightPinned: false } : JSON.parse(raw);
  if (
    !stored ||
    typeof stored !== 'object' ||
    !('leftPinned' in stored) ||
    !('rightPinned' in stored) ||
    typeof stored.leftPinned !== 'boolean' ||
    typeof stored.rightPinned !== 'boolean'
  )
    throw new Error('侧栏偏好格式无效');
  return {
    left: { pinned: stored.leftPinned, hidden: false, peek: false },
    right: { pinned: stored.rightPinned, hidden: false, peek: false },
  };
}
