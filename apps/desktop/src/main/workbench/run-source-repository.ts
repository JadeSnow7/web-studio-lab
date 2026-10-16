import { spawn } from 'node:child_process';
import { createHash } from 'node:crypto';
import { constants } from 'node:fs';
import { lstat, mkdir, open } from 'node:fs/promises';
import path from 'node:path';
import { Readable } from 'node:stream';
import { pipeline } from 'node:stream/promises';
import { z } from 'zod';
import {
  AppSourceSnapshotSchema,
  AppTargetSchema,
  CapturedSourceChangeSchema,
  SourcePathSchema,
  SOURCE_DIFF_MAX_FILES,
  SOURCE_PATCH_MAX_BYTES,
  type AppSourceSnapshot,
  type CapturedSourceChange,
  type SourceChangeFile,
} from '@wsl/protocol';

const TreeSchema = z
  .string()
  .length(40)
  .regex(/^[a-f0-9]{40}$/);
const BaselineSchema = AppTargetSchema.extend({ runId: z.uuid(), baseTree: TreeSchema }).strict();
const nullFile = process.platform === 'win32' ? 'NUL' : '/dev/null';
const gitConfig = [
  '-c',
  'core.hooksPath=' + nullFile,
  '-c',
  'core.attributesFile=' + nullFile,
  '-c',
  'core.quotePath=false',
  '-c',
  'core.pager=cat',
  '-c',
  'gc.auto=0',
  '-c',
  'maintenance.auto=false',
  '-c',
  'core.fsync=all',
  '-c',
  'diff.renameLimit=200',
];
const diffArgs = [
  'diff-tree',
  '-r',
  '--no-commit-id',
  '--no-ext-diff',
  '--no-textconv',
  '--no-color',
  '--find-renames=50%',
  '--ignore-submodules=all',
];

function validatedSource(input: AppSourceSnapshot): AppSourceSnapshot {
  const parsed = AppSourceSnapshotSchema.safeParse(input);
  if (!parsed.success) throw new Error('源码快照路径、模式、编码或预算无效');
  return parsed.data;
}

export class RunSourceRepository {
  constructor(
    private readonly root: string,
    private readonly gitBinary = 'git',
  ) {}

  private runPath(runId: string): string {
    if (!z.uuid().safeParse(runId).success) throw new Error('denied: 无效源码执行身份');
    return path.join(this.root, runId);
  }

  private async directory(directory: string) {
    const info = await lstat(directory);
    if (!info.isDirectory() || info.isSymbolicLink()) throw new Error('denied: 源码证据目录不是普通目录');
    return info;
  }

  private async prepare(runId: string): Promise<string> {
    const directory = this.runPath(runId);
    await mkdir(path.dirname(this.root), { recursive: true, mode: 0o700 });
    try {
      await mkdir(this.root, { mode: 0o700 });
    } catch (error) {
      if (!(error instanceof Error) || !('code' in error) || error.code !== 'EEXIST') throw error;
    }
    await this.directory(this.root);
    await mkdir(directory, { mode: 0o700 });
    return directory;
  }

  private async writeExclusive(directory: string, name: 'baseline.json' | 'capture.lock' | 'source.patch', content: string): Promise<void> {
    const file = await open(path.join(directory, name), 'wx', 0o400);
    try {
      await file.writeFile(content, 'utf8');
      await file.sync();
    } finally {
      await file.close();
    }
  }

  private async read(runId: string, name: 'baseline.json' | 'source.patch', maxBytes: number): Promise<Buffer> {
    const directory = this.runPath(runId);
    const rootBefore = await this.directory(this.root);
    const parentBefore = await this.directory(directory);
    const file = path.join(directory, name);
    const entry = await lstat(file);
    if (!entry.isFile() || entry.isSymbolicLink() || entry.nlink !== 1 || entry.size > maxBytes)
      throw new Error('denied: 源码证据类型或字节预算无效');
    const handle = await open(file, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
    try {
      const before = await handle.stat();
      if (!before.isFile() || before.nlink !== 1 || before.size > maxBytes || before.dev !== entry.dev || before.ino !== entry.ino)
        throw new Error('denied: 源码证据类型、身份或字节预算无效');
      const bytes = Buffer.alloc(Math.min(before.size + 1, maxBytes + 1));
      let length = 0;
      while (length < bytes.length) {
        const result = await handle.read(bytes, length, bytes.length - length, length);
        if (result.bytesRead === 0) break;
        length += result.bytesRead;
      }
      const after = await handle.stat();
      const linked = await lstat(file);
      const rootAfter = await this.directory(this.root);
      const parentAfter = await this.directory(directory);
      if (
        length !== before.size ||
        before.size !== after.size ||
        after.nlink !== 1 ||
        before.mtimeMs !== after.mtimeMs ||
        before.ctimeMs !== after.ctimeMs ||
        !linked.isFile() ||
        linked.isSymbolicLink() ||
        linked.ino !== before.ino ||
        linked.dev !== before.dev ||
        rootBefore.ino !== rootAfter.ino ||
        rootBefore.dev !== rootAfter.dev ||
        parentBefore.ino !== parentAfter.ino ||
        parentBefore.dev !== parentAfter.dev
      )
        throw new Error('conflict: 源码证据读取期间发生变化');
      return bytes.subarray(0, length);
    } finally {
      await handle.close();
    }
  }

  private async git(
    directory: string,
    args: string[],
    signal?: AbortSignal,
    input?: AsyncIterable<Buffer>,
    limit = 4096,
    truncate = false,
  ): Promise<{ bytes: Buffer; truncated: boolean }> {
    signal?.throwIfAborted();
    const child = spawn(this.gitBinary, [...gitConfig, '--git-dir=' + path.join(directory, 'objects.git'), ...args], {
      cwd: directory,
      env: {
        PATH: process.env['PATH'],
        HOME: directory,
        XDG_CONFIG_HOME: directory,
        LC_ALL: 'C',
        GIT_CONFIG_NOSYSTEM: '1',
        GIT_CONFIG_GLOBAL: nullFile,
        GIT_CONFIG_SYSTEM: nullFile,
        GIT_ATTR_NOSYSTEM: '1',
        GIT_NO_REPLACE_OBJECTS: '1',
      },
      stdio: ['pipe', 'pipe', 'pipe'],
    });
    let failure: string | null = null;
    let length = 0;
    let truncated = false;
    const chunks: Buffer[] = [];
    const stop = () => {
      failure ??= '宿主源码操作已取消或超时';
      child.kill('SIGKILL');
    };
    signal?.addEventListener('abort', stop, { once: true });
    if (signal?.aborted) stop();
    const timer = setTimeout(stop, 120000);
    child.stdout.on('data', (chunk: Buffer) => {
      const keep = Math.min(chunk.length, Math.max(0, limit - length));
      if (keep) chunks.push(Buffer.from(chunk.subarray(0, keep)));
      length += chunk.length;
      if (length > limit) {
        truncated = true;
        if (!truncate) {
          failure = '宿主 Git 摘要超过预算';
          child.kill('SIGKILL');
        }
      }
    });
    child.stderr.resume();
    child.once('error', () => {
      failure = '宿主 Git 不可用；请安装 Git 后再启动新任务';
    });
    const writing = pipeline(Readable.from(input ?? []), child.stdin).catch(() => {
      failure ??= '宿主 Git 源码输入未完成';
      child.kill('SIGKILL');
    });
    try {
      const code = await new Promise<number | null>((resolve) => child.once('close', resolve));
      await writing;
      if (failure) throw new Error(failure);
      if (code !== 0) throw new Error(`宿主 Git 源码操作失败（退出码 ${code}）`);
      return { bytes: Buffer.concat(chunks), truncated };
    } finally {
      clearTimeout(timer);
      signal?.removeEventListener('abort', stop);
    }
  }

  private async importTree(
    directory: string,
    branch: 'baseline' | 'after',
    source: AppSourceSnapshot,
    signal?: AbortSignal,
  ): Promise<string> {
    async function* content(): AsyncGenerator<Buffer> {
      for (const [index, file] of source.files.entries()) {
        signal?.throwIfAborted();
        const bytes = Buffer.from(file.base64, 'base64');
        yield Buffer.from(`blob\nmark :${index + 1}\ndata ${bytes.length}\n`);
        yield bytes;
        yield Buffer.from('\n');
      }
      yield Buffer.from(`commit refs/heads/${branch}\ncommitter Web Studio Lab <source@localhost> 0 +0000\ndata 0\n\ndeleteall\n`);
      for (const [index, file] of source.files.entries()) {
        const quoted = '"' + file.path.replaceAll('"', '\\"') + '"';
        yield Buffer.from(`M ${file.mode} :${index + 1} ${quoted}\n`);
      }
      yield Buffer.from('\ndone\n');
    }
    await this.git(directory, ['fast-import', '--quiet', '--done'], signal, content());
    const result = await this.git(directory, ['rev-parse', '--verify', `refs/heads/${branch}^{tree}`], signal);
    return TreeSchema.parse(result.bytes.toString('ascii').trim());
  }

  async createBaseline(runId: string, input: AppSourceSnapshot, signal?: AbortSignal): Promise<{ baseTree: string }> {
    const source = validatedSource(input);
    signal?.throwIfAborted();
    const directory = await this.prepare(runId);
    await this.git(directory, ['init', '--bare', '--object-format=sha1', '--template=', path.join(directory, 'objects.git')], signal);
    const baseTree = await this.importTree(directory, 'baseline', source, signal);
    await this.writeExclusive(
      directory,
      'baseline.json',
      JSON.stringify({ runId, workspaceId: source.workspaceId, projectId: source.projectId, baseTree }),
    );
    return { baseTree };
  }

  async capture(runId: string, baseTree: string, input: AppSourceSnapshot, signal?: AbortSignal): Promise<CapturedSourceChange> {
    const source = validatedSource(input);
    const baseline = BaselineSchema.parse(JSON.parse((await this.read(runId, 'baseline.json', 4096)).toString('utf8')));
    if (
      baseline.runId !== runId ||
      baseline.workspaceId !== source.workspaceId ||
      baseline.projectId !== source.projectId ||
      baseline.baseTree !== baseTree
    )
      throw new Error('denied: 源码基线归属或树身份不一致');
    const directory = this.runPath(runId);
    await this.directory(path.join(directory, 'objects.git'));
    const savedTree = await this.git(directory, ['rev-parse', '--verify', 'refs/heads/baseline^{tree}'], signal);
    if (savedTree.bytes.toString('ascii').trim() !== baseTree) throw new Error('conflict: 宿主源码基线发生变化');
    await this.writeExclusive(directory, 'capture.lock', '');
    const afterTree = await this.importTree(directory, 'after', source, signal);
    const names = await this.git(
      directory,
      [...diffArgs, '--name-status', '-z', baseTree, afterTree, '--'],
      signal,
      undefined,
      48 * 1024 * 1024,
    );
    const stats = await this.git(
      directory,
      [...diffArgs, '--numstat', '-z', baseTree, afterTree, '--'],
      signal,
      undefined,
      48 * 1024 * 1024,
    );
    const changes = this.fileChanges(names.bytes, stats.bytes);
    const diff = await this.git(
      directory,
      [...diffArgs, '-p', '--src-prefix=a/', '--dst-prefix=b/', baseTree, afterTree, '--'],
      signal,
      undefined,
      SOURCE_PATCH_MAX_BYTES,
      true,
    );
    let patch: string;
    try {
      patch = new TextDecoder('utf-8', { fatal: true }).decode(diff.bytes, { stream: diff.truncated });
    } catch {
      throw new Error('源码 diff 含非 UTF-8 文本，无法可靠展示；原始字节保留在宿主对象中');
    }
    const patchSha256 = createHash('sha256').update(patch, 'utf8').digest('hex');
    const result = CapturedSourceChangeSchema.parse({
      state: 'captured',
      baseTree,
      afterTree,
      files: changes.slice(0, SOURCE_DIFF_MAX_FILES),
      additions: changes.reduce((sum, file) => sum + file.additions, 0),
      deletions: changes.reduce((sum, file) => sum + file.deletions, 0),
      truncated: diff.truncated || changes.length > SOURCE_DIFF_MAX_FILES,
      patchSha256,
    });
    await this.writeExclusive(directory, 'source.patch', patch);
    return result;
  }

  private fileChanges(names: Buffer, stats: Buffer): SourceChangeFile[] {
    const paths = names.toString('utf8').split('\0');
    const files = new Map<string, SourceChangeFile>();
    for (let i = 0; i < paths.length - 1;) {
      const status = paths[i++];
      let name = paths[i++];
      if (status?.startsWith('R')) name = paths[i++];
      if (!status || !name || !/^(A|M|D|R[0-9]{1,3})$/.test(status) || files.has(name)) throw new Error('宿主 Git 文件摘要无效');
      files.set(name, {
        path: SourcePathSchema.parse(name),
        change: status === 'A' ? 'added' : status === 'D' ? 'deleted' : status.startsWith('R') ? 'renamed' : 'modified',
        additions: 0,
        deletions: 0,
        binary: false,
      });
    }
    const counts = stats.toString('utf8').split('\0');
    const counted = new Set<string>();
    for (let i = 0; i < counts.length - 1;) {
      const fields = counts[i++]?.split('\t');
      let name = fields?.slice(2).join('\t');
      if (name === '') {
        i++;
        name = counts[i++];
      }
      const file = name ? files.get(name) : undefined;
      if (!file || !fields || counted.has(file.path)) throw new Error('宿主 Git 行数摘要无效');
      counted.add(file.path);
      const [added, deleted] = fields;
      if (added === '-' && deleted === '-') file.binary = true;
      else {
        if (!added || !deleted || !/^\d+$/.test(added) || !/^\d+$/.test(deleted)) throw new Error('宿主 Git 行数无效');
        file.additions = Number(added);
        file.deletions = Number(deleted);
      }
    }
    if (counted.size !== files.size) throw new Error('宿主 Git 摘要不完整');
    return [...files.values()];
  }

  async readPatch(runId: string, patchSha256: string): Promise<string> {
    if (!CapturedSourceChangeSchema.shape.patchSha256.safeParse(patchSha256).success) throw new Error('denied: 无效 diff 摘要');
    const bytes = await this.read(runId, 'source.patch', SOURCE_PATCH_MAX_BYTES);
    if (createHash('sha256').update(bytes).digest('hex') !== patchSha256) throw new Error('conflict: diff SHA-256 不匹配');
    return new TextDecoder('utf-8', { fatal: true }).decode(bytes);
  }
}
