import { createStore } from '../lib/store';
import { DEMO_SPACE } from '../domain/space';

export type Route = 'home' | 'space' | 'resources' | 'conversations' | 'tasks' | 'settings';
export type BrowserTab = 'preview' | 'terminal' | 'log' | 'diff' | 'report';
export type RightTab = 'space' | 'contacts' | 'feed';

/** 当前输入作用域：首页是个人作用域，进入空间后才是该空间。 */
export type Scope = { kind: 'personal' } | { kind: 'space'; spaceId: string };

/**
 * Workshop 的显示由三个独立量决定：
 * pinned 由图钉控制，hidden 由 ⌘B 控制，peek 是悬停或点击把手时的临时展开。
 */
export interface WorkshopState {
  pinned: boolean;
  hidden: boolean;
  peek: boolean;
}
export type WorkshopMode = 'docked' | 'overlay' | 'collapsed';

export interface ShellState {
  route: Route;
  activeScope: Scope;
  workshop: WorkshopState;
  rightPanel: { open: boolean; tab: RightTab };
  browserTab: BrowserTab;
}

export const initialShell: ShellState = {
  route: 'space',
  activeScope: { kind: 'space', spaceId: DEMO_SPACE.id },
  workshop: { pinned: true, hidden: false, peek: false },
  rightPanel: { open: true, tab: 'space' },
  browserTab: 'preview',
};

export function workshopMode(w: WorkshopState): WorkshopMode {
  if (w.pinned && !w.hidden) return 'docked';
  return w.peek ? 'overlay' : 'collapsed';
}

/** ⌘B：只切换显隐，不改变是否固定。 */
export function toggleWorkshop(w: WorkshopState): WorkshopState {
  const mode = workshopMode(w);
  if (mode === 'docked') return { ...w, hidden: true, peek: false };
  if (w.pinned) return { ...w, hidden: false, peek: false };
  return { ...w, peek: !w.peek };
}

/** 图钉：固定后进入布局；取消固定后收起，靠左边缘悬停或把手再次展开。 */
export function setPinned(_w: WorkshopState, pinned: boolean): WorkshopState {
  return { pinned, hidden: false, peek: false };
}

export function setPeek(w: WorkshopState, peek: boolean): WorkshopState {
  if (workshopMode(w) === 'docked' || w.peek === peek) return w;
  return { ...w, peek };
}

export function navigate(state: ShellState, route: Route): ShellState {
  let activeScope = state.activeScope;
  if (route === 'home') activeScope = { kind: 'personal' };
  if (route === 'space') activeScope = { kind: 'space', spaceId: DEMO_SPACE.id };
  return { ...state, route, activeScope, workshop: setPeek(state.workshop, false) };
}

export const shellStore = createStore<ShellState>(initialShell);

export const shellActions = {
  navigate: (route: Route) => shellStore.set((s) => navigate(s, route)),
  toggleWorkshop: () => shellStore.set((s) => ({ ...s, workshop: toggleWorkshop(s.workshop) })),
  setPinned: (pinned: boolean) => shellStore.set((s) => ({ ...s, workshop: setPinned(s.workshop, pinned) })),
  setPeek: (peek: boolean) =>
    shellStore.set((s) => {
      const workshop = setPeek(s.workshop, peek);
      return workshop === s.workshop ? s : { ...s, workshop };
    }),
  toggleRightPanel: () => shellStore.set((s) => ({ ...s, rightPanel: { ...s.rightPanel, open: !s.rightPanel.open } })),
  openRightPanel: (tab: RightTab) => shellStore.set((s) => ({ ...s, rightPanel: { open: true, tab } })),
  setBrowserTab: (tab: BrowserTab) => shellStore.set((s) => (s.browserTab === tab ? s : { ...s, browserTab: tab })),
};
