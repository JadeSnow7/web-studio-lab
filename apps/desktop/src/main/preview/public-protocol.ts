import type { Session } from 'electron';
import { isAllowedPreviewUrl } from './navigation-policy';
import { fetchPublicDocument, parsePublicUrl, READER_HEADERS, renderReaderDocument, type PublicDocument } from './public-document';

interface PublicProtocolOptions {
  allowedOrigins: readonly string[];
  webContentsId: number;
  devToolsWebContentsId(): number | undefined;
  epoch(): number;
  onDocument(document: PublicDocument, epoch: number): void;
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
  private redirected: { epoch: number; document: PublicDocument } | null = null;
  private disposed = false;
  private readonly cancelDownload = (event: Electron.Event) => event.preventDefault();

  constructor(
    private readonly session: Session,
    private readonly options: PublicProtocolOptions,
    private readonly fetchDocument = fetchPublicDocument,
  ) {
    try {
      session.webRequest.onBeforeRequest((details, callback) => {
        if (details.webContentsId !== options.webContentsId) {
          // DevTools shares the isolated partition but only its own bundled frontend may bypass the document broker.
          const devTools =
            details.webContentsId === options.devToolsWebContentsId() && details.method === 'GET' && isBundledDevToolsUrl(details.url);
          return callback({ cancel: !devTools });
        }
        if (isAllowedPreviewUrl(details.url, options.allowedOrigins)) return callback({ cancel: details.method !== 'GET' });
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
    const epoch = this.options.epoch();
    const sequence = ++this.sequence;
    this.active?.abort();
    const controller = new AbortController();
    this.active = controller;
    try {
      if (this.disposed || request.method !== 'GET') throw new Error('公开文档请求已拒绝');
      const url = parsePublicUrl(request.url).href;
      const cached = this.redirected;
      this.redirected = null;
      const document =
        cached?.epoch === epoch && cached.document.url === url
          ? cached.document
          : await this.fetchDocument(url, undefined, AbortSignal.any([controller.signal, AbortSignal.timeout(20000)]));
      if (this.disposed || sequence !== this.sequence || epoch !== this.options.epoch()) return Response.error();
      if (document.url !== url) {
        this.redirected = { epoch, document };
        return new Response(null, { status: 302, headers: { Location: document.url, 'cache-control': 'no-store' } });
      }
      this.options.onDocument(document, epoch);
      return new Response(renderReaderDocument(document), { status: 200, headers: READER_HEADERS });
    } catch (error) {
      if (!this.disposed && sequence === this.sequence && epoch === this.options.epoch())
        this.options.onError(error instanceof Error ? error : new Error(String(error)), request.url);
      return Response.error();
    } finally {
      if (sequence === this.sequence) this.active = null;
    }
  }

  dispose(): void {
    this.disposed = true;
    this.invalidate();
    this.session.protocol.unhandle('https');
    this.session.webRequest.onBeforeRequest(null);
    this.session.removeListener('will-download', this.cancelDownload);
  }
}
