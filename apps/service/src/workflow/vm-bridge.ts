import { Worker } from 'node:worker_threads';

/**
 * VM worker 的宿主侧桥（合同 §8）：只管生命周期与有界消息，不做业务判断。
 *  dispose 之后到达的迟到消息一律忽略；dispose 用 worker.terminate() 兜底确认线程退出。
 */

export type OutboxItem =
  | { kind: 'call'; opId: number; prompt: unknown; opts: unknown; phase: unknown }
  | { kind: 'phase'; title: unknown }
  | { kind: 'log'; message: unknown }
  | { kind: 'warn'; code: unknown; message: unknown };

export interface VmErrorInfo {
  name: string;
  message: string;
  code?: string;
}

export type WorkerMessage =
  | { t: 'ready' }
  | { t: 'outbox'; items: OutboxItem[] }
  | { t: 'settled'; ok: true; value: unknown; pendingCalls: number }
  | { t: 'settled'; ok: false; error: VmErrorInfo; pendingCalls: number }
  | { t: 'disposed' };

export interface BridgeBudgets {
  heapBytes: number;
  segmentMs: number;
  totalMs: number;
  jobs: number;
}

export interface LoadPayload {
  t: 'load';
  script: string;
  meta: unknown;
  args: unknown;
  budgets: BridgeBudgets;
}

const DEFAULT_WORKER_URL = new URL('./vm-worker.mjs', import.meta.url);

export class VmBridge {
  private worker: Worker;
  private disposed = false;
  private onMessage: ((msg: WorkerMessage) => void) | null = null;
  private onDead: ((error: Error | null) => void) | null = null;

  private constructor(worker: Worker) {
    this.worker = worker;
    worker.on('message', (msg: WorkerMessage) => {
      if (this.disposed) return;
      if (msg.t === 'ready') return;
      this.onMessage?.(msg);
    });
    worker.on('error', (error) => {
      if (this.disposed) return;
      this.onDead?.(error);
    });
    worker.on('exit', (code) => {
      if (this.disposed) return;
      this.onDead?.(code === 0 ? null : new Error(`workflow vm worker exited with code ${code}`));
    });
  }

  static async spawn(workerUrl: URL = DEFAULT_WORKER_URL): Promise<VmBridge> {
    const worker = new Worker(workerUrl);
    const bridge = new VmBridge(worker);
    await new Promise<void>((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error('workflow vm worker did not become ready')), 30_000);
      const onMsg = (msg: WorkerMessage) => {
        if (msg.t === 'ready') {
          clearTimeout(timer);
          worker.off('message', onMsg);
          resolve();
        }
      };
      worker.on('message', onMsg);
      worker.once('error', (error) => {
        clearTimeout(timer);
        worker.off('message', onMsg);
        reject(error);
      });
      worker.once('exit', (code) => {
        clearTimeout(timer);
        worker.off('message', onMsg);
        reject(new Error(`workflow vm worker exited during startup with code ${code}`));
      });
    });
    return bridge;
  }

  setHandlers(handlers: { onMessage: (msg: WorkerMessage) => void; onDead: (error: Error | null) => void }): void {
    this.onMessage = handlers.onMessage;
    this.onDead = handlers.onDead;
  }

  send(msg: LoadPayload | { t: 'deliver'; opId: number; value: unknown } | { t: 'dispose' }): void {
    if (this.disposed) return;
    try {
      this.worker.postMessage(msg);
    } catch {
      // 线程已死时 postMessage 可能抛；桥只负责送达尝试。
    }
  }

  async dispose(): Promise<void> {
    if (this.disposed) return;
    this.disposed = true;
    try {
      this.worker.postMessage({ t: 'dispose' });
    } catch {
      // 线程可能已死
    }
    const exited = new Promise<number>((resolve) => this.worker.once('exit', resolve));
    const graceful = Promise.race([exited.then(() => true), new Promise<false>((r) => setTimeout(() => r(false), 1_000))]);
    if (!(await graceful)) {
      await this.worker.terminate();
    }
  }
}
