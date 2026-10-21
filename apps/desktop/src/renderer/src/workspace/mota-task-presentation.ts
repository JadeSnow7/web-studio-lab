import type { TargetRef, WorkspaceSnapshot } from '@wsl/protocol';

export const MOTA_PLAY_SCOPE = 'app.mota.play';
export const MOTA_MAP_SCOPE = 'app.mota.map.write';
type MotaTaskScope = typeof MOTA_PLAY_SCOPE | typeof MOTA_MAP_SCOPE;

/** Match the visible opt-ins without inferring a missing grant from a dependent scope. */
export function motaTaskScopes(scopes: readonly string[]): MotaTaskScope[] {
  if (!scopes.includes(MOTA_PLAY_SCOPE)) return [];
  return scopes.includes(MOTA_MAP_SCOPE) ? [MOTA_PLAY_SCOPE, MOTA_MAP_SCOPE] : [MOTA_PLAY_SCOPE];
}

export function changeMotaTaskScope(scopes: readonly string[], scope: MotaTaskScope, enabled: boolean): MotaTaskScope[] {
  const current = motaTaskScopes(scopes);
  if (scope === MOTA_PLAY_SCOPE) return enabled ? (current.length ? current : [MOTA_PLAY_SCOPE]) : [];
  if (!current.includes(MOTA_PLAY_SCOPE)) return [];
  return enabled ? [MOTA_PLAY_SCOPE, MOTA_MAP_SCOPE] : [MOTA_PLAY_SCOPE];
}

/** Presentation only. Main revalidates the live Browser binding and grants at admission. */
export function motaTaskPresentation(
  workspace: Pick<WorkspaceSnapshot, 'workspaceId' | 'managedApp' | 'resources'>,
  target: TargetRef | null,
  scopes: readonly string[],
) {
  const app = workspace.managedApp;
  if (app?.profile?.projectKind !== 'mota-web') return null;
  const running = app.state === 'running' && !!app.appInstanceId && app.workspaceId === workspace.workspaceId;
  const targets = running
    ? workspace.resources.filter(
        (resource) =>
          resource.kind === 'web' &&
          resource.appPage === 'game' &&
          resource.appProjectId === app.projectId &&
          resource.environmentId === app.environmentId &&
          !!resource.instanceId,
      )
    : [];
  const selected = target?.kind === 'web' ? targets.find((resource) => resource.resourceId === target.resourceId) : undefined;
  const allowedScopes = motaTaskScopes(scopes);
  const reason = !running
    ? '先启动魔塔 App 并打开游戏页，再选择游戏目标。'
    : !targets.length
      ? '先打开当前 App 的游戏页，再选择游戏目标。'
      : !selected
        ? '请在“任务”中明确选择当前运行的游戏页。'
        : scopes.some((scope) => scope !== MOTA_PLAY_SCOPE && scope !== MOTA_MAP_SCOPE)
          ? '此任务包含不支持的操作范围，请重新选择权限并确认任务。'
          : !allowedScopes.includes(MOTA_PLAY_SCOPE)
            ? '请在“任务”中勾选“允许 AI 操作游戏（含重新开始）”。'
            : null;
  return { targets, selected, allowedScopes, reason };
}
