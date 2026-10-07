import { z } from 'zod';

/**
 * 执行服务的接入状态。真实执行服务（T04）与 Codex CLI 通路（T02）接入之前，
 * main 只报告 available=false 与原因，renderer 据此禁用真实执行入口。
 */
export const HarnessStatusSchema = z.object({
  name: z.literal('Codex CLI'),
  state: z.enum(['not_integrated', 'unverified', 'verified']),
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
