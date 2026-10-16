import { describe, expect, it, vi } from 'vitest';
import type { Session } from 'electron';
import { extractPublicDocument, fetchPublicDocument, type PublicFetchDependencies } from './public-document';
import { PublicDocumentProtocol } from './public-protocol';

function setup(
  fetchDocument: typeof fetchPublicDocument = vi.fn(async () =>
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
    request: (): AbortSignal | undefined => undefined,
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
  it('does not begin DNS or HTTPS work for an already cancelled read', async () => {
    const owner = new AbortController();
    owner.abort();
    const dependencies: PublicFetchDependencies = {
      resolve: vi.fn(async () => [{ address: '93.184.216.34', family: 4 }]),
      request: vi.fn(async () => ({ status: 200, headers: { 'content-type': 'text/html' }, body: Buffer.from('<body>text</body>') })),
    };
    await expect(fetchPublicDocument('https://example.com/', dependencies, owner.signal)).rejects.toThrow();
    expect(dependencies.resolve).not.toHaveBeenCalled();
    expect(dependencies.request).not.toHaveBeenCalled();
  });
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
          new Promise<ReturnType<typeof extractPublicDocument>>((done) => {
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
  it('waits for an aborted owner read to settle, discards its bytes, and prevents a late dispatch with that token', async () => {
    let resolve!: (value: ReturnType<typeof extractPublicDocument>) => void;
    const fetchDocument = vi.fn(
      () =>
        new Promise<ReturnType<typeof extractPublicDocument>>((done) => {
          resolve = done;
        }),
    );
    const { protocol, options } = setup(fetchDocument);
    const owner = new AbortController();
    options.request = () => owner.signal;
    const response = protocol.handle(new Request('https://example.com/'));
    owner.abort();
    const settled = vi.fn();
    const draining = protocol.settle(owner.signal).then(settled);
    await Promise.resolve();
    expect(settled).not.toHaveBeenCalled();
    resolve(extractPublicDocument(Buffer.from('<body>Late</body>'), 'https://example.com/', 'https://example.com/'));
    expect((await response).type).toBe('error');
    await draining;
    expect(settled).toHaveBeenCalledOnce();
    expect(options.onDocument).not.toHaveBeenCalled();
    expect((await protocol.handle(new Request('https://example.com/'))).type).toBe('error');
    expect(fetchDocument).toHaveBeenCalledOnce();
  });
  it('settles only the requested owner and does not abort or wait for a newer navigation', async () => {
    let resolve!: (value: ReturnType<typeof extractPublicDocument>) => void;
    const { protocol, options } = setup(
      vi.fn(
        () =>
          new Promise<ReturnType<typeof extractPublicDocument>>((done) => {
            resolve = done;
          }),
      ),
    );
    const old = new AbortController();
    const current = new AbortController();
    options.request = () => current.signal;
    const response = protocol.handle(new Request('https://example.com/'));
    old.abort();
    await protocol.settle(old.signal);
    expect(current.signal.aborted).toBe(false);
    const document = extractPublicDocument(Buffer.from('<body>Current</body>'), 'https://example.com/', 'https://example.com/');
    resolve(document);
    expect((await response).status).toBe(200);
    expect(options.onDocument).toHaveBeenCalledWith(document, 1, current.signal);
  });
  it('does not reuse a redirect response under a different request token', async () => {
    const document = extractPublicDocument(Buffer.from('<body>Redirect</body>'), 'https://example.com/start', 'https://example.com/final');
    const fetchDocument = vi.fn(async () => document);
    const { protocol, options } = setup(fetchDocument);
    const first = new AbortController();
    options.request = () => first.signal;
    expect((await protocol.handle(new Request(document.requestedUrl))).status).toBe(302);
    const next = new AbortController();
    options.request = () => next.signal;
    await protocol.handle(new Request(document.url));
    expect(fetchDocument).toHaveBeenCalledTimes(2);
    expect(options.onDocument).toHaveBeenCalledWith(document, 1, next.signal);
  });
  it('does not issue a second network read for the same owned request', async () => {
    const fetchDocument = vi.fn(async () =>
      extractPublicDocument(Buffer.from('<body>Once</body>'), 'https://example.com/', 'https://example.com/'),
    );
    const { protocol, options } = setup(fetchDocument);
    const owner = new AbortController();
    options.request = () => owner.signal;
    expect((await protocol.handle(new Request('https://example.com/'))).status).toBe(200);
    expect((await protocol.handle(new Request('https://example.com/'))).type).toBe('error');
    expect(fetchDocument).toHaveBeenCalledOnce();
    expect(options.onDocument).toHaveBeenCalledOnce();
  });
  it.each(['DNS', 'HTTPS'] as const)('drains the actual %s promise after abortable has already rejected', async (stage) => {
    let releaseDns!: (addresses: Awaited<ReturnType<PublicFetchDependencies['resolve']>>) => void;
    let releaseRequest!: (response: Awaited<ReturnType<PublicFetchDependencies['request']>>) => void;
    const addresses = [{ address: '93.184.216.34', family: 4 }];
    const dependencies: PublicFetchDependencies = {
      resolve: vi.fn(() =>
        stage === 'DNS'
          ? new Promise<Awaited<ReturnType<PublicFetchDependencies['resolve']>>>((done) => {
              releaseDns = done;
            })
          : Promise.resolve(addresses),
      ),
      request: vi.fn(
        () =>
          new Promise<Awaited<ReturnType<PublicFetchDependencies['request']>>>((done) => {
            releaseRequest = done;
          }),
      ),
    };
    const fetch = vi.fn<typeof fetchPublicDocument>((input, _dependencies, signal, onPending) =>
      fetchPublicDocument(input, dependencies, signal, onPending),
    );
    const { protocol, options } = setup(fetch);
    const owner = new AbortController();
    options.request = () => owner.signal;
    const response = protocol.handle(new Request('https://example.com/'));
    await vi.waitFor(() => expect(stage === 'DNS' ? dependencies.resolve : dependencies.request).toHaveBeenCalledOnce());
    owner.abort();
    expect((await response).type).toBe('error');
    const settled = vi.fn();
    const draining = protocol.settle(owner.signal).then(settled);
    await Promise.resolve();
    expect(settled).not.toHaveBeenCalled();
    if (stage === 'DNS') releaseDns(addresses);
    else releaseRequest({ status: 200, headers: { 'content-type': 'text/html' }, body: Buffer.from('<body>Late</body>') });
    await draining;
    expect(settled).toHaveBeenCalledOnce();
    expect(options.onDocument).not.toHaveBeenCalled();
    if (stage === 'DNS') expect(dependencies.request).not.toHaveBeenCalled();
  });
});

describe('managed app write capability', () => {
  it('preserves read-only GET for a fixed trusted origin without a revocable lease provider', () => {
    const { session, protocol, options } = setup();
    options.allowedOrigins.push('http://127.0.0.1:49152');
    const before = session.webRequest.onBeforeRequest.mock.calls[0]![0] as (
      details: Record<string, unknown>,
      callback: (result: { cancel: boolean }) => void,
    ) => void;
    for (const method of ['GET', 'POST']) {
      const callback = vi.fn();
      before({ url: 'http://127.0.0.1:49152/api', method, resourceType: 'xhr', webContentsId: 7 }, callback);
      expect(callback).toHaveBeenCalledWith({ cancel: method !== 'GET' });
    }
    protocol.dispose();
  });
  it('requires an active exact-origin lease and owning webContents; public and demo POST remain denied', () => {
    const session = {
      webRequest: { onBeforeRequest: vi.fn() },
      protocol: { handle: vi.fn(), unhandle: vi.fn() },
      on: vi.fn(),
      removeListener: vi.fn(),
    };
    let lease: string | null = 'http://127.0.0.1:49152';
    const protocol = new PublicDocumentProtocol(session as unknown as Session, {
      allowedOrigins: ['http://127.0.0.1:49152', 'wsl-demo://taskflow'],
      managedAppOrigin: () => lease,
      webContentsId: 7,
      devToolsWebContentsId: () => 9,
      epoch: () => 0,
      onDocument: vi.fn(),
      onError: vi.fn(),
    });
    const before = session.webRequest.onBeforeRequest.mock.calls[0]![0] as (
      details: Record<string, unknown>,
      callback: (result: { cancel: boolean }) => void,
    ) => void;
    const check = (changed: Record<string, unknown>, cancel: boolean) => {
      const callback = vi.fn();
      before({ url: 'http://127.0.0.1:49152/api/kv/test', method: 'POST', resourceType: 'xhr', webContentsId: 7, ...changed }, callback);
      expect(callback).toHaveBeenCalledWith({ cancel });
    };
    for (const method of ['GET', 'HEAD', 'POST', 'PUT', 'PATCH', 'DELETE', 'OPTIONS']) check({ method }, false);
    for (const changed of [
      { webContentsId: 8 },
      { url: 'http://127.0.0.1:49153/api/kv/test' },
      { url: 'https://example.com/api' },
      { url: 'wsl-demo://taskflow/api' },
      { method: 'CONNECT' },
    ])
      check(changed, true);
    for (const replacement of [null, 'http://127.0.0.1:49153']) {
      lease = replacement;
      for (const method of ['GET', 'HEAD', 'POST', 'PUT', 'PATCH', 'DELETE', 'OPTIONS'])
        for (const resourceType of ['mainFrame', 'subFrame', 'xhr', 'image', 'script']) check({ method, resourceType }, true);
      check({ url: 'wsl-demo://taskflow/index.html', method: 'GET', resourceType: 'mainFrame' }, false);
    }
    protocol.dispose();
    check({ method: 'GET' }, true);
  });
});
