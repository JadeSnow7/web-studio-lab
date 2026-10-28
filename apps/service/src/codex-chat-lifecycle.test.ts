import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { AppControlResult, ChatConversation, ChatSlot } from '@wsl/protocol';
import { CodexChat } from './codex-chat';
import { GuestProcess, SbxConnection, type GuestFrame, type GuestOutcome } from './sbx';
import { emptyReferences } from './reference-test-fixture';

const session = 'session-lifecycle';
const other = 'session-lifecycle-other';
const personal = 'conv-personal-default';
const success: GuestOutcome = { confirmed: true, exitCode: 0, error: null };
const tick = () => new Promise<void>((resolve) => setImmediate(resolve));
function deferred<T>() {
  let resolve: (value: T) => void = () => {
    throw new Error('not initialized');
  };
  let reject: (reason: Error) => void = () => {
    throw new Error('not initialized');
  };
  const promise = new Promise<T>((yes, no) => {
    resolve = yes;
    reject = no;
  });
  return { promise, resolve, reject };
}
function transport(frame: (value: GuestFrame) => void) {
  // Exercise a real, owned fixture transport while controlling only its completion
  // contract. Rejected done is fault injection; GuestProcess normally resolves it.
  let pid: number | undefined;
  const remote = new GuestProcess(
    path.resolve('e2e/fixtures/sbx.mjs'),
    'lifecycle-fixture',
    { type: 'start', mode: 'terminal', cols: 80, rows: 24 },
    (value) => {
      if (value.type === 'ready') pid = value.pid;
    },
  );
  const nativeDone = remote.done;
  const nativeClose = remote.close.bind(remote);
  const done = deferred<GuestOutcome>();
  const closing = deferred<GuestOutcome>();
  Object.defineProperty(remote, 'done', { value: done.promise, configurable: true });
  const close = vi.spyOn(remote, 'close').mockImplementation(() => closing.promise);
  const write = vi.spyOn(remote, 'write').mockImplementation(() => {});
  return {
    remote,
    frame,
    done,
    closing,
    close,
    write,
    event: (event: unknown, newline = true) =>
      frame({ type: 'output', stream: 'stdout', data: JSON.stringify(event) + (newline ? '\n' : '') }),
    dispose: async () => {
      // Settle synthetic handles even when an assertion failed; physical teardown
      // uses the original transport and cannot be satisfied by injected outcomes.
      done.resolve(success);
      closing.resolve(success);
      Object.defineProperty(remote, 'done', { value: nativeDone, configurable: true });
      write.mockRestore();
      const outcome = await nativeClose();
      expect(outcome.confirmed).toBe(true);
      expect(outcome.error).toBeNull();
      const fixturePid = pid;
      expect(fixturePid).toBeDefined();
      if (fixturePid !== undefined) expect(() => process.kill(fixturePid, 0)).toThrow(/ESRCH/);
    },
  };
}
type Transport = ReturnType<typeof transport>;
let chat: CodexChat;
let connection: SbxConnection;
let turns: Transport[];
let emit: ReturnType<typeof vi.fn<(value: ChatConversation) => void>>;
let unhandled: unknown[];
const onUnhandled = (error: unknown) => unhandled.push(error);
beforeEach(() => {
  turns = [];
  unhandled = [];
  process.on('unhandledRejection', onUnhandled);
  connection = new SbxConnection();
  vi.spyOn(connection, 'getStatus').mockReturnValue({
    available: true,
    reason: null,
    version: 'fixture',
    sandbox: 'fixture',
    cwd: '/scratch',
  });
  vi.spyOn(connection, 'start').mockImplementation((_start, frame) => {
    const turn = transport(frame);
    turns.push(turn);
    return turn.remote;
  });
  emit = vi.fn();
  chat = new CodexChat('.', emit, connection);
  chat.register(session, 'taskflow-demo');
  chat.register(other, 'taskflow-demo');
});
afterEach(async () => {
  try {
    const results = await Promise.allSettled(turns.map((turn) => turn.dispose()));
    await tick();
    expect(results.filter((result) => result.status === 'rejected')).toEqual([]);
    expect(unhandled).toEqual([]);
  } finally {
    process.removeListener('unhandledRejection', onUnhandled);
    vi.restoreAllMocks();
  }
});
async function begin(id: ChatSlot = session) {
  const scope = id === personal ? undefined : { workspaceId: 'taskflow-demo', sessionId: id, runId: randomUUID(), sources: [] };
  await chat.send(id, 'fixture', scope, emptyReferences(id));
  const turn = turns.at(-1);
  if (!turn) throw new Error('missing fixture transport');
  return turn;
}
function protocolFailure(turn: Transport) {
  turn.event({ type: 'error', message: 'original protocol failure' });
}
function eventsComplete(turn: Transport, newline = true) {
  turn.event({ type: 'thread.started', thread_id: 'fixture-thread' });
  turn.event({ type: 'item.completed', item: { id: 'reply', type: 'agent_message', text: 'fixture reply' } });
  turn.event({ type: 'turn.completed' }, newline);
}
function complete(turn: Transport) {
  eventsComplete(turn);
  turn.done.resolve(success);
  turn.closing.resolve(success);
}
async function expectBlocked() {
  for (const id of [session, other, personal]) {
    const generation = chat.get(id).generation;
    await expect(chat.send(id, 'blocked', undefined, emptyReferences(id))).rejects.toThrow();
    await expect(chat.reset(id)).rejects.toThrow();
    expect(chat.get(id).generation).toBe(generation);
  }
}

describe('ordinary conversation completion and cleanup ownership', () => {
  // service 层各会话槽互不阻塞；Main ChatService 的 sandbox 工作区写入许可另行拒绝跨会话并发写入（W0）。
  it('keeps healthy personal and separate space conversations concurrently available', async () => {
    const first = await begin(session);
    const second = await begin(other);
    const third = await begin(personal);
    expect(connection.start).toHaveBeenCalledTimes(3);
    for (const id of [session, other, personal]) expect(chat.get(id)).toMatchObject({ state: 'running', cleanupPending: true });
    for (const turn of [first, second, third]) complete(turn);
    await tick();
    for (const id of [session, other, personal]) expect(chat.get(id)).toMatchObject({ state: 'idle', cleanupPending: false });
  });

  it('records repeated publication failures without an unhandled completion rejection', async () => {
    const turn = await begin();
    emit.mockImplementation((value) => {
      if (!value.cleanupPending) throw new Error(value.state === 'idle' ? 'terminal publication failed' : 'failure publication failed');
    });
    complete(turn);
    await tick();
    expect(chat.get(session)).toMatchObject({ state: 'failed', cleanupPending: false });
    expect(chat.get(session).error).toContain('terminal publication failed');
    expect(chat.get(session).error).toContain('failure publication failed');
    expect(unhandled).toEqual([]);
  });

  it('blocks personal and space send/reset when the shared connection has unknown cleanup', async () => {
    vi.spyOn(connection, 'getCleanupPending').mockReturnValue(true);
    await expectBlocked();
    expect(connection.start).not.toHaveBeenCalled();
  });

  it.each(['unconfirmed', 'rejected'] as const)('%s done retains the original failure and ownership in every slot', async (mode) => {
    const turn = await begin();
    protocolFailure(turn);
    if (mode === 'unconfirmed') turn.done.resolve({ confirmed: false, exitCode: null, error: 'cleanup unknown' });
    else turn.done.reject(new Error('done rejected'));
    await tick();
    expect(chat.get(session)).toMatchObject({
      state: 'failed',
      cleanupPending: true,
      error: expect.stringContaining('original protocol failure'),
    });
    expect(chat.get(session).error).toContain(mode === 'unconfirmed' ? 'cleanup unknown' : 'done rejected');
    await expectBlocked();
    expect(connection.start).toHaveBeenCalledTimes(1);
    expect(unhandled).toEqual([]);
  });

  it('publishes protocol failure immediately and does not dispatch another observation while cleanup is pending', async () => {
    const reader = vi.fn(async (): Promise<AppControlResult> => ({
      ok: false,
      tool: null,
      error: { code: 'unavailable', message: 'fixture' },
    }));
    chat.setAppControlReader(reader);
    const turn = await begin();
    protocolFailure(turn);
    expect(chat.get(session)).toMatchObject({ state: 'failed', cleanupPending: true, error: 'original protocol failure' });
    turn.frame({ type: 'observation-call', id: randomUUID(), tool: 'app.status', args: {} });
    expect(reader).not.toHaveBeenCalled();
    await expect(chat.send(personal, 'blocked', undefined, emptyReferences(personal))).rejects.toThrow();
    complete(turn);
    await tick();
    expect(chat.get(session)).toMatchObject({ state: 'failed', cleanupPending: false, error: 'original protocol failure' });
  });

  it('handles close rejection without losing the original failure or retrying close', async () => {
    const turn = await begin();
    protocolFailure(turn);
    await tick();
    turn.closing.reject(new Error('close rejected'));
    await tick();
    expect(chat.get(session)).toMatchObject({
      state: 'failed',
      cleanupPending: true,
      error: expect.stringContaining('original protocol failure'),
    });
    expect(chat.get(session).error).toContain('close rejected');
    await expectBlocked();
    expect(turn.close).toHaveBeenCalledTimes(1);
    expect(unhandled).toEqual([]);
  });

  it('never confirms cleanup from a frame before the completion promise settles', async () => {
    const turn = await begin();
    turn.frame({ type: 'cleanup', ok: true });
    expect(chat.get(session).cleanupPending).toBe(true);
    turn.done.reject(new Error('completion unknown'));
    await tick();
    expect(chat.get(session)).toMatchObject({
      state: 'failed',
      cleanupPending: true,
      error: expect.stringContaining('completion unknown'),
    });
    await expectBlocked();
    expect(unhandled).toEqual([]);
  });

  it('catches terminal publication failure after confirmed cleanup and preserves both facts', async () => {
    const turn = await begin();
    let thrown = false;
    emit.mockImplementation((value) => {
      if (value.state === 'idle' && !value.cleanupPending && !thrown) {
        thrown = true;
        throw new Error('terminal publication failed');
      }
    });
    complete(turn);
    await tick();
    expect(thrown).toBe(true);
    expect(chat.get(session)).toMatchObject({
      state: 'failed',
      cleanupPending: false,
      error: expect.stringContaining('terminal publication failed'),
    });
    expect(unhandled).toEqual([]);
    const next = await begin();
    complete(next);
  });

  it('still closes and waits for completion when publishing cancellation throws', async () => {
    const turn = await begin();
    emit.mockImplementation((value) => {
      if (value.state === 'cancelling') throw new Error('cancellation publication failed');
    });
    const cancelling = chat.cancel(session);
    const observed = cancelling.then(
      (value) => ({ value }),
      (error: unknown) => ({ error }),
    );
    await tick();
    expect(turn.close).toHaveBeenCalledTimes(1);
    expect(chat.get(session)).toMatchObject({
      state: 'failed',
      cleanupPending: true,
      error: expect.stringContaining('cancellation publication failed'),
    });
    turn.closing.resolve(success);
    turn.done.resolve(success);
    const result = await observed;
    expect(result).toMatchObject({
      value: { state: 'failed', cleanupPending: false, error: expect.stringContaining('cancellation publication failed') },
    });
    expect(unhandled).toEqual([]);
  });

  it('cancel waits for the done publication even if close reports success first', async () => {
    const turn = await begin();
    let settled = false;
    const cancelling = chat.cancel(session).then((value) => {
      settled = true;
      return value;
    });
    turn.closing.resolve(success);
    await tick();
    expect(settled).toBe(false);
    expect(chat.get(session)).toMatchObject({ state: 'cancelling', cleanupPending: true });
    turn.done.resolve(success);
    expect(await cancelling).toMatchObject({ state: 'cancelled', cleanupPending: false });
    expect(emit.mock.calls.at(-1)?.[0]).toMatchObject({ state: 'cancelled', cleanupPending: false });
  });

  it('deduplicates failure and concurrent cancellation close requests', async () => {
    const turn = await begin();
    protocolFailure(turn);
    const first = chat.cancel(session);
    const second = chat.cancel(session);
    await tick();
    expect(turn.close).toHaveBeenCalledTimes(1);
    turn.closing.resolve(success);
    turn.done.resolve(success);
    for (const result of await Promise.all([first, second]))
      expect(result).toMatchObject({ state: 'failed', error: 'original protocol failure', cleanupPending: false });
  });

  it('keeps the active owner until synchronous terminal publication returns', async () => {
    const turn = await begin();
    let reentrant: Promise<ChatConversation> | undefined;
    emit.mockImplementation((value) => {
      if (value.state === 'idle') {
        reentrant = chat.send(session, 'reentrant', undefined, emptyReferences(session));
        void reentrant.catch(() => undefined);
      }
    });
    complete(turn);
    await tick();
    expect(reentrant).toBeDefined();
    await expect(reentrant).rejects.toThrow('等待回复');
    expect(connection.start).toHaveBeenCalledTimes(1);
  });

  it.each(['confirmed', 'unconfirmed'] as const)('reentrant cancel during %s terminal publication preserves the outcome', async (mode) => {
    const turn = await begin();
    let cancelling: Promise<{ value: ChatConversation } | { error: unknown }> | undefined;
    emit.mockImplementation((value) => {
      if ((mode === 'confirmed' && value.state === 'idle') || (mode === 'unconfirmed' && value.state === 'failed')) {
        cancelling = chat.cancel(session).then(
          (value) => ({ value }),
          (error: unknown) => ({ error }),
        );
      }
    });
    eventsComplete(turn);
    turn.done.resolve(mode === 'confirmed' ? success : { confirmed: false, exitCode: null, error: 'cleanup unknown' });
    await tick();
    expect(chat.get(session)).toMatchObject(
      mode === 'confirmed'
        ? { state: 'idle', cleanupPending: false, error: null }
        : { state: 'failed', cleanupPending: true, error: 'cleanup unknown' },
    );
    expect(turn.close).not.toHaveBeenCalled();
    expect(cancelling).toBeDefined();
    expect(await cancelling).toMatchObject(
      mode === 'confirmed'
        ? { value: { state: 'idle', cleanupPending: false, error: null } }
        : { error: expect.objectContaining({ message: 'cleanup unknown' }) },
    );
  });

  it('ignores stale cleanup/output/call callbacks after reset and a new turn', async () => {
    const reader = vi.fn(async (): Promise<AppControlResult> => ({
      ok: false,
      tool: null,
      error: { code: 'unavailable', message: 'fixture' },
    }));
    chat.setAppControlReader(reader);
    const old = await begin();
    complete(old);
    await tick();
    await chat.reset(session);
    const next = await begin();
    const before = chat.get(session);
    old.frame({ type: 'cleanup', ok: false, error: 'stale cleanup' });
    old.frame({ type: 'cleanup', ok: true });
    old.event({ type: 'error', message: 'stale error' });
    old.frame({ type: 'observation-call', id: randomUUID(), tool: 'app.status', args: {} });
    expect(chat.get(session)).toEqual(before);
    expect(reader).not.toHaveBeenCalled();
    complete(next);
  });

  it('consumes the final unterminated event before publishing successful completion', async () => {
    const turn = await begin();
    eventsComplete(turn, false);
    turn.done.resolve(success);
    await tick();
    expect(chat.get(session)).toMatchObject({ state: 'idle', cleanupPending: false, error: null });
    expect(chat.get(session).messages.at(-1)?.text).toBe('fixture reply');
  });
});
