import { EventEmitter } from 'node:events';
import { describe, expect, it, vi } from 'vitest';
import type { Session } from 'electron';
import { acquireBrowserSession } from './browser-session';
function fixture() {
  const session = Object.assign(new EventEmitter(), { webRequest: { onBeforeRequest: vi.fn() } });
  return session;
}
describe('native browser session ownership', () => {
  it('shares a single listener, permits native web semantics and releases only the final owner', () => {
    const session = fixture();
    const releaseA = acquireBrowserSession(session as unknown as Session, 7, { allowedOrigins: [], devToolsWebContentsId: () => 9 });
    const releaseB = acquireBrowserSession(session as unknown as Session, 8, {
      allowedOrigins: [],
      devToolsWebContentsId: () => undefined,
    });
    expect(session.webRequest.onBeforeRequest).toHaveBeenCalledTimes(1);
    const before = session.webRequest.onBeforeRequest.mock.calls[0]![0];
    const check = (url: string, id: number, method = 'GET') => {
      const callback = vi.fn();
      before({ url, webContentsId: id, method }, callback);
      return callback.mock.calls[0]![0].cancel;
    };
    for (const url of [
      'http://localhost:3210/',
      'https://example.com/',
      'wss://example.com/ws',
      'blob:https://example.com/id',
      'data:image/png,',
    ])
      expect(check(url, 7, 'POST')).toBe(false);
    for (const url of ['file:///etc/passwd', 'javascript:alert(1)', 'custom://app']) expect(check(url, 7)).toBe(true);
    expect(check('https://example.com/', 99)).toBe(true);
    expect(check('https://example.com/worker-fetch', -1, 'POST')).toBe(false);
    expect(check('devtools://devtools/bundled/devtools_app.html', 9)).toBe(false);
    expect(check('https://example.com/', 9)).toBe(true);
    releaseA();
    expect(check('https://example.com/', 7)).toBe(true);
    expect(check('https://example.com/', 8)).toBe(false);
    expect(session.webRequest.onBeforeRequest).toHaveBeenCalledTimes(1);
    const preventDefault = vi.fn();
    session.emit('will-download', { preventDefault });
    expect(preventDefault).toHaveBeenCalledOnce();
    releaseB();
    expect(session.webRequest.onBeforeRequest).toHaveBeenLastCalledWith(null);
    expect(session.listenerCount('will-download')).toBe(0);
  });
  it('managed App requests require the current exact-origin lease', () => {
    const session = fixture();
    let lease: string | null = 'http://127.0.0.1:3210';
    acquireBrowserSession(session as unknown as Session, 7, {
      allowedOrigins: ['http://127.0.0.1:3210'],
      managedAppOrigin: () => lease,
      devToolsWebContentsId: () => undefined,
    });
    const before = session.webRequest.onBeforeRequest.mock.calls[0]![0];
    for (const [url, cancel] of [
      ['http://127.0.0.1:3210/api', false],
      ['https://example.com/', true],
      ['http://127.0.0.1:3211/', true],
    ] as const) {
      const callback = vi.fn();
      before({ url, webContentsId: 7, method: 'POST' }, callback);
      expect(callback).toHaveBeenCalledWith({ cancel });
    }
    lease = null;
    const callback = vi.fn();
    before({ url: 'http://127.0.0.1:3210/api', webContentsId: 7 }, callback);
    expect(callback).toHaveBeenCalledWith({ cancel: true });
  });
});
