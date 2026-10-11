import { z } from 'zod';
import type { AppIdentity, Task } from './contracts.js';
import { observationSchema } from './contracts.js';
import { observationExpression } from './postcondition.js';

const REQUEST_TIMEOUT_MS = 10_000;
export function loopbackUrl(value: string, protocol: 'http:' | 'ws:'): URL {
  const url = new URL(value);
  if (url.protocol !== protocol || !['127.0.0.1', '[::1]', 'localhost'].includes(url.hostname) || url.username || url.password || url.hash) {
    throw new Error('CDP and preview URLs must be unauthenticated loopback URLs');
  }
  return url;
}
export function timeout<T>(promise: Promise<T>, ms: number, label: string, signal?: AbortSignal): Promise<T> {
  return new Promise((resolve, reject) => {
    let timer: ReturnType<typeof setTimeout>;
    const release = () => { clearTimeout(timer); signal?.removeEventListener('abort', abort); };
    const succeed = (value: T) => { release(); resolve(value); };
    const fail = (error: unknown) => { release(); reject(error); };
    const abort = () => fail(new Error(`${label} aborted: ${String(signal?.reason)}`));
    timer = setTimeout(() => fail(new Error(`${label} timed out after ${ms}ms`)), ms);
    signal?.addEventListener('abort', abort, { once: true });
    if (signal?.aborted) abort();
    promise.then(succeed, fail);
  });
}
const versionSchema = z.object({ Browser: z.string(), 'User-Agent': z.string(), webSocketDebuggerUrl: z.url() });
const targetSchema = z.object({ id: z.string(), type: z.string(), url: z.string(), webSocketDebuggerUrl: z.url().optional() });
const messageSchema = z.union([
  z.object({ id: z.number().int(), result: z.unknown().optional(), error: z.object({ code: z.number(), message: z.string(), data: z.unknown().optional() }).optional() }),
  z.object({ method: z.string(), params: z.unknown().optional() }),
]);
export class CdpConnection {
  private seq = 0;
  private pending = new Map<number, { resolve(value: unknown): void; reject(error: Error): void }>();
  readonly exceptions: unknown[] = [];
  private notifications = new Map<string, Set<{ resolve(value: unknown): void; reject(error: Error): void }>>();
  private constructor(private socket: WebSocket, private record: (entry: unknown) => void) {
    socket.addEventListener('message', event => {
      try {
        const raw: unknown = JSON.parse(String(event.data));
        record({ direction: 'received', message: raw });
        const message = messageSchema.parse(raw);
        if ('id' in message) {
          const pending = this.pending.get(message.id);
          if (!pending) throw new Error(`Unmatched CDP response ${message.id}`);
          this.pending.delete(message.id);
          if (message.error) pending.reject(new Error(`CDP ${message.error.code}: ${message.error.message}`));
          else pending.resolve(message.result);
        } else {
          if (message.method === 'Runtime.exceptionThrown') this.exceptions.push(message.params);
          for (const waiter of this.notifications.get(message.method) ?? []) waiter.resolve(message.params);
        }
      } catch (error) { this.fail(error instanceof Error ? error : new Error(String(error))); }
    });
    socket.addEventListener('error', () => this.fail(new Error('CDP WebSocket error')));
    socket.addEventListener('close', () => {
      if (this.pending.size) this.fail(new Error('CDP disconnected with pending requests'));
    });
  }
  private failure: Error | undefined;
  private fail(error: Error) {
    this.failure = error;
    this.record({ direction: 'transport-error', error: error.message });
    for (const pending of this.pending.values()) pending.reject(error);
    this.pending.clear();
    for (const waiters of this.notifications.values()) for (const waiter of waiters) waiter.reject(error);
    this.notifications.clear();
  }
  static async connect(identity: AppIdentity, record: (entry: unknown) => void, signal: AbortSignal) {
    const endpoint = loopbackUrl(identity.cdpEndpoint, 'http:');
    if (endpoint.pathname !== '/' || endpoint.search) throw new Error('CDP endpoint must be the HTTP origin');
    const preview = loopbackUrl(identity.previewUrl, 'http:');
    if (!preview.searchParams.get('runId')) throw new Error('Preview URL has no runId');
    async function get(path: string) {
      const url = new URL(path, endpoint).href;
      record({ direction: 'http-request', url });
      const response = await fetch(url, { signal: AbortSignal.any([signal, AbortSignal.timeout(REQUEST_TIMEOUT_MS)]), redirect: 'error' });
      if (!response.ok) throw new Error(`CDP discovery HTTP ${response.status}`);
      const raw: unknown = await response.json();
      record({ direction: 'http-response', url, status: response.status, body: raw });
      return raw;
    }
    const version = versionSchema.parse(await get('/json/version'));
    if (!/\bElectron\//.test(version['User-Agent'])) throw new Error('CDP User-Agent does not identify Electron');
    loopbackUrl(version.webSocketDebuggerUrl, 'ws:');
    const targets = z.array(targetSchema).parse(await get('/json/list'));
    const matching = targets.filter(target => target.id === identity.targetId && target.type === 'page');
    if (matching.length !== 1 || matching[0].url !== 'about:blank' || !matching[0].webSocketDebuggerUrl) {
      throw new Error('Expected unique about:blank page target is missing');
    }
    const wsUrl = loopbackUrl(matching[0].webSocketDebuggerUrl, 'ws:');
    if (wsUrl.hostname !== endpoint.hostname || wsUrl.port !== endpoint.port) throw new Error('Target WebSocket points to a different CDP server');
    const socket = new WebSocket(wsUrl);
    const connection = new CdpConnection(socket, record);
    try {
      await timeout(new Promise<void>((resolve, reject) => {
        socket.addEventListener('open', () => resolve(), { once: true });
        socket.addEventListener('error', () => reject(new Error('Cannot connect CDP WebSocket')), { once: true });
      }), REQUEST_TIMEOUT_MS, 'CDP connection', signal);
      return connection;
    } catch (error) { socket.close(); throw error; }
  }
  async request(method: string, params: Record<string, unknown> = {}, signal?: AbortSignal): Promise<unknown> {
    if (this.failure) throw this.failure;
    const id = ++this.seq;
    const message = { id, method, params };
    this.record({ direction: 'sent', message });
    try {
      return await timeout(new Promise((resolve, reject) => {
        this.pending.set(id, { resolve, reject });
        this.socket.send(JSON.stringify(message));
      }), REQUEST_TIMEOUT_MS, `CDP ${method}`, signal);
    } catch (error) {
      this.pending.delete(id);
      throw error;
    }
  }
  private waitForNotification(method: string, signal: AbortSignal): Promise<unknown> {
    const waiters = this.notifications.get(method) ?? new Set();
    this.notifications.set(method, waiters);
    let waiter: { resolve(value: unknown): void; reject(error: Error): void };
    const result = new Promise<unknown>((resolve, reject) => { waiter = { resolve, reject }; waiters.add(waiter); });
    return timeout(result, REQUEST_TIMEOUT_MS, `CDP notification ${method}`, signal).finally(() => waiters.delete(waiter));
  }
  async navigateAndObserve(task: Task, identity: AppIdentity, signal: AbortSignal) {
    if (new URL(identity.previewUrl).searchParams.get('runId') !== task.runId) throw new Error('Preview belongs to another run');
    await this.request('Runtime.enable', {}, signal);
    await this.request('Page.enable', {}, signal);
    // Arm the load notification before navigation to avoid evaluating a destroyed context.
    const loaded = this.waitForNotification('Page.loadEventFired', signal);
    const [navigationResult] = await Promise.all([this.request('Page.navigate', { url: identity.previewUrl }, signal), loaded]);
    const navigation = z.object({ frameId: z.string(), errorText: z.string().optional() }).parse(navigationResult);
    if (navigation.errorText) throw new Error(`Page navigation failed: ${navigation.errorText}`);
    const deadline = Date.now() + REQUEST_TIMEOUT_MS;
    while (true) {
      const result = z.object({ result: z.object({ type: z.string(), value: z.string().optional() }), exceptionDetails: z.unknown().optional() })
        .parse(await this.request('Runtime.evaluate', { expression: observationExpression(task), returnByValue: true }, signal));
      if (result.exceptionDetails) throw new Error('Runtime.evaluate returned exceptionDetails');
      if (result.result.type !== 'string' || result.result.value === undefined) throw new Error('DOM evaluation did not return JSON');
      const observation = observationSchema.parse(JSON.parse(result.result.value));
      if (observation.readyState === 'complete' && observation.url === identity.previewUrl) return observation;
      if (Date.now() >= deadline) throw new Error('Page did not become ready within 10s');
      await timeout(new Promise<void>(resolve => setTimeout(resolve, 100)), 1000, 'DOM readiness pause', signal);
    }
  }
  async screenshot(signal: AbortSignal): Promise<Buffer> {
    const result = z.object({ data: z.string().min(1).regex(/^[A-Za-z0-9+/]+={0,2}$/) }).parse(await this.request('Page.captureScreenshot', { format: 'png' }, signal));
    const bytes = Buffer.from(result.data, 'base64');
    if (bytes.length <= 8 || !bytes.subarray(0, 8).equals(Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]))) throw new Error('CDP screenshot is not PNG');
    return bytes;
  }
  async close(): Promise<void> {
    if (this.socket.readyState === WebSocket.CLOSED) return;
    await timeout(new Promise<void>(resolve => {
      this.socket.addEventListener('close', () => resolve(), { once: true });
      this.socket.close();
    }), REQUEST_TIMEOUT_MS, 'CDP close');
  }
}
