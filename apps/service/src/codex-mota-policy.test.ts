import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { AppControlResult, ChatConversation, MotaTaskBinding, ResearchGrant } from '@wsl/protocol';
import { CodexChat } from './codex-chat';
import { GuestProcess, SbxConnection, type GuestFrame, type GuestOutcome, type GuestStart } from './sbx';
import { emptyReferences } from './reference-test-fixture';

const session = 'session-policy';
const otherSession = 'session-policy-other';
const workspaceId = 'taskflow-demo';
const success: GuestOutcome = { confirmed: true, exitCode: 0, error: null };
function deferred<T>() {
  let resolve: (value: T) => void = () => {
    throw new Error('deferred not initialized');
  };
  let reject: (reason: Error) => void = () => {
    throw new Error('deferred not initialized');
  };
  const promise = new Promise<T>((yes, no) => {
    resolve = yes;
    reject = no;
  });
  return { promise, resolve, reject };
}

function transport(start: GuestStart, frame: (frame: GuestFrame) => void) {
  const remote = new GuestProcess(
    path.resolve('e2e/fixtures/sbx.mjs'),
    'policy-fixture',
    { type: 'start', mode: 'terminal', cols: 80, rows: 24 },
    () => {},
  );
  const nativeDone = remote.done;
  const nativeClose = remote.close.bind(remote);
  const done = deferred<GuestOutcome>();
  const closing = deferred<GuestOutcome>();
  Object.defineProperty(remote, 'done', { value: done.promise, configurable: true });
  const close = vi.spyOn(remote, 'close').mockImplementation(() => closing.promise);
  const write = vi.spyOn(remote, 'write').mockImplementation(() => {});
  return {
    start,
    frame,
    done,
    closing,
    close,
    write,
    event: (event: unknown) => frame({ type: 'output', stream: 'stdout', data: JSON.stringify(event) + '\n' }),
    scratch: () => {
      if (start.mode === 'codex' && start.workspace) frame({ type: 'workspace', ...start.workspace });
    },
    dispose: async () => {
      Object.defineProperty(remote, 'done', { value: nativeDone, configurable: true });
      write.mockRestore();
      await nativeClose();
    },
    remote,
  };
}

type Transport = ReturnType<typeof transport>;
let chat: CodexChat;
let connection: SbxConnection;
let turns: Transport[];
let emit: ReturnType<typeof vi.fn<(value: ChatConversation) => void>>;
let unhandled: unknown[];
const onUnhandled = (error: unknown) => unhandled.push(error);
const tick = () => new Promise<void>((resolve) => setImmediate(resolve));

beforeEach(() => {
  turns = [];
  unhandled = [];
  process.on('unhandledRejection', onUnhandled);
  connection = new SbxConnection();
  vi.spyOn(connection, 'getStatus').mockReturnValue({
    available: true,
    reason: null,
    version: 'codex-cli fixture',
    sandbox: 'fixture',
    cwd: '/scratch',
  });
  vi.spyOn(connection, 'start').mockImplementation((start, frame) => {
    const turn = transport(start, frame);
    turns.push(turn);
    return turn.remote;
  });
  emit = vi.fn();
  chat = new CodexChat('.', emit, connection);
  chat.register(session, workspaceId);
  chat.register(otherSession, workspaceId);
});
afterEach(async () => {
  await Promise.all(turns.map((turn) => turn.dispose()));
  process.removeListener('unhandledRejection', onUnhandled);
  vi.restoreAllMocks();
});

async function begin(mota = true, research = false) {
  if (mota) vi.spyOn(connection, 'assertMotaCapability').mockImplementation(() => undefined);
  const binding: MotaTaskBinding = {
    workspaceId,
    environmentId: 'sandbox',
    projectId: randomUUID(),
    appInstanceId: randomUUID(),
    runId: randomUUID(),
    sessionId: session,
    resourceId: 'game',
    browserInstanceId: 'browser',
    browserGeneration: 0,
    webContentsId: 1,
    documentGeneration: 0,
  };
  const scope = { workspaceId, sessionId: session, runId: binding.runId, sources: [] };
  const grant: ResearchGrant | undefined = research
    ? {
        grantId: randomUUID(),
        accountId: 'test-account',
        workspaceId,
        sessionId: session,
        runId: binding.runId,
        taskVersionId: 'task-version',
        mode: 'live',
        purpose: 'public-web-research',
        grantedAt: new Date().toISOString(),
      }
    : undefined;
  await chat.send(session, 'policy fixture', scope, emptyReferences(session), undefined, mota ? binding : undefined, grant);
  const turn = turns.at(-1);
  if (!turn) throw new Error('missing controlled transport');
  return turn;
}
function command(turn: Transport, phase = 'item.started') {
  turn.event({ type: phase, item: { id: 'command', type: 'command_execution' } });
}
function request(turn: Transport, tool: string, args: Record<string, unknown> = {}) {
  turn.frame({ type: 'observation-call', id: randomUUID(), tool, args });
}
function completed(turn: Transport) {
  turn.event({ type: 'thread.started', thread_id: 'controlled-thread' });
  turn.event({ type: 'item.completed', item: { id: 'reply', type: 'agent_message', text: 'done' } });
  turn.event({ type: 'turn.completed' });
  turn.scratch();
  turn.done.resolve(success);
  turn.closing.resolve(success);
}
function expectPolicy(pending: boolean) {
  expect(chat.get(session)).toMatchObject({ state: 'failed', cleanupPending: pending, error: expect.stringContaining('policy_violation') });
}

describe('R4 Mota policy event boundary', () => {
  it.each(['item.started', 'item.updated', 'item.completed'])(
    'fails synchronously on %s without completed-only command fields',
    async (phase) => {
      const turn = await begin();
      command(turn, phase);
      expectPolicy(true);
      expect(emit.mock.calls.at(-1)?.[0]).toMatchObject({ state: 'failed', cleanupPending: true });
      await tick();
      expect(turn.close).toHaveBeenCalledTimes(1);
    },
  );

  it.each(['item.started', 'item.updated', 'item.completed'])('rejects non-Mota MCP and native search in %s', async (phase) => {
    const turn = await begin();
    turn.event({ type: phase, item: { id: 'drift', type: 'mcp_tool_call', server: 'wsl_space', tool: 'app_snapshot' } });
    expectPolicy(true);
  });

  it.each([
    { type: 'mcp_tool_call', server: 'other_server', tool: 'app_mota_state' },
    { type: 'mcp_tool_call', server: 'wsl_space', tool: 'app_mota_arbitrary' },
    { type: 'web_search' },
    { type: 'web_search_call' },
  ])('rejects tool drift $type / $server / $tool', async (item) => {
    const turn = await begin();
    turn.event({ type: 'item.started', item: { id: 'drift', ...item } });
    expectPolicy(true);
  });

  it.each(['app.snapshot', 'workspace.sources', 'research.open'])('fails closed on a forbidden bridged request: %s', async (tool) => {
    const reader = vi.fn();
    chat.setAppControlReader(reader);
    chat.setObservationReader(reader);
    chat.setResearchReader(reader);
    const turn = await begin();
    request(turn, tool);
    expectPolicy(true);
    expect(reader).not.toHaveBeenCalled();
  });

  it('retains legitimate prior receipts and modifications, and accepts only the four exact Mota MCP tools', async () => {
    let modified = false;
    const receipt: AppControlResult = {
      ok: true,
      tool: 'app.mota.map.set',
      data: { operationId: 'already-applied', before: 0, after: 53 },
    };
    const reader = vi.fn(async () => {
      modified = true;
      return receipt;
    });
    chat.setAppControlReader(reader);
    const turn = await begin();
    request(turn, 'app.mota.map.set');
    await tick();
    expect(turn.write).toHaveBeenCalledWith(expect.objectContaining({ result: receipt }));
    for (const tool of ['app_mota_state', 'app_mota_act', 'app_mota_map_read', 'app_mota_map_set']) {
      turn.event({
        type: 'item.completed',
        item: { id: tool, type: 'mcp_tool_call', server: 'wsl_space', tool, status: 'completed', result: receipt },
      });
    }
    const records = chat.get(session).toolExecutions;
    expect(records).toHaveLength(4);
    expect(chat.get(session).state).toBe('running');
    command(turn);
    completed(turn);
    await tick();
    expectPolicy(false);
    expect(modified).toBe(true);
    expect(chat.get(session).toolExecutions).toEqual(records);
  });

  it('leaves ordinary chat command execution and other MCP servers unchanged', async () => {
    const turn = await begin(false);
    turn.event({ type: 'item.started', item: { id: 'command', type: 'command_execution' } });
    turn.event({
      type: 'item.completed',
      item: { id: 'command', type: 'command_execution', command: 'printf ordinary', aggregated_output: 'ordinary', exit_code: 0 },
    });
    turn.event({
      type: 'item.completed',
      item: { id: 'ordinary-mcp', type: 'mcp_tool_call', server: 'other_server', tool: 'unrestricted', status: 'completed', result: {} },
    });
    completed(turn);
    await tick();
    expect(chat.get(session)).toMatchObject({ state: 'idle', cleanupPending: false, error: null });
    expect(chat.get(session).toolExecutions).toEqual(
      expect.arrayContaining([expect.objectContaining({ command: 'printf ordinary', output: 'ordinary', exitCode: 0 })]),
    );
    expect(chat.get(session).toolExecutions).toHaveLength(2);
    expect(turn.close).not.toHaveBeenCalled();
  });
});

describe('R4 admission and owned cleanup', () => {
  it('aborts in-flight per-call signals and never dispatches any post-failure requests', async () => {
    const pending = deferred<AppControlResult>();
    const signals: AbortSignal[] = [];
    const app = vi.fn((...args: Parameters<Parameters<CodexChat['setAppControlReader']>[0]>) => {
      signals.push(args[3]);
      return pending.promise;
    });
    const observer = vi.fn();
    const research = vi.fn();
    chat.setAppControlReader(app);
    chat.setObservationReader(observer);
    chat.setResearchReader(research);
    const turn = await begin();
    request(turn, 'app.mota.act');
    expect(signals).toHaveLength(1);
    expect(signals[0]?.aborted).toBe(false);
    command(turn);
    request(turn, 'app.mota.state');
    request(turn, 'workspace.sources');
    request(turn, 'research.open', { url: 'https://example.com/' });
    expect(signals[0]?.aborted).toBe(true);
    expect(app).toHaveBeenCalledTimes(1);
    expect(observer).not.toHaveBeenCalled();
    expect(research).not.toHaveBeenCalled();
    pending.resolve({ ok: true, tool: 'app.mota.act', data: {} });
    await tick();
    expect(turn.write).not.toHaveBeenCalled();
  });

  it('guards ordinary observation and deferred research readers after any turn failure', async () => {
    const observer = vi.fn(async () => ({ error: 'unavailable' as const, message: 'fixture' }));
    const research = vi.fn();
    chat.setObservationReader(observer);
    chat.setResearchReader(research);
    const turn = await begin(false, true);
    request(turn, 'research.open', { url: 'https://example.com/' });
    turn.event({ type: 'error', message: 'controlled failure' });
    request(turn, 'workspace.sources');
    request(turn, 'research.open', { url: 'https://example.com/' });
    await tick();
    expect(observer).not.toHaveBeenCalled();
    expect(research).not.toHaveBeenCalled();
  });

  it.each(['cancel', 'shutdown'] as const)(
    '%s joins policy cleanup without relabelling as user cancellation or closing twice',
    async (action) => {
      const turn = await begin();
      command(turn);
      const stopping = action === 'cancel' ? chat.cancel(session) : chat.shutdown();
      const second = chat.cancel(session);
      expectPolicy(true);
      completed(turn);
      await Promise.all([stopping, second]);
      await tick();
      expectPolicy(false);
      expect(turn.close).toHaveBeenCalledTimes(1);
      expect(emit.mock.calls.some(([value]) => value.state === 'cancelling' || value.state === 'cancelled')).toBe(false);
    },
  );

  it.each(['item.started', 'item.updated', 'item.completed'])('records violation during cancellation for %s', async (phase) => {
    const turn = await begin();
    const stopping = chat.cancel(session);
    await tick();
    expect(chat.get(session)).toMatchObject({ state: 'cancelling', cleanupPending: true });
    expect(turn.close).toHaveBeenCalledTimes(1);
    command(turn, phase);
    expectPolicy(true);
    expect(emit.mock.calls.at(-1)?.[0]).toMatchObject({ state: 'failed', error: expect.stringContaining('policy_violation') });
    completed(turn);
    expect(await stopping).toMatchObject({ state: 'failed', cleanupPending: false, error: expect.stringContaining('policy_violation') });
    expectPolicy(false);
    expect(turn.close).toHaveBeenCalledTimes(1);
    expect(chat.get(session).messages).toHaveLength(1);
  });

  it.each([false, true])('ignores malformed non-policy output and late messages during cancellation, Mota=%s', async (mota) => {
    const turn = await begin(mota);
    const stopping = chat.cancel(session);
    const before = chat.get(session);
    turn.frame({ type: 'output', stream: 'stdout', data: '{broken\n' });
    turn.event({ type: 'thread.started' });
    turn.event({ type: 'error', message: 'ignored late error' });
    turn.event({ type: 'item.completed', item: { id: 'late', type: 'agent_message', text: 'ignored late reply' } });
    expect(chat.get(session)).toEqual(before);
    completed(turn);
    expect(await stopping).toMatchObject({ state: 'cancelled', cleanupPending: false, error: null });
    expect(chat.get(session).messages).toHaveLength(1);
    expect(turn.close).toHaveBeenCalledTimes(1);
  });

  it('ignores policy events from a confirmed cancelled turn before and after the next turn starts', async () => {
    const old = await begin();
    const stopping = chat.cancel(session);
    completed(old);
    await stopping;
    const cancelled = chat.get(session);
    for (const phase of ['item.started', 'item.updated', 'item.completed']) command(old, phase);
    expect(chat.get(session)).toEqual(cancelled);
    const next = await begin();
    const before = chat.get(session);
    for (const phase of ['item.started', 'item.updated', 'item.completed']) command(old, phase);
    old.frame({ type: 'cleanup', ok: false, error: 'stale cleanup' });
    old.scratch();
    expect(chat.get(session)).toEqual(before);
    completed(next);
    await tick();
    expect(chat.get(session)).toMatchObject({ state: 'idle', cleanupPending: false, error: null });
  });

  it('late done success cannot override policy failure', async () => {
    const turn = await begin();
    command(turn);
    completed(turn);
    await tick();
    expectPolicy(false);
    expect(chat.get(session).messages).toHaveLength(1);
  });

  it('old callbacks, including workspace and cleanup frames, cannot mutate or dispatch into a new turn', async () => {
    const app = vi.fn(async (): Promise<AppControlResult> => ({ ok: true, tool: 'app.mota.state', data: {} }));
    chat.setAppControlReader(app);
    const old = await begin();
    completed(old);
    await tick();
    await chat.reset(session);
    const next = await begin();
    const before = chat.get(session);
    old.frame({ type: 'cleanup', ok: true });
    old.frame({ type: 'cleanup', ok: false, error: 'stale cleanup' });
    old.scratch();
    old.scratch();
    old.event({ type: 'error', message: 'stale failure' });
    request(old, 'app.mota.state');
    expect(chat.get(session)).toEqual(before);
    expect(app).not.toHaveBeenCalled();
    completed(next);
    await tick();
    expect(chat.get(session).state).toBe('idle');
  });

  it.each(['unconfirmed', 'rejected'] as const)('%s done preserves policy reason and blocks new/reset in every slot', async (mode) => {
    const turn = await begin();
    command(turn);
    if (mode === 'unconfirmed') turn.done.resolve({ confirmed: false, exitCode: null, error: 'cleanup unknown' });
    else turn.done.reject(new Error('done rejected'));
    await tick();
    expectPolicy(true);
    for (const id of [session, otherSession, 'conv-personal-default']) {
      await expect(chat.send(id, 'blocked', undefined, emptyReferences(id))).rejects.toThrow();
      await expect(chat.reset(id)).rejects.toThrow();
    }
    expect(connection.start).toHaveBeenCalledTimes(1);
    expect(unhandled).toEqual([]);
  });

  it('close rejection is handled, retains ownership and cannot erase policy failure', async () => {
    const turn = await begin();
    command(turn);
    await tick();
    turn.closing.reject(new Error('close rejected'));
    await tick();
    expectPolicy(true);
    expect(chat.get(session).error).toContain('close rejected');
    await expect(chat.cancel(session)).rejects.toThrow('close rejected');
    await expect(chat.reset(session)).rejects.toThrow('close rejected');
    await expect(chat.send(otherSession, 'blocked', undefined, emptyReferences(otherSession))).rejects.toThrow();
    expect(turn.close).toHaveBeenCalledTimes(1);
    expect(unhandled).toEqual([]);
  });

  it('does not infer cleanup from a cleanup frame when done subsequently rejects', async () => {
    const turn = await begin();
    command(turn);
    turn.frame({ type: 'cleanup', ok: true });
    expectPolicy(true);
    turn.done.reject(new Error('transport completion unknown'));
    await tick();
    expectPolicy(true);
    await expect(chat.reset(otherSession)).rejects.toThrow();
    expect(unhandled).toEqual([]);
  });

  it('preserves policy reason alongside outcome errors and an invalid scratch snapshot', async () => {
    const turn = await begin();
    command(turn);
    turn.done.resolve({ confirmed: true, exitCode: 9, error: 'transport error' });
    await tick();
    expectPolicy(false);
    expect(chat.get(session).error).toContain('scratch');
  });

  it('catches failures from the whole async done chain without fabricating unknown cleanup', async () => {
    const turn = await begin();
    command(turn);
    let thrown = false;
    emit.mockImplementation((value) => {
      if (value.state === 'failed' && !value.cleanupPending && !thrown) {
        thrown = true;
        throw new Error('terminal publication failed');
      }
    });
    completed(turn);
    await tick();
    expect(thrown).toBe(true);
    expectPolicy(false);
    expect(chat.get(session).error).toContain('terminal publication failed');
    expect(unhandled).toEqual([]);
  });
});
