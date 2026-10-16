import { describe, expect, it } from 'vitest';
import { AppImportPreviewSchema, AppImportRequestSchema, EduAppImportRequestSchema, MotaAppImportRequestSchema } from './app-import';
import { AppProfileSchema, EDU_SOURCE_BYTES, ManagedAppSchema } from './managed-app';
import { ChatServiceRequestSchema } from './chat';
import { MOTA_REQUIRED_FILES, MOTA_SOURCE_BYTES, MOTA_SOURCE_MAX_FILES } from './mota';
import { WorkbenchCommandSchema, WorkbenchResourceSchema } from './workspace';

const target = { workspaceId: 'mota-test', projectId: '10000000-0000-4000-8000-000000000001' };
const importOperationId = '10000000-0000-4000-8000-000000000002';
const motaSource = {
  sourceSha256: 'a'.repeat(64),
  files: MOTA_REQUIRED_FILES.map((path) => ({ path, sha256: 'b'.repeat(64), bytes: 1 })),
};
const motaRequest = {
  ...target,
  importOperationId,
  profile: 'mota-web',
  source: motaSource,
  files: MOTA_REQUIRED_FILES.map((path) => ({ path, base64: 'YQ==' })),
};
const eduSource = {
  repository: { commit: 'c'.repeat(40), dirty: false },
  sourceSha256: 'd'.repeat(64),
  files: [{ path: 'server/app.py', sha256: 'e'.repeat(64), bytes: 4 }],
};
const eduRequest = { ...target, importOperationId, source: eduSource, files: [{ path: 'server/app.py', base64: 'dGVzdA==' }] };
const preview = {
  name: '魔塔',
  profile: 'mota-web',
  profileVersion: 1,
  sourceSha256: motaSource.sourceSha256,
  fileCount: MOTA_REQUIRED_FILES.length,
  totalBytes: MOTA_REQUIRED_FILES.length,
  warnings: [],
};

describe('mota profile integration without widening edu imports', () => {
  it('persists the versioned full source profile alongside existing App identity', () => {
    const profile = { projectKind: 'mota-web', profileVersion: 1, source: motaSource };
    const app = {
      ...target,
      profile,
      sourceSha256: motaSource.sourceSha256,
      environmentId: 'sandbox',
      appInstanceId: '10000000-0000-4000-8000-000000000003',
      state: 'running',
      url: 'http://127.0.0.1:31000',
      guestCwd: '/home/agent/workspace/.wsl-apps/' + target.projectId,
      guestPort: 30000,
      error: null,
      cleanupConfirmed: false,
    };
    expect(ManagedAppSchema.parse(app)).toEqual(app);
    for (const invalid of [
      { ...profile, profileVersion: 2 },
      { ...profile, source: { ...motaSource, files: motaSource.files.slice(1) } },
      { ...profile, source: eduSource },
      { ...profile, command: 'node supplied-server.js' },
    ])
      expect(AppProfileSchema.safeParse(invalid).success).toBe(false);
  });
  it('keeps the old strict edu request and preview shape, without adding a request discriminator', () => {
    expect(AppImportRequestSchema.parse(eduRequest)).toEqual(eduRequest);
    const oldPreview = { ...preview, name: 'edu', profile: 'edu-web', repository: eduSource.repository, fileCount: 1, totalBytes: 4 };
    expect(AppImportPreviewSchema.parse(oldPreview)).toEqual(oldPreview);
    expect(AppImportRequestSchema.safeParse({ ...eduRequest, profile: 'edu-web' }).success).toBe(false);
    expect(AppImportRequestSchema.safeParse({ ...eduRequest, hostPath: '/private/source' }).success).toBe(false);
    expect(AppImportPreviewSchema.safeParse({ ...oldPreview, repository: undefined }).success).toBe(false);
    expect(AppImportPreviewSchema.safeParse({ ...oldPreview, fileCount: 257 }).success).toBe(false);
    expect(AppImportPreviewSchema.safeParse({ ...oldPreview, totalBytes: EDU_SOURCE_BYTES + 1 }).success).toBe(false);
    expect(AppProfileSchema.parse({ projectKind: 'standard-app', profileVersion: 1 })).toEqual({
      projectKind: 'standard-app',
      profileVersion: 1,
    });
    expect(AppProfileSchema.parse({ projectKind: 'edu-web', profileVersion: 1, source: eduSource })).toEqual({
      projectKind: 'edu-web',
      profileVersion: 1,
      source: eduSource,
    });
  });
  it('accepts only explicit mota requests and preserves all payload refinements through the service envelope', () => {
    const envelope = { id: 'import-mota', method: 'app.importSource', payload: motaRequest };
    expect(AppImportRequestSchema.parse(motaRequest)).toEqual(motaRequest);
    expect(ChatServiceRequestSchema.parse(envelope)).toEqual(envelope);
    for (const invalid of [
      { ...motaRequest, profile: undefined },
      { ...motaRequest, profile: 'arbitrary-web' },
      { ...motaRequest, source: { ...motaSource, repository: eduSource.repository } },
      { ...motaRequest, files: motaRequest.files.slice(1) },
      { ...motaRequest, files: [...motaRequest.files, motaRequest.files[0]] },
      { ...motaRequest, files: motaRequest.files.map((file, index) => (index === 0 ? { ...file, base64: 'YWI=' } : file)) },
      { ...motaRequest, files: motaRequest.files.map((file, index) => (index === 0 ? { ...file, path: 'project/server.js' } : file)) },
      { ...motaRequest, hostPath: '/private/source' },
      { ...motaRequest, command: 'node server.js' },
    ]) {
      expect(AppImportRequestSchema.safeParse(invalid).success).toBe(false);
      expect(ChatServiceRequestSchema.safeParse({ ...envelope, payload: invalid }).success).toBe(false);
    }
  });
  it('gives mota its own preview budget and rejects Git metadata or profile mixing', () => {
    expect(AppImportPreviewSchema.parse(preview)).toEqual(preview);
    expect(AppImportPreviewSchema.safeParse({ ...preview, fileCount: MOTA_SOURCE_MAX_FILES, totalBytes: MOTA_SOURCE_BYTES }).success).toBe(
      true,
    );
    for (const invalid of [
      { ...preview, fileCount: MOTA_SOURCE_MAX_FILES + 1 },
      { ...preview, fileCount: MOTA_REQUIRED_FILES.length - 1 },
      { ...preview, totalBytes: MOTA_SOURCE_BYTES + 1 },
      { ...preview, repository: eduSource.repository },
      { ...preview, profile: 'standard-app' },
      { ...preview, profileVersion: 2 },
    ])
      expect(AppImportPreviewSchema.safeParse(invalid).success).toBe(false);
  });
  it('accepts an asset above the legacy encoded-file budget only through the mota branch', () => {
    const base64 = 'A'.repeat(4_000_004);
    const asset = { path: 'project/fonts/font.ttf', base64 };
    const request = {
      ...motaRequest,
      source: { ...motaSource, files: [...motaSource.files, { path: asset.path, sha256: 'f'.repeat(64), bytes: 3_000_003 }] },
      files: [...motaRequest.files, asset],
    };
    expect(MotaAppImportRequestSchema.safeParse(request).success).toBe(true);
    expect(AppImportRequestSchema.safeParse(request).success).toBe(true);
    expect(EduAppImportRequestSchema.safeParse({ ...eduRequest, files: [{ path: 'server/app.py', base64 }] }).success).toBe(false);
  });
});

describe('managed game and editor page roles', () => {
  const resource = {
    resourceId: 'game-resource',
    environmentId: 'sandbox',
    appProjectId: target.projectId,
    kind: 'web',
    title: '游戏页面',
    url: 'http://127.0.0.1:31000/index.html',
    instanceId: 'game-browser',
    generation: 1,
    preview: null,
    terminal: null,
    unavailableReason: null,
  };
  it('keeps independent Browser resources for both roles under one project without synthesizing roles for old resources', () => {
    const game = WorkbenchResourceSchema.parse({ ...resource, appPage: 'game' });
    const editor = WorkbenchResourceSchema.parse({
      ...resource,
      resourceId: 'editor-resource',
      instanceId: 'editor-browser',
      appPage: 'editor',
      title: '地图编辑器',
      url: 'http://127.0.0.1:31000/editor.html',
    });
    expect(game.appProjectId).toBe(editor.appProjectId);
    expect(game.resourceId).not.toBe(editor.resourceId);
    expect(game.instanceId).not.toBe(editor.instanceId);
    expect(WorkbenchResourceSchema.parse(resource)).not.toHaveProperty('appPage');
    expect(WorkbenchResourceSchema.safeParse({ ...resource, appPage: 'admin' }).success).toBe(false);
  });
  it.each(['admin', 'student', 'game', 'editor'])('opens the named %s page without exposing a renderer-supplied URL', (page) => {
    const command = { type: 'openAppPage', commandId: 'open-page', workspaceId: target.workspaceId, page };
    expect(WorkbenchCommandSchema.parse(command)).toEqual(command);
    expect(WorkbenchCommandSchema.safeParse({ ...command, url: 'http://127.0.0.1:1/private' }).success).toBe(false);
    expect(WorkbenchCommandSchema.safeParse({ ...command, page: '../private' }).success).toBe(false);
  });
});
