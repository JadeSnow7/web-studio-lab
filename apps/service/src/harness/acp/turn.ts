import type { HarnessEvent } from '../types';
import { AcpClient, AcpMethodNotFound, AcpProtocolError } from './client';
import {
  ACP_PROTOCOL_VERSION,
  InitializeResultSchema,
  NewSessionResultSchema,
  PromptResultSchema,
  RequestPermissionParamsSchema,
  SessionUpdateNotificationSchema,
  SessionUpdateSchema,
  textOf,
  type AcpStdioMcpServer,
  type InitializeResult,
  type PermissionOutcome,
  type RequestPermissionParams,
  type StopReason,
} from './protocol';

/** 已知但本客户端不消费的更新类型（见 prompt-turn 文档）；未列出的类型记一次警告。 */
const IGNORED_UPDATES = new Set([
  'user_message_chunk',
  'plan',
  'available_commands_update',
  'current_mode_update',
  'config_option_update',
  'session_info_update',
  'usage_update',
  'compaction_update',
  'compaction_summary_chunk',
]);

export type PermissionDecider = (params: RequestPermissionParams) => PermissionOutcome | Promise<PermissionOutcome>;

/** 默认策略：一律拒绝（优先 reject_once）。审批接到 Main 之前，ACP Agent 不能自行获得额外权限。 */
export const denyAllPermissions: PermissionDecider = (params) => {
  const option = params.options.find((o) => o.kind === 'reject_once') ?? params.options.find((o) => o.kind === 'reject_always');
  return option ? { outcome: { outcome: 'selected', optionId: option.optionId } } : { outcome: { outcome: 'cancelled' } };
};

export interface AcpTurnInput {
  cwd: string;
  mcpServers: AcpStdioMcpServer[];
  /** 上一轮返回的 ACP sessionId；Agent 声明 loadSession 时用 session/load 恢复。 */
  sessionRef: string | null;
  prompt: string;
  signal: AbortSignal;
  decidePermission?: PermissionDecider;
  clientInfo?: { name: string; version: string };
}
export interface AcpTurnResult {
  stopReason: StopReason;
  sessionId: string | null;
  initialize: InitializeResult | null;
  cancelRequested: boolean;
}

interface ToolState {
  title: string | null;
  kind: string | null;
  status: string;
  texts: string[];
  rawOutput: unknown;
  emitted: string | null;
}

/**
 * 一个 ACP 轮次：initialize → session/new 或 session/load → session/prompt，期间把 session/update 归一化为 HarnessEvent。
 * 传输由调用方负责：write 写到 Agent 的 stdin，Agent 的每一行 stdout 交给 receive。轮次结束后调用方关闭 stdin 并确认进程退出。
 */
export class AcpTurn {
  readonly client: AcpClient;
  private sessionId: string | null = null;
  private phase: 'init' | 'loading' | 'prompting' | 'finishing' | 'done' = 'init';
  private cancelRequested = false;
  private readonly pendingPermissions = new Set<(outcome: PermissionOutcome) => void>();
  private readonly tools = new Map<string, ToolState>();
  private readonly toolOrder: string[] = [];
  private message: { id: string; text: string } | null = null;
  private messageSeq = 0;
  private readonly warned = new Set<string>();
  thoughtChunks = 0;

  constructor(
    write: (line: string) => void,
    private readonly emit: (event: HarnessEvent) => void,
    private readonly input: AcpTurnInput,
  ) {
    this.client = new AcpClient(write, {
      onNotification: (method, params) => this.notification(method, params),
      onRequest: (method, params) => this.request(method, params),
      // ACP 要求所有更新先于 prompt 响应发出：响应一到即同步关闭更新入口，同一批输入里随后的行不进入本轮。
      onResponse: (method) => {
        if (method === 'session/prompt' && this.phase === 'prompting') this.phase = 'finishing';
      },
    });
  }

  /** 交给调用方的输入入口；协议违约抛出 AcpProtocolError。 */
  receive(line: string) {
    this.client.receive(line);
  }

  close(reason: string) {
    this.phase = 'done';
    this.client.close(reason);
  }

  async run(): Promise<AcpTurnResult> {
    const { signal } = this.input;
    let init: InitializeResult | null = null;
    const onAbort = () => this.cancel();
    signal.addEventListener('abort', onAbort, { once: true });
    try {
      if (signal.aborted) return this.result('cancelled', init);
      init = InitializeResultSchema.parse(
        await this.client.request('initialize', {
          protocolVersion: ACP_PROTOCOL_VERSION,
          clientCapabilities: { fs: { readTextFile: false, writeTextFile: false }, terminal: false },
          clientInfo: this.input.clientInfo ?? { name: 'web-studio-lab', version: '0' },
        }),
      );
      if (init.protocolVersion !== ACP_PROTOCOL_VERSION) throw new AcpProtocolError(`ACP 协议版本不兼容：${init.protocolVersion}`);
      if (signal.aborted) return this.result('cancelled', init);
      const canLoad = init.agentCapabilities?.loadSession === true;
      if (this.input.sessionRef && canLoad) {
        this.phase = 'loading';
        this.sessionId = this.input.sessionRef;
        await this.client.request('session/load', {
          sessionId: this.input.sessionRef,
          cwd: this.input.cwd,
          mcpServers: this.input.mcpServers,
        });
      } else {
        if (this.input.sessionRef) this.warn('load', 'Agent 未声明 loadSession，已开始新会话；之前的上下文不会带入');
        this.sessionId = NewSessionResultSchema.parse(
          await this.client.request('session/new', { cwd: this.input.cwd, mcpServers: this.input.mcpServers }),
        ).sessionId;
      }
      this.emit({ type: 'session', ref: this.sessionId });
      if (signal.aborted) return this.result('cancelled', init);
      this.phase = 'prompting';
      const response = PromptResultSchema.parse(
        await this.client.request('session/prompt', { sessionId: this.sessionId, prompt: [{ type: 'text', text: this.input.prompt }] }),
      );
      this.flushMessage();
      this.flushTools(true);
      const stop = response.stopReason;
      if (stop === 'end_turn') this.emit({ type: 'turn_completed' });
      else if (stop === 'cancelled') {
        if (!this.cancelRequested) this.emit({ type: 'turn_failed', message: 'Agent 在未请求取消时返回 cancelled' });
      } else this.emit({ type: 'turn_failed', message: `Agent 停止：${stop}` });
      return this.result(stop, init);
    } finally {
      signal.removeEventListener('abort', onAbort);
      this.phase = 'done';
      for (const resolve of this.pendingPermissions) resolve({ outcome: { outcome: 'cancelled' } });
      this.pendingPermissions.clear();
      // 轮次结束后到达的任何消息（迟到的更新或响应）都被隔离：不进入本轮，也不判为协议错误。
      this.client.close('ACP 轮次已结束');
    }
  }

  private result(stopReason: StopReason, initialize: InitializeResult | null): AcpTurnResult {
    return { stopReason, sessionId: this.sessionId, initialize, cancelRequested: this.cancelRequested };
  }

  /** 按 ACP 取消规则：发 session/cancel，待决的权限请求一律回复 cancelled，然后等待 prompt 返回。 */
  private cancel() {
    if (this.cancelRequested || this.phase === 'done') return;
    this.cancelRequested = true;
    for (const resolve of this.pendingPermissions) resolve({ outcome: { outcome: 'cancelled' } });
    this.pendingPermissions.clear();
    if (this.phase === 'prompting' && this.sessionId) this.client.notify('session/cancel', { sessionId: this.sessionId });
  }

  private notification(method: string, params: unknown) {
    if (method !== 'session/update') {
      this.warn(`notification:${method}`, `ACP 未识别的通知：${method}`);
      return;
    }
    const envelope = SessionUpdateNotificationSchema.safeParse(params);
    if (!envelope.success) throw new AcpProtocolError('ACP session/update 缺少字段');
    if (this.sessionId && envelope.data.sessionId !== this.sessionId) throw new AcpProtocolError('ACP 返回了其他会话的更新');
    // session/load 期间 Agent 会回放历史；回放内容已在之前的轮次记录过，不重复进入本轮。
    if (this.phase !== 'prompting') return;
    const kind = envelope.data.update.sessionUpdate;
    if (IGNORED_UPDATES.has(kind)) return;
    if (kind === 'notice') {
      const text = textOf((envelope.data.update as Record<string, unknown>)['content']);
      if (text) this.emit({ type: 'warning', text: text.slice(0, 2000) });
      return;
    }
    const known = SessionUpdateSchema.safeParse(envelope.data.update);
    if (!known.success) {
      if (['agent_message_chunk', 'agent_thought_chunk', 'tool_call', 'tool_call_update'].includes(kind))
        throw new AcpProtocolError(`ACP ${kind} 缺少字段`);
      this.warn(`update:${kind}`, `ACP 未识别的更新类型：${kind}`);
      return;
    }
    const update = known.data;
    if (update.sessionUpdate === 'agent_thought_chunk') {
      this.thoughtChunks++;
      return;
    }
    if (update.sessionUpdate === 'agent_message_chunk') {
      const text = textOf(update.content);
      if (text === null) return;
      const id = update.messageId ?? `anon-${this.messageSeq}`;
      if (this.message && this.message.id !== id) this.flushMessage();
      this.message ??= { id, text: '' };
      this.message.text += text;
      return;
    }
    if (update.sessionUpdate === 'tool_call') {
      this.flushMessage();
      if (!this.tools.has(update.toolCallId)) this.toolOrder.push(update.toolCallId);
      this.tools.set(update.toolCallId, {
        title: update.title ?? null,
        kind: update.kind ?? null,
        status: update.status ?? 'pending',
        texts: textsOf(update.content),
        rawOutput: update.rawOutput ?? null,
        emitted: null,
      });
      this.flushTools(false);
      return;
    }
    if (update.sessionUpdate === 'tool_call_update') {
      const tool = this.tools.get(update.toolCallId);
      if (!tool) throw new AcpProtocolError(`ACP 更新了未知工具调用 ${update.toolCallId}`);
      if (update.title != null) tool.title = update.title;
      if (update.kind != null) tool.kind = update.kind;
      if (update.status != null) tool.status = update.status;
      if (update.content != null) tool.texts = textsOf(update.content);
      if (update.rawOutput != null) tool.rawOutput = update.rawOutput;
      this.flushTools(false);
    }
  }

  private async request(method: string, params: unknown): Promise<unknown> {
    if (method !== 'session/request_permission') {
      this.warn(`request:${method}`, `ACP Agent 调用了未提供的客户端能力：${method}`);
      throw new AcpMethodNotFound(method);
    }
    const parsed = RequestPermissionParamsSchema.safeParse(params);
    if (!parsed.success) throw new AcpProtocolError('ACP 权限请求缺少字段');
    if (this.cancelRequested || this.phase === 'done') return { outcome: { outcome: 'cancelled' } };
    const decide = this.input.decidePermission ?? denyAllPermissions;
    return new Promise<PermissionOutcome>((resolve) => {
      this.pendingPermissions.add(resolve);
      Promise.resolve(decide(parsed.data)).then(
        (outcome) => {
          if (!this.pendingPermissions.delete(resolve)) return;
          resolve(outcome);
        },
        () => {
          if (!this.pendingPermissions.delete(resolve)) return;
          resolve({ outcome: { outcome: 'cancelled' } });
        },
      );
    });
  }

  private flushMessage() {
    if (!this.message) return;
    if (this.message.text.trim()) this.emit({ type: 'message', id: this.message.id, text: this.message.text });
    this.message = null;
    this.messageSeq++;
  }

  /** 工具在完成或失败时发出记录；轮次结束时未完成的工具以 exitCode null 发出。 */
  private flushTools(final: boolean) {
    for (const id of this.toolOrder) {
      const tool = this.tools.get(id)!;
      const finished = tool.status === 'completed' || tool.status === 'failed';
      if (!finished && !final) continue;
      const raw = tool.texts.length ? tool.texts.join('\n') : tool.rawOutput == null ? '' : JSON.stringify(tool.rawOutput);
      const signature = `${tool.status}\u0000${raw}`;
      if (tool.emitted === signature) continue;
      tool.emitted = signature;
      this.emit({
        type: 'tool',
        id,
        command: `acp:${tool.kind ?? 'other'} ${tool.title ?? id}`,
        output: raw.slice(-16000),
        exitCode: tool.status === 'completed' ? 0 : tool.status === 'failed' ? 1 : null,
        truncated: raw.length > 16000,
      });
    }
  }

  private warn(key: string, text: string) {
    if (this.warned.has(key)) return;
    this.warned.add(key);
    this.emit({ type: 'warning', text });
  }
}

function textsOf(content: { content?: unknown }[] | undefined | null): string[] {
  return (content ?? []).map((entry) => textOf(entry.content)).filter((text): text is string => text !== null);
}
