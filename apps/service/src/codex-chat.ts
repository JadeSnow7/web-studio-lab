import { randomUUID, createHash } from 'node:crypto';
import { z } from 'zod';
import {
  ObservationTurnScopeSchema,
  ObservationSchema,
  ObservationSourcesSchema,
  ObservationErrorSchema,
  WorkspaceObservationResultSchema,
  AppControlResultSchema,
  AppToolNameSchema,
  type AppControlResult,
  ResourceBundleSchema,
  type ObservationTurnScope,
  type EduTaskBinding,
  type WorkspaceObservationResult,
  type ChatConversation,
  type ChatSlot,
  type ChatStatus,
  type CatalogReferenceSnapshot,
} from '@wsl/protocol';
import { SbxConnection, type GuestProcess, type GuestWorkspace } from './sbx';

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
  const boundedSummary = (output: string) =>
    output.length <= 16000 ? output : JSON.stringify({ truncated: true, receiptUnavailable: 'MCP metadata exceeded the record limit' });
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
  const sources = ObservationSourcesSchema.safeParse(data);
  if (sources.success) {
    const receipt = {
      kind: sources.data.kind,
      workspaceId: sources.data.workspaceId,
      sourceCount: sources.data.sources.length,
      sources: [] as { resource: unknown; instance: unknown }[],
      sourcesOmitted: sources.data.sources.length,
    };
    const summary = () => JSON.stringify({ status: item.status, truncated: true, untrusted: structured?.['untrusted'] === true, receipt });
    for (const source of sources.data.sources) {
      receipt.sources.push({ resource: source.resource, instance: source.instance });
      receipt.sourcesOmitted--;
      if (summary().length > 16000) {
        receipt.sources.pop();
        receipt.sourcesOmitted++;
        break;
      }
    }
    return { output: boundedSummary(summary()), truncated: true };
  }
  const error = ObservationErrorSchema.safeParse(data);
  if (error.success) {
    return {
      output: boundedSummary(
        JSON.stringify({
          status: item.status,
          truncated: true,
          untrusted: structured?.['untrusted'] === true,
          receipt: {
            error: error.data.error,
            message: error.data.message.slice(0, 2000),
            messageOmitted: error.data.message.length > 2000,
            detailsOmitted: error.data.details !== undefined,
          },
        }),
      ),
      truncated: true,
    };
  }
  const observation = ObservationSchema.safeParse(data);
  if (observation.success) {
    const { data: _data, ...metadata } = observation.data;
    const summary = JSON.stringify({
      status: item.status,
      truncated: true,
      untrusted: structured?.['untrusted'] === true,
      receipt: metadata,
    });
    if (summary.length <= 16000) return { output: boundedSummary(summary), truncated: true };
    const {
      revision: _revision,
      coverage,
      nextCursor: _nextCursor,
      capturedAt: _capturedAt,
      startedAt: _startedAt,
      ...identity
    } = metadata;
    return {
      output: boundedSummary(
        JSON.stringify({
          status: item.status,
          truncated: true,
          untrusted: structured?.['untrusted'] === true,
          receipt: { ...identity, coverage: { status: coverage.status } },
          metadataOmitted: ['revision', 'coverage.range', 'coverage.reasons', 'nextCursor', 'capturedAt', 'startedAt'],
        }),
      ),
      truncated: true,
    };
  }
  const receipt: Record<string, unknown> = {};
  for (const key of ['resourceId', 'version', 'url', 'title', 'contentSha256', 'sourceSha256', 'truncated']) {
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
    output: boundedSummary(summary),
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
  observation: AbortController;
  calls: Map<string, AbortController>;
}
interface Slot {
  conversation: ChatConversation;
  active: Turn | null;
}
export class CodexChat {
  private observationReader:
    | ((
        scope: ObservationTurnScope,
        tool: string,
        args: Record<string, unknown>,
        signal: AbortSignal,
      ) => Promise<WorkspaceObservationResult>)
    | null = null;
  setObservationReader(reader: NonNullable<CodexChat['observationReader']>) {
    this.observationReader = reader;
  }
  /** 控制面调用与观察共用同一 guest socket、轮次 scope 和调用预算，由 Main dispatcher 授权执行。 */
  private appControlReader:
    ((scope: ObservationTurnScope, tool: string, args: Record<string, unknown>, signal: AbortSignal) => Promise<AppControlResult>) | null =
    null;
  setAppControlReader(reader: NonNullable<CodexChat['appControlReader']>) {
    this.appControlReader = reader;
  }
  private readonly slots = new Map<ChatSlot, Slot>();
  private readonly workspaceBySession = new Map<ChatSlot, string>();
  register(id: ChatSlot, workspaceId: string) {
    if (id === 'conv-personal-default') throw new Error('个人会话不能注册为空间会话');
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
  async send(
    id: ChatSlot,
    text: string,
    observationScope: ObservationTurnScope | undefined,
    references: CatalogReferenceSnapshot,
    eduTask?: { binding: EduTaskBinding; workspace: GuestWorkspace; retain: (candidate: GuestWorkspace) => Promise<void> },
  ): Promise<ChatConversation> {
    if (this.closing) throw new Error('对话服务正在关闭');
    if (id !== 'conv-personal-default' && !this.workspaceBySession.has(id)) throw new Error('会话尚未由宿主注册');
    if (observationScope) {
      observationScope = ObservationTurnScopeSchema.parse(observationScope);
      if (observationScope.sessionId !== id || this.workspaceBySession.get(id) !== observationScope.workspaceId)
        throw new Error('观察会话不属于已注册空间');
    }
    if (
      eduTask &&
      (!observationScope ||
        observationScope.runId !== eduTask.binding.runId ||
        observationScope.workspaceId !== eduTask.binding.workspaceId ||
        eduTask.workspace.runId !== eduTask.binding.runId)
    )
      throw new Error('edu task does not belong to this run');
    const status = this.getStatus();
    if (!status.available) throw new Error(status.reason ?? 'sbx 不可用');
    const slot = this.slot(id);
    if (slot.active) throw new Error(slot.active?.cleanupError ?? '当前会话正在等待回复');
    const spaceId = this.workspaceBySession.get(id) ?? null;
    if (spaceId) this.assertCleanupKnown();
    const turnId = randomUUID();
    if (references.sessionId !== id || references.workspaceId !== spaceId) throw new Error('参考资料不属于已注册会话');
    const resourceBundle = ResourceBundleSchema.parse({
      ...references,
      conversationId: id,
      generation: slot.conversation.generation,
      turnId,
    });
    for (const resource of resourceBundle.resources)
      if (createHash('sha256').update(resource.text, 'utf8').digest('hex') !== resource.contentSha256)
        throw new Error('参考资料正文摘要不匹配');
    Object.assign(slot.conversation, { turnId, state: 'running', error: null, cleanupPending: true });
    slot.conversation.messages.push({ id: turnId, role: 'user', text });
    this.publish(slot);
    const common = [
      'codex',
      'exec',
      '--sandbox',
      'workspace-write',
      ...(eduTask ? ['-c', 'sandbox_workspace_write.writable_roots=[]'] : []),
    ];
    const argv = slot.conversation.threadId
      ? [...common, 'resume', '--json', '--skip-git-repo-check', slot.conversation.threadId, '-']
      : [...common, '--json', '--skip-git-repo-check', '-'];
    let buffer = '';
    let stderr = '';
    const fail = (reason: string) => {
      turn.failure ??= reason;
      turn.observation.abort();
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
    let candidate: GuestWorkspace | undefined;
    const candidateDiagnostics: string[] = [];
    let callCount = 0;
    const process = this.connection.start(
      {
        type: 'start',
        mode: 'codex',
        argv,
        prompt: text,
        resourceBundle,
        observation: Boolean(observationScope && this.observationReader),
        observationImages: false,
        ...(eduTask ? { workspace: eduTask.workspace, strictWorkspace: true } : {}),
      },
      (frame) => {
        if (eduTask && frame.type === 'error') candidateDiagnostics.push(frame.error.slice(0, 4000));
        if (frame.type === 'workspace') {
          if (!eduTask || candidate) {
            fail('Unexpected or duplicate task candidate');
            return;
          }
          candidate = { runId: frame.runId, files: frame.files };
          return;
        }
        if (frame.type === 'observation-cancel') {
          turn.calls.get(frame.id)?.abort();
          return;
        }
        if (frame.type === 'observation-call') {
          const appTool = frame.tool.startsWith('app.');
          const reply = (result: WorkspaceObservationResult | AppControlResult) => {
            if (slot.active !== turn || turn.cancel || turn.observation.signal.aborted) return;
            const bounded = boundedObservationReply(frame.id, result);
            process.write(bounded);
          };
          if (!observationScope || !(appTool ? this.appControlReader : this.observationReader) || turn.cancel) {
            reply(
              appTool
                ? { ok: false, tool: null, error: { code: 'no_active_run', message: '无运行归属，控制面不可用' } }
                : { error: 'unauthorized', message: '无运行观察归属' },
            );
            return;
          }
          if (turn.calls.has(frame.id)) {
            fail('观察调用身份重复');
            return;
          }
          if (turn.calls.size >= 4 || ++callCount > 64) {
            reply(
              appTool
                ? { ok: false, tool: null, error: { code: 'budget_exceeded', message: '观察与控制面并发或单轮预算已用完' } }
                : { error: 'budget_exceeded', message: '观察并发或单轮预算已用完' },
            );
            return;
          }
          const controller = new AbortController();
          turn.calls.set(frame.id, controller);
          const abort = () => controller.abort();
          turn.observation.signal.addEventListener('abort', abort, { once: true });
          const call = appTool
            ? AppToolNameSchema.safeParse(frame.tool).success
              ? this.appControlReader!(structuredClone(observationScope), frame.tool, frame.args, controller.signal).then(
                  (result) => reply(AppControlResultSchema.parse(result)),
                  (error) => reply({ ok: false, tool: null, error: { code: 'unavailable', message: (error as Error).message } }),
                )
              : Promise.resolve(reply({ ok: false, tool: null, error: { code: 'unsupported', message: '未知控制面工具' } }))
            : this.observationReader!(structuredClone(observationScope), frame.tool, frame.args, controller.signal).then(
                (result) => reply(WorkspaceObservationResultSchema.parse(result)),
                (error) => reply({ error: 'unavailable', message: (error as Error).message }),
              );
          void call.then(
            () => {
              turn.calls.delete(frame.id);
              turn.observation.signal.removeEventListener('abort', abort);
            },
            (error) => {
              turn.calls.delete(frame.id);
              turn.observation.signal.removeEventListener('abort', abort);
              if (slot.active === turn) fail('观察返回失败：' + (error as Error).message);
            },
          );
          return;
        }
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
      },
    );
    const turn: Turn = {
      process,
      cancel: false,
      failure: null,
      completed: false,
      replied: false,
      cleanupError: null,
      observation: new AbortController(),
      calls: new Map(),
    };
    slot.active = turn;
    void process.done.then(async (outcome) => {
      turn.observation.abort();
      if (buffer.trim()) consume(buffer);
      if (slot.active !== turn) return;
      turn.cleanupError = !outcome.confirmed ? (outcome.error ?? 'guest 清理未确认') : null;
      slot.conversation.cleanupPending = !outcome.confirmed;

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
      let candidateFailure: string | null = null;
      if (eduTask) {
        try {
          if (!candidate) throw new Error(['edu task returned no candidate', ...candidateDiagnostics].join('; '));
          await eduTask.retain(candidate);
          slot.conversation.eduCandidateRunId = eduTask.binding.runId;
        } catch (error) {
          candidateFailure = (error as Error).message;
        }
      }
      if (!turn.cleanupError) slot.active = null;
      slot.conversation.state = candidateFailure || failure ? 'failed' : turn.cancel ? 'cancelled' : 'idle';
      slot.conversation.error = candidateFailure ? [failure, candidateFailure].filter(Boolean).join('; ') : failure;
      this.publish(slot);
    });
    return this.get(id);
  }
  private cancelUnstarted(slot: Slot, turnId: string): ChatConversation {
    if (slot.conversation.turnId === turnId && slot.conversation.state === 'cancelled') return structuredClone(slot.conversation);
    Object.assign(slot.conversation, { turnId, state: 'cancelled', error: null, cleanupPending: false });
    return this.publish(slot);
  }
  async cancel(id: ChatSlot, queuedSend = false): Promise<ChatConversation> {
    const slot = this.slot(id);
    const turn = slot.active;
    if (!turn) return queuedSend ? this.cancelUnstarted(slot, randomUUID()) : this.get(id);
    if (turn.cleanupError) throw new Error(turn.cleanupError);
    turn.cancel = true;
    turn.observation.abort();
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
  async drainForVerification(): Promise<void> {
    await Promise.all([...this.slots.keys()].map((id) => this.cancel(id)));
    if (this.connection.getCleanupPending()) throw new Error('verification_coding_cleanup_unconfirmed');
  }
  beginShutdown(): void {
    // Apps still need the shared connection while their mappings are removed.
    // Admission can close independently of that connection's cleanup.
    this.closing = true;
  }
  async shutdown(): Promise<void> {
    this.beginShutdown();
    const outcomes = await Promise.allSettled([this.connection.shutdown(), ...[...this.slots.keys()].map((id) => this.cancel(id))]);
    const failure = outcomes.find((outcome) => outcome.status === 'rejected');
    if (failure?.status === 'rejected') throw failure.reason;
  }
}

export function boundedObservationReply(id: string, result: WorkspaceObservationResult | AppControlResult) {
  const frame = { type: 'observation-result' as const, id, result };
  if (Buffer.byteLength(JSON.stringify(frame) + '\n', 'utf8') > 1048576)
    return {
      type: 'observation-result' as const,
      id,
      result:
        'ok' in result
          ? { ok: false as const, tool: null, error: { code: 'budget_exceeded' as const, message: '控制面结果超过控制帧UTF-8预算' } }
          : { error: 'budget_exceeded' as const, message: '观察结果超过控制帧UTF-8预算' },
    };
  return frame;
}
