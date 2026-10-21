import { createHash, randomUUID } from 'node:crypto';
import { mkdtemp, readFile, readdir, stat, rm } from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import { describe, expect, it } from 'vitest';
import { AppProfileSchema, EDU_REQUIRED_FILES, type AppSource } from '@wsl/protocol';
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
  it.each([
    'transport-hash',
    'baseline-hash',
    'secret-path',
    'missing-required',
    'protected-backend',
    'protected-add',
    'protected-delete',
    'case-alias',
    'unicode-alias',
    'duplicate-path',
    'traversal',
  ])('refuses %s before creating output', async (kind) => {
    const directory = await mkdtemp(path.join(os.tmpdir(), 'wsl-edu-export-'));
    try {
      const input = source();
      if (kind === 'baseline-hash' && input.profile?.projectKind === 'edu-web') input.profile.source.sourceSha256 = '0'.repeat(64);
      if (kind === 'secret-path') input.files.push({ path: 'server/.env.py', base64: '' });
      if (kind === 'missing-required') input.files.shift();
      if (kind === 'protected-backend')
        input.files.find((file) => file.path === 'server/app.py')!.base64 = Buffer.from('changed').toString('base64');
      if (kind === 'protected-add') input.files.push({ path: 'server/extra.py', base64: '' });
      if (kind === 'protected-delete') {
        const protectedFile = { path: 'server/extra.py', sha256: hash(''), bytes: 0 };
        if (input.profile?.projectKind === 'edu-web') {
          input.profile.source.files.push(protectedFile);
          input.profile.source.files.sort((a, b) => (a.path < b.path ? -1 : 1));
          input.profile.source.sourceSha256 = hash(JSON.stringify(input.profile.source.files));
        }
      }
      if (kind === 'case-alias') input.files.push({ path: 'admin/src/app.tsx', base64: '' });
      if (kind === 'unicode-alias') input.files.push({ path: 'admin/src/é.ts', base64: '' }, { path: 'admin/src/é.ts', base64: '' });
      if (kind === 'duplicate-path') input.files.push(input.files[0]!);
      if (kind === 'traversal') input.files.push({ path: '../outside.py', base64: '' });
      input.sha256 = kind === 'transport-hash' ? '0'.repeat(64) : hash(JSON.stringify(input.files));
      await expect(exportAppSource(directory, target, input)).rejects.toThrow();
      expect(await readdir(directory)).toEqual([]);
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
  });
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

describe('R5 Main export contract before publication', () => {
  function boundary(kind: 'standard-app' | 'edu-web'): AppSource {
    const names = kind === 'edu-web' ? [...EDU_REQUIRED_FILES] : [];
    while (names.length < 256) names.push(`admin/src/中文-${names.length}.ts`);
    const files = names.sort().map((path) => ({ path, base64: '' }));
    const editable = files.filter((file) => file.path.startsWith('admin/src/'));
    editable[0]!.base64 = Buffer.concat([Buffer.from('中文🙂'), Buffer.alloc(262134, 97)]).toString('base64');
    editable[1]!.base64 = Buffer.alloc(262144, 98).toString('base64');
    const metadata = files.map((file) => {
      const bytes = Buffer.from(file.base64, 'base64');
      return { path: file.path, sha256: hash(bytes), bytes: bytes.length };
    });
    return {
      files,
      sha256: hash(JSON.stringify(files)),
      profile:
        kind === 'standard-app'
          ? { projectKind: 'standard-app', profileVersion: 1 }
          : {
              projectKind: 'edu-web',
              profileVersion: 1,
              source: {
                repository: { commit: 'a'.repeat(40), dirty: false },
                files: metadata,
                sourceSha256: hash(JSON.stringify(metadata)),
              },
            },
    };
  }

  async function inventory(root: string, relative = ''): Promise<{ path: string; sha256: string | null }[]> {
    const entries = [];
    for (const item of await readdir(path.join(root, relative), { withFileTypes: true })) {
      const name = path.join(relative, item.name);
      entries.push({ path: name, sha256: item.isDirectory() ? null : hash(await readFile(path.join(root, name))) });
      if (item.isDirectory()) entries.push(...(await inventory(root, name)));
    }
    return entries.sort((a, b) => (a.path < b.path ? -1 : a.path > b.path ? 1 : 0));
  }

  for (const kind of ['standard-app', 'edu-web'] as const) {
    it(`R5 ${kind} publishes all 256 files and 524288 decoded bytes with the original hash contract`, async () => {
      const directory = await mkdtemp(path.join(os.tmpdir(), 'wsl-r5-export-'));
      try {
        const input = boundary(kind);
        const original = JSON.stringify(input);
        const result = await exportAppSource(directory, target, input);
        const manifest = JSON.parse(await readFile(result.manifestPath, 'utf8'));
        expect(input.files).toHaveLength(256);
        expect(input.files.reduce((sum, file) => sum + Buffer.from(file.base64, 'base64').length, 0)).toBe(524288);
        for (const file of input.files)
          expect(await readFile(path.join(result.path, file.path))).toEqual(Buffer.from(file.base64, 'base64'));
        if (input.profile?.projectKind === 'edu-web') {
          expect(path.basename(result.path)).toBe('source');
          expect(manifest.workbench.importBase).toEqual(input.profile.source);
          expect(manifest.files).toEqual(input.profile.source.files);
          expect(manifest.sourceSha256).toBe(hash(JSON.stringify(manifest.files)));
          expect(result.sha256).toBe(manifest.sourceSha256);
          expect(result.manifestPath).toBe(path.join(path.dirname(result.path), 'manifest.json'));
        } else {
          expect(result.manifestPath).toBe(result.path + '.manifest.json');
          expect(result.sha256).toBe(hash(JSON.stringify(input.files)));
          expect(manifest.files).toEqual(input.files);
          expect(manifest.sha256).toBe(result.sha256);
        }
        expect(JSON.stringify(input)).toBe(original);
      } finally {
        await rm(directory, { recursive: true, force: true });
      }
    });

    it.each(['file-count', 'decoded-bytes'])(
      `R5 ${kind} rejects %s before creating a parent or changing prior exports`,
      async (failure) => {
        const directory = await mkdtemp(path.join(os.tmpdir(), 'wsl-r5-export-reject-'));
        try {
          const previous = await exportAppSource(directory, target, source());
          const before = await inventory(directory);
          const input = boundary(kind);
          if (failure === 'file-count') input.files.push({ path: 'admin/src/extra.ts', base64: '' });
          else {
            const mutable = input.files.find((file) => file.path.startsWith('admin/src/'))!;
            mutable.base64 = Buffer.concat([Buffer.from(mutable.base64, 'base64'), Buffer.from('x')]).toString('base64');
          }
          input.sha256 = hash(JSON.stringify(input.files));
          expect(AppProfileSchema.safeParse(input.profile).success).toBe(true);
          expect(input.sha256).toBe(hash(JSON.stringify(input.files)));
          const original = JSON.stringify(input);
          const reason = failure === 'file-count' ? /256|budget|预算/i : /524288|budget|预算/i;
          const absentParent = path.join(directory, 'not-created');
          await expect(exportAppSource(absentParent, target, input)).rejects.toThrow(reason);
          await expect(stat(absentParent)).rejects.toMatchObject({ code: 'ENOENT' });
          await expect(exportAppSource(directory, target, input)).rejects.toThrow(reason);
          expect(await inventory(directory)).toEqual(before);
          expect(JSON.stringify(input)).toBe(original);
          expect(await readFile(path.join(previous.path, 'server/app.py'), 'utf8')).toBe('server/app.py');
        } finally {
          await rm(directory, { recursive: true, force: true });
        }
      },
    );
  }
});
