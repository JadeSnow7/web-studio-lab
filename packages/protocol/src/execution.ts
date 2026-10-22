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

export const ExecutionStatusSchema = z.object({
  available: z.boolean(),
  reason: z.string().nullable(),
  harness: HarnessStatusSchema,
});
export type ExecutionStatus = z.infer<typeof ExecutionStatusSchema>;
