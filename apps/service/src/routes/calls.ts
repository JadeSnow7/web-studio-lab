import { randomUUID } from 'node:crypto';

/** 按调用 ID 持有可取消的 service 调用；重复 ID 拒绝，结束后释放。 */
export class CancellableCalls {
  private readonly controllers = new Map<string, AbortController>();

  constructor(private readonly duplicateMessage: string) {}

  async run<T>(id: string, work: (signal: AbortSignal) => Promise<T>): Promise<T> {
    if (this.controllers.has(id)) throw new Error(this.duplicateMessage);
    const controller = new AbortController();
    this.controllers.set(id, controller);
    try {
      return await work(controller.signal);
    } finally {
      this.controllers.delete(id);
    }
  }

  cancel(id: string): void {
    this.controllers.get(id)?.abort();
  }

  abortAll(): void {
    for (const controller of this.controllers.values()) controller.abort();
  }
}

/** 由 service 发起、等待 Main 回复的调用；取消时通知 Main 并以给定结果结束。 */
export class MainRelay<R> {
  private readonly calls = new Map<string, { resolve: (result: R) => void; abort: () => void; signal: AbortSignal }>();

  request(signal: AbortSignal, cancelled: R, call: (id: string) => void, abortCall: (id: string) => void): Promise<R> {
    return new Promise((resolve) => {
      const id = randomUUID();
      const abort = () => {
        signal.removeEventListener('abort', abort);
        abortCall(id);
        this.calls.delete(id);
        resolve(cancelled);
      };
      this.calls.set(id, { resolve, abort, signal });
      signal.addEventListener('abort', abort, { once: true });
      if (signal.aborted) {
        abort();
        return;
      }
      call(id);
    });
  }

  reply(id: string, result: R): void {
    const call = this.calls.get(id);
    if (!call) return;
    this.calls.delete(id);
    call.signal.removeEventListener('abort', call.abort);
    call.resolve(result);
  }
}
