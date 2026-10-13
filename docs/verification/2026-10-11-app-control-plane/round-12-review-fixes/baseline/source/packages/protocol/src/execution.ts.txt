import { z } from 'zod';

/** 固定比赛执行/验收状态与已集成 Runner 的说明；外部连接可用性由 ChatStatus 报告。 */
export const HarnessStatusSchema = z.object({
  name: z.literal('Codex CLI'),
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
