import { describe, expect, it } from 'vitest';
import { panelMode, togglePanel, pinPanel, closePanel, restorePanels, persistPanels } from './panels';
describe('shared left and notification panel contract', () => {
  it('starts with a docked left panel and collapsed notification, restores only pin preferences', () => {
    const state = restorePanels(null);
    expect(panelMode(state.left, false)).toBe('docked');
    expect(panelMode(state.right, false)).toBe('collapsed');
    const saved = persistPanels({ left: { pinned: false, hidden: true, peek: true }, right: { pinned: true, hidden: true, peek: true } });
    expect(JSON.parse(saved)).toEqual({ leftPinned: false, rightPinned: true });
    expect(restorePanels(saved)).toEqual({
      left: { pinned: false, hidden: false, peek: false },
      right: { pinned: true, hidden: false, peek: false },
    });
  });
  it('opening does not pin, closing preserves pin, unpinning collapses, narrow projection preserves preference', () => {
    const state = restorePanels(null);
    const opened = togglePanel(state.right, false);
    expect(opened.pinned).toBe(false);
    expect(panelMode(opened, false)).toBe('overlay');
    const pinned = pinPanel(opened, true);
    expect(panelMode(pinned, false)).toBe('docked');
    expect(closePanel(pinned).pinned).toBe(true);
    expect(panelMode(pinPanel(pinned, false), false)).toBe('collapsed');
    expect(panelMode(pinned, true)).toBe('collapsed');
    expect(panelMode(togglePanel(pinned, true), true)).toBe('overlay');
    expect(panelMode(pinned, false)).toBe('docked');
  });
});
