import path from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { CodexChat } from './codex-chat';
import { GuestProcess, SbxConnection, type GuestFrame, type GuestOutcome } from './sbx';
import { claudeCodeAcp } from './harness/acp/agents';

const success: GuestOutcome = { confirmed: true, exitCode: 0, error: null };
const unknown: GuestOutcome = { confirmed: false, exitCode: null, error: 'fixture cleanup unknown' };
const status = { available: true, reason: null, version: 'fixture', sandbox: 'fixture', cwd: '/scratch' };
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
const disposers: Array<() => Promise<void>> = [];
afterEach(async () => {
  try {
    const outcomes = await Promise.allSettled(disposers.splice(0).map((dispose) => dispose()));
    expect(outcomes.filter((outcome) => outcome.status === 'rejected')).toEqual([]);
  } finally {
    vi.restoreAllMocks();
  }
});
function setup(initial = Promise.resolve(status)) {
  const connection = new SbxConnection();
  vi.spyOn(connection, 'initialize').mockReturnValue(initial);
  vi.spyOn(connection, 'getStatus').mockReturnValue(status);
  vi.spyOn(connection, 'shutdown').mockResolvedValue();
  const transports: Array<{
    remote: GuestProcess;
    done: ReturnType<typeof deferred<GuestOutcome>>;
    closing: ReturnType<typeof deferred<GuestOutcome>>;
    close: GuestProcess['close'];
    reply: (result?: unknown) => void;
  }> = [];
  vi.spyOn(connection, 'start').mockImplementation((_start, frame: (value: GuestFrame) => void) => {
    let pid: number | undefined;
    const ready = deferred<void>();
    const remote = new GuestProcess(
      path.resolve('e2e/fixtures/sbx.mjs'),
      'acp-probe-lifecycle-fixture',
      { type: 'start', mode: 'terminal', cols: 80, rows: 24 },
      (value) => {
        if (value.type === 'ready') {
          pid = value.pid;
          ready.resolve();
        }
      },
    );
    const nativeDone = remote.done;
    const nativeClose = remote.close.bind(remote);
    const done = deferred<GuestOutcome>();
    const closing = deferred<GuestOutcome>();
    Object.defineProperty(remote, 'done', { value: done.promise, configurable: true });
    const close = vi.spyOn(remote, 'close').mockImplementation(() => closing.promise);
    const end = vi.spyOn(remote, 'endInput').mockImplementation(() => undefined);
    let requestId: number | undefined;
    const write = vi.spyOn(remote, 'writeInput').mockImplementation((line) => {
      const request = JSON.parse(line) as { id: number };
      requestId = request.id;
    });
    const reply = (result: unknown = { protocolVersion: 1, agentCapabilities: {}, authMethods: [] }) =>
      frame({ type: 'output', stream: 'stdout', data: JSON.stringify({ jsonrpc: '2.0', id: requestId, result }) + '\n' });
    transports.push({ remote, done, closing, close, reply });
    disposers.push(async () => {
      done.resolve(success);
      closing.resolve(success);
      await ready.promise;
      Object.defineProperty(remote, 'done', { value: nativeDone, configurable: true });
      write.mockRestore();
      end.mockRestore();
      const result = await nativeClose();
      expect(result.confirmed).toBe(true);
      expect(pid).toBeDefined();
      const fixturePid = pid;
      if (fixturePid !== undefined) expect(() => process.kill(fixturePid, 0)).toThrow(/ESRCH/);
    });
    return remote;
  });
  const chat = new CodexChat('.', () => undefined, connection, { kind: 'acp', spec: claudeCodeAcp });
  return { chat, connection, transports };
}

describe('ACP availability probe shutdown ownership', () => {
  it('does not advertise a successful handshake until cleanup is confirmed', async () => {
    const { chat, transports } = setup();
    const initializing = chat.initialize();
    await tick();
    const probe = transports[0];
    if (!probe) throw new Error('missing probe');
    probe.reply();
    await tick();
    try {
      expect(chat.getStatus().available).toBe(false);
    } finally {
      probe.done.resolve(success);
      probe.closing.resolve(success);
    }
    expect((await initializing).available).toBe(true);
    await chat.shutdown();
    expect(probe.close).not.toHaveBeenCalled();
  });
  it.each([
    { confirmed: true, exitCode: 1, error: null },
    { confirmed: true, exitCode: 0, error: 'fixture transport failure' },
  ])('keeps a failed probe unavailable despite confirmed cleanup: %j', async (outcome) => {
    const { chat, transports } = setup();
    const initializing = chat.initialize();
    await tick();
    const probe = transports[0];
    if (!probe) throw new Error('missing probe');
    probe.reply();
    probe.done.resolve(outcome);
    probe.closing.resolve(outcome);
    expect((await initializing).available).toBe(false);
    await chat.shutdown();
  });

  it('shutdown physically exits an unresponsive initialize Agent and its relay fixture', async () => {
    const connection = new SbxConnection();
    vi.spyOn(connection, 'initialize').mockResolvedValue(status);
    vi.spyOn(connection, 'getStatus').mockReturnValue(status);
    vi.spyOn(connection, 'shutdown').mockResolvedValue();
    const initialized = deferred<void>();
    let agentPid: number | undefined;
    let helperPid: number | undefined;
    let remote: GuestProcess | undefined;
    vi.spyOn(connection, 'start').mockImplementation((start, frame) => {
      remote = new GuestProcess(path.resolve('e2e/fixtures/sbx.mjs'), 'acp-real-probe-fixture', start, (value) => {
        if (value.type === 'ready') helperPid = value.pid;
        if (value.type === 'output' && value.stream === 'stderr') {
          const match = /ACP_TEST_PID:(\d+)/.exec(value.data);
          if (match) {
            agentPid = Number(match[1]);
            initialized.resolve();
          }
        }
        frame(value);
      });
      return remote;
    });
    // This local Agent acknowledges receipt on stderr but never answers initialize.
    const script = `require('node:readline').createInterface({input:process.stdin}).on('line',()=>process.stderr.write('ACP_TEST_PID:'+process.pid+'\\n'));`;
    const chat = new CodexChat('.', () => undefined, connection, {
      kind: 'acp',
      spec: { ...claudeCodeAcp, command: [process.execPath, '-e', script] },
    });
    const initializing = chat.initialize();
    try {
      await initialized.promise;
      expect(agentPid).toBeDefined();
      await chat.shutdown();
      expect((await initializing).available).toBe(false);
      expect(await remote?.done).toMatchObject({ confirmed: true });
      for (const pid of [agentPid, helperPid]) {
        expect(pid).toBeDefined();
        if (pid !== undefined) expect(() => process.kill(pid, 0)).toThrow(/ESRCH/);
      }
    } finally {
      await remote?.close();
      await initializing;
    }
  });

  it('closes a pending probe once and waits for its actual completion before both shutdowns settle', async () => {
    const { chat, transports } = setup();
    const initialization = chat.initialize();
    await tick();
    const probe = transports[0];
    if (!probe) throw new Error('missing probe');
    let settled = false;
    const shutting = Promise.all([chat.shutdown(), chat.shutdown()]).then(() => {
      settled = true;
    });
    try {
      await tick();
      expect(probe.close).toHaveBeenCalledTimes(1);
      expect(settled).toBe(false);
      probe.closing.resolve(success);
      await tick();
      expect(settled).toBe(false);
      probe.reply();
    } finally {
      probe.done.resolve(success);
      probe.closing.resolve(success);
      await initialization;
      await shutting;
    }
    expect(chat.getStatus().available).toBe(false);
  });
  it('does not start an ACP process when connection initialization completes after shutdown', async () => {
    const initial = deferred<typeof status>();
    const { chat, connection, transports } = setup(initial.promise);
    const initialization = chat.initialize();
    await chat.shutdown();
    initial.resolve(status);
    try {
      await tick();
      expect(connection.start).not.toHaveBeenCalled();
    } finally {
      for (const probe of transports) {
        probe.reply();
        probe.done.resolve(success);
        probe.closing.resolve(success);
      }
      await initialization;
    }
    expect(chat.getStatus().available).toBe(false);
  });
  it('deduplicates initialization so shutdown cannot lose an earlier probe', async () => {
    const { chat, connection, transports } = setup();
    const first = chat.initialize();
    const second = chat.initialize();
    await tick();
    try {
      expect(connection.start).toHaveBeenCalledTimes(1);
    } finally {
      for (const probe of transports) {
        probe.reply();
        probe.done.resolve(success);
        probe.closing.resolve(success);
      }
      await Promise.all([first, second]);
    }
    await chat.shutdown();
  });
  it('retains unconfirmed probe cleanup and rejects shutdown instead of acknowledging success', async () => {
    const { chat, transports } = setup();
    const initializing = chat.initialize();
    await tick();
    const probe = transports[0];
    if (!probe) throw new Error('missing probe');
    probe.reply();
    probe.done.resolve(unknown);
    probe.closing.resolve(unknown);
    expect((await initializing).available).toBe(false);
    await expect(chat.shutdown()).rejects.toThrow('fixture cleanup unknown');
  });
  it('records rejected completion without an unhandled rejection and fails shutdown', async () => {
    const { chat, transports } = setup();
    const initializing = chat.initialize();
    await tick();
    const probe = transports[0];
    if (!probe) throw new Error('missing probe');
    probe.done.reject(new Error('fixture done rejected'));
    probe.closing.reject(new Error('fixture close rejected'));
    await expect(chat.shutdown()).rejects.toThrow('fixture close rejected');
    expect((await initializing).available).toBe(false);
  });
  it('keeps protocol failure unavailable after confirmed physical cleanup', async () => {
    const { chat, transports } = setup();
    const initializing = chat.initialize();
    await tick();
    const probe = transports[0];
    if (!probe) throw new Error('missing probe');
    probe.reply({ protocolVersion: 999, agentCapabilities: {}, authMethods: [] });
    probe.done.resolve(success);
    probe.closing.resolve(success);
    expect(await initializing).toMatchObject({ available: false, reason: expect.stringContaining('不兼容') });
    await chat.shutdown();
  });
});
