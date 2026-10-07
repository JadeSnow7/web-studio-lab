import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { app, utilityProcess, type UtilityProcess } from 'electron';
import {
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
      start: { kind: 'chat'; slot: ChatSlot; seq: number } | { kind: 'terminal'; seq: number } | null;
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
  private terminalSnapshot: TerminalSnapshot | null = null;
  private lastStatus: ChatStatus | null = null;
  constructor(
    private readonly onConversation: (conversation: ChatConversation) => void,
    private readonly onStatus: (status: ChatStatus) => void,
    private readonly onTerminal: (snapshot: TerminalSnapshot) => void = () => undefined,
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
        if (message.type === 'event') {
          this.remember(message.conversation);
          this.onConversation(message.conversation);
          return;
        }
        if (message.type === 'terminal-event') {
          this.terminalSnapshot = message.terminal;
          this.onTerminal(message.terminal);
          return;
        }
        const request = this.pending.get(message.id);
        if (!request) throw new Error('对话服务返回未知请求身份');
        this.pending.delete(message.id);
        if (message.type === 'error') request.reject(new Error(message.error));
        else {
          if (message.result && 'conversationId' in message.result) this.remember(message.result);
          if (message.result && 'sessionId' in message.result && (!this.terminalSnapshot || this.terminalSnapshot.seq < message.result.seq))
            this.terminalSnapshot = message.result;
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
    this.failure ??= reason;
    for (const request of this.pending.values()) {
      const start = request.start;
      if (!start) continue;
      const current = start.kind === 'chat' ? this.conversations.get(start.slot) : this.terminalSnapshot;
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
        this.terminalSnapshot?.cleanupPending
          ? this.failure + '；guest 清理未确认'
          : this.failure,
      version: null,
      sandbox: this.lastStatus?.sandbox ?? null,
      cwd: this.lastStatus?.cwd ?? null,
    });
    if (this.terminalSnapshot?.cleanupPending)
      this.onTerminal({
        ...this.terminalSnapshot,
        seq: this.terminalSnapshot.seq + 1,
        state: 'failed',
        error: this.failure + '；guest 清理未确认',
      });
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
            ? { kind: 'terminal' as const, seq: this.terminalSnapshot?.seq ?? -1 }
            : null;
      this.pending.set(data.id, { resolve, reject, start });
      this.child.postMessage(data);
    });
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
  async get(id: ChatSlot) {
    return ChatConversationSchema.parse(await this.request({ method: 'get', payload: { conversationId: id } }));
  }
  async send(id: ChatSlot, text: string) {
    return ChatConversationSchema.parse(await this.request({ method: 'send', payload: { conversationId: id, text } }));
  }
  async cancel(id: ChatSlot) {
    return ChatConversationSchema.parse(await this.request({ method: 'cancel', payload: { conversationId: id } }));
  }
  async reset(id: ChatSlot) {
    return ChatConversationSchema.parse(await this.request({ method: 'reset', payload: { conversationId: id } }));
  }
  async terminalGet() {
    return TerminalSnapshotSchema.parse(await this.request({ method: 'terminal.get' }));
  }
  async terminalOpen(cols: number, rows: number) {
    return TerminalSnapshotSchema.parse(await this.request({ method: 'terminal.open', payload: { cols, rows } }));
  }
  async terminalWrite(sessionId: string, data: string) {
    await this.request({ method: 'terminal.write', payload: { sessionId, data } });
  }
  async terminalResize(sessionId: string, cols: number, rows: number) {
    await this.request({ method: 'terminal.resize', payload: { sessionId, cols, rows } });
  }
  async terminalClose(sessionId: string) {
    return TerminalSnapshotSchema.parse(await this.request({ method: 'terminal.close', payload: { sessionId } }));
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
          this.terminalSnapshot?.cleanupPending)
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
