import { z } from 'zod';

/**
 * ACP（Agent Client Protocol）v1 中本客户端实际使用的子集。
 * 依据 https://agentclientprotocol.com/protocol （initialization、session-setup、prompt-turn、tool-calls），
 * 传输为 stdio 上逐行的 JSON-RPC 2.0（与官方 SDK 的 ndJsonStream 一致）。
 * 未用到的字段一律放行（passthrough），避免 Agent 新增字段时误判为协议错误；用到的字段严格校验。
 */
export const ACP_PROTOCOL_VERSION = 1;

const JsonRpcId = z.union([z.string(), z.number().int()]);
export const JsonRpcMessageSchema = z.union([
  z.object({ jsonrpc: z.literal('2.0'), id: JsonRpcId, method: z.string(), params: z.unknown().optional() }),
  z.object({ jsonrpc: z.literal('2.0'), method: z.string(), params: z.unknown().optional() }),
  z.object({ jsonrpc: z.literal('2.0'), id: JsonRpcId, result: z.unknown() }),
  z.object({
    jsonrpc: z.literal('2.0'),
    id: JsonRpcId.nullable(),
    error: z.object({ code: z.number().int(), message: z.string(), data: z.unknown().optional() }),
  }),
]);
export type JsonRpcMessage = z.infer<typeof JsonRpcMessageSchema>;

export const InitializeResultSchema = z
  .object({
    protocolVersion: z.number().int(),
    agentCapabilities: z
      .object({
        loadSession: z.boolean().optional(),
        promptCapabilities: z
          .object({ image: z.boolean().optional(), audio: z.boolean().optional(), embeddedContext: z.boolean().optional() })
          .passthrough()
          .optional(),
        mcpCapabilities: z.object({ http: z.boolean().optional(), sse: z.boolean().optional() }).passthrough().optional(),
      })
      .passthrough()
      .optional(),
    authMethods: z.array(z.unknown()).optional(),
    agentInfo: z.object({ name: z.string(), title: z.string().optional(), version: z.string().optional() }).passthrough().optional(),
  })
  .passthrough();
export type InitializeResult = z.infer<typeof InitializeResultSchema>;

export const NewSessionResultSchema = z.object({ sessionId: z.string().min(1) }).passthrough();
export const StopReasonSchema = z.enum(['end_turn', 'max_tokens', 'max_turn_requests', 'refusal', 'cancelled']);
export const PromptResultSchema = z.object({ stopReason: StopReasonSchema }).passthrough();
export type StopReason = z.infer<typeof StopReasonSchema>;

const TextContent = z.object({ type: z.literal('text'), text: z.string() }).passthrough();
const ContentBlock = z.object({ type: z.string() }).passthrough();
export const ToolStatusSchema = z.enum(['pending', 'in_progress', 'completed', 'failed']);
const ToolCallContent = z.object({ type: z.string(), content: ContentBlock.optional() }).passthrough();

export const SessionUpdateSchema = z.discriminatedUnion('sessionUpdate', [
  z.object({ sessionUpdate: z.literal('agent_message_chunk'), messageId: z.string().optional(), content: ContentBlock }).passthrough(),
  z.object({ sessionUpdate: z.literal('user_message_chunk'), messageId: z.string().optional(), content: ContentBlock }).passthrough(),
  z.object({ sessionUpdate: z.literal('agent_thought_chunk'), content: ContentBlock.optional() }).passthrough(),
  z
    .object({
      sessionUpdate: z.literal('tool_call'),
      toolCallId: z.string().min(1),
      title: z.string().optional(),
      kind: z.string().optional(),
      status: ToolStatusSchema.optional(),
      content: z.array(ToolCallContent).optional(),
      rawInput: z.unknown().optional(),
      rawOutput: z.unknown().optional(),
    })
    .passthrough(),
  z
    .object({
      sessionUpdate: z.literal('tool_call_update'),
      toolCallId: z.string().min(1),
      title: z.string().nullable().optional(),
      kind: z.string().nullable().optional(),
      status: ToolStatusSchema.nullable().optional(),
      content: z.array(ToolCallContent).nullable().optional(),
      rawInput: z.unknown().optional(),
      rawOutput: z.unknown().optional(),
    })
    .passthrough(),
]);
export const SessionUpdateNotificationSchema = z
  .object({ sessionId: z.string(), update: z.object({ sessionUpdate: z.string() }).passthrough() })
  .passthrough();

export const PermissionOptionSchema = z
  .object({ optionId: z.string().min(1), name: z.string(), kind: z.enum(['allow_once', 'allow_always', 'reject_once', 'reject_always']) })
  .passthrough();
export const RequestPermissionParamsSchema = z
  .object({
    sessionId: z.string(),
    toolCall: z
      .object({ toolCallId: z.string(), title: z.string().nullable().optional(), kind: z.string().nullable().optional() })
      .passthrough(),
    options: z.array(PermissionOptionSchema),
  })
  .passthrough();
export type RequestPermissionParams = z.infer<typeof RequestPermissionParamsSchema>;
export type PermissionOption = z.infer<typeof PermissionOptionSchema>;
export type PermissionOutcome = { outcome: { outcome: 'selected'; optionId: string } | { outcome: 'cancelled' } };

export function textOf(block: unknown): string | null {
  const parsed = TextContent.safeParse(block);
  return parsed.success ? parsed.data.text : null;
}

/** stdio MCP 服务器描述（session/new 与 session/load 的 mcpServers 项）。 */
export interface AcpStdioMcpServer {
  name: string;
  command: string;
  args: string[];
  env: { name: string; value: string }[];
}
