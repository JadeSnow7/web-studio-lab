import { z } from 'zod';
import { BudgetSchema, CaseIdSchema } from './task';

/**
 * 记录来源。demo 只用于界面检查，内容由仓库内的演示数据给出，
 * 不是任何真实进程、模型或验收的结果；live 留给执行服务（T04）产生的真实记录。
 */
export const RunOriginSchema = z.enum(['demo', 'live']);
export type RunOrigin = z.infer<typeof RunOriginSchema>;

/** online 调用模型；revalidate 不调用模型，重新执行固定验收。历史查看只读取记录，不是一种 run。 */
export const RunModeSchema = z.enum(['online', 'revalidate']);
export type RunMode = z.infer<typeof RunModeSchema>;

export const RUN_TERMINAL_STATUSES = ['passed', 'failed', 'inconclusive', 'timed_out', 'cancelled'] as const;

export const RunStatusSchema = z.enum(['queued', 'running', 'cancelling', ...RUN_TERMINAL_STATUSES]);
export type RunStatus = z.infer<typeof RunStatusSchema>;

export const RunStageSchema = z.enum(['preparing', 'agent', 'app_starting', 'app_ready', 'accepting']);
export type RunStage = z.infer<typeof RunStageSchema>;

/**
 * 单项检查结果。error 表示检查工具自身故障，无法得出结论，与业务上的 fail 分开。
 */
export const CheckResultSchema = z.enum(['pass', 'fail', 'error', 'running', 'pending', 'not_run']);
export type CheckResult = z.infer<typeof CheckResultSchema>;

export const CheckSchema = z.object({
  id: z.string(),
  label: z.string(),
  runner: z.enum(['api', 'playwright', 'service']),
  result: CheckResultSchema,
  detail: z.string().nullable(),
});
export type Check = z.infer<typeof CheckSchema>;

export const FileChangeSchema = z.object({
  path: z.string(),
  change: z.enum(['added', 'modified', 'deleted']),
  additions: z.number().int().min(0),
  deletions: z.number().int().min(0),
});
export type FileChange = z.infer<typeof FileChangeSchema>;

/**
 * attempt 的结论。inconclusive 用于工具故障（例如验收浏览器无法启动、CDP 断开），
 * 不能当作业务验收失败或通过。
 */
export const AttemptOutcomeSchema = z.enum(['running', 'passed', 'failed', 'inconclusive', 'cancelled', 'timed_out']);
export type AttemptOutcome = z.infer<typeof AttemptOutcomeSchema>;

export const AttemptSchema = z.object({
  attemptId: z.string(),
  index: z.number().int().min(1),
  stage: RunStageSchema,
  outcome: AttemptOutcomeSchema,
  reason: z.string().nullable(),
  startedAt: z.string(),
  endedAt: z.string().nullable(),
  files: z.array(FileChangeSchema),
  checks: z.array(CheckSchema),
});
export type Attempt = z.infer<typeof AttemptSchema>;

export const SourceStateSchema = z.object({
  baseCommit: z.string(),
  diffHash: z.string(),
});
export type SourceState = z.infer<typeof SourceStateSchema>;

/** run 登记的子进程。取消时只有全部 exited 才能进入 cancelled。 */
export const RunProcessSchema = z.object({
  name: z.string(),
  pgid: z.number().int(),
  state: z.enum(['running', 'term_sent', 'kill_sent', 'exited']),
});
export type RunProcess = z.infer<typeof RunProcessSchema>;

export const RunEventSchema = z.object({
  seq: z.number().int().min(1),
  timestamp: z.string(),
  type: z.string(),
  detail: z.string(),
});
export type RunEvent = z.infer<typeof RunEventSchema>;

/**
 * 开发者审阅与 run 结论分开记录。accepted 必须绑定任务版本与源码快照；
 * changes_requested 需要说明原因，后续修改产生新的任务版本。
 */
export const ReviewSchema = z.discriminatedUnion('state', [
  z.object({ state: z.literal('not_ready') }),
  z.object({ state: z.literal('pending') }),
  z.object({
    state: z.literal('accepted'),
    decidedAt: z.string(),
    taskVersion: z.number().int().min(1),
    sourceState: SourceStateSchema,
  }),
  z.object({
    state: z.literal('changes_requested'),
    decidedAt: z.string(),
    taskVersion: z.number().int().min(1),
    note: z.string().trim().min(1),
  }),
]);
export type Review = z.infer<typeof ReviewSchema>;

export const RunRecordSchema = z.object({
  runId: z.string(),
  origin: RunOriginSchema,
  mode: RunModeSchema,
  caseId: CaseIdSchema,
  taskRef: z.object({ taskId: z.string(), version: z.number().int().min(1) }),
  harness: z.object({ name: z.literal('Codex CLI'), version: z.string().nullable(), model: z.string().nullable() }),
  budget: BudgetSchema,
  status: RunStatusSchema,
  statusReason: z.string().nullable(),
  startedAt: z.string(),
  endedAt: z.string().nullable(),
  sourceState: SourceStateSchema.nullable(),
  attempts: z.array(AttemptSchema),
  processes: z.array(RunProcessSchema),
  events: z.array(RunEventSchema),
  /** 最终源码相对于基线的统一 diff 文本。 */
  diff: z.string(),
  review: ReviewSchema,
});
export type RunRecord = z.infer<typeof RunRecordSchema>;

export function isTerminalStatus(status: RunStatus): boolean {
  return (RUN_TERMINAL_STATUSES as readonly string[]).includes(status);
}
