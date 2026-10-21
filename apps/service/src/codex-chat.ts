import { randomUUID, createHash } from 'node:crypto';
import { isDeepStrictEqual } from 'node:util';
import { z } from 'zod';
import {
  ObservationTurnScopeSchema,
  ObservationSchema,
  ObservationSourcesSchema,
  ObservationErrorSchema,
  WorkspaceObservationResultSchema,
  AppControlResultSchema,
  AppToolNameSchema,
  MotaStateSchema,
  MotaMapReadSchema,
  MotaMapSetReceiptSchema,
  type AppControlResult,
  ResourceBundleSchema,
  type ObservationTurnScope,
  type EduTaskBinding,
  MotaTaskBindingSchema,
  type MotaTaskBinding,
  type WorkspaceObservationResult,
  type ChatConversation,
  type ChatSlot,
  type ChatStatus,
  type CatalogReferenceSnapshot,
  ResearchGrantSchema,
  ResearchCallSchema,
  ResearchToolNameSchema,
  ResearchToolResultSchema,
  type ResearchGrant,
  type ResearchCall,
  type ResearchReply,
  type ResearchToolResult,
  type ResearchTurnContext,
} from '@wsl/protocol';
import { SbxConnection, type GuestOutcome, type GuestProcess, type GuestWorkspace } from './sbx';
import { recordNativeSearch, validateResearchReply } from './research-runtime';

const EventSchema = z.discriminatedUnion('type', [
  z.object({ type: z.literal('thread.started'), thread_id: z.string().min(1) }),
  z.object({ type: z.literal('turn.started') }),
  z.object({ type: z.literal('turn.completed') }),
  z.object({ type: z.literal('turn.failed'), error: z.object({ message: z.string() }) }),
  z.object({ type: z.literal('error'), message: z.string() }),
  z.object({
    type: z.enum(['item.started', 'item.updated', 'item.completed']),
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
      query: z.unknown().optional(),
    }),
  }),
]);
export function parseCodexLine(line: string) {
  const raw: unknown = JSON.parse(line);
  const envelope = z.object({ type: z.string() }).parse(raw);
  if (!EventSchema.options.some((schema) => schema.shape.type.safeParse(envelope.type).success)) return null;
  return EventSchema.parse(raw);
}
function boundedMcpOutput(item: { server?: string; tool?: string; status?: string; result?: unknown; error?: unknown }): {
  output: string;
  truncated: boolean;
} {
  const raw = JSON.stringify({ status: item.status, result: item.result ?? null, error: item.error ?? null });
  const boundedSummary = (output: string) =>
    output.length <= 16000 ? output : JSON.stringify({ truncated: true, receiptUnavailable: 'MCP metadata exceeded the record limit' });
  const object = (value: unknown): Record<string, unknown> | null =>
    value !== null && typeof value === 'object' && !Array.isArray(value) ? (value as Record<string, unknown>) : null;
  const result = object(item.result);
  if (item.server === 'wsl_space' && ['research_open', 'research_include'].includes(item.tool ?? '')) {
    const content = result && Array.isArray(result['content']) && result['content'].length === 1 ? object(result['content'][0]) : null;
    if (result && content?.['type'] === 'text' && typeof content['text'] === 'string') {
      try {
        const value: unknown = JSON.parse(content['text']);
        const parsed = z
          .object({ untrusted: z.literal(true), data: ResearchToolResultSchema })
          .strict()
          .safeParse(value);
        const duplicateKeys = ['structuredContent', 'structured_content'].filter((key) => Object.hasOwn(result, key));
        if (
          parsed.success &&
          parsed.data.data.tool.replace('.', '_') === item.tool &&
          duplicateKeys.every((key) => isDeepStrictEqual(value, result[key]))
        ) {
          const receipt = parsed.data.data;
          if (receipt.ok && receipt.tool === 'research.include') {
            const { text: _text, ...source } = receipt.source;
            return {
              output: boundedSummary(
                JSON.stringify({ status: item.status, untrusted: true, receipt: { ...receipt, source }, textOmitted: true }),
              ),
              truncated: true,
            };
          }
          const output = JSON.stringify({ status: item.status, untrusted: true, receipt });
          return { output: boundedSummary(output), truncated: output.length > 16000 };
        }
      } catch {
        /* Invalid copies retain the explicit bounded record path. */
      }
    }
    return {
      output: JSON.stringify({
        status: item.status,
        truncated: true,
        receiptUnavailable: 'Invalid or conflicting research receipt; source text omitted',
      }),
      truncated: true,
    };
  }
  if (raw.length <= 16000) return { output: raw, truncated: false };
  // Native MCP repeats the same JSON in text and structured content. Keep one
  // complete, typed Mota receipt before applying the unchanged evidence limit.
  // Conflicting copies, unrelated tools and oversized single copies keep the
  // existing explicit truncation path; never choose one side of a disagreement.
  const motaTools = {
    app_mota_state: { tool: 'app.mota.state', schema: MotaStateSchema },
    app_mota_act: { tool: 'app.mota.act', schema: MotaStateSchema },
    app_mota_map_read: { tool: 'app.mota.map.read', schema: MotaMapReadSchema },
    app_mota_map_set: { tool: 'app.mota.map.set', schema: MotaMapSetReceiptSchema },
  };
  const mota =
    item.server === 'wsl_space' && item.tool && Object.hasOwn(motaTools, item.tool) ? motaTools[item.tool as keyof typeof motaTools] : null;
  if (mota && result && Array.isArray(result['content']) && result['content'].length === 1) {
    const content = object(result['content'][0]);
    const duplicateKeys = ['structuredContent', 'structured_content'].filter((key) => Object.hasOwn(result, key));
    if (content?.['type'] === 'text' && typeof content['text'] === 'string' && duplicateKeys.length) {
      try {
        const value: unknown = JSON.parse(content['text']);
        const parsed = z
          .object({ untrusted: z.literal(true), data: AppControlResultSchema })
          .strict()
          .safeParse(value);
        if (
          parsed.success &&
          (parsed.data.data.ok
            ? parsed.data.data.tool === mota.tool && mota.schema.safeParse(parsed.data.data.data).success
            : parsed.data.data.tool === mota.tool || parsed.data.data.tool === null) &&
          duplicateKeys.every((key) => isDeepStrictEqual(value, result[key]))
        ) {
          const compactResult = { ...result };
          for (const key of duplicateKeys) delete compactResult[key];
          const compact = JSON.stringify({ status: item.status, result: compactResult, error: item.error ?? null });
          if (compact.length <= 16000) return { output: compact, truncated: false };
        }
      } catch {
        /* Invalid text retains the existing bounded summary behavior. */
      }
    }
  }
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
  cleanupConfirmed: boolean;
  finishing: boolean;
  closePromise: Promise<GuestOutcome | null> | null;
  completion: Promise<void> | null;
  observation: AbortController;
  calls: Map<string, AbortController>;
}
interface Slot {
  conversation: ChatConversation;
  active: Turn | null;
}
export class CodexChat {
  private researchReader: ((call: ResearchCall, signal: AbortSignal) => Promise<ResearchReply>) | null = null;
  setResearchReader(reader: NonNullable<CodexChat['researchReader']>) {
    this.researchReader = reader;
  }
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
  assertMotaCapability(): void {
    this.connection.assertMotaCapability();
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
      if (slot.active?.failure && slot.conversation.cleanupPending) throw new Error('失败轮次的 guest 清理尚未确认');
    }
  }
  private completionFailed(slot: Slot, turn: Turn, error: unknown): void {
    if (slot.active !== turn) return;
    const reason = error instanceof Error ? error.message : String(error);
    turn.failure ??= reason;
    turn.observation.abort();
    if (!turn.cleanupConfirmed) turn.cleanupError ??= reason;
    slot.conversation.state = 'failed';
    slot.conversation.cleanupPending = !turn.cleanupConfirmed;
    slot.conversation.error = [...new Set([turn.failure, slot.conversation.error, reason].filter(Boolean))].join('; ');
    try {
      this.publish(slot);
    } catch (publishError) {
      slot.conversation.error += `; ${publishError instanceof Error ? publishError.message : String(publishError)}`;
    }
    if (turn.cleanupConfirmed && slot.active === turn) slot.active = null;
  }
  private closeTurn(slot: Slot, turn: Turn): Promise<GuestOutcome | null> {
    turn.closePromise ??= Promise.resolve()
      .then(() => turn.process.close())
      .catch((error: unknown) => {
        this.completionFailed(slot, turn, error);
        return null;
      });
    return turn.closePromise;
  }
  async send(
    id: ChatSlot,
    text: string,
    observationScope: ObservationTurnScope | undefined,
    references: CatalogReferenceSnapshot,
    eduTask?: { binding: EduTaskBinding; workspace: GuestWorkspace; retain: (candidate: GuestWorkspace) => Promise<void> },
    motaInput?: MotaTaskBinding,
    researchInput?: ResearchGrant,
  ): Promise<ChatConversation> {
    const motaTask = motaInput && MotaTaskBindingSchema.parse(motaInput);
    const researchGrant = researchInput && ResearchGrantSchema.parse(researchInput);
    if (
      researchGrant &&
      (eduTask ||
        motaTask ||
        !this.researchReader ||
        !observationScope ||
        researchGrant.sessionId !== id ||
        researchGrant.accountId !== references.accountId ||
        researchGrant.workspaceId !== references.workspaceId ||
        researchGrant.workspaceId !== observationScope.workspaceId ||
        researchGrant.runId !== observationScope.runId)
    )
      throw new Error('Research grant does not belong to this standard App run');
    if (
      motaTask &&
      (eduTask ||
        motaTask.sessionId !== id ||
        !observationScope ||
        observationScope.runId !== motaTask.runId ||
        observationScope.workspaceId !== motaTask.workspaceId)
    )
      throw new Error('Mota task does not belong to this read-only run');
    if (motaTask) this.assertMotaCapability();
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
    this.assertCleanupKnown();
    // A Mota turn must never resume a thread previously granted workspace writes.
    if (motaTask) slot.conversation.threadId = null;
    const spaceId = this.workspaceBySession.get(id) ?? null;
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
    const researchContext: ResearchTurnContext | undefined = researchGrant
      ? { grant: structuredClone(researchGrant), generation: slot.conversation.generation, turnId }
      : undefined;
    delete slot.conversation.nativeSearches;
    delete slot.conversation.nativeSearchesTruncated;
    Object.assign(slot.conversation, { turnId, state: 'running', error: null, cleanupPending: true });
    slot.conversation.messages.push({ id: turnId, role: 'user', text });
    this.publish(slot);
    const common = [
      'codex',
      'exec',
      '--sandbox',
      motaTask ? 'read-only' : 'workspace-write',
      '-c',
      researchGrant ? 'web_search="live"' : 'web_search="disabled"',
      ...(eduTask ? ['-c', 'sandbox_workspace_write.writable_roots=[]'] : []),
    ];
    const argv = slot.conversation.threadId
      ? [...common, 'resume', '--json', '--skip-git-repo-check', slot.conversation.threadId, '-']
      : [...common, '--json', '--skip-git-repo-check', '-'];
    let buffer = '';
    let stderr = '';
    const fail = (reason: string) => {
      if (slot.active !== turn || turn.failure) return;
      turn.failure = reason;
      turn.observation.abort();
      slot.conversation.state = 'failed';
      slot.conversation.error = reason;
      slot.conversation.cleanupPending = !turn.cleanupConfirmed;
      void this.closeTurn(slot, turn);
      try {
        this.publish(slot);
      } catch (error) {
        this.completionFailed(slot, turn, error);
      }
    };
    const consume = (line: string) => {
      if (turn.failure || slot.active !== turn || (turn.cancel && !motaTask) || !line.trim()) return;
      try {
        const event = parseCodexLine(line);
        if (!event) return;
        if (
          motaTask &&
          'item' in event &&
          (event.item.type === 'command_execution' ||
            ['web_search', 'web_search_call'].includes(event.item.type) ||
            (event.item.type === 'mcp_tool_call' &&
              (event.item.server !== 'wsl_space' ||
                !['app_mota_state', 'app_mota_act', 'app_mota_map_read', 'app_mota_map_set'].includes(event.item.tool ?? ''))))
        ) {
          fail(`policy_violation: Mota run emitted forbidden native tool ${event.item.type}`);
          return;
        }
        if (turn.cancel) return;
        if (event.type === 'thread.started') {
          if (slot.conversation.threadId && slot.conversation.threadId !== event.thread_id) throw new Error('Codex 返回了不同的会话身份');
          slot.conversation.threadId = event.thread_id;
        }
        if ('item' in event && ['web_search', 'web_search_call'].includes(event.item.type)) {
          recordNativeSearch(slot.conversation, event.type, event.item, turnId);
          if (!researchGrant) {
            fail('Native search was emitted without this run’s research grant');
            return;
          }
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
        if (!turn.cancel) fail(`Codex 协议错误：${(error as Error).message}`);
      }
    };
    let candidate: GuestWorkspace | undefined;
    const motaWorkspace: GuestWorkspace | undefined = motaTask
      ? {
          runId: motaTask.runId,
          files: [
            {
              path: 'README.md',
              base64: Buffer.from(
                'Mota task: read-only scratch. Use only the bound app_mota_* MCP tools. No project source is mounted here.\n',
              ).toString('base64'),
            },
          ],
        }
      : undefined;
    const candidateDiagnostics: string[] = [];
    let callCount = 0;
    const process = this.connection.start(
      {
        type: 'start',
        mode: 'codex',
        argv,
        prompt: text,
        resourceBundle,
        observation: Boolean(observationScope && (motaTask ? this.appControlReader : this.observationReader || this.researchReader)),
        observationImages: false,
        ...(researchGrant ? { webResearch: true } : {}),
        ...(eduTask ? { workspace: eduTask.workspace, strictWorkspace: true } : {}),
        ...(motaWorkspace ? { workspace: motaWorkspace, strictWorkspace: true, motaControl: true } : {}),
      },
      (frame) => {
        if (slot.active !== turn || turn.finishing) return;
        if (eduTask && frame.type === 'error') candidateDiagnostics.push(frame.error.slice(0, 4000));
        if (frame.type === 'workspace') {
          if ((!eduTask && !motaTask) || candidate) {
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
          if (turn.failure || turn.cancel || turn.observation.signal.aborted) return;
          const appTool = frame.tool.startsWith('app.');
          const researchTool = ResearchToolNameSchema.safeParse(frame.tool);
          const reply = (result: WorkspaceObservationResult | AppControlResult | ResearchToolResult) => {
            if (slot.active !== turn || turn.failure || turn.cancel || turn.observation.signal.aborted) return;
            const bounded = boundedObservationReply(frame.id, result);
            process.write(bounded);
          };
          if (motaTask && !['app.mota.state', 'app.mota.act', 'app.mota.map.read', 'app.mota.map.set'].includes(frame.tool)) {
            fail(`policy_violation: Mota run requested forbidden tool ${frame.tool}`);
            return;
          }
          if (researchTool.success && (!researchContext || !this.researchReader)) {
            reply({
              ok: false,
              tool: researchTool.data,
              error: { code: 'unauthorized', message: 'This turn has no public research grant' },
            });
            return;
          }
          if (
            !observationScope ||
            !(researchTool.success ? this.researchReader : appTool ? this.appControlReader : this.observationReader) ||
            turn.cancel
          ) {
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
              researchTool.success
                ? {
                    ok: false,
                    tool: researchTool.data,
                    error: { code: 'budget_exceeded', message: 'Shared observation/control/research budget exhausted' },
                  }
                : appTool
                  ? { ok: false, tool: null, error: { code: 'budget_exceeded', message: '观察与控制面并发或单轮预算已用完' } }
                  : { error: 'budget_exceeded', message: '观察并发或单轮预算已用完' },
            );
            return;
          }
          const controller = new AbortController();
          turn.calls.set(frame.id, controller);
          const abort = () => controller.abort();
          turn.observation.signal.addEventListener('abort', abort, { once: true });
          const call = researchTool.success
            ? Promise.resolve().then(async () => {
                if (controller.signal.aborted || turn.observation.signal.aborted || turn.failure || turn.cancel || slot.active !== turn)
                  return;
                const parsed = ResearchCallSchema.safeParse({
                  callId: frame.id,
                  context: researchContext,
                  tool: frame.tool,
                  args: frame.args,
                });
                if (!parsed.success) {
                  reply({ ok: false, tool: researchTool.data, error: { code: 'invalid_request', message: 'Invalid research arguments' } });
                  return;
                }
                try {
                  const result = validateResearchReply(parsed.data, await this.researchReader!(parsed.data, controller.signal));
                  reply(result.result);
                } catch (error) {
                  reply({
                    ok: false,
                    tool: researchTool.data,
                    error: { code: 'unavailable', message: ((error as Error).message || 'Research failed').slice(0, 1000) },
                  });
                }
              })
            : appTool
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
          if (!frame.ok) turn.cleanupError ??= frame.error ?? 'guest 清理未确认';
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
      cleanupConfirmed: false,
      finishing: false,
      closePromise: null,
      completion: null,
      observation: new AbortController(),
      calls: new Map(),
    };
    slot.active = turn;
    turn.completion = process.done
      .then(async (outcome) => {
        if (slot.active !== turn) return;
        turn.finishing = true;
        turn.observation.abort();
        if (buffer.trim()) consume(buffer);
        turn.cleanupConfirmed = outcome.confirmed;
        turn.cleanupError = !outcome.confirmed ? (outcome.error ?? 'guest 清理未确认') : null;
        slot.conversation.cleanupPending = !outcome.confirmed;

        const failure =
          [...new Set([turn.failure, turn.cleanupError, outcome.error].filter(Boolean))].join('; ') ||
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
        if (motaWorkspace && JSON.stringify(candidate) !== JSON.stringify(motaWorkspace))
          candidateFailure = 'Mota read-only scratch changed or its cleanup snapshot was not confirmed';
        if (eduTask) {
          try {
            if (!candidate) throw new Error(['edu task returned no candidate', ...candidateDiagnostics].join('; '));
            await eduTask.retain(candidate);
            if (slot.active !== turn) return;
            slot.conversation.eduCandidateRunId = eduTask.binding.runId;
          } catch (error) {
            candidateFailure = (error as Error).message;
          }
        }
        if (slot.active !== turn) return;
        slot.conversation.state = candidateFailure || failure ? 'failed' : turn.cancel ? 'cancelled' : 'idle';
        slot.conversation.error = candidateFailure ? [failure, candidateFailure].filter(Boolean).join('; ') : failure;
        this.publish(slot);
        if (turn.cleanupConfirmed) slot.active = null;
      })
      .catch((error: unknown) => this.completionFailed(slot, turn, error));
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
    if (!turn.failure) {
      turn.cancel = true;
      turn.observation.abort();
      slot.conversation.state = 'cancelling';
      this.publish(slot);
    }
    const outcome = await this.closeTurn(slot, turn);
    if (!outcome || !outcome.confirmed || outcome.error) throw new Error(turn.cleanupError ?? outcome?.error ?? 'guest 清理未确认');
    await turn.completion;
    if (!turn.cleanupConfirmed) throw new Error(turn.cleanupError ?? 'guest 清理未确认');
    return this.get(id);
  }
  async reset(id: ChatSlot): Promise<ChatConversation> {
    if (this.closing) throw new Error('对话服务正在关闭');
    await this.cancel(id);
    this.assertCleanupKnown();
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

export function boundedObservationReply(id: string, result: WorkspaceObservationResult | AppControlResult | ResearchToolResult) {
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
