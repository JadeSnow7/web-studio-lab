import { closeSync, constants, fstatSync, ftruncateSync, lstatSync, openSync, readSync, writeFileSync, writeSync } from 'node:fs';
import type {
  ChatStatus,
  DebugStatusSnapshot,
  ExecutionStatus,
  SetupSnapshot,
  StatusFact,
  StatusTransition,
  WorkbenchSnapshot,
} from '@wsl/protocol';
import { projectFacts, redactDebugSnapshot, redactFact, redactTransition, type FactInput, type RedactContext } from '../shared/status';
import type { TrustedRenderer } from './ipc-guard';

/*
 * 诊断通道的 Main 端（status-interface.md §8）。
 * 只读订阅 Main 已发布的 WorkbenchSnapshot / ChatStatus / SetupSnapshot / ExecutionStatus，经共享的 projectFacts 得到事实，
 * 按 key 计算转换。本模块不写任何业务状态，也不授予权限；PageCapture、截图、终端输出、消息正文、文件内容不在事实里，
 * 因此不会进入这里的任何数据（事实的 raw 由 protocol 的按域白名单 schema 约束）。
 */

/** 转换环形缓冲上限（§8.5）。 */
export const TRANSITION_LIMIT = 500;
/** NDJSON 文件上限（§8.5）：5 MiB。 */
export const LOG_LIMIT_BYTES = 5 * 1024 * 1024;
/** WorkbenchSnapshot 尚未发布时的 appInstanceId 占位。 */
export const PENDING_APP_INSTANCE = 'unavailable';

/** 启用判定的唯一位置：开发服务器，或显式设置 WSL_DEBUG_STATUS=1（§8.1）。 */
export function debugStatusEnabled(trusted: TrustedRenderer, env: NodeJS.ProcessEnv): boolean {
  return trusted.kind === 'dev-server' || env['WSL_DEBUG_STATUS'] === '1';
}

export interface DebugStatusOptions {
  /** 当前用户家目录；脱敏时替换为 `~`。 */
  homeDir: string;
  /** NDJSON 路径（WSL_STATUS_LOG）；为空则不写文件。 */
  logPath?: string | null;
  /**
   * 授权根与 SSH 身份之外的补充来源：开发环境变量（WSL_OBSERVATION_ROOT、WSL_SSH_HOST 等）绕过安装记录，
   * 它们不在 SetupSnapshot 里，由装配处传入。
   */
  extraRoots?: readonly string[];
  extraSshIdentities?: readonly string[];
  /** 每条转换（已脱敏）的推送出口，对应 `debug:status` 事件。 */
  emit?: (transition: StatusTransition) => void;
  /** 写入失败等 Main 错误的出口；每个实例最多调用一次（日志写入失败后停用）。 */
  reportError?: (message: string, error: unknown) => void;
  now?: () => Date;
  /** 测试注入：默认追加写真实文件（不跟随符号链接）。 */
  writeLogFile?: (path: string, data: string) => void;
  /** 测试注入：开始写入前准备日志文件；拒绝（抛错）时 NDJSON 停用。默认见 prepareLogFile。 */
  prepareLogFile?: (path: string) => void;
}

type Endpoint = NonNullable<StatusTransition['from']>;
const endpointOf = (fact: StatusFact): Endpoint => ({ phase: fact.phase, kind: fact.kind, label: fact.label });

const SNAPSHOT_PREFIX = '{"type":"snapshot"';

/**
 * 准备 WSL_STATUS_LOG：新文件用 `wx` 创建；已存在时只有「普通文件、非符号链接、且以上次诊断的 snapshot 行开头」
 * 才截断重建，其他一律拒绝（抛错），不改动已有文件。打开使用 O_NOFOLLOW 并对同一个 fd 校验，避免检查与截断之间被换成链接。
 */
export function prepareLogFile(path: string): void {
  try {
    writeFileSync(path, '', { flag: 'wx', mode: 0o600 });
    return;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error;
  }
  if (lstatSync(path).isSymbolicLink()) throw new Error('拒绝使用符号链接作为状态日志');
  const fd = openSync(path, constants.O_RDWR | constants.O_NOFOLLOW);
  try {
    if (!fstatSync(fd).isFile()) throw new Error('状态日志路径不是普通文件');
    const head = Buffer.alloc(SNAPSHOT_PREFIX.length);
    const read = readSync(fd, head, 0, head.length, 0);
    if (head.toString('utf8', 0, read) !== SNAPSHOT_PREFIX) throw new Error('已有文件不是上次诊断留下的状态日志，拒绝覆盖');
    ftruncateSync(fd, 0);
  } finally {
    closeSync(fd);
  }
}

function defaultWriteLogFile(path: string, data: string): void {
  const fd = openSync(path, constants.O_WRONLY | constants.O_APPEND | constants.O_NOFOLLOW);
  try {
    writeSync(fd, data);
  } finally {
    closeSync(fd);
  }
}

export class DebugStatus {
  private input: FactInput = { snapshot: null, chat: null, setup: null, execution: null };
  private facts = new Map<string, StatusFact>();
  private transitions: StatusTransition[] = [];
  private seq = 0;
  private logging = false;
  private logWritten = 0;
  private logStopped = false;
  private projectionFailed = false;
  private readonly now: () => Date;
  private emitFailed = false;
  private readonly writeLogFile: NonNullable<DebugStatusOptions['writeLogFile']>;
  private readonly prepareLogFile: NonNullable<DebugStatusOptions['prepareLogFile']>;

  constructor(private readonly options: DebugStatusOptions) {
    this.now = options.now ?? (() => new Date());
    this.writeLogFile = options.writeLogFile ?? defaultWriteLogFile;
    this.prepareLogFile = options.prepareLogFile ?? prepareLogFile;
  }

  /* ---------- 订阅入口：只接收 Main 已发布的快照 ---------- */

  onWorkbench(snapshot: WorkbenchSnapshot): void {
    const current = this.input.snapshot;
    // 同一应用实例内，迟到的旧快照不覆盖新快照。
    if (current && current.appInstanceId === snapshot.appInstanceId && current.seq > snapshot.seq) return;
    this.update({ snapshot });
  }
  onChat(chat: ChatStatus): void {
    this.update({ chat });
  }
  onSetup(setup: SetupSnapshot): void {
    this.update({ setup });
  }
  onExecution(execution: ExecutionStatus): void {
    this.update({ execution });
  }

  /**
   * 合并输入、重新投影，并为每个新增 / 变化 / 消失的 key 追加一条转换。
   * 诊断是旁路：投影失败只报告一次并保持上一份事实，不向调用方（IPC 处理器、快照发布点）抛出。
   */
  update(patch: Partial<FactInput>): void {
    try {
      this.apply(patch);
    } catch (error) {
      if (this.projectionFailed) return;
      this.projectionFailed = true;
      this.options.reportError?.('状态诊断投影失败；诊断数据可能不再更新', error);
    }
  }

  private apply(patch: Partial<FactInput>): void {
    const input = { ...this.input, ...patch };
    const next = new Map(projectFacts(input).map((fact) => [fact.key, fact] as const));
    this.input = input;
    const at = this.now().toISOString();
    const produced: StatusTransition[] = [];
    for (const [key, fact] of next) {
      const previous = this.facts.get(key);
      if (!previous) produced.push({ key, from: null, to: endpointOf(fact), at, seq: ++this.seq });
      else if (previous.phase !== fact.phase || previous.kind !== fact.kind || previous.label !== fact.label)
        produced.push({ key, from: endpointOf(previous), to: endpointOf(fact), at, seq: ++this.seq });
    }
    for (const [key, fact] of this.facts) if (!next.has(key)) produced.push({ key, from: endpointOf(fact), to: null, at, seq: ++this.seq });
    this.facts = next;
    if (!produced.length) return;
    this.transitions.push(...produced);
    if (this.transitions.length > TRANSITION_LIMIT) this.transitions.splice(0, this.transitions.length - TRANSITION_LIMIT);
    const context = this.redactContext();
    const safe = produced.map((transition) => redactTransition(transition, context));
    // 先写日志、再推送：推送（sendToRenderer）失败不得中断同批转换的 NDJSON，也不算投影失败。
    for (const transition of safe) this.log({ type: 'transition', ...transition });
    for (const transition of safe) this.push(transition);
  }

  private push(transition: StatusTransition): void {
    try {
      this.options.emit?.(transition);
    } catch (error) {
      if (this.emitFailed) return;
      this.emitFailed = true;
      this.options.reportError?.('状态诊断事件推送失败；面板将不再实时更新', error);
    }
  }

  /* ---------- 出口 ---------- */

  /** `debug:status` invoke 的返回值：经 redactDebugSnapshot 脱敏。 */
  snapshot(): DebugStatusSnapshot {
    return redactDebugSnapshot(
      {
        appInstanceId: this.input.snapshot?.appInstanceId ?? PENDING_APP_INSTANCE,
        seq: this.seq,
        generatedAt: this.now().toISOString(),
        facts: [...this.facts.values()],
        transitions: [...this.transitions],
      },
      this.redactContext(),
    );
  }

  /**
   * 开始写 NDJSON：新建文件（或重建上次诊断留下的日志，见 prepareLogFile），首行为事实快照，不含 WorkbenchSnapshot；
   * 此后每条转换追加一行。路径指向其他已有文件或符号链接时只报告一次并停用。
   * 在装配处先放入启动时已知的输入，再调用本方法，使首行成为后续转换的基线。
   */
  startLog(): void {
    if (!this.options.logPath || this.logging || this.logStopped) return;
    try {
      this.prepareLogFile(this.options.logPath);
    } catch (error) {
      this.logStopped = true;
      this.options.reportError?.(`状态诊断日志无法使用，已停用：${this.options.logPath}`, error);
      return;
    }
    this.logging = true;
    const context = this.redactContext();
    const first = {
      type: 'snapshot',
      appInstanceId: this.input.snapshot?.appInstanceId ?? PENDING_APP_INSTANCE,
      seq: this.seq,
      generatedAt: this.now().toISOString(),
      facts: [...this.facts.values()].map((fact) => redactFact(fact, context)),
    };
    this.log(first);
  }

  /** 授权根与 SSH 身份来自安装记录（及开发环境补充）；家目录来自调用方。 */
  private redactContext(): RedactContext {
    const config = this.input.setup?.config;
    return {
      homeDir: this.options.homeDir,
      roots: [config?.localRoot, config?.ssh?.root, ...(this.options.extraRoots ?? [])].filter((root): root is string => !!root),
      sshIdentities: [config?.ssh?.host, config?.ssh?.username, ...(this.options.extraSshIdentities ?? [])].filter(
        (value): value is string => !!value,
      ),
    };
  }

  private log(entry: Record<string, unknown>): void {
    const path = this.options.logPath;
    if (!path || !this.logging || this.logStopped) return;
    const line = `${JSON.stringify(entry)}\n`;
    const limitLine = `${JSON.stringify({ type: 'limit' })}\n`;
    const size = Buffer.byteLength(line);
    // 为 limit 行预留空间，保证文件不超过上限；到达上限后停止写入，不轮转、不删除。
    const overflow = this.logWritten + size + Buffer.byteLength(limitLine) > LOG_LIMIT_BYTES;
    try {
      if (overflow) {
        this.logStopped = true;
        this.writeLogFile(path, limitLine);
        this.logWritten += Buffer.byteLength(limitLine);
        return;
      }
      this.writeLogFile(path, line);
      this.logWritten += size;
    } catch (error) {
      // 日志失败只记录一次并停用，不影响应用与诊断面板。
      this.logStopped = true;
      this.options.reportError?.(`状态诊断日志写入失败，已停用：${path}`, error);
    }
  }
}
