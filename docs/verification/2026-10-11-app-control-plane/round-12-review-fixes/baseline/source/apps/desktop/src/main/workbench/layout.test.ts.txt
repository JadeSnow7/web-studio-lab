import { describe, expect, it } from 'vitest';
import { activateTab, closePane, closeTab, panes, splitPane } from './layout';
import type { PaneLayout } from '@wsl/protocol';

describe('workbench layout lifecycle', () => {
  const initial: PaneLayout = { kind: 'pane', paneId: 'p1', tabId: 't1' };
  it('focuses an already visible tab without duplicating it', () => {
    const split = splitPane(initial, 'p1', 'horizontal', 'p2', 't2');
    const result = activateTab(split, 'p1', 't2');
    expect(result.activePaneId).toBe('p2');
    expect(result.layout).toEqual(split);
  });
  it('closing a pane removes only that view; closing a tab leaves an empty pane', () => {
    const split = splitPane(initial, 'p1', 'vertical', 'p2', 't2');
    expect(closePane(split, 'p2')).toEqual(initial);
    expect(panes(closeTab(split, 't2'))[1]?.tabId).toBeNull();
  });
  it('rejects a fifth pane and duplicate visible tabs', () => {
    let tree: PaneLayout = initial;
    for (let n = 2; n <= 4; n++) tree = splitPane(tree, 'p1', 'horizontal', `p${n}`, null);
    expect(() => splitPane(tree, 'p1', 'vertical', 'p5', null)).toThrow('pane_limit');
    expect(() => splitPane(initial, 'p1', 'vertical', 'p2', 't1')).toThrow('conflict');
  });
});
