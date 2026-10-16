import {
  EduAdmissionRecoveryStatusSchema,
  EduVerificationBeginSchema,
  EduVerificationTargetSchema,
  EduVerificationStatusSchema,
} from './edu-verification';
import { EduTaskBindingSchema, EduTaskDispatchRejectionSchema, EduTaskOperationResultSchema } from './edu-task';
import { MotaTaskBindingSchema, MotaControlRequestSchema, MotaControlResponseSchema } from './mota-control';
import { WorkspaceObservationResultSchema, ObservationRequestSchema as RequestSchema, ObservationTurnScopeSchema } from './observation';
import { EnvironmentListSchema, RuntimeResourceIdentitySchema } from './environments';
import {
  ObservationRequestSchema,
  ObservationResultSchema,
  ResourceInstanceIdentitySchema,
  FileInvalidationHintSchema,
} from './observation';
import { z } from 'zod';
import { AppTargetSchema, AppSourceFileSchema, ManagedAppSchema, AppSourceSchema, EduImportSchema } from './managed-app';
import { AppImportRequestSchema, AppImportTargetSchema, AppImportOutcomeSchema } from './app-import';
import { AppSourceSnapshotResultSchema } from './source-change';
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
import { ResearchCallSchema, ResearchGrantSchema, ResearchNativeSearchRecordsSchema, ResearchReplySchema } from './research';
export const ChatStatusSchema = z.object({
  available: z.boolean(),
  reason: z.string().nullable(),
  version: z.string().nullable(),
  sandbox: z.string().nullable(),
  cwd: z.string().nullable(),
});
export const ChatMessageSchema = z.object({ id: z.string(), role: z.enum(['user', 'assistant']), text: z.string() });
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
  cleanupPending: z.boolean(),
  error: z.string().nullable(),
  eduCandidateRunId: z.uuid().optional(),
  nativeSearches: ResearchNativeSearchRecordsSchema.optional(),
  nativeSearchesTruncated: z.boolean().optional(),
});
export const ChatSendSchema = z
  .object({
    conversationId: ChatSlotSchema,
    text: z.string().trim().min(1).max(32000),
    observationScope: ObservationTurnScopeSchema.optional(),
    references: CatalogReferenceSnapshotSchema,
    eduTask: EduTaskBindingSchema.optional(),
    motaTask: MotaTaskBindingSchema.optional(),
    researchGrant: ResearchGrantSchema.optional(),
  })
  .strict()
  .refine((request) => !(request.eduTask && request.motaTask), 'task profiles are exclusive')
  .refine((request) => !(request.researchGrant && (request.eduTask || request.motaTask)), '研究只允许标准 App 任务')
  .refine(
    (request) =>
      !request.researchGrant ||
      (request.conversationId !== 'conv-personal-default' &&
        request.researchGrant.accountId === request.references.accountId &&
        request.researchGrant.workspaceId === request.references.workspaceId &&
        request.researchGrant.sessionId === request.conversationId &&
        request.researchGrant.sessionId === request.references.sessionId &&
        request.researchGrant.runId === request.observationScope?.runId &&
        request.researchGrant.sessionId === request.observationScope.sessionId &&
        request.researchGrant.workspaceId === request.observationScope.workspaceId),
    '研究授权必须属于当前账户、空间、会话与运行',
  )
  .refine(
    (request) =>
      !request.motaTask ||
      (request.motaTask.sessionId === request.conversationId &&
        request.motaTask.workspaceId === request.references.workspaceId &&
        request.motaTask.sessionId === request.references.sessionId &&
        request.motaTask.runId === request.observationScope?.runId &&
        request.motaTask.sessionId === request.observationScope.sessionId &&
        request.motaTask.workspaceId === request.observationScope.workspaceId),
    'Mota task must belong to the exact observed run',
  );
export const MotaTaskDispatchRejectionSchema = z
  .object({
    kind: z.literal('mota-task-dispatch-rejected'),
    conversationId: ChatSlotSchema,
    binding: MotaTaskBindingSchema,
    executorStarted: z.literal(false),
    error: z.string().min(1).max(1000),
  })
  .strict();
export const ChatTargetSchema = z.object({ conversationId: ChatSlotSchema });
export const ChatServiceRequestSchema = z.discriminatedUnion('method', [
  z.object({ id: z.string(), method: z.literal('research.reply'), payload: ResearchReplySchema }).strict(),
  z.object({ id: z.string(), method: z.literal('app.motaControl'), payload: MotaControlRequestSchema }).strict(),
  z.object({ id: z.string(), method: z.literal('app.verification.begin'), payload: EduVerificationBeginSchema }).strict(),
  z.object({ id: z.string(), method: z.literal('app.verification.recoverAdmission'), payload: EduVerificationBeginSchema }).strict(),
  ...(['app.verification.end', 'app.verification.status', 'app.verification.reconcile'] as const).map((method) =>
    z.object({ id: z.string(), method: z.literal(method), payload: EduVerificationTargetSchema }).strict(),
  ),
  z
    .object({
      id: z.string(),
      method: z.enum(['app.prepareEduTask', 'app.applyEduTask', 'app.cancelEduTask']),
      payload: EduTaskBindingSchema,
    })
    .strict(),
  z.object({ id: z.string(), method: z.literal('app.importEdu'), payload: EduImportSchema }).strict(),
  z.object({ id: z.string(), method: z.literal('app.importSource'), payload: AppImportRequestSchema }).strict(),
  z.object({ id: z.string(), method: z.literal('app.cancelImport'), payload: AppImportTargetSchema }).strict(),
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
  ...(['app.get', 'app.start', 'app.stop', 'app.export', 'app.taskSource'] as const).map((method) =>
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
  z.discriminatedUnion('tool', [
    ResearchCallSchema.options[0].extend({ type: z.literal('research-call') }),
    ResearchCallSchema.options[1].extend({ type: z.literal('research-call') }),
  ]),
  z.object({ type: z.literal('research-abort'), callId: z.uuid() }).strict(),
  z.object({ type: z.literal('edu-verification-event'), status: EduVerificationStatusSchema }).strict(),
  z.object({ type: z.literal('edu-admission-recovery-event'), status: EduAdmissionRecoveryStatusSchema }).strict(),
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
      MotaControlResponseSchema,
      MotaTaskDispatchRejectionSchema,
      EduTaskDispatchRejectionSchema,
      EduTaskOperationResultSchema,
      AppSourceSnapshotResultSchema,
      EduVerificationStatusSchema,
      EduAdmissionRecoveryStatusSchema,
      AppAgentResultSchema,
      AppLogsSchema,
      ManagedAppSchema,
      AppImportOutcomeSchema,
      AppSourceSchema,
      ChatStatusSchema,
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
export type ChatConversation = z.infer<typeof ChatConversationSchema>;
export type ChatServiceRequest = z.infer<typeof ChatServiceRequestSchema>;
export type ChatServiceMessage = z.infer<typeof ChatServiceMessageSchema>;
