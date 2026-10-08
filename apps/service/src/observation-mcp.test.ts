import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { afterEach, beforeEach, describe, it, expect, vi } from 'vitest';
import { CodexChat, boundedObservationReply } from './codex-chat';
import type { ObservationTurnScope } from '@wsl/protocol';
let chat: CodexChat;
let root: string;
const scope: ObservationTurnScope = { workspaceId: 'space-a', sessionId: 'session-a', runId: 'run-a', sources: [] };
beforeEach(async () => {
  root = await mkdtemp(path.join(tmpdir(), 'wsl-observation-mcp-'));
  vi.stubEnv('WSL_SBX_NAME', 'fixture');
  vi.stubEnv('WSL_SBX_BIN', path.resolve('apps/service/src/fixtures/observation-sbx.mjs'));
  chat = new CodexChat(root, vi.fn());
  await chat.initialize();
  chat.register(scope.sessionId, scope.workspaceId);
});
afterEach(async () => {
  await chat.shutdown();
  await rm(root, { recursive: true, force: true });
  vi.unstubAllEnvs();
});
describe('per-turn observation MCP host', () => {
  it('binds real session/run identity and rejects another session or registered workspace', async () => {
    const reader = vi.fn().mockResolvedValue({ error: 'not_found', message: 'fixture' });
    chat.setObservationReader(reader);
    await expect(chat.send(scope.sessionId, 'single', { ...scope, workspaceId: 'other' })).rejects.toThrow('观察会话');
    await chat.send(scope.sessionId, 'single', scope);
    await vi.waitFor(() => expect(chat.get(scope.sessionId).state).toBe('idle'));
    expect(reader).toHaveBeenCalledOnce();
    expect(reader.mock.calls[0]!.slice(0, 3)).toEqual([scope, 'files.read', { resourceId: 'resource-a', path: 'note.txt' }]);
    expect(reader.mock.calls[0]![3]).toBeInstanceOf(AbortSignal);
  });
  it('propagates cancellation of a pending request to the Main reader and discards late completion', async () => {
    let signal!: AbortSignal;
    let finish!: (value: unknown) => void;
    const reader = vi.fn((_scope, _tool, _args, abort: AbortSignal) => {
      signal = abort;
      return new Promise<never>((resolve) => {
        finish = resolve as never;
      });
    });
    chat.setObservationReader(reader);
    await chat.send(scope.sessionId, 'pending', scope);
    await vi.waitFor(() => expect(reader).toHaveBeenCalledOnce());
    await chat.cancel(scope.sessionId);
    expect(signal.aborted).toBe(true);
    finish({ error: 'not_found', message: 'late' });
    expect(chat.get(scope.sessionId).state).toBe('cancelled');
    expect(chat.get(scope.sessionId).messages.filter((message) => message.role === 'assistant')).toEqual([]);
  });
  it('propagates guest socket disconnect and preserves a bounded response', async () => {
    let signal!: AbortSignal;
    chat.setObservationReader((_scope, _tool, _args, abort) => {
      signal = abort;
      return new Promise((resolve) =>
        abort.addEventListener('abort', () => resolve({ error: 'cancelled', message: 'disconnected' }), { once: true }),
      );
    });
    await chat.send(scope.sessionId, 'disconnect', scope);
    await vi.waitFor(() => expect(chat.get(scope.sessionId).state).toBe('idle'));
    expect(signal.aborted).toBe(true);
  });
  it('enforces four pending calls and cancels all of them on turn shutdown', async () => {
    const signals: AbortSignal[] = [];
    chat.setObservationReader((_scope, _tool, _args, signal) => {
      signals.push(signal);
      return new Promise((resolve) =>
        signal.addEventListener('abort', () => resolve({ error: 'cancelled', message: 'stopped' }), { once: true }),
      );
    });
    await chat.send(scope.sessionId, 'concurrent', scope);
    await vi.waitFor(() => expect(signals).toHaveLength(4));
    expect(chat.get(scope.sessionId).messages.at(-1)?.text).toContain('budget_exceeded');
    await chat.cancel(scope.sessionId);
    expect(signals.every((signal) => signal.aborted)).toBe(true);
  });
  it('bounds the complete JSON UTF8 frame before writing Chinese content', () => {
    const id = randomUUID();
    const frame = boundedObservationReply(id, { error: 'unavailable', message: '中'.repeat(400000) });
    expect(frame.result).toMatchObject({ error: 'budget_exceeded' });
    expect(Buffer.byteLength(JSON.stringify(frame) + '\n')).toBeLessThan(1048576);
    expect(boundedObservationReply(id, { error: 'not_found', message: '中文' }).result).toEqual({ error: 'not_found', message: '中文' });
  });
  it('enforces the independent 64 request budget for sequential calls in one turn', async () => {
    const reader = vi.fn().mockResolvedValue({ error: 'not_found', message: 'fixture' });
    chat.setObservationReader(reader);
    await chat.send(scope.sessionId, 'budget', scope);
    await vi.waitFor(() => expect(chat.get(scope.sessionId).state).toBe('idle'));
    expect(reader).toHaveBeenCalledTimes(64);
    expect(chat.get(scope.sessionId).messages.at(-1)?.text).toContain('budget_exceeded');
  });
  it('returns a bounded error through the framed process for an oversized multibyte Provider result', async () => {
    chat.setObservationReader(async () => ({ error: 'unavailable', message: '中'.repeat(400000) }));
    await chat.send(scope.sessionId, 'large', scope);
    await vi.waitFor(() => expect(chat.get(scope.sessionId).state).toBe('idle'));
    expect(chat.get(scope.sessionId).messages.at(-1)?.text).toContain('budget_exceeded');
    expect(chat.get(scope.sessionId).cleanupPending).toBe(false);
  });
});
