import { shellActions, shellStore } from './shell';
import type { WorkbenchTab } from '@wsl/protocol';
import { defaultEnvironment, readEnvironmentPreference, rememberEnvironment } from './default-environment';
import { reportError } from './errors';
import { spaceActions, spaceUiStore } from './space-ui';
import { createWebTab } from './shortcuts';
import { beginNavigation, isCurrentNavigation, workspaceCommand, workspaceStore, workspaceSwitchPending } from './workspace';
const pending = new Set<string>();
export async function createTab(kind: WorkbenchTab['targetRef']['kind']) {
  const state = workspaceStore.get();
  const workspace = state.snapshot?.workspaces.find((item) => item.workspaceId === state.selectedId);
  if (!workspace || workspaceSwitchPending() || pending.has(workspace.workspaceId)) return;
  const workspaceId = workspace.workspaceId;
  pending.add(workspaceId);
  try {
    if (kind === 'web') {
      if (shellStore.get().workshop.peek) shellActions.closePanel('left', false);
      return await createWebTab();
    }
    if (kind === 'session') {
      await workspaceCommand(workspaceId, { type: 'createTab', kind, title: `会话 ${workspace.sessions.length + 1}` });
      return;
    }
    const navigation = beginNavigation();
    const ui = spaceUiStore.get();
    const environments = await window.studio.workbench.environments();
    if (
      workspaceStore.get().selectedId !== workspaceId ||
      workspaceSwitchPending() ||
      !isCurrentNavigation(navigation) ||
      spaceUiStore.get() !== ui
    )
      return;
    const environment = defaultEnvironment(environments, kind, readEnvironmentPreference(localStorage, workspaceId, kind));
    if (kind !== 'terminal' || !environment) {
      await spaceActions.openEditor({ kind: 'tab', tabKind: kind }, kind === 'terminal' ? '终端' : kind === 'file' ? '文件' : 'SSH');
      return;
    }
    const result = await workspaceCommand(workspaceId, {
      type: 'createTab',
      kind,
      title: `终端 · ${environment.label}`,
      environmentId: environment.environmentId,
    });
    if (result?.ok) rememberEnvironment(localStorage, workspaceId, kind, environment.environmentId);
  } catch (error) {
    reportError('新建标签', error);
  } finally {
    pending.delete(workspaceId);
  }
}
