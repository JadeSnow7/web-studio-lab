import { WorkspaceObservationResultSchema, ObservationRequestSchema as RequestSchema, ObservationTurnScopeSchema } from './observation';
import { EnvironmentListSchema, RuntimeResourceIdentitySchema } from './environments';
import {
  ObservationRequestSchema,
  ObservationResultSchema,
  ResourceInstanceIdentitySchema,
  FileInvalidationHintSchema,
} from './observation';
import { z } from 'zod';
import { AppSourceSnapshotResultSchema } from './source-change';
import { AppTargetSchema, AppSourceFileSchema, ManagedAppSchema, AppSourceSchema } from './managed-app';
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
      .array(z.object({ optionId: z.string().min(1).max(200), name: z.string().max(200), kind: z.enum(['allow_once', 'reject_once']) }).strict())
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
      method: z.literal('app.create'),
      payload: AppTargetSchema.extend({ files: z.array(AppSourceFileSchema).min(1).max(256) }),
    })
    .strict(),
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
  z.object({
    type: z.literal('response'),
    id: z.string(),
    result: z.union([
      AppSourceSnapshotResultSchema,
      AppAgentResultSchema,
      AppLogsSchema,
      ManagedAppSchema,
      AppSourceSchema,
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
