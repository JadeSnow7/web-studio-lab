import { beforeEach, describe, expect, it, vi } from 'vitest';
import { installOcclusionHider, occlusion } from './occlusion';
import { spaceActions, spaceUiStore } from './space-ui';
const native = { workspaceId: 'w', resourceId: 'page', webContentsId: 42, documentGeneration: 1 };
let original: { isConnected: boolean; focus: ReturnType<typeof vi.fn>; closest: ReturnType<typeof vi.fn> };
let query: ReturnType<typeof vi.fn>;
let restore: ReturnType<typeof vi.fn>;
beforeEach(() => {
  original = { isConnected: true, focus: vi.fn(), closest: vi.fn(() => null) };
  query = vi.fn().mockResolvedValue(native);
  restore = vi.fn().mockResolvedValue(true);
  vi.stubGlobal('document', { activeElement: original, querySelector: vi.fn(() => null) });
  vi.stubGlobal('HTMLElement', Object);
  vi.stubGlobal('requestAnimationFrame', (callback: () => void) => queueMicrotask(callback));
  vi.stubGlobal('window', {
    studio: { shell: { nativeFocus: query, focusWorkbench: vi.fn().mockResolvedValue(true), restoreBrowserFocus: restore } },
  });
  occlusion.store.set(() => ({}));
  installOcclusionHider(async () => true);
  spaceUiStore.set((state) => ({ ...state, switcher: false, editor: null }));
});
describe('B5 palette focus lifecycle', () => {
  it('coalesces repeated openings before native focus lookup settles, restoring the first native identity', async () => {
    let release: (value: typeof native) => void = () => {
      throw new Error('missing gate');
    };
    query.mockImplementation(
      () =>
        new Promise((resolve) => {
          release = resolve;
        }),
    );
    const opening = spaceActions.openSwitcher();
    await spaceActions.openSwitcher();
    expect(query).toHaveBeenCalledTimes(1);
    release(native);
    await opening;
    expect(spaceUiStore.get().switcher).toBe(true);
    spaceActions.closeSwitcher();
    await vi.waitFor(() => expect(restore).toHaveBeenCalledExactlyOnceWith(native));
    expect(original.focus).not.toHaveBeenCalled();
  });
  it('transfers the original native identity from palette to its editor instead of restoring stale DOM focus', async () => {
    await spaceActions.openSwitcher(native);
    await spaceActions.openEditor({ kind: 'workspace' });
    expect(spaceUiStore.get().switcher).toBe(false);
    expect(spaceUiStore.get().editor?.kind).toBe('workspace');
    expect(restore).not.toHaveBeenCalled();
    spaceActions.closeEditor();
    await vi.waitFor(() => expect(restore).toHaveBeenCalledExactlyOnceWith(native));
  });
  it('does not restore a dismissed palette when a result begins navigation', async () => {
    await spaceActions.openSwitcher(native);
    spaceActions.closeSwitcher(false);
    await Promise.resolve();
    expect(restore).not.toHaveBeenCalled();
    expect(original.focus).not.toHaveBeenCalled();
  });
});

describe('B6 palette hide acknowledgement and foreground guard', () => {
  it('waits for a successful hide acknowledgement before requesting focus and coalesces another opening', async () => {
    let acknowledge: (ok: boolean) => void = () => {
      throw new Error('missing hide gate');
    };
    const hide = vi.fn(
      () =>
        new Promise<boolean>((resolve) => {
          acknowledge = resolve;
        }),
    );
    installOcclusionHider(hide);
    const focus = vi.mocked(window.studio.shell.focusWorkbench);
    const pending = spaceActions.openSwitcher(null);
    expect(occlusion.blocked()).toBe(true);
    expect(spaceUiStore.get().switcher).toBe(false);
    expect(focus).not.toHaveBeenCalled();
    await spaceActions.openSwitcher(null);
    expect(hide).toHaveBeenCalledTimes(1);
    acknowledge(true);
    await pending;
    expect(focus).toHaveBeenCalledTimes(1);
    expect(spaceUiStore.get().switcher).toBe(true);
    spaceActions.closeSwitcher(false);
  });
  it('a delayed failed hide does not request focus or expose the dialog and can be opened again', async () => {
    let acknowledge: (ok: boolean) => void = () => {
      throw new Error('missing hide gate');
    };
    installOcclusionHider(
      () =>
        new Promise<boolean>((resolve) => {
          acknowledge = resolve;
        }),
    );
    const pending = spaceActions.openSwitcher(null);
    expect(occlusion.blocked()).toBe(true);
    acknowledge(false);
    await pending;
    expect(window.studio.shell.focusWorkbench).not.toHaveBeenCalled();
    expect(spaceUiStore.get().switcher).toBe(false);
    expect(occlusion.blocked()).toBe(false);
    installOcclusionHider(async () => true);
    await spaceActions.openSwitcher(null);
    expect(spaceUiStore.get().switcher).toBe(true);
    spaceActions.closeSwitcher(false);
  });
  it('a focus refusal after successful hide releases the barrier without restoring focus; a later foreground request recovers', async () => {
    const focus = vi.mocked(window.studio.shell.focusWorkbench);
    focus.mockResolvedValueOnce(false);
    await spaceActions.openSwitcher(null);
    expect(focus).toHaveBeenCalledTimes(1);
    expect(spaceUiStore.get().switcher).toBe(false);
    expect(occlusion.blocked()).toBe(false);
    expect(original.focus).not.toHaveBeenCalled();
    expect(restore).not.toHaveBeenCalled();
    await spaceActions.openSwitcher(null);
    expect(spaceUiStore.get().switcher).toBe(true);
    spaceActions.closeSwitcher(false);
  });
});
