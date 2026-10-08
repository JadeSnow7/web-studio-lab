import { describe, expect, it, vi } from 'vitest';
import type { Session } from 'electron';
import { extractPublicDocument } from './public-document';
import { PublicDocumentProtocol } from './public-protocol';

function setup(
  fetchDocument = vi.fn(async () =>
    extractPublicDocument(Buffer.from('<title>Public</title><body>Text</body>'), 'https://example.com/', 'https://example.com/'),
  ),
) {
  const session = {
    webRequest: { onBeforeRequest: vi.fn() },
    protocol: { handle: vi.fn(), unhandle: vi.fn() },
    on: vi.fn(),
    removeListener: vi.fn(),
  };
  let epoch = 1;
  const options = {
    allowedOrigins: ['wsl-demo://taskflow'],
    webContentsId: 7,
    devToolsWebContentsId: () => 9,
    epoch: () => epoch,
    onDocument: vi.fn(),
    onError: vi.fn(),
  };
  const protocol = new PublicDocumentProtocol(session as unknown as Session, options, fetchDocument);
  return {
    session,
    options,
    protocol,
    nextNavigation: () => {
      epoch += 1;
      protocol.invalidate();
    },
  };
}

describe('隔离公开文档协议', () => {
  it('源页面和子资源不能绕过 GET 主框架 broker，另一个 webContents 也不能复用', () => {
    const { session } = setup();
    const before = session.webRequest.onBeforeRequest.mock.calls[0]![0] as (
      details: Record<string, unknown>,
      callback: (result: { cancel: boolean }) => void,
    ) => void;
    for (const changed of [
      { resourceType: 'image' },
      { resourceType: 'subFrame' },
      { resourceType: 'webSocket' },
      { method: 'POST' },
      { url: 'file:///etc/passwd' },
      { url: 'http://example.com/' },
      { webContentsId: 8 },
    ]) {
      const callback = vi.fn();
      before({ url: 'https://example.com/', method: 'GET', resourceType: 'mainFrame', webContentsId: 7, ...changed }, callback);
      expect(callback).toHaveBeenCalledWith({ cancel: true });
    }
    const callback = vi.fn();
    before({ url: 'https://example.com/', method: 'GET', resourceType: 'mainFrame', webContentsId: 7 }, callback);
    expect(callback).toHaveBeenCalledWith({ cancel: false });
  });
  it('allows only the owning DevTools bundled GET frontend, never another view or remote resource', () => {
    const { session } = setup();
    const before = session.webRequest.onBeforeRequest.mock.calls[0]![0] as (
      details: Record<string, unknown>,
      callback: (result: { cancel: boolean }) => void,
    ) => void;
    for (const [changed, allowed] of [
      [{}, true],
      [{ webContentsId: 8 }, false],
      [{ webContentsId: 7 }, false],
      [{ method: 'POST' }, false],
      [{ url: 'https://example.com/' }, false],
      [{ url: 'devtools://devtools/other/app.html' }, false],
      [{ url: 'devtools://other/bundled/app.html' }, false],
      [{ url: 'devtools://devtools/bundled/../other/app.html' }, false],
      [{ url: 'devtools://devtools/bundled/%2e%2e/other/app.html' }, false],
    ] as const) {
      const callback = vi.fn();
      before(
        { url: 'devtools://devtools/bundled/devtools_app.html', webContentsId: 9, method: 'GET', resourceType: 'mainFrame', ...changed },
        callback,
      );
      expect(callback).toHaveBeenCalledWith({ cancel: !allowed });
    }
  });
  it('跳转先通知浏览器最终 URL，只有最终 URL 响应才能成为可捕获文档', async () => {
    const document = extractPublicDocument(
      Buffer.from('<title>Final</title><body>Final text</body>'),
      'https://example.com/start',
      'https://example.com/final',
    );
    const fetchDocument = vi.fn(async () => document);
    const { protocol, options } = setup(fetchDocument);
    const first = await protocol.handle(new Request('https://example.com/start'));
    expect(first.status).toBe(302);
    expect(first.headers.get('location')).toBe('https://example.com/final');
    expect(options.onDocument).not.toHaveBeenCalled();
    const final = await protocol.handle(new Request('https://example.com/final'));
    expect(final.status).toBe(200);
    expect(await final.text()).toContain('Final text');
    expect(options.onDocument).toHaveBeenCalledWith(document, 1);
    expect(fetchDocument).toHaveBeenCalledTimes(1);
    expect(final.headers.get('content-security-policy')).toContain("default-src 'none'");
    expect(final.headers.get('content-security-policy')).toContain('sandbox');
  });
  it('导航中的晚到响应不能恢复旧文档', async () => {
    let resolve!: (document: ReturnType<typeof extractPublicDocument>) => void;
    const { protocol, options, nextNavigation } = setup(
      vi.fn(
        () =>
          new Promise((done) => {
            resolve = done;
          }),
      ),
    );
    const loading = protocol.handle(new Request('https://example.com/'));
    nextNavigation();
    resolve(extractPublicDocument(Buffer.from('<body>Old</body>'), 'https://example.com/', 'https://example.com/'));
    expect((await loading).type).toBe('error');
    expect(options.onDocument).not.toHaveBeenCalled();
    expect(options.onError).not.toHaveBeenCalled();
  });
  it('加载失败是网络失败并显示原因；不返回伪造正文，销毁后停止协议', async () => {
    const { protocol, options, session } = setup(
      vi.fn(async () => {
        throw new Error('HTTP 404');
      }),
    );
    const result = await protocol.handle(new Request('https://example.com/'));
    expect(result.type).toBe('error');
    expect(options.onError).toHaveBeenCalledWith(expect.objectContaining({ message: 'HTTP 404' }), 'https://example.com/');
    expect(options.onDocument).not.toHaveBeenCalled();
    protocol.dispose();
    expect(session.protocol.unhandle).toHaveBeenCalledWith('https');
    expect(session.webRequest.onBeforeRequest).toHaveBeenLastCalledWith(null);
  });
});
