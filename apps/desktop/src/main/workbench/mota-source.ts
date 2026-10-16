import { createHash } from 'node:crypto';
import { constants, type Stats } from 'node:fs';
import { lstat, open, readdir, realpath } from 'node:fs/promises';
import path from 'node:path';
import {
  MOTA_REQUIRED_FILES,
  MOTA_ROOT_DIRS,
  MOTA_ROOT_FILES,
  MOTA_SOURCE_BYTES,
  MOTA_SOURCE_FILE_BYTES,
  MOTA_SOURCE_MAX_FILES,
  MotaSourceSchema,
  isMotaExcludedName,
  isMotaSourcePath,
  motaSourceIdentityInput,
  type MotaImport,
} from '@wsl/protocol';

const hash = (value: Buffer | string) => createHash('sha256').update(value).digest('hex');
const unchanged = (before: Stats, after: Stats) =>
  before.dev === after.dev &&
  before.ino === after.ino &&
  before.mode === after.mode &&
  before.nlink === after.nlink &&
  before.size === after.size &&
  before.mtimeMs === after.mtimeMs &&
  before.ctimeMs === after.ctimeMs;

/** Static capture only: no Git helpers, source scripts, writes, or guest access. */
export async function collectMotaSource(
  input: string,
  signal: AbortSignal,
  progress?: (value: { files: number; bytes: number }) => void,
): Promise<Pick<MotaImport, 'source' | 'files'>> {
  signal.throwIfAborted();
  if ((await lstat(input)).isSymbolicLink()) throw new Error('魔塔源码根目录不能是符号链接');
  const root = await realpath(input);
  const rootInfo = await lstat(root);
  if (!rootInfo.isDirectory()) throw new Error('魔塔源码根目录不是目录');

  const assertRoot = async () => {
    signal.throwIfAborted();
    if ((await realpath(input)) !== root || !unchanged(rootInfo, await lstat(root))) throw new Error('魔塔源码采集期间根目录发生变化');
  };
  const collect = async (keepBytes: boolean) => {
    await assertRoot();
    const inventory: { path: string; info: Stats }[] = [];
    const directories: { path: string; info: Stats }[] = [{ path: root, info: rootInfo }];
    let total = 0;
    let visited = 0;
    const walk = async (relative: string, optional = false): Promise<void> => {
      signal.throwIfAborted();
      if (++visited > 4096 || relative.split('/').length > 32) throw new Error('魔塔源码目录超出遍历预算');
      if (relative.split('/').some(isMotaExcludedName)) return;
      // The shared predicate validates files; only these canonical roots are also traversable directories.
      if (!MOTA_ROOT_DIRS.includes(relative) && !isMotaSourcePath(relative)) throw new Error('魔塔源码包含不支持的路径');
      const filename = path.join(root, relative);
      let info: Stats;
      try {
        info = await lstat(filename);
      } catch (error) {
        if (optional && (error as NodeJS.ErrnoException).code === 'ENOENT') return;
        throw error;
      }
      if (info.isSymbolicLink()) throw new Error('魔塔源码包含符号链接');
      if ((await realpath(filename)) !== filename) throw new Error('魔塔源码路径包含符号链接');
      if (info.isDirectory()) {
        if (MOTA_ROOT_FILES.includes(relative)) throw new Error('魔塔源码入口必须是普通文件');
        directories.push({ path: filename, info });
        for (const name of (await readdir(filename)).sort()) await walk(relative + '/' + name);
      } else {
        if (MOTA_ROOT_DIRS.includes(relative)) throw new Error('魔塔源码资源根必须是目录');
        if (!info.isFile() || info.nlink !== 1) throw new Error('魔塔源码必须是单硬链接普通文件');
        if (info.size > MOTA_SOURCE_FILE_BYTES) throw new Error('魔塔单个源码文件超出字节预算');
        total += info.size;
        if (total > MOTA_SOURCE_BYTES || inventory.length >= MOTA_SOURCE_MAX_FILES) throw new Error('魔塔源码超出传输预算');
        inventory.push({ path: relative, info });
      }
    };
    for (const name of [...MOTA_ROOT_FILES, ...MOTA_ROOT_DIRS]) await walk(name, true);
    inventory.sort((a, b) => (a.path < b.path ? -1 : a.path > b.path ? 1 : 0));
    const names = new Set(inventory.map((file) => file.path));
    if (MOTA_REQUIRED_FILES.some((name) => !names.has(name))) throw new Error('魔塔工程缺少必需源码');
    const verifyDirectories = async () => {
      await assertRoot();
      for (const directory of directories) {
        signal.throwIfAborted();
        if ((await realpath(directory.path)) !== directory.path || !unchanged(directory.info, await lstat(directory.path)))
          throw new Error('魔塔源码采集期间目录发生变化');
      }
    };
    await verifyDirectories();

    const files: MotaImport['files'] = [];
    const metadata: MotaImport['source']['files'] = [];
    let captured = 0;
    for (const file of inventory) {
      signal.throwIfAborted();
      const filename = path.join(root, file.path);
      if ((await realpath(filename)) !== filename) throw new Error('魔塔源码路径包含符号链接');
      const handle = await open(filename, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
      try {
        const opened = await handle.stat();
        if (!opened.isFile() || opened.nlink !== 1 || !unchanged(file.info, opened)) throw new Error('魔塔源码采集期间文件发生变化');
        const bytes = Buffer.alloc(file.info.size);
        let offset = 0;
        while (offset < bytes.length) {
          signal.throwIfAborted();
          const read = await handle.read(bytes, offset, Math.min(65536, bytes.length - offset), offset);
          if (!read.bytesRead) throw new Error('魔塔源码采集期间文件发生变化');
          offset += read.bytesRead;
        }
        if (
          !unchanged(file.info, await handle.stat()) ||
          !unchanged(file.info, await lstat(filename)) ||
          (await realpath(filename)) !== filename
        )
          throw new Error('魔塔源码采集期间文件发生变化');
        metadata.push({ path: file.path, sha256: hash(bytes), bytes: bytes.length });
        if (keepBytes) files.push({ path: file.path, base64: bytes.toString('base64') });
        captured += bytes.length;
        if (keepBytes) progress?.({ files: metadata.length, bytes: captured });
      } finally {
        await handle.close();
      }
    }
    await verifyDirectories();
    for (const file of inventory) {
      signal.throwIfAborted();
      const filename = path.join(root, file.path);
      if ((await realpath(filename)) !== filename || !unchanged(file.info, await lstat(filename)))
        throw new Error('魔塔源码采集期间文件发生变化');
    }
    return { files, metadata, inventory, directories };
  };

  const captured = await collect(true);
  const repeated = await collect(false);
  signal.throwIfAborted();
  const identity = motaSourceIdentityInput(captured.metadata);
  const sameEntries = (before: { path: string; info: Stats }[], after: { path: string; info: Stats }[]) =>
    before.length === after.length &&
    before.every((entry, index) => {
      const next = after[index];
      return next !== undefined && entry.path === next.path && unchanged(entry.info, next.info);
    });
  if (
    identity !== motaSourceIdentityInput(repeated.metadata) ||
    !sameEntries(captured.inventory, repeated.inventory) ||
    !sameEntries(captured.directories, repeated.directories)
  )
    throw new Error('魔塔源码采集期间内容发生变化，请重试');
  return {
    files: captured.files,
    source: MotaSourceSchema.parse({ sourceSha256: hash(identity), files: captured.metadata }),
  };
}
