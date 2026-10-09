import { mkdtemp, writeFile, access } from 'node:fs/promises';
import path from 'node:path';
import { tmpdir } from 'node:os';
import { vi } from 'vitest';
import { expect, it, describe } from 'vitest';
import { LocalTerminal } from './local-terminal';
describe('local terminal lifecycle', () => {
  it('real local PTY: failed command preserves shell, zsh hooks report code, close settles', async () => {
    const terminal = new LocalTerminal(
      process.cwd(),
      {
        workspaceId: 'test',
        environmentId: 'local',
        resourceId: 'local-test',
        kind: 'terminal',
        instanceId: 'local-instance',
        instanceGeneration: 1,
      },
      () => undefined,
    );
    const opened = await terminal.open(80, 24);
    try {
      await expect.poll(() => terminal.get().state).toBe('running');
      terminal.write(opened.sessionId!, 'false\n');
      await expect.poll(async () => JSON.stringify((await terminal.observation!.readCommand()).data)).toContain('"exitCode":1');
      expect(terminal.get().state).toBe('running');
      terminal.write(opened.sessionId!, "printf 'LOCAL_PTY_OK\\n'\n");
      await expect.poll(() => terminal.get().output).toContain('LOCAL_PTY_OK');
    } finally {
      await terminal.close(opened.sessionId!);
    }
    expect(terminal.get().state).toBe('closed');
  }, 15000);
  it('bounds cleanup when foreground process ignores hangup', async () => {
    const terminal = new LocalTerminal(
      process.cwd(),
      {
        workspaceId: 'test',
        environmentId: 'local',
        resourceId: 'local-test',
        kind: 'terminal',
        instanceId: 'local-instance',
        instanceGeneration: 1,
      },
      () => undefined,
    );
    const opened = await terminal.open(80, 24);
    await expect.poll(() => terminal.get().state).toBe('running');
    terminal.write(opened.sessionId!, "trap '' HUP; sleep 60\n");
    await new Promise((resolve) => setTimeout(resolve, 100));
    const started = Date.now();
    await terminal.close(opened.sessionId!);
    expect(Date.now() - started).toBeLessThan(5000);
    expect(terminal.get().cleanupPending).toBe(false);
  }, 10000);
  it('consumes immediate close queued alongside start without losing the frame', async () => {
    for (let attempt = 0; attempt < 3; attempt++) {
      const states: string[] = [];
      const terminal = new LocalTerminal(
        process.cwd(),
        {
          workspaceId: 'test',
          environmentId: 'local',
          resourceId: 'local-test',
          kind: 'terminal',
          instanceId: 'local-instance',
          instanceGeneration: 1,
        },
        (snapshot) => states.push(snapshot.state),
      );
      const opened = await terminal.open(80, 24);
      expect(opened.state).toBe('starting');
      await terminal.close(opened.sessionId!);
      expect(terminal.get().state).toBe('closed');
      expect(terminal.get().cleanupPending).toBe(false);
      expect(states.slice(states.indexOf('closing'))).not.toContain('running');
    }
  }, 15000);
});

it('local PTY observation retains the Main identity instead of using the shell session as resource', async () => {
  const identity = {
    workspaceId: 'w-other',
    environmentId: 'local',
    resourceId: 'terminal-stable',
    kind: 'terminal' as const,
    instanceId: 'main-instance',
    instanceGeneration: 4,
  };
  const terminal = new LocalTerminal(process.cwd(), identity, () => undefined);
  const opened = await terminal.open(80, 24);
  try {
    await expect.poll(() => terminal.get().state).toBe('running');
    expect(terminal.observation?.resource).toEqual(identity);
    expect(opened.sessionId).not.toBe(identity.resourceId);
  } finally {
    await terminal.close(opened.sessionId!);
  }
});

it('rejects oversized UTF-8 Chinese input without closing the PTY and still runs the next command', async () => {
  const terminal = new LocalTerminal(
    process.cwd(),
    {
      workspaceId: 'w',
      environmentId: 'local',
      resourceId: 'terminal-input',
      kind: 'terminal',
      instanceId: 'instance-input',
      instanceGeneration: 1,
    },
    () => {},
  );
  const opened = await terminal.open(80, 24);
  await expect.poll(() => terminal.get().state).toBe('running');
  let writeError: unknown;
  try {
    terminal.write(opened.sessionId!, '中'.repeat(30000));
  } catch (error) {
    writeError = error;
  }
  if (writeError) {
    terminal.write(opened.sessionId!, "printf 'AFTER_REJECTED_CHINESE_INPUT\\n'\n");
    await expect.poll(() => terminal.get().output).toContain('AFTER_REJECTED_CHINESE_INPUT');
    expect(terminal.get().state).toBe('running');
  } else {
    await expect.poll(() => terminal.get().state).toBe('failed');
  }
  const shutdown = await Promise.allSettled([terminal.shutdown()]);
  expect(writeError).toBeInstanceOf(Error);
  expect((writeError as Error).message).toBe('input too large');
  expect(shutdown[0]?.status).toBe('fulfilled');
}, 15000);

it('bundled Python PTY isolates stdlib imports from cwd and PYTHONPATH', async () => {
  const root = await mkdtemp(path.join(tmpdir(), 'wsl-isolated-pty-'));
  for (const module of ['json', 'pty', 'signal'])
    await writeFile(path.join(root, module + '.py'), "raise RuntimeError('hostile-module-executed')");
  const python = path.resolve(process.env['WSL_TEST_PYTHON'] ?? '/usr/bin/python3');
  await access(python);
  vi.stubEnv('PYTHONPATH', root);
  const terminal = new LocalTerminal(
    root,
    { workspaceId: 'w', environmentId: 'local', resourceId: 'r', kind: 'terminal', instanceId: 'i', instanceGeneration: 1 },
    () => undefined,
    python,
  );
  try {
    const started = await terminal.open(80, 24);
    await expect.poll(() => terminal.get().state, { timeout: 5000 }).toBe('running');
    terminal.write(started.sessionId!, "printf 'ISOLATED_PYTHON_OK\\n'\n");
    await expect.poll(() => terminal.get().output).toContain('ISOLATED_PYTHON_OK');
    expect(terminal.get().output).not.toContain('hostile-module-executed');
    await terminal.close(started.sessionId!);
  } finally {
    vi.unstubAllEnvs();
    await terminal.shutdown();
  }
}, 15000);
