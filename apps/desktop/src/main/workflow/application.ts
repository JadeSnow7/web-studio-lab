import { randomUUID } from 'node:crypto';
import {
  WORKFLOW_DSL_VERSION,
  type AppSource,
  type AppSourceApplyResult,
  type AppSourceSnapshot,
  type AppSourceSnapshotResult,
  type AppTarget,
  type CapturedSourceChange,
  type WorkflowCacheEntry,
  type WorkflowInputFile,
  type WorkflowJournalEvent,
  type RouteScopeMember,
  type WorkflowPublication,
  type WorkflowRouteScope,
  type WorkflowRunInput,
  type WorkflowUsage,
} from '@wsl/protocol';
import { WorkflowProcessUnconfirmedError } from './engine-port';
import type { WorkflowEnginePort, WorkflowEngineRunHandle, WorkflowEngineRunSpec, WorkflowPublishResult } from './engine-port';
import { scriptDeclaresLane } from './commands';
import {
  canonical,
  WORKFLOW_RECOVERY_STATUS,
  WORKFLOW_TERMINAL_RUN_STATUSES,
  WorkflowJournalError,
  workflowArgsHash,
  workflowScriptHash,
  type SqliteWorkflowJournal,
  type WorkflowCandidateState,
  type WorkflowRunRow,
} from './journal-sqlite';

/**
 * Main 任务职责下的 workflow 应用用例（设计 §1/§7）：幂等受理、P0 并发 1、
 * 续跑身份校验、已提交结果复用、进程未确认拒绝续跑。Electron 无关。
 */

export type WorkflowApplicationErrorCode =
  | 'request_conflict'
  | 'run_busy'
  | 'run_not_found'
  | 'run_not_resumable'
  | 'resume_mismatch'
  | 'process_unconfirmed'
  | 'journal_schema_unsupported'
  | 'engine_rejected'
  /** W6b：run 无已发布候选（或未绑定可应用的目标）。 */
  | 'candidate_unavailable'
  /** W6b：受管 App 不存在、未确认或源码服务不可用。 */
  | 'app_unavailable'
  /** W6b：工程写租约被占或 App 生命周期操作在途。 */
  | 'project_busy'
  /** W6b：应用源码已偏离候选基线（有第三方写入），拒绝应用。 */
  | 'apply_conflict'
  /** W6b：helper/传输失败或快照不可复核；候选未写入或写入未确认。 */
  | 'apply_failed'
  | 'internal_error';

export class WorkflowApplicationError extends Error {
  readonly code: WorkflowApplicationErrorCode;

  constructor(code: WorkflowApplicationErrorCode, message?: string) {
    super(message ?? code);
    this.name = 'WorkflowApplicationError';
    this.code = code;
  }
}

export interface WorkflowRunRequest {
  requestId: string;
  script: string;
  args?: unknown;
  deadlineMs?: number;
  /** run 级冻结输入（W3/W4）：由 service 侧适配器在每次 attempt 物化到独立目录。 */
  input?: WorkflowRunInput;
  /**
   * W6a：候选发布面向的应用目标；缺省为合成 workflow 身份。
   * 候选快照属于该目标，基线/发布都在 candidateStore 内对同一目标核对。
   */
  appTarget?: AppTarget;
  /** 记录到 runs.engine 的执行器标识；缺省 'kernel'。 */
  engine?: string;
}

export interface WorkflowResumeRequest extends WorkflowRunRequest {
  parentWorkflowRunId: string;
}

export interface WorkflowRunAccepted {
  workflowRunId: string;
  scriptHash: string;
  argsHash: string;
}

export interface WorkflowStatusProjection {
  runId: string;
  status: string;
  failureCode: string | null;
  result?: unknown;
  calls: {
    seq: number;
    label: string | null;
    status: string;
    code: string | null;
    attempts: number;
    phase: string | null;
    /** cached 调用回溯到原始成功 runId；非 cached 为 null。 */
    cachedFromRunId: string | null;
    /** 最近一次报告的 attempt 用量；未提供为 null（unknown，不记 0）。 */
    usage: WorkflowUsage | null;
    /** W8：conflict 终态的冲突文件清单与保留候选树；非 conflict 缺省。 */
    conflictFiles?: string[];
    candidateRef?: string;
  }[];
  /** phase/log/warn 的尾部投影（最多 200 条），供详情视图日志区。 */
  logTail: { seq: number; kind: 'phase' | 'log' | 'warn'; text: string }[];
  /** W6a：run 的候选投影；无候选能力或无发布时为缺省。 */
  candidate?: WorkflowCandidateState;
  /** W6b：命令卡元数据副本与本次执行绑定的受管 App（null = 无绑定；lane 调用得 unavailable）。 */
  requiresApp: boolean;
  writes: boolean;
  appTarget: AppTarget | null;
}

/**
 * W6a：候选快照存储端口——Lab 管理的 Git 对象仓（RunSourceRepository 直接满足）。
 * createBaseline 在受理时建立 run 基线；captureCandidate 对同一基线按 callSeq 快照。
 * 快照只进 Lab 管理存储，绝不触碰用户 checkout/HEAD/index。
 */
export interface WorkflowCandidateStore {
  createBaseline(runId: string, snapshot: AppSourceSnapshot): Promise<{ baseTree: string }>;
  captureCandidate(runId: string, callSeq: number, baseTree: string, snapshot: AppSourceSnapshot): Promise<CapturedSourceChange>;
  /** W6b：读取某次 lane 发布保存的 diff（`source-{callSeq}.patch`），按 sha256 校验。 */
  readCandidatePatch?(runId: string, callSeq: number, patchSha256: string): Promise<string>;
  /** W6b：把候选树物化为 app.source.apply 消费的扁平文件列表。 */
  materialize?(runId: string, treeId: string, signal?: AbortSignal): Promise<AppSource['files']>;
  /** W6b：以候选树相同的 100644 约定计算活体源码的 tree-id。 */
  computeTree?(runId: string, snapshot: AppSourceSnapshot, signal?: AbortSignal): Promise<string>;
  /**
   * W8：lane 候选的文件级三向合并（B=调用登记基线，candidate=lane 采集树，P=当前指针）。
   * 返回合并树或冲突文件清单；不 touch 工作区/HEAD/真实 index。缺省 → run 无波次合并能力。
   */
  mergeCandidate?(
    runId: string,
    callSeq: number,
    baseTree: string,
    candidateTree: string,
    pointerTree: string,
    signal?: AbortSignal,
  ): Promise<{ merged: string } | { conflict: { files: string[] } }>;
}

/** W6b：puerto de源码 del App（快照 + aplicación）；apply/patch lo requieren。 */
export interface WorkflowAppSourcePort {
  snapshot(target: AppTarget, signal: AbortSignal): Promise<AppSourceSnapshotResult>;
  apply(target: AppTarget, files: AppSource['files'], signal: AbortSignal): Promise<AppSourceApplyResult>;
}

/** 请求未声明 appTarget 时的合成 workflow 目标（固定值——候选归属不依赖宿主项目）。 */
const DEFAULT_APP_TARGET: AppTarget = { workspaceId: 'workflow', projectId: '00000000-0000-0000-0000-000000000000' };

/**
 * W7：未显式声明 harness 的调用的解析起点——当前真实矩阵只有 codex native
 * （claude-code 是 ACP spec-harness，进不了 workflow 路由成员表）。
 */
const WORKFLOW_DEFAULT_HARNESS = 'codex';

export interface WorkflowApplicationDeps {
  journal: SqliteWorkflowJournal;
  engine: WorkflowEnginePort;
  /** W6a：lane 候选快照存储；缺省时 run 无候选能力（lane 发布按 internal_error 拒绝）。 */
  candidateStore?: WorkflowCandidateStore;
  /** W6b：受理期解析受管 App（WorkbenchApplication.managedAppTarget）；缺省 → lane 永不绑定。 */
  appResolver?: () => AppTarget | null;
  /** W6b：App 源码端口；lane 绑定的受理快照与 applyCandidate 都需要它。 */
  appSource?: WorkflowAppSourcePort;
  /** W6b：工程写租约（WorkbenchApplication.acquireProjectWriter）——apply 的快照/应用临界区。 */
  acquireWriter?: (projectId: string, ownerId: string) => { release(): void } | null;
  /** W6b：App 侧阻塞理由（WorkbenchApplication.projectWriteBlocker）：'busy:'/'unavailable:' 前缀。 */
  appBusy?: (target: AppTarget) => string | null;
  /**
   * W7：受理时的路由范围提供者——从 Profile 快照取可进 workflow 的 Harness × Profile 成员。
   * 缺省 → spec 不带 routeScope，service 维持单适配器（opts.profile 只记录不路由）。
   * 每次受理调用时取快照：Profile 增删在两次 run 之间生效，单次 run 内范围冻结。
   */
  routeScopeProvider?: () => RouteScopeMember[];
  now?: () => number;
  /** 每条 journal 事件落盘提交后回调（W4：Main 据此向 renderer 推 workflow:update tick）。 */
  onEvent?: (runId: string) => void;
}

const TERMINAL: ReadonlySet<string> = new Set(WORKFLOW_TERMINAL_RUN_STATUSES);

export class WorkflowApplication {
  private readonly journal: SqliteWorkflowJournal;
  private readonly engine: WorkflowEnginePort;
  private readonly candidateStore: WorkflowCandidateStore | undefined;
  private readonly appResolver: (() => AppTarget | null) | undefined;
  private readonly appSource: WorkflowAppSourcePort | undefined;
  private readonly acquireWriter: ((projectId: string, ownerId: string) => { release(): void } | null) | undefined;
  private readonly appBusy: ((target: AppTarget) => string | null) | undefined;
  private readonly routeScopeProvider: (() => RouteScopeMember[]) | undefined;
  private readonly now: () => number;
  private readonly onEvent: ((runId: string) => void) | undefined;
  /** runId → 在途引擎句柄；done 落定即移除，finished/未知 run 的 stop 为 no-op。 */
  private readonly handles = new Map<string, WorkflowEngineRunHandle>();
  /** W6a/W8：runId:callSeq → publishCandidate 已登记事实（{publication}|{conflict} canonical）；call_end 到达时逐位核对。 */
  private readonly pendingCandidates = new Map<string, string>();
  private closing = false;
  private readonly ownedOperations = new Map<Promise<unknown>, AbortController>();
  private shutdownAttempt: Promise<void> | undefined;
  private readonly unconfirmedAdmissions = new Map<string, Error>();
  private remoteShutdown: Promise<void> | undefined;

  private owned<T>(operation: (signal: AbortSignal) => Promise<T>): Promise<T> {
    this.assertOpen();
    const controller = new AbortController();
    const pending = operation(controller.signal);
    this.ownedOperations.set(pending, controller);
    void pending.then(
      () => this.ownedOperations.delete(pending),
      () => this.ownedOperations.delete(pending),
    );
    return pending;
  }

  private assertOpen(): void {
    if (this.closing) throw new WorkflowApplicationError('run_busy', 'workflow is closing');
  }

  beginShutdown(): void {
    this.closing = true;
    for (const controller of this.ownedOperations.values()) controller.abort();
    if (this.remoteShutdown === undefined) {
      const remote = this.engine.shutdown();
      this.remoteShutdown = remote;
      // The exit coordinator observes this same receipt; retries start only after
      // a failed shutdown attempt has been presented to the user.
      void remote.catch(() => undefined);
    }
  }

  shutdown(): Promise<void> {
    this.beginShutdown();
    if (this.shutdownAttempt) return this.shutdownAttempt;
    const remoteShutdown = this.remoteShutdown!;
    const operations = [...this.ownedOperations];
    const attempt = (async () => {
      await Promise.allSettled(operations.map(([pending]) => pending));
      const results = await Promise.allSettled(
        [...this.handles].map(async ([runId, handle]) => {
          try {
            await handle.stop();
            await handle.done;
          } catch (error) {
            this.journalCall(() => this.journal.updateRunStatus(runId, { status: WORKFLOW_RECOVERY_STATUS }));
            throw error;
          }
        }),
      );
      const remote = await Promise.allSettled([remoteShutdown]);
      const errors = [
        ...remote.flatMap((result) => (result.status === 'rejected' ? [result.reason] : [])),
        ...this.unconfirmedAdmissions.values(),
        ...results.flatMap((result) => (result.status === 'rejected' ? [result.reason] : [])),
      ];
      if (errors.length) throw new AggregateError(errors, 'workflow cleanup unconfirmed');
    })();
    this.shutdownAttempt = attempt;
    void attempt.catch(() => {
      this.shutdownAttempt = undefined;
      if (this.remoteShutdown === remoteShutdown) this.remoteShutdown = undefined;
    });
    return attempt;
  }

  constructor(deps: WorkflowApplicationDeps) {
    this.journal = deps.journal;
    this.engine = deps.engine;
    this.candidateStore = deps.candidateStore;
    this.appResolver = deps.appResolver;
    this.appSource = deps.appSource;
    this.acquireWriter = deps.acquireWriter;
    this.appBusy = deps.appBusy;
    this.routeScopeProvider = deps.routeScopeProvider;
    this.now = deps.now ?? Date.now;
    this.onEvent = deps.onEvent;
  }

  /**
   * 幂等受理：同 requestId 同内容返回既有 workflowRunId；同 requestId 不同内容 → request_conflict。
   * P0 并发 1：存在任何非终态（含 needs_reconciliation）run → run_busy，不排队。
   */
  async run(request: WorkflowRunRequest): Promise<WorkflowRunAccepted> {
    return this.owned((signal) => this.runOwned(request, signal));
  }

  private async runOwned(request: WorkflowRunRequest, signal: AbortSignal): Promise<WorkflowRunAccepted> {
    const scriptHash = workflowScriptHash(request.script);
    const argsHash = workflowArgsHash(request.args);
    const accepted = this.idempotentAccept(request.requestId, scriptHash, argsHash, null);
    if (accepted) return accepted;

    this.assertIdle();
    const runId = randomUUID();
    const binding = await this.bindLane(request.script, request.appTarget ?? null, request.input, signal);
    const appTarget = binding.target ?? DEFAULT_APP_TARGET;
    // W6a：候选基线先于 run 行建立——基线失败即受理失败，不留下没有候选身份的运行。
    const baseTree = await this.createBaseline(runId, appTarget, binding.input?.files ?? []);
    signal.throwIfAborted();
    this.journalCall(() =>
      this.journal.insertRun({
        runId,
        requestId: request.requestId,
        parentRunId: null,
        scriptHash,
        argsHash,
        dslVersion: WORKFLOW_DSL_VERSION,
        status: 'running',
        engine: request.engine ?? 'kernel',
        createdMs: this.now(),
        baseTree,
        // W6b：appTargetJson 只记真实绑定（合成 workflow 身份不持久化）——
        // 公共投影据此区分「lane 绑定 App」与「lane 未绑定将得 unavailable」。
        appTargetJson:
          binding.target !== null ? canonical(binding.target) : request.appTarget !== undefined ? canonical(request.appTarget) : null,
        requiresApp: binding.requiresApp,
        writes: binding.writes,
      }),
    );
    await this.startHandle(runId, {
      runId,
      script: request.script,
      args: request.args === undefined ? null : request.args,
      deadlineMs: request.deadlineMs,
      cache: [],
      journal: this.journalSink(),
      input: binding.input,
      baseTree: baseTree ?? undefined,
      appTarget: binding.target ?? request.appTarget,
      routeScope: this.routeScope(),
    });
    return { workflowRunId: runId, scriptHash, argsHash };
  }

  /**
   * 精确续跑：父 run 必须存在且为已确认终态；needs_reconciliation → process_unconfirmed，
   * running/stopping → run_not_resumable；scriptHash/argsHash 与父不一致 → resume_mismatch。
   * 缓存沿祖先链近者优先（直接父的 hash 相等即续跑链一致的闸门）。
   */
  async resume(request: WorkflowResumeRequest): Promise<WorkflowRunAccepted> {
    return this.owned((signal) => this.resumeOwned(request, signal));
  }

  private async resumeOwned(request: WorkflowResumeRequest, signal: AbortSignal): Promise<WorkflowRunAccepted> {
    const scriptHash = workflowScriptHash(request.script);
    const argsHash = workflowArgsHash(request.args);
    const accepted = this.idempotentAccept(request.requestId, scriptHash, argsHash, request.parentWorkflowRunId);
    if (accepted) return accepted;

    const parent = this.journalCall(() => this.journal.getRun(request.parentWorkflowRunId));
    if (parent === null) {
      throw new WorkflowApplicationError('run_not_found', `unknown parent run ${request.parentWorkflowRunId}`);
    }
    if (parent.status === WORKFLOW_RECOVERY_STATUS) {
      throw new WorkflowApplicationError('process_unconfirmed', `parent run ${parent.runId} awaits reconciliation`);
    }
    if (!TERMINAL.has(parent.status)) {
      throw new WorkflowApplicationError('run_not_resumable', `parent run ${parent.runId} is ${parent.status}, not terminal`);
    }
    if (parent.scriptHash !== scriptHash || parent.argsHash !== argsHash) {
      throw new WorkflowApplicationError('resume_mismatch', 'scriptHash or argsHash differ from parent run');
    }
    // W6a：候选谱系随父继承——目标取父 run 登记值（父无目标时允许请求声明），
    // 声明不一致即 resume_mismatch；基线必须逐位相等，回放链才对得上 CAS 前驱。
    const parentTarget = parent.appTargetJson === null ? null : (JSON.parse(parent.appTargetJson) as AppTarget);
    if (parentTarget !== null && request.appTarget !== undefined && canonical(parentTarget) !== canonical(request.appTarget)) {
      throw new WorkflowApplicationError('resume_mismatch', 'appTarget differs from parent run');
    }
    // W6b：lane 绑定与受理同规则——父 run 绑定目标优先（续跑属于同一应用），
    // 父未绑定时重新解析；冻结输入=目标 App 的实时快照。
    const binding = await this.bindLane(request.script, parentTarget ?? request.appTarget ?? null, request.input, signal);
    const appTarget = binding.target ?? DEFAULT_APP_TARGET;
    const cache = this.buildResumeCache(parent.runId);
    for (const entry of cache) {
      if (entry.publication !== undefined && entry.publication.baseTree !== parent.baseTree) {
        throw new WorkflowApplicationError('resume_mismatch', 'ancestor publication baseline differs from parent run');
      }
    }

    this.assertIdle();
    const runId = randomUUID();
    const childBaseTree = parent.baseTree === null ? null : await this.createBaseline(runId, appTarget, binding.input?.files ?? []);
    signal.throwIfAborted();
    if (parent.baseTree !== null && childBaseTree !== parent.baseTree) {
      throw new WorkflowApplicationError('resume_mismatch', 'frozen input does not reproduce the parent baseline');
    }
    // Candidate objects belong to one run's private Git store. Cached pointers need
    // their ancestor objects present locally before a later uncached lane can merge.
    if (this.candidateStore?.materialize !== undefined && this.candidateStore.computeTree !== undefined) {
      const transferred = new Set<string>(childBaseTree === null ? [] : [childBaseTree]);
      for (const entry of cache) {
        const publication = entry.publication;
        if (publication === undefined || transferred.has(publication.afterTree)) continue;
        const files = await this.candidateStore.materialize(entry.fromRunId, publication.afterTree, signal);
        signal.throwIfAborted();
        const restored = await this.candidateStore.computeTree(runId, this.snapshotFor(appTarget, files), signal);
        signal.throwIfAborted();
        if (restored !== publication.afterTree) {
          throw new WorkflowApplicationError('resume_mismatch', 'cached candidate tree does not reproduce its ancestor identity');
        }
        transferred.add(restored);
      }
    }
    this.journalCall(() =>
      this.journal.insertRun({
        runId,
        requestId: request.requestId,
        parentRunId: parent.runId,
        scriptHash,
        argsHash,
        dslVersion: WORKFLOW_DSL_VERSION,
        status: 'running',
        engine: request.engine ?? 'kernel',
        createdMs: this.now(),
        baseTree: childBaseTree,
        appTargetJson:
          binding.target !== null ? canonical(binding.target) : request.appTarget !== undefined ? canonical(request.appTarget) : null,
        requiresApp: binding.requiresApp,
        writes: binding.writes,
      }),
    );
    await this.startHandle(runId, {
      runId,
      script: request.script,
      args: request.args === undefined ? null : request.args,
      deadlineMs: request.deadlineMs,
      cache,
      journal: this.journalSink(),
      parentRunId: parent.runId,
      input: binding.input,
      baseTree: childBaseTree ?? undefined,
      appTarget: binding.target ?? request.appTarget,
      routeScope: this.routeScope(),
    });
    return { workflowRunId: runId, scriptHash, argsHash };
  }

  /** 停止：等引擎清理确认（done 落定）；未知或已终态的 run 为 no-op。 */
  async stop(workflowRunId: string): Promise<void> {
    const unconfirmed = this.unconfirmedAdmissions.get(workflowRunId);
    if (unconfirmed) throw new WorkflowApplicationError('process_unconfirmed', unconfirmed.message);
    const handle = this.handles.get(workflowRunId);
    if (handle === undefined) return;
    try {
      await handle.stop();
      await handle.done;
    } catch (error) {
      this.journalCall(() => this.journal.updateRunStatus(workflowRunId, { status: WORKFLOW_RECOVERY_STATUS }));
      this.onEvent?.(workflowRunId);
      throw error;
    }
  }

  /** 重启恢复：所有非终态 run 标记 needs_reconciliation（恢复标记，不写合成 journal 事件）。 */
  recoverOpenRuns(): WorkflowRunRow[] {
    const open = this.journalCall(() => this.journal.listNonTerminalRuns());
    for (const run of open) {
      this.journalCall(() => this.journal.updateRunStatus(run.runId, { status: WORKFLOW_RECOVERY_STATUS }));
    }
    return open.map((run) => ({ ...run, status: WORKFLOW_RECOVERY_STATUS }));
  }

  /**
   * Restart-recovered runs can be reconciled after the user checks external facts.
   * A live owner in this process cannot be cleared by changing its journal status;
   * 进程已由调用方核实停止后，结清为终态以解锁续跑与并发槽（设计 §6/§7）。
   */
  reconcileAsStopped(workflowRunId: string): void {
    if (this.handles.has(workflowRunId) || this.unconfirmedAdmissions.has(workflowRunId)) {
      throw new WorkflowApplicationError('process_unconfirmed', 'live workflow owner cleanup remains unconfirmed');
    }
    const run = this.journalCall(() => this.journal.getRun(workflowRunId));
    if (run === null) throw new WorkflowApplicationError('run_not_found', `unknown run ${workflowRunId}`);
    if (run.status !== WORKFLOW_RECOVERY_STATUS) {
      throw new WorkflowApplicationError('run_not_resumable', `run ${workflowRunId} is ${run.status}, not awaiting reconciliation`);
    }
    this.journalCall(() => this.journal.updateRunStatus(workflowRunId, { status: 'stopped' }));
  }

  /**
   * W6a：service 回执前的 lane 候选登记（由引擎端口的 workflow-candidate 消息驱动）。
   * 核对：run 存在且未终态、attempt 已提交、目标可重建；快照经 candidateStore.captureCandidate
   * 落 Git 对象，随后在同一 SQLite 事务登记 publications 行并 CAS 推进候选指针。
   * 返回的 publication 回给 service 作为 call_end 的事实载荷；任何一步失败即拒绝，两侧状态不变。
   */
  async publishCandidate(runId: string, callSeq: number, files: WorkflowInputFile[]): Promise<WorkflowPublishResult> {
    const run = this.journalCall(() => this.journal.getRun(runId));
    if (run === null) throw new WorkflowApplicationError('run_not_found', `unknown run ${runId}`);
    if (TERMINAL.has(run.status)) {
      throw new WorkflowApplicationError('internal_error', `run ${runId} is ${run.status}; candidate publication closed`);
    }
    if (run.baseTree === null || this.candidateStore === undefined) {
      throw new WorkflowApplicationError('internal_error', `run ${runId} has no candidate capability`);
    }
    if (!this.journalCall(() => this.journal.hasAttemptStarted(runId, callSeq))) {
      throw new WorkflowApplicationError('internal_error', `lane attempt ${runId}:c${callSeq} is not committed`);
    }
    const appTarget = run.appTargetJson === null ? null : (JSON.parse(run.appTargetJson) as AppTarget);
    if (appTarget === null) {
      throw new WorkflowApplicationError('internal_error', `run ${runId} has no candidate target`);
    }
    let captured: CapturedSourceChange;
    try {
      captured = await this.candidateStore.captureCandidate(runId, callSeq, run.baseTree, this.snapshotFor(appTarget, files));
    } catch (error) {
      throw new WorkflowApplicationError(
        'internal_error',
        `lane candidate capture failed: ${error instanceof Error ? error.message : String(error)}`,
      );
    }
    if (captured.baseTree !== run.baseTree) {
      throw new WorkflowApplicationError('internal_error', 'captured candidate baseline differs from run baseline');
    }

    // W8：有合并能力的存储走三向合并——B=调用登记基线（无记录时回退 run 基线），
    // P=当前候选指针；无 mergeCandidate 的存储维持 W6a 逐快照语义。
    let afterTree = captured.afterTree;
    if (this.candidateStore.mergeCandidate !== undefined) {
      const callBase = this.journalCall(() => this.journal.callBaseTree(runId, callSeq)) ?? run.baseTree;
      const pointer = this.journalCall(() => this.journal.candidatePointer(runId)) ?? run.baseTree;
      let merged: { merged: string } | { conflict: { files: string[] } };
      try {
        merged = await this.candidateStore.mergeCandidate(runId, callSeq, callBase, captured.afterTree, pointer);
      } catch (error) {
        throw new WorkflowApplicationError(
          'internal_error',
          `lane candidate merge failed: ${error instanceof Error ? error.message : String(error)}`,
        );
      }
      if ('conflict' in merged) {
        const current = this.journalCall(() => this.journal.getRun(runId));
        const call = this.journalCall(() => this.journal.listCalls(runId)).find((item) => item.callSeq === callSeq);
        if (current?.status !== 'running' || call?.status !== 'pending') {
          throw new WorkflowApplicationError('internal_error', `candidate publication closed for ${runId}:c${callSeq}`);
        }
        // 冲突：候选已 capture（patch+tree 留在 objects.git 可诊断），不写发布行、不动指针。
        const conflict = { files: merged.conflict.files, candidateRef: captured.afterTree };
        this.pendingCandidates.set(`${runId}:${callSeq}`, canonical({ conflict }));
        return { conflict };
      }
      afterTree = merged.merged;
    }
    const publication: WorkflowPublication = {
      baseTree: captured.baseTree,
      afterTree,
      patchSha256: captured.patchSha256,
      files: captured.files,
    };
    this.journalCall(() => this.journal.publishCandidate({ runId, callSeq, publication }));
    // 登记待核对项：call_end{publication} 到达时必须与本登记逐位一致（回放除外）。
    this.pendingCandidates.set(`${runId}:${callSeq}`, canonical({ publication }));
    return { publication };
  }

  /**
   * W8：service 的 lane 工作区请求（workflow-lanebase 消息委托）。返回该调用登记时
   * 冻结的候选基线树与其物化文件集；调用未知/无基线或存储不支持物化即拒绝。
   */
  async laneWorkspace(runId: string, callSeq: number): Promise<{ baseTree: string; files: WorkflowInputFile[] }> {
    const run = this.journalCall(() => this.journal.getRun(runId));
    if (run === null) throw new WorkflowApplicationError('run_not_found', `unknown run ${runId}`);
    if (this.candidateStore?.materialize === undefined) {
      throw new WorkflowApplicationError('internal_error', `run ${runId} has no candidate capability`);
    }
    const baseTree = this.journalCall(() => this.journal.callBaseTree(runId, callSeq));
    if (baseTree === null) {
      throw new WorkflowApplicationError('internal_error', `lane workspace base for ${runId}:c${callSeq} is unavailable`);
    }
    const files = await this.candidateStore.materialize(runId, baseTree);
    return { baseTree, files: files.map((file) => ({ path: file.path, base64: file.base64 })) };
  }

  /**
   * W6b：受理/续跑共用的 lane 绑定决策。脚本声明 lane 时解析受管 App
   * （请求显式目标优先，否则 appResolver）并取实时源码快照作为冻结输入；
   * 未绑定 → target=null：run 照常受理，kernel 的 lane 调用得 unavailable。
   * App 目标不参与命令身份——批准绑定只看脚本/args/input/deadline，绑定在执行期。
   */
  private async bindLane(
    script: string,
    requested: AppTarget | null,
    input: WorkflowRunInput | undefined,
    signal: AbortSignal,
  ): Promise<{ target: AppTarget | null; input: WorkflowRunInput | undefined; requiresApp: boolean; writes: boolean }> {
    if (!scriptDeclaresLane(script)) return { target: requested, input, requiresApp: false, writes: false };
    const wanted = requested ?? this.appResolver?.() ?? null;
    if (wanted === null) return { target: null, input, requiresApp: true, writes: true };
    if (this.appSource === undefined) {
      throw new WorkflowApplicationError('app_unavailable', 'lane 命令需要 App 源码服务，但未配置');
    }
    const snap = await this.appSource.snapshot(wanted, signal);
    signal.throwIfAborted();
    if (!snap.ok) {
      throw new WorkflowApplicationError('app_unavailable', `lane 绑定失败——无法快照受管 App：${snap.error}`);
    }
    return {
      target: wanted,
      input: { files: snap.snapshot.files.map((file) => ({ path: file.path, base64: file.base64 })) },
      requiresApp: true,
      writes: true,
    };
  }

  /**
   * W7：受理时取一次 Profile 快照作为本 run 的路由范围（授权范围随 spec 冻结）。
   * 无 provider → undefined：service 维持单适配器语义，opts.profile 只记录不路由。
   */
  private routeScope(): WorkflowRouteScope | undefined {
    const members = this.routeScopeProvider?.();
    if (members === undefined) return undefined;
    return { defaultHarness: WORKFLOW_DEFAULT_HARNESS, members };
  }

  /** W6a：受理/续跑的候选基线；无 candidateStore 时 run 无候选能力（baseTree=null）。 */
  private async createBaseline(runId: string, appTarget: AppTarget, files: WorkflowInputFile[]): Promise<string | null> {
    if (this.candidateStore === undefined) return null;
    try {
      return (await this.candidateStore.createBaseline(runId, this.snapshotFor(appTarget, files))).baseTree;
    } catch (error) {
      throw new WorkflowApplicationError(
        'internal_error',
        `candidate baseline failed: ${error instanceof Error ? error.message : String(error)}`,
      );
    }
  }

  /** run 输入/候选文件集 → AppSourceSnapshot（mode 统一 100644；路径与预算由仓库侧 schema 复核）。 */
  private snapshotFor(appTarget: AppTarget, files: WorkflowInputFile[]): AppSourceSnapshot {
    const entries = files.map((file) => ({ path: file.path, mode: '100644' as const, base64: file.base64 }));
    let totalBytes = 0;
    for (const file of entries) totalBytes += Buffer.from(file.base64, 'base64').length;
    return { ...appTarget, files: entries, totalBytes };
  }

  /** 最近 run 列表（created_seq 降序，默认 50）；W6b：并入候选投影，剥离内部列由 IPC 边界做。 */
  listRuns(limit = 50): (WorkflowRunRow & { candidate?: WorkflowCandidateState })[] {
    return this.journalCall(() =>
      this.journal.listRuns(limit).map((row) => {
        const candidate = this.journal.candidateForRun(row.runId);
        return candidate === null ? row : { ...row, candidate };
      }),
    );
  }

  /** 单个 run 行 + 候选投影；未知 runId 抛 run_not_found。 */
  runRow(workflowRunId: string): WorkflowRunRow & { candidate?: WorkflowCandidateState } {
    const row = this.journalCall(() => this.journal.getRun(workflowRunId));
    if (row === null) throw new WorkflowApplicationError('run_not_found', `unknown run ${workflowRunId}`);
    const candidate = this.journalCall(() => this.journal.candidateForRun(workflowRunId));
    return candidate === null ? row : { ...row, candidate };
  }

  /**
   * W6b workflow:patch——候选最新发布的统一 diff（sha256 与投影核对）。
   * run 无候选 → candidate_unavailable；未知 run → run_not_found。
   */
  async workflowPatch(runId: string): Promise<{ runId: string; patchSha256: string; patch: string }> {
    const row = this.journalCall(() => this.journal.getRun(runId));
    if (row === null) throw new WorkflowApplicationError('run_not_found', `unknown run ${runId}`);
    const candidate = this.journalCall(() => this.journal.candidateForRun(runId));
    if (candidate === null || this.candidateStore?.readCandidatePatch === undefined) {
      throw new WorkflowApplicationError('candidate_unavailable', `run ${runId} has no published candidate`);
    }
    const callSeq = this.journalCall(() => this.journal.publicationCallSeqForTree(runId, candidate.currentTree));
    if (callSeq === null) {
      throw new WorkflowApplicationError('candidate_unavailable', `run ${runId} candidate pointer has no publication`);
    }
    const patch = await this.candidateStore.readCandidatePatch(runId, callSeq, candidate.patchSha256);
    return { runId, patchSha256: candidate.patchSha256, patch };
  }

  /**
   * W6b workflow:apply——显式授权把已发布候选应用到受管 App。事务序：
   *   1) run 终态 + 候选存在 + 目标已绑定   2) App 侧阻塞核对（busy/unavailable）
   *   3) 工程写租约（互斥于任务执行/源码采集）   4) 租约内取实时源码快照
   *   5) 快照树 vs 候选基线 —— 偏离即 apply_conflict，不写任何东西
   *   6) 物化候选树 → app.source.apply   7) apply 事件落盘投影 applied_at
   *   8) 租约释放（finally——失败路径同样释放）
   * 幂等：最后一条 apply 事件的 afterTree 已等于当前候选指针 → no-op 成功。
   */
  async applyCandidate(runId: string): Promise<WorkflowRunRow & { candidate?: WorkflowCandidateState }> {
    return this.owned((signal) => this.applyCandidateOwned(runId, signal));
  }

  private async applyCandidateOwned(runId: string, signal: AbortSignal): Promise<WorkflowRunRow & { candidate?: WorkflowCandidateState }> {
    if (this.appSource === undefined || this.acquireWriter === undefined) {
      throw new WorkflowApplicationError('internal_error', 'apply requires app source port and writer lease');
    }
    const row = this.journalCall(() => this.journal.getRun(runId));
    if (row === null) throw new WorkflowApplicationError('run_not_found', `unknown run ${runId}`);
    if (!TERMINAL.has(row.status)) {
      throw new WorkflowApplicationError('run_busy', `run ${runId} is ${row.status}; apply requires a terminal run`);
    }
    const candidate = this.journalCall(() => this.journal.candidateForRun(runId));
    if (candidate === null || this.candidateStore?.materialize === undefined || this.candidateStore?.computeTree === undefined) {
      throw new WorkflowApplicationError('candidate_unavailable', `run ${runId} has no published candidate`);
    }
    const target = row.appTargetJson === null ? null : (JSON.parse(row.appTargetJson) as AppTarget);
    if (target === null || target.workspaceId === DEFAULT_APP_TARGET.workspaceId) {
      throw new WorkflowApplicationError('app_unavailable', `run ${runId} is not bound to a managed App`);
    }
    // 幂等：该候选树已应用过 → 返回当前行，不重写（applied_at 属事实不重复登记）。
    const lastApply = this.journalCall(() => this.journal.listEvents(runId))
      .filter((event) => event.t === 'apply')
      .at(-1);
    if (
      lastApply !== undefined &&
      lastApply.t === 'apply' &&
      lastApply.afterTree === candidate.currentTree &&
      canonical(lastApply.target) === canonical(target)
    ) {
      return this.runRow(runId);
    }
    const blocker = this.appBusy?.(target) ?? null;
    if (blocker !== null) {
      if (blocker.startsWith('busy:')) throw new WorkflowApplicationError('project_busy', blocker.slice(5).trim());
      throw new WorkflowApplicationError('app_unavailable', blocker.replace(/^unavailable:\s*/, ''));
    }
    const lease = this.acquireWriter(target.projectId, `workflow-apply-${runId}`);
    if (lease === null) {
      throw new WorkflowApplicationError('project_busy', '工程已有写作者或执行在途；候选未应用');
    }
    try {
      // 租约持有整个 快照→核对→应用 临界区——期间任何工程写入都被互斥。
      const snapshot = await this.appSource.snapshot(target, signal);
      signal.throwIfAborted();
      if (!snapshot.ok) {
        throw new WorkflowApplicationError(snapshot.error.startsWith('busy:') ? 'project_busy' : 'apply_failed', snapshot.error);
      }
      const currentTree = await this.candidateStore.computeTree(runId, snapshot.snapshot, signal);
      signal.throwIfAborted();
      if (currentTree !== candidate.baseTree) {
        throw new WorkflowApplicationError('apply_conflict', '应用源码已偏离候选基线：工程在候选发布后又被改动，拒绝应用');
      }
      const files = await this.candidateStore.materialize(runId, candidate.currentTree, signal);
      signal.throwIfAborted();
      const applied = await this.appSource.apply(target, files, signal);
      // A successful write receipt is a fact even if cancellation raced its return.
      if (!applied.ok) {
        throw new WorkflowApplicationError(applied.error.startsWith('busy:') ? 'project_busy' : 'apply_failed', applied.error);
      }
      // 事实落盘：apply 事件把应用时间投影到 runs.applied_at（与事件同事务）。
      this.journalCall(() => this.journal.appendEvent({ t: 'apply', runId, target, afterTree: candidate.currentTree, at: this.now() }));
      this.onEvent?.(runId);
      return this.runRow(runId);
    } finally {
      lease.release();
    }
  }

  /**
   * 进度投影：run 行 + calls 表按 callSeq 升序。usage 与日志尾部来自 events 原始镜像
   * （类型化投影不含这两类字段）；usage 未报告保持 null（unknown，不记 0）。
   */
  status(workflowRunId: string): WorkflowStatusProjection {
    const run = this.journalCall(() => this.journal.getRun(workflowRunId));
    if (run === null) throw new WorkflowApplicationError('run_not_found', `unknown run ${workflowRunId}`);
    const events = this.journalCall(() => this.journal.listEvents(workflowRunId));
    const usageByCall = new Map<number, WorkflowUsage>();
    const logTail: WorkflowStatusProjection['logTail'] = [];
    for (const event of events) {
      if (event.t === 'attempt_end' && event.status === 'ok' && event.usage) usageByCall.set(event.callSeq, event.usage);
      else if (event.t === 'phase') logTail.push({ seq: event.seq, kind: 'phase', text: event.title });
      else if (event.t === 'log') logTail.push({ seq: event.seq, kind: 'log', text: event.message });
      else if (event.t === 'warn') logTail.push({ seq: event.seq, kind: 'warn', text: `${event.code}：${event.message}` });
    }
    const calls = this.journalCall(() => this.journal.listCalls(workflowRunId)).map((call) => ({
      seq: call.callSeq,
      label: call.label,
      status: call.status,
      code: call.code,
      attempts: call.attempts,
      phase: call.phase,
      cachedFromRunId: call.cachedFromRunId,
      usage: usageByCall.get(call.callSeq) ?? null,
      // W8：conflict 终态透出冲突文件与保留候选树（非 conflict 字段缺省）。
      ...(call.conflict !== null ? { conflictFiles: call.conflict.files, candidateRef: call.conflict.candidateRef } : {}),
    }));
    const projection: WorkflowStatusProjection = {
      runId: run.runId,
      status: run.status,
      failureCode: run.failureCode,
      calls,
      logTail: logTail.slice(-200),
      requiresApp: run.requiresApp,
      writes: run.writes,
      appTarget: run.appTargetJson === null ? null : (JSON.parse(run.appTargetJson) as AppTarget),
    };
    if (run.resultJson !== null) projection.result = JSON.parse(run.resultJson);
    // W6a：候选投影随状态透出；无候选能力的 run 字段缺省。
    const candidate = this.journalCall(() => this.journal.candidateForRun(workflowRunId));
    if (candidate !== null) projection.candidate = candidate;
    return projection;
  }

  private idempotentAccept(
    requestId: string,
    scriptHash: string,
    argsHash: string,
    parentRunId: string | null,
  ): WorkflowRunAccepted | null {
    const existing = this.journalCall(() => this.journal.findRunByRequestId(requestId));
    if (existing === null) return null;
    if (existing.scriptHash === scriptHash && existing.argsHash === argsHash && existing.parentRunId === parentRunId) {
      return { workflowRunId: existing.runId, scriptHash, argsHash };
    }
    throw new WorkflowApplicationError('request_conflict', `requestId ${requestId} was already accepted with different content`);
  }

  private assertIdle(): void {
    const open = this.journalCall(() => this.journal.listNonTerminalRuns());
    if (open.length > 0) {
      throw new WorkflowApplicationError('run_busy', `run ${open[0]!.runId} is ${open[0]!.status}; P0 allows one active run`);
    }
  }

  private journalSink(): (event: WorkflowJournalEvent) => Promise<void> {
    return async (event) => {
      // W6a/W8：本 run 实时 lane 的 call_end{publication|conflict} 必须与 publishCandidate
      // 登记的事实逐位一致——错配即拒绝落盘（service 收到 nack → internal_error），不留半提交投影。
      // cached 回放（祖先或同轮去重）不经 pending：journal 按回放语义在同一事务补登。
      if (event.t === 'call_end' && event.cachedFromRunId === undefined) {
        const expected = this.pendingCandidates.get(`${event.runId}:${event.callSeq}`);
        if (event.publication !== undefined) {
          if (expected === undefined || expected !== canonical({ publication: event.publication })) {
            throw new WorkflowApplicationError(
              'internal_error',
              `lane publication for ${event.runId}:c${event.callSeq} does not match a pending candidate`,
            );
          }
        } else if (event.status === 'conflict') {
          const fact = canonical({ conflict: { files: event.conflictFiles ?? [], candidateRef: event.candidateRef } });
          if (expected === undefined || expected !== fact) {
            throw new WorkflowApplicationError(
              'internal_error',
              `lane conflict for ${event.runId}:c${event.callSeq} does not match a pending candidate`,
            );
          }
        }
      }
      this.journalCall(() => this.journal.appendEvent(event));
      this.onEvent?.(event.runId);
    };
  }

  private async startHandle(runId: string, spec: WorkflowEngineRunSpec): Promise<void> {
    let handle: WorkflowEngineRunHandle;
    try {
      handle = await this.engine.run(spec);
    } catch (error) {
      if (error instanceof WorkflowProcessUnconfirmedError) {
        this.unconfirmedAdmissions.set(runId, error);
        this.journalCall(() => this.journal.updateRunStatus(runId, { status: WORKFLOW_RECOVERY_STATUS }));
        this.onEvent?.(runId);
        throw new WorkflowApplicationError('process_unconfirmed', error.message);
      }
      this.journalCall(() => this.journal.updateRunStatus(runId, { status: 'failed', failureCode: 'engine_rejected' }));
      const detail = error instanceof Error ? error.message : String(error);
      throw new WorkflowApplicationError('engine_rejected', `engine rejected run ${runId}: ${detail}`);
    }
    this.handles.set(runId, handle);
    void handle.done.then(
      () => {
        this.handles.delete(runId);
        this.dropPendingCandidates(runId);
      },
      () => {
        this.journalCall(() => this.journal.updateRunStatus(runId, { status: WORKFLOW_RECOVERY_STATUS }));
        this.onEvent?.(runId);
      },
    );
  }

  /** 终态后残留的待核对候选登记一律清除——迟到事件不再被误认为实时发布。 */
  private dropPendingCandidates(runId: string): void {
    const prefix = `${runId}:`;
    for (const key of this.pendingCandidates.keys()) {
      if (key.startsWith(prefix)) this.pendingCandidates.delete(key);
    }
  }

  /** 祖先链近者优先建立 contentKey→已提交结果映射；直接父的 hash 闸门已在 resume 校验。 */
  private buildResumeCache(parentRunId: string): WorkflowCacheEntry[] {
    const cache = new Map<string, WorkflowCacheEntry>();
    let ancestorId: string | null = parentRunId;
    while (ancestorId !== null) {
      const current: string = ancestorId;
      for (const entry of this.journalCall(() => this.journal.callsForResume(current))) {
        if (!cache.has(entry.contentKey)) cache.set(entry.contentKey, entry);
      }
      const row = this.journalCall(() => this.journal.getRun(current));
      ancestorId = row?.parentRunId ?? null;
    }
    return [...cache.values()];
  }

  private journalCall<T>(fn: () => T): T {
    try {
      return fn();
    } catch (error) {
      if (error instanceof WorkflowJournalError) {
        // journal_event_invalid 是发布/CAS 的内部一致性问题，对外收敛为 internal_error。
        const code = error.code === 'journal_event_invalid' ? 'internal_error' : (error.code as WorkflowApplicationErrorCode);
        throw new WorkflowApplicationError(code, error.message);
      }
      throw error;
    }
  }
}
