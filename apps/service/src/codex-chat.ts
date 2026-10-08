import { randomUUID } from 'node:crypto';
import { z } from 'zod';
import { ResourceBundleSchema, type ChatConversation, type ChatSlot, type ChatStatus, type ResourceCollection } from '@wsl/protocol';
import { SbxConnection, type GuestProcess } from './sbx';

const EventSchema = z.discriminatedUnion('type', [
  z.object({ type: z.literal('thread.started'), thread_id: z.string().min(1) }),
  z.object({ type: z.literal('turn.started') }),
  z.object({ type: z.literal('turn.completed') }),
  z.object({ type: z.literal('turn.failed'), error: z.object({ message: z.string() }) }),
  z.object({ type: z.literal('error'), message: z.string() }),
  z.object({
    type: z.literal('item.completed'),
    item: z.object({
      id: z.string(),
      type: z.string(),
      text: z.string().optional(),
      message: z.string().optional(),
      command: z.string().optional(),
      aggregated_output: z.string().optional(),
      exit_code: z.number().int().nullable().optional(),
      server: z.string().optional(),
      tool: z.string().optional(),
      arguments: z.unknown().optional(),
      result: z.unknown().optional(),
      error: z.unknown().optional(),
      status: z.string().optional(),
    }),
  }),
]);
export function parseCodexLine(line: string) {
  const raw: unknown = JSON.parse(line);
  const envelope = z.object({ type: z.string() }).parse(raw);
  if (!EventSchema.options.some((schema) => schema.shape.type.value === envelope.type)) return null;
  return EventSchema.parse(raw);
}
function boundedMcpOutput(item: { status?: string; result?: unknown; error?: unknown }): { output: string; truncated: boolean } {
  const raw = JSON.stringify({ status: item.status, result: item.result ?? null, error: item.error ?? null });
  if (raw.length <= 16000) return { output: raw, truncated: false };
  const object = (value: unknown): Record<string, unknown> | null =>
    value !== null && typeof value === 'object' && !Array.isArray(value) ? (value as Record<string, unknown>) : null;
  const result = object(item.result);
  let structured = object(result?.['structuredContent'] ?? result?.['structured_content']);
  if (!structured && Array.isArray(result?.['content'])) {
    const text = result['content'].find((entry: unknown) => object(entry)?.['type'] === 'text');
    const content = object(text)?.['text'];
    if (typeof content === 'string') {
      try {
        structured = object(JSON.parse(content));
      } catch {
        structured = null;
      }
    }
  }
  const data = object(structured?.['data']);
  const receipt: Record<string, unknown> = {};
  for (const key of ['resourceId', 'version', 'spaceId', 'url', 'title', 'contentSha256', 'sourceSha256', 'truncated']) {
    if (data?.[key] !== undefined) receipt[key] = data[key];
  }
  if (typeof data?.['text'] === 'string') receipt['textExcerpt'] = data['text'].slice(0, 2000);
  if (Array.isArray(data?.['resources']))
    receipt['resourceIdentities'] = data['resources'].map((entry: unknown) => {
      const resource = object(entry);
      return { resourceId: resource?.['resourceId'], version: resource?.['version'], contentSha256: resource?.['contentSha256'] };
    });
  // Keep an explicit receipt when full MCP output cannot fit the UI record; never slice JSON into a misleading tail.
  const summary = JSON.stringify({ status: item.status, truncated: true, untrusted: structured?.['untrusted'] === true, receipt });
  return {
    output:
      summary.length <= 16000
        ? summary
        : JSON.stringify({ status: item.status, truncated: true, receiptUnavailable: 'MCP metadata exceeded the record limit' }),
    truncated: true,
  };
}
interface Turn {
  process: GuestProcess;
  cancel: boolean;
  failure: string | null;
  completed: boolean;
  replied: boolean;
  cleanupError: string | null;
}
interface Slot {
  conversation: ChatConversation;
  active: Turn | null;
  preparing: { done: Promise<void>; finish(): void; cancelled: boolean } | null;
}
export class CodexChat {
  private readonly slots = new Map<ChatSlot, Slot>();
  private readonly workspaceBySession = new Map<ChatSlot, string>();
  register(id: ChatSlot, workspaceId: string) {
    const previous = this.workspaceBySession.get(id);
    if (previous && previous !== workspaceId) throw new Error('会话归属已冻结');
    this.workspaceBySession.set(id, workspaceId);
  }
  private sequence = 0;
  private closing = false;
  readonly connection: SbxConnection;
  constructor(
    _root: string,
    private readonly emit: (conversation: ChatConversation) => void,
    connection = new SbxConnection(),
    private readonly resources?: { list(spaceId: string): Promise<ResourceCollection> },
  ) {
    this.connection = connection;
  }
  initialize(): Promise<ChatStatus> {
    return this.connection.initialize();
  }
  getStatus(): ChatStatus {
    return this.connection.getStatus();
  }
  private slot(id: ChatSlot): Slot {
    let slot = this.slots.get(id);
    if (!slot) {
      slot = {
        conversation: {
          conversationId: id,
          generation: randomUUID(),
          seq: ++this.sequence,
          threadId: null,
          turnId: null,
          state: 'idle',
          messages: [],
          toolExecutions: [],
          warnings: [],
          cleanupPending: false,
          error: null,
        },
        active: null,
        preparing: null,
      };
      this.slots.set(id, slot);
    }
    return slot;
  }
  get(id: ChatSlot): ChatConversation {
    return structuredClone(this.slot(id).conversation);
  }
  private publish(slot: Slot): ChatConversation {
    slot.conversation.seq = ++this.sequence;
    const snapshot = structuredClone(slot.conversation);
    this.emit(snapshot);
    return snapshot;
  }
  private assertCleanupKnown(): void {
    if (this.connection.getCleanupPending()) throw new Error('共享 sandbox 清理状态未知');
    for (const slot of this.slots.values()) {
      if (slot.active?.cleanupError) throw new Error(slot.active.cleanupError);
    }
  }
  assertResourceMutationAllowed(spaceId: string): void {
    this.assertCleanupKnown();
    if (spaceId !== 'taskflow-demo') throw new Error('未知资源空间');
    for (const [id, slot] of this.slots)
      if ((id === 'conv-space-taskflow-demo-impl' || this.workspaceBySession.get(id) === spaceId) && (slot.active || slot.preparing))
        throw new Error('空间对话正在运行，请先停止回复再修改资源');
  }
  invalidateResources(spaceId: string): void {
    this.assertResourceMutationAllowed(spaceId);
    for (const [id, slot] of this.slots) {
      if (id !== 'conv-space-taskflow-demo-impl' && this.workspaceBySession.get(id) !== spaceId) continue;
      slot.conversation.threadId = null;
      const warning = '空间资源已变更；下一轮使用新资源快照，历史消息保留为旧记录。';
      if (!slot.conversation.warnings.includes(warning)) slot.conversation.warnings.push(warning);
      slot.conversation.warnings = slot.conversation.warnings.slice(-20);
      this.publish(slot);
    }
  }
  async send(id: ChatSlot, text: string): Promise<ChatConversation> {
    if (this.closing) throw new Error('对话服务正在关闭');
    if (id !== 'conv-personal-default' && id !== 'conv-space-taskflow-demo-impl' && !this.workspaceBySession.has(id))
      throw new Error('会话尚未由宿主注册');
    const status = this.getStatus();
    if (!status.available) throw new Error(status.reason ?? 'sbx 不可用');
    const slot = this.slot(id);
    if (slot.active || slot.preparing) throw new Error(slot.active?.cleanupError ?? '当前会话正在等待回复');
    const spaceId = id === 'conv-space-taskflow-demo-impl' || this.workspaceBySession.get(id) === 'taskflow-demo' ? 'taskflow-demo' : null;
    if (spaceId) this.assertCleanupKnown();
    let collection: ResourceCollection = { spaceId: 'taskflow-demo', revision: 0, resources: [] };
    if (spaceId && this.resources) {
      let finish!: () => void;
      const preparing = {
        done: new Promise<void>((resolve) => {
          finish = resolve;
        }),
        finish: () => finish(),
        cancelled: false,
      };
      slot.preparing = preparing;
      try {
        collection = await this.resources.list(spaceId);
        if (preparing.cancelled || this.closing) return this.get(id);
        this.assertCleanupKnown();
      } finally {
        slot.preparing = null;
        preparing.finish();
      }
    }
    const turnId = randomUUID();
    const resourceBundle = ResourceBundleSchema.parse({
      conversationId: id,
      generation: slot.conversation.generation,
      turnId,
      spaceId,
      collectionRevision: spaceId ? collection.revision : 0,
      resources: spaceId ? collection.resources : [],
    });
    Object.assign(slot.conversation, { turnId, state: 'running', error: null, cleanupPending: true });
    slot.conversation.messages.push({ id: turnId, role: 'user', text });
    this.publish(slot);
    const common = ['codex', 'exec', '--sandbox', 'workspace-write'];
    const argv = slot.conversation.threadId
      ? [...common, 'resume', '--json', '--skip-git-repo-check', slot.conversation.threadId, '-']
      : [...common, '--json', '--skip-git-repo-check', '-'];
    let buffer = '';
    let stderr = '';
    const fail = (reason: string) => {
      turn.failure ??= reason;
      void turn.process.close();
    };
    const consume = (line: string) => {
      if (turn.cancel || turn.failure || slot.active !== turn || !line.trim()) return;
      try {
        const event = parseCodexLine(line);
        if (!event) return;
        if (event.type === 'thread.started') {
          if (slot.conversation.threadId && slot.conversation.threadId !== event.thread_id) throw new Error('Codex 返回了不同的会话身份');
          slot.conversation.threadId = event.thread_id;
        }
        if (event.type === 'item.completed') {
          const item = event.item;
          if (item.type === 'agent_message') {
            if (!item.text?.trim()) throw new Error('Codex 回复缺少文本');
            turn.replied = true;
            const messageId = `${turnId}:${item.id}`;
            if (!slot.conversation.messages.some((message) => message.id === messageId))
              slot.conversation.messages.push({ id: messageId, role: 'assistant', text: item.text });
          }
          if (item.type === 'error') {
            if (!item.message) throw new Error('Codex 警告缺少文本');
            const warning = item.message.slice(0, 2000);
            if (!slot.conversation.warnings.includes(warning)) slot.conversation.warnings.push(warning);
            slot.conversation.warnings = slot.conversation.warnings.slice(-20);
          }
          if (item.type === 'command_execution' || item.type === 'mcp_tool_call') {
            if (
              item.type === 'command_execution' &&
              (!item.command || item.aggregated_output === undefined || item.exit_code === undefined)
            )
              throw new Error('Codex 工具执行记录缺少字段');
            if (
              item.type === 'mcp_tool_call' &&
              (!item.server || !item.tool || !item.status || (item.result === undefined && item.error === undefined))
            )
              throw new Error('Codex MCP 执行记录缺少字段');
            const command =
              item.type === 'mcp_tool_call' ? `mcp:${item.server}.${item.tool} ${JSON.stringify(item.arguments ?? {})}` : item.command!;
            const bounded =
              item.type === 'mcp_tool_call'
                ? boundedMcpOutput(item)
                : { output: item.aggregated_output!.slice(-16000), truncated: item.aggregated_output!.length > 16000 };
            const output = bounded.output;
            const tools = slot.conversation.toolExecutions;
            const record = {
              id: item.id,
              turnId,
              command: command.slice(-4000),
              output,
              exitCode: item.type === 'mcp_tool_call' ? (item.status === 'completed' && !item.error ? 0 : 1) : item.exit_code!,
              truncated: bounded.truncated || command.length > 4000,
            };
            const index = tools.findIndex((tool) => tool.id === item.id && tool.turnId === turnId);
            if (index < 0) tools.push(record);
            else tools[index] = record;
            while (tools.length > 100) tools.shift();
            let excess = tools.reduce((sum, tool) => sum + tool.output.length, 0) - 131072;
            for (const tool of tools) {
              if (excess <= 0) break;
              if (tool.command.startsWith('mcp:')) {
                const priorLength = tool.output.length;
                tool.output = JSON.stringify({
                  truncated: true,
                  receiptOmitted: 'Conversation output limit reached; tool arguments remain in command',
                });
                tool.truncated = true;
                excess -= priorLength - tool.output.length;
              } else {
                const removed = Math.min(tool.output.length, excess);
                tool.output = tool.output.slice(removed);
                tool.truncated = true;
                excess -= removed;
              }
            }
          }
        }
        if (event.type === 'turn.completed') turn.completed = true;
        if (event.type === 'turn.failed') fail(event.error.message);
        if (event.type === 'error') fail(event.message);
        this.publish(slot);
      } catch (error) {
        fail(`Codex 协议错误：${(error as Error).message}`);
      }
    };
    const process = this.connection.start({ type: 'start', mode: 'codex', argv, prompt: text, resourceBundle }, (frame) => {
      if (frame.type === 'cleanup') {
        slot.conversation.cleanupPending = !frame.ok;
        this.publish(slot);
      }
      if (frame.type !== 'output') return;
      if (frame.stream === 'stderr') {
        stderr = (stderr + frame.data).slice(-4000);
        return;
      }
      buffer += frame.data;
      if (buffer.length > 1048576) {
        fail('Codex 协议行超过限制');
        return;
      }
      while (buffer.includes('\n')) {
        const index = buffer.indexOf('\n');
        const line = buffer.slice(0, index);
        buffer = buffer.slice(index + 1);
        consume(line);
      }
    });
    const turn: Turn = { process, cancel: false, failure: null, completed: false, replied: false, cleanupError: null };
    slot.active = turn;
    void process.done.then((outcome) => {
      if (buffer.trim()) consume(buffer);
      if (slot.active !== turn) return;
      turn.cleanupError = !outcome.confirmed ? (outcome.error ?? 'guest 清理未确认') : null;
      slot.conversation.cleanupPending = !outcome.confirmed;
      if (!turn.cleanupError) slot.active = null;
      const failure =
        turn.cleanupError ??
        outcome.error ??
        turn.failure ??
        (!turn.cancel
          ? outcome.exitCode !== 0
            ? `Codex 退出失败（${outcome.exitCode}）${stderr ? `：${stderr}` : ''}`
            : !turn.completed
              ? 'Codex 未返回对话完成事件'
              : !slot.conversation.threadId
                ? 'Codex 未返回会话身份'
                : !turn.replied
                  ? 'Codex 未返回助手回复'
                  : null
          : null);
      slot.conversation.state = failure ? 'failed' : turn.cancel ? 'cancelled' : 'idle';
      slot.conversation.error = failure;
      this.publish(slot);
    });
    return this.get(id);
  }
  async cancel(id: ChatSlot): Promise<ChatConversation> {
    const slot = this.slot(id);
    if (slot.preparing) {
      slot.preparing.cancelled = true;
      await slot.preparing.done;
    }
    const turn = slot.active;
    if (!turn) return this.get(id);
    if (turn.cleanupError) throw new Error(turn.cleanupError);
    turn.cancel = true;
    slot.conversation.state = 'cancelling';
    this.publish(slot);
    const outcome = await turn.process.close();
    if (!outcome.confirmed || outcome.error) throw new Error(outcome.error ?? 'guest 清理未确认');
    return this.get(id);
  }
  async reset(id: ChatSlot): Promise<ChatConversation> {
    if (this.closing) throw new Error('对话服务正在关闭');
    await this.cancel(id);
    this.slots.delete(id);
    return this.publish(this.slot(id));
  }
  async shutdown(): Promise<void> {
    this.closing = true;
    const outcomes = await Promise.allSettled([this.connection.shutdown(), ...[...this.slots.keys()].map((id) => this.cancel(id))]);
    const failure = outcomes.find((outcome) => outcome.status === 'rejected');
    if (failure?.status === 'rejected') throw failure.reason;
  }
}
