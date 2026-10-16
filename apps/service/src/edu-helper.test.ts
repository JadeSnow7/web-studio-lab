import { createHash } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { mkdtemp, mkdir, writeFile, readFile, symlink, link, rm, stat } from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import { describe, expect, it } from 'vitest';
import { EDU_REQUIRED_FILES } from '@wsl/protocol';
import helper from './app-helper.py?raw';

const files = [...EDU_REQUIRED_FILES, 'admin/src/App.tsx'].sort().map((path) => ({ path, base64: Buffer.from(path).toString('base64') }));
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
async function fixture(create = true) {
  const root = await mkdtemp(path.join(os.tmpdir(), 'wsl-edu-helper-'));
  const execute = (operation: string, overrides: Record<string, unknown> = {}) =>
    execFileSync(
      'python3',
      [
        '-c',
        "import sys,json; from pathlib import Path; scope={'__name__':'wsl_test'}; exec(sys.argv[3],scope); scope['ROOT']=Path(sys.argv[1]); scope['run'](json.loads(sys.argv[2]))",
        root,
        JSON.stringify({ operation, workspaceId: 'edu-helper', projectId: 'edu-project', files, profile, ...overrides }),
        helper,
      ],
      { encoding: 'utf8', timeout: 3000, stdio: ['ignore', 'pipe', 'pipe'] },
    );
  if (create) execute('create');
  return { root, execute, project: path.join(root, 'edu-project') };
}

describe('guest edu profile boundaries', () => {
  it('exports only allowlisted sources after a frontend edit, retaining the baseline', async () => {
    const test = await fixture();
    try {
      for (const name of [
        '.venv/secret.py',
        'server/__pycache__/app.pyc',
        '.env',
        '.data/edu.db',
        'admin/dist/index.html',
        'admin/tsconfig.tsbuildinfo',
      ]) {
        const file = path.join(test.project, name);
        await mkdir(path.dirname(file), { recursive: true });
        await writeFile(file, 'not source');
      }
      await writeFile(path.join(test.project, 'admin/src/App.tsx'), 'a frontend edit');
      const exported = JSON.parse(test.execute('export').split('WSL_APP_RESULT:')[1]!);
      expect(exported.files.map((file: { path: string }) => file.path)).toEqual(files.map((file) => file.path));
      expect(
        Buffer.from(exported.files.find((file: { path: string }) => file.path === 'admin/src/App.tsx').base64, 'base64').toString(),
      ).toBe('a frontend edit');
      expect(JSON.parse(await readFile(path.join(test.project, '.wsl-profile.json'), 'utf8'))).toEqual(profile);
    } finally {
      await rm(test.root, { recursive: true, force: true });
    }
  });
  it.each(['symlink', 'hardlink', 'backend-edit', 'lock-edit', 'foreign-profile', 'standard-dependencies'])(
    'refuses %s without losing source',
    async (kind) => {
      const test = await fixture();
      try {
        if (kind === 'symlink') await symlink(path.join(test.project, 'server/app.py'), path.join(test.project, 'admin/src/linked.ts'));
        if (kind === 'hardlink') await link(path.join(test.project, 'server/app.py'), path.join(test.project, 'admin/src/linked.ts'));
        if (kind === 'backend-edit') await writeFile(path.join(test.project, 'server/app.py'), 'unauthorized');
        if (kind === 'lock-edit') await writeFile(path.join(test.project, 'admin/package-lock.json'), 'unauthorized');
        expect(() =>
          test.execute(
            kind === 'standard-dependencies' ? 'dependencies' : 'export',
            kind === 'foreign-profile' ? { profile: { projectKind: 'standard-app', profileVersion: 1 } } : {},
          ),
        ).toThrow();
        expect((await stat(test.project)).isDirectory()).toBe(true);
      } finally {
        await rm(test.root, { recursive: true, force: true });
      }
    },
  );
  it('validates an import digest before creating its project directory', async () => {
    const test = await fixture(false);
    try {
      expect(() =>
        test.execute('create', { profile: { ...profile, source: { ...profile.source, sourceSha256: '0'.repeat(64) } } }),
      ).toThrow();
      await expect(stat(test.project)).rejects.toMatchObject({ code: 'ENOENT' });
    } finally {
      await rm(test.root, { recursive: true, force: true });
    }
  });
});

describe('edu candidate application gate', () => {
  it.each(['allowed', 'stale', 'protected', 'symlink'])('handles %s without applying rejected candidates', async (kind) => {
    const test = await fixture();
    try {
      const candidate = files.map((file) =>
        file.path === 'admin/src/App.tsx' ? { ...file, base64: Buffer.from('edited').toString('base64') } : { ...file },
      );
      const task = {
        sourceSha256: profile.source.sourceSha256,
        protectedFiles: metadata.filter((file) => !file.path.startsWith('admin/src/')),
      };
      if (kind === 'stale') await writeFile(path.join(test.project, 'admin/src/App.tsx'), 'concurrent');
      if (kind === 'protected') candidate.find((file) => file.path === 'server/app.py')!.base64 = 'eA==';
      if (kind === 'symlink') await symlink(path.join(test.project, 'server/app.py'), path.join(test.project, 'admin/src/linked.ts'));
      if (kind === 'allowed') {
        test.execute('apply-task', { files: candidate, task });
        expect(await readFile(path.join(test.project, 'admin/src/App.tsx'), 'utf8')).toBe('edited');
      } else {
        expect(() => test.execute('apply-task', { files: candidate, task })).toThrow();
        expect(await readFile(path.join(test.project, 'admin/src/App.tsx'), 'utf8')).toBe(
          kind === 'stale' ? 'concurrent' : 'admin/src/App.tsx',
        );
      }
      expect(await readFile(path.join(test.project, 'server/app.py'), 'utf8')).toBe('server/app.py');
    } finally {
      await rm(test.root, { recursive: true, force: true });
    }
  });
});
