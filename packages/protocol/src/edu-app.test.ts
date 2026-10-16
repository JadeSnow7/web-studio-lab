import { describe, expect, it } from 'vitest';
import { AppSourceSchema, ManagedAppSchema } from './managed-app';
import { ChatServiceRequestSchema } from './chat';
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
