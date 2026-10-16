import { createHash, randomUUID } from 'node:crypto';
import { mkdtemp, readFile, readdir, stat, rm } from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import { describe, expect, it } from 'vitest';
import { EDU_REQUIRED_FILES, type AppSource } from '@wsl/protocol';
import { exportAppSource } from './source-export';

const hash = (content: string | Buffer) => createHash('sha256').update(content).digest('hex');
const target = { workspaceId: 'export-test', projectId: randomUUID() };
function source(): AppSource {
  const files = [...EDU_REQUIRED_FILES, 'admin/src/App.tsx'].sort().map((path) => ({ path, base64: Buffer.from(path).toString('base64') }));
  const metadata = files.map((file) => {
    const bytes = Buffer.from(file.base64, 'base64');
    return { path: file.path, sha256: hash(bytes), bytes: bytes.length };
  });
  return {
    files,
    sha256: hash(JSON.stringify(files)),
    profile: {
      projectKind: 'edu-web',
      profileVersion: 1,
      source: { repository: { commit: 'a'.repeat(40), dirty: false }, sourceSha256: hash(JSON.stringify(metadata)), files: metadata },
    },
  };
}

describe('Main-owned source export publication', () => {
  it('writes a complete private bundle with real current hashes and an immutable import baseline', async () => {
    const directory = await mkdtemp(path.join(os.tmpdir(), 'wsl-edu-export-'));
    try {
      const input = source();
      input.files.find((file) => file.path === 'admin/src/App.tsx')!.base64 = Buffer.from('a managed edit').toString('base64');
      input.sha256 = hash(JSON.stringify(input.files));
      const result = await exportAppSource(directory, target, input);
      const manifest = JSON.parse(await readFile(result.manifestPath, 'utf8'));
      expect(manifest).toMatchObject({
        sourceKind: 'workbench-export',
        projectKind: 'edu-web',
        profileVersion: 1,
        repository: { commit: 'a'.repeat(40), dirty: true },
        workbench: { ...target, environmentId: 'sandbox' },
      });
      expect(manifest.sourceSha256).toBe(hash(JSON.stringify(manifest.files)));
      expect(manifest.sourceSha256).toBe(result.sha256);
      expect(manifest.workbench.importBase).toEqual(input.profile?.projectKind === 'edu-web' ? input.profile.source : null);
      expect(manifest.workbench.importBase.sourceSha256).not.toBe(manifest.sourceSha256);
      expect(await readdir(path.dirname(result.manifestPath))).toEqual(['manifest.json', 'source']);
      for (const file of input.files) {
        const bytes = await readFile(path.join(result.path, file.path));
        expect(bytes).toEqual(Buffer.from(file.base64, 'base64'));
        expect(manifest.files.find((item: { path: string }) => item.path === file.path)).toEqual({
          path: file.path,
          sha256: hash(bytes),
          bytes: bytes.length,
        });
        expect((await stat(path.join(result.path, file.path))).mode & 0o777).toBe(0o600);
      }
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
  });
  it.each(['transport-hash', 'baseline-hash', 'secret-path', 'missing-required', 'protected-backend', 'duplicate-path', 'traversal'])(
    'refuses %s before creating output',
    async (kind) => {
      const directory = await mkdtemp(path.join(os.tmpdir(), 'wsl-edu-export-'));
      try {
        const input = source();
        if (kind === 'baseline-hash' && input.profile?.projectKind === 'edu-web') input.profile.source.sourceSha256 = '0'.repeat(64);
        if (kind === 'secret-path') input.files.push({ path: 'server/.env.py', base64: '' });
        if (kind === 'missing-required') input.files.shift();
        if (kind === 'protected-backend')
          input.files.find((file) => file.path === 'server/app.py')!.base64 = Buffer.from('changed').toString('base64');
        if (kind === 'duplicate-path') input.files.push(input.files[0]!);
        if (kind === 'traversal') input.files.push({ path: '../outside.py', base64: '' });
        input.sha256 = kind === 'transport-hash' ? '0'.repeat(64) : hash(JSON.stringify(input.files));
        await expect(exportAppSource(directory, target, input)).rejects.toThrow();
        expect(await readdir(directory)).toEqual([]);
      } finally {
        await rm(directory, { recursive: true, force: true });
      }
    },
  );
  it('keeps the existing standard-app export layout and transport hash', async () => {
    const directory = await mkdtemp(path.join(os.tmpdir(), 'wsl-standard-export-'));
    try {
      const files = [{ path: 'package.json', base64: Buffer.from('{}').toString('base64') }];
      const result = await exportAppSource(directory, target, { files, sha256: hash(JSON.stringify(files)) });
      expect(await readFile(path.join(result.path, 'package.json'), 'utf8')).toBe('{}');
      expect(result.manifestPath).toBe(result.path + '.manifest.json');
      expect(result.sha256).toBe(hash(JSON.stringify(files)));
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
  });
});
