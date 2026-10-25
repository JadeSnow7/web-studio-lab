import type { ShellCommandEvent, WorkspaceSnapshot } from '@wsl/protocol';
import { panes, workspaceStore, workspaceCommand, workspaceSwitchPending, beginNavigation, isCurrentNavigation } from './workspace';
import { shellActions, shellStore } from './shell';
import { spaceActions } from './space-ui';
import { toggleCapture, cancelCapture } from './capture';
import { occlusion } from './occlusion';
import { nativeMenuStore } from './native-menu';
import { createStore } from '../lib/store';

export const shortcutModalOpen = () =>
  !!nativeMenuStore.get().open || Object.keys(occlusion.store.get()).some((key) => key !== 'left' && key !== 'right');

export function activeShortcutTab(workspace: WorkspaceSnapshot, focus: Element | null, nativeResourceId: string | null) {
  // DOM focus remains on its last input while a native page owns the keyboard.
  const owner = !nativeResourceId && shellStore.get().route === 'space' ? focus?.closest('[data-session-id]') : null;
  const session = workspace.sessions.find((item) => item.sessionId === owner?.getAttribute('data-session-id'));
  if (session && !owner?.closest('[hidden]')) return workspace.tabs.find((tab) => tab.targetRef.resourceId === session.resourceId);
  if (nativeResourceId) return workspace.tabs.find((tab) => tab.targetRef.resourceId === nativeResourceId);
  const pane = panes(workspace.layout).find((item) => item.paneId === workspace.activePaneId);
  return workspace.tabs.find((tab) => tab.tabId === pane?.tabId);
}

interface NewWebAddressFocus {
  request: number;
  workspaceId: string;
  resourceId: string;
  tabId: string;
  navigation: number;
}
export const webAddressFocusStore = createStore<{ intent: NewWebAddressFocus | null }>({ intent: null });
let newWebRequest = 0;
let releaseAddressFocus = () => {};
function cancelAddressFocus() {
  newWebRequest++;
  releaseAddressFocus();
  releaseAddressFocus = () => {};
  webAddressFocusStore.set(() => ({ intent: null }));
}
function addressFocusCurrent(intent: NewWebAddressFocus) {
  const state = workspaceStore.get();
  const workspace = state.snapshot?.workspaces.find((item) => item.workspaceId === intent.workspaceId);
  return (
    intent.request === newWebRequest &&
    isCurrentNavigation(intent.navigation) &&
    state.selectedId === intent.workspaceId &&
    state.snapshot?.activeWorkspaceId === intent.workspaceId &&
    shellStore.get().route === 'space' &&
    !workspaceSwitchPending() &&
    !occlusion.blocked() &&
    !!workspace &&
    panes(workspace.layout).some((pane) => pane.paneId === workspace.activePaneId && pane.tabId === intent.tabId)
  );
}
/** Browser calls this only after its native browserLayout command has returned, including construction and visibility. */
export async function completeNewWebAddressFocus(workspaceId: string, resourceId: string, layoutSucceeded: boolean) {
  const intent = webAddressFocusStore.get().intent;
  if (!intent || intent.workspaceId !== workspaceId || intent.resourceId !== resourceId) return;
  const resource = workspaceStore
    .get()
    .snapshot?.workspaces.find((workspace) => workspace.workspaceId === workspaceId)
    ?.resources.find((item) => item.resourceId === resourceId);
  if (!layoutSucceeded || !addressFocusCurrent(intent) || resource?.preview?.loadError) {
    cancelAddressFocus();
    return;
  }
  // A newly constructed native view can take focus during its first navigation, after the first layout acknowledgement.
  // Wait for a committed, stopped document; Browser republishes layout when those explicit load facts change.
  if (!resource?.preview || resource.preview.page.documentGeneration === 0 || resource.preview.loading) return;
  // Claim once: ResizeObserver and React can both publish layout while the Main focus acknowledgement is pending.
  webAddressFocusStore.set(() => ({ intent: null }));
  try {
    if (!(await window.studio.shell.focusWorkbench()) || !addressFocusCurrent(intent)) return;
    const address = document.getElementById(`address-${intent.resourceId}`);
    if (!address) throw new Error('新网页布局已就绪但地址栏不存在');
    address.focus();
  } finally {
    if (intent.request === newWebRequest) cancelAddressFocus();
  }
}
export async function createWebTab() {
  const view = workspaceStore.get();
  const workspace = view.snapshot?.workspaces.find((item) => item.workspaceId === view.snapshot?.activeWorkspaceId);
  if (!workspace || workspaceSwitchPending()) return;
  cancelAddressFocus();
  const request = newWebRequest;
  const stop = () => {
    if (request === newWebRequest) cancelAddressFocus();
  };
  // A later user action revokes this focus intent even if it does not change the layout (for example, Tab to another control).
  window.addEventListener('pointerdown', stop, true);
  window.addEventListener('keydown', stop, true);
  releaseAddressFocus = () => {
    window.removeEventListener('pointerdown', stop, true);
    window.removeEventListener('keydown', stop, true);
  };
  const known = new Set(workspace.tabs.map((tab) => tab.tabId));
  const creation = workspaceCommand(workspace.workspaceId, { type: 'createTab', kind: 'web', title: '新网页', autoTitle: true });
  const navigation = beginNavigation();
  const result = await creation;
  if (request !== newWebRequest) return;
  if (
    !result?.ok ||
    !isCurrentNavigation(navigation) ||
    workspaceStore.get().snapshot?.activeWorkspaceId !== workspace.workspaceId ||
    workspaceSwitchPending()
  ) {
    cancelAddressFocus();
    return;
  }
  const createdWorkspace = result.snapshot.workspaces.find((item) => item.workspaceId === workspace.workspaceId);
  const createdPane = createdWorkspace && panes(createdWorkspace.layout).find((pane) => pane.paneId === createdWorkspace.activePaneId);
  const created = createdWorkspace?.tabs.find((tab) => tab.tabId === createdPane?.tabId && !known.has(tab.tabId));
  if (!created) {
    cancelAddressFocus();
    throw new Error('新建网页成功但缺少标签身份');
  }
  shellActions.navigate('space');
  const intent: NewWebAddressFocus = {
    request,
    workspaceId: workspace.workspaceId,
    resourceId: created.targetRef.resourceId,
    tabId: created.tabId,
    navigation: beginNavigation(),
  };
  const check = () => {
    if (!addressFocusCurrent(intent) && request === newWebRequest) cancelAddressFocus();
  };
  const unsubscribeWorkspace = workspaceStore.subscribe(check);
  const unsubscribeShell = shellStore.subscribe(check);
  const unsubscribeOcclusion = occlusion.store.subscribe(check);
  const releaseInteraction = releaseAddressFocus;
  releaseAddressFocus = () => {
    releaseInteraction();
    unsubscribeWorkspace();
    unsubscribeShell();
    unsubscribeOcclusion();
  };
  webAddressFocusStore.set(() => ({ intent }));
}

export async function dispatchShortcut(event: ShellCommandEvent) {
  const view = workspaceStore.get();
  const workspace = view.snapshot?.workspaces.find((item) => item.workspaceId === view.snapshot?.activeWorkspaceId);
  const focus = document.activeElement;
  if (event.command === 'command-palette') {
    await spaceActions.openSwitcher(event.nativeBrowser);
    return;
  }
  if (!workspace || workspaceSwitchPending() || shortcutModalOpen()) return;
  const original = event.nativeBrowser;
  if (
    original &&
    (original.workspaceId !== workspace.workspaceId ||
      !workspace.resources.some(
        (resource) =>
          resource.resourceId === original.resourceId &&
          !!resource.instanceId &&
          resource.preview?.page.webContentsId === original.webContentsId &&
          // Tab navigation and new-tab creation do not read the old document; its projection may trail Main's focused page.
          (event.command.startsWith('activate-tab-') ||
            event.command === 'new-web-tab' ||
            resource.preview.page.documentGeneration === original.documentGeneration),
      ))
  )
    return;
  if ((event.command === 'toggle-capture' || event.command === 'cancel-session-run') && shellStore.get().route !== 'space' && !original)
    return;
  const tab = activeShortcutTab(workspace, focus, original?.resourceId ?? null);
  const pane = panes(workspace.layout).find((item) => item.paneId === workspace.activePaneId);
  const command = event.command;
  if (command === 'new-web-tab') await createWebTab();
  else if (command === 'close-tab' && pane?.tabId) await workspaceCommand(workspace.workspaceId, { type: 'closeTab', tabId: pane.tabId });
  else if (command.startsWith('activate-tab-')) {
    const number = Number(command.slice('activate-tab-'.length));
    const selected = number === 9 ? workspace.tabs.at(-1) : workspace.tabs[number - 1];
    if (selected) {
      shellActions.navigate('space');
      await workspaceCommand(workspace.workspaceId, { type: 'activateTab', tabId: selected.tabId });
    }
  } else if (command === 'split-pane' && pane) {
    await workspaceCommand(workspace.workspaceId, { type: 'splitPane', paneId: pane.paneId, direction: 'horizontal' }, workspace.revision);
  } else if (command === 'toggle-capture' && tab?.targetRef.kind === 'web') {
    const resource = workspace.resources.find((item) => item.resourceId === tab.targetRef.resourceId);
    if (resource?.preview?.picking || (resource?.instanceId && !resource.preview?.loading))
      await toggleCapture(workspace.workspaceId, tab.targetRef.resourceId);
  } else if (command === 'cancel-session-run' && tab?.targetRef.kind === 'session') {
    const session = workspace.sessions.find((item) => item.resourceId === tab.targetRef.resourceId);
    const run = workspace.runs.filter((item) => item.sessionId === session?.sessionId).at(-1);
    if (run && (run.state === 'starting' || run.state === 'running'))
      await workspaceCommand(workspace.workspaceId, { type: 'cancelRun', runId: run.runId });
  }
}

export function installCaptureEscape() {
  const blocked = new WeakSet<Event>();
  const before = (event: KeyboardEvent) => {
    if (occlusion.blocked() || nativeMenuStore.get().open) blocked.add(event);
  };
  const after = (event: KeyboardEvent) => {
    if (event.key !== 'Escape' || event.defaultPrevented || event.isComposing || event.keyCode === 229 || blocked.has(event)) return;
    const view = workspaceStore.get();
    const workspace = view.snapshot?.workspaces.find((item) => item.workspaceId === view.snapshot?.activeWorkspaceId);
    if (!workspace || workspaceSwitchPending() || shellStore.get().route !== 'space') return;
    const tab = activeShortcutTab(workspace, document.activeElement, null);
    if (tab?.targetRef.kind !== 'web') return;
    event.preventDefault();
    void cancelCapture(workspace.workspaceId, tab.targetRef.resourceId);
  };
  window.addEventListener('keydown', before, true);
  window.addEventListener('keydown', after);
  return () => {
    window.removeEventListener('keydown', before, true);
    window.removeEventListener('keydown', after);
  };
}
