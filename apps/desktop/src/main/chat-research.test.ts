import { randomUUID } from 'node:crypto';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { ResearchCall, ResearchReply } from '@wsl/protocol';
const transport = vi.hoisted(() => ({ message: undefined as ((value: unknown) => void) | undefined, postMessage: vi.fn(), kill: vi.fn() }));
vi.mock('electron', () => ({
  app: { isPackaged: false, getAppPath: () => '/desktop', getPath: () => '/data' },
  utilityProcess: {
    fork: () => ({
      once: vi.fn(),
      kill: transport.kill,
      postMessage: transport.postMessage,
      on: (event: string, callback: (value: unknown) => void) => {
        if (event === 'message') {
          transport.message = callback;
          callback({
            type: 'initialized',
            status: { available: true, reason: null, version: 'fixture', sandbox: 'fixture', cwd: '/guest' },
            cleanupPending: false,
          });
        }
      },
    }),
  },
}));
import { ChatService } from './chat-service';
beforeEach(() => {
  transport.postMessage.mockReset();
  transport.kill.mockReset();
});
const call = (): ResearchCall => ({
  callId: randomUUID(),
  context: {
    grant: {
      grantId: randomUUID(),
      accountId: 'a',
      workspaceId: 'w',
      sessionId: 'session-test',
      taskVersionId: 'v',
      runId: 'r',
      mode: 'live',
      purpose: 'public-web-research',
      grantedAt: new Date().toISOString(),
    },
    generation: 'g',
    turnId: 't',
  },
  tool: 'research.open',
  args: { url: 'https://www.wikipedia.org/' },
});
const reply = (request: ResearchCall): ResearchReply => ({
  callId: request.callId,
  context: request.context,
  result: { ok: false, tool: request.tool, error: { code: 'blocked', message: 'HTTP 403' } },
});
async function returned() {
  await vi.waitFor(() => expect(transport.postMessage.mock.calls.some(([request]) => request.method === 'research.reply')).toBe(true));
  const request = transport.postMessage.mock.calls.find(([request]) => request.method === 'research.reply')![0];
  transport.message!({ type: 'response', id: request.id, result: null });
  await Promise.resolve();
  return request.payload as ResearchReply;
}
describe('research dedicated Main bridge', () => {
  it('passes the exact context and returns only its matching reply', async () => {
    const service = new ChatService(vi.fn(), vi.fn()),
      request = call();
    const read = vi.fn(async (input: ResearchCall) => reply(input));
    service.setResearchReader(read);
    transport.message!({ type: 'research-call', ...request });
    expect(await returned()).toEqual(reply(request));
    expect(read.mock.calls[0]![0]).toEqual(request);
  });
  it('does not forward a foreign reply as an authorized source', async () => {
    const service = new ChatService(vi.fn(), vi.fn()),
      request = call();
    service.setResearchReader(async () => ({ ...reply(request), context: { ...request.context, turnId: 'foreign' } }));
    transport.message!({ type: 'research-call', ...request });
    expect(await returned()).toMatchObject({
      context: request.context,
      result: { ok: false, error: { code: 'unavailable', message: '研究回执归属不匹配' } },
    });
  });
  it('aborts the exact call without fabricating a reply before the reader settles', async () => {
    const service = new ChatService(vi.fn(), vi.fn()),
      request = call();
    let signal!: AbortSignal, finish!: (value: ResearchReply) => void;
    service.setResearchReader((_request, current) => {
      signal = current;
      return new Promise((resolve) => {
        finish = resolve;
      });
    });
    transport.message!({ type: 'research-call', ...request });
    await vi.waitFor(() => expect(signal).toBeDefined());
    transport.message!({ type: 'research-abort', callId: request.callId });
    expect(signal.aborted).toBe(true);
    expect(transport.postMessage.mock.calls.some(([request]) => request.method === 'research.reply')).toBe(false);
    finish(reply(request));
    expect(await returned()).toMatchObject({ result: { ok: false, error: { code: 'cancelled' } } });
  });
  it('reports an unavailable Main reader without executing another capability', async () => {
    new ChatService(vi.fn(), vi.fn());
    transport.message!({ type: 'research-call', ...call() });
    expect(await returned()).toMatchObject({ result: { ok: false, error: { code: 'unavailable' } } });
  });
});
