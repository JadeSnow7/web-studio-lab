import { describe, expect, it } from 'vitest';
import { initialShell, navigate, setPeek, setPinned, toggleWorkshop, workshopMode, type WorkshopState } from './shell';

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

describe('路由与作用域', () => {
  it('进入首页切到个人作用域，管理页保持当前作用域，回到空间恢复空间作用域', () => {
    const home = navigate(initialShell, 'home');
    expect(home.activeScope).toEqual({ kind: 'personal' });
    const tasks = navigate(home, 'tasks');
    expect(tasks.activeScope).toEqual({ kind: 'personal' });
    const space = navigate(tasks, 'space');
    expect(space.activeScope.kind).toBe('space');
  });
  it('导航时收起临时展开的 Workshop', () => {
    const peeking = { ...initialShell, workshop: { pinned: false, hidden: false, peek: true } };
    expect(navigate(peeking, 'home').workshop.peek).toBe(false);
  });
});
