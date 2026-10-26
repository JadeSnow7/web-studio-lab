import { randomUUID } from 'node:crypto';
import { mkdir } from 'node:fs/promises';
import type { AppTarget, WorkflowIsolation, WorkflowPublication } from '@wsl/protocol';
import { analyzeScript, type ScriptMeta } from './analyze';
import { WorkflowCleanupUnconfirmedError } from './call-adapter';
import type {
  CallEvent,
  CallUsage,
  EffectiveSemantics,
  WorkflowCall,
  WorkflowCallAdapter,
  WorkflowCandidate,
  WorkflowLaneWorkspace,
  WorkflowPublishOutcome,
} from './call-adapter';
import {
  canonical,
  contentKey,
  DSL_VERSION,
  LIMITS,
  sha256Hex,
  WorkflowContractError,
  type AgentResult,
  type CallFailureCode,
  type JournalEvent,
  type RunFailureCode,
  type RunStatus,
} from './contract';
import { JsonlJournal, readJournal } from './journal-jsonl';
import { VmBridge, type OutboxItem, type WorkerMessage } from './vm-bridge';

/**
 * 合同 §3/§4/§7 的运行内核：callSeq 分配、opts 校验、有界并发派发、重试、schema 校验、
 * 按序交付、journal、缓存续跑、deadline 与停止。Electron 无关的纯 TypeScript。
 * W5：派发并发上界 MAX_CONCURRENT_CALLS 只改变物理执行次序；call_end 先于 deliver、
 * 按 callSeq 顺序交付的语义不变，同一 seq 的 journal 事件顺序与顺序执行一致。
 */

/**
 * journal 端口：内核只要求逐条 append 且按 await 顺序提交；close 在终态落盘后调用（可选）。
 * JsonlJournal 与 Main 侧 SQLite 沉点经同一窄接口注入。
 */
export interface WorkflowJournalPort {
  append(event: JournalEvent): Promise<void>;
  close?(): Promise<void>;
}

export interface CreateRunOptions {
  script: string;
  args?: unknown;
  /** 缺省 journal 的落盘目录；提供 journal 时可省略。两者皆无 → 创建拒绝。 */
  journalDir?: string;
  /** 注入的 journal 沉点（W2 Main 侧经引擎端口传入）；给出时不再打开 JSONL 文件。 */
  journal?: WorkflowJournalPort;
  adapter: WorkflowCallAdapter;
  runId?: string;
  deadlineMs?: number;
  /**
   * 续跑缓存（contentKey → 已提交结果与出处 runId；lane 命中附带祖先发布事实）。
   * 给出时跳过 buildResumeCache 的 journal 文件读取与 hash 校验——调用方
   * （Main 应用用例）已完成身份核对；仅 parentRunId 续跑生效，新建 run 忽略。
   */
  resumeCache?: Map<string, { result: unknown; fromRunId: string; publication?: WorkflowPublication }>;
  /** 测试缝：第 n 个 call_end 落盘后自动 stop（seq n+1 保证未派发）。 */
  stopAfterCalls?: number;
  workerUrl?: URL;
  /** Internal admission only: an aborted launch must dispose its newly ready VM before rejecting. */
  signal?: AbortSignal;
  /** W5：并发派发上限；缺省 LIMITS.MAX_CONCURRENT_CALLS，越界截断到 [1, 上限]（不报错）。 */
  maxConcurrentCalls?: number;
  /**
   * W7：本 run 授权的路由范围（Main 受理时下发；profileDir 只由宿主机适配器消费，内核不读）。
   * 存在时 opts.harness 必须落在成员 harnessId 集内（缺省解析到 defaultHarness），
   * 显式 opts.profile 必须是该 Harness 的成员 profileId；实际成员表由 adapter.resolveRoute 复核。
   * 缺省维持单适配器语义：harness 只能等于 adapter.harnessId，opts.profile 只记录不路由。
   */
  routeScope?: { defaultHarness: string; members: readonly { harnessId: string; profileId: string }[] };
  /** W6a：受理时建立的候选基线树，随 run 事件回显进 journal（续跑由调用方核对一致性）。 */
  baseTree?: string;
  /** W6a：候选发布面向的应用目标，随 run 事件回显。 */
  appTarget?: AppTarget;
  /**
   * W6a：lane 调用成功后的候选发布端口（callSeq → 已登记 publication）。
   * W8：返回联合扩展为 publication | conflict——conflict 使调用以 conflict 终态交付。
   * 在 call_end 之前由 lane 排干按 callSeq 顺序调用；缺失时 lane 调用不派发 attempt、
   * 直接以 internal 失败。
   */
  publishCandidate?: (callSeq: number, candidate: WorkflowCandidate) => Promise<WorkflowPublishOutcome>;
  /**
   * W8：lane 调用的工作区端口（callSeq → 登记基线树 + 物化文件集）。
   * lane 调用首次派发 attempt 前调用一次（重试复用同一结果）；缺失时与
   * publishCandidate 缺失同口径——lane 调用不派发、以 internal 失败。
   */
  laneWorkspace?: (callSeq: number) => Promise<WorkflowLaneWorkspace>;
}

export interface ResumeRunOptions extends CreateRunOptions {
  parentRunId: string;
}

export interface WorkflowRunResult {
  runId: string;
  status: 'completed' | 'failed' | 'stopped';
  failureCode?: RunFailureCode;
  result?: unknown;
}

const RETRYABLE: ReadonlySet<string> = new Set(['timeout', 'crash', 'empty_output', 'schema_mismatch']);

interface CallState {
  seq: number;
  registrationBatch: number;
  opId: number;
  prompt: unknown;
  ended: boolean;
  label: string | null;
  phase: string | null;
  contentKey: string;
  validated: ValidatedCall | null;
}

interface ValidatedCall {
  effective: EffectiveSemantics;
  schema: Record<string, unknown> | null;
  label: string | null;
  phase: string | null;
  tools: string[];
  timeoutMs: number;
  retries: number;
  /** W6a：派发与 journal 记录共用的实际隔离级别。 */
  isolation: WorkflowIsolation;
  /** W7：登记期解析并冻结的路由成员；适配器无 resolveRoute 时为 null（attempt_start 不记 route）。 */
  route: { harnessId: string; profileId: string } | null;
}

type Validation = { ok: true; call: ValidatedCall } | { ok: false; code: CallFailureCode; message: string };

type AttemptOutcome =
  | { kind: 'ok'; value: unknown; usage?: CallUsage; candidate?: WorkflowCandidate }
  | { kind: 'failed'; code: CallFailureCode; message: string }
  | { kind: 'stopped' };

interface Deliverable {
  opId: number;
  result: AgentResult;
  bytes: number;
}

/**
 * W8：物理完成但尚未按 callSeq 提交的 lane 终态事实。
 * publish 型在提交时才经 publishCandidate 端口决定 ok/conflict（合并按逻辑序号发生）。
 */
type PendingLaneEnd =
  | { kind: 'publish'; attempt: number; value: unknown; candidate: WorkflowCandidate }
  | { kind: 'plain'; status: 'failed' | 'stopped'; code: CallFailureCode | undefined; attempts: number; message: string }
  | { kind: 'cached'; result: unknown; fromRunId: string; publication?: WorkflowPublication };

export class WorkflowRun {
  readonly runId: string;
  /** Rejects only when adapter process cleanup is unconfirmed; the owner must retain reconciliation state. */
  readonly done: Promise<WorkflowRunResult>;
  private readonly kernel: Kernel;

  constructor(kernel: Kernel) {
    this.kernel = kernel;
    this.runId = kernel.runId;
    this.done = kernel.completion;
  }

  get status(): RunStatus {
    return this.kernel.status;
  }

  /** 用户停止等待所属清理；已确认才写终态，清理未确认与 done 同样拒绝并由 owner 保留占用。 */
  async stop(): Promise<WorkflowRunResult> {
    this.kernel.requestStop();
    return this.done;
  }
}

export async function createRun(options: CreateRunOptions): Promise<WorkflowRun> {
  const kernel = await Kernel.create(options, null);
  return new WorkflowRun(kernel);
}

export async function resumeRun(options: ResumeRunOptions): Promise<WorkflowRun> {
  const kernel = await Kernel.create(options, options.parentRunId);
  return new WorkflowRun(kernel);
}

class Kernel {
  readonly runId: string;
  status: RunStatus = 'running';
  readonly completion: Promise<WorkflowRunResult>;

  private readonly script: string;
  private readonly meta: ScriptMeta;
  private readonly args: unknown;
  private readonly scriptHash: string;
  private readonly argsHash: string;
  private readonly parentRunId: string | null;
  private readonly adapter: WorkflowCallAdapter;
  private readonly journal: WorkflowJournalPort;
  private readonly bridge: VmBridge;
  private readonly deadlineMs: number;
  private readonly stopAfterCalls: number | null;
  /** 并发派发上界（[1, LIMITS.MAX_CONCURRENT_CALLS]）。 */
  private readonly maxInFlight: number;
  /** 续跑祖先链缓存；命中即 cached。本轮内 ok 结果也写入（同轮去重，首到者胜）。 */
  private readonly cache: Map<string, { result: unknown; fromRunId: string; publication?: WorkflowPublication }> | null;
  /** W6a：run 级候选基线与应用目标，仅回显进 run 事件（业务事实由 Main 持有）。 */
  private readonly baseTree: string | null;
  private readonly appTarget: AppTarget | null;
  /** W6a/W8：lane 候选发布端口（publication | conflict 联合）；见 CreateRunOptions.publishCandidate。 */
  private readonly publishCandidate: ((callSeq: number, candidate: WorkflowCandidate) => Promise<WorkflowPublishOutcome>) | undefined;
  /** W8：lane 工作区端口；见 CreateRunOptions.laneWorkspace。 */
  private readonly laneWorkspace: ((callSeq: number) => Promise<WorkflowLaneWorkspace>) | undefined;
  /** W8：本 run 登记过的 lane 调用 seq（按 callSeq 升序，供排干定位最早未结束 lane）。 */
  private readonly laneSeqs: number[] = [];
  /** W8：物理已完成、等待按逻辑序号提交的 lane call_end（seq → 待提交事实）。 */
  private readonly pendingLaneEnds = new Map<number, PendingLaneEnd>();
  /** W8：排干循环防重入标记；排干期间新到 lane end 由循环自身拾取。 */
  private laneDraining = false;
  /** Every call_start in one VM outbox commits before that batch can dispatch, publish or deliver. */
  private registering = false;
  private registrationBatch = 0;
  /** W7：受理时下发的路由范围；null = 单适配器（opts.profile 只记录不路由）。 */
  private readonly routeScope: { defaultHarness: string; members: readonly { harnessId: string; profileId: string }[] } | null;

  private resolveDone!: (r: WorkflowRunResult) => void;
  private rejectDone!: (error: WorkflowCleanupUnconfirmedError) => void;
  private cleanupFailure: WorkflowCleanupUnconfirmedError | null = null;
  private readonly unconfirmedCalls = new Set<number>();
  private inbox: WorkerMessage[] = [];
  private draining = false;
  private finalized = false;
  private pendingFailure: RunFailureCode | null = null;
  private eventSeq = 0;
  private lastSeq = 0;
  private nextDeliverSeq = 1;
  private calls = new Map<number, CallState>();
  private pendingDispatch = new Set<number>();
  private deliverables = new Map<number, Deliverable>();
  private bufferedBytes = 0;
  /** 在途派发（物理并发）；交付与此表无关，仍按 nextDeliverSeq 顺序。 */
  private inFlight = new Set<number>();
  /** 每 seq 一个 AbortController；stop/失败时对在途全部 abort。 */
  private inFlightAborts = new Map<number, AbortController>();
  /** 推进循环的等待者：dispatch 完成/新交付物/停止/失败时统一唤醒。 */
  private progressWaiters = new Set<() => void>();
  private progressRunning = false;
  private deadlineTimer: ReturnType<typeof setTimeout> | null = null;

  private constructor(init: {
    runId: string;
    script: string;
    meta: ScriptMeta;
    args: unknown;
    scriptHash: string;
    argsHash: string;
    parentRunId: string | null;
    adapter: WorkflowCallAdapter;
    journal: WorkflowJournalPort;
    bridge: VmBridge;
    deadlineMs: number;
    stopAfterCalls: number | null;
    maxInFlight: number;
    cache: Map<string, { result: unknown; fromRunId: string; publication?: WorkflowPublication }> | null;
    baseTree: string | null;
    appTarget: AppTarget | null;
    publishCandidate: ((callSeq: number, candidate: WorkflowCandidate) => Promise<WorkflowPublishOutcome>) | undefined;
    laneWorkspace: ((callSeq: number) => Promise<WorkflowLaneWorkspace>) | undefined;
    routeScope: { defaultHarness: string; members: readonly { harnessId: string; profileId: string }[] } | null;
  }) {
    this.runId = init.runId;
    this.script = init.script;
    this.meta = init.meta;
    this.args = init.args;
    this.scriptHash = init.scriptHash;
    this.argsHash = init.argsHash;
    this.parentRunId = init.parentRunId;
    this.adapter = init.adapter;
    this.journal = init.journal;
    this.bridge = init.bridge;
    this.deadlineMs = init.deadlineMs;
    this.stopAfterCalls = init.stopAfterCalls;
    this.maxInFlight = init.maxInFlight;
    this.cache = init.cache;
    this.baseTree = init.baseTree;
    this.appTarget = init.appTarget;
    this.publishCandidate = init.publishCandidate;
    this.laneWorkspace = init.laneWorkspace;
    this.routeScope = init.routeScope;
    this.completion = new Promise((resolve, reject) => {
      this.resolveDone = resolve;
      this.rejectDone = reject;
    });
  }

  static async create(options: CreateRunOptions, parentRunId: string | null): Promise<Kernel> {
    options.signal?.throwIfAborted();
    // 加载拒绝路径：在进入运行、写 journal 之前抛出 WorkflowContractError。
    if (Buffer.byteLength(options.script, 'utf8') > LIMITS.SCRIPT_BYTES) {
      throw new WorkflowContractError('script_too_large', 'script exceeds 64 KiB');
    }
    const analyzed = analyzeScript(options.script);
    if (!analyzed.ok) {
      throw new WorkflowContractError('script_rejected', analyzed.reason, { line: analyzed.line, column: analyzed.column });
    }
    const args = options.args === undefined ? null : options.args;
    let argsCanonical: string;
    try {
      argsCanonical = canonical(args);
    } catch {
      throw new WorkflowContractError('invalid_args', 'args is not JSON-serializable');
    }
    if (Buffer.byteLength(argsCanonical, 'utf8') > LIMITS.ARGS_BYTES) {
      throw new WorkflowContractError('invalid_args', 'args exceeds 256 KiB');
    }
    const scriptHash = sha256Hex(options.script);
    const argsHash = sha256Hex(argsCanonical);
    if (options.baseTree !== undefined && !/^[a-f0-9]{40}$/.test(options.baseTree)) {
      throw new WorkflowContractError('invalid_args', 'baseTree must be a 40-char lowercase git tree id');
    }

    // 缓存只在续跑链上生效：注入 resumeCache 时调用方已完成 hash 校验，跳过文件重建。
    let cache: Map<string, { result: unknown; fromRunId: string; publication?: WorkflowPublication }> | null = null;
    if (parentRunId !== null) {
      if (options.resumeCache !== undefined) {
        cache = options.resumeCache;
      } else {
        if (options.journalDir === undefined) {
          throw new WorkflowContractError('invalid_args', 'journalDir is required to rebuild the resume cache');
        }
        cache = await Kernel.buildResumeCache(options.journalDir, parentRunId, scriptHash, argsHash);
      }
    }

    const runId = options.runId ?? randomUUID();
    let journal: WorkflowJournalPort;
    if (options.journal !== undefined) {
      journal = options.journal;
    } else {
      if (options.journalDir === undefined) {
        throw new WorkflowContractError('invalid_args', 'either journal or journalDir is required');
      }
      await mkdir(options.journalDir, { recursive: true });
      journal = await JsonlJournal.open(options.journalDir, runId);
    }
    const bridge = await VmBridge.spawn(options.workerUrl);
    if (options.signal?.aborted) {
      await bridge.dispose();
      await journal.close?.();
      options.signal.throwIfAborted();
    }
    const kernel = new Kernel({
      runId,
      script: options.script,
      meta: analyzed.meta,
      args,
      scriptHash,
      argsHash,
      parentRunId,
      adapter: options.adapter,
      journal,
      bridge,
      deadlineMs: options.deadlineMs ?? LIMITS.RUN_DEADLINE_MS,
      stopAfterCalls: options.stopAfterCalls ?? null,
      maxInFlight: clampConcurrency(options.maxConcurrentCalls),
      cache,
      baseTree: options.baseTree ?? null,
      appTarget: options.appTarget ?? null,
      publishCandidate: options.publishCandidate,
      laneWorkspace: options.laneWorkspace,
      routeScope: options.routeScope ?? null,
    });
    kernel.start();
    return kernel;
  }

  /** 近祖先优先建立 contentKey→ok-result 映射；scriptHash/argsHash 不一致 → resume_mismatch，不写 journal。 */
  private static async buildResumeCache(
    journalDir: string,
    parentRunId: string,
    scriptHash: string,
    argsHash: string,
  ): Promise<Map<string, { result: unknown; fromRunId: string; publication?: WorkflowPublication }>> {
    const cache = new Map<string, { result: unknown; fromRunId: string; publication?: WorkflowPublication }>();
    let ancestorId: string | null = parentRunId;
    let direct = true;
    while (ancestorId !== null) {
      let events: JournalEvent[];
      try {
        events = await readJournal(JsonlJournal.filePath(journalDir, ancestorId));
      } catch {
        throw new WorkflowContractError('resume_mismatch', `ancestor run ${ancestorId} has no journal`);
      }
      const runEvent = events.find((e) => e.t === 'run');
      if (!runEvent || runEvent.t !== 'run') {
        throw new WorkflowContractError('resume_mismatch', `ancestor run ${ancestorId} journal lacks run event`);
      }
      if (direct && (runEvent.scriptHash !== scriptHash || runEvent.argsHash !== argsHash)) {
        throw new WorkflowContractError('resume_mismatch', 'scriptHash or argsHash differ from parent run');
      }
      for (const e of events) {
        if (e.t === 'call_end' && (e.status === 'ok' || e.status === 'cached') && e.result !== undefined) {
          const start = findCallStart(events, e.callSeq);
          if (start && !cache.has(start.contentKey)) {
            // W6a：祖先 lane 调用的已提交 publication 随缓存项保留，续跑命中时原样回放。
            cache.set(start.contentKey, {
              result: e.result,
              fromRunId: e.cachedFromRunId ?? ancestorId,
              publication: e.publication,
            });
          }
        }
      }
      ancestorId = runEvent.parentRunId;
      direct = false;
    }
    return cache;
  }

  private start(): void {
    this.bridge.setHandlers({
      onMessage: (msg) => {
        if (this.finalized) return; // dispose 后的迟到消息：不抛、不写 journal、不动作
        this.inbox.push(msg);
        this.scheduleDrain();
      },
      onDead: (error) => {
        this.initiateFailure('internal_error', error?.message ?? 'vm worker died');
      },
    });
    this.deadlineTimer = setTimeout(() => this.initiateFailure('run_deadline_exceeded', 'run deadline exceeded'), this.deadlineMs);
    this.deadlineTimer.unref?.();
    void this.appendJournal({
      t: 'run',
      runId: this.runId,
      parentRunId: this.parentRunId,
      scriptHash: this.scriptHash,
      argsHash: this.argsHash,
      dslVersion: DSL_VERSION,
      status: 'running',
      baseTree: this.baseTree ?? undefined,
      appTarget: this.appTarget ?? undefined,
      // W9：meta.ultra === true 时回显（受理标记；零特权——不跳审批、不改预算、不改路由）。
      ...(this.meta.ultra === true ? { ultra: true } : {}),
    }).then((committed) => {
      // 首条 run 事件未落盘不进入执行：journal 失败已由 initiateFailure 标记。
      if (!committed) return;
      this.bridge.send({
        t: 'load',
        script: this.script,
        meta: this.meta,
        args: this.args,
        budgets: {
          heapBytes: LIMITS.VM_HEAP_BYTES,
          segmentMs: LIMITS.VM_SEGMENT_MS,
          totalMs: LIMITS.VM_TOTAL_MS,
          jobs: LIMITS.VM_JOBS,
        },
      });
    });
  }

  /**
   * 所有 journal 写入的唯一出口：append 拒绝 → run failed{internal_error}（§6），
   * 不让沉点异常逃逸成未处理拒绝，也不在失败后续写已不可信的记录。
   * 并发派发下 dispatch/交付与终态收尾可能交叠：finalized 之后一律不再发事件
   * （返回 false，调用方走既有失败分支且不产生新动作）；finalizeRun 内部经
   * { final: true } 写终态 call_end/run。
   */
  private async appendJournal(event: JournalEvent, opts?: { final?: boolean }): Promise<boolean> {
    if (this.finalized && !opts?.final) return false;
    try {
      await this.journal.append(event);
      return true;
    } catch (error) {
      const detail = error instanceof Error ? error.message : String(error);
      this.initiateFailure('internal_error', `journal append failed: ${detail}`);
      return false;
    }
  }

  requestStop(): void {
    if (this.status !== 'running' || this.pendingFailure !== null) return;
    this.status = 'stopping';
    for (const abort of this.inFlightAborts.values()) abort.abort();
    this.notifyProgress();
    this.scheduleDrain();
  }

  private isEnding(): boolean {
    return this.finalized || this.status === 'stopping' || this.pendingFailure !== null;
  }

  private scheduleDrain(): void {
    if (this.draining) return;
    this.draining = true;
    void this.runDrain();
  }

  private async runDrain(): Promise<void> {
    try {
      while (this.inbox.length > 0 && !this.finalized) {
        const msg = this.inbox.shift()!;
        await this.handleEvent(msg);
        // 派发与交付由独立的推进循环承担，不阻塞后续 outbox/settled 消息的处理。
        if (!this.isEnding()) this.scheduleProgress();
      }
    } finally {
      this.draining = false;
      await this.maybeFinalize();
      // maybeFinalize 的 await 窗口内到达的消息不能丢：排空后重新触发一轮。
      if (this.inbox.length > 0 && !this.finalized) this.scheduleDrain();
    }
  }

  private async handleEvent(msg: WorkerMessage): Promise<void> {
    if (msg.t === 'outbox') {
      this.registering = true;
      this.registrationBatch += 1;
      try {
        for (const item of msg.items) await this.handleOutboxItem(item);
      } finally {
        this.registering = false;
        this.notifyProgress();
        this.scheduleLaneDrain();
        this.scheduleProgress();
      }
      return;
    }
    if (msg.t !== 'settled') return;
    if (msg.ok) {
      // main 返回时仍有已登记未交付的调用（worker 报告的 pending deferred）→ script_error（合同 §3）。
      // 内核侧 nextDeliverSeq<=lastSeq 作为双重校验覆盖已交付前 settled 的到达序。
      if (msg.pendingCalls > 0 || this.nextDeliverSeq <= this.lastSeq) {
        this.initiateFailure('script_error', 'main settled with undelivered calls');
        return;
      }
      if (Buffer.byteLength(canonical(msg.value), 'utf8') > LIMITS.RESULT_BYTES) {
        // §6：最终返回 >1 MiB → run failed{result_too_large}（见 contract.ts RunFailureCode 备注）。
        this.initiateFailure('result_too_large', 'main result exceeds 1 MiB');
        return;
      }
      await this.finalizeRun({ runId: this.runId, status: 'completed', result: msg.value });
      return;
    }
    this.initiateFailure(mapVmError(msg.error), msg.error.message);
  }

  private async handleOutboxItem(item: OutboxItem): Promise<void> {
    switch (item.kind) {
      case 'phase':
        await this.appendJournal({ t: 'phase', runId: this.runId, seq: ++this.eventSeq, title: String(item.title) });
        return;
      case 'log':
        await this.appendJournal({ t: 'log', runId: this.runId, seq: ++this.eventSeq, message: String(item.message) });
        return;
      case 'warn':
        await this.appendJournal({
          t: 'warn',
          runId: this.runId,
          seq: ++this.eventSeq,
          code: String(item.code),
          message: String(item.message),
        });
        return;
      case 'call':
        await this.registerCall(item);
        return;
    }
  }

  private async registerCall(item: Extract<OutboxItem, { kind: 'call' }>): Promise<void> {
    const seq = ++this.lastSeq;
    const callId = `${this.runId}:c${seq}`;
    const currentPhase = typeof item.phase === 'string' ? item.phase : null;
    const rawOpts = isPlainObject(item.opts) ? item.opts : {};
    let validated = validateOpts(item.prompt, item.opts, new Set(this.meta.phases ?? []), this.adapter.harnessId, this.routeScope);
    if (
      validated.ok &&
      validated.call.isolation === 'lane' &&
      [...this.calls.values()].some(
        (call) => call.registrationBatch < this.registrationBatch && call.validated?.isolation === 'lane' && !call.ended,
      )
    ) {
      validated = {
        ok: false,
        code: 'unsupported_option',
        message: 'lane_not_serializable: previous lane wave has not finished publication',
      };
    }
    if (validated.ok) {
      // W7：派发前冻结有效执行语义——校验通过后、contentKey/call_start 之前解析路由。
      // 解析结果（含自动选择的 profile）进入调用身份：显式 profile 总进键，自动解析
      // 标记 profileAuto 一并进键；拒绝与校验失败同路径（call_start/call_end 照写不派发）。
      const resolved = this.adapter.resolveRoute?.({
        harness: validated.call.effective.harness,
        ...(validated.call.effective.profile !== undefined ? { profile: validated.call.effective.profile } : {}),
      });
      if (resolved !== undefined) {
        if ('code' in resolved) {
          validated = { ok: false, code: resolved.code, message: resolved.message };
        } else {
          validated.call.effective.profile = resolved.profileId;
          if (resolved.provenance === 'auto') validated.call.effective.profileAuto = true;
          validated.call.route = { harnessId: resolved.harnessId, profileId: resolved.profileId };
        }
      }
    }
    if (validated.ok) {
      // W9：登记期表达力核对——isolation+model/tier 组不出启动 argv 时按 unsupported_option
      // 在 attempt_start 之前拒绝（与校验/路由拒绝同路径：call_start/call_end 照写、不派发）。
      // 适配器未实现 checkExecution 时放行，由 run() 入口的 argv 组装兜底。
      const capable = this.adapter.checkExecution?.({
        harness: validated.call.effective.harness,
        ...(validated.call.effective.profile !== undefined ? { profile: validated.call.effective.profile } : {}),
        isolation: validated.call.isolation,
        ...(validated.call.effective.model !== undefined ? { model: validated.call.effective.model } : {}),
        ...(validated.call.effective.tier !== undefined ? { tier: validated.call.effective.tier } : {}),
      });
      if (capable !== null && capable !== undefined) {
        validated = { ok: false, code: capable.code, message: capable.message };
      }
    }
    const label = validated.ok ? validated.call.label : typeof rawOpts.label === 'string' ? rawOpts.label : null;
    const call: CallState = {
      seq,
      registrationBatch: this.registrationBatch,
      opId: item.opId,
      prompt: item.prompt,
      ended: false,
      label,
      phase: validated.ok ? (validated.call.phase ?? currentPhase) : currentPhase,
      contentKey: '',
      validated: validated.ok ? validated.call : null,
    };
    this.calls.set(seq, call);
    call.contentKey = contentKey({
      prompt: typeof item.prompt === 'string' ? item.prompt : canonical(item.prompt),
      effective: call.validated ? { ...call.validated.effective } : {},
      schema: call.validated?.schema ?? undefined,
      label,
      tools: call.validated?.tools ?? [],
      isolation: call.validated?.isolation ?? 'readonly',
    });
    await this.appendJournal({
      t: 'call_start',
      runId: this.runId,
      callSeq: seq,
      callId,
      phase: call.phase,
      label,
      contentKey: call.contentKey,
      effective: call.validated ? { ...call.validated.effective } : {},
      promptHash: sha256Hex(typeof item.prompt === 'string' ? item.prompt : canonical(item.prompt)),
      isolation: call.validated?.isolation ?? 'readonly',
    });

    // W8：lane 调用按登记序进入排干序列（lane identity = call_start 记录的有效隔离级别）。
    if (call.validated?.isolation === 'lane') this.laneSeqs.push(seq);

    // 预算内超支与校验失败同路径：照常 call_start/call_end，不派发。
    if (seq > LIMITS.CALL_BUDGET) {
      if (call.validated?.isolation === 'lane') {
        this.queueLaneEnd(seq, {
          kind: 'plain',
          status: 'failed',
          code: 'call_budget_exceeded',
          attempts: 0,
          message: 'call budget of 1000 exceeded',
        });
        return;
      }
      await this.endCall(call, 'failed', 'call_budget_exceeded', 0);
      this.enqueueDeliverable(call, {
        status: 'failed',
        code: 'call_budget_exceeded',
        message: 'call budget of 1000 exceeded',
        callId,
      });
      return;
    }
    if (!validated.ok) {
      await this.endCall(call, 'failed', validated.code, 0);
      this.enqueueDeliverable(call, { status: 'failed', code: validated.code, message: validated.message, callId });
      return;
    }

    const cached = this.cache?.get(call.contentKey);
    if (cached) {
      // W8：cached lane 走同一排干——回放 publication 按逻辑序号补齐本 run 的发布行。
      if (call.validated?.isolation === 'lane') {
        this.queueLaneEnd(seq, { kind: 'cached', result: cached.result, fromRunId: cached.fromRunId, publication: cached.publication });
        return;
      }
      call.ended = true;
      // W6a：lane 命中时回放祖先已提交 publication——Main journal 据此在同一事务
      // 插入 publications 行并 CAS 候选指针，续跑不重复执行副作用也不丢候选事实。
      await this.appendJournal({
        t: 'call_end',
        runId: this.runId,
        callSeq: seq,
        status: 'cached',
        result: cached.result,
        cachedFromRunId: cached.fromRunId,
        attempts: 0,
        publication: cached.publication,
      });
      if (this.stopAfterCalls !== null && seq === this.stopAfterCalls) this.requestStop();
      this.enqueueDeliverable(call, { status: 'ok', value: cached.result, callId });
      return;
    }

    this.pendingDispatch.add(seq);
  }

  /**
   * 推进调度器入口：drain、dispatch 完成、缓存命中入队等事件都可能推进状态；
   * 单纤维循环（progressRunning 防重入）保证 deliver 排干与派发窗口的检查顺序稳定。
   */
  private scheduleProgress(): void {
    if (this.registering || this.progressRunning || this.finalized) return;
    this.progressRunning = true;
    void this.runProgress();
  }

  private notifyProgress(): void {
    const waiters = [...this.progressWaiters];
    this.progressWaiters.clear();
    for (const resolve of waiters) resolve();
  }

  private waitProgress(): Promise<void> {
    return new Promise((resolve) => {
      this.progressWaiters.add(resolve);
    });
  }

  /**
   * 排干有序 deliverables（call_end 先于 deliver，严格按 callSeq），再按 inFlight 上界
   * 并发派发 pendingDispatch 中的 seq；dispatch 各自携带重试循环，不 await。
   * 无事可做且有在途调用时挂起等待 notifyProgress；完全静止（无在途无待派）时返回。
   */
  private async runProgress(): Promise<void> {
    try {
      while (!this.isEnding() && !this.registering) {
        while (!this.registering && this.deliverables.has(this.nextDeliverSeq) && !this.isEnding()) {
          const d = this.deliverables.get(this.nextDeliverSeq)!;
          this.deliverables.delete(this.nextDeliverSeq);
          this.bufferedBytes -= d.bytes;
          await this.appendJournal({ t: 'deliver', runId: this.runId, callSeq: this.nextDeliverSeq });
          while (this.registering && !this.isEnding()) await this.waitProgress();
          if (this.isEnding()) return;
          this.nextDeliverSeq += 1;
          this.bridge.send({ t: 'deliver', opId: d.opId, value: d.result });
        }
        while (!this.registering && !this.isEnding() && this.inFlight.size < this.maxInFlight && this.pendingDispatch.size > 0) {
          const seq = this.pendingDispatch.values().next().value!;
          // W8：lane 与 readonly 同享并发上界（固定波次——lane 物理并行，发布由排干保序）。
          // 测试缝语义保持：stopAfterCalls=n 时 seq n+1 保证不派发（并发下同样成立）。
          if (this.stopAfterCalls !== null && seq > this.stopAfterCalls) break;
          this.pendingDispatch.delete(seq);
          this.inFlight.add(seq);
          void this.dispatch(seq)
            .catch((error: unknown) => {
              if (error instanceof WorkflowCleanupUnconfirmedError) {
                this.recordUnconfirmedCleanup(seq, error);
                return;
              }
              // dispatch 内部已兜住沉点/适配器异常；逃逸的异常按内部失败收束，不让在途槽泄漏。
              this.initiateFailure(
                'internal_error',
                `dispatch for call ${seq} crashed: ${error instanceof Error ? error.message : String(error)}`,
              );
            })
            .finally(() => {
              this.inFlight.delete(seq);
              this.inFlightAborts.delete(seq);
              this.notifyProgress();
              this.scheduleProgress();
            });
        }
        if (this.pendingDispatch.size === 0 && this.inFlight.size === 0) return;
        await this.waitProgress();
      }
    } finally {
      this.progressRunning = false;
      // 推进循环退出可能正是收尾条件（在途清空 + stopping/failure）。
      await this.maybeFinalize();
      // 退出窗口内错过一次 notify 时不能停摆：仍有可推进事项就再起一轮。
      // 收尾期间（stopping/failure）不重排——在途完成的 .finally 各自触发 maybeFinalize，
      // 否则纯微任务自调度会饿死事件循环，让在途清理永远等不到宏任务。
      if (!this.isEnding() && (this.pendingDispatch.size > 0 || this.deliverables.has(this.nextDeliverSeq) || this.inFlight.size > 0)) {
        this.scheduleProgress();
      }
    }
  }

  private async dispatch(seq: number): Promise<void> {
    const call = this.calls.get(seq)!;
    const v = call.validated!;
    const callId = `${this.runId}:c${seq}`;
    const spec: WorkflowCall = {
      callId,
      prompt: typeof call.prompt === 'string' ? call.prompt : String(call.prompt),
      label: call.label,
      phase: call.phase,
      effective: v.effective,
      schema: v.schema,
      isolation: v.isolation,
      tools: v.tools,
      timeoutMs: v.timeoutMs,
    };
    // W6b：lane 调用要求 run 在受理期绑定受管 App；未绑定时不派发 attempt，
    // 以 unavailable 失败（区别于 internal——这是受理侧可预期的缺失目标）。
    if (v.isolation === 'lane' && this.appTarget === null) {
      this.queueLaneEnd(seq, {
        kind: 'plain',
        status: 'failed',
        code: 'unavailable',
        attempts: 0,
        message: 'lane call requires a managed App bound at run acceptance',
      });
      return;
    }
    // W6a/W8：发布通道或 lane 工作区通道不可用时 lane 调用注定失败——不派发 attempt，节省一次注定丢弃的执行。
    if (v.isolation === 'lane' && (this.publishCandidate === undefined || this.laneWorkspace === undefined)) {
      this.queueLaneEnd(seq, {
        kind: 'plain',
        status: 'failed',
        code: 'internal',
        attempts: 0,
        message: 'lane candidate publication or workspace channel is unavailable',
      });
      return;
    }
    // W8：lane attempt 工作区一次性获取——重试复用同一基线与输入，不重新物化。
    // 端口拒绝（工作区不可得）→ failed{unavailable}；其他失败 → failed{internal}。
    let laneBase: string | undefined;
    if (v.isolation === 'lane') {
      let workspace: WorkflowLaneWorkspace;
      try {
        workspace = await this.laneWorkspace!(seq);
      } catch (error) {
        const unavailable = (error as { code?: unknown })?.code === 'unavailable';
        this.queueLaneEnd(seq, {
          kind: 'plain',
          status: 'failed',
          code: unavailable ? 'unavailable' : 'internal',
          attempts: 0,
          message: `lane workspace unavailable: ${error instanceof Error ? error.message : String(error)}`,
        });
        return;
      }
      laneBase = workspace.baseTree;
      spec.laneInput = workspace.files;
    }
    const maxAttempts = 1 + v.retries;
    let attempt = 0;
    while (true) {
      attempt += 1;
      // abort 先于 attempt_start 落盘注册：inFlight.add→controller.set 全程同步，
      // stop()/失败到达时 inFlight 中的 seq 必然有已注册 controller 可 abort。
      const abort = new AbortController();
      this.inFlightAborts.set(seq, abort);
      const started = await this.appendJournal({
        t: 'attempt_start',
        runId: this.runId,
        callSeq: seq,
        attempt,
        isolation: v.isolation,
        // W7：记录该 attempt 实际派发的路由成员；无路由能力的适配器不写字段。
        ...(v.route !== null ? { route: v.route } : {}),
        // W8：记录该 lane attempt 的实际基线树（工作区端口的返回值）。
        ...(laneBase !== undefined ? { laneBase } : {}),
      });
      // journal 写不进时不派发新 attempt：未被记录的执行会破坏可恢复性。
      if (!started) {
        this.inFlightAborts.delete(seq);
        return;
      }
      const outcome = await this.runAttempt(spec, abort.signal);
      this.inFlightAborts.delete(seq);
      if (outcome.kind === 'stopped') {
        await this.appendJournal({ t: 'attempt_end', runId: this.runId, callSeq: seq, attempt, status: 'stopped' });
        if (v.isolation === 'lane') {
          this.queueLaneEnd(seq, { kind: 'plain', status: 'stopped', code: undefined, attempts: attempt, message: '' });
          return;
        }
        await this.endCall(call, 'stopped', undefined, attempt);
        return;
      }
      if (outcome.kind === 'ok') {
        await this.appendJournal({
          t: 'attempt_end',
          runId: this.runId,
          callSeq: seq,
          attempt,
          status: 'ok',
          ...(outcome.usage ? { usage: outcome.usage } : {}),
        });
        // W6a/W8：lane 成功 attempt 的候选先于 call_end 发布——publication/conflict 是
        // call_end 的一部分，缺失或拒绝都使调用以 internal 失败而不产生半提交状态。
        // W8 起发布经 pendingLaneEnds 按 callSeq 排干提交：物理完成可乱序，合并与
        // call_end 写入严格按逻辑序号。
        if (v.isolation === 'lane') {
          if (!outcome.candidate) {
            this.queueLaneEnd(seq, {
              kind: 'plain',
              status: 'failed',
              code: 'internal',
              attempts: attempt,
              message: 'lane adapter returned no candidate snapshot',
            });
            return;
          }
          this.queueLaneEnd(seq, { kind: 'publish', attempt, value: outcome.value, candidate: outcome.candidate });
          return;
        }
        await this.endCall(call, 'ok', undefined, attempt, outcome.value);
        if (this.cache && !this.cache.has(call.contentKey)) {
          this.cache.set(call.contentKey, { result: outcome.value, fromRunId: this.runId });
        }
        this.enqueueDeliverable(call, { status: 'ok', value: outcome.value, callId });
        return;
      }
      await this.appendJournal({
        t: 'attempt_end',
        runId: this.runId,
        callSeq: seq,
        attempt,
        status: 'failed',
        code: outcome.code,
      });
      if (RETRYABLE.has(outcome.code) && attempt < maxAttempts && !this.isEnding()) continue;
      if (v.isolation === 'lane') {
        this.queueLaneEnd(seq, {
          kind: 'plain',
          status: 'failed',
          code: outcome.code,
          attempts: attempt,
          message: outcome.message,
        });
        return;
      }
      await this.endCall(call, 'failed', outcome.code, attempt);
      this.enqueueDeliverable(call, { status: 'failed', code: outcome.code, message: outcome.message, callId });
      return;
    }
  }

  private async runAttempt(spec: WorkflowCall, signal: AbortSignal): Promise<AttemptOutcome> {
    const iterator = this.adapter.run(spec, signal)[Symbol.asyncIterator]();
    const aborted = new Promise<'aborted'>((resolve) => {
      if (signal.aborted) resolve('aborted');
      else signal.addEventListener('abort', () => resolve('aborted'), { once: true });
    });
    const timed = new Promise<'timeout'>((resolve) => {
      const t = setTimeout(() => resolve('timeout'), spec.timeoutMs);
      t.unref?.();
    });
    let nextFailure: unknown;
    const next = iterator.next().catch((error: unknown) => {
      nextFailure = error;
      throw error;
    });
    const first = await Promise.race([next, aborted, timed]);
    if (first === 'aborted' || first === 'timeout') {
      // A pending next can reject before its queued return resolves, even when
      // abort won the race. That cleanup receipt must not be lost.
      try {
        await iterator.return?.();
      } catch (error) {
        if (nextFailure instanceof WorkflowCleanupUnconfirmedError) throw nextFailure;
        throw error;
      }
      if (nextFailure instanceof WorkflowCleanupUnconfirmedError) throw nextFailure;
      return first === 'aborted'
        ? { kind: 'stopped' }
        : { kind: 'failed', code: 'timeout', message: `attempt exceeded ${spec.timeoutMs}ms` };
    }
    // 信号已在途时适配器可在首个 await 前直接 return（干净关闭、无终态事件）——语义仍是 stopped。
    if (first.done)
      return signal.aborted ? { kind: 'stopped' } : { kind: 'failed', code: 'internal', message: 'adapter produced no terminal event' };
    try {
      return this.mapTerminal(first.value, spec.schema);
    } catch (error) {
      return { kind: 'failed', code: 'crash', message: String((error as Error)?.message ?? error) };
    }
  }

  private mapTerminal(event: CallEvent, schema: Record<string, unknown> | null): AttemptOutcome {
    if (event.type === 'failed') return { kind: 'failed', code: event.code, message: event.message };
    const usage = event.usage === undefined ? {} : { usage: event.usage };
    // W6a：lane 适配器把 helper 采集的候选随 result 事件带回；readonly 携带的候选被忽略。
    const candidate = 'candidate' in event && event.candidate !== undefined ? { candidate: event.candidate } : {};
    if (event.type === 'result' && 'text' in event) {
      const text = event.text;
      if (Buffer.byteLength(text, 'utf8') > LIMITS.RESULT_BYTES) {
        return { kind: 'failed', code: 'result_too_large', message: 'call result exceeds 1 MiB' };
      }
      if (schema === null) return { kind: 'ok', value: text, ...usage, ...candidate };
      if (text.trim().length === 0) return { kind: 'failed', code: 'empty_output', message: 'empty text output with schema' };
      let parsed: unknown;
      try {
        parsed = JSON.parse(text);
      } catch {
        return { kind: 'failed', code: 'schema_mismatch', message: 'text output is not valid JSON for schema check' };
      }
      const check = validateSchema(parsed, schema);
      if (!check.ok) return { kind: 'failed', code: 'schema_mismatch', message: check.reason };
      return { kind: 'ok', value: parsed, ...usage, ...candidate };
    }
    const json = (event as { json: unknown }).json;
    if (Buffer.byteLength(canonical(json), 'utf8') > LIMITS.RESULT_BYTES) {
      return { kind: 'failed', code: 'result_too_large', message: 'call result exceeds 1 MiB' };
    }
    if (schema !== null) {
      const check = validateSchema(json, schema);
      if (!check.ok) return { kind: 'failed', code: 'schema_mismatch', message: check.reason };
    }
    return { kind: 'ok', value: json, ...usage, ...candidate };
  }

  private async endCall(
    call: CallState,
    status: 'ok' | 'failed' | 'stopped',
    code: CallFailureCode | undefined,
    attempts: number,
    result?: unknown,
    publication?: WorkflowPublication,
  ): Promise<void> {
    call.ended = true;
    await this.appendJournal({
      t: 'call_end',
      runId: this.runId,
      callSeq: call.seq,
      status,
      code,
      result,
      attempts,
      publication,
    });
    this.afterCallEnd(call);
  }

  /** call_end 提交后的共享钩子：stopAfterCalls=n 的测试缝在第 n 个 call_end 落盘后触发停止。 */
  private afterCallEnd(call: CallState): void {
    if (this.stopAfterCalls !== null && call.seq === this.stopAfterCalls && this.status === 'running') {
      this.requestStop();
    }
  }

  /**
   * W8：lane 终态先入 per-call 队列——物理完成可乱序，call_end（含合并发布）
   * 必须等所有 seq 更小的 lane call_end 提交后再写。入队即尝试排干。
   */
  private queueLaneEnd(seq: number, end: PendingLaneEnd): void {
    this.pendingLaneEnds.set(seq, end);
    this.scheduleLaneDrain();
  }

  private scheduleLaneDrain(): void {
    if (this.registering || this.laneDraining || this.finalized) return;
    this.laneDraining = true;
    void this.runLaneDrain();
  }

  /** 最早的未结束 lane 调用 seq；没有 lane 或全部结束为 null。 */
  private earliestOpenLaneSeq(): number | null {
    for (const seq of this.laneSeqs) {
      const call = this.calls.get(seq);
      if (call !== undefined && !call.ended) return seq;
    }
    return null;
  }

  /**
   * 排干循环：从最早的未结束 lane seq 起逐个提交其 call_end；最早 lane 仍在途
   * （无 queued end）则退出等待——它的 dispatch 完成时会经 queueLaneEnd 再次唤起。
   * 收尾（stopping/failure）期间不再启动新提交：在途 publish 完成后自然收口，
   * 剩余 queued end 由 finalizeRun 的 stopped 投影结清。不持锁、不重入。
   */
  private async runLaneDrain(): Promise<void> {
    try {
      while (!this.isEnding() && !this.registering) {
        const seq = this.earliestOpenLaneSeq();
        if (seq === null) return;
        const end = this.pendingLaneEnds.get(seq);
        if (end === undefined) return;
        this.pendingLaneEnds.delete(seq);
        await this.commitLaneEnd(seq, end);
      }
    } finally {
      this.laneDraining = false;
      await this.maybeFinalize();
      const next = this.earliestOpenLaneSeq();
      if (!this.isEnding() && next !== null && this.pendingLaneEnds.has(next)) this.scheduleLaneDrain();
    }
  }

  /** 提交单个 lane call_end：publish 型先经端口合并决定 ok/conflict，再写事件与交付物。 */
  private async commitLaneEnd(seq: number, end: PendingLaneEnd): Promise<void> {
    const call = this.calls.get(seq);
    if (call === undefined || call.ended || this.finalized) return;
    const callId = `${this.runId}:c${seq}`;
    if (end.kind === 'cached') {
      // W6a/W8：回放祖先已提交 publication——Main 据此在同一事务补登本 run 的发布行。
      const committed = await this.appendJournal({
        t: 'call_end',
        runId: this.runId,
        callSeq: seq,
        status: 'cached',
        result: end.result,
        cachedFromRunId: end.fromRunId,
        attempts: 0,
        publication: end.publication,
      });
      if (!committed) return;
      call.ended = true;
      this.afterCallEnd(call);
      this.enqueueDeliverable(call, { status: 'ok', value: end.result, callId });
      return;
    }
    if (end.kind === 'plain') {
      const committed = await this.appendJournal({
        t: 'call_end',
        runId: this.runId,
        callSeq: seq,
        status: end.status,
        code: end.code,
        attempts: end.attempts,
      });
      if (!committed) return;
      call.ended = true;
      this.afterCallEnd(call);
      if (end.status === 'failed') {
        this.enqueueDeliverable(call, { status: 'failed', code: end.code!, message: end.message, callId });
      }
      return;
    }
    // publish 型：合并发布端口返回 publication 或 conflict；conflict 不重试（终态）。
    let outcome: WorkflowPublishOutcome;
    try {
      outcome = await this.publishCandidate!(seq, end.candidate);
    } catch (error) {
      if (call.ended || this.finalized) return;
      const committed = await this.appendJournal({
        t: 'call_end',
        runId: this.runId,
        callSeq: seq,
        status: 'failed',
        code: 'internal',
        attempts: end.attempt,
      });
      if (!committed) return;
      call.ended = true;
      this.afterCallEnd(call);
      this.enqueueDeliverable(call, {
        status: 'failed',
        code: 'internal',
        message: `lane candidate publication failed: ${error instanceof Error ? error.message : String(error)}`,
        callId,
      });
      return;
    }
    if (call.ended || this.finalized) return;
    if ('conflict' in outcome) {
      // W8：合并冲突——候选已保留为孤立对象，指针不动；调用以 conflict 终态交付（非失败）。
      const committed = await this.appendJournal({
        t: 'call_end',
        runId: this.runId,
        callSeq: seq,
        status: 'conflict',
        attempts: end.attempt,
        conflictFiles: outcome.conflict.files,
        candidateRef: outcome.conflict.candidateRef,
      });
      if (!committed) return;
      call.ended = true;
      this.afterCallEnd(call);
      this.enqueueDeliverable(call, {
        status: 'conflict',
        files: outcome.conflict.files,
        candidateRef: outcome.conflict.candidateRef,
        callId,
      });
      return;
    }
    const publication = outcome.publication;
    const committed = await this.appendJournal({
      t: 'call_end',
      runId: this.runId,
      callSeq: seq,
      status: 'ok',
      result: end.value,
      attempts: end.attempt,
      publication,
    });
    if (!committed) return;
    call.ended = true;
    this.afterCallEnd(call);
    if (this.cache && !this.cache.has(call.contentKey)) {
      this.cache.set(call.contentKey, { result: end.value, fromRunId: this.runId, publication });
    }
    this.enqueueDeliverable(call, { status: 'ok', value: end.value, callId });
  }

  private enqueueDeliverable(call: CallState, result: AgentResult): void {
    const bytes = Buffer.byteLength(canonical(result), 'utf8');
    this.deliverables.set(call.seq, { opId: call.opId, result, bytes });
    this.bufferedBytes += bytes;
    this.notifyProgress();
    this.scheduleProgress();
    if (this.bufferedBytes > LIMITS.BRIDGE_BUFFER_BYTES) {
      this.initiateFailure('bridge_buffer_exceeded', 'delivery buffer exceeds 16 MiB');
    }
  }

  private initiateFailure(code: RunFailureCode, _message?: string): void {
    if (this.finalized || this.pendingFailure !== null || this.cleanupFailure !== null) return;
    this.pendingFailure = code;
    for (const abort of this.inFlightAborts.values()) abort.abort();
    this.notifyProgress();
    this.scheduleDrain();
  }

  private recordUnconfirmedCleanup(seq: number, error: WorkflowCleanupUnconfirmedError): void {
    this.cleanupFailure ??= error;
    this.unconfirmedCalls.add(seq);
    this.status = 'stopping';
    for (const abort of this.inFlightAborts.values()) abort.abort();
    this.notifyProgress();
    this.scheduleDrain();
  }

  private async finalizeUnconfirmedCleanup(error: WorkflowCleanupUnconfirmedError): Promise<void> {
    this.finalized = true;
    if (this.deadlineTimer) clearTimeout(this.deadlineTimer);
    try {
      for (const call of this.calls.values()) {
        if (!call.ended && !this.unconfirmedCalls.has(call.seq)) {
          call.ended = true;
          await this.appendJournal({ t: 'call_end', runId: this.runId, callSeq: call.seq, status: 'stopped' }, { final: true });
        }
      }
      await this.bridge.dispose();
      await this.journal.close?.();
    } catch (cause) {
      error = new WorkflowCleanupUnconfirmedError(
        `${error.message}; runtime cleanup failed: ${cause instanceof Error ? cause.message : String(cause)}`,
      );
    }
    // No ordinary run terminal can assert ownership was settled. The Main owner
    // receives this rejection after every remaining attempt/publication settled.
    this.rejectDone(error);
  }

  private async maybeFinalize(): Promise<void> {
    if (this.finalized || this.registering || this.laneDraining || this.inFlight.size !== 0) return;
    if (this.cleanupFailure !== null) {
      await this.finalizeUnconfirmedCleanup(this.cleanupFailure);
      return;
    }
    if (this.status !== 'stopping' && this.pendingFailure === null) return;
    const outcome: WorkflowRunResult = this.pendingFailure
      ? { runId: this.runId, status: 'failed', failureCode: this.pendingFailure }
      : { runId: this.runId, status: 'stopped' };
    await this.finalizeRun(outcome);
  }

  private async finalizeRun(outcome: WorkflowRunResult): Promise<void> {
    if (this.finalized) return;
    this.finalized = true;
    if (this.deadlineTimer) clearTimeout(this.deadlineTimer);
    this.status = outcome.status;
    for (const call of this.calls.values()) {
      if (!call.ended) {
        call.ended = true;
        await this.appendJournal({ t: 'call_end', runId: this.runId, callSeq: call.seq, status: 'stopped' }, { final: true });
      }
    }
    await this.bridge.dispose();
    await this.appendJournal(
      {
        t: 'run',
        runId: this.runId,
        parentRunId: this.parentRunId,
        scriptHash: this.scriptHash,
        argsHash: this.argsHash,
        dslVersion: DSL_VERSION,
        status: outcome.status,
        failureCode: outcome.failureCode,
        result: outcome.result,
        baseTree: this.baseTree ?? undefined,
        appTarget: this.appTarget ?? undefined,
        ...(this.meta.ultra === true ? { ultra: true } : {}),
      },
      { final: true },
    );
    await this.journal.close?.();
    this.resolveDone(outcome);
  }
}

/** 并发上限收敛：缺省/非法值回落到 LIMITS 上限；越界截断到 [1, MAX_CONCURRENT_CALLS]。 */
function clampConcurrency(value: number | undefined): number {
  if (value === undefined || !Number.isFinite(value)) return LIMITS.MAX_CONCURRENT_CALLS;
  return Math.min(LIMITS.MAX_CONCURRENT_CALLS, Math.max(1, Math.trunc(value)));
}

function findCallStart(events: JournalEvent[], callSeq: number) {
  return events.find((e): e is Extract<JournalEvent, { t: 'call_start' }> => e.t === 'call_start' && e.callSeq === callSeq);
}

function mapVmError(error: { name: string; message: string; code?: string }): RunFailureCode {
  const runCodes: ReadonlySet<string> = new Set([
    'vm_out_of_memory',
    'vm_cpu_segment',
    'vm_budget_exceeded',
    'jobs_budget_exceeded',
    'bridge_buffer_exceeded',
    'run_deadline_exceeded',
    'result_too_large',
    'internal_error',
  ]);
  if (error.code && runCodes.has(error.code)) return error.code as RunFailureCode;
  if (error.name === 'WorkflowContractError') return 'contract_violation';
  return 'script_error';
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) return false;
  const proto = Object.getPrototypeOf(value);
  return proto === Object.prototype || proto === null;
}

function containsKeyDeep(value: unknown, keys: Set<string>): boolean {
  if (Array.isArray(value)) return value.some((v) => containsKeyDeep(v, keys));
  if (isPlainObject(value)) {
    for (const k of Object.keys(value)) {
      if (keys.has(k) || containsKeyDeep(value[k], keys)) return true;
    }
  }
  return false;
}

function validateOpts(
  prompt: unknown,
  opts: unknown,
  declaredPhases: Set<string>,
  adapterId: string,
  routeScope: { defaultHarness: string; members: readonly { harnessId: string; profileId: string }[] } | null,
): Validation {
  const bad = (code: CallFailureCode, message: string): Validation => ({ ok: false, code, message });
  if (typeof prompt !== 'string' || prompt.length === 0 || Buffer.byteLength(prompt, 'utf8') > LIMITS.PROMPT_BYTES) {
    return bad('invalid_args', 'prompt must be a non-empty string <= 32 KiB');
  }
  const o = opts === undefined ? {} : opts;
  if (!isPlainObject(o)) return bad('invalid_args', 'opts must be a plain object');

  // W7：有路由范围时 harness 闭集为成员表的 harnessId（缺省 defaultHarness）；
  // 无范围时维持单适配器口径（只能等于 adapter.harnessId）。
  const scopeHarnesses = routeScope === null ? null : new Set(routeScope.members.map((member) => member.harnessId));
  const harness = o.harness === undefined ? (routeScope?.defaultHarness ?? adapterId) : o.harness;
  if (typeof harness !== 'string') return bad('invalid_args', 'opts.harness must be a string');
  if (scopeHarnesses === null) {
    if (harness !== adapterId) return bad('unsupported_option', `harness ${String(harness)} is not registered in P0a`);
  } else if (!scopeHarnesses.has(harness)) {
    return bad('unsupported_option', `harness ${String(harness)} is not in the run route scope`);
  }

  if (o.profile !== undefined && (typeof o.profile !== 'string' || o.profile.length > LIMITS.PROFILE_CHARS)) {
    return bad('invalid_args', 'opts.profile must be a string <= 64 chars');
  }
  if (scopeHarnesses !== null && typeof o.profile === 'string' && routeScope !== null) {
    // 显式 Profile 必须是该 Harness 的授权成员；越界即拒绝（路由范围属运行授权，不静默降级）。
    const memberProfiles = new Set(routeScope.members.filter((member) => member.harnessId === harness).map((member) => member.profileId));
    if (!memberProfiles.has(o.profile)) {
      return bad('unsupported_option', `profile ${o.profile} is not a route member of harness ${harness}`);
    }
  }
  if (o.model !== undefined && o.tier !== undefined) return bad('invalid_args', 'opts.model and opts.tier are mutually exclusive');
  if (o.tier !== undefined && o.tier !== 'small' && o.tier !== 'medium' && o.tier !== 'big') {
    return bad('invalid_args', 'opts.tier must be small|medium|big');
  }
  if (o.model !== undefined && (typeof o.model !== 'string' || o.model.length > LIMITS.MODEL_CHARS)) {
    return bad('invalid_args', 'opts.model must be a string <= 64 chars');
  }

  let schema: Record<string, unknown> | null = null;
  if (o.schema !== undefined) {
    if (!isPlainObject(o.schema)) return bad('schema_invalid', 'opts.schema must be a JSON object');
    if (Buffer.byteLength(canonical(o.schema), 'utf8') > LIMITS.SCHEMA_BYTES) {
      return bad('schema_invalid', 'opts.schema exceeds 32 KiB');
    }
    if (containsKeyDeep(o.schema, new Set(['$ref', '$dynamicRef']))) {
      return bad('schema_invalid', 'opts.schema must not contain $ref/$dynamicRef');
    }
    schema = o.schema;
  }

  if (o.isolation !== undefined) {
    if (typeof o.isolation !== 'string') return bad('invalid_args', 'opts.isolation must be a string');
    // W6a：字面量集合为 readonly|lane；parallel/pipeline 位置约束由 analyze 静态拒绝，
    // 动态取值落到此处仍以 unsupported_option 兜底。
    if (o.isolation !== 'readonly' && o.isolation !== 'lane') {
      return bad('unsupported_option', `isolation ${o.isolation} is not supported`);
    }
  }

  if (o.label !== undefined && (typeof o.label !== 'string' || o.label.length > LIMITS.LABEL_CHARS)) {
    return bad('invalid_args', 'opts.label must be a string <= 128 chars');
  }
  if (o.phase !== undefined && (typeof o.phase !== 'string' || !declaredPhases.has(o.phase))) {
    return bad('invalid_args', 'opts.phase must be declared in meta.phases');
  }
  if (
    o.timeoutMs !== undefined &&
    (typeof o.timeoutMs !== 'number' ||
      !Number.isInteger(o.timeoutMs) ||
      o.timeoutMs < LIMITS.CALL_TIMEOUT_MIN_MS ||
      o.timeoutMs > LIMITS.CALL_TIMEOUT_MAX_MS)
  ) {
    return bad('invalid_args', 'opts.timeoutMs must be an integer in [1000, 300000]');
  }
  if (
    o.retries !== undefined &&
    (typeof o.retries !== 'number' || !Number.isInteger(o.retries) || o.retries < 0 || o.retries > LIMITS.RETRIES_MAX)
  ) {
    return bad('invalid_args', 'opts.retries must be an integer in [0, 5]');
  }
  if (o.tools !== undefined) {
    if (
      !Array.isArray(o.tools) ||
      o.tools.length > LIMITS.TOOLS_MAX ||
      o.tools.some((t) => typeof t !== 'string' || t.length > LIMITS.TOOL_CHARS)
    ) {
      return bad('invalid_args', 'opts.tools must be a string[] <= 32 items, each <= 64 chars');
    }
  }

  const effective: EffectiveSemantics = { harness };
  if (typeof o.profile === 'string') effective.profile = o.profile;
  if (typeof o.model === 'string') effective.model = o.model;
  if (o.tier === 'small' || o.tier === 'medium' || o.tier === 'big') effective.tier = o.tier;
  const tools = (o.tools as string[] | undefined) ?? [];
  if (o.tools !== undefined) effective.tools = tools;
  return {
    ok: true,
    call: {
      effective,
      schema,
      label: typeof o.label === 'string' ? o.label : null,
      phase: typeof o.phase === 'string' ? o.phase : null,
      tools,
      timeoutMs: typeof o.timeoutMs === 'number' ? o.timeoutMs : LIMITS.CALL_TIMEOUT_DEFAULT_MS,
      retries: typeof o.retries === 'number' ? o.retries : 0,
      isolation: o.isolation === 'lane' ? 'lane' : 'readonly',
      route: null,
    },
  };
}

/**
 * 内部 JSON Schema 子集校验器：type / properties / required / items / enum / const /
 * additionalProperties(false) / anyOf / oneOf；其余关键字按 JSON Schema 惯例忽略，$ref 已在派发前拒绝。
 */
function validateSchema(value: unknown, schema: Record<string, unknown>, path = '$'): { ok: true } | { ok: false; reason: string } {
  const fail = (reason: string) => ({ ok: false as const, reason: `${path}: ${reason}` });
  if (schema.const !== undefined && !deepEqual(value, schema.const)) return fail('const mismatch');
  if (Array.isArray(schema.enum) && !schema.enum.some((e) => deepEqual(e, value))) return fail('enum mismatch');
  if (Array.isArray(schema.anyOf)) {
    const matches = schema.anyOf.filter((s) => isPlainObject(s) && validateSchema(value, s, path).ok);
    if (matches.length === 0) return fail('anyOf: no branch matched');
  }
  if (Array.isArray(schema.oneOf)) {
    const matches = schema.oneOf.filter((s) => isPlainObject(s) && validateSchema(value, s, path).ok);
    if (matches.length !== 1) return fail(`oneOf: ${matches.length} branches matched`);
  }
  if (schema.type !== undefined) {
    const types = Array.isArray(schema.type) ? schema.type : [schema.type];
    if (!types.some((t) => matchesType(value, t))) return fail(`type mismatch, expected ${JSON.stringify(schema.type)}`);
  }
  if (isPlainObject(value)) {
    if (Array.isArray(schema.required)) {
      for (const key of schema.required) {
        if (typeof key === 'string' && !Object.prototype.hasOwnProperty.call(value, key)) return fail(`missing required ${key}`);
      }
    }
    if (isPlainObject(schema.properties)) {
      for (const key of Object.keys(schema.properties)) {
        if (Object.prototype.hasOwnProperty.call(value, key) && isPlainObject(schema.properties[key])) {
          const r = validateSchema(value[key], schema.properties[key], `${path}.${key}`);
          if (!r.ok) return r;
        }
      }
    }
    if (schema.additionalProperties === false && isPlainObject(schema.properties)) {
      for (const key of Object.keys(value)) {
        if (!(key in schema.properties)) return fail(`additional property ${key}`);
      }
    }
  }
  if (Array.isArray(value) && isPlainObject(schema.items)) {
    for (let i = 0; i < value.length; i++) {
      const r = validateSchema(value[i], schema.items, `${path}[${i}]`);
      if (!r.ok) return r;
    }
  }
  return { ok: true };
}

function matchesType(value: unknown, type: unknown): boolean {
  switch (type) {
    case 'object':
      return value !== null && typeof value === 'object' && !Array.isArray(value);
    case 'array':
      return Array.isArray(value);
    case 'string':
      return typeof value === 'string';
    case 'number':
      return typeof value === 'number' && Number.isFinite(value);
    case 'integer':
      return typeof value === 'number' && Number.isInteger(value);
    case 'boolean':
      return typeof value === 'boolean';
    case 'null':
      return value === null;
    default:
      return false;
  }
}

function deepEqual(a: unknown, b: unknown): boolean {
  return canonical(a) === canonical(b);
}
