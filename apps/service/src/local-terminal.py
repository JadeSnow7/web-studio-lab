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
            class BsdInfo(ctypes.Structure):
                _fields_ = [(name, ctypes.c_uint32) for name in (
                    'flags', 'status', 'xstatus', 'pid', 'ppid', 'uid', 'gid',
                    'ruid', 'rgid', 'svuid', 'svgid', 'reserved')]
                _fields_ += [('comm', ctypes.c_char * 16), ('name', ctypes.c_char * 32)]
                _fields_ += [(name, ctypes.c_uint32) for name in (
                    'nfiles', 'pgid', 'jobc', 'tdev', 'tpgid', 'nice')]
                _fields_ += [('start_sec', ctypes.c_uint64), ('start_usec', ctypes.c_uint64)]
            self.BsdInfo = BsdInfo
        elif not sys.platform.startswith('linux'):
            raise RuntimeError('owned process identity unavailable on this platform')
        self.birth = self.identity(os.getpid())[1]
        self.members = {}
        self.root = None

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
            if used <= 0 or used >= ctypes.sizeof(data):
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
                pass
        return result

    def identity(self, pid):
        if sys.platform == 'darwin':
            info = self.BsdInfo()
            result = self.libproc.proc_pidinfo(pid, 3, 0, ctypes.byref(info), ctypes.sizeof(info))
            if result != ctypes.sizeof(info):
                if ctypes.get_errno() == errno.ESRCH:
                    return None
                raise RuntimeError('owned process birth identity unavailable')
            return (info.uid, (info.start_sec, info.start_usec), info.status == 5)
        try:
            with open('/proc/%d/stat' % pid) as file:
                fields = file.read().rsplit(')', 1)[1].split()
            return (os.stat('/proc/%d' % pid).st_uid, (int(fields[19]),), fields[0] == 'Z')
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
            data = ctypes.create_string_buffer(size.value)
            if self.libc.sysctl(mib, 3, data, ctypes.byref(size), None, 0) != 0:
                if ctypes.get_errno() == errno.ESRCH:
                    return None
                raise OSError(ctypes.get_errno(), 'owned process marker unavailable')
            # Only compare the exact random marker; do not parse or report other values.
            return owner in data.raw[:size.value].split(b'\0')
        try:
            with open('/proc/%d/environ' % pid, 'rb') as file:
                data = file.read(1048577)
            if len(data) > 1048576:
                raise RuntimeError('owned process marker exceeds inspection budget')
            return owner in data.split(b'\0')
        except FileNotFoundError:
            return None

    def remaining(self):
        found = {}
        for candidate in self.pids():
            if candidate == os.getpid():
                continue
            identity = self.identity(candidate)
            if not identity or identity[0] != os.getuid() or identity[1] < self.birth or identity[2]:
                continue
            if self.root == (candidate, identity[1]):
                found[candidate] = identity[1]
                continue
            marked = self.marked(candidate)
            after = self.identity(candidate)
            if after != identity:
                continue
            if marked:
                found[candidate] = identity[1]
            elif self.members.get(candidate) == identity[1]:
                raise RuntimeError('owned process marker changed; cleanup unknown')
        self.members.update(found)
        return found

    def signal(self, members, sig):
        for member, birth in members.items():
            identity = self.identity(member)
            if not identity or identity[1] != birth or identity[2]:
                continue
            if self.root != (member, birth) and not self.marked(member):
                raise RuntimeError('owned process marker changed; cleanup unknown')
            if self.identity(member) != identity:
                continue
            try:
                os.kill(member, sig)
            except ProcessLookupError:
                pass

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
    emit({'type': 'ready'})
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
        os.close(fd)
        try:
            remaining = processes.remaining()
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
                    if status is not None and not remaining:
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
