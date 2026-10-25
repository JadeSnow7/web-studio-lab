import { beforeEach, describe, expect, it, vi } from 'vitest';
import { WorkbenchSnapshotSchema, WorkspaceSnapshotSchema } from '@wsl/protocol';
import * as workspace from './workspace';
import { shellStore } from './shell';
import { occlusion } from './occlusion';
import { nativeMenuStore } from './native-menu';
import { activeShortcutTab, dispatchShortcut, shortcutModalOpen } from './shortcuts';
import { toggleCapture } from './capture';
vi.mock('./capture', () => ({ toggleCapture: vi.fn(), cancelCapture: vi.fn() }));
vi.mock('./space-ui', () => ({ spaceActions: { openSwitcher: vi.fn() } }));
const page = { webContentsId: 42, documentGeneration: 1, url: 'wsl-demo://taskflow/index.html', title: '网页', partition: 'test' };
const space = () =>
  WorkspaceSnapshotSchema.parse({
    workspaceId: 'space',
    name: '空间',
    revision: 1,
    theme: 'light',
    layout: { kind: 'pane', paneId: 'pane', tabId: 'web-tab' },
    activePaneId: 'pane',
    tabs: [{ tabId: 'web-tab', title: '网页', targetRef: { kind: 'web', resourceId: 'web' }, pinned: false, group: null }],
    resources: [
      {
        resourceId: 'web',
        kind: 'web',
        environmentId: 'local',
        title: '网页',
        url: page.url,
        instanceId: 'instance',
        generation: 1,
        terminal: null,
        unavailableReason: null,
        preview: {
          page,
          loading: false,
          canGoBack: false,
          canGoForward: false,
          picking: false,
          cdp: { state: 'idle' },
          consoleIssueCount: 0,
          loadError: null,
          blockedNavigation: null,
          pickError: null,
        },
      },
    ],
    sessions: [],
    runs: [],
  });
let current: ReturnType<typeof space>;
beforeEach(() => {
  vi.stubGlobal('document', { activeElement: null });
  vi.clearAllMocks();
  current = space();
  workspace.workspaceStore.set(() => ({
    snapshot: WorkbenchSnapshotSchema.parse({
      appInstanceId: 'app',
      activeWorkspaceId: 'space',
      storageError: null,
      seq: 1,
      workspaces: [current],
    }),
    selectedId: 'space',
    error: null,
  }));
  const projected = workspace.workspaceStore.get().snapshot?.workspaces[0];
  if (!projected) throw new Error('missing projected workspace');
  current = projected;
  shellStore.set((state) => ({ ...state, route: 'space' }));
  occlusion.store.set(() => ({}));
  nativeMenuStore.set(() => ({ open: null }));
});
describe('B5 shortcut scope and guards', () => {
  it('allows tab-number navigation across document projection lag but retains native ownership and capture generation guards', async () => {
    const command = vi.spyOn(workspace, 'workspaceCommand').mockResolvedValue(null);
    const nativeBrowser = { workspaceId: 'space', resourceId: 'web', webContentsId: 42, documentGeneration: 2 };
    await dispatchShortcut({ command: 'activate-tab-1', nativeBrowser });
    expect(command).toHaveBeenCalledExactlyOnceWith('space', { type: 'activateTab', tabId: 'web-tab' });
    await dispatchShortcut({ command: 'toggle-capture', nativeBrowser });
    expect(toggleCapture).not.toHaveBeenCalled();
    await dispatchShortcut({ command: 'activate-tab-1', nativeBrowser: { ...nativeBrowser, workspaceId: 'other-space' } });
    await dispatchShortcut({ command: 'activate-tab-1', nativeBrowser: { ...nativeBrowser, webContentsId: 99 } });
    const resource = current.resources[0];
    if (!resource) throw new Error('missing native resource');
    resource.instanceId = null;
    await dispatchShortcut({ command: 'activate-tab-1', nativeBrowser });
    expect(command).toHaveBeenCalledTimes(1);
  });

  it('does not capture hidden workspace from settings, rejects stale native identity, and does not bypass unavailable toolbar', async () => {
    shellStore.set((state) => ({ ...state, route: 'settings' }));
    await dispatchShortcut({ command: 'toggle-capture', nativeBrowser: null });
    expect(toggleCapture).not.toHaveBeenCalled();
    shellStore.set((state) => ({ ...state, route: 'space' }));
    await dispatchShortcut({
      command: 'toggle-capture',
      nativeBrowser: { workspaceId: 'space', resourceId: 'web', webContentsId: 99, documentGeneration: 1 },
    });
    expect(toggleCapture).not.toHaveBeenCalled();
    const resource = current.resources[0];
    if (!resource?.preview) throw new Error('missing fixture page');
    resource.preview.loading = true;
    await dispatchShortcut({ command: 'toggle-capture', nativeBrowser: null });
    expect(toggleCapture).not.toHaveBeenCalled();
    resource.preview.loading = false;
    await dispatchShortcut({
      command: 'toggle-capture',
      nativeBrowser: { workspaceId: 'space', resourceId: 'web', webContentsId: 42, documentGeneration: 1 },
    });
    expect(toggleCapture).toHaveBeenCalledExactlyOnceWith('space', 'web');
  });
  it('blocks sending/context commands for modal or native menu, while a temporary sidebar is not a modal', () => {
    occlusion.store.set(() => ({ left: { token: 1, visible: true } }));
    expect(shortcutModalOpen()).toBe(false);
    occlusion.store.set((state) => ({ ...state, editor: { token: 2, visible: true } }));
    expect(shortcutModalOpen()).toBe(true);
    occlusion.store.set(() => ({}));
    nativeMenuStore.set(() => ({ open: 'test-menu' }));
    expect(shortcutModalOpen()).toBe(true);
  });
  it('native page ownership overrides the stale DOM session focus; a non-space route ignores that hidden DOM owner', () => {
    const focus = { closest: () => ({ getAttribute: () => 'session', closest: () => null }) } as unknown as Element;
    current.sessions = WorkspaceSnapshotSchema.shape.sessions.parse([
      {
        sessionId: 'session',
        resourceId: 'session-resource',
        title: '会话',
        draft: '',
        conversation: null,
        context: null,
        contextTarget: null,
        taskTargetRef: null,
        contextApplicability: 'unknown',
        taskVersions: [],
      },
    ]);
    current.tabs.push({
      tabId: 'session-tab',
      title: '会话',
      pinned: false,
      group: null,
      autoTitle: false,
      targetRef: { kind: 'session', resourceId: 'session-resource' },
    });
    expect(activeShortcutTab(current, focus, null)?.tabId).toBe('session-tab');
    expect(activeShortcutTab(current, focus, 'web')?.tabId).toBe('web-tab');
    shellStore.set((state) => ({ ...state, route: 'settings' }));
    expect(activeShortcutTab(current, focus, null)?.tabId).toBe('web-tab');
  });
});

describe('B5 new web address native layout handoff', () => {
  let events: EventTarget;
  let focusWorkbench: ReturnType<typeof vi.fn>;
  let focusAddress: ReturnType<typeof vi.fn>;
  let createdCount: number;
  beforeEach(() => {
    events = new EventTarget();
    focusWorkbench = vi.fn().mockResolvedValue(true);
    focusAddress = vi.fn();
    createdCount = 0;
    vi.stubGlobal('document', { activeElement: null, getElementById: vi.fn(() => ({ focus: focusAddress })) });
    vi.stubGlobal('window', {
      addEventListener: events.addEventListener.bind(events),
      removeEventListener: events.removeEventListener.bind(events),
      studio: { shell: { focusWorkbench } },
    });
    vi.spyOn(workspace, 'workspaceCommand').mockImplementation(async () => {
      createdCount++;
      const resourceId = `new-web-${createdCount}`;
      const tabId = `new-tab-${createdCount}`;
      const template = current.resources[0];
      if (!template?.preview) throw new Error('missing native page fixture');
      current.resources.push({
        ...template,
        resourceId,
        instanceId: `instance-${createdCount}`,
        preview: {
          ...template.preview,
          page: { ...template.preview.page, webContentsId: 100 + createdCount, documentGeneration: 1 },
          loading: false,
        },
      });
      current.tabs.push({ tabId, title: '新网页', pinned: false, group: null, autoTitle: false, targetRef: { kind: 'web', resourceId } });
      current.layout = { kind: 'pane', paneId: current.activePaneId, tabId };
      const snapshot = workspace.workspaceStore.get().snapshot;
      if (!snapshot) throw new Error('missing snapshot');
      workspace.workspaceStore.set((state) => ({ ...state, snapshot: { ...snapshot, seq: snapshot.seq + 1 } }));
      return { ok: true, snapshot };
    });
  });
  it('creates a new web resource when only the focused document generation leads the renderer projection', async () => {
    await dispatchShortcut({
      command: 'new-web-tab',
      nativeBrowser: { workspaceId: 'space', resourceId: 'web', webContentsId: 42, documentGeneration: 2 },
    });
    expect(workspace.workspaceCommand).toHaveBeenCalledExactlyOnceWith('space', {
      type: 'createTab',
      kind: 'web',
      title: '新网页',
      autoTitle: true,
    });
    expect(createdCount).toBe(1);
  });
  it('keeps stale capture and wrong workspace, resource or webContents rejected for new-web commands', async () => {
    const nativeBrowser = { workspaceId: 'space', resourceId: 'web', webContentsId: 42, documentGeneration: 2 };
    await dispatchShortcut({ command: 'toggle-capture', nativeBrowser });
    expect(toggleCapture).not.toHaveBeenCalled();
    for (const mismatch of [{ workspaceId: 'other' }, { resourceId: 'other' }, { webContentsId: 99 }]) {
      await dispatchShortcut({ command: 'new-web-tab', nativeBrowser: { ...nativeBrowser, ...mismatch } });
    }
    const resource = current.resources[0];
    if (!resource) throw new Error('missing original browser');
    resource.instanceId = null;
    await dispatchShortcut({ command: 'new-web-tab', nativeBrowser });
    expect(workspace.workspaceCommand).not.toHaveBeenCalled();
    expect(createdCount).toBe(0);
  });
  it('waits for an explicit successful layout receipt and claims the native handoff only once', async () => {
    const { createWebTab, completeNewWebAddressFocus, webAddressFocusStore } = await import('./shortcuts');
    await createWebTab();
    expect(focusWorkbench).not.toHaveBeenCalled();
    expect(webAddressFocusStore.get().intent?.resourceId).toBe('new-web-1');
    await Promise.all([completeNewWebAddressFocus('space', 'new-web-1', true), completeNewWebAddressFocus('space', 'new-web-1', true)]);
    expect(focusWorkbench).toHaveBeenCalledTimes(1);
    expect(focusAddress).toHaveBeenCalledTimes(1);
    expect(webAddressFocusStore.get().intent).toBeNull();
  });
  it('does not focus before the first native load completes, and cleans up an initial load failure', async () => {
    const { createWebTab, completeNewWebAddressFocus, webAddressFocusStore } = await import('./shortcuts');
    await createWebTab();
    const preview = current.resources.find((resource) => resource.resourceId === 'new-web-1')?.preview;
    if (!preview) throw new Error('missing new page');
    preview.page.documentGeneration = 0;
    await completeNewWebAddressFocus('space', 'new-web-1', true);
    expect(focusWorkbench).not.toHaveBeenCalled();
    preview.page.documentGeneration = 1;
    preview.loading = true;
    await completeNewWebAddressFocus('space', 'new-web-1', true);
    expect(focusWorkbench).not.toHaveBeenCalled();
    preview.loading = false;
    await completeNewWebAddressFocus('space', 'new-web-1', true);
    expect(focusWorkbench).toHaveBeenCalledTimes(1);
    expect(focusAddress).toHaveBeenCalledTimes(1);
    await createWebTab();
    const failed = current.resources.find((resource) => resource.resourceId === 'new-web-2')?.preview;
    if (!failed) throw new Error('missing failed page');
    failed.page.documentGeneration = 0;
    failed.loadError = { code: -1, description: 'initial load failed', url: page.url };
    await completeNewWebAddressFocus('space', 'new-web-2', true);
    expect(webAddressFocusStore.get().intent).toBeNull();
    expect(focusWorkbench).toHaveBeenCalledTimes(1);
  });
  it('cleans up a failed layout without focusing or silently retrying, and respects a nonforeground Main refusal', async () => {
    const { createWebTab, completeNewWebAddressFocus, webAddressFocusStore } = await import('./shortcuts');
    await createWebTab();
    await completeNewWebAddressFocus('space', 'new-web-1', false);
    await completeNewWebAddressFocus('space', 'new-web-1', true);
    expect(focusWorkbench).not.toHaveBeenCalled();
    expect(webAddressFocusStore.get().intent).toBeNull();
    await createWebTab();
    focusWorkbench.mockResolvedValue(false);
    await completeNewWebAddressFocus('space', 'new-web-2', true);
    expect(focusAddress).not.toHaveBeenCalled();
    expect(webAddressFocusStore.get().intent).toBeNull();
  });
  it('only the latest CmdT may focus; a pointer or user navigation revokes the pending intention', async () => {
    const { createWebTab, completeNewWebAddressFocus, webAddressFocusStore } = await import('./shortcuts');
    await Promise.all([createWebTab(), createWebTab()]);
    expect(webAddressFocusStore.get().intent?.resourceId).toBe('new-web-2');
    await completeNewWebAddressFocus('space', 'new-web-1', true);
    expect(focusWorkbench).not.toHaveBeenCalled();
    events.dispatchEvent(new Event('pointerdown'));
    await completeNewWebAddressFocus('space', 'new-web-2', true);
    expect(focusWorkbench).not.toHaveBeenCalled();
    await createWebTab();
    shellStore.set((state) => ({ ...state, route: 'settings' }));
    await completeNewWebAddressFocus('space', 'new-web-3', true);
    expect(focusWorkbench).not.toHaveBeenCalled();
    expect(webAddressFocusStore.get().intent).toBeNull();
  });
  it('rechecks intent after Main focus acknowledgement when the user has already moved elsewhere', async () => {
    const { createWebTab, completeNewWebAddressFocus } = await import('./shortcuts');
    let release: (focused: boolean) => void = () => {
      throw new Error('missing focus gate');
    };
    focusWorkbench.mockImplementation(
      () =>
        new Promise((resolve) => {
          release = resolve;
        }),
    );
    await createWebTab();
    const pending = completeNewWebAddressFocus('space', 'new-web-1', true);
    events.dispatchEvent(new Event('keydown'));
    release(true);
    await pending;
    expect(focusAddress).not.toHaveBeenCalled();
  });
});
