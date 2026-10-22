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
/**
 * Profile 身份（W4）：内置 Profile 为 `<harnessId>:default`，即该 Harness 在运行环境内的默认登录；
 * 新建 Profile 为 Lab 生成的 UUID。Profile 只引用运行环境内的配置目录，不含任何凭据。
 */
export const HarnessProfileIdSchema = z.union([
  z.string().regex(/^[a-z][a-z0-9-]{0,39}:default$/),
  z.string().regex(/^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/),
]);
export const HarnessRefSchema = z
  .object({
    harnessId: HarnessIdSchema,
    displayName: z.string().min(1).max(80),
    adapter: HarnessAdapterKindSchema,
    version: z.string().max(200).nullable(),
    /** 执行时冻结的 Profile；W4 之前的记录没有该字段。 */
    profileId: HarnessProfileIdSchema.optional(),
  })
  .strict();
/** 某个 Harness 在当前运行环境中能否使用；不可用时说明原因。 */
export const HarnessAvailabilitySchema = z
  .object({
    descriptor: HarnessDescriptorSchema,
    available: z.boolean(),
    reason: z.string().max(2000).nullable(),
  })
  .strict();

/** Lab 为新建 Profile 生成的配置目录根；目录名固定为 `<harnessId>/<profileId>`，用户不能自填路径（W4-4）。 */
export const PROFILE_DIR_ROOT = '/home/agent/.wsl-profiles';
/** 各 Harness 选择配置与登录目录的环境变量；未列出的 Harness 不支持新建 Profile。 */
export const PROFILE_DIR_ENV = { 'claude-code': 'CLAUDE_CONFIG_DIR', codex: 'CODEX_HOME' } as const;
/** 当前允许新建 Profile 的 Harness。sbx 中 Codex 的账号由 sbx secret 决定，只有内置的“sbx 默认”（W4-2）。 */
export const PROFILE_CREATABLE_HARNESSES = ['claude-code'] as const;

/** 传给运行环境的配置目录：只允许约定根目录下的 `<harnessId>/<profileId>`，并只映射到该 Harness 声明的环境变量。 */
export const ProfileDirSchema = z
  .object({
    env: z.enum(['CLAUDE_CONFIG_DIR', 'CODEX_HOME']),
    path: z
      .string()
      .regex(/^\/home\/agent\/\.wsl-profiles\/[a-z][a-z0-9-]{0,39}\/[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/),
  })
  .strict();

/** 无模型自检的结果：只保存解析后的字段，CLI 的原始输出（可能含账号信息）不保存。 */
export const ProfileCheckResultSchema = z
  .object({
    cliVersion: z.string().max(200).nullable(),
    login: z.enum(['logged_in', 'logged_out', 'undetermined']),
    reason: z.string().max(500).nullable(),
  })
  .strict();
export const ProfileCheckSchema = ProfileCheckResultSchema.extend({ checkedAt: z.string().datetime() }).strict();

export const HarnessProfileSchema = z
  .object({
    profileId: HarnessProfileIdSchema,
    harnessId: HarnessIdSchema,
    environmentId: z.literal('sandbox'),
    /** `null` 表示该 Harness 的默认配置目录（内置 Profile）。 */
    configDir: ProfileDirSchema.nullable(),
    label: z.string().trim().min(1).max(60),
    builtin: z.boolean(),
    createdAt: z.string().datetime(),
    check: ProfileCheckSchema.nullable(),
  })
  .strict();

/** 一次选择：用哪个 Harness 的哪个 Profile 执行。 */
export const HarnessSelectionSchema = z.object({ harnessId: HarnessIdSchema, profileId: HarnessProfileIdSchema }).strict();
/** 发往 service 的本轮选择：Main 已解析出配置目录，service 与 helper 再各自校验。 */
export const TurnHarnessSchema = HarnessSelectionSchema.extend({ profileDir: ProfileDirSchema.nullable() }).strict();

/** Main 持有的 Profile 状态快照（W4-5：独立文件，由 Main 单点写入）。 */
export const HarnessProfilesSnapshotSchema = z
  .object({
    profiles: z.array(HarnessProfileSchema).max(32),
    defaultSelection: HarnessSelectionSchema,
  })
  .strict();

export function builtinProfileId(harnessId: string): string {
  return `${harnessId}:default`;
}
export function profileDirOf(harnessId: string, profileId: string): z.infer<typeof ProfileDirSchema> | null {
  const env = (PROFILE_DIR_ENV as Record<string, z.infer<typeof ProfileDirSchema>['env'] | undefined>)[harnessId];
  if (!env || profileId.endsWith(':default')) return null;
  return ProfileDirSchema.parse({ env, path: `${PROFILE_DIR_ROOT}/${harnessId}/${profileId}` });
}

export type HarnessId = z.infer<typeof HarnessIdSchema>;
export type HarnessProfileId = z.infer<typeof HarnessProfileIdSchema>;
export type HarnessAvailability = z.infer<typeof HarnessAvailabilitySchema>;
export type ProfileDir = z.infer<typeof ProfileDirSchema>;
export type ProfileCheckResult = z.infer<typeof ProfileCheckResultSchema>;
export type ProfileCheck = z.infer<typeof ProfileCheckSchema>;
export type HarnessProfile = z.infer<typeof HarnessProfileSchema>;
export type HarnessSelection = z.infer<typeof HarnessSelectionSchema>;
export type TurnHarness = z.infer<typeof TurnHarnessSchema>;
export type HarnessProfilesSnapshot = z.infer<typeof HarnessProfilesSnapshotSchema>;
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

export function harnessRefOf(descriptor: HarnessDescriptor, profileId: HarnessProfileId): HarnessRef {
  return {
    harnessId: descriptor.harnessId,
    displayName: descriptor.displayName,
    adapter: descriptor.adapter,
    version: descriptor.version,
    profileId,
  };
}

/** 界面显示用：执行记录冻结的 Harness 名称；W2 之前的记录没有 Harness 出处，按 Codex CLI 显示。 */
export function harnessDisplayName(source: { harness?: { displayName: string } | null | undefined } | null | undefined): string {
  return source?.harness?.displayName ?? LEGACY_CODEX_HARNESS_REF.displayName;
}

/** 界面显示用：某个选择对应的 Harness 名称；服务尚未报告该 Harness 时显示其标识。 */
export function selectionDisplayName(
  selection: HarnessSelection | null | undefined,
  harnesses: readonly HarnessAvailability[] | null | undefined,
): string {
  if (!selection) return LEGACY_CODEX_HARNESS_REF.displayName;
  return harnesses?.find((item) => item.descriptor.harnessId === selection.harnessId)?.descriptor.displayName ?? selection.harnessId;
}
