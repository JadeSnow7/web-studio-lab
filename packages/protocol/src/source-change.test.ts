import { describe, expect, it } from 'vitest';
import {
  AppSourceSnapshotSchema,
  AppSourceSnapshotResultSchema,
  RunPatchQuerySchema,
  RunPatchResultSchema,
  SOURCE_MAX_BYTES,
  SOURCE_MAX_FILES,
  SourceChangeSchema,
} from './source-change';
import { ChatServiceRequestSchema } from './chat';
import { WorkbenchRunSchema } from './workspace';

const target = { workspaceId: 'space', projectId: '6e2214b5-778b-4b53-91ec-0de1b0cd2c18' };
const file = (path: string) => ({ path, mode: '100644', base64: '' });

describe('source evidence protocol', () => {
  it('accepts empty snapshots and the 20000-file bound, independently from App export', () => {
    expect(AppSourceSnapshotSchema.parse({ ...target, files: [], totalBytes: 0 }).files).toEqual([]);
    const files = Array.from({ length: SOURCE_MAX_FILES }, (_, i) => file(`src/file-${i}`));
    expect(AppSourceSnapshotSchema.parse({ ...target, files, totalBytes: 0 }).files).toHaveLength(SOURCE_MAX_FILES);
    expect(AppSourceSnapshotSchema.safeParse({ ...target, files: [...files, file('extra')], totalBytes: 0 }).success).toBe(false);
    expect(AppSourceSnapshotSchema.safeParse({ ...target, files: [], totalBytes: SOURCE_MAX_BYTES + 1 }).success).toBe(false);
  });
  it('rejects an excessive implied directory tree before importing guest files on the host', () => {
    const files = Array.from({ length: 400 }, (_, i) => file(`tree-${i}/${'d/'.repeat(62)}leaf`));
    expect(() => AppSourceSnapshotSchema.parse({ ...target, files, totalBytes: 0 })).toThrow('源码目录数量超限');
  });
  it.each([
    '../outside',
    '/absolute',
    'src/../bad',
    'src\\bad',
    'a\0b',
    'src/.git/config',
    'nested/node_modules/a',
    'src/.wsl-hash',
    'a:b',
    'a//b',
    'bad.',
    'bad ',
    'bad\ud800',
    'e\u0301.ts',
    'bad\u0085.ts',
    'bad\u202e.ts',
    'bad\u2028.ts',
    'x'.repeat(1025),
    `${'d/'.repeat(64)}leaf`,
  ])('rejects unsafe paths %j', (path) => {
    expect(AppSourceSnapshotSchema.safeParse({ ...target, files: [file(path)], totalBytes: 0 }).success).toBe(false);
  });
  it.each(
    [
      [file('a'), file('a')],
      [file('a'), file('A')],
      [file('straße'), file('STRASSE')],
      [file('dir/a'), file('DIR/b')],
      [file('dir/a'), file('dir')],
      [file('dir'), file('dir/a')],
      [{ ...file('a'), mode: '120000' }],
      [{ ...file('a'), base64: 'Zh==' }],
      [{ ...file('a'), base64: 'AA$=' }],
    ].map((files) => ({ files })),
  )('rejects collisions, symlink modes and noncanonical encoding %#', ({ files }) => {
    expect(AppSourceSnapshotSchema.safeParse({ ...target, files, totalBytes: 0 }).success).toBe(false);
  });
  it('rejects line endings in canonical base64 and hashes, not merely mismatched byte receipts', () => {
    expect(AppSourceSnapshotSchema.safeParse({ ...target, files: [{ ...file('a'), base64: 'A==\n' }], totalBytes: 3 }).success).toBe(false);
    expect(AppSourceSnapshotSchema.safeParse({ ...target, files: [{ ...file('a'), base64: 'YQ==' }], totalBytes: 1 }).success).toBe(true);
    expect(SourceChangeSchema.safeParse({ state: 'baseline', baseTree: 'a'.repeat(40) + '\n' }).success).toBe(false);
  });
  it.each([
    '.env',
    '.env.local',
    '.env.example',
    'nested/.ENV.production',
    '.npmrc',
    'nested/.netrc',
    '.pypirc',
    '.git-credentials',
    '.ssh/id_rsa',
    '.aws/credentials',
    '.azure/accessTokens.json',
    '.gnupg/private-keys-v1.d/key',
    '.codex/auth.json',
    '.docker/config.json',
    'nested/id_ed25519',
    'nested/id_ecdsa_sk',
  ])('rejects credential filename DTO %s rather than trusting guest exclusions', (name) => {
    expect(AppSourceSnapshotSchema.safeParse({ ...target, files: [file(name)], totalBytes: 0 }).success).toBe(false);
  });
  it('keeps ordinary auth source and non-env examples in the evidence scope', () => {
    expect(
      AppSourceSnapshotSchema.safeParse({ ...target, files: [file('src/auth.ts'), file('example.env.ts')], totalBytes: 0 }).success,
    ).toBe(true);
  });
  it('never accepts guest trees or a guest patch instead of raw content', () => {
    expect(AppSourceSnapshotSchema.safeParse({ ...target, files: [], totalBytes: 0, baseTree: 'a'.repeat(40) }).success).toBe(false);
    expect(
      ChatServiceRequestSchema.safeParse({
        id: 'call',
        method: 'app.source.snapshot',
        payload: { target, callId: target.projectId, path: '/host/run' },
      }).success,
    ).toBe(false);
  });
  it('requires bounded explicit source cleanup facts and cannot mark an unconfirmed snapshot successful', () => {
    const failed = { ok: false, target, cleanupConfirmed: false, error: 'synthetic' };
    expect(AppSourceSnapshotResultSchema.parse(failed)).toEqual(failed);
    expect(AppSourceSnapshotResultSchema.safeParse({ ...failed, error: 'x'.repeat(1001) }).success).toBe(false);
    expect(AppSourceSnapshotResultSchema.safeParse({ ok: false, target, error: 'missing cleanup' }).success).toBe(false);
    expect(
      AppSourceSnapshotResultSchema.safeParse({ ok: true, cleanupConfirmed: false, snapshot: { ...target, files: [], totalBytes: 0 } })
        .success,
    ).toBe(false);
  });
  it('limits summaries and UTF-8 patch bytes and excludes path arguments', () => {
    const runId = target.projectId;
    expect(RunPatchQuerySchema.safeParse({ workspaceId: 'space', runId: '../escape' }).success).toBe(false);
    expect(RunPatchQuerySchema.safeParse({ workspaceId: 'space', runId, path: '/tmp/patch' }).success).toBe(false);
    expect(
      RunPatchResultSchema.safeParse({ workspaceId: 'space', runId, patchSha256: 'a'.repeat(64), patch: '中'.repeat(90000) }).success,
    ).toBe(false);
    expect(
      SourceChangeSchema.safeParse({
        state: 'captured',
        baseTree: 'a'.repeat(40),
        afterTree: 'b'.repeat(40),
        additions: 0,
        deletions: 0,
        truncated: true,
        patchSha256: 'a'.repeat(64),
        files: Array.from({ length: 201 }, (_, i) => ({ path: `f${i}`, change: 'added', additions: 0, deletions: 0, binary: false })),
      }).success,
    ).toBe(false);
  });
  it('does not synthesize sourceChange when parsing an old schema4 run', () => {
    const run = WorkbenchRunSchema.parse({
      runId: 'old-run',
      workspaceId: 'space',
      sessionId: 'session',
      taskVersionId: 'task',
      targetRef: null,
      state: 'completed',
      startedAt: 'then',
      endedAt: 'then',
      error: null,
      candidateId: 'candidate',
      validation: { state: 'not_run', applicability: 'unknown', reason: null },
      review: null,
    });
    expect(run).not.toHaveProperty('sourceChange');
    expect(run).not.toHaveProperty('sourceCleanupPending');
    expect(run).not.toHaveProperty('eduTaskCleanupPending');
  });
});
