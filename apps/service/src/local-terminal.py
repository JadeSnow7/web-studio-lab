"""Owned local PTY transport. No network listener, no global shell configuration."""
import base64, codecs, ctypes, errno, fcntl, json, os, pty, select, signal, struct, sys, tempfile, termios, time, uuid

def emit(value):
    print(json.dumps(value), flush=True)

def resize(fd, cols, rows):
    if not (2 <= cols <= 500 and 1 <= rows <= 300):
        raise ValueError("invalid terminal size")
    fcntl.ioctl(fd, termios.TIOCSWINSZ, struct.pack("HHHH", rows, cols, 0, 0))

# This marker tracks normally inherited owned processes, not an OS sandbox.
# Never expose process arguments or environment values through the transport.
owner = ('WSL_PTY_OWNER=' + uuid.uuid4().hex).encode()

class ProcessTable:
    def __init__(self):
        if sys.platform == 'darwin':
            self.libproc = ctypes.CDLL('/usr/lib/libproc.dylib', use_errno=True)
            self.libc = ctypes.CDLL(None, use_errno=True)
            self.libc.csops.argtypes = [ctypes.c_int, ctypes.c_uint, ctypes.c_void_p, ctypes.c_size_t]
            self.libc.csops.restype = ctypes.c_int
            class BsdInfo(ctypes.Structure):
                _fields_ = [(name, ctypes.c_uint32) for name in (
                    'flags', 'status', 'xstatus', 'pid', 'ppid', 'uid', 'gid',
                    'ruid', 'rgid', 'svuid', 'svgid', 'reserved')]
                _fields_ += [('comm', ctypes.c_char * 16), ('name', ctypes.c_char * 32)]
                _fields_ += [(name, ctypes.c_uint32) for name in (
                    'nfiles', 'pgid', 'jobc', 'tdev', 'tpgid', 'nice')]
                _fields_ += [('start_sec', ctypes.c_uint64), ('start_usec', ctypes.c_uint64)]
            class UniqueInfo(ctypes.Structure):
                _fields_ = [('uuid', ctypes.c_ubyte * 16), ('uniqueid', ctypes.c_uint64),
                            ('parent_uniqueid', ctypes.c_uint64), ('version', ctypes.c_int32),
                            ('parent_version', ctypes.c_int32), ('reserved2', ctypes.c_uint64),
                            ('reserved3', ctypes.c_uint64)]
            class ProcessInfo(ctypes.Structure):
                _fields_ = [('bsd', BsdInfo), ('unique', UniqueInfo)]
            self.BsdInfo = BsdInfo
            self.ProcessInfo = ProcessInfo
        elif not sys.platform.startswith('linux'):
            raise RuntimeError('owned process identity unavailable on this platform')
        self.birth = self.identity(os.getpid())[1]
        native = self.native_identity(os.getpid()) if sys.platform == 'darwin' else None
        self.native_uniqueid = native[0] if native else None
        self.members = {}
        self.lineage = {}
        self.observed = {}
        self.complete = False
        self.root = None
        self.peers = []

    def bind_root(self, pid):
        identity = self.identity(pid)
        if not identity or identity[0] != os.getuid():
            raise RuntimeError('owned shell birth identity unavailable')
        # The direct fork child is owned independently of shell env rewriting.
        self.root = (pid, identity[1])

    def pids(self):
        if sys.platform == 'darwin':
            size = self.libproc.proc_listpids(4, os.getuid(), None, 0)
            if size <= 0 or size > 400000:
                raise RuntimeError('owned process enumeration unavailable')
            data = (ctypes.c_int * (size // 4 + 1024))()
            used = self.libproc.proc_listpids(4, os.getuid(), data, ctypes.sizeof(data))
            if used <= 0 or used >= ctypes.sizeof(data) or used % 4:
                raise RuntimeError('owned process enumeration incomplete')
            return [pid for pid in data[:used // 4] if pid > 0]
        result = []
        for name in os.listdir('/proc'):
            if not name.isdigit():
                continue
            try:
                if os.stat('/proc/' + name).st_uid == os.getuid():
                    result.append(int(name))
            except FileNotFoundError:
                raise RuntimeError('owned process enumeration changed; cleanup unknown')
        return result

    def identity(self, pid):
        if sys.platform == 'darwin':
            info = self.BsdInfo()
            ctypes.set_errno(0)
            result = self.libproc.proc_pidinfo(pid, 3, 0, ctypes.byref(info), ctypes.sizeof(info))
            if result != ctypes.sizeof(info):
                if result == 0 and ctypes.get_errno() == errno.ESRCH:
                    return None
                raise RuntimeError('owned process birth identity unavailable')
            return (info.uid, (info.start_sec, info.start_usec), info.status == 5)
        try:
            with open('/proc/%d/stat' % pid) as file:
                fields = file.read().rsplit(')', 1)[1].split()
            return (os.stat('/proc/%d' % pid).st_uid, (int(fields[19]),), fields[0] == 'Z')
        except FileNotFoundError:
            return None

    def native_identity(self, pid):
        combined = self.ProcessInfo()
        info = combined.unique
        ctypes.set_errno(0)
        size = self.libproc.proc_pidinfo(pid, 17, 0, ctypes.byref(info), ctypes.sizeof(info))
        if size != ctypes.sizeof(info):
            # This optional negative witness is unavailable, never proof of absence or permission to signal.
            return None
        return (info.uniqueid, info.version, bytes(info))

    def details(self, pid, include_exec=True):
        if sys.platform == 'darwin':
            # XNU PROC_PIDT_BSDINFOWITHUNIQID (18) includes pidversion: birth alone does not detect exec.
            info = self.ProcessInfo()
            ctypes.set_errno(0)
            result = self.libproc.proc_pidinfo(pid, 18, 1, ctypes.byref(info), ctypes.sizeof(info))
            if result != ctypes.sizeof(info):
                if result == 0 and ctypes.get_errno() == errno.ESRCH:
                    return None
                raise RuntimeError('owned process ancestry/exec identity unavailable')
            bsd = info.bsd
            return (bsd.uid, (bsd.start_sec, bsd.start_usec), bsd.status == 5, bsd.ppid, info.unique.version,
                    info.unique.uniqueid, info.unique.parent_uniqueid, info.unique.parent_version)
        try:
            with open('/proc/%d/stat' % pid) as file:
                fields = file.read().rsplit(')', 1)[1].split()
            identity = (os.stat('/proc/%d' % pid).st_uid, (int(fields[19]),), fields[0] == 'Z')
            executable = os.stat('/proc/%d/exe' % pid) if include_exec and not identity[2] else None
            image = (executable.st_dev, executable.st_ino, fields[23], fields[25]) if executable else None
            return (*identity, int(fields[1]), image)
        except FileNotFoundError:
            return None

    def marked(self, pid):
        for attempt in range(3):
            try:
                return self.read_marker(pid)
            except OSError as error:
                identity = self.identity(pid)
                if not identity or identity[2]:
                    return None
                if error.errno not in (errno.EINVAL, errno.EIO) or attempt == 2:
                    raise
                # KERN_PROCARGS2 races exec/exit even while BSD identity is present.
                # A bounded re-read confirms disappearance or retains unknown.
                time.sleep(0.005)

    def read_marker(self, pid):
        if sys.platform == 'darwin':
            mib = (ctypes.c_int * 3)(1, 49, pid)
            size = ctypes.c_size_t()
            if self.libc.sysctl(mib, 3, None, ctypes.byref(size), None, 0) != 0:
                if ctypes.get_errno() == errno.ESRCH:
                    return None
                raise OSError(ctypes.get_errno(), 'owned process marker unavailable')
            if size.value <= 0 or size.value > 1048576:
                raise RuntimeError('owned process marker exceeds inspection budget')
            capacity = size.value
            data = ctypes.create_string_buffer(capacity)
            if self.libc.sysctl(mib, 3, data, ctypes.byref(size), None, 0) != 0:
                if ctypes.get_errno() == errno.ESRCH:
                    return None
                raise OSError(ctypes.get_errno(), 'owned process marker unavailable')
            if not 0 < size.value <= capacity:
                raise RuntimeError('owned process marker inspection incomplete')
            # Only compare the exact random marker; do not parse or report other values.
            if owner in data.raw[:size.value].split(b'\0'):
                return True
            flags = ctypes.c_uint32()
            if self.libc.csops(pid, 0, ctypes.byref(flags), ctypes.sizeof(flags)) != 0:
                raise OSError(ctypes.get_errno(), 'owned process environment visibility unavailable')
            # CS_RESTRICT can make KERN_PROCARGS2 succeed with argv only. Absence is then unknown.
            return None if flags.value & 0x00000800 else False
        try:
            with open('/proc/%d/environ' % pid, 'rb') as file:
                data = file.read(1048577)
            if len(data) > 1048576:
                raise RuntimeError('owned process marker exceeds inspection budget')
            return owner in data.split(b'\0')
        except FileNotFoundError:
            return None

    def set_peers(self, peers):
        if not isinstance(peers, list):
            raise ValueError('invalid PTY peer witnesses')
        for peer in peers:
            if not isinstance(peer, dict) or set(peer) != {'helper', 'root'}:
                raise ValueError('invalid PTY peer witness')
            for value in peer.values():
                if (not isinstance(value, dict) or set(value) != {'pid', 'birth'}
                    or type(value['pid']) is not int or value['pid'] <= 0
                    or not isinstance(value['birth'], list) or len(value['birth']) != len(self.birth)
                    or any(type(part) is not int or part < 0 for part in value['birth'])):
                    raise ValueError('invalid PTY peer identity')
        self.peers = peers

    @staticmethod
    def descendants(stable, root):
        result = {root}
        while True:
            children = {pid for pid, detail in stable.items() if detail[0] == os.getuid() and detail[3] in result
                        and detail[1] >= stable[detail[3]][1]}
            if children <= result:
                return result
            result.update(children)

    def remaining(self):
        self.complete = False
        init_before = self.native_identity(1) if sys.platform == 'darwin' else None
        before_pids = set(self.pids())
        known = set(self.members.items()) | set(self.lineage.items())
        if self.root:
            known.add(self.root)
        def read_known():
            identities = {pid: self.identity(pid) for pid, birth in known}
            for pid, birth in known:
                value = identities[pid]
                if value and value[1] == birth and not value[2] and value[0] != os.getuid():
                    raise RuntimeError('owned process UID changed; cleanup unknown')
            return identities
        # The UID-filtered list must never erase a previously proven live birth.
        known_before = read_known()
        # Old unrelated Linux processes need birth/parent identity, not access to their executable.
        basic = {pid: known_before[pid] if pid in known_before else self.identity(pid) for pid in before_pids}
        anchors = {value['pid'] for peer in self.peers for value in peer.values()}
        if self.root:
            anchors.add(self.root[0])
        inspect = {pid for pid, value in basic.items() if value and not value[2]
                   and (pid in anchors or value[0] == os.getuid() and value[1] >= self.birth)}
        before = {pid: self.details(pid) for pid in inspect}
        marked = {pid: self.marked(pid) for pid, detail in before.items()
                  if detail and pid != os.getpid() and self.root != (pid, detail[1])}
        after_pids = set(self.pids())
        after = {pid: self.details(pid) for pid in inspect}
        known_after = read_known()
        after_basic = {pid: known_after[pid] if pid in known_after else self.identity(pid) for pid in before_pids}
        complete = (before_pids == after_pids and known_before == known_after
                    and all(not value or value[2] or (pid, value[1]) not in known
                            or pid in before_pids and pid in after_pids for pid, value in known_after.items())
                    and all(basic[pid] is not None and basic[pid] == after_basic[pid] for pid in before_pids)
                    and all(before[pid] is not None and before[pid] == after[pid] for pid in inspect))
        stable = {pid: detail for pid, detail in before.items()
                  if detail and detail == after[pid] and basic[pid] == detail[:3] == after_basic[pid] and not detail[2]}
        init_after = self.native_identity(1) if sys.platform == 'darwin' else None
        init_parent = None
        if (init_before and init_before == init_after and init_before[1] != 0 and self.native_uniqueid
            and 0 < init_before[0] < self.native_uniqueid):
            init_parent = init_before[:2]
        peer_claims = {(value['pid'], tuple(value['birth'])) for peer in self.peers for value in peer.values()}
        owned = set()
        if self.root and self.root[0] in stable and stable[self.root[0]][:2] == (os.getuid(), self.root[1]):
            owned = self.descendants(stable, self.root[0])
        peer_members = set()
        for peer in self.peers:
            helper, root = peer['helper'], peer['root']
            hp, rp = helper['pid'], root['pid']
            if (hp in stable and rp in stable and hp != rp
                and stable[hp][:2] == (os.getuid(), tuple(helper['birth']))
                and stable[rp][:2] == (os.getuid(), tuple(root['birth']))
                and stable[rp][3] == hp and stable[rp][1] >= stable[hp][1]):
                peer_members.add(hp)
                peer_members.update(self.descendants(stable, rp))
        self.lineage.update((pid, stable[pid][1]) for pid in owned if pid not in peer_members)
        found = {}
        for pid, detail in stable.items():
            if pid == os.getpid() or detail[0] != os.getuid() or detail[1] < self.birth:
                continue
            birth = detail[1]
            own = (pid in owned or self.root == (pid, birth) or marked.get(pid) is True
                   or self.lineage.get(pid) == birth or self.members.get(pid) == birth)
            if pid in peer_members:
                if own:
                    complete = False
                continue
            if self.root == (pid, birth):
                found[pid] = birth
            elif marked[pid] is True:
                found[pid] = birth
                self.members[pid] = birth
            elif self.members.get(pid) == birth:
                raise RuntimeError('owned process marker changed; cleanup unknown')
            elif self.lineage.get(pid) == birth:
                found[pid] = birth
            elif marked[pid] is None:
                # Exec can rewrite parent_uniqueid after reparenting, so the original parent's 32-bit
                # version must also match actual init. This only excludes; it never grants ownership.
                if (init_parent and (pid, birth) not in peer_claims and detail[5] > 0
                    and detail[6:8] == init_parent):
                    continue
                # Same UID and recent birth select a candidate, never permission to signal it.
                complete = False
        self.observed.update((pid, stable[pid]) for pid in found)
        self.complete = complete
        return found

    def signal(self, members, sig):
        for member, birth in members.items():
            identity = self.identity(member)
            if not identity or identity[1] != birth or identity[2]:
                self.complete = False
                continue
            if identity[0] != os.getuid():
                self.complete = False
                raise RuntimeError('owned process UID changed; cleanup unknown')
            marked = self.marked(member) if self.root != (member, birth) else None
            observed = self.observed.get(member)
            current = self.details(member)
            if not current or current[1] != birth or current[2]:
                self.complete = False
                continue
            # Proven descendants may reparent after their parent exits; exec/birth must remain unchanged.
            if not observed or current[:3] != observed[:3] or current[4] != observed[4]:
                raise RuntimeError('owned process identity/exec changed; cleanup unknown')
            latest = self.identity(member)
            if not latest or latest[1] != birth or latest[2]:
                self.complete = False
                continue
            if latest != identity:
                raise RuntimeError('owned process identity/exec changed; cleanup unknown')
            if self.root != (member, birth):
                if self.members.get(member) == birth and marked is not True:
                    raise RuntimeError('owned process marker changed; cleanup unknown')
                if marked is not True and self.lineage.get(member) != birth:
                    raise RuntimeError('owned process marker changed; cleanup unknown')
            try:
                os.kill(member, sig)
            except ProcessLookupError:
                self.complete = False
processes = ProcessTable()

# Do not mix TextIOWrapper.readline with os.read: readline can prefetch the
# next input/close frame, making it invisible to the select loop below.
start_line = bytearray()
while True:
    byte = os.read(sys.stdin.fileno(), 1)
    if not byte:
        raise ValueError('missing terminal start frame')
    if byte == b'\n':
        break
    start_line.extend(byte)
    if len(start_line) > 65536:
        raise ValueError('terminal start frame too large')
start = json.loads(start_line)
shell = start['shell']
if shell not in ('/bin/bash', '/bin/zsh'):
    raise ValueError('unsupported local shell')
with tempfile.TemporaryDirectory(prefix='wsl-shell-') as directory:
    rc = os.path.join(directory, '.zshrc' if shell.endswith('zsh') else '.bashrc')
    with open(rc, 'wb') as file:
        file.write(base64.b64decode(start['rc'], validate=True))
    pid, fd = pty.fork()
    if pid == 0:
        os.chdir(start['cwd'])
        env = dict(os.environ)
        env['TERM'] = 'xterm-256color'
        env['WSL_PTY_OWNER'] = owner.split(b'=', 1)[1].decode('ascii')
        if shell.endswith('zsh'):
            env['ZDOTDIR'] = directory
            argv = [shell, '-d', '-i']
        else:
            argv = [shell, '--noprofile', '--rcfile', rc, '-i']
        os.execve(shell, argv, env)
    processes.bind_root(pid)
    resize(fd, start['cols'], start['rows'])
    emit({'type': 'ready', 'helper': {'pid': os.getpid(), 'birth': processes.birth},
          'root': {'pid': processes.root[0], 'birth': processes.root[1]}})
    decoder = codecs.getincrementaldecoder('utf8')('replace')
    pending = b''
    input_queue = b''
    os.set_blocking(fd, False)
    try:
        alive = True
        while alive:
            ready, writable, _ = select.select([fd, sys.stdin.fileno()], [fd] if input_queue else [], [], 0.2)
            if writable:
                try:
                    input_queue = input_queue[os.write(fd, input_queue):]
                except BlockingIOError:
                    pass
            for source in ready:
                if source == fd:
                    try:
                        data = os.read(fd, 65536)
                    except OSError:
                        alive = False
                        break
                    if not data:
                        alive = False
                        break
                    emit({'type': 'output', 'data': decoder.decode(data)})
                else:
                    data = os.read(sys.stdin.fileno(), 65536)
                    if not data:
                        alive = False
                        break
                    pending += data
                    if len(pending) > 1048576:
                        raise ValueError('input queue overflow')
                    while b'\n' in pending:
                        line, pending = pending.split(b'\n', 1)
                        message = json.loads(line)
                        if 'peers' in message:
                            processes.set_peers(message['peers'])
                        if message['type'] == 'peers':
                            continue
                        if message['type'] == 'input':
                            value = message['data'].encode('utf8')
                            if len(value) > 65536:
                                raise ValueError('input too large')
                            input_queue += value
                            if len(input_queue) > 1048576:
                                raise ValueError('PTY input queue overflow')
                        elif message['type'] == 'resize':
                            resize(fd, message['cols'], message['rows'])
                        elif message['type'] == 'close':
                            alive = False
    finally:
        # Reparenting and setsid do not remove the inherited instance marker.
        # Recheck birth identity immediately before signalling to avoid PID reuse.
        status = None
        confirmed = False
        try:
            try:
                # Capture the live parent chain before closing the PTY can reparent its children.
                remaining = processes.remaining()
            finally:
                os.close(fd)
            for sig in (None, signal.SIGTERM, signal.SIGKILL):
                if sig is not None:
                    processes.signal(remaining, sig)
                deadline = time.monotonic() + 0.8
                while time.monotonic() < deadline:
                    if status is None:
                        found, value = os.waitpid(pid, os.WNOHANG)
                        if found:
                            status = value
                    remaining = processes.remaining()
                    if status is not None and not remaining and processes.complete:
                        confirmed = True
                        break
                    time.sleep(0.02)
                if confirmed:
                    break
        except (OSError, RuntimeError):
            # A missing inspection capability is unknown cleanup, never success.
            confirmed = False
        if not confirmed:
            emit({'type': 'cleanup', 'ok': False})
            raise RuntimeError('owned shell cleanup not confirmed')
        emit({'type': 'exit', 'exitCode': os.waitstatus_to_exitcode(status)})
        emit({'type': 'cleanup', 'ok': True})
