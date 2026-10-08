import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { expect, it } from 'vitest';
import helper from './local-terminal.py?raw';

it('cleans an inherited owned child after fork, reparenting and setsid without claiming an OS sandbox', async () => {
  const probe = String.raw`
import os, subprocess, json, base64, tempfile, time, signal, shlex, uuid
helper = sys.argv[1]
# Reuse exactly the helper's birth/marker checks for failure-path test cleanup.
exec(helper.split('# Do not mix')[0], globals())
owner = ('WSL_TEST_CHILD=' + uuid.uuid4().hex).encode()
table = ProcessTable()
with tempfile.TemporaryDirectory(prefix='wsl-owned-detached-test-') as tmp:
    path = tmp + '/owned.pid'
    env = dict(os.environ)
    env['WSL_TEST_CHILD'] = owner.split(b'=', 1)[1].decode('ascii')
    p = subprocess.Popen(['/usr/bin/python3', '-u', '-c', helper], stdin=subprocess.PIPE, stdout=subprocess.PIPE, stderr=subprocess.PIPE, text=True, env=env)
    child = None
    identity = None
    def send(value):
        p.stdin.write(json.dumps(value) + '\n')
        p.stdin.flush()
    try:
        send(dict(shell='/bin/bash', cwd=tmp, cols=80, rows=24, rc=base64.b64encode(b'PS1=""\n').decode()))
        assert json.loads(p.stdout.readline())['type'] == 'ready'
        code = "import os,time,signal; p=os.fork(); os._exit(0) if p else None; os.setsid(); signal.signal(signal.SIGHUP,signal.SIG_IGN); open(" + repr(path) + ",'w').write(str(os.getpid())); time.sleep(60)"
        send(dict(type='input', data='/usr/bin/python3 -c ' + shlex.quote(code) + '\n'))
        deadline = time.monotonic() + 5
        while not os.path.exists(path) and time.monotonic() < deadline:
            time.sleep(.02)
        child = int(open(path).read())
        identity = table.identity(child)
        assert identity and table.marked(child)
        send(dict(type='close'))
        out, err = p.communicate(timeout=5)
        current = table.identity(child)
        alive = bool(current and current == identity and not current[2])
        frames = [json.loads(line) for line in out.splitlines()]
        print(json.dumps(dict(returncode=p.returncode, cleanup=[frame['ok'] for frame in frames if frame['type'] == 'cleanup'], detachedAlive=alive)))
    finally:
        if child and identity:
            current = table.identity(child)
            if current == identity and not current[2] and table.marked(child) and table.identity(child) == identity:
                os.kill(child, signal.SIGKILL)
        if p.poll() is None:
            p.kill()
            p.wait()
`;
  const { stdout } = await promisify(execFile)('/usr/bin/python3', ['-c', 'import sys\n' + probe, helper], { timeout: 10000 });
  expect(JSON.parse(stdout)).toEqual({ returncode: 0, cleanup: [true], detachedAlive: false });
}, 15000);

it('never signals a reused birth identity or an unreadable owned marker', async () => {
  const probe = String.raw`
import sys, json
exec(sys.argv[1].split('# Do not mix')[0], globals())
processes.root = None
signals = []
os.kill = lambda pid, sig: signals.append((pid, sig))
processes.identity = lambda pid: (os.getuid(), (2, 2), False)
processes.marked = lambda pid: True
processes.signal({1234: (1, 1)}, signal.SIGKILL)
assert not signals
processes.identity = lambda pid: (os.getuid(), (1, 1), False)
def unavailable(pid):
    raise PermissionError('owned marker inspection unavailable')
processes.marked = unavailable
unknown = False
try:
    processes.signal({1234: (1, 1)}, signal.SIGKILL)
except PermissionError:
    unknown = True
assert not signals
print(json.dumps(dict(reusedSignal=False, unreadableSignal=False, unknown=unknown)))
`;
  const { stdout } = await promisify(execFile)('/usr/bin/python3', ['-c', probe, helper], { timeout: 5000 });
  expect(JSON.parse(stdout)).toEqual({ reusedSignal: false, unreadableSignal: false, unknown: true });
});
