import type { WorkflowInputFile, WorkflowIsolation, WorkflowPublication } from '@wsl/protocol';
import type { CallFailureCode } from './contract';

/** The owning process could not confirm cleanup; this cannot become an ordinary call failure or release a Profile. */
export class WorkflowCleanupUnconfirmedError extends Error {
  readonly code = 'workflow_cleanup_unconfirmed' as const;
  constructor(message: string) {
    super(message);
    this.name = 'WorkflowCleanupUnconfirmedError';
  }
}

/**
 * WorkflowCallAdapter 端口（合同 §8）：一次 attempt 的调用。
 * 适配器产出恰好一个终态事件；result 区分 text/json，schema 校验由内核做。
 * signal 中止后的正常结束表示所属清理已确认；未确认时 next/return 须抛
 * WorkflowCleanupUnconfirmedError，由 owner 保留占用，不能产出普通终态。
 */
export interface EffectiveSemantics {
  harness: string;
  profile?: string;
  /** W7：profile 由路由自动解析而来（显式指定的 profile 无此标记）；随 effective 进入调用身份。 */
  profileAuto?: boolean;
  model?: string;
  tier?: 'small' | 'medium' | 'big';
  tools?: string[];
}

export interface WorkflowCall {
  callId: string;
  prompt: string;
  label: string | null;
  phase: string | null;
  effective: EffectiveSemantics;
  schema: Record<string, unknown> | null;
  /** W6a：readonly 只读；lane 在独立 attempt 候选目录内可写并采集候选快照。 */
  isolation: WorkflowIsolation;
  tools: string[];
  timeoutMs: number;
  /**
   * W8：lane 调用的工作区文件集（laneWorkspace 端口取回的登记基线物化）；
   * 缺省时适配器回退到 run 级冻结输入。仅 lane 调用可能携带。
   */
  laneInput?: WorkflowInputFile[];
}

/** 一次 attempt 报告的模型用量；Harness 未提供时缺省（unknown，不记 0）。 */
export interface CallUsage {
  inputTokens: number;
  outputTokens: number;
}

/** W6a：lane attempt 成功后由 guest helper 采集的候选文件集，随 result 事件带回内核。 */
export interface WorkflowCandidate {
  files: WorkflowInputFile[];
}

/** W8：laneWorkspace 端口取回的 lane attempt 工作区——登记基线树与其物化文件集。 */
export interface WorkflowLaneWorkspace {
  baseTree: string;
  files: WorkflowInputFile[];
}

/**
 * W8：lane 候选发布端口的返回联合——已登记 publication 或合并冲突事实
 * （files 为重叠且结果不同的路径，candidateRef 为保留的诊断候选树）。
 */
export type WorkflowPublishOutcome = { publication: WorkflowPublication } | { conflict: { files: string[]; candidateRef: string } };

export type CallEvent =
  | { type: 'result'; text: string; usage?: CallUsage; candidate?: WorkflowCandidate }
  | { type: 'result'; json: unknown; usage?: CallUsage; candidate?: WorkflowCandidate }
  | { type: 'failed'; code: CallFailureCode; message: string };

/** W7：路由解析结果——该调用冻结使用的 Harness 与 Profile 成员；provenance 区分显式指定与自动选择。 */
export interface RouteResolution {
  harnessId: string;
  profileId: string;
  provenance: 'explicit' | 'auto';
}

/** W7：路由拒绝——与 opts 校验失败走同一 call 级终态（通常 unsupported_option）。 */
export interface RouteRejection {
  code: CallFailureCode;
  message: string;
}

/**
 * W9：登记期的执行选项表达力核对请求。isolation 已由 validateOpts 收敛到 readonly|lane；
 * model/tier 是冻结进 effective 的推理选项——适配器据此判断启动 argv 能否表达该组合。
 */
export interface ExecutionCapabilityRequest {
  harness: string;
  /** 路由解析后冻结的 profile（成员身份）；单适配器路径缺省。 */
  profile?: string;
  isolation: WorkflowIsolation;
  model?: string;
  tier?: 'small' | 'medium' | 'big';
}

export interface WorkflowCallAdapter {
  readonly harnessId: string;
  /**
   * W7：把已校验的请求语义解析为路由成员（登记期一次，解析结果冻结进 effective 与 attempt route）。
   * 缺省实现 = 单适配器：内核维持既有行为，opts.profile 只记录不参与路由。
   */
  resolveRoute?(requested: { harness: string; profile?: string }): RouteResolution | RouteRejection;
  /**
   * W9：登记期核对「isolation + model/tier」能否表达为本适配器的启动 argv。
   * 返回 RouteRejection → 与路由拒绝同路径（call_start/call_end 照写、不派发 attempt）；
   * 返回 null 或未实现 → 放行，由 run() 入口的 argv 组装兜底（null → failed{unsupported_option}）。
   * 早拒绝优先：表达不出的组合在 attempt_start 之前失败，不消耗一次注定丢弃的执行。
   */
  checkExecution?(request: ExecutionCapabilityRequest): RouteRejection | null;
  run(call: WorkflowCall, signal: AbortSignal): AsyncIterable<CallEvent>;
}
