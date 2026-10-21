import { mkdtemp, mkdir, writeFile, rename, rm, readFile, realpath } from 'node:fs/promises';
import type { FileHandle } from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { EDU_REQUIRED_FILES } from '@wsl/protocol';
import { collectEduSource } from './edu-source';

const hooks = vi.hoisted(() => ({ afterOpen: null as null | ((name: string, handle: FileHandle) => Promise<void>) }));
vi.mock('node:fs/promises', async (original) => {
  const actual = await original<typeof import('node:fs/promises')>();
  return {
    ...actual,
    open: async (...args: Parameters<typeof actual.open>) => {
      const handle = await actual.open(...args);
      await hooks.afterOpen?.(String(args[0]), handle);
      return handle;
    },
  };
});
afterEach(() => {
  hooks.afterOpen = null;
});
async function fixture() {
  const root = await realpath(await mkdtemp(path.join(os.tmpdir(), 'wsl-edu-race-')));
  for (const name of EDU_REQUIRED_FILES) {
    await mkdir(path.dirname(path.join(root, name)), { recursive: true });
    await writeFile(path.join(root, name), name);
  }
  return root;
}
const identity = async () => ({ commit: 'a'.repeat(40), dirty: false });
describe('edu collector concurrent filesystem boundaries', () => {
  it('rejects a pathname replaced after opening its inode and closes the owned descriptor', async () => {
    const root = await fixture();
    let close: ReturnType<typeof vi.spyOn> | undefined;
    const file = path.join(root, 'admin/package.json');
    try {
      hooks.afterOpen = async (name, handle) => {
        if (name !== file || close) return;
        close = vi.spyOn(handle, 'close');
        await rename(file, file + '.old');
        await writeFile(file, 'replacement');
      };
      await expect(collectEduSource(root, new AbortController().signal, identity)).rejects.toThrow(/变化/);
      expect(close).toHaveBeenCalledOnce();
      expect(await readFile(file, 'utf8')).toBe('replacement');
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });
  it('aborts after opening a file without releasing bytes and closes the descriptor', async () => {
    const root = await fixture();
    const controller = new AbortController();
    let close: ReturnType<typeof vi.spyOn> | undefined;
    try {
      hooks.afterOpen = async (_name, handle) => {
        close = vi.spyOn(handle, 'close');
        controller.abort(new Error('bounded cancellation'));
      };
      await expect(collectEduSource(root, controller.signal, identity)).rejects.toThrow('bounded cancellation');
      expect(close).toHaveBeenCalledOnce();
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });
  it('rejects a directory traversal budget overflow without collecting undeclared entries', async () => {
    const root = await fixture();
    try {
      await mkdir(path.join(root, 'admin/oversized'));
      // Entries are streamed, including unsupported extensions; the budget is not an allowlist-only count.
      for (let index = 0; index < 4100; index++) await writeFile(path.join(root, 'admin/oversized', `${index}.bin`), '');
      await expect(collectEduSource(root, new AbortController().signal, identity)).rejects.toThrow(/遍历预算/);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });
});
