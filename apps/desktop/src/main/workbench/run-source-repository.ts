import { spawn } from 'node:child_process';
import { createHash } from 'node:crypto';
import { constants } from 'node:fs';
import { lstat, mkdir, mkdtemp, open, rm } from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
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
  type AppSource,
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

  private async writeExclusive(directory: string, name: string, content: string): Promise<void> {
    const file = await open(path.join(directory, name), 'wx', 0o400);
    try {
      await file.writeFile(content, 'utf8');
      await file.sync();
    } finally {
      await file.close();
    }
  }

  private async read(runId: string, name: string, maxBytes: number): Promise<Buffer> {
    if (!/^[a-z0-9][a-z0-9.-]{0,63}$/i.test(name) || name.includes('..')) throw new Error('denied: 无效源码证据名称');
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
    extraEnv?: Record<string, string>,
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
        ...extraEnv,
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
    branch: 'baseline' | 'after' | 'after-check' | `after-${number}`,
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
    return this.captureInternal(
      runId,
      baseTree,
      input,
      {
        branch: 'after',
        lockName: 'capture.lock',
        patchName: 'source.patch',
      },
      signal,
    );
  }

  /**
   * W6a：workflow lane 候选的按调用序号快照。与 capture() 同一基线核对与 diff 口径，
   * 但锁定、after 引用与 patch 证据都按 callSeq 分名——同一 run 可多次发布互不覆盖。
   */
  async captureCandidate(
    runId: string,
    callSeq: number,
    baseTree: string,
    input: AppSourceSnapshot,
    signal?: AbortSignal,
  ): Promise<CapturedSourceChange> {
    if (!Number.isInteger(callSeq) || callSeq < 1 || callSeq > 1_000_000) throw new Error('denied: 无效候选调用序号');
    return this.captureInternal(
      runId,
      baseTree,
      input,
      {
        branch: `after-${callSeq}`,
        lockName: `capture-${callSeq}.lock`,
        patchName: `source-${callSeq}.patch`,
      },
      signal,
    );
  }

  private async captureInternal(
    runId: string,
    baseTree: string,
    input: AppSourceSnapshot,
    artifact: { branch: 'after' | `after-${number}`; lockName: string; patchName: string },
    signal?: AbortSignal,
  ): Promise<CapturedSourceChange> {
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
    await this.writeExclusive(directory, artifact.lockName, '');
    const afterTree = await this.importTree(directory, artifact.branch, source, signal);
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
    await this.writeExclusive(directory, artifact.patchName, patch);
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

  /**
   * W6b：读取某次 lane 发布的 diff（captureCandidate 写入的 `source-{callSeq}.patch`），
   * 与 readPatch 相同的 sha256 校验。
   */
  async readCandidatePatch(runId: string, callSeq: number, patchSha256: string): Promise<string> {
    if (!Number.isInteger(callSeq) || callSeq < 1 || callSeq > 1_000_000) throw new Error('denied: 无效候选调用序号');
    if (!CapturedSourceChangeSchema.shape.patchSha256.safeParse(patchSha256).success) throw new Error('denied: 无效 diff 摘要');
    const bytes = await this.read(runId, `source-${callSeq}.patch`, SOURCE_PATCH_MAX_BYTES);
    if (createHash('sha256').update(bytes).digest('hex') !== patchSha256) throw new Error('conflict: diff SHA-256 不匹配');
    return new TextDecoder('utf-8', { fatal: true }).decode(bytes);
  }

  /**
   * W6b：以与候选树相同的约定（全部 100644 模式）计算一份活体源码（App 快照）的
   * tree-id，使 baseTree ↔ 当前源码比较只反映路径与内容。blob 写入 run 的
   * objects.git（内容寻址、无引用），解析出树后删除临时分支。
   */
  async computeTree(runId: string, input: AppSourceSnapshot, signal?: AbortSignal): Promise<string> {
    const source = validatedSource(input);
    const normalized: AppSourceSnapshot = {
      ...source,
      files: source.files.map((file) => ({ ...file, mode: '100644' })),
    };
    const directory = this.runPath(runId);
    await this.directory(path.join(directory, 'objects.git'));
    const tree = await this.importTree(directory, 'after-check', normalized, signal);
    await this.git(directory, ['update-ref', '-d', 'refs/heads/after-check'], signal).catch(() => undefined);
    return tree;
  }

  /**
   * W6b：把候选树物化为 app.source.apply 消费的扁平文件列表——`git ls-tree -r` 枚举、
   * `git show` 逐 blob 读出。树必须已存在于 run 的 objects.git（由
   * createBaseline/captureCandidate 创建）。预算：≤256 文件、≤512 KiB 总量
   * （与 AppSourceApplyFilesSchema 同口径）。
   */
  async materialize(runId: string, treeId: string, signal?: AbortSignal): Promise<AppSource['files']> {
    if (!TreeSchema.safeParse(treeId).success) throw new Error('denied: 无效树身份');
    const directory = this.runPath(runId);
    await this.directory(path.join(directory, 'objects.git'));
    // ls-tree -rz: "<mode> <type> <oid>\t<path>\0"
    const ls = await this.git(directory, ['ls-tree', '-rz', '--full-tree', treeId], signal, undefined, 48 * 1024 * 1024);
    const entries = ls.bytes
      .toString('utf8')
      .split('\0')
      .filter((line) => line.length > 0)
      .map((line) => {
        const tab = line.indexOf('\t');
        const meta = line.slice(0, tab).split(' ');
        return { mode: meta[0] ?? '', type: meta[1] ?? '', oid: meta[2] ?? '', path: line.slice(tab + 1) };
      });
    if (entries.length > 256) throw new Error('候选树超过应用文件预算');
    const files: AppSource['files'] = [];
    let total = 0;
    for (const entry of entries) {
      if (entry.type !== 'blob') continue; // -r 下不应出现 subtree；commit/submodule 一律忽略
      const blob = await this.git(directory, ['show', entry.oid], signal, undefined, 512 * 1024 + 1);
      total += blob.bytes.length;
      if (total > 512 * 1024) throw new Error('候选树超过应用字节预算');
      files.push({ path: entry.path, base64: blob.bytes.toString('base64') });
    }
    return files;
  }

  /** ls-tree -r -z 的平铺视图：path → {mode, oid}（只收 blob；submodule/commit 条目跳过）。 */
  private async lsTreeMap(directory: string, treeId: string, signal?: AbortSignal): Promise<Map<string, { mode: string; oid: string }>> {
    const ls = await this.git(directory, ['ls-tree', '-rz', '--full-tree', treeId], signal, undefined, 48 * 1024 * 1024);
    const map = new Map<string, { mode: string; oid: string }>();
    for (const line of ls.bytes.toString('utf8').split('\0')) {
      if (line.length === 0) continue;
      const tab = line.indexOf('\t');
      const meta = line.slice(0, tab).split(' ');
      if (meta[1] !== 'blob') continue;
      map.set(line.slice(tab + 1), { mode: meta[0] ?? '', oid: meta[2] ?? '' });
    }
    return map;
  }

  /**
   * W8：lane 候选的文件级三向合并。B = 调用登记基线，candidate = lane 采集树，
   * P = 当前候选指针。两侧相对 B 各自 diff：同路径比较结果（blob 相同或两边都删
   * → 相同补丁按「已合入」去重不冲突；不同结果 → conflict）；目录/文件位置
   * 冲突（一侧在某路径是文件、另一侧把它当目录）同样判冲突。
   * 无冲突时用临时 index（read-tree P + update-index --index-info + write-tree）
   * 构造合并树 M——只写 objects.git，不 touch 工作区/HEAD/真实 index。
   */
  async mergeCandidate(
    runId: string,
    callSeq: number,
    baseTree: string,
    candidateTree: string,
    pointerTree: string,
    signal?: AbortSignal,
  ): Promise<{ merged: string } | { conflict: { files: string[] } }> {
    for (const treeId of [baseTree, candidateTree, pointerTree]) {
      if (!TreeSchema.safeParse(treeId).success) throw new Error('denied: 无效树身份');
    }
    if (!Number.isInteger(callSeq) || callSeq < 1 || callSeq > 1_000_000) throw new Error('denied: 无效候选调用序号');
    const directory = this.runPath(runId);
    await this.directory(path.join(directory, 'objects.git'));

    const base = await this.lsTreeMap(directory, baseTree, signal);
    const candidate = await this.lsTreeMap(directory, candidateTree, signal);
    const pointer = await this.lsTreeMap(directory, pointerTree, signal);
    // 预算：平铺路径数与对象数上限与候选文件预算同口径。
    for (const [name, map] of [
      ['base', base],
      ['candidate', candidate],
      ['pointer', pointer],
    ] as const) {
      if (map.size > 4096) throw new Error(`denied: 合并树 ${name} 超过路径预算`);
    }
    const outcomeOf = (map: Map<string, { mode: string; oid: string }>, path: string) => map.get(path) ?? null;
    const changed = (from: Map<string, { mode: string; oid: string }>, to: Map<string, { mode: string; oid: string }>) => {
      const paths = new Set<string>();
      for (const [p, e] of to) {
        const before = from.get(p);
        if (before === undefined || before.oid !== e.oid || before.mode !== e.mode) paths.add(p);
      }
      for (const p of from.keys()) {
        if (!to.has(p)) paths.add(p);
      }
      return paths;
    };
    const laneDiff = changed(base, candidate);
    const pointerDiff = changed(base, pointer);
    const ancestorsOf = (p: string): string[] => {
      const out: string[] = [];
      let i = p.indexOf('/');
      while (i > 0) {
        out.push(p.slice(0, i));
        i = p.indexOf('/', i + 1);
      }
      return out;
    };
    const conflicts = new Set<string>();
    // 同路径重叠：结果相同（含两边都删）→ 去重；不同 → 冲突。
    for (const p of laneDiff) {
      if (!pointerDiff.has(p)) continue;
      const laneOut = outcomeOf(candidate, p);
      const pointerOut = outcomeOf(pointer, p);
      const same =
        laneOut === null && pointerOut === null
          ? true
          : laneOut !== null && pointerOut !== null && laneOut.oid === pointerOut.oid && laneOut.mode === pointerOut.mode;
      if (!same) conflicts.add(p);
    }
    // 目录/文件位置冲突：lane 在某目录下产文件而 P 在该目录位置有（改动过的）文件，或反之。
    for (const p of laneDiff) {
      for (const dir of ancestorsOf(p)) {
        const inPointer = outcomeOf(pointer, dir);
        const inBase = outcomeOf(base, dir);
        if ((inPointer === null) !== (inBase === null) || (inPointer !== null && inBase !== null && inPointer.oid !== inBase.oid)) {
          conflicts.add(p);
        }
      }
    }
    for (const p of pointerDiff) {
      for (const dir of ancestorsOf(p)) {
        const inCandidate = outcomeOf(candidate, dir);
        const inBase = outcomeOf(base, dir);
        if ((inCandidate === null) !== (inBase === null) || (inCandidate !== null && inBase !== null && inCandidate.oid !== inBase.oid)) {
          conflicts.add(p);
        }
      }
    }
    if (conflicts.size > 0) return { conflict: { files: [...conflicts].sort() } };

    // 无冲突：lane 的非重叠变更套到 P 上（重叠且结果相同的路径天然已在 P 中）。
    const tmpRoot = await mkdtemp(path.join(os.tmpdir(), 'wsl-merge-index-'));
    const indexFile = path.join(tmpRoot, 'index');
    const env = { GIT_INDEX_FILE: indexFile };
    try {
      await this.git(directory, ['read-tree', pointerTree], signal, undefined, 4096, false, env);
      const updates: Buffer[] = [];
      let applyCount = 0;
      for (const p of [...laneDiff].sort()) {
        const pointerOut = outcomeOf(pointer, p);
        const laneOut = outcomeOf(candidate, p);
        const same =
          laneOut === null && pointerOut === null
            ? true
            : laneOut !== null && pointerOut !== null && laneOut.oid === pointerOut.oid && laneOut.mode === pointerOut.mode;
        if (same) continue; // 相同补丁去重：已在 P 中，不重复写。
        applyCount += 1;
        if (applyCount > 4096) throw new Error('denied: 合并补丁超过路径预算');
        if (laneOut === null) {
          updates.push(Buffer.from(`0 0000000000000000000000000000000000000000\t${p}\n`));
        } else {
          updates.push(Buffer.from(`${laneOut.mode} ${laneOut.oid}\t${p}\n`));
        }
      }
      if (updates.length > 0) {
        async function* lines(): AsyncGenerator<Buffer> {
          for (const line of updates) yield line;
        }
        await this.git(directory, ['update-index', '--add', '--remove', '--index-info'], signal, lines(), 4096, false, env);
      }
      const tree = await this.git(directory, ['write-tree'], signal, undefined, 4096, false, env);
      return { merged: TreeSchema.parse(tree.bytes.toString('ascii').trim()) };
    } finally {
      await rm(tmpRoot, { recursive: true, force: true });
    }
  }
}
