import { createHash } from 'node:crypto';
import { mkdtemp, mkdir, writeFile, readFile, symlink, link, rm } from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import { describe, expect, it, vi } from 'vitest';
import { EDU_REQUIRED_FILES } from '@wsl/protocol';
import { collectEduSource } from './edu-source';

const repository = { commit: 'a'.repeat(40), dirty: false };
async function fixture() {
  const root = await mkdtemp(path.join(os.tmpdir(), 'wsl-edu-source-'));
  for (const name of [...EDU_REQUIRED_FILES, 'admin/src/App.tsx', 'README.md']) {
    const file = path.join(root, name);
    await mkdir(path.dirname(file), { recursive: true });
    await writeFile(file, name + '\n');
  }
  return root;
}
const identity = async () => repository;

describe('Main-owned edu source capture', () => {
  it('hashes actual allowlisted bytes, excludes runtime data and rechecks source identity', async () => {
    const root = await fixture();
    try {
      for (const name of [
        '.env',
        'server/.env.py',
        'server/data/edu.db',
        'admin/dist/index.html',
        'admin/tsconfig.tsbuildinfo',
        'android/app.json',
      ]) {
        const file = path.join(root, name);
        await mkdir(path.dirname(file), { recursive: true });
        await writeFile(file, 'not source');
      }
      const version = vi.fn(identity);
      const result = await collectEduSource(root, new AbortController().signal, version);
      expect(result.files.map((file) => file.path)).toEqual([...EDU_REQUIRED_FILES, 'admin/src/App.tsx', 'README.md'].sort());
      expect(result.source.repository).toEqual(repository);
      expect(result.source.sourceSha256).toBe(createHash('sha256').update(JSON.stringify(result.source.files)).digest('hex'));
      expect(version).toHaveBeenCalledTimes(2);
      for (const file of result.files) expect(Buffer.from(file.base64, 'base64')).toEqual(await readFile(path.join(root, file.path)));
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });
  it.each(['symlink', 'hardlink', 'directory-symlink', 'oversize', 'missing-required'])(
    'rejects %s without publishing a source snapshot',
    async (kind) => {
      const root = await fixture();
      try {
        if (kind === 'symlink') await symlink(path.join(root, 'README.md'), path.join(root, 'server/linked.py'));
        if (kind === 'hardlink') await link(path.join(root, 'README.md'), path.join(root, 'server/linked.py'));
        if (kind === 'directory-symlink') await symlink(path.join(root, 'server'), path.join(root, 'admin/linked'));
        if (kind === 'oversize') await writeFile(path.join(root, 'server/large.py'), Buffer.alloc(524289));
        if (kind === 'missing-required') await rm(path.join(root, EDU_REQUIRED_FILES[0]!));
        await expect(collectEduSource(root, new AbortController().signal, identity)).rejects.toThrow();
      } finally {
        await rm(root, { recursive: true, force: true });
      }
    },
  );
  it('does not start source collection after cancellation', async () => {
    const abort = new AbortController();
    abort.abort();
    const version = vi.fn(identity);
    await expect(collectEduSource('/not-used', abort.signal, version)).rejects.toThrow();
    expect(version).not.toHaveBeenCalled();
  });
  it.each(['commit', 'bytes'])('detects a concurrent %s change before releasing the snapshot', async (kind) => {
    const root = await fixture();
    let calls = 0;
    try {
      const version = async () => {
        if (++calls === 2) {
          if (kind === 'commit') return { ...repository, commit: 'b'.repeat(40) };
          await writeFile(path.join(root, 'admin/src/App.tsx'), 'changed while capturing');
        }
        return repository;
      };
      await expect(collectEduSource(root, new AbortController().signal, version)).rejects.toThrow(/变化|changed/);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });
});
