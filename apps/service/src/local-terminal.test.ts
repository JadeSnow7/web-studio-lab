import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import helperSource from './local-terminal.py?raw';
import zshRc from './terminal-zsh-integration.sh?raw';
import bashRc from './terminal-bash-integration.sh?raw';
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

it(
  'HUP cleanup confirms the real sleep birth identity stopped, not just the helper acknowledgement',
  async () => {
    const probe = String.raw`
import sys, os, json, subprocess, base64, select, time, signal
helper, rc, cwd = sys.argv[1:4]
exec(helper.split('# Do not mix')[0], globals())
table = ProcessTable()
def info(pid):
    identity = table.identity(pid)
    if not identity:
        return None
    if sys.platform == 'darwin':
        value = table.BsdInfo()
        if table.libproc.proc_pidinfo(pid, 3, 0, ctypes.byref(value), ctypes.sizeof(value)) != ctypes.sizeof(value):
            raise RuntimeError('test process metadata unavailable')
        parent = value.ppid
        name = bytes(value.comm).split(b'\0', 1)[0].decode()
    else:
        contents = open('/proc/%d/stat' % pid).read()
        fields = contents.rsplit(')', 1)[1].split()
        parent = int(fields[1])
        name = contents.split('(', 1)[1].rsplit(')', 1)[0]
    return dict(pid=pid, identity=identity, parent=parent, name=name)
p = subprocess.Popen([sys.executable, '-I', '-B', '-u', '-c', helper], stdin=subprocess.PIPE, stdout=subprocess.PIPE, stderr=subprocess.PIPE, bufsize=0)
root = table.identity(p.pid)
known = {}
child = None
deadline = time.monotonic() + 10
output = ''
def send(value):
    p.stdin.write((json.dumps(value) + '\n').encode())
    p.stdin.flush()
def next_frame():
    if not select.select([p.stdout], [], [], max(0, min(5, deadline - time.monotonic())))[0]:
        raise RuntimeError('test PTY transport timed out')
    line = p.stdout.readline()
    if not line:
        raise RuntimeError('test PTY transport closed early')
    return json.loads(line)
try:
    send(dict(shell='/bin/zsh' if sys.platform == 'darwin' else '/bin/bash', cwd=cwd, cols=80, rows=24, rc=base64.b64encode(rc.encode()).decode()))
    assert next_frame()['type'] == 'ready'
    send(dict(type='input', data="trap '' HUP; printf '%s%s\\n' 'HUP_' 'READY'; sleep 60\n"))
    while 'HUP_READY' not in output:
        frame = next_frame()
        if frame['type'] == 'output':
            output += frame['data']
    time.sleep(.1)
    rows = {pid: row for pid in table.pids() if (row := info(pid))}
    descendants = {p.pid}
    while True:
        expanded = descendants | {pid for pid, row in rows.items() if row['parent'] in descendants}
        if expanded == descendants:
            break
        descendants = expanded
    assert table.identity(p.pid) == root
    for pid in descendants:
        row = rows[pid]
        assert row['identity'][0] == os.getuid() and table.identity(pid) == row['identity']
        known[pid] = row['identity']
    sleeps = [rows[pid] for pid in descendants if rows[pid]['name'] == 'sleep']
    assert len(sleeps) == 1
    child = sleeps[0]
    send(dict(type='close'))
    out, _err = p.communicate(timeout=max(.1, min(5, deadline - time.monotonic())))
    frames = [json.loads(line) for line in out.splitlines()]
    current = table.identity(child['pid'])
    alive = bool(current and current == child['identity'] and not current[2])
    print(json.dumps(dict(code=p.returncode, cleanup=[frame['ok'] for frame in frames if frame['type'] == 'cleanup'], sleepPid=child['pid'], sleepBirth=child['identity'][1], ownedBeforeClose=True, childAlive=alive)))
finally:
    # Also account for startup/assertion failures before the normal capture point.
    if table.identity(p.pid) == root:
        rows = {pid: row for pid in table.pids() if (row := info(pid))}
        descendants = {p.pid}
        while True:
            expanded = descendants | {pid for pid, row in rows.items() if row['parent'] in descendants}
            if expanded == descendants:
                break
            descendants = expanded
        if table.identity(p.pid) == root:
            for pid in descendants:
                row = rows.get(pid)
                if row and row['identity'][0] == os.getuid() and table.identity(pid) == row['identity']:
                    known[pid] = row['identity']
    # Exact parent-chain/birth evidence above authorizes these test-owned positive PIDs only.
    for pid, identity in known.items():
        current = table.identity(pid)
        if current and current == identity and current[0] == os.getuid() and not current[2] and table.identity(pid) == current:
            os.kill(pid, signal.SIGKILL)
    if p.poll() is None:
        p.kill()
        p.wait()
`;
    const { stdout } = await promisify(execFile)(python, [
      '-I',
      '-B',
      '-u',
      '-c',
      probe,
      helperSource,
      process.platform === 'darwin' ? zshRc : bashRc,
      process.cwd(),
    ]);
    const result: unknown = JSON.parse(stdout);
    console.info('[HUP child identity]', JSON.stringify(result));
    expect(result).toMatchObject({ code: 0, cleanup: [true], ownedBeforeClose: true, childAlive: false });
  },
  lifecycleTimeout,
);

it(
  'closes two idle PTYs in creation order while the surviving PTY remains usable',
  async () => {
    const a = new LocalTerminal(process.cwd(), { ...identity, resourceId: 'peer-a', instanceId: 'peer-a' }, () => undefined, python);
    const b = new LocalTerminal(process.cwd(), { ...identity, resourceId: 'peer-b', instanceId: 'peer-b' }, () => undefined, python);
    await withTerminal(a, async (closeA) => {
      await withTerminal(b, async (closeB) => {
        await open(a);
        await expectRunning(a);
        const bId = await open(b);
        await expectRunning(b);
        await expect.poll(() => b.get().output.length).toBeGreaterThan(0);
        await closeA();
        expect(a.get().cleanupPending).toBe(false);
        expect(b.get().state).toBe('running');
        b.write(bId, "printf '%s%s\\n' 'PEER_' 'SURVIVED'\n");
        await expect.poll(() => b.get().output).toContain('PEER_SURVIVED');
        await closeB();
        expect(b.get().cleanupPending).toBe(false);
      });
    });
  },
  lifecycleTimeout,
);

it(
  'carries current peer witnesses when input exits a shell normally',
  async () => {
    const a = new LocalTerminal(process.cwd(), { ...identity, resourceId: 'exit-a', instanceId: 'exit-a' }, () => undefined, python);
    const b = new LocalTerminal(process.cwd(), { ...identity, resourceId: 'exit-b', instanceId: 'exit-b' }, () => undefined, python);
    await withTerminal(a, async () => {
      await withTerminal(b, async () => {
        const aId = await open(a);
        await expectRunning(a);
        const bId = await open(b);
        await expectRunning(b);
        a.write(aId, 'exit\n');
        await expect.poll(() => a.get().state, { timeout: readyTimeout }).toBe('closed');
        expect(a.get().cleanupPending).toBe(false);
        b.write(bId, "printf '%s%s\\n' 'EXIT_PEER_' 'SURVIVED'\n");
        await expect.poll(() => b.get().output).toContain('EXIT_PEER_SURVIVED');
      });
    });
  },
  lifecycleTimeout,
);
