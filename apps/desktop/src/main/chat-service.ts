import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { app, utilityProcess, type UtilityProcess } from 'electron';
import {
  EnvironmentListSchema,
  ObservationResultSchema,
  type ResourceInstanceIdentity,
  type ObservationRequest,
  type ObservationTurnScope,
  type WorkspaceObservationResult,
  type FileInvalidationHint,
  ResourceCollectionSchema,
  ResourceListRequestSchema,
  ResourceSaveRequestSchema,
  ResourceRemoveRequestSchema,
  type PageResourceSnapshot,
  ChatConversationSchema,
  TerminalSnapshotSchema,
  type TerminalSnapshot,
  ChatServiceMessageSchema,
  ChatServiceRequestSchema,
  ChatStatusSchema,
  type ChatConversation,
  type ChatServiceRequest,
  type ChatSlot,
  type ChatStatus,
} from '@wsl/protocol';

export class ChatService {
  private child: UtilityProcess;
  private readonly pending = new Map<
    string,
    {
      resolve: (result: unknown) => void;
      reject: (error: Error) => void;
      resourceId?: string;
      start: { kind: 'chat'; slot: ChatSlot; seq: number } | { kind: 'terminal'; seq: number; resourceId: string } | null;
    }
  >();
  private unknownCleanup = false;
  private initializationPending = true;
  private failure: string | null = null;
  private stopped = false;
  private shutdownResult: Promise<void> | null = null;
  private readonly exit: Promise<void>;
  private readonly conversations = new Map<ChatSlot, ChatConversation>();
  private sequence = 0;
  private readonly terminals = new Map<string, TerminalSnapshot>();
  private readonly resourceBindings = new Map<string, ResourceInstanceIdentity>();
  private observationReader:
    | ((
        scope: ObservationTurnScope,
        tool: string,
        args: Record<string, unknown>,
        signal: AbortSignal,
      ) => Promise<WorkspaceObservationResult>)
    | null = null;
  private readonly observationCalls = new Map<string, AbortController>();
  setObservationReader(reader: NonNullable<ChatService['observationReader']>) {
    this.observationReader = reader;
  }
  private lastStatus: ChatStatus | null = null;
  constructor(
    private readonly onConversation: (conversation: ChatConversation) => void,
    private readonly onStatus: (status: ChatStatus) => void,
    private readonly onTerminal: (snapshot: TerminalSnapshot, resourceId: string, binding: ResourceInstanceIdentity) => void = () =>
      undefined,
    private readonly onFileHint: (hint: FileInvalidationHint) => void = () => undefined,
  ) {
    const entry = app.isPackaged
      ? path.join(process.resourcesPath, 'service/index.cjs')
      : path.resolve(app.getAppPath(), '../service/out/index.cjs');
    this.child = utilityProcess.fork(entry, [path.join(app.getPath('userData'), 'chat')], { serviceName: 'Codex 对话', stdio: 'pipe' });
    this.exit = new Promise((resolve) =>
      this.child.once('exit', (code) => {
        this.fail(`对话服务已退出（${code}）`);
        resolve();
      }),
    );
    this.child.on('message', (raw: unknown) => {
      try {
        const message = ChatServiceMessageSchema.parse(raw);
        if (message.type === 'initialized') {
          this.initializationPending = message.cleanupPending;
          this.lastStatus = message.status;
          this.onStatus(message.status);
          return;
        }
        if (message.type === 'observation-abort') {
          this.observationCalls.get(message.id)?.abort();
          return;
        }
        if (message.type === 'observation-call') {
          if (this.observationCalls.has(message.id)) throw new Error('观察调用身份重复');
          const controller = new AbortController();
          this.observationCalls.set(message.id, controller);
          const read = this.observationReader
            ? this.observationReader(message.scope, message.tool, message.args, controller.signal)
            : Promise.resolve({ error: 'unavailable' as const, message: 'Main观察通道未接入' });
          void read
            .then(
              (result) => this.request({ method: 'observation.reply', payload: { callId: message.id, result } }),
              (error) =>
                this.request({
                  method: 'observation.reply',
                  payload: { callId: message.id, result: { error: 'unavailable', message: (error as Error).message } },
                }),
            )
            .then(
              () => {
                this.observationCalls.delete(message.id);
              },
              (error) => {
                this.observationCalls.delete(message.id);
                this.fail('观察返回通道失败：' + (error as Error).message);
              },
            );
          return;
        }
        if (message.type === 'event') {
          this.remember(message.conversation);
          this.onConversation(message.conversation);
          return;
        }
        if (message.type === 'terminal-event') {
          const binding = this.resourceBindings.get(message.resourceId);
          if (!binding || (Object.keys(binding) as (keyof ResourceInstanceIdentity)[]).some((key) => binding[key] !== message.binding[key]))
            return;
          this.terminals.set(message.resourceId, message.terminal);
          this.onTerminal(message.terminal, message.resourceId, message.binding);
          return;
        }
        if (message.type === 'file-hint') {
          this.onFileHint(message.hint);
          return;
        }
        const request = this.pending.get(message.id);
        if (!request) throw new Error('对话服务返回未知请求身份');
        this.pending.delete(message.id);
        if (message.type === 'error') request.reject(new Error(message.error));
        else {
          if (message.result && 'conversationId' in message.result) this.remember(message.result);
          if (message.result && 'sessionId' in message.result) {
            if (request.resourceId) {
              const before = this.terminals.get(request.resourceId);
              if (!before || before.seq < message.result.seq) this.terminals.set(request.resourceId, message.result);
            }
          }
          request.resolve(message.result);
        }
      } catch (error) {
        this.fail(`对话服务通信失败：${(error as Error).message}`);
        this.child.kill();
      }
    });
  }
  private remember(conversation: ChatConversation) {
    this.sequence = Math.max(this.sequence, conversation.seq);
    if ((this.conversations.get(conversation.conversationId)?.seq ?? -1) < conversation.seq)
      this.conversations.set(conversation.conversationId, conversation);
  }
  private fail(reason: string) {
    for (const controller of this.observationCalls.values()) controller.abort();
    this.failure ??= reason;
    for (const request of this.pending.values()) {
      const start = request.start;
      if (!start) continue;
      const current = start.kind === 'chat' ? this.conversations.get(start.slot) : this.terminals.get(start.resourceId);
      // 新快照的清理确认可解除尚未收到 ACK 的启动请求占用。
      if (!current || current.seq <= start.seq || current.cleanupPending) this.unknownCleanup = true;
    }
    for (const request of this.pending.values()) request.reject(new Error(this.failure));
    this.pending.clear();
    if (this.stopped) return;
    this.onStatus({
      available: false,
      reason:
        this.initializationPending ||
        this.unknownCleanup ||
        [...this.conversations.values()].some((conversation) => conversation.cleanupPending) ||
        [...this.terminals.values()].some((t) => t.cleanupPending)
          ? this.failure + '；guest 清理未确认'
          : this.failure,
      version: null,
      sandbox: this.lastStatus?.sandbox ?? null,
      cwd: this.lastStatus?.cwd ?? null,
    });
    for (const [resourceId, terminal] of this.terminals) {
      const binding = this.resourceBindings.get(resourceId);
      if (terminal.cleanupPending && binding)
        this.onTerminal(
          { ...terminal, seq: terminal.seq + 1, state: 'failed', error: this.failure + '；guest 清理未确认' },
          resourceId,
          binding,
        );
    }
    for (const conversation of this.conversations.values()) {
      if (conversation.cleanupPending) {
        this.onConversation({ ...conversation, seq: ++this.sequence, state: 'failed', error: this.failure + '；guest 清理未确认' });
      }
    }
  }

  private request(
    request: ChatServiceRequest extends infer R ? (R extends { id: string } ? Omit<R, 'id'> : never) : never,
  ): Promise<unknown> {
    if (this.stopped && request.method !== 'shutdown') return Promise.reject(new Error('对话服务正在关闭'));
    if (this.failure) return Promise.reject(new Error(this.failure));
    const data = ChatServiceRequestSchema.parse({ ...request, id: randomUUID() });
    return new Promise((resolve, reject) => {
      const start =
        data.method === 'send'
          ? {
              kind: 'chat' as const,
              slot: data.payload.conversationId,
              seq: this.conversations.get(data.payload.conversationId)?.seq ?? -1,
            }
          : data.method === 'terminal.open'
            ? {
                kind: 'terminal' as const,
                resourceId: data.payload.resourceId,
                seq: this.terminals.get(data.payload.resourceId)?.seq ?? -1,
              }
            : null;
      const resourceId =
        data.method === 'terminal.get'
          ? data.resourceId
          : 'payload' in data && 'resourceId' in data.payload
            ? data.payload.resourceId
            : undefined;
      this.pending.set(data.id, { resolve, reject, start, resourceId });
      this.child.postMessage(data);
    });
  }
  async environmentsList() {
    return EnvironmentListSchema.parse(await this.request({ method: 'environments.list' }));
  }
  async registerResource(binding: ResourceInstanceIdentity) {
    await this.request({ method: 'resource.register', payload: binding });
    const previous = this.resourceBindings.get(binding.resourceId);
    if (previous && (previous.instanceId !== binding.instanceId || previous.instanceGeneration !== binding.instanceGeneration))
      this.terminals.delete(binding.resourceId);
    this.resourceBindings.set(binding.resourceId, binding);
  }
  async observe(request: ObservationRequest) {
    return ObservationResultSchema.parse(await this.request({ method: 'observation.read', payload: request }));
  }
  async cancelObservation(requestId: string) {
    await this.request({ method: 'observation.cancel', payload: { requestId } });
  }
  async resourcesList(spaceId: string) {
    return ResourceCollectionSchema.parse(
      await this.request({ method: 'resources.list', payload: ResourceListRequestSchema.parse({ spaceId }) }),
    );
  }
  async resourcesSave(spaceId: string, snapshot: PageResourceSnapshot, resourceId?: string) {
    return ResourceCollectionSchema.parse(
      await this.request({ method: 'resources.save', payload: ResourceSaveRequestSchema.parse({ spaceId, snapshot, resourceId }) }),
    );
  }
  async resourcesRemove(spaceId: string, resourceId: string) {
    return ResourceCollectionSchema.parse(
      await this.request({ method: 'resources.remove', payload: ResourceRemoveRequestSchema.parse({ spaceId, resourceId }) }),
    );
  }
  async status() {
    if (this.failure)
      return {
        available: false,
        reason: this.failure,
        version: null,
        sandbox: this.lastStatus?.sandbox ?? null,
        cwd: this.lastStatus?.cwd ?? null,
      };
    this.lastStatus = ChatStatusSchema.parse(await this.request({ method: 'status' }));
    return this.lastStatus;
  }
  async register(id: ChatSlot, workspaceId: string) {
    await this.request({ method: 'register', payload: { conversationId: id, workspaceId } });
  }
  async get(id: ChatSlot) {
    return ChatConversationSchema.parse(await this.request({ method: 'get', payload: { conversationId: id } }));
  }
  async send(id: ChatSlot, text: string, observationScope?: ObservationTurnScope) {
    return ChatConversationSchema.parse(await this.request({ method: 'send', payload: { conversationId: id, text, observationScope } }));
  }
  async cancel(id: ChatSlot) {
    return ChatConversationSchema.parse(await this.request({ method: 'cancel', payload: { conversationId: id } }));
  }
  async reset(id: ChatSlot) {
    return ChatConversationSchema.parse(await this.request({ method: 'reset', payload: { conversationId: id } }));
  }
  async terminalGet(resourceId: string) {
    return TerminalSnapshotSchema.parse(await this.request({ method: 'terminal.get', resourceId }));
  }
  async terminalOpen(cols: number, rows: number, resourceId: string) {
    return TerminalSnapshotSchema.parse(await this.request({ method: 'terminal.open', payload: { cols, rows, resourceId } }));
  }
  async terminalWrite(sessionId: string, data: string, resourceId: string) {
    await this.request({ method: 'terminal.write', payload: { sessionId, data, resourceId } });
  }
  async terminalResize(sessionId: string, cols: number, rows: number, resourceId: string) {
    await this.request({ method: 'terminal.resize', payload: { sessionId, cols, rows, resourceId } });
  }
  async terminalClose(sessionId: string, resourceId: string) {
    return TerminalSnapshotSchema.parse(await this.request({ method: 'terminal.close', payload: { sessionId, resourceId } }));
  }
  shutdown(): Promise<void> {
    if (this.shutdownResult) return this.shutdownResult;
    this.stopped = true;
    this.shutdownResult = (async () => {
      if (
        this.failure &&
        (this.initializationPending ||
          this.unknownCleanup ||
          [...this.conversations.values()].some((conversation) => conversation.cleanupPending) ||
          [...this.terminals.values()].some((t) => t.cleanupPending))
      )
        throw new Error(this.failure + '；guest 清理未确认');
      if (!this.failure) {
        try {
          await this.request({ method: 'shutdown' });
          // 只在远端清理已确认的ACK到达后结束已无guest进程的本地服务。
          this.child.kill();
        } catch (error) {
          this.onStatus({
            available: false,
            reason: `guest 清理失败：${(error as Error).message}`,
            version: null,
            sandbox: this.lastStatus?.sandbox ?? null,
            cwd: this.lastStatus?.cwd ?? null,
          });
          throw error;
        }
      }
      await this.exit;
    })();
    return this.shutdownResult;
  }
}
