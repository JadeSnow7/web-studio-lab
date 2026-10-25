import { AppImportRequestSchema, AppImportTargetSchema, AppImportOutcomeSchema } from './app-import';
import { WorkspaceObservationResultSchema, ObservationRequestSchema as RequestSchema, ObservationTurnScopeSchema } from './observation';
import { EnvironmentListSchema, RuntimeResourceIdentitySchema } from './environments';
import {
  ObservationRequestSchema,
  ObservationResultSchema,
  ResourceInstanceIdentitySchema,
  FileInvalidationHintSchema,
} from './observation';
import { z } from 'zod';
import { AppSourceApplyResultSchema, AppSourceSnapshotResultSchema } from './source-change';
import { AppTargetSchema, AppSourceFileSchema, AppSourceApplyFilesSchema, ManagedAppSchema, AppSourceSchema } from './managed-app';
import { AppAgentOperationSchema, AppAgentResultSchema, AppControlResultSchema, AppLogsSchema, AppToolNameSchema } from './app-control';
const BufferlessBytes = (value: string) => {
  let bytes = 0;
  for (const char of value) {
    const code = char.codePointAt(0)!;
    bytes += code < 128 ? 1 : code < 2048 ? 2 : code < 65536 ? 3 : 4;
  }
  return bytes;
};
import { TerminalOpenSchema, TerminalWriteSchema, TerminalResizeSchema, TerminalTargetSchema, TerminalSnapshotSchema } from './terminal';

import { ChatSlotSchema } from './chat-slot';
export { ChatSlotSchema } from './chat-slot';
import {
  WorkflowCacheEntrySchema,
  WorkflowCandidatePayloadSchema,
  WorkflowInputFileSchema,
  WorkflowJournalEventSchema,
  WorkflowPublicationSchema,
  WorkflowRouteScopeSchema,
  WorkflowRunInputSchema,
  WorkflowRunOutcomeSchema,
} from './workflow';
import { CatalogReferenceSnapshotSchema } from './resource-catalog';
import { HarnessAvailabilitySchema, ProfileCheckResultSchema, ProfileDirSchema, HarnessIdSchema, TurnHarnessSchema } from './harness';
export const ChatStatusSchema = z.object({
  available: z.boolean(),
  reason: z.string().nullable(),
  version: z.string().nullable(),
  sandbox: z.string().nullable(),
  cwd: z.string().nullable(),
  /** 本服务已注册的全部 Harness 及其可用性（W4）；按执行选择其一。 */
  harnesses: z.array(HarnessAvailabilitySchema).max(16),
});
export const ChatMessageSchema = z.object({ id: z.string(), role: z.enum(['user', 'assistant']), text: z.string() });
/**
 * 等待用户决定的 Agent 权限请求（W4b）。内容来自 Agent，按不可信数据展示；只含一次性选项，
 * 截止时间到后由执行核心按拒绝处理。
 */
export const PermissionRequestSchema = z
  .object({
    requestId: z.string().uuid(),
    turnId: z.string(),
    toolCallId: z.string().max(200),
    title: z.string().max(200),
    kind: z.string().max(40),
    options: z
      .array(
        z.object({ optionId: z.string().min(1).max(200), name: z.string().max(200), kind: z.enum(['allow_once', 'reject_once']) }).strict(),
      )
      .min(1)
      .max(4),
    requestedAt: z.string().datetime(),
    expiresAt: z.string().datetime(),
  })
  .strict();
export const PermissionReplySchema = z
  .object({ conversationId: ChatSlotSchema, requestId: z.string().uuid(), optionId: z.string().min(1).max(200).nullable() })
  .strict();
export const ChatConversationSchema = z.object({
  conversationId: ChatSlotSchema,
  generation: z.string(),
  seq: z.number().int().nonnegative(),
  threadId: z.string().nullable(),
  turnId: z.string().nullable(),
  state: z.enum(['idle', 'running', 'cancelling', 'cancelled', 'failed']),
  messages: z.array(ChatMessageSchema),
  toolExecutions: z
    .array(
      z.object({
        id: z.string(),
        turnId: z.string(),
        command: z.string().max(4000),
        output: z.string().max(16000),
        exitCode: z.number().int().nullable(),
        truncated: z.boolean(),
      }),
    )
    .max(100)
    .refine((tools) => tools.reduce((sum, tool) => sum + tool.output.length, 0) <= 131072, '工具输出超过总长度限制'),
  warnings: z.array(z.string().max(2000)).max(20),
  /** 待用户决定的权限请求（W4b）；执行服务总是写入，旧快照没有该字段时视为空。 */
  permissionRequests: z.array(PermissionRequestSchema).max(4).optional(),
  cleanupPending: z.boolean(),
  error: z.string().nullable(),
});
export const ChatSendSchema = z
  .object({
    conversationId: ChatSlotSchema,
    text: z.string().trim().min(1).max(32000),
    observationScope: ObservationTurnScopeSchema.optional(),
    references: CatalogReferenceSnapshotSchema,
    /** 本轮使用的 Harness 与 Profile，由 Main 解析后传入（W4）。 */
    harness: TurnHarnessSchema,
  })
  .strict();
/** 无模型自检一个 Profile：在运行环境内以其配置目录运行版本与登录状态命令。 */
export const ProfileCheckRequestSchema = z.object({ harnessId: HarnessIdSchema, profileDir: ProfileDirSchema.nullable() }).strict();
export const ChatTargetSchema = z.object({ conversationId: ChatSlotSchema });
export const ChatServiceRequestSchema = z.discriminatedUnion('method', [
  z
    .object({
      id: z.string(),
      method: z.literal('app.source.snapshot'),
      payload: z.object({ callId: z.uuid(), target: AppTargetSchema }).strict(),
    })
    .strict(),
  z.object({ id: z.string(), method: z.literal('app.source.cancel'), payload: z.object({ callId: z.uuid() }).strict() }).strict(),
  z
    .object({
      id: z.string(),
      method: z.literal('app.source.apply'),
      payload: z.object({ callId: z.uuid(), target: AppTargetSchema, files: AppSourceApplyFilesSchema }).strict(),
    })
    .strict(),
  z
    .object({
      id: z.string(),
      method: z.literal('app.create'),
      payload: AppTargetSchema.extend({ files: z.array(AppSourceFileSchema).min(1).max(256) }),
    })
    .strict(),
  z.object({ id: z.string(), method: z.literal('app.importSource'), payload: AppImportRequestSchema }).strict(),
  z.object({ id: z.string(), method: z.literal('app.cancelImport'), payload: AppImportTargetSchema }).strict(),
  ...(['app.get', 'app.start', 'app.stop', 'app.export'] as const).map((method) =>
    z.object({ id: z.string(), method: z.literal(method), payload: AppTargetSchema }).strict(),
  ),
  z
    .object({
      id: z.string(),
      method: z.literal('app.reply'),
      payload: z.object({ callId: z.string().uuid(), result: AppControlResultSchema }).strict(),
    })
    .strict(),
  z
    .object({
      id: z.string(),
      method: z.literal('app.agent'),
      payload: z
        .object({
          callId: z.string().uuid(),
          target: AppTargetSchema,
          appInstanceId: z.string().min(1).max(200).nullable(),
          operation: AppAgentOperationSchema,
        })
        .strict(),
    })
    .strict(),
  z.object({ id: z.string(), method: z.literal('app.agent.cancel'), payload: z.object({ callId: z.string().uuid() }).strict() }).strict(),
  z
    .object({
      id: z.string(),
      method: z.literal('app.logs'),
      payload: z.object({ target: AppTargetSchema, maxBytes: z.number().int().min(1).max(65536) }).strict(),
    })
    .strict(),
  z
    .object({
      id: z.string(),
      method: z.literal('observation.reply'),
      payload: z.object({ callId: z.string().uuid(), result: WorkspaceObservationResultSchema }).strict(),
    })
    .strict(),
  z.object({ id: z.string(), method: z.literal('status') }),
  z.object({ id: z.string(), method: z.literal('profile.check'), payload: ProfileCheckRequestSchema }).strict(),
  z.object({ id: z.string(), method: z.literal('permission.reply'), payload: PermissionReplySchema }).strict(),
  z.object({ id: z.string(), method: z.literal('environments.list') }).strict(),
  z.object({ id: z.string(), method: z.literal('resource.register'), payload: RuntimeResourceIdentitySchema }).strict(),
  z.object({ id: z.string(), method: z.literal('resource.release'), payload: RuntimeResourceIdentitySchema }).strict(),
  z.object({ id: z.string(), method: z.literal('observation.read'), payload: ObservationRequestSchema }).strict(),
  z
    .object({
      id: z.string(),
      method: z.literal('observation.cancel'),
      payload: z.object({ requestId: z.string().min(1).max(200) }).strict(),
    })
    .strict(),
  z
    .object({
      id: z.string(),
      method: z.literal('register'),
      payload: z.object({ conversationId: ChatSlotSchema, workspaceId: z.string().min(1) }),
    })
    .strict(),
  z.object({ id: z.string(), method: z.literal('get'), payload: ChatTargetSchema }),
  z.object({ id: z.string(), method: z.literal('send'), payload: ChatSendSchema }),
  z.object({ id: z.string(), method: z.literal('cancel'), payload: ChatTargetSchema }),
  z.object({ id: z.string(), method: z.literal('reset'), payload: ChatTargetSchema }),
  z.object({ id: z.string(), method: z.literal('terminal.get'), resourceId: z.string().min(1) }),
  /**
   * W4 workflow：Main 受理一次固定任务运行。spec 身份（runId、parentRunId、cache 出处）已由 Main 核对；
   * run 的 journal 事件经 workflow-event 逐条回传（service 等待对应 workflow-event-ack 才继续），
   * 终态经 workflow-done 单独发布。
   */
  z
    .object({
      id: z.string(),
      method: z.literal('workflow-run'),
      runId: z.string().min(1).max(200),
      script: z.string(),
      args: z.unknown().optional(),
      deadlineMs: z.number().int().positive().optional(),
      input: WorkflowRunInputSchema.optional(),
      cache: z.array(WorkflowCacheEntrySchema).optional(),
      parentRunId: z.string().min(1).max(200).optional(),
      /** W6a：受理时建立的候选基线树，经 spec 传给 service 并回显进 run 事件。 */
      baseTree: WorkflowPublicationSchema.shape.baseTree.optional(),
      /** W6a：候选发布面向的应用目标。 */
      appTarget: AppTargetSchema.optional(),
      /** W7：本 run 授权的路由范围；缺省 → service 维持单适配器（opts.profile 只记录不路由）。 */
      routeScope: WorkflowRouteScopeSchema.optional(),
    })
    .strict(),
  z.object({ id: z.string(), method: z.literal('workflow-stop'), runId: z.string().min(1).max(200) }).strict(),
  /**
   * W6a：lane 候选发布的 Main→service 回执。callId 与 workflow-candidate 消息的 id 相等；
   * ok:true+publication 为已登记的发布事实，ok:true+conflict 为合并冲突（W8：候选保留、
   * 指针不动，调用以 conflict 终态交付），ok:false 使对应 lane 调用以 internal 失败。
   */
  z
    .object({
      id: z.string(),
      method: z.literal('workflow-candidate.reply'),
      payload: z
        .object({
          callId: z.string().uuid(),
          result: z.union([
            z.object({ ok: z.literal(true), publication: WorkflowPublicationSchema }).strict(),
            z
              .object({
                ok: z.literal(true),
                conflict: z
                  .object({ files: z.array(z.string()).max(256), candidateRef: WorkflowPublicationSchema.shape.afterTree })
                  .strict(),
              })
              .strict(),
            z.object({ ok: z.literal(false), error: z.string().min(1).max(2000) }).strict(),
          ]),
        })
        .strict(),
    })
    .strict(),
  /**
   * W8：lane attempt 工作区的 Main→service 回执。callId 与 workflow-lanebase 消息的 id 相等；
   * ok:true 携带该调用登记时的基线树与其物化文件集，ok:false 使 lane 调用不派发 attempt。
   */
  z
    .object({
      id: z.string(),
      method: z.literal('workflow-lanebase.reply'),
      payload: z
        .object({
          callId: z.string().uuid(),
          result: z.union([
            z
              .object({
                ok: z.literal(true),
                baseTree: WorkflowPublicationSchema.shape.baseTree,
                files: z.array(WorkflowInputFileSchema).max(256),
              })
              .strict(),
            z.object({ ok: z.literal(false), error: z.string().min(1).max(2000) }).strict(),
          ]),
        })
        .strict(),
    })
    .strict(),
  /** Close only the workflow owner while retaining journal/candidate receipt transport. */
  z.object({ id: z.string(), method: z.literal('workflow-shutdown') }).strict(),
  /** Main 侧 journal 落盘回执；ok:false 时 run 记 internal_error。 */
  z
    .object({
      id: z.string(),
      method: z.literal('workflow-event-ack'),
      runId: z.string().min(1).max(200),
      seq: z.number().int().positive(),
      ok: z.boolean(),
      error: z.string().max(2000).optional(),
    })
    .strict(),
  z.object({ id: z.string(), method: z.literal('terminal.open'), payload: TerminalOpenSchema }),
  z.object({ id: z.string(), method: z.literal('terminal.write'), payload: TerminalWriteSchema }),
  z.object({ id: z.string(), method: z.literal('terminal.resize'), payload: TerminalResizeSchema }),
  z.object({ id: z.string(), method: z.literal('terminal.close'), payload: TerminalTargetSchema }),
  z.object({ id: z.string(), method: z.literal('shutdown') }),
]);
export const ChatServiceMessageSchema = z.discriminatedUnion('type', [
  z.object({ type: z.literal('initialized'), status: ChatStatusSchema, cleanupPending: z.boolean() }),
  z.object({ type: z.literal('app-event'), snapshot: ManagedAppSchema }).strict(),
  z.object({ type: z.literal('event'), conversation: ChatConversationSchema }),
  z.object({
    type: z.literal('terminal-event'),
    terminal: TerminalSnapshotSchema,
    resourceId: z.string().min(1),
    binding: ResourceInstanceIdentitySchema,
  }),
  z.object({ type: z.literal('file-hint'), hint: FileInvalidationHintSchema }).strict(),
  z
    .object({
      type: z.literal('observation-call'),
      id: z.string().uuid(),
      scope: ObservationTurnScopeSchema,
      tool: RequestSchema.shape.tool,
      args: z.record(z.string(), z.unknown()).refine((args) => BufferlessBytes(JSON.stringify(args)) <= 16384),
    })
    .strict(),
  z.object({ type: z.literal('observation-abort'), id: z.string().uuid() }).strict(),
  z
    .object({
      type: z.literal('app-call'),
      id: z.string().uuid(),
      scope: ObservationTurnScopeSchema,
      tool: AppToolNameSchema,
      args: z.record(z.string(), z.unknown()).refine((args) => BufferlessBytes(JSON.stringify(args)) <= 16384),
    })
    .strict(),
  z.object({ type: z.literal('app-abort'), id: z.string().uuid() }).strict(),
  /** W4 workflow：内核提交的每条 journal 事件；seq 每 run 从 1 单调递增，等待对应 workflow-event-ack。 */
  z
    .object({ type: z.literal('workflow-event'), runId: z.string(), seq: z.number().int().positive(), event: WorkflowJournalEventSchema })
    .strict(),
  /** W4 workflow：内核清理已确认（worker dispose、终态事件已提交）后的 run 终态。 */
  z.object({ type: z.literal('workflow-done'), runId: z.string(), outcome: WorkflowRunOutcomeSchema }).strict(),
  /** An execution failure does not prove guest cleanup. Keep the owner pending reconciliation. */
  z.object({ type: z.literal('workflow-cleanup-unconfirmed'), runId: z.string(), error: z.string() }).strict(),
  /**
   * W6a：lane 调用在 call_end 之前向 Main 请求候选发布。id 与 workflow-candidate.reply
   * 的 payload.callId 对应；文件集为 attempt workspace 采集的快照（≤256、按导出预算校验）。
   */
  z.object({ type: z.literal('workflow-candidate'), id: z.string().uuid(), ...WorkflowCandidatePayloadSchema.shape }).strict(),
  /**
   * W8：lane 调用首次派发前向 Main 请求本调用的工作区（call_start 时冻结的基线树的物化）。
   * id 与 workflow-lanebase.reply 的 payload.callId 对应；波次内各调用共享同一登记基线。
   */
  z
    .object({
      type: z.literal('workflow-lanebase'),
      id: z.string().uuid(),
      runId: z.string().min(1).max(200),
      callSeq: z.number().int().positive(),
    })
    .strict(),
  z.object({
    type: z.literal('response'),
    id: z.string(),
    result: z.union([
      AppSourceSnapshotResultSchema,
      AppSourceApplyResultSchema,
      AppAgentResultSchema,
      AppLogsSchema,
      ManagedAppSchema,
      AppSourceSchema,
      AppImportOutcomeSchema,
      ChatStatusSchema,
      ProfileCheckResultSchema,
      ChatConversationSchema,
      TerminalSnapshotSchema,
      EnvironmentListSchema,
      ObservationResultSchema,
      z.null(),
    ]),
  }),
  z.object({ type: z.literal('error'), id: z.string(), error: z.string() }),
]);
export type ChatSlot = z.infer<typeof ChatSlotSchema>;
export type ChatStatus = z.infer<typeof ChatStatusSchema>;
/** 运行环境连接本身的状态（sandbox、CLI 版本、工作目录），不含 Harness 可用性；由执行核心补全为 ChatStatus。 */
export type SandboxStatus = Omit<ChatStatus, 'harnesses'>;
export type ChatConversation = z.infer<typeof ChatConversationSchema>;
export type PermissionRequest = z.infer<typeof PermissionRequestSchema>;
export type PermissionReply = z.infer<typeof PermissionReplySchema>;
export type ChatServiceRequest = z.infer<typeof ChatServiceRequestSchema>;
export type ChatServiceMessage = z.infer<typeof ChatServiceMessageSchema>;
