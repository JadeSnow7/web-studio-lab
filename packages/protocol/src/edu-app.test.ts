import { describe, expect, it } from 'vitest';
import { AppProfileSchema, AppSourceSchema, EDU_REQUIRED_FILES, ManagedAppSchema } from './managed-app';
import { MOTA_REQUIRED_FILES } from './mota';
import { ChatServiceMessageSchema, ChatServiceRequestSchema } from './chat';
import { WorkbenchCommandSchema } from './workspace';

const target = { workspaceId: 'edu-test', projectId: '10000000-0000-4000-8000-000000000001' };
const source = {
  repository: { commit: 'a'.repeat(40), dirty: false },
  sourceSha256: 'b'.repeat(64),
  files: [{ path: 'server/app.py', bytes: 4, sha256: 'c'.repeat(64) }],
};
const profile = { projectKind: 'edu-web', profileVersion: 1, source };
const snapshot = {
  ...target,
  environmentId: 'sandbox',
  appInstanceId: null,
  state: 'created',
  url: null,
  guestCwd: '/home/agent/workspace/.wsl-apps/' + target.projectId,
  error: null,
  cleanupConfirmed: true,
};

describe('fixed edu project contract', () => {
  it('accepts a named import command without exposing paths or commands to the renderer', () => {
    const command = { type: 'importEduApp', commandId: 'import-1', workspaceId: target.workspaceId };
    expect(WorkbenchCommandSchema.parse(command)).toEqual(command);
    for (const extra of [{ path: '/private/source' }, { command: 'python arbitrary.py' }, { profileVersion: 2 }])
      expect(WorkbenchCommandSchema.safeParse({ ...command, ...extra }).success).toBe(false);
  });
  it('preserves the imported profile and source baseline in managed and exported projections', () => {
    expect(ManagedAppSchema.parse({ ...snapshot, profile })).toEqual({ ...snapshot, profile });
    const exported = { files: [{ path: 'server/app.py', base64: 'dGVzdA==' }], sha256: 'd'.repeat(64), profile };
    expect(AppSourceSchema.parse(exported)).toEqual(exported);
  });
  it('keeps old standard-app descriptions valid without inferring an edu source', () => {
    expect(ManagedAppSchema.parse(snapshot)).toEqual(snapshot);
  });
  it.each([
    { ...profile, profileVersion: 2 },
    { ...profile, projectKind: 'arbitrary' },
    { ...profile, command: 'arbitrary' },
    { ...profile, source: undefined },
    { ...profile, source: { ...source, repository: { commit: 'main', dirty: false } } },
    { ...profile, source: { ...source, files: [...source.files, ...source.files] } },
    { ...profile, source: { ...source, files: [{ ...source.files[0], path: 'server/.env.py' }] } },
    { ...profile, source: { ...source, files: [{ ...source.files[0], path: 'server/../app.py' }] } },
    { ...profile, source: { ...source, files: [{ ...source.files[0], bytes: 524289 }] } },
  ])('rejects unversioned, executable, ambiguous or out-of-scope profiles: %j', (invalid) => {
    expect(ManagedAppSchema.safeParse({ ...snapshot, profile: invalid }).success).toBe(false);
  });
  it('separates the edu service import from creation of the bundled standard template', () => {
    const request = {
      id: 'request-1',
      method: 'app.importEdu',
      payload: { ...target, source, files: [{ path: 'server/app.py', base64: 'dGVzdA==' }] },
    };
    expect(ChatServiceRequestSchema.parse(request)).toEqual(request);
    expect(ChatServiceRequestSchema.safeParse({ ...request, payload: { ...request.payload, command: 'arbitrary' } }).success).toBe(false);
  });
});

describe('R5 shared source and export request contract', () => {
  // These schema fixtures declare metadata; Main/helper tests independently verify actual hashes.
  const digest = 'd'.repeat(64);
  const ascii = (bytes: number) => 'YWFh'.repeat(Math.floor(bytes / 3)) + ['', 'YQ==', 'YWE='][bytes % 3];
  const decodedBytes = (value: string) => (value.length / 4) * 3 - (value.endsWith('==') ? 2 : value.endsWith('=') ? 1 : 0);
  function payload(kind: 'standard-app' | 'edu-web', count: number, bytes: number, aggregate = false) {
    const names = kind === 'edu-web' ? [...EDU_REQUIRED_FILES] : [];
    while (names.length < count) names.push(`admin/src/中文-${names.length}.ts`);
    const files = names.sort().map((path) => ({ path, base64: '' }));
    const editable = files.filter((file) => file.path.startsWith('admin/src/'));
    const firstBytes = aggregate ? Math.floor(bytes / 2) : bytes;
    // 中文🙂ab is twelve UTF-8 bytes, with no padding before the ASCII remainder.
    editable[0]!.base64 = '5Lit5paH8J+ZgmFi' + ascii(firstBytes - 12);
    if (aggregate) editable[1]!.base64 = ascii(bytes - firstBytes);
    const metadata = files
      .filter((file) => count <= 256 || file.path !== editable.at(-1)?.path)
      .map((file) => ({
        path: file.path,
        sha256: digest,
        bytes: bytes > 524288 ? 0 : decodedBytes(file.base64),
      }));
    return {
      files,
      sha256: digest,
      profile:
        kind === 'standard-app'
          ? { projectKind: 'standard-app', profileVersion: 1 }
          : {
              projectKind: 'edu-web',
              profileVersion: 1,
              source: {
                repository: source.repository,
                files: metadata,
                sourceSha256: digest,
              },
            },
    };
  }

  for (const kind of ['standard-app', 'edu-web'] as const) {
    it.each([255, 256, 257])(`R5 ${kind} counts every source file at %i`, (count) => {
      const input = payload(kind, count, 12);
      expect(AppProfileSchema.safeParse(input.profile).success).toBe(true);
      expect(AppSourceSchema.safeParse(input).success).toBe(count <= 256);
    });
    it.each([524287, 524288, 524289])(`R5 ${kind} measures single and aggregate decoded bytes at %i`, (bytes) => {
      for (const aggregate of [false, true]) {
        const input = payload(kind, 8, bytes, aggregate);
        expect(AppProfileSchema.safeParse(input.profile).success).toBe(true);
        expect(input.files.reduce((sum, file) => sum + decodedBytes(file.base64), 0)).toBe(bytes);
        expect(AppSourceSchema.safeParse(input).success, `aggregate=${aggregate}`).toBe(bytes <= 524288);
      }
    });
  }

  it('R5 preserves legacy empty-file sources, base64 padding and taskSource response compatibility', () => {
    for (const base64 of ['', 'YQ==', 'YWI=', 'YWJj', '5Lit', '8J+Zgg==']) {
      const input = { files: [{ path: 'src/中文.ts', base64 }], sha256: digest };
      expect(AppSourceSchema.parse(input)).toEqual(input);
      expect(ChatServiceMessageSchema.parse({ type: 'response', id: 'task-source', result: input })).toMatchObject({ result: input });
    }
    expect(AppSourceSchema.safeParse({ files: [], sha256: digest }).success).toBe(false);
  });

  it.each(['a', '!!!!', 'YQ=', 'YQ==='])('R5 rejects malformed source base64 %s', (base64) => {
    expect(AppSourceSchema.safeParse({ files: [{ path: 'src/App.ts', base64 }], sha256: digest }).success).toBe(false);
  });

  it('R5 rejects public budget overrides and unknown profiles while preserving generic Mota capability', () => {
    const command = { type: 'exportApp', commandId: 'r5-export', workspaceId: target.workspaceId };
    expect(WorkbenchCommandSchema.parse(command)).toEqual(command);
    expect(WorkbenchCommandSchema.safeParse({ ...command, exportBudget: { maxFiles: 256, maxSourceBytes: 8388608 } }).success).toBe(false);
    for (const method of ['app.export', 'app.taskSource']) {
      const request = { id: 'r5-request', method, payload: target };
      expect(ChatServiceRequestSchema.parse(request)).toEqual(request);
      for (const extra of [{ exportBudget: { maxFiles: 257, maxSourceBytes: 8388608 } }, { maxSourceBytes: 8388608 }, { profile }])
        expect(ChatServiceRequestSchema.safeParse({ ...request, payload: { ...target, ...extra } }).success).toBe(false);
    }
    for (const invalid of [
      { projectKind: 'standard-app', profileVersion: 2 },
      { projectKind: 'unknown', profileVersion: 1 },
    ])
      expect(AppSourceSchema.safeParse({ ...payload('standard-app', 1, 12), profile: invalid }).success).toBe(false);
    const mota = {
      projectKind: 'mota-web',
      profileVersion: 1,
      source: {
        sourceSha256: digest,
        files: MOTA_REQUIRED_FILES.map((path) => ({ path, bytes: 0, sha256: digest })),
      },
    };
    expect(AppProfileSchema.parse(mota)).toEqual(mota);
    expect(ManagedAppSchema.parse({ ...snapshot, profile: mota }).profile).toEqual(mota);
  });
});
