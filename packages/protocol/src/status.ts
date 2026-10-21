import { z } from 'zod';
import { AgentControlStateSchema } from './app-control';
import { ChatConversationSchema } from './chat';
import { HarnessStatusSchema } from './execution';
import { ManagedAppSchema } from './managed-app';
import { FileInvalidationHintSchema, ObservationErrorSchema, ObservationRecordSchema, ObservationSchema } from './observation';
import { SetupStageSchema } from './setup';
import { TerminalSnapshotSchema } from './terminal';
import { WorkbenchRunSchema, WorkbenchSessionSchema } from './workspace';

/*
 * 统一状态接口的跨进程 DTO：只含 schema 与类型。
 * 文案、优先级的取值、条件映射与选择逻辑不在此处；事实投影见 apps/desktop/src/shared/status，展示投影只在 Renderer。
 */

export const StatusPhaseSchema = z.enum(['idle', 'pending', 'active', 'ok', 'degraded', 'failed', 'unknown']);
export type StatusPhase = z.infer<typeof StatusPhaseSchema>;

/** 事实种类，决定展示通道；语义见 docs/design/2026-10-11-status-surface/status-interface.md §2。 */
export const StatusKindSchema = z.enum(['progress', 'control', 'unresolved', 'problem', 'confirmation', 'steady', 'capability']);
export type StatusKind = z.infer<typeof StatusKindSchema>;

export const StatusDomainSchema = z.enum([
  'chat',
  'setup',
  'execution',
  'storage',
  'web',
  'terminal',
  'app',
  'run',
  'validation',
  'review',
  'context',
  'observation',
  'file',
]);
export type StatusDomain = z.infer<typeof StatusDomainSchema>;

const Id = z.string().min(1).max(200);

/**
 * 事实的归属范围，供展示层按窗格 / 会话 / 空间取用。
 * 只保留实际需要的四种：全局、空间、空间内资源、空间内会话。
 */
export const StatusScopeSchema = z.discriminatedUnion('kind', [
  z.object({ kind: z.literal('global') }).strict(),
  z.object({ kind: z.literal('workspace'), workspaceId: Id }).strict(),
  z.object({ kind: z.literal('resource'), workspaceId: Id, resourceId: Id }).strict(),
  z.object({ kind: z.literal('session'), workspaceId: Id, sessionId: Id }).strict(),
]);
export type StatusScope = z.infer<typeof StatusScopeSchema>;

/** 动作只映射到现有命令或现有界面动作（status-interface.md §7）。 */
export const StatusActionIdSchema = z.enum([
  'terminal.connect',
  'web.reload',
  'web.reattach',
  'web.resumeAgent',
  'web.cancelPick',
  'run.cancel',
  'run.reconcileCleanup',
  'context.recapture',
  'observation.cancel',
  'app.start',
  'app.manage',
  'app.create',
  'nav.settings',
  'nav.setup',
]);
export type StatusActionId = z.infer<typeof StatusActionIdSchema>;

export const StatusActionSchema = z
  .object({ id: StatusActionIdSchema, label: z.string().min(1).max(60), disabled: z.boolean().optional() })
  .strict();
export type StatusAction = z.infer<typeof StatusActionSchema>;

/*
 * raw 白名单（status-interface.md §8.2）：每个 domain 只允许下列字段，多余字段一律拒绝。
 * 明确排除页面截图与 PageCapture、终端输出、消息正文与草稿、文件内容、观察结果正文、凭据与环境变量、完整 URL 查询串与片段。
 * 字符串字段不设长度上限：超过 2 KiB 的 raw 由投影层截断并标 truncated。
 */
const Truncated = { truncated: z.literal(true).optional() };

export const WebStatusRawSchema = z
  .object({
    instanceId: z.string().nullable().optional(),
    documentGeneration: z.number().int().min(0).optional(),
    cdpState: z.enum(['attached', 'detached', 'idle']).optional(),
    agentControlState: AgentControlStateSchema.shape.state.optional(),
    loadErrorCode: z.number().int().optional(),
    consoleIssueCount: z.number().int().min(0).optional(),
    ...Truncated,
  })
  .strict();

export const TerminalStatusRawSchema = z
  .object({
    instanceId: z.string().nullable().optional(),
    sessionId: z.string().nullable().optional(),
    state: TerminalSnapshotSchema.shape.state.optional(),
    cleanupPending: z.boolean().optional(),
    environmentId: z.string().nullable().optional(),
    outputOffset: z.number().int().nonnegative().optional(),
    ...Truncated,
  })
  .strict();

export const AppStatusRawSchema = z
  .object({
    appInstanceId: z.string().nullable().optional(),
    projectId: z.string().optional(),
    state: ManagedAppSchema.shape.state.optional(),
    cleanupConfirmed: z.boolean().optional(),
    guestPort: z.number().int().nullable().optional(),
    ...Truncated,
  })
  .strict();

export const RunStatusRawSchema = z
  .object({
    state: WorkbenchRunSchema.shape.state.optional(),
    cleanupPending: z.boolean().optional(),
    appCleanupPending: z.boolean().optional(),
    sourceCleanupPending: z.boolean().optional(),
    sourceChangeState: z.enum(['baseline', 'captured', 'unavailable']).optional(),
    executorState: z.object({ state: ChatConversationSchema.shape.state, cleanupPending: z.boolean() }).strict().optional(),
    cleanupRetryAvailable: z.boolean().optional(),
    cleanupReconciling: z.boolean().optional(),
    taskVersionId: z.string().optional(),
    ...Truncated,
  })
  .strict();

export const ValidationStatusRawSchema = z
  .object({
    state: WorkbenchRunSchema.shape.validation.shape.state.optional(),
    applicability: WorkbenchRunSchema.shape.validation.shape.applicability.optional(),
    decision: z.enum(['accepted', 'changes_requested']).nullable().optional(),
    candidateId: z.string().optional(),
    ...Truncated,
  })
  .strict();

export const ContextStatusRawSchema = z
  .object({
    applicability: WorkbenchSessionSchema.shape.contextApplicability.optional(),
    captureRequestId: z.string().nullable().optional(),
    captureState: z.enum(['pending', 'completed', 'failed', 'cancelled']).optional(),
    ...Truncated,
  })
  .strict();

export const ObservationStatusRawSchema = z
  .object({
    tool: ObservationRecordSchema.shape.request.shape.tool.optional(),
    state: ObservationRecordSchema.shape.state.optional(),
    coverageStatus: ObservationSchema.shape.coverage.shape.status.optional(),
    revisionStrength: ObservationSchema.shape.revision.shape.strength.optional(),
    errorCode: ObservationErrorSchema.shape.error.optional(),
    change: FileInvalidationHintSchema.shape.change.optional(),
    ...Truncated,
  })
  .strict();

export const GlobalStatusRawSchema = z
  .object({
    available: z.boolean().optional(),
    stage: SetupStageSchema.optional(),
    busy: z.boolean().optional(),
    errorCode: z.string().optional(),
    harnessState: HarnessStatusSchema.shape.state.optional(),
    restartRequired: z.boolean().optional(),
    ...Truncated,
  })
  .strict();

/** §8.2 未列出 storage；持久化失败的原文只出现在 label 中，raw 不携带任何字段。 */
export const StorageStatusRawSchema = z.object({ ...Truncated }).strict();

export const StatusRawSchemas = {
  chat: GlobalStatusRawSchema,
  setup: GlobalStatusRawSchema,
  execution: GlobalStatusRawSchema,
  storage: StorageStatusRawSchema,
  web: WebStatusRawSchema,
  terminal: TerminalStatusRawSchema,
  app: AppStatusRawSchema,
  run: RunStatusRawSchema,
  validation: ValidationStatusRawSchema,
  review: ValidationStatusRawSchema,
  context: ContextStatusRawSchema,
  observation: ObservationStatusRawSchema,
  file: ObservationStatusRawSchema,
} as const satisfies Record<StatusDomain, z.ZodType>;

export type StatusRawByDomain = { [D in StatusDomain]: z.infer<(typeof StatusRawSchemas)[D]> };
export type StatusRaw = StatusRawByDomain[StatusDomain];

const FactBase = {
  /** `<domain>:<entityId>:<facet>` */
  key: z.string().min(1).max(700),
  facet: z.string().min(1).max(64),
  scope: StatusScopeSchema,
  phase: StatusPhaseSchema,
  kind: StatusKindSchema,
  /** 仅在同一通道内比较；数值越大越靠前。 */
  priority: z.number().int(),
  label: z.string().min(1).max(120),
  detail: z.string().max(300).optional(),
  action: StatusActionSchema.optional(),
  /** 实体实例身份：实例更换后变化，用于使旧确认失效。 */
  instanceToken: z.string().min(1).max(700),
};

const factSchema = <D extends StatusDomain>(domain: D) =>
  z.object({ ...FactBase, domain: z.literal(domain), raw: StatusRawSchemas[domain] }).strict();

/** 域内 raw 与 domain 一一对应：判别联合会拒绝把 A 域的 raw 放进 B 域的事实。 */
export const StatusFactSchema = z.discriminatedUnion('domain', [
  factSchema('chat'),
  factSchema('setup'),
  factSchema('execution'),
  factSchema('storage'),
  factSchema('web'),
  factSchema('terminal'),
  factSchema('app'),
  factSchema('run'),
  factSchema('validation'),
  factSchema('review'),
  factSchema('context'),
  factSchema('observation'),
  factSchema('file'),
]);
export type StatusFact = z.infer<typeof StatusFactSchema>;

const TransitionEndpoint = z.object({ phase: StatusPhaseSchema, kind: StatusKindSchema, label: z.string().max(300) }).strict();
export const StatusTransitionSchema = z
  .object({
    key: z.string().min(1).max(700),
    from: TransitionEndpoint.nullable(),
    to: TransitionEndpoint.nullable(),
    at: z.string(),
    seq: z.number().int().nonnegative(),
  })
  .strict();
export type StatusTransition = z.infer<typeof StatusTransitionSchema>;

/** `debug:status` invoke 的返回值（§8.6）。 */
export const DebugStatusSnapshotSchema = z
  .object({
    appInstanceId: z.string().min(1).max(200),
    seq: z.number().int().nonnegative(),
    generatedAt: z.string(),
    facts: z.array(StatusFactSchema),
    transitions: z.array(StatusTransitionSchema),
  })
  .strict();
export type DebugStatusSnapshot = z.infer<typeof DebugStatusSnapshotSchema>;
