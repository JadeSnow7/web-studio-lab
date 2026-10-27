import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { installOcclusionHider, occlusion } from './occlusion';
import { spaceActions, spaceUiStore } from './space-ui';
import { workspaceStore } from './workspace';

class FocusTarget {
  isConnected = true;
  inClosedDialog = false;
  focus = vi.fn(() => {
    dom.activeElement = this;
  });
  closest(selector: string) {
    return selector === 'dialog:not([open])' && this.inClosedDialog ? {} : null;
  }
}
let frames: FrameRequestCallback[];
let trigger: FocusTarget;
let fallback: FocusTarget;
let dialog: { close: ReturnType<typeof vi.fn> };
let dom: { body: FocusTarget; activeElement: FocusTarget | null; querySelector: ReturnType<typeof vi.fn> };
const flushFrame = () => {
  const frame = frames.shift();
  if (!frame) throw new Error('missing restoration frame');
  frame(0);
};
const openEditor = () => spaceActions.openEditor({ kind: 'tab', tabKind: 'file' });
beforeEach(() => {
  frames = [];
  trigger = new FocusTarget();
  fallback = new FocusTarget();
  const body = new FocusTarget();
  dialog = {
    close: vi.fn(() => {
      dom.activeElement = body;
    }),
  };
  dom = {
    body,
    activeElement: trigger,
    querySelector: vi.fn((selector: string) => (selector === 'dialog.workspace-editor:not(.managed-app-dialog)' ? dialog : fallback)),
  };
  vi.stubGlobal('HTMLElement', FocusTarget);
  vi.stubGlobal('document', dom);
  vi.stubGlobal('localStorage', { getItem: () => null });
  vi.stubGlobal('requestAnimationFrame', (callback: FrameRequestCallback) => frames.push(callback));
  vi.stubGlobal('window', {
    studio: {
      workbench: { environments: vi.fn().mockResolvedValue([]) },
      shell: { nativeFocus: vi.fn().mockResolvedValue(null), focusWorkbench: vi.fn().mockResolvedValue(true) },
    },
  });
  workspaceStore.set(() => ({ snapshot: null, selectedId: 'workspace', error: null }));
  occlusion.store.set(() => ({}));
  installOcclusionHider(async () => true);
  spaceUiStore.set((state) => ({ ...state, switcher: false, editor: null }));
});
afterEach(() => {
  vi.unstubAllGlobals();
});
describe('editor deferred focus restoration', () => {
  it('does not steal new control focus after the dialog closes but before its restoration frame', async () => {
    await openEditor();
    spaceActions.closeEditor();
    expect(dialog.close).toHaveBeenCalledOnce();
    expect(spaceUiStore.get().editor).toBeNull();
    const next = new FocusTarget();
    next.focus();
    flushFrame();
    expect(trigger.focus).not.toHaveBeenCalled();
    expect(dom.activeElement).toBe(next);
  });
  it('returns focus to the trigger when closing leaves the body active', async () => {
    await openEditor();
    spaceActions.closeEditor();
    expect(dom.activeElement).toBe(dom.body);
    flushFrame();
    expect(trigger.focus).toHaveBeenCalledOnce();
    expect(dom.activeElement).toBe(trigger);
  });
  it('does not mistake a still-connected control in the closed dialog for valid new focus', async () => {
    await openEditor();
    spaceActions.closeEditor();
    const stale = new FocusTarget();
    stale.inClosedDialog = true;
    dom.activeElement = stale;
    flushFrame();
    expect(trigger.focus).toHaveBeenCalledOnce();
    expect(dom.activeElement).toBe(trigger);
  });
  it('falls back to the workspace switcher when the original trigger disappeared', async () => {
    await openEditor();
    trigger.isConnected = false;
    spaceActions.closeEditor();
    flushFrame();
    expect(trigger.focus).not.toHaveBeenCalled();
    expect(fallback.focus).toHaveBeenCalledOnce();
    expect(dom.activeElement).toBe(fallback);
  });
  it('a newer close invalidates an older restoration frame', async () => {
    await openEditor();
    spaceActions.closeEditor();
    const second = new FocusTarget();
    dom.activeElement = second;
    await openEditor();
    spaceActions.closeEditor();
    flushFrame();
    expect(trigger.focus).not.toHaveBeenCalled();
    expect(second.focus).not.toHaveBeenCalled();
    flushFrame();
    expect(second.focus).toHaveBeenCalledOnce();
    expect(dom.activeElement).toBe(second);
  });
  it('restores the trigger inside a surviving outer overlay without releasing that overlay', async () => {
    await occlusion.open('outer');
    await openEditor();
    spaceActions.closeEditor();
    expect(occlusion.visible('outer')).toBe(true);
    flushFrame();
    expect(trigger.focus).toHaveBeenCalledOnce();
    expect(occlusion.visible('outer')).toBe(true);
  });
  it('keeps focus already acquired by a new overlay', async () => {
    await openEditor();
    spaceActions.closeEditor();
    await occlusion.open('next-overlay');
    const next = new FocusTarget();
    next.focus();
    flushFrame();
    expect(trigger.focus).not.toHaveBeenCalled();
    expect(dom.activeElement).toBe(next);
    expect(occlusion.visible('next-overlay')).toBe(true);
  });
});
