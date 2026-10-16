import type { Session } from 'electron';
import { isAllowedPreviewUrl } from './navigation-policy';
import { fetchPublicDocument, parsePublicUrl, READER_HEADERS, renderReaderDocument, type PublicDocument } from './public-document';

interface PublicProtocolOptions {
  allowedOrigins: readonly string[];
  /** Active, identity-verified application lease; never supplied by renderer content. */
  managedAppOrigin?(): string | null;
  webContentsId: number;
  devToolsWebContentsId(): number | undefined;
  epoch(): number;
  request?(): AbortSignal | undefined;
  onDocument(document: PublicDocument, epoch: number, request?: AbortSignal): void;
  onError(error: Error, url: string): void;
}

function isBundledDevToolsUrl(value: string): boolean {
  try {
    const url = new URL(value);
    return (
      url.href === value &&
      url.protocol === 'devtools:' &&
      url.hostname === 'devtools' &&
      !url.port &&
      !url.username &&
      !url.password &&
      url.pathname.startsWith('/bundled/')
    );
  } catch {
    return false;
  }
}

/** 仅 Browser session 使用；远端响应永远不直接交给 Chromium。 */
export class PublicDocumentProtocol {
  private sequence = 0;
  private active: AbortController | null = null;
  private redirected: { epoch: number; document: PublicDocument; request?: AbortSignal } | null = null;
  private readonly pending = new Map<AbortSignal, Set<Promise<void>>>();
  private readonly dispatched = new WeakSet<AbortSignal>();
  private disposed = false;
  private readonly cancelDownload = (event: Electron.Event) => event.preventDefault();

  constructor(
    private readonly session: Session,
    private readonly options: PublicProtocolOptions,
    private readonly fetchDocument = fetchPublicDocument,
  ) {
    try {
      session.webRequest.onBeforeRequest((details, callback) => {
        if (this.disposed) return callback({ cancel: true });
        if (details.webContentsId !== options.webContentsId) {
          // DevTools shares the isolated partition but only its own bundled frontend may bypass the document broker.
          const devTools =
            details.webContentsId === options.devToolsWebContentsId() && details.method === 'GET' && isBundledDevToolsUrl(details.url);
          return callback({ cancel: !devTools });
        }
        const managedOrigin = options.managedAppOrigin?.();
        if (managedOrigin && isAllowedPreviewUrl(details.url, [managedOrigin]) && isAllowedPreviewUrl(details.url, options.allowedOrigins))
          return callback({ cancel: !['GET', 'HEAD', 'POST', 'PUT', 'PATCH', 'DELETE', 'OPTIONS'].includes(details.method) });
        if (isAllowedPreviewUrl(details.url, options.allowedOrigins)) {
          // Bundled demo and fixed trusted reads are permanent; managed application access requires its current lease.
          return callback({ cancel: (!!options.managedAppOrigin && !details.url.startsWith('wsl-demo:')) || details.method !== 'GET' });
        }
        let allowed = details.resourceType === 'mainFrame' && details.method === 'GET';
        try {
          parsePublicUrl(details.url);
        } catch {
          allowed = false;
        }
        callback({ cancel: !allowed });
      });
      session.on('will-download', this.cancelDownload);
      session.protocol.handle('https', (request) => this.handle(request));
    } catch (error) {
      this.dispose();
      throw error;
    }
  }

  invalidate(): void {
    this.sequence += 1;
    this.active?.abort();
    this.active = null;
    this.redirected = null;
  }

  async handle(request: Request): Promise<Response> {
    const owner = this.options.request?.();
    let finish!: () => void;
    const done = new Promise<void>((resolve) => {
      finish = resolve;
    });
    if (owner) {
      const pending = this.pending.get(owner) ?? new Set<Promise<void>>();
      pending.add(done);
      this.pending.set(owner, pending);
    }
    const epoch = this.options.epoch();
    const sequence = ++this.sequence;
    this.active?.abort();
    const controller = new AbortController();
    this.active = controller;
    try {
      if (this.disposed || owner?.aborted || request.method !== 'GET') throw new Error('公开文档请求已拒绝');
      const url = parsePublicUrl(request.url).href;
      const cached = this.redirected;
      this.redirected = null;
      const redirect = cached?.epoch === epoch && cached.request === owner && cached.document.url === url ? cached.document : null;
      if (owner && this.dispatched.has(owner) && !redirect) throw new Error('本次公开文档读取已经派发，不能重复请求');
      if (owner) this.dispatched.add(owner);
      const document =
        redirect ??
        (await this.fetchDocument(
          url,
          undefined,
          AbortSignal.any([controller.signal, AbortSignal.timeout(20000), ...(owner ? [owner] : [])]),
          owner ? (operation) => this.track(owner, operation) : undefined,
        ));
      if (this.disposed || owner?.aborted || sequence !== this.sequence || epoch !== this.options.epoch()) return Response.error();
      if (document.url !== url) {
        this.redirected = { epoch, document, request: owner };
        return new Response(null, { status: 302, headers: { Location: document.url, 'cache-control': 'no-store' } });
      }
      if (owner) this.options.onDocument(document, epoch, owner);
      else this.options.onDocument(document, epoch);
      return new Response(renderReaderDocument(document), { status: 200, headers: READER_HEADERS });
    } catch (error) {
      if (!this.disposed && !owner?.aborted && sequence === this.sequence && epoch === this.options.epoch())
        this.options.onError(error instanceof Error ? error : new Error(String(error)), request.url);
      return Response.error();
    } finally {
      if (sequence === this.sequence) this.active = null;
      finish();
      if (owner) {
        const pending = this.pending.get(owner);
        pending?.delete(done);
        if (!pending?.size) this.pending.delete(owner);
      }
    }
  }

  /** Abort is only a request; callers drain the exact reads before releasing their owner. */
  async settle(request: AbortSignal): Promise<void> {
    for (let pending = this.pending.get(request); pending; pending = this.pending.get(request)) await Promise.allSettled([...pending]);
  }

  private track(owner: AbortSignal, operation: Promise<unknown>): void {
    const settled = operation.then(
      () => undefined,
      () => undefined,
    );
    const pending = this.pending.get(owner) ?? new Set<Promise<void>>();
    pending.add(settled);
    this.pending.set(owner, pending);
    void settled.then(() => {
      pending.delete(settled);
      if (!pending.size && this.pending.get(owner) === pending) this.pending.delete(owner);
    });
  }

  dispose(): void {
    this.disposed = true;
    this.invalidate();
    this.session.protocol.unhandle('https');
    this.session.webRequest.onBeforeRequest(null);
    this.session.removeListener('will-download', this.cancelDownload);
  }
}
