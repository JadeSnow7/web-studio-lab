import { createStore } from '../lib/store';
import { closePanel, panelMode, pinPanel, restorePanels, togglePanel, persistPanels, type PanelState } from './panels';
import { occlusion } from './occlusion';
import { reportError } from './errors';
import { beginNavigation } from './workspace';
export type Route = 'home' | 'space' | 'resources' | 'conversations' | 'tasks' | 'workflows' | 'settings';
export interface ShellState {
  route: Route;
  workshop: PanelState;
  rightPanel: PanelState;
  focusMode: boolean;
}
export const initialShell: ShellState = {
  route: 'space',
  workshop: { pinned: true, hidden: false, peek: false },
  rightPanel: { pinned: false, hidden: false, peek: false },
  focusMode: false,
};
export function navigate(state: ShellState, route: Route): ShellState {
  return { ...state, route };
}
export const shellStore = createStore<ShellState>(initialShell);
export const routeLabels: Record<Route, string> = {
  home: '首页',
  space: '空间',
  resources: '资源',
  conversations: '会话',
  tasks: '任务',
  workflows: '工作流',
  settings: '应用设置',
};
export const workshopMode = panelMode;
export type WorkshopMode = ReturnType<typeof panelMode>;
export const preferenceKey = 'wsl-shell-panels-v1';
export function initializeShell() {
  try {
    const panels = restorePanels(localStorage.getItem(preferenceKey));
    shellStore.set((s) => ({ ...s, workshop: panels.left, rightPanel: panels.right }));
  } catch (error) {
    reportError('读取侧栏偏好', error);
  }
}
const narrow = () => window.innerWidth < 1080;
type Side = 'left' | 'right';
const key = (side: Side) => (side === 'left' ? 'workshop' : 'rightPanel');
const restoreTrigger = (side: Side) => document.getElementById(side === 'left' ? 'left-panel-trigger' : 'right-panel-trigger')?.focus();
async function updatePanel(side: Side, next: PanelState) {
  const field = key(side);
  if (panelMode(next, narrow()) === 'overlay' && !(await occlusion.open(side))) return;
  shellStore.set((s) => ({ ...s, focusMode: false, [field]: next }));
  if (panelMode(next, narrow()) !== 'overlay') occlusion.close(side);
}
function toggleShellPanel(side: Side) {
  if (occlusion.store.get()[side] && !occlusion.visible(side)) {
    shellActions.closePanel(side);
    return;
  }
  const state = shellStore.get();
  // Focus mode visually collapses both panes, so the first activation opens
  // the requested pane even if its underlying pinned state was docked.
  const current = state.focusMode ? closePanel(state[key(side)]) : state[key(side)];
  return updatePanel(side, togglePanel(current, narrow()));
}
export const shellActions = {
  navigate: (route: Route) => {
    beginNavigation();
    const peeking = shellStore.get().workshop.peek || !!occlusion.store.get()['left'];
    shellStore.set((s) => navigate(s, route));
    if (peeking) shellActions.closePanel('left');
  },
  toggleWorkshop: () => toggleShellPanel('left'),
  toggleRightPanel: () => toggleShellPanel('right'),
  closePanel: (side: Side, restoreFocus = true) => {
    occlusion.close(side);
    shellStore.set((s) => ({ ...s, [key(side)]: closePanel(s[key(side)]) }));
    if (restoreFocus) restoreTrigger(side);
  },
  setPinned: async (pinned: boolean, side: Side = 'left') => {
    const next = pinPanel(shellStore.get()[key(side)], pinned);
    await updatePanel(side, next);
    try {
      const s = shellStore.get();
      localStorage.setItem(preferenceKey, persistPanels({ left: s.workshop, right: s.rightPanel }));
    } catch (error) {
      reportError('保存侧栏偏好', error);
    }
  },
  setPeek: (peek: boolean, side: Side = 'left') =>
    peek ? updatePanel(side, { ...shellStore.get()[key(side)], peek: true }) : shellActions.closePanel(side),
  toggleFocus: () => {
    occlusion.close('left');
    occlusion.close('right');
    shellStore.set((s) => ({
      ...s,
      focusMode: !s.focusMode,
      workshop: { ...s.workshop, peek: false },
      rightPanel: { ...s.rightPanel, peek: false },
    }));
  },
};
