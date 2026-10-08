import { EventEmitter } from 'node:events';
import { describe, expect, it, vi } from 'vitest';
import type { RequestOptions } from 'node:https';
import type * as HttpsModule from 'node:https';

const mocks = vi.hoisted(() => ({ lookup: vi.fn(), request: vi.fn() }));
vi.mock('node:dns/promises', () => ({ lookup: mocks.lookup }));
vi.mock('node:https', () => ({ request: mocks.request }));
import { fetchPublicDocument } from './public-document';

describe('真实 HTTPS 适配器边界', () => {
  it('保留 URL 主机和默认 TLS 校验，单 IP lookup 不触发地址族重选，忽略浏览器凭据', async () => {
    mocks.lookup.mockResolvedValue([{ address: '93.184.216.34', family: 4 }]);
    let observedUrl!: URL;
    let observedOptions!: RequestOptions;
    mocks.request.mockImplementation((url: URL, options: RequestOptions, callback: (response: unknown) => void) => {
      observedUrl = url;
      observedOptions = options;
      const request = Object.assign(new EventEmitter(), {
        end: () => {
          const response = Object.assign(new EventEmitter(), {
            statusCode: 200,
            headers: { 'content-type': 'text/html; charset=utf-8' },
            destroy: vi.fn(),
          });
          callback(response);
          response.emit('data', Buffer.from('<title>Network</title><body>Actual adapter</body>'));
          response.emit('end');
        },
      });
      return request;
    });
    expect((await fetchPublicDocument('https://example.com/')).text).toBe('Actual adapter');
    expect(observedUrl.href).toBe('https://example.com/');
    expect(observedOptions).toMatchObject({ family: 4, agent: false, method: 'GET', maxHeaderSize: 16384 });
    expect(observedOptions).toHaveProperty('rejectUnauthorized', true);
    expect(observedOptions).not.toHaveProperty('checkServerIdentity');
    expect(observedOptions.headers).toEqual({
      Accept: 'text/html',
      'Accept-Encoding': 'identity',
      'User-Agent': 'WebStudioLab-ReadonlyDocument/1.0',
    });
    const callback = vi.fn();
    observedOptions.lookup!('example.com', { all: false }, callback);
    expect(callback).toHaveBeenCalledWith(null, '93.184.216.34', 4);
    expect(mocks.lookup).toHaveBeenCalledOnce();
    const realHttps = await vi.importActual<typeof HttpsModule>('node:https');
    let actualLookupOptions: unknown;
    await new Promise<void>((resolve) => {
      const probe = realHttps.request(observedUrl, {
        ...observedOptions,
        lookup: (hostname, options, done) => {
          actualLookupOptions = options;
          // 在 DNS 回调结束连接，不发出 TLS/HTTP 流量；这里核对 Node 实际选择的回调契约。
          observedOptions.lookup!(hostname, options, (error, address, family) => {
            expect(error).toBeNull();
            expect(address).toBe('93.184.216.34');
            expect(family).toBe(4);
            done(new Error('lookup contract probe complete'), '', 4);
          });
        },
      });
      probe.on('error', () => resolve());
      probe.end();
    });
    expect(actualLookupOptions).toMatchObject({ family: 4 });
    expect(actualLookupOptions).not.toMatchObject({ all: true });
  });
});
