import { execFile } from 'node:child_process';
import { createHash } from 'node:crypto';
import { constants } from 'node:fs';
import { lstat, open, opendir, realpath } from 'node:fs/promises';
import path from 'node:path';
import { promisify } from 'node:util';
import {
  EDU_REQUIRED_FILES,
  EDU_ROOT_FILES,
  EDU_SOURCE_BYTES,
  EduSourceSchema,
  isEduExcludedName,
  isEduSourcePath,
  type EduImport,
  type EduSource,
} from '@wsl/protocol';

const exec = promisify(execFile);
const hash = (bytes: Buffer | string) => createHash('sha256').update(bytes).digest('hex');

async function repositoryIdentity(root: string, signal: AbortSignal): Promise<EduSource['repository']> {
  const git = async (...args: string[]) =>
    (
      await exec(
        '/usr/bin/git',
        ['-C', root, '-c', 'core.fsmonitor=false', '-c', 'core.hooksPath=/dev/null', '-c', 'core.attributesFile=/dev/null', ...args],
        {
          signal,
          timeout: 10000,
          maxBuffer: 1024 * 1024,
          env: {
            PATH: '/usr/bin:/bin',
            LANG: 'C',
            GIT_CONFIG_NOSYSTEM: '1',
            GIT_CONFIG_GLOBAL: '/dev/null',
            GIT_ATTR_NOSYSTEM: '1',
            GIT_NO_LAZY_FETCH: '1',
            GIT_NO_REPLACE_OBJECTS: '1',
            GIT_OPTIONAL_LOCKS: '0',
            GIT_TERMINAL_PROMPT: '0',
          },
        },
      )
    ).stdout.trim();
  let unsafeConfig = '';
  try {
    unsafeConfig = await git(
      'config',
      '--includes',
      '--name-only',
      '--get-regexp',
      '^(filter\\.|extensions\\.partialclone$|remote\\..*\\.promisor$)',
    );
  } catch (error) {
    if (
      !(error instanceof Error) ||
      !('code' in error) ||
      error.code !== 1 ||
      !('stdout' in error) ||
      error.stdout !== '' ||
      !('stderr' in error) ||
      error.stderr !== ''
    )
      throw new Error('无法安全检查来源 Git 配置', { cause: error });
  }
  if (unsafeConfig) throw new Error('来源 Git 包含外部过滤器或 partial-clone；请使用无执行助手的完整源码 checkout');
  if ((await realpath(await git('rev-parse', '--show-toplevel'))) !== root) throw new Error('请选择 edu Git 工程根目录');
  if ((await git('ls-files', '--stage')).split('\n').some((line) => line.startsWith('160000 ')))
    throw new Error('edu profile v1 不支持 Git submodule；请使用完整源码 checkout');
  return {
    commit: await git('rev-parse', '--verify', 'HEAD^{commit}'),
    dirty: (await git('status', '--porcelain=v1', '--untracked-files=normal', '--ignore-submodules=all')) !== '',
  };
}

export async function collectEduSource(
  input: string,
  signal: AbortSignal,
  identity = repositoryIdentity,
  progress?: (value: { files: number; bytes: number }) => void,
): Promise<Pick<EduImport, 'files' | 'source'>> {
  signal.throwIfAborted();
  if ((await lstat(input)).isSymbolicLink()) throw new Error('源码根目录不能是符号链接');
  const root = await realpath(input);
  if (!(await lstat(root)).isDirectory()) throw new Error('源码根目录不是目录');
  const before = await identity(root, signal);
  const collect = async (report = false) => {
    const files: EduImport['files'] = [];
    let total = 0;
    let visited = 0;
    const walk = async (relative: string) => {
      signal.throwIfAborted();
      if (++visited > 4096) throw new Error('源码目录超出遍历预算');
      if (isEduExcludedName(path.basename(relative))) return;
      if (relative.includes('\\') || [...relative].some((char) => char.charCodeAt(0) < 32 || char.charCodeAt(0) === 127))
        throw new Error('源码路径无效');
      const file = path.join(root, relative);
      let info;
      try {
        info = await lstat(file);
      } catch (error) {
        if (
          (error as NodeJS.ErrnoException).code === 'ENOENT' &&
          (EDU_ROOT_FILES.includes(relative) || relative === 'docs/development/webstudiolab.md')
        )
          return;
        throw error;
      }
      if (info.isSymbolicLink()) throw new Error('源码包含符号链接：' + relative);
      if (info.isDirectory()) {
        if (relative.split('/').length > 32) throw new Error('源码目录层级超出预算');
        const directory = await opendir(file);
        // Stream names so a huge untrusted directory cannot allocate an unbounded listing.
        const names: string[] = [];
        for await (const entry of directory) {
          signal.throwIfAborted();
          if (names.length + visited >= 4096) throw new Error('源码目录超出遍历预算');
          names.push(entry.name);
        }
        for (const name of names.sort()) await walk(relative + '/' + name);
        return;
      }
      if (!isEduSourcePath(relative)) return;
      if (!info.isFile() || info.nlink !== 1) throw new Error('源码必须是单硬链接普通文件：' + relative);
      total += info.size;
      if (total > EDU_SOURCE_BYTES || files.length >= 256) throw new Error('edu 源码超出传输预算');
      if ((await realpath(file)) !== file) throw new Error('源码路径包含符号链接');
      const handle = await open(file, constants.O_RDONLY | constants.O_NOFOLLOW);
      try {
        const opened = await handle.stat();
        if (opened.dev !== info.dev || opened.ino !== info.ino || opened.size !== info.size || opened.nlink !== 1)
          throw new Error('源码采集期间发生变化');
        const bytes = Buffer.alloc(info.size);
        let offset = 0;
        while (offset < bytes.length) {
          signal.throwIfAborted();
          const read = await handle.read(bytes, offset, bytes.length - offset, offset);
          if (!read.bytesRead) throw new Error('源码采集期间发生变化');
          offset += read.bytesRead;
        }
        const after = await handle.stat();
        const named = await lstat(file);
        if (
          after.size !== info.size ||
          after.mtimeMs !== info.mtimeMs ||
          after.ctimeMs !== info.ctimeMs ||
          after.nlink !== 1 ||
          named.dev !== after.dev ||
          named.ino !== after.ino ||
          named.isSymbolicLink() ||
          (await realpath(file)) !== file
        )
          throw new Error('源码采集期间发生变化');
        files.push({ path: relative, base64: bytes.toString('base64') });
        if (report) progress?.({ files: files.length, bytes: total });
      } finally {
        await handle.close();
      }
    };
    for (const name of [...EDU_ROOT_FILES, 'admin', 'server', 'docs/development/webstudiolab.md']) await walk(name);
    files.sort((a, b) => (a.path < b.path ? -1 : a.path > b.path ? 1 : 0));
    for (const name of EDU_REQUIRED_FILES) if (!files.some((file) => file.path === name)) throw new Error('edu 工程缺少必需源码：' + name);
    return files;
  };
  const files = await collect(true);
  const after = await identity(root, signal);
  const repeated = await collect();
  if (JSON.stringify(before) !== JSON.stringify(after) || JSON.stringify(files) !== JSON.stringify(repeated))
    throw new Error('源码采集期间来源或内容发生变化，请重试');
  signal.throwIfAborted();
  const metadata = files.map((file) => {
    const bytes = Buffer.from(file.base64, 'base64');
    return { path: file.path, sha256: hash(bytes), bytes: bytes.length };
  });
  return { files, source: EduSourceSchema.parse({ repository: before, sourceSha256: hash(JSON.stringify(metadata)), files: metadata }) };
}
