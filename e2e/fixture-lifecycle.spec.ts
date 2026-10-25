import { createConnection, Socket } from 'node:net';
import { expect, test } from '@playwright/test';
import { fullBrowserServer } from './fixtures/full-browser-server';
import { launchApp } from './helpers';

// Capture the actual fixture upgrade socket without changing its write result or introducing a fake transport.
async function upgradeSocket() {
  const server = await fullBrowserServer();
  const write = Socket.prototype.write;
  const captured: Socket[] = [];
  let report: () => void = () => {
    throw new Error('missing upgrade gate');
  };
  const upgraded = new Promise<void>((resolve) => {
    report = resolve;
  });
  Socket.prototype.write = function (
    data: string | Uint8Array,
    encodingOrCallback?: BufferEncoding | ((error?: Error | null) => void),
    callback?: (error?: Error | null) => void,
  ) {
    if (typeof data === 'string' && data.startsWith('HTTP/1.1 101 Switching Protocols')) {
      captured.push(this);
      report();
    }
    return Reflect.apply(write, this, [data, encodingOrCallback, callback]) as boolean;
  };
  const client = createConnection({ host: '127.0.0.1', port: Number(new URL(server.url).port) });
  try {
    await new Promise<void>((resolve, reject) => {
      client.once('connect', resolve);
      client.once('error', reject);
    });
    client.write(
      'GET /ws HTTP/1.1\r\nHost: localhost\r\nConnection: Upgrade\r\nUpgrade: websocket\r\nSec-WebSocket-Key: dGhlIHNhbXBsZSBub25jZQ==\r\n\r\n',
    );
    await upgraded;
    const socket = captured[0];
    if (!socket) throw new Error('missing real fixture socket');
    return { server, client, socket };
  } catch (error) {
    client.destroy();
    await server.close();
    throw error;
  } finally {
    Socket.prototype.write = write;
  }
}

for (const [code, syscall] of [
  ['EPIPE', 'write'],
  ['ECONNRESET', 'read'],
]) {
  test(`fixture records a recognized peer disconnect ${code} without an unhandled socket error`, async () => {
    const { server, client, socket } = await upgradeSocket();
    try {
      const error = Object.assign(new Error(`injected peer ${code}`), { code, syscall });
      expect(() => socket.emit('error', error)).not.toThrow();
      expect(server).toHaveProperty('disconnects', expect.arrayContaining([expect.objectContaining({ code, syscall })]));
    } finally {
      client.destroy();
      await server.close();
    }
  });
}

test('fixture unknown socket errors remain failures at close', async () => {
  const { server, client, socket } = await upgradeSocket();
  let closeAttempted = false;
  try {
    const error = Object.assign(new Error('injected unknown fixture socket failure'), { code: 'EUNEXPECTED', syscall: 'write' });
    expect(() => socket.emit('error', error)).not.toThrow();
    client.destroy();
    closeAttempted = true;
    await expect(server.close()).rejects.toThrow('injected unknown fixture socket failure');
  } finally {
    client.destroy();
    if (!closeAttempted) await server.close();
  }
});

for (const lateError of [false, true]) {
  test(`helper close after explicit window shutdown ${lateError ? 'preserves a late renderer error' : 'succeeds with no renderer errors'}`, async () => {
    const { app, page } = await launchApp();
    let closeAttempted = false;
    try {
      if (lateError) {
        await page.evaluate(() => {
          console.error('LATE_RENDERER_LIFECYCLE_NONCE');
        });
        await expect
          .poll(() =>
            app.evaluate(() =>
              (globalThis as unknown as { __wslRendererErrors: string[] }).__wslRendererErrors.some((message) =>
                message.includes('LATE_RENDERER_LIFECYCLE_NONCE'),
              ),
            ),
          )
          .toBe(true);
      }
      const closed = page.waitForEvent('close');
      await app.evaluate(({ BrowserWindow }) => {
        BrowserWindow.getAllWindows()[0]?.close();
      });
      await closed;
      closeAttempted = true;
      if (lateError) await expect(app.close()).rejects.toThrow('LATE_RENDERER_LIFECYCLE_NONCE');
      else await app.close();
    } finally {
      if (!closeAttempted) await app.close();
    }
  });
}

test('helper startup renderer failures remain visible', async () => {
  const { app } = await launchApp({ startupError: 'STARTUP_RENDERER_LIFECYCLE_NONCE' });
  await expect(app.close()).rejects.toThrow('STARTUP_RENDERER_LIFECYCLE_NONCE');
});
