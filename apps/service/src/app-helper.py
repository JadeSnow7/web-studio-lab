"""Trusted application commands; process ownership remains in guest-helper.py."""
import base64
import hashlib
import json
import os
from pathlib import Path
import re
import subprocess
import sys
import tarfile
import stat
import unicodedata

ROOT = Path('/home/agent/workspace/.wsl-apps')
LIMIT = 8 * 1024 * 1024
EXCLUDED = {'node_modules', 'dist', '.data', 'data', '.git', '.vite', '.wsl-identity.json', '.wsl-prepared', '.wsl-deps.tar.gz', '.wsl-dependency-lock'}


def relative_path(value):
    if not isinstance(value, str) or not value or '\\' in value or '\x00' in value or any(p in ('', '.', '..') for p in value.split('/')):
        raise ValueError('unsafe app file path')
    if value.split('/')[0] in EXCLUDED or value.startswith('.wsl-'):
        raise ValueError('reserved app file path')
    return value


def output(value):
    print('WSL_APP_RESULT:' + json.dumps(value, separators=(',', ':')), flush=True)


def run(request):
    project = request['projectId']
    if not isinstance(project, str) or not re.fullmatch(r'[A-Za-z0-9][A-Za-z0-9_-]{0,127}', project):
        raise ValueError('invalid project identity')
    if request['operation'] == 'source-snapshot':
        if set(request) != {'operation', 'workspaceId', 'projectId'}:
            raise ValueError('unsupported source request')
        source_snapshot(project, request['workspaceId'])
        return
    ROOT.mkdir(exist_ok=True)
    if ROOT.is_symlink():
        raise ValueError('app root must not be a symlink')
    root = ROOT / project
    identity = {'workspaceId': request['workspaceId'], 'environmentId': 'sandbox', 'projectId': project}
    if request['operation'] == 'create':
        # Exclusive mkdir is the project write gate, including across service processes.
        root.mkdir()
        files = request['files']
        total = 0
        seen = set()
        for entry in files:
            relative = relative_path(entry['path'])
            if relative in seen:
                raise ValueError('duplicate app file')
            seen.add(relative)
            data = base64.b64decode(entry['base64'], validate=True)
            total += len(data)
            if total > LIMIT:
                raise ValueError('app sources exceed budget')
            destination = root / relative
            destination.parent.mkdir(parents=True, exist_ok=True)
            with destination.open('xb') as target:
                target.write(data)
        (root / '.wsl-identity.json').write_text(json.dumps(identity))
        output({'created': True})
        return
    if root.is_symlink() or json.loads((root / '.wsl-identity.json').read_text()) != identity:
        raise ValueError('app workspace identity mismatch')
    if request['operation'] == 'dependencies':
        if request['platform'] != sys.platform or request['arch'] != 'arm64' or os.uname().machine != 'aarch64':
            raise ValueError('dependency archive platform mismatch')
        if request['lockSha256'] != hashlib.sha256((root / 'package-lock.json').read_bytes()).hexdigest():
            raise ValueError('dependency archive does not match project lockfile')
        archive = root / '.wsl-deps.tar.gz'
        digest = hashlib.sha256()
        total = 0
        created_archive = False
        try:
            with archive.open('xb') as target:
                created_archive = True
                while True:
                    chunk = sys.stdin.buffer.read(1024 * 1024)
                    if not chunk:
                        break
                    total += len(chunk)
                    if total > 256 * 1024 * 1024:
                        raise ValueError('dependency archive exceeds budget')
                    digest.update(chunk)
                    target.write(chunk)
            if digest.hexdigest() != request['sha256']:
                raise ValueError('dependency archive hash mismatch')
            with tarfile.open(archive, 'r:gz') as source:
                members = source.getmembers()
                if len(members) > 100000 or sum(member.size for member in members) > 1024 * 1024 * 1024:
                    raise ValueError('dependency archive expansion exceeds budget')
                for member in members:
                    parts = member.name.rstrip('/').split('/')
                    if not parts or parts[0] != 'node_modules' or any(part in ('', '.', '..') for part in parts):
                        raise ValueError('dependency archive path outside node_modules')
                    if not (member.isfile() or member.isdir() or member.issym()):
                        raise ValueError('unsupported dependency archive member')
                source.extractall(root, members=members, filter='data')
            (root / '.wsl-dependency-lock').write_text(hashlib.sha256((root / 'package-lock.json').read_bytes()).hexdigest())
            output({'dependenciesImported': True, 'sha256': digest.hexdigest()})
        finally:
            if created_archive:
                archive.unlink()
        return
    if request['operation'] == 'export':
        budget = request.get('exportBudget')
        if (not isinstance(budget, dict) or set(budget) != {'maxFiles', 'maxSourceBytes'} or
                type(budget['maxFiles']) is not int or type(budget['maxSourceBytes']) is not int or
                budget['maxFiles'] != 256 or budget['maxSourceBytes'] != 524288):
            raise ValueError('invalid app export budget')
        files = []
        total = 0
        for parent, directories, names in os.walk(root, followlinks=False):
            directories[:] = sorted(d for d in directories if d not in EXCLUDED)
            for name in [*directories, *names]:
                if name not in EXCLUDED and (Path(parent) / name).is_symlink():
                    raise ValueError('app source symlink')
            for name in sorted(names):
                if name in EXCLUDED:
                    continue
                source = Path(parent) / name
                relative = relative_path(source.relative_to(root).as_posix())
                if not source.is_file():
                    raise ValueError('app source is not a regular file')
                if len(files) >= budget['maxFiles']:
                    raise ValueError('app export exceeds budget')
                with source.open('rb') as handle:
                    content = handle.read(budget['maxSourceBytes'] - total + 1)
                total += len(content)
                if total > budget['maxSourceBytes']:
                    raise ValueError('app export exceeds budget')
                files.append({'path': relative, 'base64': base64.b64encode(content).decode('ascii')})
        if not files:
            raise ValueError('empty app export')
        files.sort(key=lambda entry: entry['path'])
        output({'files': files})
        return
    if request['operation'] == 'agent':
        agent(root, identity, request)
        return
    if request['operation'] != 'start':
        raise ValueError('unknown app operation')
    env = dict(os.environ)
    env.update({'HOST': '0.0.0.0', 'PORT': '0', 'WSL_DATA_DIR': str(root / '.data' / 'pglite'),
                'WSL_WORKSPACE_ID': identity['workspaceId'], 'WSL_ENVIRONMENT_ID': 'sandbox',
                'WSL_PROJECT_ID': project, 'WSL_APP_INSTANCE_ID': request['appInstanceId'], 'WSL_DEV_SESSIONS': '1'})
    # 1.1.0+ 项目用 agent 构建挂载控制面；旧项目没有该脚本，照旧生产构建，不强制升级。
    token = request.get('agentToken')
    if token is not None and (not isinstance(token, str) or not re.fullmatch(r'[0-9a-f]{64}', token)):
        raise ValueError('invalid agent token')
    scripts = json.loads((root / 'package.json').read_text()).get('scripts', {})
    build = ['npm', 'run', 'build:agent'] if token and isinstance(scripts, dict) and 'build:agent' in scripts else ['npm', 'run', 'build']
    commands = []
    if not (root / '.wsl-prepared').exists():
        commands = [['npm', 'ci', '--ignore-scripts', '--workspaces=false'], ['npm', 'run', 'db:migrate'],
                    ['npm', 'run', 'db:seed'], ['npm', 'run', 'check'], build]
    else:
        commands = [['npm', 'run', 'db:migrate'], ['npm', 'run', 'check'], build]
    dependency_lock = root / '.wsl-dependency-lock'
    if dependency_lock.exists() and dependency_lock.read_text() == hashlib.sha256((root / 'package-lock.json').read_bytes()).hexdigest():
        commands = [command for command in commands if command[:2] != ['npm', 'ci']]
        print('WSL_APP_PHASE: verified offline Linux dependencies', flush=True)
    for command in commands:
        print('WSL_APP_PHASE:' + ' '.join(command), flush=True)
        subprocess.run(command, cwd=root, env=env, check=True)
    (root / '.wsl-prepared').touch()
    os.chdir(root)
    # 令牌只交给最终服务进程，不进入构建与检查命令的环境。
    if token and build[-1] == 'build:agent':
        env['WSL_AGENT_TOKEN'] = token
    os.execvpe('npm', ['npm', 'start'], env)


SOURCE_MAX_BYTES = 200 * 1024 * 1024
SOURCE_MAX_FILES = 20000
SOURCE_MAX_DIRECTORIES = 20000
SOURCE_CHUNK_BYTES = 48 * 1024
SOURCE_EXCLUDED = {'node_modules', 'dist', '.data', 'data', '.git', '.vite',
                   '.env', '.npmrc', '.netrc', '.pypirc', '.git-credentials',
                   '.ssh', '.aws', '.azure', '.gnupg', '.codex', '.docker',
                   'id_rsa', 'id_dsa', 'id_ecdsa', 'id_ed25519', 'id_ecdsa_sk', 'id_ed25519_sk'}


def source_frame(value):
    print('WSL_SOURCE:' + json.dumps(value, ensure_ascii=False, separators=(',', ':')), flush=True)


def source_path(value):
    parts = value.split('/')
    if (len(value.encode('utf-8')) > 1024 or len(parts) > 64 or unicodedata.normalize('NFC', value) != value
            or '\\' in value or ':' in value or any(unicodedata.category(char) in ('Cc', 'Cf', 'Cs', 'Zl', 'Zp') for char in value)
            or any(part in ('', '.', '..') or part.endswith(('.', ' ')) for part in parts)):
        raise ValueError('unsafe or unsupported source path')
    return value


def source_stat(info):
    return (info.st_dev, info.st_ino, info.st_mode, info.st_nlink, info.st_size, info.st_mtime_ns, info.st_ctime_ns)


def source_snapshot(project, workspace_id):
    max_bytes = SOURCE_MAX_BYTES
    max_files = SOURCE_MAX_FILES
    excluded = SOURCE_EXCLUDED
    flags = os.O_RDONLY | os.O_NOFOLLOW | os.O_NONBLOCK
    directory_flags = flags | os.O_DIRECTORY
    parent = os.open('/', directory_flags)
    try:
        for part in ROOT.parts[1:]:
            child = os.open(part, directory_flags, dir_fd=parent)
            os.close(parent)
            parent = child
        root = os.open(project, directory_flags, dir_fd=parent)
        try:
            root_stat = source_stat(os.fstat(root))
            if root_stat[2] & 0o7000:
                raise ValueError('source special modes are unsupported')
            identity_fd = os.open('.wsl-identity.json', flags, dir_fd=root)
            try:
                identity_stat = os.fstat(identity_fd)
                if not stat.S_ISREG(identity_stat.st_mode) or identity_stat.st_mode & 0o7000 or identity_stat.st_nlink != 1 or identity_stat.st_size > 4096:
                    raise ValueError('unsafe source identity')
                identity = json.loads(os.read(identity_fd, 4097))
                if identity != {'workspaceId': workspace_id, 'environmentId': 'sandbox', 'projectId': project}:
                    raise ValueError('app workspace identity mismatch')
                if source_stat(identity_stat) != source_stat(os.fstat(identity_fd)):
                    raise ValueError('source identity changed')
            finally:
                os.close(identity_fd)
            # Standard projects do not carry imported-product profile receipts.
            # Do not silently collect an unsupported product as a standard App.
            try:
                os.stat('.wsl-profile.json', dir_fd=root, follow_symlinks=False)
            except FileNotFoundError:
                pass
            else:
                raise ValueError('unsupported source profile receipt')
            facts = {}
            folded = {}
            total = 0
            count = 0
            directories = 0

            def names_in(fd):
                names = []
                with os.scandir(fd) as entries:
                    for entry in entries:
                        if len(names) >= SOURCE_MAX_FILES + SOURCE_MAX_DIRECTORIES:
                            raise ValueError('source directory entry budget exceeded')
                        names.append(entry.name)
                return sorted(names)

            def walk(fd, prefix, verify=False):
                nonlocal total, count, directories
                names = names_in(fd)
                for name in names:
                    if name.lower() in excluded or name.lower().startswith(('.wsl-', '.env.')):
                        continue
                    relative = source_path(prefix + name)
                    info = os.stat(name, dir_fd=fd, follow_symlinks=False)
                    if not (stat.S_ISDIR(info.st_mode) or stat.S_ISREG(info.st_mode)):
                        raise ValueError('source links or special files are unsupported')
                    if info.st_mode & 0o7000:
                        raise ValueError('source special modes are unsupported')
                    current = source_stat(info)
                    if verify:
                        if facts.pop(relative, None) != current:
                            raise ValueError('source changed during snapshot')
                    else:
                        key = unicodedata.normalize('NFC', relative.upper().lower())
                        if key in folded:
                            raise ValueError('source path collision')
                        folded[key] = relative
                        facts[relative] = current
                    if stat.S_ISDIR(info.st_mode):
                        if not verify:
                            directories += 1
                            if directories > SOURCE_MAX_DIRECTORIES:
                                raise ValueError('source directory budget exceeded')
                        child = os.open(name, directory_flags, dir_fd=fd)
                        try:
                            if source_stat(os.fstat(child)) != current:
                                raise ValueError('source directory changed')
                            walk(child, relative + '/', verify)
                            if source_stat(os.fstat(child)) != current:
                                raise ValueError('source directory changed')
                        finally:
                            os.close(child)
                    elif not verify:
                        if info.st_nlink != 1 or info.st_mode & 0o7000:
                            raise ValueError('source hardlinks or special modes are unsupported')
                        count += 1
                        if count > max_files or total + info.st_size > max_bytes:
                            raise ValueError('source snapshot budget exceeded')
                        source = os.open(name, flags, dir_fd=fd)
                        try:
                            if source_stat(os.fstat(source)) != current:
                                raise ValueError('source file changed')
                            source_frame({'type': 'file', 'path': relative, 'mode': '100755' if info.st_mode & 0o111 else '100644'})
                            length = 0
                            while True:
                                content = os.read(source, SOURCE_CHUNK_BYTES)
                                if not content:
                                    break
                                total += len(content)
                                length += len(content)
                                if total > max_bytes:
                                    raise ValueError('source snapshot budget exceeded')
                                source_frame({'type': 'chunk', 'base64': base64.b64encode(content).decode('ascii')})
                            if length != info.st_size or source_stat(os.fstat(source)) != current:
                                raise ValueError('source file changed')
                            source_frame({'type': 'end-file'})
                        finally:
                            os.close(source)
                    if source_stat(os.stat(name, dir_fd=fd, follow_symlinks=False)) != current:
                        raise ValueError('source path changed')
                if names != names_in(fd):
                    raise ValueError('source directory changed')

            walk(root, '')
            walk(root, '', True)
            if (facts or source_stat(os.fstat(root)) != root_stat
                    or source_stat(os.stat(project, dir_fd=parent, follow_symlinks=False)) != root_stat
                    or source_stat(os.stat('.wsl-identity.json', dir_fd=root, follow_symlinks=False)) != source_stat(identity_stat)):
                raise ValueError('source changed during snapshot')
            source_frame({'type': 'complete', 'totalBytes': total, 'fileCount': count})
        finally:
            os.close(root)
    finally:
        os.close(parent)


AGENT_DB_READS = {'query', 'snapshot'}


def agent(root, identity, request):
    """Read-only control-plane CLI for a stopped app; writes go through the running instance only."""
    args = request.get('args')
    if (not isinstance(args, list) or not 1 <= len(args) <= 6 or not all(isinstance(arg, str) and len(arg) <= 4096 for arg in args)
            or args[0] not in ('describe', 'db') or (args[0] == 'db' and (len(args) < 2 or args[1] not in AGENT_DB_READS))):
        raise ValueError('agent operation not allowed')
    if not (root / 'server' / 'agent-cli.ts').is_file():
        output({'unsupported': '项目未包含 Agent 控制面（模板 1.0.0）'})
        return
    if not (root / '.wsl-prepared').exists():
        output({'unsupported': '项目依赖尚未准备；先启动一次应用'})
        return
    env = {key: value for key, value in os.environ.items() if not key.startswith('WSL_AGENT_')}
    env.update({'WSL_DATA_DIR': str(root / '.data' / 'pglite'), 'WSL_WORKSPACE_ID': identity['workspaceId'],
                'WSL_ENVIRONMENT_ID': 'sandbox', 'WSL_PROJECT_ID': identity['projectId']})
    try:
        completed = subprocess.run(['node', '--import', 'tsx', 'server/agent-cli.ts', *args, '--json'], cwd=root, env=env,
                                   stdin=subprocess.DEVNULL, capture_output=True, timeout=25)
    except subprocess.TimeoutExpired:
        output({'exitCode': 124, 'stdout': '', 'stderr': 'agent-cli timed out'})
        return
    output({'exitCode': completed.returncode, 'stdout': completed.stdout[-1048576:].decode('utf-8', 'replace'),
            'stderr': completed.stderr[-2000:].decode('utf-8', 'replace')})


if __name__ == '__main__':
    request = json.loads(sys.argv[1]) if len(sys.argv) > 1 else json.load(sys.stdin)
    if request.get('operation') == 'dependencies':
        try:
            run(request)
        finally:
            # No descendants are started by this finite importer. Even a rejected
            # hash has a distinct process completion receipt, unlike lost transport.
            output({'dependenciesCleanup': True})
    else:
        run(request)
