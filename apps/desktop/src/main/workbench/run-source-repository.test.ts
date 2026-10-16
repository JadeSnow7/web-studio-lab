import { afterEach, describe, expect, it, vi } from 'vitest';
import { access, chmod, lstat, mkdir, mkdtemp, readFile, rename, rm, symlink, writeFile } from 'node:fs/promises';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { createHash, randomUUID } from 'node:crypto';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { SOURCE_PATCH_MAX_BYTES, type AppSourceSnapshot } from '@wsl/protocol';
import { RunSourceRepository } from './run-source-repository';

const exec = promisify(execFile);
const directories: string[] = [];
afterEach(async () => {
  vi.unstubAllEnvs();
  await Promise.all(directories.splice(0).map((directory) => rm(directory, { recursive: true, force: true })));
});
const target = { workspaceId: 'space', projectId: '6e2214b5-778b-4b53-91ec-0de1b0cd2c18' };
function source(contents: Record<string, string | Buffer>): AppSourceSnapshot {
  const files = Object.entries(contents).map(([path, text]) => ({
    path,
    mode: '100644' as const,
    base64: Buffer.from(text).toString('base64'),
  }));
  return { ...target, files, totalBytes: files.reduce((sum, file) => sum + Buffer.from(file.base64, 'base64').length, 0) };
}
async function fixture() {
  const directory = await mkdtemp(path.join(tmpdir(), 'wsl-host-source-'));
  directories.push(directory);
  const root = path.join(directory, 'runs');
  const runId = randomUUID();
  return { directory, root, runId, run: path.join(root, runId), repository: new RunSourceRepository(root) };
}

describe('host-owned per-run source evidence with real Git', () => {
  it('rejects credential DTOs before importing baseline or ending evidence, while retaining auth source', async () => {
    const f = await fixture();
    for (const name of ['.env', '.env.example', 'nested/.env.production', '.codex/auth.json', '.ssh/id_ed25519']) {
      await expect(f.repository.createBaseline(f.runId, source({ [name]: 'SYNTHETIC_NOT_A_REAL_SECRET' }))).rejects.toThrow('路径');
      await expect(access(f.root)).rejects.toMatchObject({ code: 'ENOENT' });
    }
    const { baseTree } = await f.repository.createBaseline(f.runId, source({ 'src/auth.ts': 'before\n' }));
    for (const name of ['.env', '.env.example', 'nested/.env.production', '.codex/auth.json', '.ssh/id_ed25519']) {
      await expect(f.repository.capture(f.runId, baseTree, source({ [name]: 'SYNTHETIC_NOT_A_REAL_SECRET' }))).rejects.toThrow('路径');
      await expect(access(path.join(f.run, 'capture.lock'))).rejects.toMatchObject({ code: 'ENOENT' });
    }
    const captured = await f.repository.capture(f.runId, baseTree, source({ 'src/auth.ts': 'after\n' }));
    const patch = await f.repository.readPatch(f.runId, captured.patchSha256);
    expect(patch).toContain('src/auth.ts');
    expect(patch).not.toContain('SYNTHETIC_NOT_A_REAL_SECRET');
  });
  it('computes additions, modifications, deletions, exact renames and binary facts from raw bytes', async () => {
    const f = await fixture();
    const before = source({
      'modified.ts': 'old\ncommon\n',
      'deleted.ts': 'removed\n',
      'old-name.ts': 'identical rename\n',
      'binary.dat': Buffer.from([0, 1, 2]),
    });
    const { baseTree } = await f.repository.createBaseline(f.runId, before);
    const after = source({
      'modified.ts': 'new\ncommon\n',
      'added.ts': 'added\n',
      'new-name.ts': 'identical rename\n',
      'binary.dat': Buffer.from([0, 7, 8]),
    });
    const result = await f.repository.capture(f.runId, baseTree, after);
    expect(result.files).toEqual(
      expect.arrayContaining([
        { path: 'modified.ts', change: 'modified', additions: 1, deletions: 1, binary: false },
        { path: 'deleted.ts', change: 'deleted', additions: 0, deletions: 1, binary: false },
        { path: 'added.ts', change: 'added', additions: 1, deletions: 0, binary: false },
        { path: 'new-name.ts', change: 'renamed', additions: 0, deletions: 0, binary: false },
        { path: 'binary.dat', change: 'modified', additions: 0, deletions: 0, binary: true },
      ]),
    );
    expect(result).toMatchObject({ additions: 2, deletions: 2, truncated: false });
    const patch = await f.repository.readPatch(f.runId, result.patchSha256);
    expect(patch).toContain('-old\n+new');
    expect(patch).toContain('rename from old-name.ts');
    expect(patch).toContain('Binary files');
    expect(createHash('sha256').update(patch).digest('hex')).toBe(result.patchSha256);
    expect((await exec('git', ['--git-dir=' + path.join(f.run, 'objects.git'), 'cat-file', '-p', baseTree + ':modified.ts'])).stdout).toBe(
      'old\ncommon\n',
    );
    await expect(access(path.join(f.run, 'modified.ts'))).rejects.toThrow();
  });
  it('does not interpret guest ignore rules, attributes, repository config or inherited Git configuration', async () => {
    const f = await fixture();
    const marker = path.join(f.directory, 'should-not-exist');
    const config = path.join(f.directory, 'hostile-config');
    await writeFile(
      config,
      `[diff]\nexternal = sh -c 'touch ${marker}'\n[filter "evil"]\nclean = sh -c 'touch ${marker}'\nrequired = true\n[diff "evil"]\ntextconv = sh -c 'touch ${marker}'\n`,
    );
    vi.stubEnv('GIT_CONFIG_GLOBAL', config);
    vi.stubEnv('GIT_CONFIG_COUNT', '1');
    vi.stubEnv('GIT_CONFIG_KEY_0', 'diff.external');
    vi.stubEnv('GIT_CONFIG_VALUE_0', `sh -c 'touch ${marker}'`);
    vi.stubEnv('GIT_EXTERNAL_DIFF', `sh -c 'touch ${marker}'`);
    vi.stubEnv('GIT_DIR', '/guest/repository/.git');
    vi.stubEnv('GIT_ATTR_SOURCE', 'HEAD');
    const original = source({
      '.gitignore': '*\n',
      '.gitattributes': '* filter=evil diff=evil -text\n',
      'source.ts': 'before\n',
      '配置.ts': '以前\n',
    });
    const { baseTree } = await f.repository.createBaseline(f.runId, original);
    const current = source({
      '.gitignore': '*\n',
      '.gitattributes': '* filter=evil diff=evil -text\n',
      'source.ts': 'after\n',
      '配置.ts': '以后\n',
      'new ignored.ts': 'new\n',
    });
    const result = await f.repository.capture(f.runId, baseTree, current);
    expect(result.files.map((file) => file.path)).toEqual(['new ignored.ts', 'source.ts', '配置.ts']);
    expect(await f.repository.readPatch(f.runId, result.patchSha256)).toContain('+after');
    await expect(access(marker)).rejects.toThrow();
  });
  it('recognizes an edited rename within the bounded similarity search', async () => {
    const f = await fixture();
    const original = Array.from({ length: 20 }, (_, i) => `original source line ${i}\n`).join('');
    const { baseTree } = await f.repository.createBaseline(f.runId, source({ 'before.ts': original }));
    const result = await f.repository.capture(f.runId, baseTree, source({ 'after.ts': original.replace('line 10', 'changed 10') }));
    expect(result.files).toEqual([{ path: 'after.ts', change: 'renamed', additions: 1, deletions: 1, binary: false }]);
  });
  it('keeps a baseline exclusively created and immutable to later guest snapshots or repeat capture', async () => {
    const f = await fixture();
    const { baseTree } = await f.repository.createBaseline(f.runId, source({ a: 'first\n' }));
    const baseline = await readFile(path.join(f.run, 'baseline.json'), 'utf8');
    await expect(f.repository.createBaseline(f.runId, source({ a: 'forged baseline\n' }))).rejects.toThrow();
    expect(await readFile(path.join(f.run, 'baseline.json'), 'utf8')).toBe(baseline);
    const result = await f.repository.capture(f.runId, baseTree, source({ a: 'actual after\n' }));
    const patch = await f.repository.readPatch(f.runId, result.patchSha256);
    await expect(f.repository.capture(f.runId, baseTree, source({ a: 'second after\n' }))).rejects.toThrow();
    expect(await f.repository.readPatch(f.runId, result.patchSha256)).toBe(patch);
    expect(patch).toContain('-first\n+actual after');
  });
  it('supports empty snapshots and returns an empty patch for unchanged source without validation claims', async () => {
    const f = await fixture();
    const snapshot = source({});
    const { baseTree } = await f.repository.createBaseline(f.runId, snapshot);
    const result = await f.repository.capture(f.runId, baseTree, snapshot);
    expect(result).toMatchObject({ baseTree, afterTree: baseTree, files: [], additions: 0, deletions: 0, truncated: false });
    expect(await f.repository.readPatch(f.runId, result.patchSha256)).toBe('');
  });
  it('records executable mode changes without creating guest files on the host', async () => {
    const f = await fixture();
    const snapshot = source({ 'run.sh': 'exit 0\n' });
    const { baseTree } = await f.repository.createBaseline(f.runId, snapshot);
    const after: AppSourceSnapshot = { ...snapshot, files: snapshot.files.map((file) => ({ ...file, mode: '100755' })) };
    const result = await f.repository.capture(f.runId, baseTree, after);
    expect(result.files[0]).toMatchObject({ change: 'modified', additions: 0, deletions: 0 });
    expect(await f.repository.readPatch(f.runId, result.patchSha256)).toContain('new mode 100755');
  });
  it('rejects non-UTF-8 text diff instead of silently replacing evidence bytes', async () => {
    const f = await fixture();
    const { baseTree } = await f.repository.createBaseline(f.runId, source({}));
    await expect(f.repository.capture(f.runId, baseTree, source({ 'legacy.txt': Buffer.from([0xff, 0xfe, 10]) }))).rejects.toThrow(
      '非 UTF-8',
    );
    await expect(access(path.join(f.run, 'source.patch'))).rejects.toThrow();
  });
  it('bounds UTF-8 patch bytes and summary files without dropping aggregate counts', async () => {
    const f = await fixture();
    const { baseTree } = await f.repository.createBaseline(f.runId, source({}));
    const entries = Object.fromEntries(
      Array.from({ length: 210 }, (_, i) => [`f${String(i).padStart(3, '0')}.ts`, '中文变更'.repeat(300) + '\n']),
    );
    const result = await f.repository.capture(f.runId, baseTree, source(entries));
    const patch = await f.repository.readPatch(f.runId, result.patchSha256);
    expect(result.files).toHaveLength(200);
    expect(result.additions).toBe(210);
    expect(result.truncated).toBe(true);
    expect(Buffer.byteLength(patch)).toBeLessThanOrEqual(SOURCE_PATCH_MAX_BYTES);
    expect(patch).not.toContain('\ufffd');
    expect(Buffer.byteLength(patch)).toBeGreaterThan(SOURCE_PATCH_MAX_BYTES - 4);
  });
  it.each(['../outside', '/outside', 'dir/../../escape', '.git/config', 'nested/node_modules/hidden', 'source\\bad'])(
    'rejects unsafe source path %s without creating a run directory',
    async (unsafe) => {
      const f = await fixture();
      await expect(f.repository.createBaseline(f.runId, source({ [unsafe]: 'forged' }))).rejects.toThrow('源码快照');
      await expect(lstat(f.run)).rejects.toThrow();
    },
  );
  it('rejects wrong targets, invalid run paths and corrupt hashes', async () => {
    const f = await fixture();
    const { baseTree } = await f.repository.createBaseline(f.runId, source({ a: 'before' }));
    await expect(f.repository.capture(f.runId, baseTree, { ...source({}), workspaceId: 'other' })).rejects.toThrow('归属');
    await expect(f.repository.capture(f.runId, '0'.repeat(40), source({}))).rejects.toThrow('归属');
    const result = await f.repository.capture(f.runId, baseTree, source({ a: 'after' }));
    await expect(f.repository.readPatch('../escape', result.patchSha256)).rejects.toThrow('身份');
    await expect(f.repository.readPatch(f.runId, '0'.repeat(64))).rejects.toThrow('SHA-256');
    const patch = path.join(f.run, 'source.patch');
    await chmod(patch, 0o600);
    await writeFile(patch, 'tampered');
    await expect(f.repository.readPatch(f.runId, result.patchSha256)).rejects.toThrow('SHA-256');
    await writeFile(patch, 'a'.repeat(SOURCE_PATCH_MAX_BYTES + 1));
    await expect(f.repository.readPatch(f.runId, result.patchSha256)).rejects.toThrow('预算');
  });
  it('rejects symlink patch, run and runs directories', async () => {
    const f = await fixture();
    const { baseTree } = await f.repository.createBaseline(f.runId, source({}));
    const result = await f.repository.capture(f.runId, baseTree, source({ a: 'after' }));
    const patch = path.join(f.run, 'source.patch');
    const actualPatch = path.join(f.run, 'actual.patch');
    await rename(patch, actualPatch);
    await symlink(actualPatch, patch);
    await expect(f.repository.readPatch(f.runId, result.patchSha256)).rejects.toThrow();
    const realRun = path.join(f.root, 'real');
    await rename(f.run, realRun);
    await symlink(realRun, f.run);
    await expect(f.repository.readPatch(f.runId, result.patchSha256)).rejects.toThrow('目录');
    const second = await fixture();
    const elsewhere = path.join(second.directory, 'elsewhere');
    await mkdir(elsewhere);
    await symlink(elsewhere, second.root);
    await expect(second.repository.createBaseline(second.runId, source({}))).rejects.toThrow('目录');
  });
  it('reports missing Git as evidence unavailable and honors abort before any host I/O', async () => {
    const f = await fixture();
    await expect(new RunSourceRepository(f.root, '/missing/wsl-git').createBaseline(f.runId, source({}))).rejects.toThrow('Git 不可用');
    const aborted = AbortSignal.abort();
    const next = randomUUID();
    await expect(f.repository.createBaseline(next, source({}), aborted)).rejects.toThrow();
    await expect(lstat(path.join(f.root, next))).rejects.toThrow();
  });
});
