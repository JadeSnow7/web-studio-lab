import path from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { profileDirOf } from '@wsl/protocol';
import { CodexChat } from './codex-chat';
import { GuestProcess, SbxConnection, type GuestOutcome } from './sbx';
import { claudeCodeAcp } from './harness/acp/agents';

const success: GuestOutcome = { confirmed: true, exitCode: 0, error: null };
const unknown: GuestOutcome = { confirmed: false, exitCode: null, error: 'profile cleanup unknown' };
const status = { available: true, reason: null, version: 'fixture', sandbox: 'fixture', cwd: '/scratch' };
const tick = () => new Promise<void>((resolve) => setImmediate(resolve));
function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (reason: Error) => void;
  const promise = new Promise<T>((yes, no) => {
    resolve = yes;
    reject = no;
  });
  return { promise, resolve, reject };
}
afterEach(() => vi.restoreAllMocks());
function setup(onStart?: () => void) {
  const connection = new SbxConnection();
  vi.spyOn(connection, 'getStatus').mockReturnValue(status);
  vi.spyOn(connection, 'getCleanupPending').mockReturnValue(false);
  vi.spyOn(connection, 'shutdown').mockResolvedValue();
  const transports: Array<{
    done: ReturnType<typeof deferred<GuestOutcome>>;
    closing: ReturnType<typeof deferred<GuestOutcome>>;
    close: GuestProcess['close'];
    emit: (data: string) => void;
    physicalClose: () => Promise<void>;
  }> = [];
  vi.spyOn(connection, 'start').mockImplementation((_start, frame) => {
    const ready = deferred<void>();
    let pid: number | undefined;
    const remote = new GuestProcess(
      path.resolve('e2e/fixtures/sbx.mjs'),
      'profile-lifecycle-fixture',
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
    const physicalClose = async () => {
      await ready.promise;
      Object.defineProperty(remote, 'done', { value: nativeDone, configurable: true });
      expect((await nativeClose()).confirmed).toBe(true);
      expect(pid).toBeDefined();
      const fixturePid = pid;
      if (fixturePid !== undefined) expect(() => process.kill(fixturePid, 0)).toThrow(/ESRCH/);
    };
    transports.push({ done, closing, close, physicalClose, emit: (data) => frame({ type: 'output', stream: 'stdout', data }) });
    onStart?.();
    return remote;
  });
  const chat = new CodexChat('.', vi.fn(), connection, [{ kind: 'acp', spec: claudeCodeAcp }]);
  const checks: Array<Promise<unknown>> = [];
  const check = (last = 'a') => {
    const id = 'a1b2c3d4-0000-4000-8000-00000000000' + last;
    const result = chat.checkProfile('claude-code', profileDirOf('claude-code', id)).catch((error: unknown) => error);
    checks.push(result);
    return result;
  };
  const receipt = (last = 'a') => {
    const id = 'a1b2c3d4-0000-4000-8000-00000000000' + last;
    const result = chat.checkProfileReceipt('claude-code', profileDirOf('claude-code', id));
    checks.push(result);
    return result;
  };
  const dispose = async () => {
    // The old implementation may launch its status command after the first command settles.
    for (let cursor = 0; cursor < transports.length; cursor++) {
      const probe = transports[cursor]!;
      await probe.physicalClose();
      probe.done.resolve(success);
      probe.closing.resolve(success);
      await tick();
    }
    await Promise.all(checks);
  };
  return { chat, connection, transports, check, receipt, dispose };
}

describe('Profile self-check shutdown ownership', () => {
  it('attests a no-start validation error as clean without exposing business transport metadata', async () => {
    const f = setup();
    try {
      expect(await f.chat.checkProfileReceipt('unregistered', null)).toMatchObject({
        type: 'profile-check',
        ok: false,
        cleanupConfirmed: true,
      });
      expect(f.connection.start).not.toHaveBeenCalled();
      await f.chat.shutdown();
    } finally {
      await f.dispose();
    }
  });
  it('retains an unreturned process-start attempt as unknown in both its receipt and shutdown', async () => {
    const f = setup();
    vi.mocked(f.connection.start).mockImplementationOnce(() => {
      throw new Error('start ownership lost');
    });
    try {
      expect(await f.receipt()).toEqual({ type: 'profile-check', ok: false, error: 'start ownership lost', cleanupConfirmed: false });
      await expect(f.chat.shutdown()).rejects.toThrow('启动归属未确认');
    } finally {
      await f.dispose();
    }
  });
  it.each(['unknown', 'rejected'] as const)('carries %s cleanup in the same operation receipt', async (kind) => {
    const f = setup();
    const receipt = f.receipt();
    try {
      await tick();
      const probe = f.transports[0]!;
      await probe.physicalClose();
      if (kind === 'unknown') probe.done.resolve(unknown);
      else probe.done.reject(new Error('done unavailable'));
      const value = await receipt;
      expect(value).toMatchObject({ type: 'profile-check', cleanupConfirmed: false });
      if (kind === 'unknown') expect(value).toMatchObject({ ok: true, result: { login: 'undetermined' } });
      else expect(value).toMatchObject({ ok: false, error: 'done unavailable' });
    } finally {
      await f.dispose();
    }
  });
  it('keeps each concurrent receipt bound to its own processes when one cleanup is unknown', async () => {
    const f = setup();
    const unknownReceipt = f.receipt('a');
    const cleanReceipt = f.receipt('b');
    try {
      await tick();
      const a = f.transports[0]!;
      const b = f.transports[1]!;
      b.emit('fixture v1');
      await b.physicalClose();
      b.done.resolve(success);
      b.closing.resolve(success);
      await tick();
      const login = f.transports[2]!;
      await a.physicalClose();
      a.done.resolve(unknown);
      a.closing.resolve(unknown);
      login.emit('{"loggedIn":true}');
      await login.physicalClose();
      login.done.resolve(success);
      login.closing.resolve(success);
      expect(await unknownReceipt).toMatchObject({ cleanupConfirmed: false });
      expect(await cleanReceipt).toEqual({
        type: 'profile-check',
        ok: true,
        result: { cliVersion: 'fixture v1', login: 'logged_in', reason: null },
        cleanupConfirmed: true,
      });
      await expect(f.chat.shutdown()).rejects.toThrow('profile cleanup unknown');
    } finally {
      await f.dispose();
    }
  });
  it('owns a queued check before its first process can start', async () => {
    const f = setup();
    const checking = f.check();
    try {
      await f.chat.shutdown();
      expect(await checking).toBeInstanceOf(Error);
      expect(f.connection.start).not.toHaveBeenCalled();
    } finally {
      await f.dispose();
    }
  });
  it('owns a process returned after a synchronous shutdown callback during start', async () => {
    let shutdown: Promise<void> | undefined;
    const f = setup(() => {
      shutdown = f.chat.shutdown();
    });
    const checking = f.check();
    try {
      await tick();
      const probe = f.transports[0]!;
      expect(probe.close).toHaveBeenCalledOnce();
      let settled = false;
      const observed = shutdown?.then(() => {
        settled = true;
      });
      probe.closing.resolve(success);
      await tick();
      expect(settled).toBe(false);
      await probe.physicalClose();
      probe.done.resolve(success);
      await observed;
      expect(await checking).toBeInstanceOf(Error);
      expect(f.connection.start).toHaveBeenCalledOnce();
    } finally {
      await f.dispose();
      await shutdown;
    }
  });
  it.each(['version', 'status'] as const)(
    'owns both concurrent Profile processes during %s and waits beyond close acceptance',
    async (phase) => {
      const f = setup();
      const checks = [f.check('a'), f.check('b')];
      let shutdown: Promise<void> | undefined;
      try {
        await tick();
        expect(f.transports).toHaveLength(2);
        if (phase === 'status') {
          for (const version of f.transports.slice()) {
            version.emit('fixture v1');
            await version.physicalClose();
            version.done.resolve(success);
            version.closing.resolve(success);
          }
          await tick();
          expect(f.transports).toHaveLength(4);
        }
        const active = f.transports.slice(phase === 'status' ? 2 : 0);
        const count = f.transports.length;
        let settled = false;
        shutdown = Promise.all([f.chat.shutdown(), f.chat.shutdown()]).then(() => {
          settled = true;
        });
        await tick();
        expect(active.map((probe) => vi.mocked(probe.close).mock.calls.length)).toEqual([1, 1]);
        expect(settled).toBe(false);
        for (const probe of active) probe.closing.resolve(success);
        await tick();
        expect(settled).toBe(false);
        for (const probe of active) {
          probe.emit('{"loggedIn":true}');
          await probe.physicalClose();
          probe.done.resolve(success);
        }
        await shutdown;
        expect(f.transports).toHaveLength(count);
        for (const result of await Promise.all(checks)) expect(result).toBeInstanceOf(Error);
        await expect(f.chat.checkProfile('claude-code', null)).rejects.toThrow('关闭');
        expect(f.connection.start).toHaveBeenCalledTimes(count);
      } finally {
        await f.dispose();
        await shutdown;
      }
    },
  );

  it.each(['unknown', 'rejected'] as const)('retains %s process cleanup and refuses shutdown success or another check', async (kind) => {
    const f = setup();
    const checking = f.check();
    try {
      await tick();
      const probe = f.transports[0]!;
      await probe.physicalClose();
      if (kind === 'unknown') {
        probe.done.resolve(unknown);
        probe.closing.resolve(unknown);
      } else {
        probe.done.reject(new Error('profile done rejected'));
      }
      await checking;
      const following = f.check('b');
      await tick();
      expect(f.connection.start).toHaveBeenCalledOnce();
      expect(await following).toBeInstanceOf(Error);
      const shutting = f.chat.shutdown();
      if (kind === 'rejected') {
        await tick();
        probe.closing.reject(new Error('profile close rejected'));
      }
      await expect(shutting).rejects.toThrow(/profile/);
    } finally {
      await f.dispose();
    }
  });

  it('returns a normal two-stage login result and releases both confirmed processes before shutdown', async () => {
    const f = setup();
    const checking = f.check();
    try {
      await tick();
      const version = f.transports[0]!;
      version.emit('fixture v1');
      await version.physicalClose();
      version.done.resolve(success);
      version.closing.resolve(success);
      await tick();
      const login = f.transports[1]!;
      login.emit('{"loggedIn":true}');
      await login.physicalClose();
      login.done.resolve(success);
      login.closing.resolve(success);
      expect(await checking).toEqual({ cliVersion: 'fixture v1', login: 'logged_in', reason: null });
      await f.chat.shutdown();
      expect(version.close).not.toHaveBeenCalled();
      expect(login.close).not.toHaveBeenCalled();
    } finally {
      await f.dispose();
    }
  });
});
