import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { initialShell, navigate, shellActions, shellStore } from './shell';
import { installOcclusionHider, occlusion } from './occlusion';
import { panelMode, pinPanel as setPinned, togglePanel, type PanelState as WorkshopState } from './panels';
const workshopMode = (panel: WorkshopState) => panelMode(panel, false);
const toggleWorkshop = (panel: WorkshopState) => togglePanel(panel, false);

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
  it('在覆盖层里固定后进入布局', () => {
    const overlay = toggleWorkshop(setPinned(docked, false));
    expect(workshopMode(setPinned(overlay, true))).toBe('docked');
  });
});

describe('标题栏侧栏动作与原生遮挡', () => {
  beforeEach(() => {
    vi.stubGlobal('window', { innerWidth: 1440 });
    vi.stubGlobal('document', { getElementById: vi.fn() });
    shellStore.set(() => initialShell);
    installOcclusionHider(async () => true);
  });
  afterEach(() => {
    occlusion.close('left');
    occlusion.close('right');
    shellStore.set(() => initialShell);
    vi.unstubAllGlobals();
  });
  it('专注模式的已固定左栏按可见收起状态展开，不建立不可见屏障', async () => {
    shellActions.toggleFocus();
    await shellActions.toggleWorkshop();
    expect(shellStore.get().focusMode).toBe(false);
    expect(workshopMode(shellStore.get().workshop)).toBe('docked');
    expect(occlusion.blocked()).toBe(false);
  });
  it('专注模式的未固定通知等待隐藏确认后才退出专注并展示', async () => {
    let confirm!: (hidden: boolean) => void;
    installOcclusionHider(
      () =>
        new Promise((resolve) => {
          confirm = resolve;
        }),
    );
    shellActions.toggleFocus();
    const opening = shellActions.toggleRightPanel();
    expect(shellStore.get().focusMode).toBe(true);
    expect(occlusion.visible('right')).toBe(false);
    confirm(true);
    await opening;
    expect(shellStore.get().focusMode).toBe(false);
    expect(workshopMode(shellStore.get().rightPanel)).toBe('overlay');
    expect(occlusion.visible('right')).toBe(true);
  });
  it('两栏可并存，关闭上层不释放另一栏的屏障，焦点回常驻触发器', async () => {
    const focus = vi.fn();
    vi.stubGlobal('document', { getElementById: vi.fn(() => ({ focus })) });
    shellStore.set((s) => ({ ...s, workshop: { pinned: false, hidden: false, peek: false } }));
    await shellActions.toggleWorkshop();
    await shellActions.toggleRightPanel();
    expect(occlusion.visible('left')).toBe(true);
    shellActions.closePanel('right');
    expect(occlusion.visible('left')).toBe(true);
    expect(occlusion.blocked()).toBe(true);
    expect(document.getElementById).toHaveBeenCalledWith('right-panel-trigger');
    expect(focus).toHaveBeenCalledOnce();
  });
  it('快速重复点击取消等待中的展开，迟到确认不能重新显示', async () => {
    let confirm!: (hidden: boolean) => void;
    installOcclusionHider(
      () =>
        new Promise((resolve) => {
          confirm = resolve;
        }),
    );
    const opening = shellActions.toggleRightPanel();
    shellActions.toggleRightPanel();
    confirm(true);
    await opening;
    expect(workshopMode(shellStore.get().rightPanel)).toBe('collapsed');
    expect(occlusion.blocked()).toBe(false);
  });
  it('内容区点击关闭不夺走当前输入焦点', async () => {
    await shellActions.toggleRightPanel();
    shellActions.closePanel('right', false);
    expect(document.getElementById).not.toHaveBeenCalled();
    expect(workshopMode(shellStore.get().rightPanel)).toBe('collapsed');
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
