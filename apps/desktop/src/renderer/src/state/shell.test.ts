import { describe, expect, it } from 'vitest';
import { initialShell, navigate } from './shell';
import { panelMode, pinPanel as setPinned, togglePanel, type PanelState as WorkshopState } from './panels';
const workshopMode = (panel: WorkshopState) => panelMode(panel, false);
const toggleWorkshop = (panel: WorkshopState) => togglePanel(panel, false);
const setPeek = (panel: WorkshopState, peek: boolean) => (workshopMode(panel) === 'docked' ? panel : { ...panel, peek });

const docked: WorkshopState = { pinned: true, hidden: false, peek: false };

describe('Workshop 显示状态', () => {
  it('⌘B 只切换显隐，不改变固定', () => {
    const hidden = toggleWorkshop(docked);
    expect(workshopMode(hidden)).toBe('collapsed');
    expect(hidden.pinned).toBe(true);
    expect(workshopMode(toggleWorkshop(hidden))).toBe('docked');
  });
  it('未固定时 ⌘B 打开或关闭临时覆盖层', () => {
    const unpinned = setPinned(docked, false);
    expect(workshopMode(unpinned)).toBe('collapsed');
    const overlay = toggleWorkshop(unpinned);
    expect(workshopMode(overlay)).toBe('overlay');
    expect(workshopMode(toggleWorkshop(overlay))).toBe('collapsed');
  });
  it('悬停展开不影响已固定的布局', () => {
    expect(setPeek(docked, true)).toBe(docked);
    const unpinned = setPinned(docked, false);
    expect(workshopMode(setPeek(unpinned, true))).toBe('overlay');
  });
  it('在覆盖层里固定后进入布局', () => {
    const overlay = setPeek(setPinned(docked, false), true);
    expect(workshopMode(setPinned(overlay, true))).toBe('docked');
  });
});

describe('全局路由与个人输入隔离', () => {
  it('六个全局路由互相直接可达，导航不改变空间业务或侧栏偏好', () => {
    for (const route of ['home', 'space', 'resources', 'conversations', 'tasks', 'settings'] as const) {
      const next = navigate(initialShell, route);
      expect(next.route).toBe(route);
      expect(next.workshop).toEqual(initialShell.workshop);
      expect(next.rightPanel).toEqual(initialShell.rightPanel);
    }
  });
});
