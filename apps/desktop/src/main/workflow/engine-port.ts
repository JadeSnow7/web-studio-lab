import type {
  AppTarget,
  WorkflowCacheEntry,
  WorkflowJournalEvent,
  WorkflowPublication,
  WorkflowRouteScope,
  WorkflowRunInput,
  WorkflowRunOutcome,
} from '@wsl/protocol';

/**
 * Main↔service 边界的窄端口（W2）：WorkflowApplication 只经此接口受理运行，
 * service 侧由 WorkflowEngine 实现同一形状。DTO 全部来自 @wsl/protocol。
 */
export interface WorkflowEngineRunSpec {
  runId: string;
  script: string;
  args: unknown;
  deadlineMs?: number;
  /** 续跑注入的已提交结果缓存（祖先链近者优先）；新建运行为空数组。 */
  cache: WorkflowCacheEntry[];
  /** journal 沉点：内核逐条 await；拒绝会使 run failed{internal_error}。 */
  journal: (event: WorkflowJournalEvent) => Promise<void>;
  parentRunId?: string;
  /** run 级冻结输入（W3）：由 service 侧适配器在每次 attempt 物化到独立目录。 */
  input?: WorkflowRunInput;
  /** W6a：受理时建立的候选基线树，经 spec 传给 service 并回显进 run 事件。 */
  baseTree?: string;
  /** W6a：候选发布面向的应用目标，经 spec 传给 service 并回显进 run 事件。 */
  appTarget?: AppTarget;
  /** W7：受理时注入的路由范围；缺省 → service 维持单适配器（opts.profile 只记录不路由）。 */
  routeScope?: WorkflowRouteScope;
}

/**
 * W6a/W8：service → Main 的 lane 候选发布请求（workflow-candidate 消息载荷的接收端）。
 * W8 返回联合：publication = 已登记合并发布；conflict = 合并冲突（files + 保留候选树）。
 * 结果经 workflow-candidate.reply 回执给 service，进入 call_end。
 */
export type WorkflowPublishResult = { publication: WorkflowPublication } | { conflict: { files: string[]; candidateRef: string } };

export interface WorkflowCandidatePublisher {
  publishCandidate(runId: string, callSeq: number, files: { path: string; base64: string }[]): Promise<WorkflowPublishResult>;
}

/**
 * W8：service → Main 的 lane attempt 工作区请求（workflow-lanebase 消息载荷的接收端）。
 * 返回该调用登记时冻结的候选基线树与其物化文件集；失败回执 ok:false。
 */
export interface WorkflowLaneWorkspaceProvider {
  laneWorkspace(runId: string, callSeq: number): Promise<{ baseTree: string; files: { path: string; base64: string }[] }>;
}

export interface WorkflowEngineRunHandle {
  /** resolve confirms cleanup and committed terminal receipts; rejection leaves an owner needing reconciliation. */
  done: Promise<WorkflowRunOutcome>;
  stop(): Promise<void>;
}

export interface WorkflowEnginePort {
  /** Synchronously revoke remote admission, then await its owned cleanup receipts. */
  shutdown(): Promise<void>;
  run(spec: WorkflowEngineRunSpec): WorkflowEngineRunHandle | Promise<WorkflowEngineRunHandle>;
}

/** Remote admission/cleanup cannot be established after a lost or negative receipt. */
export class WorkflowProcessUnconfirmedError extends Error {
  readonly code = 'process_unconfirmed';
}
