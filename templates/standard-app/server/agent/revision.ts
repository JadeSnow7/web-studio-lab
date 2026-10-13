import { createHash } from 'node:crypto';
import { lstat, readdir, readFile, readlink } from 'node:fs/promises';
import { join } from 'node:path';

/**
 * 源码修订：对项目输入文件按相对路径排序后的 sha256(JSON[[path, sha256]...])。
 * 生成物（agent/、dist）、依赖、数据目录、日志与工作台内部文件不参与；符号链接按链接文本计入，不跟随。
 */
const EXCLUDED_ANYWHERE = new Set(['node_modules', 'dist', '.data', '.test-data', '.git', '.vite', 'coverage']);
const EXCLUDED_TOP = new Set(['agent', 'template-manifest.json']);

export async function sourceFiles(root: string): Promise<Map<string, string>> {
  const files = new Map<string, string>();
  const walk = async (directory: string, prefix: string) => {
    for (const entry of (await readdir(directory, { withFileTypes: true })).sort((a, b) => (a.name < b.name ? -1 : 1))) {
      const relative = prefix + entry.name;
      if (EXCLUDED_ANYWHERE.has(entry.name) || entry.name.startsWith('.wsl-') || entry.name.endsWith('.log')) continue;
      if (!prefix && EXCLUDED_TOP.has(entry.name)) continue;
      const location = join(directory, entry.name);
      const stat = await lstat(location);
      if (stat.isSymbolicLink()) files.set(relative, sha256(`symlink:${await readlink(location)}`));
      else if (stat.isDirectory()) await walk(location, relative + '/');
      else if (stat.isFile()) files.set(relative, sha256(await readFile(location)));
    }
  };
  await walk(root, '');
  return files;
}

export async function computeSourceRevision(root: string): Promise<string> {
  return revisionOf(await sourceFiles(root));
}

export function revisionOf(files: Map<string, string>): string {
  return sha256(JSON.stringify([...files.entries()].sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))));
}

export function sha256(value: string | Buffer): string {
  return createHash('sha256').update(value).digest('hex');
}
