import { createHash } from 'node:crypto';
import { lstat, mkdir, mkdtemp, readFile, readdir, realpath, rm, stat, symlink, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { describe, expect, it, vi } from 'vitest';
import { WorkbenchHost } from './host';

const runtime = vi.hoisted(() => ({ userData: '' }));
vi.mock('electron', () => ({ app: { getPath: () => runtime.userData }, session: {}, protocol: {}, WebContentsView: class {} }));
const target = { workspaceId: 'source-export-test', projectId: '1e09976d-3f28-4f32-b448-19bb5ae196f0' };
const entry = (name: string, bytes: Buffer | string = 'source') => ({ path: name, base64: Buffer.from(bytes).toString('base64') });
const source = (files: ReturnType<typeof entry>[]) => ({ files, sha256: createHash('sha256').update(JSON.stringify(files)).digest('hex') });
// Invoke the real production host method, including its actual export adapter wiring; no window is constructed.
const exportSource = (input: unknown, suppliedTarget: unknown = target) =>
  Reflect.apply(WorkbenchHost.prototype.appExport, { chat: { appExport: async () => input } }, [suppliedTarget]) as ReturnType<
    WorkbenchHost['appExport']
  >;
async function fixture(run: (root: string) => Promise<void>) {
  const root = await mkdtemp(path.join(os.tmpdir(), 'wsl-source-export-'));
  runtime.userData = path.join(root, 'absent', 'user-data');
  try {
    await run(root);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
  await expect(lstat(root)).rejects.toMatchObject({ code: 'ENOENT' });
}
const invalid = [
  ['late traversal', source([entry('valid'), entry('../escape')])],
  ['late absolute', source([entry('valid'), entry('/escape')])],
  ['late backslash', source([entry('valid'), entry('dir\\escape')])],
  ['late overlong component', source([entry('valid'), entry('x'.repeat(256))])],
  ['late invalid Unicode', source([entry('valid'), entry('bad\ud800')])],
  ['late control', source([entry('valid'), entry('bad\u0001name')])],
  ['duplicate', source([entry('same'), entry('same')])],
  ['file then descendant', source([entry('dir'), entry('dir/child')])],
  ['descendant then file', source([entry('dir/child'), entry('dir')])],
  ['case leaf alias', source([entry('README.md'), entry('readme.MD')])],
  ['NFC leaf alias', source([entry('é.txt'), entry('e\u0301.txt')])],
  ['case parent alias', source([entry('Folder/first'), entry('folder/second')])],
  ['NFC parent alias', source([entry('é/first'), entry('e\u0301/second')])],
  ['wrong hash', { ...source([entry('valid')]), sha256: '0'.repeat(64) }],
  ['late malformed base64', source([entry('valid'), { path: 'later', base64: 'Zg==!' }])],
  ['late oversized bytes', source([entry('valid', Buffer.alloc(262144)), entry('later', Buffer.alloc(262145))])],
  ['late overlong encoding', source([entry('valid'), { path: 'later', base64: 'A'.repeat(5592408) + '!' }])],
  ['257 files', source(Array.from({ length: 257 }, (_, i) => entry(String(i), '')))],
  ['empty result', source([])],
  ['extra profile', { ...source([entry('valid')]), profile: { projectKind: 'standard-app' } }],
] as const;

describe('standard app host export filesystem contract', () => {
  it.skipIf(process.platform !== 'darwin').each([false, true])(
    'rejects a late full path over macOS PATH_MAX before writes (existing export: %s)',
    async (existing) =>
      fixture(async (root) => {
        const initial = existing ? await exportSource(source([entry('original', 'original')])) : null;
        const before = initial ? (await readdir(path.dirname(initial.path))).sort() : [];
        const manifest = initial ? await readFile(initial.manifestPath) : null;
        const relative = Array(4).fill('中'.repeat(80)).join('/');
        expect(relative.length).toBe(323);
        expect(Buffer.byteLength(relative)).toBe(963);
        await expect(exportSource(source([entry('valid'), entry(relative)]))).rejects.toThrow();
        if (initial) {
          expect((await readdir(path.dirname(initial.path))).sort()).toEqual(before);
          expect(await readFile(initial.manifestPath)).toEqual(manifest);
          expect(await readFile(path.join(initial.path, 'original'), 'utf8')).toBe('original');
        } else expect(await readdir(root)).toEqual([]);
      }),
  );
  it.skipIf(process.platform !== 'darwin')(
    'includes the manifest suffix in preflight even when the directory and short file fit',
    async () =>
      fixture(async (root) => {
        const resolved = await realpath(root);
        // The output directory and short file fit; its sibling manifest exceeds the observed 1024-byte macOS limit.
        const desiredUserDataBytes = 1015 - Buffer.byteLength('/exports/' + target.projectId + '-' + '0'.repeat(36));
        let directory = resolved;
        while (Buffer.byteLength(directory) < desiredUserDataBytes) {
          const remaining = desiredUserDataBytes - Buffer.byteLength(directory) - 1;
          directory += '/' + 'x'.repeat(Math.min(remaining, 200));
        }
        runtime.userData = directory;
        const basename = target.projectId + '-' + '0'.repeat(36);
        expect(Buffer.byteLength(path.join(directory, 'exports', basename, 'a'))).toBeLessThan(1024);
        expect(Buffer.byteLength(path.join(directory, 'exports', basename) + '.manifest.json')).toBeGreaterThanOrEqual(1024);
        await expect(exportSource(source([entry('a', '')]))).rejects.toThrow();
        expect(await readdir(root)).toEqual([]);
      }),
  );
  it.skipIf(process.platform !== 'darwin')('checks the resolved pathname of a short parent alias before writes', async () =>
    fixture(async (root) => {
      const canonical = path.join(await realpath(root), 'x'.repeat(200), 'y'.repeat(200));
      await mkdir(canonical, { recursive: true });
      const alias = path.join(root, 'alias');
      await symlink(canonical, alias);
      runtime.userData = path.join(alias, 'missing');
      const relative = Array(3).fill('中'.repeat(60)).join('/');
      const basename = target.projectId + '-' + '0'.repeat(36);
      expect(Buffer.byteLength(path.join(runtime.userData, 'exports', basename, relative))).toBeLessThan(1024);
      expect(Buffer.byteLength(path.join(canonical, 'missing', 'exports', basename, relative))).toBeGreaterThanOrEqual(1024);
      await expect(exportSource(source([entry('valid'), entry(relative)]))).rejects.toThrow();
      expect(await readdir(canonical)).toEqual([]);
    }),
  );
  it.skipIf(process.platform !== 'darwin').each([1023, 1024])(
    'uses the macOS pathname boundary including NUL at %i bytes',
    async (length) =>
      fixture(async (root) => {
        const resolved = await realpath(root);
        const desiredUserDataBytes = 800 - Buffer.byteLength('/exports/' + target.projectId + '-' + '0'.repeat(36));
        let directory = resolved;
        while (Buffer.byteLength(directory) < desiredUserDataBytes) {
          directory += '/' + 'x'.repeat(Math.min(desiredUserDataBytes - Buffer.byteLength(directory) - 1, 200));
        }
        runtime.userData = root + directory.slice(resolved.length);
        const relative = 'a'.repeat(length - 801);
        const input = source([entry(relative, 'exact bytes')]);
        if (length === 1024) {
          await expect(exportSource(input)).rejects.toThrow();
          expect(await readdir(root)).toEqual([]);
        } else {
          const exported = await exportSource(input);
          const destination = path.join(exported.path, relative);
          expect(Buffer.byteLength(destination)).toBe(1023);
          expect(await readFile(destination, 'utf8')).toBe('exact bytes');
        }
      }),
  );
  it.each(invalid)('rejects %s before creating even an absent parent', async (_label, input) =>
    fixture(async (root) => {
      await expect(exportSource(input)).rejects.toThrow();
      expect(await readdir(root)).toEqual([]);
    }),
  );
  it.each(invalid)('rejects %s without changing an existing export', async (_label, input) =>
    fixture(async () => {
      const valid = source([entry('original', 'original bytes')]);
      const first = await exportSource(valid);
      const manifest = await readFile(first.manifestPath);
      const directory = path.dirname(first.path);
      const before = (await readdir(directory)).sort();
      await expect(exportSource(input)).rejects.toThrow();
      expect((await readdir(directory)).sort()).toEqual(before);
      expect(await readFile(first.manifestPath)).toEqual(manifest);
      expect(await readFile(path.join(first.path, 'original'), 'utf8')).toBe('original bytes');
    }),
  );
  it.each([
    { ...target, projectId: '../escape' },
    { ...target, profile: 'extra' },
    { ...target, workspaceId: '' },
  ])('validates target before filesystem writes %j', async (invalidTarget) =>
    fixture(async (root) => {
      await expect(exportSource(source([entry('a')]), invalidTarget)).rejects.toThrow();
      expect(await readdir(root)).toEqual([]);
    }),
  );
  it.each([524287, 524288])('preserves %i actual bytes, original paths, hash, manifest and private modes', async (size) =>
    fixture(async () => {
      const contents = Buffer.alloc(size, 97);
      const input = source([entry('子目录/中文.txt', contents), entry('empty', '')]);
      const result = await exportSource(input);
      expect(path.basename(result.path)).toMatch(new RegExp('^' + target.projectId + '-'));
      expect(result.manifestPath).toBe(result.path + '.manifest.json');
      expect(result.sha256).toBe(input.sha256);
      expect((await readFile(path.join(result.path, '子目录/中文.txt'))).equals(contents)).toBe(true);
      expect(await readFile(path.join(result.path, 'empty'))).toHaveLength(0);
      expect(JSON.parse(await readFile(result.manifestPath, 'utf8'))).toEqual({ ...target, ...input });
      for (const directory of [path.dirname(result.path), result.path, path.join(result.path, '子目录')])
        expect((await stat(directory)).mode & 0o777).toBe(0o700);
      for (const file of [result.manifestPath, path.join(result.path, '子目录/中文.txt'), path.join(result.path, 'empty')])
        expect((await stat(file)).mode & 0o777).toBe(0o600);
    }),
  );
  it('exports the exact aggregate decoded budget with shared, consistently spelled parent directories', async () =>
    fixture(async () => {
      const input = source([entry('directory/first', Buffer.alloc(262144, 97)), entry('directory/second', Buffer.alloc(262144, 98))]);
      const result = await exportSource(input);
      expect((await readFile(path.join(result.path, 'directory/first'))).equals(Buffer.alloc(262144, 97))).toBe(true);
      expect((await readFile(path.join(result.path, 'directory/second'))).equals(Buffer.alloc(262144, 98))).toBe(true);
    }));
  it.each([255, 256])('exports %i distinct empty files', async (count) =>
    fixture(async () => {
      const result = await exportSource(source(Array.from({ length: count }, (_, i) => entry(String(i), ''))));
      expect(await readdir(result.path)).toHaveLength(count);
    }),
  );
  it('rejects a symlink destination root without modifying its target', async () =>
    fixture(async (root) => {
      const elsewhere = path.join(root, 'elsewhere');
      await mkdir(elsewhere);
      await mkdir(runtime.userData, { recursive: true });
      await symlink(elsewhere, path.join(runtime.userData, 'exports'));
      await expect(exportSource(source([entry('a')]))).rejects.toThrow();
      expect(await readdir(elsewhere)).toEqual([]);
    }));
  it('records actual fixture volume case and Unicode aliases before rejecting them', async () =>
    fixture(async (root) => {
      const fixtures = path.join(root, 'volume-probe');
      await mkdir(fixtures);
      for (const [first, alias] of [
        ['README.md', 'readme.MD'],
        ['é.txt', 'e\u0301.txt'],
      ]) {
        if (!first || !alias) throw new Error('missing fixture');
        await writeFile(path.join(fixtures, first), first, { flag: 'wx' });
        const initial = await stat(path.join(fixtures, first));
        const alternate = await stat(path.join(fixtures, alias)).catch((error: NodeJS.ErrnoException) => {
          if (error.code !== 'ENOENT') throw error;
          return null;
        });
        console.info(
          JSON.stringify({
            fixture: 'source-export-volume',
            platform: process.platform,
            first,
            alias,
            sameInode: alternate?.ino === initial.ino && alternate?.dev === initial.dev,
          }),
        );
        await expect(exportSource(source([entry(first), entry(alias)]))).rejects.toThrow();
      }
      await expect(lstat(runtime.userData)).rejects.toMatchObject({ code: 'ENOENT' });
    }));
});
