import { createHash, randomUUID } from 'node:crypto';
import { lstat, mkdir, realpath, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { AppSourceSchema, AppTargetSchema, type AppSource, type AppTarget } from '@wsl/protocol';

/** Standard-app export: validate the complete input before creating any output. */
export async function exportAppSource(directory: string, target: AppTarget, supplied: AppSource) {
  const identity = AppTargetSchema.parse(target);
  const source = AppSourceSchema.parse(supplied);
  if (createHash('sha256').update(JSON.stringify(source.files)).digest('hex') !== source.sha256) throw new Error('源码导出散列不匹配');
  const paths = new Map<string, { spelling: string; file: boolean }>();
  const decoded = source.files.map((file) => {
    const parts = file.path.split('/');
    if (
      file.path.includes('\\') ||
      [...file.path].some((char) => char.charCodeAt(0) < 32 || char.charCodeAt(0) === 127) ||
      Buffer.from(file.path).toString('utf8') !== file.path ||
      parts.some((part) => !part || part === '.' || part === '..' || Buffer.byteLength(part, 'utf8') > 255)
    )
      throw new Error('源码导出路径无效');
    for (let length = 1; length <= parts.length; length++) {
      const spelling = parts.slice(0, length).join('/');
      // Conservative portable collision key, not a complete filesystem collation model.
      const key = spelling.normalize('NFC').toLowerCase();
      const isFile = length === parts.length;
      const previous = paths.get(key);
      if (previous && (previous.spelling !== spelling || previous.file || isFile))
        throw new Error('源码导出路径重复、别名或文件与目录冲突');
      paths.set(key, { spelling, file: isFile });
    }
    return { path: file.path, bytes: Buffer.from(file.base64, 'base64') };
  });
  // Resolve an existing ancestor without creating missing directories. Textual aliases
  // such as /var can expand, so pathname limits apply to the actual destination.
  let resolvedDirectory = path.resolve(directory);
  const missing: string[] = [];
  while (true) {
    try {
      const info = await lstat(resolvedDirectory);
      if (missing.length === 0 && info.isSymbolicLink()) throw new Error('导出目录不能是符号链接');
      resolvedDirectory = path.join(await realpath(resolvedDirectory), ...missing);
      break;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
      const parent = path.dirname(resolvedDirectory);
      if (parent === resolvedDirectory) throw error;
      missing.unshift(path.basename(resolvedDirectory));
      resolvedDirectory = parent;
    }
  }
  const output = path.join(resolvedDirectory, identity.projectId + '-' + randomUUID());
  const manifestPath = output + '.manifest.json';
  // The supported macOS runtime has PATH_MAX=1024, including the terminating NUL.
  if (
    process.platform === 'darwin' &&
    [output, manifestPath, ...decoded.map((file) => path.join(output, file.path))].some((file) => Buffer.byteLength(file) >= 1024)
  )
    throw new Error('源码导出完整路径超出系统长度限制');
  // All input and predictable path checks precede the first mkdir; I/O failures are not transactional.
  await mkdir(resolvedDirectory, { recursive: true, mode: 0o700 });
  await mkdir(output, { mode: 0o700 });
  for (const file of decoded) {
    const destination = path.join(output, file.path);
    await mkdir(path.dirname(destination), { recursive: true, mode: 0o700 });
    await writeFile(destination, file.bytes, { flag: 'wx', mode: 0o600 });
  }
  await writeFile(manifestPath, JSON.stringify({ ...identity, ...source }, null, 2), { flag: 'wx', mode: 0o600 });
  return { path: output, manifestPath, sha256: source.sha256 };
}
