import { z } from 'zod';

/**
 * Agent Harness 的身份与能力（ADR-0003）。
 *
 * - HarnessDescriptor：某个运行环境中一种 Harness 的说明，由 service 侧适配器报告。
 * - HarnessRef：一次执行冻结的 Harness 出处，随 TaskRun 持久化；只作出处，不影响验证适用性（设计 D6）。
 */
export const HarnessIdSchema = z
  .string()
  .regex(/^[a-z][a-z0-9-]{0,39}$/)
  .describe('稳定的 Harness 标识，如 codex、claude-code');
export const HarnessAdapterKindSchema = z.enum(['native', 'acp', 'pty-only', 'remote']);
export const HarnessCapabilitiesSchema = z
  .object({
    structuredEvents: z.boolean(),
    mcp: z.boolean(),
    resume: z.boolean(),
    permissionRequests: z.boolean(),
    clientFs: z.boolean(),
    clientTerminal: z.boolean(),
    readOnlyMode: z.boolean(),
    images: z.boolean(),
  })
  .strict();
export const HarnessDescriptorSchema = z
  .object({
    harnessId: HarnessIdSchema,
    displayName: z.string().min(1).max(80),
    adapter: HarnessAdapterKindSchema,
    /** 实际探测到的 CLI 版本；未探测或不可用时为 null。 */
    version: z.string().max(200).nullable(),
    capabilities: HarnessCapabilitiesSchema,
    /**
     * 能力声明的依据：declared 表示适配器按已有验证记录声明（native 适配器），probed 表示本次实际探测得到。
     */
    capabilitySource: z.enum(['declared', 'probed']),
  })
  .strict();
export const HarnessRefSchema = z
  .object({
    harnessId: HarnessIdSchema,
    displayName: z.string().min(1).max(80),
    adapter: HarnessAdapterKindSchema,
    version: z.string().max(200).nullable(),
  })
  .strict();
export type HarnessId = z.infer<typeof HarnessIdSchema>;
export type HarnessAdapterKind = z.infer<typeof HarnessAdapterKindSchema>;
export type HarnessCapabilities = z.infer<typeof HarnessCapabilitiesSchema>;
export type HarnessDescriptor = z.infer<typeof HarnessDescriptorSchema>;
export type HarnessRef = z.infer<typeof HarnessRefSchema>;

/** 引入 HarnessRef 之前的执行记录都由 sbx 中的 Codex CLI native 路径执行；读取旧记录时按此解释，不改写持久数据。 */
export const LEGACY_CODEX_HARNESS_REF: HarnessRef = Object.freeze({
  harnessId: 'codex',
  displayName: 'Codex CLI',
  adapter: 'native',
  version: null,
}) as HarnessRef;

export function harnessRefOf(descriptor: HarnessDescriptor): HarnessRef {
  return { harnessId: descriptor.harnessId, displayName: descriptor.displayName, adapter: descriptor.adapter, version: descriptor.version };
}

/** 界面显示用：已报告的 Harness 名称，否则按当前唯一接入的 Codex CLI 显示。 */
export function harnessDisplayName(source: { harness?: { displayName: string } | null | undefined } | null | undefined): string {
  return source?.harness?.displayName ?? LEGACY_CODEX_HARNESS_REF.displayName;
}
