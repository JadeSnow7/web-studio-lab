import { createHash } from 'node:crypto';
import { utimesSync, writeFileSync } from 'node:fs';
import { link, mkdir, mkdtemp, readFile, rm, symlink, truncate, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { MOTA_REQUIRED_FILES, MOTA_SOURCE_FILE_BYTES, MOTA_SOURCE_MAX_FILES, motaSourceIdentityInput } from '@wsl/protocol';
import { collectMotaSource } from './mota-source';

const owned: string[] = [];
afterEach(async () => {
  await Promise.all(owned.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});
async function fixture() {
  const root = await mkdtemp(path.join(os.tmpdir(), 'wsl-mota-source-'));
  owned.push(root);
  for (const name of MOTA_REQUIRED_FILES) await put(root, name, name + '\n');
  return root;
}
async function put(root: string, relative: string, value: string | Buffer) {
  const filename = path.join(root, relative);
  await mkdir(path.dirname(filename), { recursive: true });
  await writeFile(filename, value);
}
const signal = () => new AbortController().signal;

describe('Main-owned static mota source capture', () => {
  it('captures binary assets above the old inline file budget without Git or source execution', async () => {
    const root = await fixture();
    const font = Buffer.alloc(8_029_000, 0xa5);
    await put(root, 'project/fonts/beeB.ttf', font);
    await put(root, 'project/images/中文.png', Buffer.from([0, 255, 1, 254]));
    for (const name of ['.env', 'project/.env.json', 'project/.git/config', '_saves/private-save', 'server.js', 'server.py'])
      await put(root, name, 'excluded fixture bytes');
    const progress: { files: number; bytes: number }[] = [];
    const captured = await collectMotaSource(root, signal(), (value) => progress.push(value));
    expect(captured.files.map((file) => file.path)).toEqual(
      [...MOTA_REQUIRED_FILES, 'project/fonts/beeB.ttf', 'project/images/中文.png'].sort(),
    );
    expect(captured.source).not.toHaveProperty('repository');
    expect(captured.source.sourceSha256).toBe(createHash('sha256').update(motaSourceIdentityInput(captured.source.files)).digest('hex'));
    for (const file of captured.files) {
      const bytes = Buffer.from(file.base64, 'base64');
      const original = await readFile(path.join(root, file.path));
      expect(bytes.length).toBe(original.length);
      expect(bytes.equals(original)).toBe(true);
      expect(captured.source.files.find((entry) => entry.path === file.path)?.sha256).toBe(
        createHash('sha256').update(original).digest('hex'),
      );
    }
    expect(progress.at(-1)).toEqual({
      files: captured.files.length,
      bytes: captured.source.files.reduce((sum, file) => sum + file.bytes, 0),
    });
    // The collector never manufactures the runtime marker in a chosen source.
    await expect(readFile(path.join(root, '.wsl-mota-copy'))).rejects.toMatchObject({ code: 'ENOENT' });
  });

  it.each(['root-link', 'file-link', 'directory-link', 'hardlink'] as const)('rejects %s', async (kind) => {
    const root = await fixture();
    let selected = root;
    if (kind === 'root-link') {
      selected = path.join(root, 'source-link');
      await symlink(root, selected);
    } else if (kind === 'file-link') await symlink(path.join(root, 'main.js'), path.join(root, 'project/linked.js'));
    else if (kind === 'directory-link') await symlink(path.join(root, 'libs'), path.join(root, 'project/linked'));
    else await link(path.join(root, 'main.js'), path.join(root, 'project/linked.js'));
    await expect(collectMotaSource(selected, signal())).rejects.toThrow(/链接/);
  });

  it('rejects an incomplete directory without invoking any project code', async () => {
    const root = await fixture();
    await rm(path.join(root, 'editor.html'));
    await expect(collectMotaSource(root, signal())).rejects.toThrow(/必需/);
  });

  it.each(['root-file', 'root-directory'] as const)('rejects an unexpected %s type', async (kind) => {
    const root = await fixture();
    if (kind === 'root-file') await mkdir(path.join(root, 'logo.png'));
    else await put(root, 'extensions', 'not a directory');
    await expect(collectMotaSource(root, signal())).rejects.toThrow(/必须是/);
  });

  it.each(['file', 'total', 'count'] as const)('rejects the %s budget from metadata before loading assets', async (budget) => {
    const root = await fixture();
    if (budget === 'count') {
      for (let index = 0; index <= MOTA_SOURCE_MAX_FILES - MOTA_REQUIRED_FILES.length; index++)
        await put(root, `project/assets/${index}.png`, 'x');
    } else {
      for (let index = 0; index < (budget === 'total' ? 6 : 1); index++) {
        const name = `project/assets/${index}.png`;
        await put(root, name, '');
        await truncate(path.join(root, name), MOTA_SOURCE_FILE_BYTES + (budget === 'file' ? 1 : 0));
      }
    }
    let progress = 0;
    await expect(collectMotaSource(root, signal(), () => progress++)).rejects.toThrow(/预算/);
    expect(progress).toBe(0);
  });

  it('honors cancellation before reading the root and while capturing assets', async () => {
    const before = new AbortController();
    before.abort();
    await expect(collectMotaSource('/unused/mota-source', before.signal)).rejects.toMatchObject({ name: 'AbortError' });
    const root = await fixture();
    const during = new AbortController();
    let calls = 0;
    await expect(
      collectMotaSource(root, during.signal, () => {
        calls++;
        during.abort();
      }),
    ).rejects.toMatchObject({ name: 'AbortError' });
    expect(calls).toBe(1);
  });

  it('rejects a same-sized file change between captures instead of returning stale bytes', async () => {
    const root = await fixture();
    const first = [...MOTA_REQUIRED_FILES].sort()[0];
    if (!first) throw new Error('fixture requires a source file');
    let changed = false;
    await expect(
      collectMotaSource(root, signal(), () => {
        if (changed) return;
        changed = true;
        writeFileSync(path.join(root, first), Buffer.alloc(Buffer.byteLength(first + '\n'), 0x78));
      }),
    ).rejects.toThrow(/变化/);
    expect(changed).toBe(true);
  });

  it('rejects new source files added after the inventory was frozen', async () => {
    const root = await fixture();
    let changed = false;
    await expect(
      collectMotaSource(root, signal(), () => {
        if (changed) return;
        changed = true;
        writeFileSync(path.join(root, 'project/added.js'), 'changed');
      }),
    ).rejects.toThrow(/变化/);
  });

  it('rejects metadata changes even when source bytes still hash identically', async () => {
    const root = await fixture();
    const first = [...MOTA_REQUIRED_FILES].sort()[0];
    if (!first) throw new Error('fixture requires a source file');
    let changed = false;
    await expect(
      collectMotaSource(root, signal(), () => {
        if (changed) return;
        changed = true;
        utimesSync(path.join(root, first), new Date(0), new Date(0));
      }),
    ).rejects.toThrow(/变化/);
  });
});
