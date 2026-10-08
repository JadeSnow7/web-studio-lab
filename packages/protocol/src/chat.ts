import { z } from 'zod';
import { TerminalOpenSchema, TerminalWriteSchema, TerminalResizeSchema, TerminalTargetSchema, TerminalSnapshotSchema } from './terminal';

import { ChatSlotSchema } from './chat-slot';
export { ChatSlotSchema } from './chat-slot';
import { ResourceCollectionSchema, ResourceListRequestSchema, ResourceRemoveRequestSchema, ResourceSaveRequestSchema } from './resources';
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
});
export const ChatSendSchema = z.object({ conversationId: ChatSlotSchema, text: z.string().trim().min(1).max(32000) });
export const ChatTargetSchema = z.object({ conversationId: ChatSlotSchema });
export const ChatServiceRequestSchema = z.discriminatedUnion('method', [
  z.object({ id: z.string(), method: z.literal('status') }),
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
  z.object({ id: z.string(), method: z.literal('resources.list'), payload: ResourceListRequestSchema }).strict(),
  z.object({ id: z.string(), method: z.literal('resources.save'), payload: ResourceSaveRequestSchema }).strict(),
  z.object({ id: z.string(), method: z.literal('resources.remove'), payload: ResourceRemoveRequestSchema }).strict(),
  z.object({ id: z.string(), method: z.literal('shutdown') }),
]);
export const ChatServiceMessageSchema = z.discriminatedUnion('type', [
  z.object({ type: z.literal('initialized'), status: ChatStatusSchema, cleanupPending: z.boolean() }),
  z.object({ type: z.literal('event'), conversation: ChatConversationSchema }),
  z.object({ type: z.literal('terminal-event'), terminal: TerminalSnapshotSchema, resourceId: z.string().min(1) }),
  z.object({
    type: z.literal('response'),
    id: z.string(),
    result: z.union([ChatStatusSchema, ChatConversationSchema, TerminalSnapshotSchema, ResourceCollectionSchema, z.null()]),
  }),
  z.object({ type: z.literal('error'), id: z.string(), error: z.string() }),
]);
export type ChatSlot = z.infer<typeof ChatSlotSchema>;
export type ChatStatus = z.infer<typeof ChatStatusSchema>;
export type ChatConversation = z.infer<typeof ChatConversationSchema>;
export type ChatServiceRequest = z.infer<typeof ChatServiceRequestSchema>;
export type ChatServiceMessage = z.infer<typeof ChatServiceMessageSchema>;
