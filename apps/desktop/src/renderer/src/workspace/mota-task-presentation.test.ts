import { describe, expect, it } from 'vitest';
import type { ManagedApp, WorkbenchResource } from '@wsl/protocol';
import { changeMotaTaskScope, MOTA_MAP_SCOPE, MOTA_PLAY_SCOPE, motaTaskPresentation, motaTaskScopes } from './mota-task-presentation';

const app: ManagedApp = {
  workspaceId: 'workspace',
  projectId: 'project',
  environmentId: 'sandbox',
  appInstanceId: 'app-instance',
  state: 'running',
  url: 'http://127.0.0.1:43210',
  guestCwd: '/home/agent/workspace/.wsl-apps/project',
  error: null,
  cleanupConfirmed: false,
  profile: { projectKind: 'mota-web', profileVersion: 1, source: { sourceSha256: 'a'.repeat(64), files: [] } },
};
const game: WorkbenchResource = {
  resourceId: 'game',
  appProjectId: 'project',
  appPage: 'game',
  environmentId: 'sandbox',
  kind: 'web',
  title: '魔塔游戏',
  url: 'http://127.0.0.1:43210/index.html',
  instanceId: 'game-browser',
  generation: 2,
  preview: null,
  terminal: null,
  unavailableReason: null,
};
const workspace = { workspaceId: 'workspace', managedApp: app, resources: [game] };
const target = { kind: 'web' as const, resourceId: 'game' };

describe('Mota task presentation permissions', () => {
  it('does not grant either operation by default or infer play from map permission', () => {
    expect(motaTaskScopes([])).toEqual([]);
    expect(motaTaskScopes([MOTA_MAP_SCOPE])).toEqual([]);
    expect(changeMotaTaskScope([], MOTA_MAP_SCOPE, true)).toEqual([]);
    expect(motaTaskPresentation(workspace, target, [])?.reason).toContain('勾选');
    expect(motaTaskPresentation(workspace, target, [MOTA_MAP_SCOPE])?.reason).toContain('勾选');
  });

  it('revoking play also revokes map, and re-enabling play does not restore the dependent grant', () => {
    const play = changeMotaTaskScope([], MOTA_PLAY_SCOPE, true);
    expect(play).toEqual([MOTA_PLAY_SCOPE]);
    const both = changeMotaTaskScope(play, MOTA_MAP_SCOPE, true);
    expect(both).toEqual([MOTA_PLAY_SCOPE, MOTA_MAP_SCOPE]);
    expect(changeMotaTaskScope(both, MOTA_MAP_SCOPE, false)).toEqual([MOTA_PLAY_SCOPE]);
    const revoked = changeMotaTaskScope(both, MOTA_PLAY_SCOPE, false);
    expect(revoked).toEqual([]);
    expect(changeMotaTaskScope(revoked, MOTA_PLAY_SCOPE, true)).toEqual([MOTA_PLAY_SCOPE]);
  });

  it('serializes only the visible grants and rejects unsupported scopes on a frozen version', () => {
    expect(motaTaskScopes(['src/**', MOTA_PLAY_SCOPE, MOTA_MAP_SCOPE, MOTA_PLAY_SCOPE])).toEqual([MOTA_PLAY_SCOPE, MOTA_MAP_SCOPE]);
    expect(motaTaskPresentation(workspace, target, [MOTA_PLAY_SCOPE, 'src/**'])?.reason).toContain('不支持');
    expect(motaTaskPresentation(workspace, target, [MOTA_PLAY_SCOPE])?.reason).toBeNull();
    expect(motaTaskPresentation(workspace, target, [MOTA_PLAY_SCOPE, MOTA_MAP_SCOPE])?.reason).toBeNull();
  });

  it('requires explicit selection even with exactly one eligible game resource', () => {
    const state = motaTaskPresentation(workspace, null, [MOTA_PLAY_SCOPE]);
    expect(state?.targets.map((resource) => resource.resourceId)).toEqual(['game']);
    expect(state?.selected).toBeUndefined();
    expect(state?.reason).toContain('明确选择');
  });

  it('excludes editor, other projects, other environments, non-web and closed resources', () => {
    const resources: WorkbenchResource[] = [
      game,
      { ...game, resourceId: 'editor', appPage: 'editor' },
      { ...game, resourceId: 'foreign', appProjectId: 'another-project' },
      { ...game, resourceId: 'local', environmentId: 'local' },
      { ...game, resourceId: 'file', kind: 'file' },
      { ...game, resourceId: 'closed', instanceId: null },
      { ...game, resourceId: 'unowned', appProjectId: undefined },
    ];
    const current = { ...workspace, resources };
    expect(motaTaskPresentation(current, target, [MOTA_PLAY_SCOPE])?.targets).toEqual([game]);
    for (const resource of resources.slice(1)) {
      expect(motaTaskPresentation(current, { kind: resource.kind, resourceId: resource.resourceId }, [MOTA_PLAY_SCOPE])?.reason).toContain(
        '明确选择',
      );
    }
    expect(motaTaskPresentation(current, { kind: 'file', resourceId: 'game' }, [MOTA_PLAY_SCOPE])?.selected).toBeUndefined();
  });

  it('a stop or replacement invalidates the previously selected game without deleting its draft grants', () => {
    for (const managedApp of [
      { ...app, state: 'stopped' as const },
      { ...app, state: 'starting' as const },
      { ...app, appInstanceId: null },
      { ...app, workspaceId: 'another-workspace' },
    ]) {
      const state = motaTaskPresentation({ ...workspace, managedApp }, target, [MOTA_PLAY_SCOPE, MOTA_MAP_SCOPE]);
      expect(state?.targets).toEqual([]);
      expect(state?.reason).toContain('先启动');
      expect(state?.allowedScopes).toEqual([MOTA_PLAY_SCOPE, MOTA_MAP_SCOPE]);
    }
    const replacement = motaTaskPresentation({ ...workspace, managedApp: { ...app, projectId: 'replacement' } }, target, [MOTA_PLAY_SCOPE]);
    expect(replacement?.selected).toBeUndefined();
    expect(replacement?.reason).toContain('先打开');
  });

  it('keeps stale frozen targets blocked while a new draft can select the current game', () => {
    expect(motaTaskPresentation(workspace, { kind: 'web', resourceId: 'previous-game' }, [MOTA_PLAY_SCOPE])?.reason).toContain('明确选择');
    expect(motaTaskPresentation(workspace, target, [MOTA_PLAY_SCOPE])?.reason).toBeNull();
  });

  it('does not impose Mota presentation gates on standard or edu workspaces', () => {
    expect(motaTaskPresentation({ ...workspace, managedApp: null }, null, [])).toBeNull();
    expect(motaTaskPresentation({ ...workspace, managedApp: { ...app, profile: undefined } }, null, [])).toBeNull();
  });
});
