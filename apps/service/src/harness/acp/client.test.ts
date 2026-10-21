import { describe, expect, it } from 'vitest';
import { AcpClient, AcpMethodNotFound, AcpProtocolError, AcpRemoteError } from './client';

function make(onRequest: (method: string, params: unknown) => Promise<unknown> = async () => null) {
  const written: Record<string, unknown>[] = [];
  const notifications: [string, unknown][] = [];
  const client = new AcpClient((line) => written.push(JSON.parse(line)), {
    onNotification: (method, params) => notifications.push([method, params]),
    onRequest,
  });
  return { client, written, notifications };
}

describe('AcpClient（W3a）', () => {
  it('按身份配对响应，错误响应转为 AcpRemoteError', async () => {
    const { client, written } = make();
    const first = client.request('a', { x: 1 });
    const second = client.request('b', null);
    expect(written).toEqual([
      { jsonrpc: '2.0', id: 1, method: 'a', params: { x: 1 } },
      { jsonrpc: '2.0', id: 2, method: 'b', params: null },
    ]);
    client.receive(JSON.stringify({ jsonrpc: '2.0', id: 2, error: { code: -32000, message: 'auth required' } }));
    client.receive(JSON.stringify({ jsonrpc: '2.0', id: 1, result: { ok: true } }));
    await expect(first).resolves.toEqual({ ok: true });
    await expect(second).rejects.toBeInstanceOf(AcpRemoteError);
  });
  it('回复 Agent 的请求；未提供的方法回复 -32601', async () => {
    const { client, written } = make(async (method) => {
      if (method === 'known') return { fine: true };
      throw new AcpMethodNotFound(method);
    });
    client.receive(JSON.stringify({ jsonrpc: '2.0', id: 'x', method: 'known', params: {} }));
    client.receive(JSON.stringify({ jsonrpc: '2.0', id: 7, method: 'fs/write_text_file', params: {} }));
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(written).toContainEqual({ jsonrpc: '2.0', id: 'x', result: { fine: true } });
    expect(written).toContainEqual({ jsonrpc: '2.0', id: 7, error: { code: -32601, message: 'Method not found: fs/write_text_file' } });
  });
  it('协议违约抛出 AcpProtocolError：非 JSON、非 JSON-RPC、未知身份、超长行、在途请求过多', async () => {
    const { client } = make();
    expect(() => client.receive('{')).toThrow(AcpProtocolError);
    expect(() => client.receive(JSON.stringify({ id: 1, result: {} }))).toThrow('JSON-RPC 2.0');
    expect(() => client.receive(JSON.stringify({ jsonrpc: '2.0', id: 9, result: {} }))).toThrow('未知请求身份 9');
    expect(() => client.receive('x'.repeat(1048577))).toThrow('协议行超过限制');
    const small = new AcpClient(
      () => undefined,
      { onNotification: () => undefined, onRequest: async () => null },
      { maxLineChars: 100, maxPending: 1 },
    );
    void small.request('a', null).catch(() => undefined);
    await expect(small.request('b', null)).rejects.toThrow('在途请求超过上限');
  });
  it('关闭后拒绝在途请求，不再写出，忽略之后到达的行', async () => {
    const { client, written } = make();
    const pending = client.request('a', null);
    client.close('已关闭');
    await expect(pending).rejects.toThrow('已关闭');
    client.notify('n', null);
    expect(written).toHaveLength(1);
    expect(() => client.receive(JSON.stringify({ jsonrpc: '2.0', id: 1, result: {} }))).not.toThrow();
    expect(() => client.receive('not json')).not.toThrow();
    await expect(client.request('b', null)).rejects.toThrow('已关闭');
  });
});
