import { z } from 'zod';
import { PageIdentitySchema } from './preview';

/** 任务计划第 6 节的三个固定用例。 */
export const CaseIdSchema = z.enum(['c1', 'c2', 'c3']);
export type CaseId = z.infer<typeof CaseIdSchema>;

/** 任务计划决策表的默认运行预算：每个 run 最多 3 次 attempt（初次 + 最多 2 次修复），总时限 15 分钟。 */
export const DEFAULT_BUDGET = { maxAttempts: 3, timeLimitMinutes: 15 } as const;

export const BudgetSchema = z.object({
  maxAttempts: z.number().int().min(1).max(3),
  timeLimitMinutes: z.number().int().min(1).max(15),
});
export type Budget = z.infer<typeof BudgetSchema>;

/** 允许 Agent 修改的项目范围。固定验收与 fixture 永远不在其中。 */
export const AllowedScopeSchema = z.enum(['ui', 'api', 'db-migration', 'shared-types']);
export type AllowedScope = z.infer<typeof AllowedScopeSchema>;

/** 任务确认时引用的页面现场。只保留引用与摘要，截图留在采集记录里。 */
export const CaptureRefSchema = z.object({
  captureId: z.string(),
  capturedAt: z.string(),
  page: PageIdentitySchema,
  elementSelector: z.string(),
  elementText: z.string(),
});
export type CaptureRef = z.infer<typeof CaptureRefSchema>;

/**
 * 开发者确认后的任务输入，确认后不可变。目标、范围、验收或预算变化时产生新版本，
 * 旧版本与其运行结果保留。
 */
export const TaskVersionSchema = z.object({
  taskId: z.string(),
  version: z.number().int().min(1),
  confirmedAt: z.string(),
  caseId: CaseIdSchema,
  goal: z.string().trim().min(1),
  allowedScopes: z.array(AllowedScopeSchema).min(1),
  acceptance: z.array(z.string().trim().min(1)).min(1),
  budget: BudgetSchema,
  capture: CaptureRefSchema,
});
export type TaskVersion = z.infer<typeof TaskVersionSchema>;
