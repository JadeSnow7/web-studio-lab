import {
  AppTargetSchema,
  WorkflowPublicationSchema,
  WorkflowRouteScopeSchema,
  WorkflowRunInputSchema,
  type AppTarget,
  type WorkflowCacheEntry,
  type WorkflowJournalEvent,
  type WorkflowRouteScope,
  type WorkflowRunInput,
  type WorkflowRunOutcome,
} from '@wsl/protocol';
import type { WorkflowCallAdapter, WorkflowCandidate, WorkflowLaneWorkspace, WorkflowPublishOutcome } from './call-adapter';
import { WorkflowContractError, type JournalEvent } from './contract';
import { createRun, resumeRun } from './kernel';

/**
 * Main↔service 边界的窄端口（W2）：一次 workflowRun 的受理与句柄。
 * spec 已含 Main 核对过的身份（runId、cache 出处、parentRunId 谱系）；
 * 本层只做形状校验并把输入映射到内核端口，不再做业务判断。
 */
export interface WorkflowEngineRunSpec {
  /** Service-local launch cancellation; never part of the Main RPC or journal identity. */
  signal?: AbortSignal;
  runId: string;
  script: string;
  args: unknown;
  deadlineMs?: number;
  /** 续跑注入的已提交结果缓存；Main 按祖先链近者优先建立。仅在 parentRunId 续跑时有意义。 */
  cache: WorkflowCacheEntry[];
  /** journal 沉点：内核逐条 await，append 拒绝 → run failed{internal_error}。 */
  journal: (event: WorkflowJournalEvent) => Promise<void>;
  parentRunId?: string;
  /** run 级冻结输入（W3）：原样传给 createAdapter，由适配器在每次 attempt 物化；内核不消费。 */
  input?: WorkflowRunInput;
  /** W5：本 run 的并发派发上限；缺省用 LIMITS.MAX_CONCURRENT_CALLS，越界截断到 [1, 上限]。 */
  maxConcurrentCalls?: number;
  /** W6a：受理时 Main 建立的候选基线树，随 run 事件回显进 journal。 */
  baseTree?: string;
  /** W6a：候选发布面向的应用目标，随 run 事件回显。 */
  appTarget?: AppTarget;
  /** W6a/W8：lane 候选发布端口（publication | conflict 联合）；缺省时 lane 调用不派发 attempt、以 internal 失败。 */
  publishCandidate?: (callSeq: number, candidate: WorkflowCandidate) => Promise<WorkflowPublishOutcome>;
  /** W8：lane attempt 工作区端口（登记基线树 + 物化文件集）；缺省时 lane 调用以 internal 失败。 */
  laneWorkspace?: (callSeq: number) => Promise<WorkflowLaneWorkspace>;
  /** W7：本 run 授权的路由范围；缺省 → 单适配器（opts.profile 只记录不路由）。 */
  routeScope?: WorkflowRouteScope;
}

export interface WorkflowEngineRunHandle {
  /** resolve confirms cleanup; WorkflowCleanupUnconfirmedError rejection retains the owner for reconciliation. */
  done: Promise<WorkflowRunOutcome>;
  stop(): Promise<void>;
}

export interface WorkflowEngineDeps {
  adapter: WorkflowCallAdapter;
  /** 按受理 spec 为每次 run 构造适配器（W3：runId/input 进入适配器）；缺省回退到 deps.adapter。 */
  createAdapter?: (spec: WorkflowEngineRunSpec) => WorkflowCallAdapter;
  workerUrl?: URL;
}

export class WorkflowEngine {
  private readonly createAdapter: (spec: WorkflowEngineRunSpec) => WorkflowCallAdapter;
  private readonly workerUrl: URL | undefined;

  constructor(deps: WorkflowEngineDeps) {
    this.createAdapter = deps.createAdapter ?? (() => deps.adapter);
    this.workerUrl = deps.workerUrl;
  }

  /**
   * 受理一次运行：形状校验失败 → WorkflowContractError 拒绝（不启动内核、不写 journal）。
   * 脚本/args 的合同校验由内核在创建时完成并同样以 WorkflowContractError 抛出。
   */
  async run(spec: WorkflowEngineRunSpec): Promise<WorkflowEngineRunHandle> {
    if (typeof spec.runId !== 'string' || spec.runId.length === 0) {
      throw new WorkflowContractError('invalid_args', 'spec.runId must be a non-empty string');
    }
    if (typeof spec.script !== 'string') {
      throw new WorkflowContractError('invalid_args', 'spec.script must be a string');
    }
    if (typeof spec.journal !== 'function') {
      throw new WorkflowContractError('invalid_args', 'spec.journal must be an async append function');
    }
    if (!Array.isArray(spec.cache)) {
      throw new WorkflowContractError('invalid_args', 'spec.cache must be an array');
    }
    for (const entry of spec.cache) {
      if (typeof entry?.contentKey !== 'string' || entry.contentKey.length === 0 || typeof entry.fromRunId !== 'string') {
        throw new WorkflowContractError('invalid_args', 'cache entries require contentKey and fromRunId strings');
      }
    }
    // 缓存只来自续跑祖先链；无 parentRunId 的非空缓存会让 cachedFromRunId 失去谱系依据。
    if (spec.parentRunId === undefined && spec.cache.length > 0) {
      throw new WorkflowContractError('invalid_args', 'non-empty cache requires parentRunId');
    }
    if (spec.input !== undefined && !WorkflowRunInputSchema.safeParse(spec.input).success) {
      throw new WorkflowContractError('invalid_args', 'spec.input must match the frozen-input shape (<= 256 files)');
    }
    // W6a：续跑缓存项可能携带祖先 lane 的发布事实，逐条复核形状。
    for (const entry of spec.cache) {
      if (entry.publication !== undefined && !WorkflowPublicationSchema.safeParse(entry.publication).success) {
        throw new WorkflowContractError('invalid_args', 'cache entry publication must match the publication shape');
      }
    }
    if (spec.baseTree !== undefined && !/^[a-f0-9]{40}$/.test(spec.baseTree)) {
      throw new WorkflowContractError('invalid_args', 'spec.baseTree must be a 40-char lowercase git tree id');
    }
    if (spec.appTarget !== undefined && !AppTargetSchema.safeParse(spec.appTarget).success) {
      throw new WorkflowContractError('invalid_args', 'spec.appTarget must match the application target shape');
    }
    // W7：路由范围逐字段复核；parse 结果顺带落实 defaultHarness 缺省值。
    const routeScope = spec.routeScope === undefined ? undefined : WorkflowRouteScopeSchema.safeParse(spec.routeScope);
    if (routeScope !== undefined && !routeScope.success) {
      throw new WorkflowContractError('invalid_args', 'spec.routeScope must match the route-scope shape');
    }

    const resumeCache = new Map(
      spec.cache.map((entry) => [entry.contentKey, { result: entry.result, fromRunId: entry.fromRunId, publication: entry.publication }]),
    );
    const journal = {
      append: (event: JournalEvent) => spec.journal(event),
    };
    spec.signal?.throwIfAborted();
    const base = {
      signal: spec.signal,
      script: spec.script,
      args: spec.args,
      runId: spec.runId,
      deadlineMs: spec.deadlineMs,
      adapter: this.createAdapter(spec),
      journal,
      resumeCache,
      workerUrl: this.workerUrl,
      maxConcurrentCalls: spec.maxConcurrentCalls,
      baseTree: spec.baseTree,
      appTarget: spec.appTarget,
      publishCandidate: spec.publishCandidate,
      laneWorkspace: spec.laneWorkspace,
      routeScope: routeScope?.data,
    };
    const run = spec.parentRunId === undefined ? await createRun(base) : await resumeRun({ ...base, parentRunId: spec.parentRunId });

    return {
      done: run.done,
      stop: async () => {
        await run.stop();
      },
    };
  }
}
