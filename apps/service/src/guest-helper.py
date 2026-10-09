"""Linux guest only: owned session cleanup and framed Codex/PTY transport."""
import base64
import codecs
import ctypes
import errno
import fcntl
import json
import os
import pty
import select
import socket
import uuid
import signal
import shutil
import struct
import subprocess
import sys
import termios
import tempfile
import time

PREFIX = "WSL_GUEST_FRAME:"
CWD = "/home/agent/workspace"
TERMINAL_RC_BASE64 = ""
RESOURCE_MCP_BASE64 = ""  # Replaced only by the trusted host build, never by a page or frame.
WORKSPACE_BYTES = 524288


class GuestWorkspaceOwner:
    # Unknown process cleanup must retain its cwd and modifications. No destructor
    # removes this directory; only the explicit confirmed-cleanup path may do so.
    def __init__(self, run_id):
        self.name = tempfile.mkdtemp(prefix="wsl-vs001-" + run_id + "-", dir=CWD)
        self.removed = False

    def cleanup(self):
        if not self.removed:
            try:
                shutil.rmtree(self.name)
            except FileNotFoundError:
                pass
            self.removed = True


def report_retained_workspace(workspace, start, reason):
    if workspace is not None:
        emit("error", error="guest workspace retained after unconfirmed cleanup: " + str(reason),
             runId=start["workspace"]["runId"], workspaceDir=workspace.name, cleanupConfirmed=False)


def workspace_path(root, relative):
    if (not isinstance(relative, str) or not relative or "\\" in relative or
            any(part in ("", ".", "..") for part in relative.split("/")) or "\x00" in relative):
        raise ValueError("unsafe guest workspace path")
    return os.path.join(root, relative)


def create_workspace(payload):
    if (not isinstance(payload, dict) or set(payload) != {"runId", "files"} or
            str(uuid.UUID(payload["runId"])) != payload["runId"] or
            not isinstance(payload["files"], list) or not 0 < len(payload["files"]) <= 256):
        raise ValueError("invalid guest workspace payload")
    # Hold explicit ownership before populating any files. A failed initial write
    # has no child process and can be safely cleaned immediately.
    directory = GuestWorkspaceOwner(payload["runId"])
    try:
        total = 0
        for entry in payload["files"]:
            if not isinstance(entry, dict) or set(entry) != {"path", "base64"}:
                raise ValueError("invalid guest workspace file")
            destination = workspace_path(directory.name, entry["path"])
            content = base64.b64decode(entry["base64"], validate=True)
            total += len(content)
            if total > WORKSPACE_BYTES:
                raise ValueError("guest workspace exceeds byte budget")
            os.makedirs(os.path.dirname(destination), exist_ok=True)
            with open(destination, "xb") as target:
                target.write(content)
        return directory
    except BaseException:
        directory.cleanup()
        raise


def snapshot_workspace(root, run_id):
    files = []
    total = 0
    def walk(directory, prefix=""):
        nonlocal total
        for entry in sorted(os.scandir(directory), key=lambda item: item.name):
            relative = prefix + entry.name
            workspace_path(root, relative)
            if entry.is_symlink():
                raise ValueError("guest workspace symlink: " + relative)
            if not prefix and entry.name in ("node_modules", "dist", ".vite") and entry.is_dir(follow_symlinks=False):
                continue
            if entry.is_dir(follow_symlinks=False):
                walk(entry.path, relative + "/")
            elif entry.is_file(follow_symlinks=False):
                with open(entry.path, "rb") as source:
                    content = source.read(WORKSPACE_BYTES + 1)
                total += len(content)
                if total > WORKSPACE_BYTES or len(files) >= 256:
                    raise ValueError("guest workspace snapshot exceeds budget")
                files.append({"path": relative, "base64": base64.b64encode(content).decode("ascii")})
            else:
                raise ValueError("guest workspace non-file: " + relative)
    walk(root)
    emit("workspace", runId=run_id, files=files)


def drain_streams(streams):
    # Cancel and protocol failure still retain the tail produced before children stopped.
    deadline = time.monotonic() + 2
    while streams:
        readable, _, _ = select.select(list(streams), [], [], max(0, deadline - time.monotonic()))
        if not readable:
            raise RuntimeError("guest output drain not confirmed")
        for fd in readable:
            stream, decoder = streams[fd]
            try:
                data = os.read(fd, 65536)
            except OSError as error:
                if error.errno != errno.EIO:
                    raise
                data = b""
            text = decoder.decode(data, final=not data)
            if text:
                emit("output", stream=stream, data=text)
            if not data:
                del streams[fd]


def emit(kind, **fields):
    print(PREFIX + json.dumps({"type": kind, **fields}), flush=True)


def owned_members(sid):
    processes = {}
    for entry in os.scandir("/proc"):
        if not entry.name.isdigit():
            continue
        try:
            with open(entry.path + "/stat") as source:
                fields = source.read().rsplit(")", 1)[1].split()
        except FileNotFoundError:
            continue
        processes[int(entry.name)] = (int(fields[1]), int(fields[3]))
    # Include descendants that created a new session, and children adopted by subreaper.
    owned = {os.getpid()}
    while True:
        descendants = {pid for pid, (parent, _) in processes.items() if parent in owned}
        if descendants.issubset(owned):
            break
        owned.update(descendants)
    owned.update(pid for pid, (_, session) in processes.items() if session == sid)
    owned.discard(os.getpid())
    return owned


def reap(members, leader):
    for pid in members:
        if pid == leader:
            continue
        try:
            os.waitpid(pid, os.WNOHANG)
        except ChildProcessError:
            # Still belongs to a live intermediate parent; it is not adopted yet.
            pass


def cleanup(sid, child):
    # Subreaper adopts orphaned background jobs, so zombies can actually be reaped.
    for sig, duration in [(signal.SIGTERM, 1.5), (signal.SIGKILL, 3.0)]:
        deadline = time.monotonic() + duration
        while True:
            child.poll()
            members = owned_members(sid)
            reap(members, child.pid)
            members = owned_members(sid)
            if not members:
                return
            for pid in members:
                try:
                    os.kill(pid, sig)
                except ProcessLookupError:
                    pass
            if time.monotonic() >= deadline:
                break
            time.sleep(0.02)
    raise RuntimeError("guest session cleanup not confirmed")


def resize(fd, cols, rows):
    if type(cols) is not int or not 2 <= cols <= 500 or type(rows) is not int or not 1 <= rows <= 300:
        raise ValueError("invalid PTY dimensions")
    fcntl.ioctl(fd, termios.TIOCSWINSZ, struct.pack("HHHH", rows, cols, 0, 0))


def read_start():
    if sys.platform != "linux":
        raise RuntimeError("guest helper requires Linux")
    libc = ctypes.CDLL(None, use_errno=True)
    if libc.prctl(36, 1, 0, 0, 0) != 0:
        raise OSError(ctypes.get_errno(), "PR_SET_CHILD_SUBREAPER")
    first = b""
    while not first.endswith(b"\n"):
        byte = os.read(sys.stdin.fileno(), 1)
        if not byte:
            break
        first += byte
        if len(first) > 1048576:
            raise ValueError("start frame too large")
    if not first:
        raise RuntimeError("missing start frame")
    start = json.loads(first)
    if not isinstance(start, dict) or start.get("type") != "start" or start.get("mode") not in ("codex", "terminal"):
        raise ValueError("invalid start frame")
    allowed = {"type", "mode", "cols", "rows"} if start["mode"] == "terminal" else {"type", "mode", "argv", "prompt", "resourceBundle", "observation", "observationImages", "workspace"}
    for key in ("observation", "observationImages"):
        if key in start and type(start[key]) is not bool:
            raise ValueError("invalid observation capability")
    if set(start) - allowed:
        raise ValueError("unknown start fields")
    return start


def main(start):
    os.makedirs(CWD, exist_ok=True)
    env = dict(os.environ)
    env["PATH"] = "/usr/local/bin:/usr/local/share/npm-global/bin:" + env.get("PATH", "")
    terminal = start["mode"] == "terminal"
    master = None
    child = None
    resource_fd = None
    observer = None
    observer_dir = None
    observer_clients = {}
    observation_count = 0
    terminal_rc = None
    workspace = None
    streams = {}
    try:
        if terminal:
            master, slave = pty.openpty()
            resize(master, start["cols"], start["rows"])
            env["TERM"] = "xterm-256color"
            def own_tty():
                os.setsid()
                fcntl.ioctl(0, termios.TIOCSCTTY, 0)
            shell_argv = ["/bin/bash", "--noprofile", "--norc", "-i"]
            if TERMINAL_RC_BASE64:
                terminal_rc = tempfile.NamedTemporaryFile(prefix="wsl-terminal-", suffix=".bashrc", mode="wb")
                terminal_rc.write(base64.b64decode(TERMINAL_RC_BASE64, validate=True))
                terminal_rc.flush()
                shell_argv = ["/bin/bash", "--noprofile", "--rcfile", terminal_rc.name, "-i"]
            child = subprocess.Popen(shell_argv, cwd=CWD, env=env,
                                     stdin=slave, stdout=slave, stderr=slave, preexec_fn=own_tty)
            os.close(slave)
            streams = {master: ("stdout", codecs.getincrementaldecoder("utf-8")("replace"))}
        else:
            argv = start["argv"]
            if not isinstance(argv, list) or not argv or not all(isinstance(arg, str) for arg in argv):
                raise ValueError("invalid Codex argv")
            if "resourceBundle" in start:
                if argv[0] != "codex" or "exec" not in argv or not RESOURCE_MCP_BASE64:
                    raise ValueError("resource capability requires fixed Codex exec")
                source = base64.b64decode(RESOURCE_MCP_BASE64, validate=True).decode("utf-8")
                module = {"__name__": "wsl_resource_module"}
                exec(compile(source, "<wsl-resource-mcp>", "exec"), module)
                resource_fd = module["sealed_bundle"](start["resourceBundle"])
                descriptor = "/proc/%d/fd/%d" % (os.getpid(), resource_fd)
                observation_args = []
                if start.get("observation") is True:
                    observer_dir = tempfile.TemporaryDirectory(prefix="wsl-observe-")
                    observer = socket.socket(socket.AF_UNIX, socket.SOCK_STREAM)
                    observation_path = observer_dir.name + "/read.sock"
                    observer.bind(observation_path)
                    observer.listen(4)
                    observer.setblocking(False)
                    observation_args = [observation_path, "images" if start.get("observationImages") is True else "text"]
                # TOML basic strings/arrays use the same escaping used here by JSON.
                config = ["-c", 'mcp_servers.wsl_space.command="python3"', "-c",
                          "mcp_servers.wsl_space.args=" + json.dumps(["-I", "-u", "-c", source, descriptor, *observation_args]),
                          "-c", "mcp_servers.wsl_space.required=true"]
                argv = [argv[0], *config, *argv[1:]]
            if "workspace" in start:
                workspace = create_workspace(start["workspace"])
            child = subprocess.Popen(argv, cwd=workspace.name if workspace else CWD, env=env, stdin=subprocess.PIPE,
                                     stdout=subprocess.PIPE, stderr=subprocess.PIPE, start_new_session=True)
            child.stdin.write(start.get("prompt", "").encode())
            child.stdin.close()
            streams = {child.stdout.fileno(): ("stdout", codecs.getincrementaldecoder("utf-8")("replace")),
                       child.stderr.fileno(): ("stderr", codecs.getincrementaldecoder("utf-8")("replace"))}
        emit("ready", pid=child.pid)
        for fd in streams:
            os.set_blocking(fd, False)
        stdin = sys.stdin.fileno()
        os.set_blocking(stdin, False)
        buffer = b""
        closing = False
        pending_input = b""
        leader_cleaned = False
        while (streams or child.poll() is None) and not closing:
            readable, writable, _ = select.select([stdin, *streams, *([observer.fileno()] if observer else []), *[client.fileno() for client, pending, _ in observer_clients.values()]], [master] if pending_input else [], [], 0.1)
            if writable:
                written = os.write(master, pending_input)
                pending_input = pending_input[written:]
            for call_id, (client, pending, deadline) in list(observer_clients.items()):
                if time.monotonic() > deadline:
                    if pending is None:
                        emit("observation-cancel", id=call_id)
                    client.close()
                    del observer_clients[call_id]
            for fd in readable:
                if observer and fd == observer.fileno():
                    client, _ = observer.accept()
                    client.setblocking(False)
                    if len(observer_clients) >= 4 or observation_count >= 64:
                        client.close()
                    else:
                        observer_clients[str(uuid.uuid4())] = (client, b"", time.monotonic() + 20)
                        observation_count += 1
                    continue
                observer_id = next((key for key, (client, _, _) in observer_clients.items() if client.fileno() == fd), None)
                if observer_id:
                    client, pending, deadline = observer_clients[observer_id]
                    try:
                        chunk = client.recv(16385)
                    except OSError:
                        chunk = b""
                    if pending is None:
                        if not chunk:
                            emit("observation-cancel", id=observer_id)
                            client.close()
                            del observer_clients[observer_id]
                        elif chunk:
                            raise ValueError("observation client sent data after request")
                        continue
                    pending += chunk
                    if not chunk or len(pending) > 16384:
                        client.close()
                        del observer_clients[observer_id]
                    elif b"\n" in pending:
                        try:
                            request = json.loads(pending)
                            if not isinstance(request, dict) or set(request) != {"tool", "args"} or not isinstance(request["tool"], str) or not isinstance(request["args"], dict):
                                raise ValueError("invalid observation request")
                        except (ValueError, TypeError):
                            client.close()
                            del observer_clients[observer_id]
                            continue
                        emit("observation-call", id=observer_id, tool=request["tool"], args=request["args"])
                        observer_clients[observer_id] = (client, None, deadline)
                    else:
                        observer_clients[observer_id] = (client, pending, deadline)
                    continue
                if fd == stdin:
                    data = os.read(stdin, 65536)
                    if not data:
                        closing = True
                        break
                    buffer += data
                    while b"\n" in buffer:
                        line, buffer = buffer.split(b"\n", 1)
                        if len(line) > 1048576:
                            raise ValueError("control frame too large")
                        frame = json.loads(line)
                        if not isinstance(frame, dict):
                            raise ValueError("invalid control frame")
                        kind = frame.get("type")
                        keys = {"observation-result": {"type", "id", "result"}, "close": {"type"}, "input": {"type", "data"}, "resize": {"type", "cols", "rows"}}
                        if kind not in keys or set(frame) != keys[kind]:
                            raise ValueError("invalid control fields")
                        if kind == "observation-result" and not terminal:
                            pending = observer_clients.pop(frame["id"], None)
                            if pending:
                                client = pending[0]
                                encoded = (json.dumps(frame["result"]) + "\n").encode()
                                if len(encoded) > 1048576:
                                    encoded = b'{"error":"unavailable","message":"Observation exceeds transport budget"}\n'
                                client.settimeout(1)
                                try:
                                    client.sendall(encoded)
                                except OSError:
                                    emit("observation-cancel", id=frame["id"])
                                client.close()
                        elif kind == "close":
                            closing = True
                        elif terminal and kind == "input":
                            data = frame["data"]
                            if not isinstance(data, str) or not 0 < len(data.encode()) <= 65536:
                                raise ValueError("invalid terminal input")
                            pending_input += data.encode()
                            if len(pending_input) > 1048576:
                                raise ValueError("terminal input queue too large")
                        elif terminal and kind == "resize":
                            resize(master, frame["cols"], frame["rows"])
                        else:
                            raise ValueError("invalid control frame")
                    if len(buffer) > 1048576:
                        raise ValueError("control frame too large")
                else:
                    if fd not in streams:
                        continue
                    stream, decoder = streams[fd]
                    try:
                        data = os.read(fd, 65536)
                    except OSError as error:
                        if terminal and error.errno == errno.EIO:
                            data = b""
                        else:
                            raise
                    text = decoder.decode(data, final=not data)
                    if text:
                        emit("output", stream=stream, data=text)
                    if not data:
                        del streams[fd]
            # Leader exit does not imply background jobs have released the streams.
            if child.poll() is not None and not leader_cleaned:
                cleanup(child.pid, child)
                leader_cleaned = True
        if closing:
            cleanup(child.pid, child)
            drain_streams(streams)
        else:
            child.wait()
            cleanup(child.pid, child)
        emit("exit", exitCode=child.returncode)
        if workspace is not None:
            snapshot_workspace(workspace.name, start["workspace"]["runId"])
            workspace.cleanup()
            workspace = None
        for call_id, (client, _, _) in observer_clients.items():
            emit("observation-cancel", id=call_id)
            client.close()
        observer_clients.clear()
        emit("cleanup", ok=True)
    except BaseException as error:
        emit("error", error=str(error))
        if child is not None:
            try:
                cleanup(child.pid, child)
                drain_streams(streams)
            except BaseException as cleanup_error:
                report_retained_workspace(workspace, start, cleanup_error)
                emit("cleanup", ok=False, error=str(cleanup_error))
                return
        if workspace is not None:
            try:
                snapshot_workspace(workspace.name, start["workspace"]["runId"])
            except BaseException as snapshot_error:
                emit("error", error=str(snapshot_error))
            try:
                workspace.cleanup()
                workspace = None
            except BaseException as cleanup_error:
                report_retained_workspace(workspace, start, cleanup_error)
                emit("cleanup", ok=False, error=str(cleanup_error))
                return
        for call_id, (client, _, _) in observer_clients.items():
            emit("observation-cancel", id=call_id)
            client.close()
        observer_clients.clear()
        emit("cleanup", ok=True)
    finally:
        for client, _, _ in observer_clients.values():
            client.close()
        if observer is not None:
            observer.close()
        if observer_dir is not None:
            observer_dir.cleanup()
        if terminal_rc is not None:
            terminal_rc.close()
        if master is not None:
            os.close(master)
        if resource_fd is not None:
            os.close(resource_fd)


try:
    start = read_start()
except BaseException as error:
    # Preflight has no process side effects; rejection does not leave an owned child.
    emit("error", error=str(error))
    emit("cleanup", ok=True)
else:
    try:
        main(start)
    except BaseException as error:
        emit("error", error=str(error))
        emit("cleanup", ok=False, error="helper finalization failed")
