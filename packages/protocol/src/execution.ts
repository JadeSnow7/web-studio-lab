import { z } from 'zod';
import { HarnessIdSchema } from './harness';

/** 固定比赛执行/验收状态与已集成 Runner 的说明；外部连接可用性由 ChatStatus 报告。 */
export const HarnessStatusSchema = z.object({
  /** 缺省为 codex（引入多 Harness 之前的状态）。 */
  harnessId: HarnessIdSchema.optional(),
  name: z.string().min(1),
  state: z.enum(['not_integrated', 'integrated', 'unverified', 'verified']),
  version: z.string().nullable(),
  model: z.string().nullable(),
});
export type HarnessStatus = z.infer<typeof HarnessStatusSchema>;

/** 独立检查器未接入的结构化原因（OPS-1 S3）。`not_integrated`：产品检查器尚未接入。 */
export const CheckerUnavailableReasonSchema = z.enum(['not_integrated']);
export type CheckerUnavailableReason = z.infer<typeof CheckerUnavailableReasonSchema>;

/**
 * 独立检查器能力：由 Main 发布的只读投影，不持久化。
 * 只决定“未接入”时的呈现（中性稳态、隐藏运行检查）；不授予接受权限——接受仍要求该候选的检查 passed 且 current。
 */
export const CheckerCapabilitySchema = z.discriminatedUnion('connected', [
  z.object({ connected: z.literal(true) }).strict(),
  z.object({ connected: z.literal(false), reason: CheckerUnavailableReasonSchema }).strict(),
]);
export type CheckerCapability = z.infer<typeof CheckerCapabilitySchema>;

export const ExecutionStatusSchema = z.object({
  available: z.boolean(),
  reason: z.string().nullable(),
  harness: HarnessStatusSchema,
  checker: CheckerCapabilitySchema,
});
export type ExecutionStatus = z.infer<typeof ExecutionStatusSchema>;
