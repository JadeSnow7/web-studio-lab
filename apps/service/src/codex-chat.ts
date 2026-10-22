import { randomUUID, createHash } from 'node:crypto';
import {
  ObservationTurnScopeSchema,
  WorkspaceObservationResultSchema,
  AppControlResultSchema,
  AppToolNameSchema,
  type AppControlResult,
  ResourceBundleSchema,
  type ObservationTurnScope,
  type WorkspaceObservationResult,
  type ChatConversation,
  type ChatSlot,
  type ChatStatus,
  type CatalogReferenceSnapshot,
} from '@wsl/protocol';
import { SbxConnection, GUEST_CWD, type GuestProcess, type GuestOutcome } from './sbx';
import { codexAdapter } from './harness/codex/adapter';
import type { HarnessEvent, NativeHarnessAdapter } from './harness/types';
import { acpDescriptor, type AcpAgentSpec } from './harness/acp/agents';
import { AcpClient, AcpMethodNotFound, AcpProtocolError } from './harness/acp/client';
import { ACP_PROTOCOL_VERSION, InitializeResultSchema, type AcpStdioMcpServer, type InitializeResult } from './harness/acp/protocol';
import { AcpTurn, acpInitializeParams } from './harness/acp/turn';
import { workspaceWritePolicy } from './harness/acp/policy';

export { parseCodexLine } from './harness/codex/adapter';

/** 执行核心使用的 Harness：native 逐行解析一次性进程的输出；acp 经 stdin relay 与长连接 Agent 往返。 */
export type ChatHarness = { kind: 'native'; adapter: NativeHarnessAdapter } | { kind: 'acp'; spec: AcpAgentSpec };
export const CODEX_HARNESS: ChatHarness = { kind: 'native', adapter: codexAdapter };

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
    /** 本执行核心使用的 Harness；默认 Codex native。 */
    private readonly harness: ChatHarness = CODEX_HARNESS,
  ) {
    this.connection = connection;
  }
  private acpInit: InitializeResult | null = null;
  private acpFailure: string | null = null;
  private get label() {
    return this.harness.kind === 'native' ? this.harness.adapter.label : this.harness.spec.label;
  }
  async initialize(): Promise<ChatStatus> {
    const status = await this.connection.initialize();
    if (this.harness.kind === 'acp' && status.available) await this.probeAcp(this.harness.spec);
    return this.withHarness(status);
  }
  getStatus(): ChatStatus {
    return this.withHarness(this.connection.getStatus());
  }
  private withHarness(status: ChatStatus): ChatStatus {
    if (this.harness.kind === 'native')
      return { ...status, harness: this.harness.adapter.descriptor(status.available ? status.version : null) };
    const harness = acpDescriptor(this.harness.spec, this.acpInit);
    if (!status.available) return { ...status, harness };
    if (!this.acpInit)
      return { ...status, available: false, reason: `${this.label} 不可用：${this.acpFailure ?? '尚未完成检查'}`, version: null, harness };
    return { ...status, version: harness.version, harness };
  }
  /**
   * 可用性探测：在 guest 内启动 ACP Agent，只发 initialize（不调用模型），据回复声明能力，然后关闭 stdin 并确认清理。
   * 清理未确认时判为不可用，避免留下未知进程。
   */
  private async probeAcp(spec: AcpAgentSpec) {
    this.acpInit = null;
    this.acpFailure = null;
    let buffer = '';
    const probe = this.connection.start({ type: 'start', mode: 'codex', argv: spec.command, stdin: 'relay' }, (frame) => {
      if (frame.type !== 'output' || frame.stream !== 'stdout') return;
      buffer += frame.data;
      while (buffer.includes('\n')) {
        const index = buffer.indexOf('\n');
        const line = buffer.slice(0, index);
        buffer = buffer.slice(index + 1);
        try {
          client.receive(line);
        } catch (error) {
          client.close((error as Error).message);
        }
      }
    });
    const client = new AcpClient((line) => probe.writeInput(line), {
      onNotification: () => undefined,
      onRequest: async (method) => {
        throw new AcpMethodNotFound(method);
      },
    });
    const exited = probe.done.then(() => client.close('Agent 进程在初始化前退出'));
    const timer = setTimeout(() => client.close('Agent 初始化超时'), 30000);
    try {
      const init = InitializeResultSchema.parse(await client.request('initialize', acpInitializeParams()));
      if (init.protocolVersion !== ACP_PROTOCOL_VERSION) throw new AcpProtocolError(`ACP 协议版本不兼容：${init.protocolVersion}`);
      this.acpInit = init;
    } catch (error) {
      this.acpFailure = (error as Error).message;
    } finally {
      clearTimeout(timer);
      client.close('探测结束');
      try {
        probe.endInput();
      } catch {
        // 传输已关闭：退出结果由 done 报告。
      }
    }
    const outcome = await Promise.race([probe.done, new Promise<null>((resolve) => setTimeout(() => resolve(null), 10000))]);
    const settled = outcome ?? (await probe.close());
    await exited;
    if (!settled.confirmed) {
      this.acpInit = null;
      this.acpFailure = settled.error ?? '探测进程清理未确认';
    }
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
  ): Promise<ChatConversation> {
    if (this.closing) throw new Error('对话服务正在关闭');
    if (id !== 'conv-personal-default' && !this.workspaceBySession.has(id)) throw new Error('会话尚未由宿主注册');
    if (observationScope) {
      observationScope = ObservationTurnScopeSchema.parse(observationScope);
      if (observationScope.sessionId !== id || this.workspaceBySession.get(id) !== observationScope.workspaceId)
        throw new Error('观察会话不属于已注册空间');
    }
    const status = this.getStatus();
    if (!status.available) throw new Error(status.reason ?? 'sbx 不可用');
    const slot = this.slot(id);
    if (slot.active) throw new Error(slot.active?.cleanupError ?? '当前会话正在等待回复');
    const spaceId = this.workspaceBySession.get(id) ?? null;
    this.assertCleanupKnown();
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
    const harness = this.harness;
    const label = this.label;
    const native = harness.kind === 'native' ? harness.adapter : null;
    const argv = native ? native.argv(slot.conversation.threadId) : (harness as Extract<ChatHarness, { kind: 'acp' }>).spec.command;
    const maxLineChars = native ? native.maxLineChars : 1048576;
    const mcpServers: AcpStdioMcpServer[] = [];
    let acpTurn: AcpTurn | null = null;
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
    const apply = (events: HarnessEvent[]) => {
      for (const event of events) {
        if (event.type === 'session') {
          if (!event.fresh && slot.conversation.threadId && slot.conversation.threadId !== event.ref)
            throw new Error(`${label} 返回了不同的会话身份`);
          slot.conversation.threadId = event.ref;
        }
        if (event.type === 'message') {
          turn.replied = true;
          const messageId = `${turnId}:${event.id}`;
          if (!slot.conversation.messages.some((message) => message.id === messageId))
            slot.conversation.messages.push({ id: messageId, role: 'assistant', text: event.text });
        }
        if (event.type === 'warning') {
          if (!slot.conversation.warnings.includes(event.text)) slot.conversation.warnings.push(event.text);
          slot.conversation.warnings = slot.conversation.warnings.slice(-20);
        }
        if (event.type === 'tool') {
          const command = event.command;
          const tools = slot.conversation.toolExecutions;
          const record = {
            id: event.id,
            turnId,
            command: command.slice(-4000),
            output: event.output,
            exitCode: event.exitCode,
            truncated: event.truncated || command.length > 4000,
          };
          const index = tools.findIndex((tool) => tool.id === event.id && tool.turnId === turnId);
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
        if (event.type === 'turn_completed') turn.completed = true;
        if (event.type === 'turn_failed') fail(event.message);
      }
    };
    const consume = (line: string) => {
      if (turn.cancel || turn.failure || slot.active !== turn || !line.trim()) return;
      try {
        if (native) {
          const events = native.parseLine(line);
          if (!events) return;
          apply(events);
          this.publish(slot);
        } else acpTurn?.receive(line);
      } catch (error) {
        fail(`${label} 协议错误：${(error as Error).message}`);
      }
    };
    const startAcp = () => {
      const turnRef = turn;
      acpTurn = new AcpTurn(
        (line) => {
          try {
            process.writeInput(line);
          } catch {
            // 传输已关闭：结果由进程完成回执决定。
          }
        },
        (event) => {
          if (turnRef.cancel || turnRef.failure || slot.active !== turnRef) return;
          try {
            apply([event]);
            this.publish(slot);
          } catch (error) {
            fail(`${label} 协议错误：${(error as Error).message}`);
          }
        },
        {
          cwd: GUEST_CWD,
          mcpServers,
          sessionRef: slot.conversation.threadId,
          prompt: text,
          signal: turnRef.observation.signal,
          decidePermission: workspaceWritePolicy((params, reason) => {
            const warning = `已拒绝 ${params.toolCall.title ?? params.toolCall.toolCallId} 的权限请求：${reason}`.slice(0, 2000);
            if (!slot.conversation.warnings.includes(warning)) slot.conversation.warnings.push(warning);
            slot.conversation.warnings = slot.conversation.warnings.slice(-20);
          }),
        },
      );
      void acpTurn.run().then(
        () => {
          try {
            process.endInput();
          } catch {
            // 传输已关闭。
          }
        },
        (error: Error) => fail(`${label} 协议错误：${error.message}`),
      );
    };
    let callCount = 0;
    const process = this.connection.start(
      {
        type: 'start',
        mode: 'codex',
        argv,
        ...(native ? { mcp: native.mcpInjection, prompt: text } : { mcp: 'acp-stdio' as const, stdin: 'relay' as const }),
        resourceBundle,
        observation: Boolean(observationScope && this.observationReader),
        observationImages: false,
      },
      (frame) => {
        if (slot.active !== turn || turn.finishing) return;
        if (frame.type === 'observation-cancel') {
          turn.calls.get(frame.id)?.abort();
          return;
        }
        if (frame.type === 'observation-call') {
          if (turn.failure || turn.cancel || turn.observation.signal.aborted) return;
          const appTool = frame.tool.startsWith('app.');
          const reply = (result: WorkspaceObservationResult | AppControlResult) => {
            if (slot.active !== turn || turn.failure || turn.cancel || turn.observation.signal.aborted) return;
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
        if (frame.type === 'mcp-server') {
          if (!native) mcpServers.push({ name: frame.name, command: frame.command, args: frame.args, env: [] });
          return;
        }
        if (frame.type === 'ready') {
          if (!native && !acpTurn) startAcp();
          return;
        }
        if (frame.type === 'cleanup') {
          // A frame is not the transport's settled cleanup receipt.
          if (!frame.ok) turn.cleanupError ??= frame.error ?? 'guest 清理未确认';
        }
        if (frame.type !== 'output') return;
        if (frame.stream === 'stderr') {
          stderr = (stderr + frame.data).slice(-4000);
          return;
        }
        buffer += frame.data;
        if (buffer.length > maxLineChars) {
          fail(`${label} 协议行超过限制`);
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
      .then((outcome) => {
        if (slot.active !== turn) return;
        turn.finishing = true;
        turn.observation.abort();
        // The final JSON event need not end with a newline. Only new frames are
        // blocked while finishing; this already-received tail is still consumed.
        if (buffer.trim()) consume(buffer);
        // 进程已退出：未完成的 ACP 请求不再等待，之后到达的内容被隔离。
        (acpTurn as AcpTurn | null)?.close('Agent 进程已退出');
        turn.cleanupConfirmed = outcome.confirmed;
        turn.cleanupError = !outcome.confirmed ? (outcome.error ?? 'guest 清理未确认') : null;
        slot.conversation.cleanupPending = !outcome.confirmed;
        const failure =
          [...new Set([turn.failure, turn.cleanupError, outcome.error].filter(Boolean))].join('; ') ||
          (!turn.cancel
            ? outcome.exitCode !== 0
              ? `${label} 退出失败（${outcome.exitCode}）${stderr ? `：${stderr}` : ''}`
              : !turn.completed
                ? `${label} 未返回对话完成事件`
                : (native ? native.requiresSessionRef : true) && !slot.conversation.threadId
                  ? `${label} 未返回会话身份`
                  : !turn.replied
                    ? `${label} 未返回助手回复`
                    : null
            : null);
        slot.conversation.state = failure ? 'failed' : turn.cancel ? 'cancelled' : 'idle';
        slot.conversation.error = failure;
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
    // A synchronous subscriber may cancel while the settled outcome is being
    // published. It must await that publication without changing the terminal state.
    if (turn.finishing) {
      await turn.completion;
      if (!turn.cleanupConfirmed) throw new Error(turn.cleanupError ?? 'guest 清理未确认');
      return this.get(id);
    }
    if (turn.cleanupError) throw new Error(turn.cleanupError);
    if (!turn.failure) {
      turn.cancel = true;
      turn.observation.abort();
      slot.conversation.state = 'cancelling';
      try {
        this.publish(slot);
      } catch (error) {
        // Publication failure must not prevent the owned process from closing.
        this.completionFailed(slot, turn, error);
      }
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
