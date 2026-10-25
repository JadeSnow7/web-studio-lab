import type { CatalogAction, WorkbenchCommand, WorkbenchSnapshot, WorkspaceSnapshot, PaneLayout } from '@wsl/protocol';
import { occlusion, installOcclusionHider } from './occlusion';
import { createStore } from '../lib/store';

type Payload = WorkbenchCommand extends infer C
  ? C extends WorkbenchCommand
    ? Omit<C, 'commandId' | 'workspaceId' | 'expectedRevision'>
    : never
  : never;
/** 工作台命令去掉命令身份、空间与版本后的内容（由 workspaceCommand 补齐）。 */
export type WorkspaceCommandPayload = Payload;
export const workspaceStore = createStore<{ snapshot: WorkbenchSnapshot | null; selectedId: string | null; error: string | null }>({
  snapshot: null,
  selectedId: null,
  error: null,
});
export function projectSnapshot(snapshot: WorkbenchSnapshot, authoritativeEpoch = false) {
  const current = workspaceStore.get().snapshot;
  if (current && current.appInstanceId !== snapshot.appInstanceId && !authoritativeEpoch) return;
  workspaceStore.set((s) =>
    s.snapshot && s.snapshot.appInstanceId === snapshot.appInstanceId && s.snapshot.seq > snapshot.seq
      ? s
      : {
          ...s,
          snapshot,
          selectedId:
            s.snapshot?.appInstanceId === snapshot.appInstanceId
              ? (s.selectedId ?? snapshot.activeWorkspaceId)
              : snapshot.activeWorkspaceId,
        },
  );
}
export function selectedWorkspace(): WorkspaceSnapshot | undefined {
  const s = workspaceStore.get();
  return s.snapshot?.workspaces.find((w) => w.workspaceId === s.selectedId);
}
export function panes(layout: PaneLayout): Array<Extract<PaneLayout, { kind: 'pane' }>> {
  return layout.kind === 'pane' ? [layout] : [...panes(layout.first), ...panes(layout.second)];
}
const metadataQueues = new Map<string, Promise<unknown>>();
const runtimeCommands = new Set([
  'startRun',
  'cancelRun',
  'createApp',
  'previewAppImport',
  'confirmAppImport',
  'cancelAppImport',
  'retryAppImport',
  'openAppPage',
  'startApp',
  'stopApp',
  'exportApp',
  'browserLayout',
  'browserAction',
  'terminalOpen',
  'terminalWrite',
  'terminalResize',
  'stopInstance',
  'switchWorkspace',
  'locateSession',
  'hideBrowsers',
]);
async function executeCommand(workspaceId: string, payload: Payload, revision?: number) {
  try {
    if (payload.type === 'browserLayout' && occlusion.blocked()) payload = { ...payload, layout: { ...payload.layout, visible: false } };
    const result = await window.studio.workbench.command({
      ...payload,
      commandId: crypto.randomUUID(),
      workspaceId,
      ...(revision === undefined ? {} : { expectedRevision: revision }),
    } as WorkbenchCommand);
    projectSnapshot(result.snapshot);
    // Resource business errors have one owner in the workspace snapshot.
    // Transport exceptions still use the global error surface below.
    if (!result.ok)
      workspaceStore.set((s) => ({
        ...s,
        error: result.error.code === 'pane_limit' ? '最多四个窗格；请先关闭一个窗格。' : result.error.message,
      }));
    return result;
  } catch (error) {
    workspaceStore.set((s) => ({ ...s, error: (error as Error).message }));
    return null;
  }
}
/**
 * navigate：这些布局命令默认视为用户的新导航（撤销此前导航的自动定位）。迟到的原生菜单选择作用于后台空间或空间切换进行中时
 * 传 false，不打断进行中的切换（OPS-1 S5）。
 */
export function workspaceCommand(workspaceId: string, payload: Payload, revision?: number, options: { navigate?: boolean } = {}) {
  if (
    options.navigate !== false &&
    ['activateTab', 'openTab', 'createTab', 'closeTab', 'focusPane', 'splitPane', 'closePane'].includes(payload.type)
  )
    beginNavigation();
  if (runtimeCommands.has(payload.type)) return executeCommand(workspaceId, payload);
  const previous = metadataQueues.get(workspaceId) ?? Promise.resolve();
  const next = previous.then(() => {
    const latest = workspaceStore.get().snapshot?.workspaces.find((w) => w.workspaceId === workspaceId);
    return executeCommand(workspaceId, payload, revision ?? latest?.revision);
  });
  metadataQueues.set(workspaceId, next);
  return next;
}
/**
 * 等到本 renderer 对该空间已发出的元数据命令（如点击触发器前的 focusPane、activateTab）都有结果。
 * 原生菜单在此之后请求 Main 快照，冻结的版本就包含这些命令（OPS-1 S5）。
 */
export async function workspaceCommandsSettled(workspaceId: string): Promise<void> {
  for (;;) {
    const pending = metadataQueues.get(workspaceId);
    if (!pending) return;
    await pending;
    if (metadataQueues.get(workspaceId) === pending) return;
  }
}
type CatalogPayload = CatalogAction extends infer C
  ? C extends CatalogAction
    ? Omit<C, 'commandId' | 'expectedCatalogRevision'>
    : never
  : never;
export async function catalogCommand(payload: CatalogPayload) {
  const result = await window.studio.workbench.catalogCommand({
    ...payload,
    commandId: crypto.randomUUID(),
    expectedCatalogRevision: workspaceStore.get().snapshot?.catalog?.revision ?? 0,
  } as CatalogAction);
  projectSnapshot(result.snapshot);
  return result;
}
export function command(payload: Payload) {
  const w = selectedWorkspace();
  if (!w) throw new Error('没有活动空间');
  return workspaceCommand(w.workspaceId, payload);
}
let navigation = 0;
export const beginNavigation = () => ++navigation;
export const isCurrentNavigation = (token: number) => token === navigation;
let spaceChanges = 0;
/** 空间切换（或跨空间定位）进行中：迟到的原生菜单展示动作据此丢弃（OPS-1 S5）。 */
export const workspaceSwitchPending = () => spaceChanges > 0;
/** 包住一次可能改变活动空间的操作，期间 workspaceSwitchPending() 为真。 */
export async function trackSpaceChange<T>(change: () => Promise<T>): Promise<T> {
  spaceChanges++;
  try {
    return await change();
  } finally {
    spaceChanges--;
  }
}
export function switchWorkspace(workspaceId: string, tabId?: string) {
  return trackSpaceChange(() => switchWorkspaceNow(workspaceId, tabId));
}
async function switchWorkspaceNow(workspaceId: string, tabId?: string) {
  const token = beginNavigation();
  const result = await workspaceCommand(workspaceId, { type: 'switchWorkspace' });
  if (!result?.ok || token !== navigation) return false;
  workspaceStore.set((s) => ({ ...s, selectedId: workspaceId }));
  if (tabId) {
    const pending = workspaceCommand(workspaceId, { type: 'activateTab', tabId });
    const activationToken = navigation;
    return (await pending)?.ok === true && activationToken === navigation;
  }
  return true;
}
let subscribed = false;
let initializing: Promise<void> | null = null;
export function initializeWorkspace(retry = false): Promise<void> {
  if (initializing) return initializing;
  if (!subscribed) {
    window.studio.workbench.onEvent((event) => projectSnapshot(event.snapshot));
    subscribed = true;
  }
  initializing = (async () => {
    try {
      projectSnapshot(await (retry ? window.studio.workbench.reload() : window.studio.workbench.getSnapshot()), true);
      await window.studio.workbench.environments();
      projectSnapshot(await window.studio.workbench.getSnapshot());
      workspaceStore.set((s) => ({ ...s, error: null }));
    } catch (error) {
      workspaceStore.set((s) => ({ ...s, error: (error as Error).message }));
    } finally {
      initializing = null;
    }
  })();
  return initializing;
}

installOcclusionHider(async () => {
  const workspace = selectedWorkspace();
  if (!workspace) return true;
  const result = await workspaceCommand(workspace.workspaceId, { type: 'hideBrowsers' });
  return result?.ok === true;
});
