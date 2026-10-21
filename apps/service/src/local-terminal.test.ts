import { mkdtemp, writeFile, access } from 'node:fs/promises';
import path from 'node:path';
import { tmpdir } from 'node:os';
import { expect, it, describe, vi } from 'vitest';
import { LocalTerminal } from './local-terminal';

const python = path.resolve(process.env['WSL_TEST_PYTHON'] ?? '/usr/bin/python3');
// Match the existing import-isolation and release-preflight functional bounds.
// This is a hang guard, not a startup performance SLO or a production deadline.
const readyTimeout = 5000;
const lifecycleTimeout = 15000;
const identity = {
  workspaceId: 'test',
  environmentId: 'local',
  resourceId: 'local-test',
  kind: 'terminal' as const,
  instanceId: 'local-instance',
  instanceGeneration: 1,
};

async function expectRunning(terminal: LocalTerminal) {
  const started = Date.now();
  try {
    await expect.poll(() => terminal.get().state, { timeout: readyTimeout }).toBe('running');
  } catch (error) {
    const snapshot = terminal.get();
    // State only: shell output, cwd and inherited environment may contain private data.
    console.error(
      JSON.stringify({
        probe: 'local-pty-start',
        elapsedMs: Date.now() - started,
        runtime: process.env['WSL_TEST_PYTHON'] ? 'configured' : 'system',
        state: snapshot.state,
        error: snapshot.error,
        cleanupPending: snapshot.cleanupPending,
      }),
    );
    throw error;
  }
}

async function open(terminal: LocalTerminal) {
  const opened = await terminal.open(80, 24);
  expect(opened.state).toBe('starting');
  if (!opened.sessionId) throw new Error('PTY did not allocate a session');
  return opened.sessionId;
}

// Register cleanup before open. One close attempt retains its production five-second bound;
// finally reports both an assertion failure and an independent cleanup failure.
async function withTerminal(terminal: LocalTerminal, run: (close: () => Promise<void>) => Promise<void>) {
  const failures: unknown[] = [];
  let closing: Promise<void> | undefined;
  const close = () => (closing ??= terminal.shutdown());
  try {
    await run(close);
  } catch (error) {
    failures.push(error);
  } finally {
    try {
      await close();
    } catch (error) {
      if (!failures.includes(error)) failures.push(error);
    }
  }
  if (failures.length === 1) throw failures[0];
  if (failures.length > 1) throw new AggregateError(failures, 'PTY assertion and cleanup failed');
}

describe('local terminal lifecycle', () => {
  it(
    'real local PTY: failed command preserves shell, zsh hooks report code, close settles',
    async () => {
      const terminal = new LocalTerminal(process.cwd(), identity, () => undefined, python);
      await withTerminal(terminal, async () => {
        const sessionId = await open(terminal);
        await expectRunning(terminal);
        const observation = terminal.observation;
        if (!observation) throw new Error('PTY observation is unavailable');
        terminal.write(sessionId, 'false\n');
        await expect.poll(async () => JSON.stringify((await observation.readCommand()).data)).toContain('"exitCode":1');
        expect(terminal.get().state).toBe('running');
        // The complete marker is absent from the input, so terminal echo cannot satisfy this assertion.
        terminal.write(sessionId, "printf '%s%s\\n' 'LOCAL_PTY_' 'OK'\n");
        await expect.poll(() => terminal.get().output).toContain('LOCAL_PTY_OK');
      });
      expect(terminal.get().state).toBe('closed');
      expect(terminal.get().cleanupPending).toBe(false);
    },
    lifecycleTimeout,
  );

  it(
    'bounds cleanup when foreground process ignores hangup',
    async () => {
      const terminal = new LocalTerminal(process.cwd(), identity, () => undefined, python);
      await withTerminal(terminal, async (close) => {
        const sessionId = await open(terminal);
        await expectRunning(terminal);
        terminal.write(sessionId, "trap '' HUP; printf '%s%s\\n' 'HUP_' 'READY'; sleep 60\n");
        await expect.poll(() => terminal.get().output).toContain('HUP_READY');
        await new Promise((resolve) => setTimeout(resolve, 100));
        const started = Date.now();
        await close();
        expect(Date.now() - started).toBeLessThan(5000);
        expect(terminal.get().state).toBe('closed');
        expect(terminal.get().cleanupPending).toBe(false);
      });
    },
    lifecycleTimeout,
  );

  it.each([1, 2, 3])(
    'consumes immediate close queued alongside start without losing the frame (case %i)',
    async () => {
      const states: string[] = [];
      const terminal = new LocalTerminal(process.cwd(), identity, (snapshot) => states.push(snapshot.state), python);
      await withTerminal(terminal, async (close) => {
        await open(terminal);
        await close();
        expect(terminal.get().state).toBe('closed');
        expect(terminal.get().cleanupPending).toBe(false);
        expect(states).toContain('closing');
        expect(states.slice(states.indexOf('closing'))).not.toContain('running');
      });
    },
    lifecycleTimeout,
  );

  // Allow a separate exit-observation bound and the finally cleanup if that assertion fails.
  it('normal shell exit confirms cleanup and closes the resource', async () => {
    const terminal = new LocalTerminal(process.cwd(), identity, () => undefined, python);
    await withTerminal(terminal, async () => {
      const sessionId = await open(terminal);
      await expectRunning(terminal);
      terminal.write(sessionId, "printf '%s%s\\n' 'BEFORE_' 'EXIT'; exit 0\n");
      await expect.poll(() => terminal.get().output).toContain('BEFORE_EXIT');
      await expect.poll(() => terminal.get().state, { timeout: 5000 }).toBe('closed');
      expect(terminal.get().cleanupPending).toBe(false);
      expect(terminal.get().error).toBeNull();
      expect(() => terminal.write(sessionId, 'true\n')).toThrow('unavailable');
    });
  }, 20000);
});

it(
  'local PTY observation retains the Main identity instead of using the shell session as resource',
  async () => {
    const mainIdentity = {
      workspaceId: 'w-other',
      environmentId: 'local',
      resourceId: 'terminal-stable',
      kind: 'terminal' as const,
      instanceId: 'main-instance',
      instanceGeneration: 4,
    };
    const terminal = new LocalTerminal(process.cwd(), mainIdentity, () => undefined, python);
    await withTerminal(terminal, async () => {
      const sessionId = await open(terminal);
      await expectRunning(terminal);
      expect(terminal.observation?.resource).toEqual(mainIdentity);
      expect(sessionId).not.toBe(mainIdentity.resourceId);
    });
  },
  lifecycleTimeout,
);

it(
  'rejects oversized UTF-8 Chinese input without closing the PTY and still runs the next command',
  async () => {
    const terminal = new LocalTerminal(process.cwd(), identity, () => undefined, python);
    await withTerminal(terminal, async () => {
      const sessionId = await open(terminal);
      await expectRunning(terminal);
      expect(() => terminal.write(sessionId, '中'.repeat(30000))).toThrow('input too large');
      terminal.write(sessionId, "printf '%s%s\\n' 'AFTER_REJECTED_' 'CHINESE_INPUT'\n");
      await expect.poll(() => terminal.get().output).toContain('AFTER_REJECTED_CHINESE_INPUT');
      expect(terminal.get().state).toBe('running');
    });
    expect(terminal.get().cleanupPending).toBe(false);
  },
  lifecycleTimeout,
);

it(
  'selected Python PTY isolates stdlib imports from cwd and PYTHONPATH',
  async () => {
    const root = await mkdtemp(path.join(tmpdir(), 'wsl-isolated-pty-'));
    for (const module of ['json', 'pty', 'signal'])
      await writeFile(path.join(root, module + '.py'), "raise RuntimeError('hostile-module-executed')");
    await access(python);
    vi.stubEnv('PYTHONPATH', root);
    try {
      const terminal = new LocalTerminal(root, identity, () => undefined, python);
      await withTerminal(terminal, async () => {
        const sessionId = await open(terminal);
        await expectRunning(terminal);
        terminal.write(sessionId, "printf '%s%s\\n' 'ISOLATED_PYTHON_' 'OK'\n");
        await expect.poll(() => terminal.get().output).toContain('ISOLATED_PYTHON_OK');
        expect(terminal.get().output).not.toContain('hostile-module-executed');
      });
    } finally {
      vi.unstubAllEnvs();
    }
  },
  lifecycleTimeout,
);
