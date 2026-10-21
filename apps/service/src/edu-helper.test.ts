import { createHash } from 'node:crypto';
import { execFileSync, spawnSync } from 'node:child_process';
import { mkdtemp, mkdir, writeFile, readFile, symlink, link, rm, stat } from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import { describe, expect, it } from 'vitest';
import { EDU_REQUIRED_FILES } from '@wsl/protocol';
import { z } from 'zod';
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
async function fixture(create = true, kind: 'standard-app' | 'edu-web' = 'edu-web') {
  const root = await mkdtemp(path.join(os.tmpdir(), 'wsl-edu-helper-'));
  const initialFiles = kind === 'edu-web' ? files : [{ path: 'package.json', base64: Buffer.from('{}').toString('base64') }];
  const initialProfile = kind === 'edu-web' ? profile : { projectKind: 'standard-app', profileVersion: 1 };
  const args = (operation: string, overrides: Record<string, unknown> = {}) => [
    '-c',
    "import sys,json; from pathlib import Path; scope={'__name__':'wsl_test'}; exec(sys.argv[3],scope); scope['ROOT']=Path(sys.argv[1]); scope['run'](json.loads(sys.argv[2]))",
    root,
    JSON.stringify({
      operation,
      workspaceId: 'edu-helper',
      projectId: 'edu-project',
      files: initialFiles,
      profile: initialProfile,
      ...(operation === 'export' ? { exportBudget: { maxFiles: 256, maxSourceBytes: 524288 } } : {}),
      ...overrides,
    }),
    helper,
  ];
  const execute = (operation: string, overrides: Record<string, unknown> = {}) =>
    execFileSync('python3', args(operation, overrides), { encoding: 'utf8', timeout: 3000, stdio: ['ignore', 'pipe', 'pipe'] });
  try {
    if (create) execute('create');
  } catch (error) {
    await rm(root, { recursive: true, force: true });
    throw error;
  }
  const observe = (overrides: Record<string, unknown> = {}) => {
    const result = spawnSync('python3', args('export', overrides), {
      encoding: 'utf8',
      timeout: 3000,
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    if (result.error) throw result.error;
    const receipts = result.stdout.split('\n').filter((line) => line.startsWith('WSL_APP_RESULT:'));
    const exported = receipts.map((line) =>
      z
        .object({ files: z.array(z.object({ path: z.string(), base64: z.string() })) })
        .parse(JSON.parse(line.slice('WSL_APP_RESULT:'.length))),
    );
    console.info(
      'R5 actual helper trace',
      JSON.stringify({
        kind,
        requestBytes: Buffer.byteLength(args('export', overrides)[3]!),
        status: result.status,
        successfulReceipts: receipts.length,
        stdoutBytes: Buffer.byteLength(result.stdout),
        stdoutSha256: createHash('sha256').update(result.stdout).digest('hex'),
        stderr: result.stderr,
        decodedSourceBytes: exported.map((receipt) =>
          receipt.files.reduce((sum, file) => sum + Buffer.from(file.base64, 'base64').length, 0),
        ),
        fileCounts: exported.map((receipt) => receipt.files.length),
      }),
    );
    return { ...result, exported };
  };
  return { root, execute, observe, initialFiles, project: path.join(root, 'edu-project') };
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

describe('R5 actual local helper export contract', () => {
  function refused(result: ReturnType<Awaited<ReturnType<typeof fixture>>['observe']>) {
    expect(result.exported.length).toBe(0);
    expect(result.status).not.toBe(0);
    expect(result.stderr).toMatch(/budget|exceed|count|limit|profile/i);
  }

  it('R5 refuses a standard project grown after valid creation to 524289 decoded bytes', async () => {
    const test = await fixture(true, 'standard-app');
    try {
      expect(test.observe().exported[0]?.files).toEqual(test.initialFiles);
      const content = Buffer.concat([Buffer.from('{}'), Buffer.alloc(524287, 32)]);
      await writeFile(path.join(test.project, 'package.json'), content);
      expect((await stat(path.join(test.project, 'package.json'))).size).toBe(524289);
      // Old helper returns a complete successful receipt here (below its shared 8 MiB limit).
      refused(test.observe());
      expect(await readFile(path.join(test.project, 'package.json'))).toEqual(content);
    } finally {
      await rm(test.root, { recursive: true, force: true });
    }
  });

  for (const kind of ['standard-app', 'edu-web'] as const) {
    it(`R5 ${kind} actual helper counts required and empty files at 255/256/257`, async () => {
      const test = await fixture(true, kind);
      try {
        for (let index = test.initialFiles.length; index < 257; index++) {
          const relative = `admin/src/中文-${index}.ts`;
          await mkdir(path.dirname(path.join(test.project, relative)), { recursive: true });
          await writeFile(path.join(test.project, relative), '');
          const count = index + 1;
          if (count < 255) continue;
          const result = test.observe();
          if (count === 257) refused(result);
          else {
            expect(result.status).toBe(0);
            expect(result.exported).toHaveLength(1);
            expect(result.exported[0]?.files).toHaveLength(count);
          }
        }
      } finally {
        await rm(test.root, { recursive: true, force: true });
      }
    });

    for (const shape of ['single', 'aggregate'] as const) {
      it.each([524287, 524288, 524289])(`R5 ${kind} actual helper measures ${shape} UTF-8 bytes at %i`, async (total) => {
        const test = await fixture(true, kind);
        try {
          const mutable = kind === 'edu-web' ? 'admin/src/App.tsx' : 'package.json';
          const fixed = test.initialFiles
            .filter((file) => file.path !== mutable)
            .reduce((sum, file) => sum + Buffer.from(file.base64, 'base64').length, 0);
          const second = path.join(test.project, 'admin/src/中文🙂.ts');
          await mkdir(path.dirname(second), { recursive: true });
          const aggregate = shape === 'aggregate';
          const prefix = Buffer.from('中文🙂');
          const content = Buffer.concat([prefix, Buffer.alloc(total - fixed - prefix.length, 97)]);
          const split = aggregate ? Math.floor(content.length / 2) : content.length;
          await writeFile(path.join(test.project, mutable), content.subarray(0, split));
          if (aggregate) await writeFile(second, content.subarray(split));
          const result = test.observe();
          if (total === 524289) refused(result);
          else {
            expect(result.status).toBe(0);
            expect(result.exported).toHaveLength(1);
            const exported = result.exported[0]!.files;
            expect(exported.reduce((sum, file) => sum + Buffer.from(file.base64, 'base64').length, 0)).toBe(total);
            expect(Buffer.from(exported.find((file) => file.path === mutable)!.base64, 'base64')).toEqual(content.subarray(0, split));
            if (aggregate)
              expect(Buffer.from(exported.find((file) => file.path === 'admin/src/中文🙂.ts')!.base64, 'base64')).toEqual(
                content.subarray(split),
              );
          }
        } finally {
          await rm(test.root, { recursive: true, force: true });
        }
      });
    }

    it(`R5 ${kind} actual helper rejects missing malformed forged or enlarged private export budgets`, async () => {
      const test = await fixture(true, kind);
      try {
        expect(test.observe().status).toBe(0);
        for (const exportBudget of [
          undefined,
          null,
          '524288',
          {},
          { maxFiles: true, maxSourceBytes: 524288 },
          { maxFiles: 256, maxSourceBytes: '524288' },
          { maxFiles: 257, maxSourceBytes: 524288 },
          { maxFiles: 256, maxSourceBytes: 8388608 },
          { maxFiles: 255, maxSourceBytes: 524288 },
          { maxFiles: 256, maxSourceBytes: 524288, projectKind: 'standard-app' },
        ]) {
          refused(test.observe({ exportBudget }));
        }
        expect(test.observe().exported[0]?.files).toEqual(test.initialFiles);
        for (const file of test.initialFiles)
          expect(await readFile(path.join(test.project, file.path))).toEqual(Buffer.from(file.base64, 'base64'));
      } finally {
        await rm(test.root, { recursive: true, force: true });
      }
    });
  }
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
