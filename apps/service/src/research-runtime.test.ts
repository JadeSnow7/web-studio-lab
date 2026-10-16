import { createHash, randomUUID } from 'node:crypto';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { ResearchCall, ResearchGrant, ResearchReply, ResearchToolResult } from '@wsl/protocol';
import { CodexChat } from './codex-chat';
import type { GuestFrame, GuestOutcome, GuestProcess } from './sbx';
import { emptyReferences } from './reference-test-fixture';
import { validateResearchReply } from './research-runtime';

const sessionId = 'session-research';
const workspaceId = 'research-space';
const refs = emptyReferences(sessionId, workspaceId);
const grant: ResearchGrant = {
  grantId: randomUUID(),
  accountId: refs.accountId,
  workspaceId,
  sessionId,
  taskVersionId: 'task-1',
  runId: 'run-1',
  mode: 'live',
  purpose: 'public-web-research',
  grantedAt: '2026-10-15T00:00:00.000Z',
};
const scope = { workspaceId, sessionId, runId: grant.runId, sources: [] };
let root: string;
let chat: CodexChat;
beforeEach(async () => {
  root = await mkdtemp(path.join(tmpdir(), 'wsl-research-runtime-'));
  vi.stubEnv('WSL_SBX_NAME', 'fixture');
  vi.stubEnv('WSL_SBX_BIN', path.resolve('e2e/fixtures/sbx.mjs'));
  chat = new CodexChat(root, vi.fn());
  chat.register(sessionId, workspaceId);
  await chat.initialize();
});
afterEach(async () => {
  await chat.shutdown();
  vi.restoreAllMocks();
  vi.unstubAllEnvs();
  await rm(root, { recursive: true, force: true });
});
function transport() {
  let emit!: (frame: GuestFrame) => void;
  let settle!: (outcome: GuestOutcome) => void;
  const outcome = { confirmed: true, error: null, exitCode: 0 };
  const write = vi.fn();
  const done = new Promise<GuestOutcome>((resolve) => {
    settle = resolve;
  });
  const start = vi.spyOn(chat.connection, 'start').mockImplementation((_request, handler) => {
    emit = handler;
    return {
      done,
      write,
      close: async () => {
        settle(outcome);
        return outcome;
      },
    } as unknown as GuestProcess;
  });
  const event = (value: unknown) => emit({ type: 'output', stream: 'stdout', data: JSON.stringify(value) + '\n' });
  return {
    start,
    write,
    event,
    call: (tool: string, args: Record<string, unknown>, id = randomUUID()) => {
      emit({ type: 'observation-call', id, tool, args });
      return id;
    },
    finish: () => {
      event({ type: 'thread.started', thread_id: 'research-thread' });
      event({ type: 'item.completed', item: { id: 'answer', type: 'agent_message', text: 'done' } });
      event({ type: 'turn.completed' });
      settle(outcome);
    },
  };
}
const rejection = (call: ResearchCall): ResearchReply => ({
  callId: call.callId,
  context: call.context,
  result: { ok: false, tool: call.tool, error: { code: 'blocked', message: 'fixture public access blocked' } },
});
describe('research runtime ownership and shared limits', () => {
  it.each([
    { resume: false, authorized: false },
    { resume: false, authorized: true },
    { resume: true, authorized: false },
    { resume: true, authorized: true },
  ])('uses exact native-search argv for resume=$resume, authorized=$authorized', async ({ resume, authorized }) => {
    const reader = vi.fn(async (call: ResearchCall) => rejection(call));
    chat.setResearchReader(reader);
    let priorThreadId: string | null = null;
    let priorTurnId: string | null = null;
    if (resume) {
      const prior = transport();
      await chat.send(sessionId, 'earlier research', scope, refs, undefined, undefined, grant);
      priorTurnId = chat.get(sessionId).turnId;
      prior.finish();
      await vi.waitFor(() => {
        expect(chat.get(sessionId).state).toBe('idle');
        expect(chat.get(sessionId).cleanupPending).toBe(false);
      });
      priorThreadId = chat.get(sessionId).threadId;
      expect(priorThreadId).toBe('research-thread');
      prior.start.mockRestore();
    }
    const nextScope = { ...scope, runId: randomUUID() };
    const nextGrant: ResearchGrant = { ...grant, grantId: randomUUID(), runId: nextScope.runId, taskVersionId: 'task-2' };
    const wire = transport();
    await chat.send(sessionId, 'new task', nextScope, refs, undefined, undefined, authorized ? nextGrant : undefined);
    expect(wire.start).toHaveBeenCalledTimes(1);
    const request = wire.start.mock.calls[0]![0];
    if (request.mode !== 'codex') throw new Error('expected Codex start frame');
    expect(request.argv).toEqual([
      'codex',
      'exec',
      '--sandbox',
      'workspace-write',
      '-c',
      authorized ? 'web_search="live"' : 'web_search="disabled"',
      ...(resume ? ['resume', '--json', '--skip-git-repo-check', priorThreadId!, '-'] : ['--json', '--skip-git-repo-check', '-']),
    ]);
    expect(request.observation).toBe(true);
    if (authorized) expect(request.webResearch).toBe(true);
    else expect(request).not.toHaveProperty('webResearch');
    if (resume) expect(chat.get(sessionId).turnId).not.toBe(priorTurnId);
    wire.call('research.open', { url: 'https://example.com/' });
    await vi.waitFor(() => expect(wire.write).toHaveBeenCalledTimes(1));
    if (authorized) {
      expect(reader).toHaveBeenCalledTimes(1);
      expect(reader.mock.calls[0]![0].context).toEqual({
        grant: nextGrant,
        generation: chat.get(sessionId).generation,
        turnId: chat.get(sessionId).turnId,
      });
      expect(wire.write.mock.calls[0]![0]).toMatchObject({ result: { ok: false, error: { code: 'blocked' } } });
    } else {
      expect(reader).not.toHaveBeenCalled();
      expect(wire.write.mock.calls[0]![0]).toMatchObject({ result: { ok: false, error: { code: 'unauthorized' } } });
    }
    wire.finish();
  });
  it('sets live only for the bound grant and explicitly disables resumed subsequent calls', async () => {
    chat.setResearchReader(async (call) => rejection(call));
    const first = transport();
    await chat.send(sessionId, 'research', scope, refs, undefined, undefined, grant);
    expect(first.start.mock.calls[0]?.[0]).toMatchObject({ webResearch: true, observation: true });
    expect(first.start.mock.calls[0]?.[0]).toHaveProperty('argv', expect.arrayContaining(['-c', 'web_search="live"']));
    first.event({ type: 'item.completed', item: { id: 'search', type: 'web_search', query: 'public source' } });
    expect(chat.get(sessionId).nativeSearches).toHaveLength(1);
    first.finish();
    await vi.waitFor(() => expect(chat.get(sessionId).state).toBe('idle'));
    first.start.mockRestore();
    const second = transport();
    await chat.send(sessionId, 'ordinary', { ...scope, runId: randomUUID() }, refs);
    const args = second.start.mock.calls[0]?.[0];
    expect(chat.get(sessionId).nativeSearches).toBeUndefined();
    expect(args).not.toHaveProperty('webResearch');
    expect(args).toHaveProperty('argv', expect.arrayContaining(['resume', 'web_search="disabled"']));
    expect(args).toHaveProperty('argv', expect.not.arrayContaining(['web_search="live"']));
    second.finish();
  });
  it('rejects foreign grants before any process and does not dispatch ungranted tools', async () => {
    const reader = vi.fn(async (call: ResearchCall) => rejection(call));
    chat.setResearchReader(reader);
    const wire = transport();
    await expect(chat.send(sessionId, 'bad', scope, refs, undefined, undefined, { ...grant, accountId: 'other' })).rejects.toThrow('grant');
    expect(wire.start).not.toHaveBeenCalled();
    await chat.send(sessionId, 'ordinary', scope, refs);
    wire.call('research.open', { url: 'https://example.com/' });
    expect(wire.write).toHaveBeenCalledWith(
      expect.objectContaining({
        result: expect.objectContaining({ ok: false, error: { code: 'unauthorized', message: expect.any(String) } }),
      }),
    );
    expect(reader).not.toHaveBeenCalled();
    wire.finish();
  });
  it('injects the live context, rejects foreign replies and shares the 64-call budget', async () => {
    const reader = vi.fn(async (call: ResearchCall) => ({ ...rejection(call), context: { ...call.context, turnId: 'foreign' } }));
    chat.setResearchReader(reader);
    const observer = vi.fn(async () => ({ error: 'unavailable' as const, message: 'fixture source unavailable' }));
    chat.setObservationReader(observer);
    const wire = transport();
    await chat.send(sessionId, 'research', scope, refs, undefined, undefined, grant);
    for (let i = 0; i < 65; i++) {
      if (i % 2 === 0) wire.call('research.open', { url: 'https://example.com/' });
      else wire.call('files.read', { path: 'README.md' });
      await vi.waitFor(() => expect(wire.write).toHaveBeenCalledTimes(i + 1));
    }
    expect(reader).toHaveBeenCalledTimes(32);
    expect(observer).toHaveBeenCalledTimes(32);
    expect(reader.mock.calls[0]![0].context).toEqual({
      grant,
      generation: chat.get(sessionId).generation,
      turnId: chat.get(sessionId).turnId,
    });
    expect(wire.write.mock.calls[0]![0].result.error.code).toBe('unavailable');
    expect(wire.write.mock.lastCall![0].result.error.code).toBe('budget_exceeded');
    wire.finish();
  });
  it('does not start a queued research call after synchronous cancellation', async () => {
    const reader = vi.fn(async (call: ResearchCall) => rejection(call));
    chat.setResearchReader(reader);
    const wire = transport();
    await chat.send(sessionId, 'research', scope, refs, undefined, undefined, grant);
    wire.call('research.open', { url: 'https://example.com/' });
    await chat.cancel(sessionId);
    expect(reader).not.toHaveBeenCalled();
    expect(wire.write).not.toHaveBeenCalled();
  });
  it('limits concurrent research to four and aborts all on cancellation without late results', async () => {
    const signals: AbortSignal[] = [];
    chat.setResearchReader(
      (call, signal) =>
        new Promise((resolve) => {
          signals.push(signal);
          signal.addEventListener('abort', () => resolve(rejection(call)), { once: true });
        }),
    );
    const wire = transport();
    await chat.send(sessionId, 'research', scope, refs, undefined, undefined, grant);
    for (let i = 0; i < 5; i++) wire.call('research.open', { url: 'https://example.com/' });
    await vi.waitFor(() => expect(signals).toHaveLength(4));
    expect(wire.write).toHaveBeenCalledTimes(1);
    await chat.cancel(sessionId);
    expect(signals.every((s) => s.aborted)).toBe(true);
    await Promise.resolve();
    expect(wire.write).toHaveBeenCalledTimes(1);
  });
  it('audits only provider search items, bounds multibyte metadata and marks unsupported schemas', async () => {
    chat.setResearchReader(async (call) => rejection(call));
    const wire = transport();
    await chat.send(sessionId, 'research', scope, refs, undefined, undefined, grant);
    for (let i = 0; i < 40; i++)
      wire.event({ type: 'item.completed', item: { id: 'search-' + i, type: 'web_search', query: '中'.repeat(4000) } });
    wire.event({ type: 'item.completed', item: { id: 'unknown', type: 'web_search_call', action: { query: 'not copied' } } });
    const current = chat.get(sessionId);
    expect(current.nativeSearchesTruncated).toBe(true);
    expect(current.nativeSearches!.length).toBeLessThanOrEqual(32);
    expect(Buffer.byteLength(JSON.stringify(current.nativeSearches))).toBeLessThanOrEqual(65536);
    expect(current.nativeSearches!.at(-1)).toMatchObject({ schemaUnsupported: true });
    expect(current.nativeSearches!.at(-1)).not.toHaveProperty('query');
    wire.finish();
  });
  it('fails closed when native search appears without a run grant', async () => {
    const wire = transport();
    await chat.send(sessionId, 'ordinary', scope, refs);
    wire.event({ type: 'item.started', item: { id: 'search', type: 'web_search', query: 'unexpected' } });
    await vi.waitFor(() => expect(chat.get(sessionId).state).toBe('failed'));
    expect(chat.get(sessionId).error).toContain('without');
  });
  it('keeps exact inclusion metadata but omits text from small and conflicting MCP history records', async () => {
    chat.setResearchReader(async (call) => rejection(call));
    const wire = transport();
    await chat.send(sessionId, 'research', scope, refs, undefined, undefined, grant);
    const text = 'private test source body that must not enter the public conversation';
    const source = {
      captureId: randomUUID(),
      readerResourceId: 'reader',
      requestedUrl: 'https://example.com/',
      url: 'https://example.com/',
      title: 'example',
      capturedAt: '2026-10-15T00:00:00.000Z',
      sourceSha256: 'a'.repeat(64),
      contentSha256: createHash('sha256').update(text).digest('hex'),
      extractionVersion: 'html-text-v1',
      truncated: false,
      textBytes: Buffer.byteLength(text),
      includedAt: '2026-10-15T00:00:00.000Z',
      text,
    };
    const envelope = { untrusted: true, data: { ok: true, tool: 'research.include', source } };
    for (const conflict of [false, true]) {
      wire.event({
        type: 'item.completed',
        item: {
          id: `include-${conflict}`,
          type: 'mcp_tool_call',
          server: 'wsl_space',
          tool: 'research_include',
          status: 'completed',
          arguments: { captureId: source.captureId, contentSha256: source.contentSha256 },
          result: {
            content: [{ type: 'text', text: JSON.stringify(envelope) }],
            structured_content: conflict
              ? { ...envelope, data: { ...envelope.data, source: { ...source, title: 'different' } } }
              : envelope,
          },
        },
      });
    }
    const records = chat.get(sessionId).toolExecutions;
    expect(records).toHaveLength(2);
    expect(JSON.parse(records[0]!.output)).toMatchObject({
      textOmitted: true,
      receipt: { source: { captureId: source.captureId, contentSha256: source.contentSha256 } },
    });
    expect(JSON.parse(records[1]!.output)).toHaveProperty('receiptUnavailable');
    expect(records.every((record) => record.truncated && !record.output.includes(text))).toBe(true);
    for (const [index, malformed] of [{ result: text }, { result: [text] }, { error: { message: text } }].entries()) {
      wire.event({
        type: 'item.completed',
        item: {
          id: `malformed-${index}`,
          type: 'mcp_tool_call',
          server: 'wsl_space',
          tool: 'research_include',
          status: 'failed',
          ...malformed,
        },
      });
    }
    const malformed = chat.get(sessionId).toolExecutions.slice(2);
    expect(malformed).toHaveLength(3);
    expect(
      malformed.every((record) => record.truncated && !record.output.includes(text) && JSON.parse(record.output).receiptUnavailable),
    ).toBe(true);
    wire.finish();
  });
});

it('checks inclusion identity and the exact source text hash', () => {
  const text = 'actual public text';
  const hash = createHash('sha256').update(text).digest('hex');
  const captureId = randomUUID();
  const call: ResearchCall = {
    callId: randomUUID(),
    context: { grant, generation: 'g', turnId: 't' },
    tool: 'research.include',
    args: { captureId, contentSha256: hash },
  };
  const result: ResearchToolResult = {
    ok: true,
    tool: 'research.include',
    source: {
      captureId,
      readerResourceId: 'reader',
      requestedUrl: 'https://example.com/',
      url: 'https://example.com/',
      title: 'example',
      capturedAt: '2026-10-15T00:00:00.000Z',
      sourceSha256: 'a'.repeat(64),
      contentSha256: hash,
      extractionVersion: 'html-text-v1',
      truncated: false,
      textBytes: Buffer.byteLength(text),
      includedAt: '2026-10-15T00:00:00.000Z',
      text,
    },
  };
  expect(validateResearchReply(call, { callId: call.callId, context: call.context, result }).result).toEqual(result);
  expect(() =>
    validateResearchReply(call, {
      callId: call.callId,
      context: call.context,
      result: { ...result, source: { ...result.source, text: 'forged public text' } },
    }),
  ).toThrow('frozen capture');
});
