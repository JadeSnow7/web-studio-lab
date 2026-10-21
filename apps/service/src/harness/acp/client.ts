import { JsonRpcMessageSchema } from './protocol';

/** ACP 协议违约：调用方应把当前轮次记为失败并关闭所属进程。 */
export class AcpProtocolError extends Error {}
/** Agent 以 JSON-RPC error 回复了本端请求。 */
export class AcpRemoteError extends Error {
  constructor(
    readonly method: string,
    readonly code: number,
    message: string,
  ) {
    super(message);
  }
}

export interface AcpClientHandlers {
  onNotification(method: string, params: unknown): void;
  /** Agent 发给客户端的请求；抛出 AcpMethodNotFound 时回复 -32601。 */
  onRequest(method: string, params: unknown): Promise<unknown>;
}
export class AcpMethodNotFound extends Error {}

interface Pending {
  method: string;
  resolve: (value: unknown) => void;
  reject: (error: Error) => void;
}

/**
 * 逐行 JSON-RPC 2.0 客户端，与传输无关：调用方提供 write，把收到的每一行交给 receive。
 * 只负责消息配对与边界校验，不理解 ACP 业务语义。
 */
export class AcpClient {
  private nextId = 1;
  private readonly pending = new Map<number, Pending>();
  private closed: string | null = null;
  constructor(
    private readonly write: (line: string) => void,
    private readonly handlers: AcpClientHandlers,
    private readonly limits = { maxLineChars: 1048576, maxPending: 16 },
  ) {}

  get isClosed() {
    return this.closed !== null;
  }

  request(method: string, params: unknown): Promise<unknown> {
    if (this.closed) return Promise.reject(new Error(this.closed));
    if (this.pending.size >= this.limits.maxPending) return Promise.reject(new AcpProtocolError('ACP 在途请求超过上限'));
    const id = this.nextId++;
    return new Promise((resolve, reject) => {
      this.pending.set(id, { method, resolve, reject });
      this.send({ jsonrpc: '2.0', id, method, params });
    });
  }

  notify(method: string, params: unknown) {
    if (this.closed) return;
    this.send({ jsonrpc: '2.0', method, params });
  }

  /** 处理一行输入；格式错误、未知响应身份等协议违约抛出 AcpProtocolError。关闭后到达的行被忽略。 */
  receive(line: string): void {
    if (this.closed || !line.trim()) return;
    if (line.length > this.limits.maxLineChars) throw new AcpProtocolError('ACP 协议行超过限制');
    let raw: unknown;
    try {
      raw = JSON.parse(line);
    } catch {
      throw new AcpProtocolError('ACP 输出不是 JSON');
    }
    const parsed = JsonRpcMessageSchema.safeParse(raw);
    if (!parsed.success) throw new AcpProtocolError('ACP 消息不符合 JSON-RPC 2.0');
    const message = parsed.data;
    if ('method' in message) {
      if ('id' in message) void this.answer(message.id, message.method, message.params);
      else this.handlers.onNotification(message.method, message.params);
      return;
    }
    const id = message.id;
    const pending = typeof id === 'number' ? this.pending.get(id) : undefined;
    if (!pending) throw new AcpProtocolError(`ACP 返回了未知请求身份 ${String(id)}`);
    this.pending.delete(id as number);
    if ('error' in message) pending.reject(new AcpRemoteError(pending.method, message.error.code, message.error.message));
    else pending.resolve(message.result);
  }

  /** 关闭后拒绝所有在途请求，不再写出任何消息。 */
  close(reason: string) {
    if (this.closed) return;
    this.closed = reason;
    for (const pending of this.pending.values()) pending.reject(new Error(reason));
    this.pending.clear();
  }

  private async answer(id: string | number, method: string, params: unknown) {
    try {
      const result = await this.handlers.onRequest(method, params);
      if (!this.closed) this.send({ jsonrpc: '2.0', id, result: result ?? null });
    } catch (error) {
      if (this.closed) return;
      const notFound = error instanceof AcpMethodNotFound;
      this.send({
        jsonrpc: '2.0',
        id,
        error: { code: notFound ? -32601 : -32603, message: notFound ? `Method not found: ${method}` : (error as Error).message },
      });
    }
  }

  private send(message: unknown) {
    this.write(JSON.stringify(message) + '\n');
  }
}
