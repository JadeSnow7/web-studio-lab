import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import path from 'node:path';
import { expect, it } from 'vitest';
import helper from './local-terminal.py?raw';
const python = path.resolve(process.env['WSL_TEST_PYTHON'] ?? '/usr/bin/python3');

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
    p = subprocess.Popen([sys.executable, '-I', '-B', '-u', '-c', helper], stdin=subprocess.PIPE, stdout=subprocess.PIPE, stderr=subprocess.PIPE, text=True, env=env)
    child = None
    identity = None
    def send(value):
        p.stdin.write(json.dumps(value) + '\n')
        p.stdin.flush()
    try:
        send(dict(shell='/bin/bash', cwd=tmp, cols=80, rows=24, rc=base64.b64encode(b'PS1=""\n').decode()))
        assert json.loads(p.stdout.readline())['type'] == 'ready'
        # Publish only the complete PID: exists() must not expose the writer's empty file.
        code = "import os,time,signal; p=os.fork(); os._exit(0) if p else None; os.setsid(); signal.signal(signal.SIGHUP,signal.SIG_IGN); f=open(" + repr(path + '.tmp') + ",'w'); f.write(str(os.getpid())); f.close(); os.replace(" + repr(path + '.tmp') + "," + repr(path) + "); time.sleep(60)"
        send(dict(type='input', data=shlex.quote(sys.executable) + ' -I -B -c ' + shlex.quote(code) + '\n'))
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
        cleanup = [frame['ok'] for frame in frames if frame['type'] == 'cleanup']
        if p.returncode != 0 or cleanup != [True]:
            print(json.dumps(dict(helperPid=p.pid, childPid=child, childBirth=identity[1], childAlive=alive,
                                  helperExceptionType=err.splitlines()[-1].split(':', 1)[0] if err.splitlines() else None,
                                  diagnostic=[line for line in err.splitlines() if line.startswith('WSL_PTY_DIAGNOSTIC ')])), file=sys.stderr)
        print(json.dumps(dict(returncode=p.returncode, cleanup=cleanup, detachedAlive=alive)))
    finally:
        if child and identity:
            current = table.identity(child)
            if current == identity and not current[2] and table.marked(child) and table.identity(child) == identity:
                os.kill(child, signal.SIGKILL)
        if p.poll() is None:
            p.kill()
            p.wait()
`;
  const { stdout, stderr } = await promisify(execFile)(python, ['-I', '-B', '-c', 'import sys\n' + probe, helper], { timeout: 10000 });
  const receipt = JSON.parse(stdout);
  if (receipt.returncode !== 0) console.error('[PTY detached failure]', stderr);
  expect(receipt).toEqual({ returncode: 0, cleanup: [true], detachedAlive: false });
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
  const { stdout } = await promisify(execFile)(python, ['-I', '-B', '-c', probe, helper], { timeout: 5000 });
  expect(JSON.parse(stdout)).toEqual({ reusedSignal: false, unreadableSignal: false, unknown: true });
});

it('retains unknown for incomplete snapshots and never derives signal authority from hidden environment alone', async () => {
  const probe = String.raw`
import sys, json
exec(sys.argv[1].split('# Do not mix')[0], globals())
uid = os.getuid()
r, c, g, foreign = 1000001, 1000002, 1000003, 1000004
signals = []
os.kill = lambda pid, sig: signals.append(pid)
def make(with_foreign=False):
    table = ProcessTable()
    table.birth = (1, 0)
    table.root = (r, (2, 0))
    rows = {r: (uid, (2, 0), False, 1, 10, 11, 1, 5), c: (uid, (3, 0), False, r, 11, 12, 11, 10), g: (uid, (4, 0), False, c, 12, 13, 12, 11)}
    if with_foreign:
        rows[foreign] = (uid, (5, 0), False, 1, 13, 14, 999, 13)
    table.pids = lambda: list(rows)
    table.details = rows.get
    table.identity = lambda pid: rows[pid][:3] if pid in rows else None
    table.marked = lambda pid: None
    table.native_uniqueid = 1000
    table.native_identity = lambda pid: (1, 5, b'init')
    return table, rows
# A complete, twice-observed full chain can authorize specific positive PIDs; a foreign candidate cannot.
table, rows = make(True)
found = table.remaining()
assert set(found) == {r, c, g} and not table.complete
table.signal(found, signal.SIGTERM)
assert set(signals) == {r, c, g} and all(pid > 0 for pid in signals)
# Changed parent birth breaks the full chain, including an otherwise stable grandchild.
table, rows = make()
calls = {}
def changed_parent(pid):
    calls[pid] = calls.get(pid, 0) + 1
    return (uid, (30, 0), False, r, 11) if pid == c and calls[pid] > 1 else rows.get(pid)
table.details = changed_parent
found = table.remaining()
assert set(found) == {r} and not table.complete
# An exec change during observation never becomes an exclusion or permission to signal.
table, rows = make()
calls = {}
def exec_during_read(pid):
    calls[pid] = calls.get(pid, 0) + 1
    return (*rows[pid][:4], 99) if pid == c and calls[pid] > 1 else rows.get(pid)
table.details = exec_during_read
found = table.remaining()
assert c not in found and g not in found and not table.complete
# The same birth cannot bypass a new exec immediately before signalling.
table, rows = make()
found = table.remaining()
rows[c] = (*rows[c][:4], 99)
signals.clear()
try:
    table.signal({c: found[c]}, signal.SIGTERM)
except RuntimeError:
    pass
else:
    raise AssertionError('changed exec identity was accepted')
assert not signals
# Root forks after the old PID list and exits: empty known members are not a complete fresh scan.
table, rows = make()
table.pids = lambda: [r]
reads = iter([rows[r], None])
table.details = lambda pid: next(reads)
lists = iter([[r], [foreign]])
table.pids = lambda: next(lists)
assert not table.remaining() and not table.complete
rows.clear()  # The root really stopped; remembered birth reads must agree with that fact.
# A later stable scan still has an unowned hidden candidate and cannot clear it.
table.pids = lambda: [foreign]
table.details = lambda pid: (uid, (5, 0), False, 1, 13)
assert not table.remaining() and not table.complete
# Only a subsequent complete, stable empty scan establishes that candidate's absence.
table.pids = lambda: []
assert not table.remaining() and table.complete
# Disappearance while reading invalidates this snapshot even when its marker could not be read.
table, rows = make()
table.root = None
table.pids = lambda: [foreign]
reads = iter([(uid, (5, 0), False, 1, 13), None])
table.details = lambda pid: next(reads)
assert not table.remaining() and not table.complete
# A previously readable marker cannot be replaced by lineage to hide a changed/unreadable marker.
table, rows = make()
table.marked = lambda pid: True
found = table.remaining()
table.marked = lambda pid: False
signals.clear()
try:
    table.signal({c: found[c]}, signal.SIGTERM)
except RuntimeError:
    pass
else:
    raise AssertionError('changed marker was accepted through lineage')
assert not signals
# Proven ownership survives expected reparenting, while exec identity still cannot change.
table, rows = make()
found = table.remaining()
rows[c] = (*rows[c][:3], 1, *rows[c][4:])
signals.clear()
table.signal({c: found[c]}, signal.SIGTERM)
assert signals == [c]
# A peer root is an exclusion only with both exact births and its real helper parent chain.
peer_helper, peer_root, peer_child = 1000010, 1000011, 1000012
def peer_case():
    table, rows = make()
    rows[peer_helper] = (uid, (6, 0), False, 77, 15, 20, 77, 14)
    rows[peer_root] = (uid, (7, 0), False, peer_helper, 16, 21, 20, 15)
    rows[peer_child] = (uid, (8, 0), False, peer_root, 17, 22, 21, 16)
    table.set_peers([{'helper': {'pid': peer_helper, 'birth': [6, 0]}, 'root': {'pid': peer_root, 'birth': [7, 0]}}])
    return table, rows
table, rows = peer_case()
assert set(table.remaining()) == {r, c, g} and table.complete
for corruption in ['helper_birth', 'root_birth', 'root_parent', 'helper_gone']:
    table, rows = peer_case()
    if corruption == 'helper_birth':
        rows[peer_helper] = (uid, (60, 0), False, 77, 15, 23, 77, 14)
    elif corruption == 'root_birth':
        rows[peer_root] = (uid, (70, 0), False, peer_helper, 16, 24, 20, 15)
    elif corruption == 'root_parent':
        rows[peer_root] = (uid, (7, 0), False, 1, 16, 21, 20, 15)
    else:
        del rows[peer_helper]
    assert set(table.remaining()) == {r, c, g} and not table.complete
# An own marker/previously proven lineage conflicts with exclusion: neither signal nor success.
for conflict in ['marker', 'lineage']:
    table, rows = peer_case()
    if conflict == 'marker':
        table.marked = lambda pid: True if pid == peer_child else None
    else:
        table.lineage[peer_child] = (8, 0)
    found = table.remaining()
    assert peer_child not in found and not table.complete
    signals.clear()
    table.signal(found, signal.SIGTERM)
    assert peer_child not in signals
# A forged witness claiming the owned root cannot convert it to peer cleanup authority.
table, rows = make()
rows[peer_helper] = (uid, (1, 0), False, 77, 15, 20, 77, 14)
rows[r] = (*rows[r][:3], peer_helper, rows[r][4])
table.set_peers([{'helper': {'pid': peer_helper, 'birth': [1, 0]}, 'root': {'pid': r, 'birth': [2, 0]}}])
assert not table.remaining() and not table.complete
# Capability failure stays an explicit failure, never a negative marker or empty complete scan.
table, rows = make()
def unavailable():
    raise PermissionError('enumeration unavailable')
table.pids = unavailable
try:
    table.remaining()
except PermissionError:
    pass
else:
    raise AssertionError('enumeration denial was accepted')
assert not table.complete
print(json.dumps(dict(lineagePositiveOnly=True, hiddenForeignUnknown=True, changedParentUnknown=True, changedExecUnknown=True, oldForkListRejected=True, stableFreshScanAccepted=True, disappearanceUnknown=True, markerChangedUnknown=True, capabilityFailureUnknown=True, reparentPreservesOwnership=True, peerBirthChainRequired=True, peerConflictUnknown=True)))
`;
  const { stdout } = await promisify(execFile)(python, ['-I', '-B', '-c', probe, helper], { timeout: 5000 });
  expect(JSON.parse(stdout)).toEqual({
    lineagePositiveOnly: true,
    hiddenForeignUnknown: true,
    changedParentUnknown: true,
    changedExecUnknown: true,
    oldForkListRejected: true,
    stableFreshScanAccepted: true,
    disappearanceUnknown: true,
    markerChangedUnknown: true,
    capabilityFailureUnknown: true,
    reparentPreservesOwnership: true,
    peerBirthChainRequired: true,
    peerConflictUnknown: true,
  });
});

it.runIf(process.platform === 'darwin').each(['detached', 'unrelated'])(
  'keeps cleanup unknown and does not signal a protected %s process without independent ownership evidence',
  async (kind) => {
    const probe = String.raw`
import sys, os, subprocess, json, base64, tempfile, time, signal, shlex
helper, kind = sys.argv[1:3]
exec(helper.split('# Do not mix')[0], globals())
table = ProcessTable()
with tempfile.TemporaryDirectory(prefix='wsl-pty-unknown-') as tmp:
    p = subprocess.Popen([sys.executable, '-I', '-B', '-u', '-c', helper], stdin=subprocess.PIPE, stdout=subprocess.PIPE, stderr=subprocess.PIPE)
    child = None
    identity = None
    external = None
    def send(value):
        p.stdin.write((json.dumps(value) + '\n').encode())
        p.stdin.flush()
    try:
        send(dict(shell='/bin/zsh', cwd=tmp, cols=80, rows=24, rc=base64.b64encode(b'PS1=""\n').decode()))
        assert json.loads(p.stdout.readline())['type'] == 'ready'
        if kind == 'detached':
            path = tmp + '/child.pid'
            code = "import os,signal; child=os.fork(); os._exit(0) if child else None; os.setsid(); signal.signal(signal.SIGHUP,signal.SIG_IGN); f=open(" + repr(path + '.tmp') + ",'w'); f.write(str(os.getpid())); f.close(); os.replace(" + repr(path + '.tmp') + "," + repr(path) + "); os.execl('/bin/sleep','sleep','60')"
            send(dict(type='input', data=shlex.quote(sys.executable) + ' -I -B -c ' + shlex.quote(code) + '\n'))
            deadline = time.monotonic() + 5
            while not os.path.exists(path) and time.monotonic() < deadline:
                time.sleep(.02)
            child = int(open(path).read())
        else:
            external = subprocess.Popen(['/bin/sleep', '60'], start_new_session=True)
            child = external.pid
        identity = table.identity(child)
        assert identity and identity[0] == os.getuid()
        deadline = time.monotonic() + 5
        while table.marked(child) is not None and time.monotonic() < deadline:
            time.sleep(.02)
        assert table.marked(child) is None and table.identity(child) == identity
        send(dict(type='close'))
        out, _err = p.communicate(timeout=5)
        frames = [json.loads(line) for line in out.splitlines()]
        current = table.identity(child)
        alive = bool(current and current == identity and not current[2])
        print(json.dumps(dict(code=p.returncode, cleanup=[frame['ok'] for frame in frames if frame['type'] == 'cleanup'], hiddenCandidateAlive=alive)))
    finally:
        # The test controller created/observed this exact PID+birth; the PTY helper lacks that authority.
        if child and identity:
            current = table.identity(child)
            if current == identity and current[0] == os.getuid() and not current[2] and table.identity(child) == current:
                os.kill(child, signal.SIGKILL)
        if external is not None:
            external.wait(timeout=1)
        if p.poll() is None:
            p.kill()
            p.wait()
`;
    const { stdout } = await promisify(execFile)(python, ['-I', '-B', '-u', '-c', probe, helper, kind], { timeout: 10000 });
    expect(JSON.parse(stdout)).toEqual({ code: 1, cleanup: [false], hiddenCandidateAlive: true });
  },
  15000,
);

it.runIf(process.platform === 'darwin')(
  'rejects truncated process enumeration and marker reads instead of treating them as absence',
  async () => {
    const probe = String.raw`
import sys, json
exec(sys.argv[1].split('# Do not mix')[0], globals())
class TruncatedList:
    def proc_listpids(self, kind, uid, data, size):
        return 4 if data is None else size
class TruncatedMarker:
    def sysctl(self, mib, count, data, size, value, value_size):
        size._obj.value = 8 if data is None else 9
        return 0
table = ProcessTable()
table.libproc = TruncatedList()
try:
    table.pids()
except RuntimeError as error:
    assert 'incomplete' in str(error)
else:
    raise AssertionError('truncated enumeration accepted')
table.libc = TruncatedMarker()
try:
    table.read_marker(1000001)
except RuntimeError as error:
    assert 'incomplete' in str(error)
else:
    raise AssertionError('truncated marker read accepted')
print(json.dumps(dict(enumerationUnknown=True, markerUnknown=True)))
`;
    const { stdout } = await promisify(execFile)(python, ['-I', '-B', '-c', probe, helper], { timeout: 5000 });
    expect(JSON.parse(stdout)).toEqual({ enumerationUnknown: true, markerUnknown: true });
  },
);

it('rechecks confirmed disappearance during signal preparation with a fresh scan instead of permanently failing cleanup', async () => {
  const probe = String.raw`
import sys, json
exec(sys.argv[1].split('# Do not mix')[0], globals())
uid, pid, birth = os.getuid(), 1000020, (3, 0)
alive = (uid, birth, False)
observed = (*alive, 77, 10)
signals = []
os.kill = lambda pid, sig: signals.append(pid)
for scenario in ['details_absent', 'details_zombie', 'details_replaced', 'last_identity_absent', 'last_identity_zombie', 'last_identity_replaced']:
    table = ProcessTable()
    table.complete = True
    table.marked = lambda pid: True
    table.observed[pid] = observed
    identities = iter([alive, None if scenario == 'last_identity_absent' else (uid, (30, 0), False) if scenario == 'last_identity_replaced' else (uid, birth, True)])
    table.identity = lambda pid: next(identities)
    table.details = lambda pid: None if scenario == 'details_absent' else (uid, birth, True, 77, 10) if scenario == 'details_zombie' else (uid, (30, 0), False, 77, 10) if scenario == 'details_replaced' else observed
    table.signal({pid: birth}, signal.SIGTERM)
    assert not signals and not table.complete, scenario
    # A later fresh complete empty table can recover; this is not automatic helper restart.
    table.pids = lambda: []
    assert not table.remaining() and table.complete
for scenario in ['changed_uid', 'changed_exec', 'changed_exec_then_exit', 'read_denied']:
    table = ProcessTable()
    table.marked = lambda pid: True
    table.observed[pid] = observed
    identities = iter([alive, None])
    table.identity = (lambda pid: next(identities)) if scenario == 'changed_exec_then_exit' else (lambda pid: alive)
    def changed(pid):
        if scenario == 'read_denied':
            raise PermissionError('process detail unavailable')
        if scenario == 'changed_uid':
            return (uid + 1, birth, False, 77, 10)
        return (*alive, 77, 11)
    table.details = changed
    try:
        table.signal({pid: birth}, signal.SIGTERM)
    except (RuntimeError, PermissionError):
        pass
    else:
        raise AssertionError('changed identity/capability failure accepted: ' + scenario)
assert not signals
print(json.dumps(dict(exitedDuringSignalNotSent=True, freshScanCanConfirm=True, changedIdentityUnknown=True)))
`;
  const { stdout } = await promisify(execFile)(python, ['-I', '-B', '-c', probe, helper], { timeout: 5000 });
  expect(JSON.parse(stdout)).toEqual({ exitedDuringSignalNotSent: true, freshScanCanConfirm: true, changedIdentityUnknown: true });
});

it('retains known birth identities across UID-filtered scans without signalling a live changed-UID process', async () => {
  const probe = String.raw`
import sys, json
exec(sys.argv[1].split('# Do not mix')[0], globals())
uid, root, child = os.getuid(), 1000030, 1000031
signals = []
os.kill = lambda pid, sig: signals.append(pid)
def known_table():
    table = ProcessTable()
    table.birth = (1, 0)
    table.root = (root, (2, 0))
    rows = {root: (uid, (2, 0), False, 1, 10), child: (uid, (3, 0), False, root, 11)}
    table.pids = lambda: list(rows)
    table.details = rows.get
    table.identity = lambda pid: rows[pid][:3] if pid in rows else None
    table.marked = lambda pid: True
    assert set(table.remaining()) == {root, child} and table.complete
    return table, rows
# The UID-filtered enumeration drops both PIDs, but the remembered child still has the same live birth.
table, rows = known_table()
rows.clear()
rows[child] = (uid + 1, (3, 0), False, 1, 11)
table.pids = lambda: []
for scan in range(3):
    try:
        table.remaining()
    except RuntimeError:
        pass
    else:
        raise AssertionError('live known birth vanished from UID-filtered scan')
    assert not table.complete
try:
    table.signal({child: (3, 0)}, signal.SIGKILL)
except RuntimeError:
    pass
else:
    raise AssertionError('initial changed UID was silently dropped')
assert not signals
# Each independent source of known authority must survive the UID-filtered enumeration.
for proof in ['member_only', 'lineage_only', 'root_only']:
    table, rows = known_table()
    if proof == 'member_only':
        table.root = None
        table.lineage.clear()
        pid, birth = child, (3, 0)
    elif proof == 'lineage_only':
        table.root = None
        table.members.clear()
        pid, birth = child, (3, 0)
    else:
        table.members.clear()
        table.lineage.clear()
        pid, birth = root, (2, 0)
    rows.clear()
    rows[pid] = (uid + 1, birth, False, 1, 11)
    table.pids = lambda: []
    try:
        table.remaining()
    except RuntimeError:
        pass
    else:
        raise AssertionError('lost independent known proof: ' + proof)
    assert not table.complete
# A missing identity, same-birth zombie, or replaced birth proves that the original child has stopped.
for replacement in [None, (uid + 1, (3, 0), True, 1, 11), (uid + 1, (30, 0), False, 1, 12)]:
    table, rows = known_table()
    rows.clear()
    if replacement:
        rows[child] = replacement
    table.pids = lambda: []
    assert not table.remaining() and table.complete
    table.signal({child: (3, 0)}, signal.SIGKILL)
assert not signals
# A changed UID between scans cannot be converted to absence; denied direct inspection is unknown.
table, rows = known_table()
table.pids = lambda: []
def denied(pid):
    raise PermissionError('known identity unavailable')
table.identity = denied
try:
    table.remaining()
except PermissionError:
    pass
else:
    raise AssertionError('known identity read failure was accepted')
assert not table.complete and not signals
print(json.dumps(dict(knownUidDriftUnknown=True, repeatedFilteredScansUnknown=True, changedUidNotSignalled=True, stoppedBirthsCanConfirm=True, inspectionFailureUnknown=True)))
`;
  const { stdout } = await promisify(execFile)(python, ['-I', '-B', '-c', probe, helper], { timeout: 5000 });
  expect(JSON.parse(stdout)).toEqual({
    knownUidDriftUnknown: true,
    repeatedFilteredScansUnknown: true,
    changedUidNotSignalled: true,
    stoppedBirthsCanConfirm: true,
    inspectionFailureUnknown: true,
  });
});

it.runIf(process.platform === 'darwin')(
  'uses only stable direct-init native provenance as negative evidence without signalling or covering positive ownership',
  async () => {
    const probe = String.raw`
import sys, json
exec(sys.argv[1].split('# Do not mix')[0], globals())
uid, candidate, root, helper_pid = os.getuid(), 1000101, 1000102, 1000103
signals = []
os.kill = lambda pid, sig: signals.append(pid)
def make():
    table = ProcessTable()
    table.birth = (10, 0)
    table.native_uniqueid = 100
    table.root = None
    row = [uid, (20, 0), False, 1, 800, 150, 1, 572]
    rows = {candidate: tuple(row)}
    table.pids = lambda: list(rows)
    table.details = rows.get
    table.identity = lambda pid: rows[pid][:3] if pid in rows else None
    table.marked = lambda pid: None
    table.native_identity = lambda pid: (1, 572, b'complete-init-record')
    return table, rows
# The old implementation treats this complete native negative proof as unknown.
table, rows = make()
assert not table.remaining() and table.complete, 'stable direct-init candidate blocked despite no positive ownership'
table.signal({}, signal.SIGKILL)
assert not signals
# No current PPID, name, UID, or generic old ancestor can substitute for the exact native parent pair.
for index, value in [(5, 0), (6, 0), (6, 99), (7, 0), (7, 573)]:
    table, rows = make()
    row = list(rows[candidate]); row[index] = value; rows[candidate] = tuple(row)
    assert not table.remaining() and not table.complete
# An orphan may exec with parent_uniqueid reset to init while keeping its creator's original version.
table, rows = make()
row = list(rows[candidate]); row[7] = 700; rows[candidate] = tuple(row)
assert not table.remaining() and not table.complete
# Missing/short/denied native reads are unavailable proof, never absence or exclusion.
for unavailable in [None, (0, 572, b'zero-init'), (1, 0, b'zero-version'), (101, 572, b'newer-init')]:
    table, rows = make()
    table.native_identity = lambda pid: unavailable
    assert not table.remaining() and not table.complete
for changed in [(2, 572, b'new-unique'), (1, 573, b'new-version'), (1, 572, b'changed-record')]:
    table, rows = make()
    reads = iter([(1, 572, b'complete-init-record'), changed])
    table.native_identity = lambda pid: next(reads)
    assert not table.remaining() and not table.complete
# Exercise the actual flavor17 boundary: short and permission-denied reads remain unavailable proof.
for size, error in [(55, 0), (0, errno.EPERM)]:
    table, rows = make()
    del table.native_identity
    class UnavailableNative:
        def proc_pidinfo(self, pid, flavor, arg, data, capacity):
            assert pid == 1 and flavor == 17 and capacity == 56
            ctypes.set_errno(error)
            return size
    table.libproc = UnavailableNative()
    assert not table.remaining() and not table.complete
for helper_id in [None, 0]:
    table, rows = make()
    table.native_uniqueid = helper_id
    assert not table.remaining() and not table.complete
# Missing/denied candidate metadata cannot become a negative match.
table, rows = make()
table.details = lambda pid: None
assert not table.remaining() and not table.complete
table, rows = make()
def denied_candidate(pid):
    raise PermissionError('candidate native identity unavailable')
table.details = denied_candidate
try:
    table.remaining()
except PermissionError:
    pass
else:
    raise AssertionError('candidate denial was accepted')
assert not table.complete
# Candidate exec/birth/native ancestry drift invalidates the entire scan even if init stays stable.
for index, value in [(1, (21, 0)), (4, 801), (5, 151), (6, 2), (7, 573)]:
    table, rows = make()
    first = rows[candidate]
    second = list(first); second[index] = value
    reads = iter([first, tuple(second)])
    table.details = lambda pid: next(reads)
    assert not table.remaining() and not table.complete
# Marker or already proven birth ownership takes precedence over this negative witness.
for proof in ['marker', 'root', 'member', 'lineage']:
    table, rows = make()
    birth = rows[candidate][1]
    if proof == 'marker':
        table.marked = lambda pid: True
    elif proof == 'root':
        table.root = (candidate, birth)
    elif proof == 'member':
        table.members[candidate] = birth
    else:
        table.lineage[candidate] = birth
    try:
        found = table.remaining()
    except RuntimeError:
        assert proof == 'member'  # A formerly readable marker may not disappear through the negative path.
        assert not table.complete
    else:
        assert found.get(candidate) == birth, proof
# An unverified peer claiming this exact birth cannot be bypassed through the init exclusion.
table, rows = make()
table.set_peers([{'helper': {'pid': helper_pid, 'birth': [11, 0]}, 'root': {'pid': candidate, 'birth': [20, 0]}}])
assert not table.remaining() and not table.complete
# Positive marker plus peer proof conflict remains unknown and does not add the peer candidate to signals.
table, rows = make()
rows[helper_pid] = (uid, (11, 0), False, 77, 600, 120, 77, 500)
row = list(rows[candidate]); row[3] = helper_pid; rows[candidate] = tuple(row)
table.set_peers([{'helper': {'pid': helper_pid, 'birth': [11, 0]}, 'root': {'pid': candidate, 'birth': [20, 0]}}])
table.marked = lambda pid: True if pid == candidate else False
found = table.remaining()
assert candidate not in found and not table.complete
assert not signals
print(json.dumps(dict(directInitNegative=True, orphanExecUnknown=True, nativeDriftUnknown=True, positiveOwnershipPreserved=True, peerConflictUnknown=True, noSignals=True)))
`;
    const { stdout } = await promisify(execFile)(python, ['-I', '-B', '-c', probe, helper], { timeout: 5000 });
    expect(JSON.parse(stdout)).toEqual({
      directInitNegative: true,
      orphanExecUnknown: true,
      nativeDriftUnknown: true,
      positiveOwnershipPreserved: true,
      peerConflictUnknown: true,
      noSignals: true,
    });
  },
);
