import { execFile, execFileSync, spawn } from 'node:child_process';
import { createHash, randomUUID } from 'node:crypto';
import { mkdtemp, mkdir, readFile, readdir, rm, stat, symlink, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { promisify } from 'node:util';
import { EDU_REQUIRED_FILES } from '@wsl/protocol';
import { describe, expect, it } from 'vitest';
import { z } from 'zod';
import helper from './app-helper.py?raw';

const files = [...EDU_REQUIRED_FILES, 'admin/src/App.tsx'].sort().map((name) => ({
  path: name,
  base64: Buffer.from(name).toString('base64'),
}));
const metadata = files.map((file) => ({
  path: file.path,
  sha256: createHash('sha256').update(Buffer.from(file.base64, 'base64')).digest('hex'),
  bytes: Buffer.from(file.base64, 'base64').length,
}));
const profile = {
  projectKind: 'edu-web',
  profileVersion: 1,
  source: {
    repository: { commit: 'a'.repeat(40), dirty: false },
    sourceSha256: createHash('sha256').update(JSON.stringify(metadata)).digest('hex'),
    files: metadata,
  },
};
const receiptSchema = z.object({
  outcome: z.enum(['imported', 'cancelled', 'failed']),
  retryable: z.boolean(),
  errorCode: z.string().nullable(),
  importOperationId: z.uuid(),
  sourceSha256: z.string().optional(),
  profile: z.unknown().optional(),
});
function result(stdout: string) {
  const line = stdout.split('\n').find((entry) => entry.startsWith('WSL_APP_RESULT:'));
  if (!line) throw new Error('missing helper receipt');
  return receiptSchema.parse(JSON.parse(line.slice('WSL_APP_RESULT:'.length)));
}
const setup =
  "import sys,json,os; from pathlib import Path; scope={'__name__':'wsl_import_test'}; exec(sys.argv[3],scope); scope['ROOT']=Path(sys.argv[1]); request=json.loads(sys.argv[2])\n";
const executeAsync = promisify(execFile);
async function fixture() {
  const root = await mkdtemp(path.join(os.tmpdir(), 'wsl-edu-import-'));
  const importOperationId = randomUUID();
  const projectId = randomUUID();
  const request = { workspaceId: 'edu-import-test', projectId, importOperationId, profile, files };
  const args = (operation: string, overrides: Record<string, unknown> = {}, inject = '') => [
    '-c',
    setup + inject + "\nscope['run'](request)",
    root,
    JSON.stringify({ ...request, operation, ...overrides }),
    helper,
  ];
  return {
    root,
    projectId,
    importOperationId,
    project: path.join(root, projectId),
    staging: path.join(root, '.wsl-import-stage-' + importOperationId),
    receipt: path.join(root, '.wsl-import-operations', importOperationId + '.json'),
    run: (operation: string, overrides: Record<string, unknown> = {}, inject = '') =>
      result(execFileSync('python3', args(operation, overrides, inject), { encoding: 'utf8', timeout: 3000 })),
    runAsync: async () => result((await executeAsync('python3', args('import-source'), { encoding: 'utf8', timeout: 3000 })).stdout),
    args,
    dispose: () => rm(root, { recursive: true, force: true }),
  };
}
// Crash a real worker after its owned marker, leaving a partially copied source.
const partialCrash = `original = scope['import_write_json']
def interrupted(path, value, replace=False):
    original(path, value, replace)
    if path.name == '.wsl-import.json':
        (path.parent / 'server').mkdir()
        (path.parent / 'server/app.py').write_text('partial')
        os._exit(71)
scope['import_write_json'] = interrupted
`;
const publishedCrash = `original = scope['import_publish']
def interrupted(staging, destination):
    original(staging, destination)
    os._exit(72)
scope['import_publish'] = interrupted
`;

describe('transactional edu source importer (real local Python, no guest)', () => {
  it('publishes complete bytes once and recovers duplicate delivery without replacing its directory', async () => {
    const test = await fixture();
    try {
      expect(test.run('import-source')).toMatchObject({ outcome: 'imported', retryable: false, errorCode: null, profile });
      const inode = (await stat(test.project)).ino;
      expect(test.run('import-source')).toMatchObject({ outcome: 'imported', sourceSha256: profile.source.sourceSha256 });
      expect(test.run('reconcile-import', { profile: undefined, files: undefined })).toMatchObject({ outcome: 'imported', profile });
      expect((await stat(test.project)).ino).toBe(inode);
      for (const file of files) expect(await readFile(path.join(test.project, file.path), 'utf8')).toBe(file.path);
      expect(JSON.parse(await readFile(path.join(test.project, '.wsl-profile.json'), 'utf8'))).toEqual(profile);
      expect(JSON.parse(await readFile(path.join(test.project, '.wsl-import.json'), 'utf8'))).toMatchObject({
        importOperationId: test.importOperationId,
      });
      await expect(stat(test.staging)).rejects.toMatchObject({ code: 'ENOENT' });
    } finally {
      await test.dispose();
    }
  });

  it('serializes duplicate workers across processes without a second publication', async () => {
    const test = await fixture();
    try {
      const receipts = await Promise.all([test.runAsync(), test.runAsync()]);
      expect(receipts.some((entry) => entry.outcome === 'imported')).toBe(true);
      for (const entry of receipts) {
        if (entry.outcome === 'failed') expect(entry).toMatchObject({ retryable: false, errorCode: 'import_cleanup_unknown' });
      }
      expect(test.run('import-source').outcome).toBe('imported');
      expect((await readdir(test.root)).filter((name) => !name.startsWith('.'))).toEqual([test.projectId]);
    } finally {
      await test.dispose();
    }
  });

  it.each(['target', 'profile', 'source'])('refuses operation reuse with a different %s without modifying its receipt', async (kind) => {
    const test = await fixture();
    try {
      test.run('import-source');
      const before = await readFile(test.receipt);
      const changedFiles = files.map((file) => ({ ...file, base64: Buffer.from(file.path + 'changed').toString('base64') }));
      const changedMetadata = changedFiles.map((file) => ({
        path: file.path,
        sha256: createHash('sha256').update(Buffer.from(file.base64, 'base64')).digest('hex'),
        bytes: Buffer.from(file.base64, 'base64').length,
      }));
      const overrides =
        kind === 'target'
          ? { projectId: randomUUID() }
          : kind === 'profile'
            ? { profile: { ...profile, source: { ...profile.source, repository: { commit: 'b'.repeat(40), dirty: false } } } }
            : {
                files: changedFiles,
                profile: {
                  ...profile,
                  source: {
                    ...profile.source,
                    files: changedMetadata,
                    sourceSha256: createHash('sha256').update(JSON.stringify(changedMetadata)).digest('hex'),
                  },
                },
              };
      expect(test.run('import-source', overrides)).toMatchObject({
        outcome: 'failed',
        retryable: false,
        errorCode: 'import_operation_conflict',
      });
      expect(await readFile(test.receipt)).toEqual(before);
    } finally {
      await test.dispose();
    }
  });

  it('persists cancel-before-import without needing profile and never replays a cancelled operation', async () => {
    const test = await fixture();
    try {
      expect(test.run('reconcile-import', { profile: undefined, files: undefined })).toMatchObject({
        outcome: 'cancelled',
        retryable: false,
      });
      expect(test.run('import-source')).toMatchObject({ outcome: 'cancelled', retryable: false });
      expect(test.run('reconcile-import', { cancel: false, profile: undefined })).toMatchObject({ outcome: 'cancelled', retryable: false });
      await expect(stat(test.project)).rejects.toMatchObject({ code: 'ENOENT' });
      await expect(stat(test.staging)).rejects.toMatchObject({ code: 'ENOENT' });
    } finally {
      await test.dispose();
    }
  });

  it.each([true, false])('reconciles an interrupted owned copy with cancel=%s and permits only safe failed retries', async (cancel) => {
    const test = await fixture();
    try {
      expect(() => test.run('import-source', {}, partialCrash)).toThrow();
      expect(await readFile(path.join(test.staging, 'server/app.py'), 'utf8')).toBe('partial');
      expect(test.run('reconcile-import', { cancel, profile: undefined, files: undefined })).toMatchObject({
        outcome: cancel ? 'cancelled' : 'failed',
        retryable: !cancel,
      });
      await expect(stat(test.staging)).rejects.toMatchObject({ code: 'ENOENT' });
      expect(test.run('import-source').outcome).toBe(cancel ? 'cancelled' : 'imported');
    } finally {
      await test.dispose();
    }
  });

  it('keeps a pre-marker crash directory because its ownership is incomplete', async () => {
    const test = await fixture();
    try {
      const injection = `original = scope['import_write_json']
def interrupted(path, value, replace=False):
    original(path, value, replace)
    if path.name.endswith('.json') and value.get('state') == 'pending' and value.get('directory') is not None:
        os._exit(73)
scope['import_write_json'] = interrupted
`;
      expect(() => test.run('import-source', {}, injection)).toThrow();
      expect(test.run('reconcile-import')).toMatchObject({ outcome: 'failed', retryable: false });
      expect((await stat(test.staging)).isDirectory()).toBe(true);
      await expect(stat(test.project)).rejects.toMatchObject({ code: 'ENOENT' });
    } finally {
      await test.dispose();
    }
  });

  it.each([true, false])('recognizes commit after a lost post-rename receipt with cancel=%s', async (cancel) => {
    const test = await fixture();
    try {
      expect(() => test.run('import-source', {}, publishedCrash)).toThrow();
      const inode = (await stat(test.project)).ino;
      expect(test.run('reconcile-import', { cancel, profile: undefined, files: undefined })).toMatchObject({
        outcome: 'imported',
        retryable: false,
        profile,
      });
      expect((await stat(test.project)).ino).toBe(inode);
      expect(test.run('import-source').outcome).toBe('imported');
    } finally {
      await test.dispose();
    }
  });

  it('does not overwrite an empty directory racing with the atomic publication', async () => {
    const test = await fixture();
    try {
      const injection = `original = scope['import_publish']
def raced(staging, destination):
    destination.mkdir()
    original(staging, destination)
scope['import_publish'] = raced
`;
      expect(test.run('import-source', {}, injection)).toMatchObject({ outcome: 'failed', retryable: false });
      expect(await readdir(test.project)).toEqual([]);
      expect((await stat(test.staging)).isDirectory()).toBe(true);
    } finally {
      await test.dispose();
    }
  });

  it('keeps cancellation durable even when a foreign target prevents reconciliation', async () => {
    const test = await fixture();
    try {
      expect(() => test.run('import-source', {}, partialCrash)).toThrow();
      await mkdir(test.project);
      await writeFile(path.join(test.project, 'foreign.txt'), 'untouched');
      expect(test.run('reconcile-import')).toMatchObject({ outcome: 'failed', retryable: false });
      expect(await readFile(path.join(test.project, 'foreign.txt'), 'utf8')).toBe('untouched');
      await rm(test.project, { recursive: true });
      expect(test.run('import-source')).toMatchObject({ outcome: 'cancelled', retryable: false });
      await expect(stat(test.project)).rejects.toMatchObject({ code: 'ENOENT' });
    } finally {
      await test.dispose();
    }
  });

  it.each(['changed', 'missing'])('never repairs a previously published project that is %s', async (kind) => {
    const test = await fixture();
    try {
      test.run('import-source');
      const before = await readFile(test.receipt);
      if (kind === 'changed') await writeFile(path.join(test.project, 'admin/src/App.tsx'), 'user change');
      else await rm(test.project, { recursive: true });
      expect(test.run('import-source')).toMatchObject({ outcome: 'failed', retryable: false });
      expect(await readFile(test.receipt)).toEqual(before);
      if (kind === 'changed') expect(await readFile(path.join(test.project, 'admin/src/App.tsx'), 'utf8')).toBe('user change');
      else await expect(stat(test.project)).rejects.toMatchObject({ code: 'ENOENT' });
    } finally {
      await test.dispose();
    }
  });

  it('does not clean an owned stage after an unknown file has appeared', async () => {
    const test = await fixture();
    try {
      expect(() => test.run('import-source', {}, partialCrash)).toThrow();
      await writeFile(path.join(test.staging, 'foreign.txt'), 'keep');
      expect(test.run('reconcile-import')).toMatchObject({ outcome: 'failed', retryable: false, errorCode: 'import_cleanup_unknown' });
      expect(await readFile(path.join(test.staging, 'foreign.txt'), 'utf8')).toBe('keep');
    } finally {
      await test.dispose();
    }
  });

  it('rejects a target symlink without touching its destination', async () => {
    const test = await fixture();
    try {
      const other = path.join(test.root, 'foreign');
      await mkdir(other);
      await writeFile(path.join(other, 'keep'), 'untouched');
      await symlink(other, test.project);
      expect(test.run('import-source')).toMatchObject({ outcome: 'failed', retryable: false });
      expect(await readFile(path.join(other, 'keep'), 'utf8')).toBe('untouched');
    } finally {
      await test.dispose();
    }
  });

  it('checks all supplied bytes before creating transaction metadata', async () => {
    const test = await fixture();
    try {
      expect(test.run('import-source', { files: files.map((file) => ({ ...file, base64: 'eA==' })) })).toMatchObject({
        outcome: 'failed',
        retryable: false,
        errorCode: 'import_source_mismatch',
      });
      expect(await readdir(test.root)).toEqual([]);
    } finally {
      await test.dispose();
    }
  });

  it('cleans an owned failed publication before allowing the same operation to retry', async () => {
    const test = await fixture();
    try {
      const injection = `def unavailable(staging, destination):
    raise OSError(28, 'simulated full filesystem')
scope['import_publish'] = unavailable
`;
      expect(test.run('import-source', {}, injection)).toMatchObject({ outcome: 'failed', retryable: true, errorCode: 'import_failed' });
      await expect(stat(test.staging)).rejects.toMatchObject({ code: 'ENOENT' });
      await expect(stat(test.project)).rejects.toMatchObject({ code: 'ENOENT' });
      expect(test.run('import-source').outcome).toBe('imported');
    } finally {
      await test.dispose();
    }
  });

  it.each(['corrupt', 'future-version', 'symlink'])('preserves a %s operation receipt and refuses to use it', async (kind) => {
    const test = await fixture();
    try {
      test.run('reconcile-import', { cancel: false });
      const foreign = path.join(test.root, 'foreign.json');
      if (kind === 'corrupt') await writeFile(test.receipt, '{');
      if (kind === 'future-version') {
        const stored = JSON.parse(await readFile(test.receipt, 'utf8'));
        await writeFile(test.receipt, JSON.stringify({ ...stored, schemaVersion: 2 }));
      }
      if (kind === 'symlink') {
        await writeFile(foreign, 'keep');
        await rm(test.receipt);
        await symlink(foreign, test.receipt);
      }
      const before = await readFile(test.receipt);
      expect(test.run('import-source')).toMatchObject({ outcome: 'failed', retryable: false });
      expect(await readFile(test.receipt)).toEqual(before);
      await expect(stat(test.project)).rejects.toMatchObject({ code: 'ENOENT' });
    } finally {
      await test.dispose();
    }
  });

  it('reports a live lock immediately instead of waiting and replaying after worker exit', async () => {
    const test = await fixture();
    let child: ReturnType<typeof spawn> | undefined;
    try {
      // Create only a retryable empty operation so the lock inode already exists.
      test.run('reconcile-import', { cancel: false });
      const script =
        setup +
        `with scope['import_lock'](Path(sys.argv[1]) / '.wsl-import-operations' / (request['importOperationId'] + '.lock')):
    print('LOCKED', flush=True)
    sys.stdin.readline()
`;
      const args = test.args('import-source');
      args[1] = script;
      const worker = spawn('python3', args, { stdio: ['pipe', 'pipe', 'pipe'] });
      child = worker;
      await new Promise<void>((resolve, reject) => {
        worker.once('error', reject);
        worker.stdout.once('data', () => resolve());
        worker.once('exit', (code) => {
          if (code !== 0) reject(new Error('lock holder exited early'));
        });
      });
      expect(test.run('import-source')).toMatchObject({ outcome: 'failed', retryable: false, errorCode: 'import_cleanup_unknown' });
      await expect(stat(test.project)).rejects.toMatchObject({ code: 'ENOENT' });
      const exited = new Promise<void>((resolve) => worker.once('exit', () => resolve()));
      worker.stdin.end('\n');
      await exited;
      expect(test.run('import-source').outcome).toBe('imported');
    } finally {
      if (child && child.exitCode === null) child.kill();
      await test.dispose();
    }
  });
});
