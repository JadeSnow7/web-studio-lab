import type { WorkbenchCommand, WorkbenchSnapshot, WorkspaceSnapshot, PaneLayout } from '@wsl/protocol';
import { occlusion, installOcclusionHider } from './occlusion';
import { createStore } from '../lib/store';

type Payload = WorkbenchCommand extends infer C
  ? C extends WorkbenchCommand
    ? Omit<C, 'commandId' | 'workspaceId' | 'expectedRevision'>
    : never
  : never;
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
    if (!result.ok && payload.type !== 'capturePublicResource' && payload.type !== 'removePublicResource')
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
export function workspaceCommand(workspaceId: string, payload: Payload, revision?: number) {
  if (runtimeCommands.has(payload.type)) return executeCommand(workspaceId, payload);
  const previous = metadataQueues.get(workspaceId) ?? Promise.resolve();
  const next = previous.then(() => {
    const latest = workspaceStore.get().snapshot?.workspaces.find((w) => w.workspaceId === workspaceId);
    return executeCommand(workspaceId, payload, revision ?? latest?.revision);
  });
  metadataQueues.set(workspaceId, next);
  return next;
}
export function command(payload: Payload) {
  const w = selectedWorkspace();
  if (!w) throw new Error('没有活动空间');
  return workspaceCommand(w.workspaceId, payload);
}
let navigation = 0;
export const beginNavigation = () => ++navigation;
export const isCurrentNavigation = (token: number) => token === navigation;
export async function switchWorkspace(workspaceId: string, tabId?: string) {
  const token = beginNavigation();
  const result = await workspaceCommand(workspaceId, { type: 'switchWorkspace' });
  if (!result?.ok || token !== navigation) return;
  workspaceStore.set((s) => ({ ...s, selectedId: workspaceId }));
  if (tabId) await workspaceCommand(workspaceId, { type: 'activateTab', tabId });
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
