"""Trusted application commands; process ownership remains in guest-helper.py."""
import base64
import fcntl
import tempfile
import hashlib
import json
import os
from pathlib import Path
import re
import shutil
import stat
import subprocess
import sys
import tarfile

OWNED_PROCESS_BASE64 = ""
ROOT = Path('/home/agent/workspace/.wsl-apps')
LIMIT = 8 * 1024 * 1024
EXCLUDED = {'node_modules', 'dist', '.data', 'data', '.git', '.vite', '.wsl-identity.json', '.wsl-profile.json', '.wsl-prepared', '.wsl-deps.tar.gz', '.wsl-dependency-lock'}
EDU_LIMIT = 524288
EDU_ROOT_FILES = {'README.md', 'SPEC.md', 'API.md', 'DESIGN.md', 'UX-CONTRACT.md', 'AGENTS.md'}
EDU_REQUIRED = {'admin/package.json', 'admin/package-lock.json', 'server/app.py', 'server/requirements.lock', 'server/requirements-test.lock', 'server/wsl_runtime.py'}
EDU_EXCLUDED = EXCLUDED | {'.venv', 'venv', '__pycache__', '.pytest_cache', '.ruff_cache', '.mypy_cache', '.runtime', 'coverage'}
STANDARD_PROFILE = {'projectKind': 'standard-app', 'profileVersion': 1}


def relative_path(value):
    if not isinstance(value, str) or not value or '\\' in value or '\x00' in value or any(p in ('', '.', '..') for p in value.split('/')):
        raise ValueError('unsafe app file path')
    if value.split('/')[0] in EXCLUDED or value.startswith('.wsl-'):
        raise ValueError('reserved app file path')
    return value


def output(value):
    print('WSL_APP_RESULT:' + json.dumps(value, separators=(',', ':')), flush=True)


def edu_excluded(name):
    return name in EDU_EXCLUDED or name.startswith(('.env', '.wsl-'))


def edu_path(value):
    relative_path(value)
    parts = value.split('/')
    if len(value) > 500 or any(ord(char) < 32 or ord(char) == 127 for char in value) or any(edu_excluded(part) for part in parts):
        return False
    if len(parts) == 1:
        return value in EDU_ROOT_FILES
    if value == 'docs/development/webstudiolab.md':
        return True
    return (parts[0] == 'admin' and Path(value).suffix in {'.json', '.ts', '.tsx', '.js', '.mjs', '.css', '.html', '.md'}) or (parts[0] == 'server' and Path(value).suffix in {'.py', '.txt', '.lock', '.md'})


def edu_metadata(files):
    if not isinstance(files, list) or not 0 < len(files) <= 256:
        raise ValueError('invalid edu source count')
    entries = []
    total = 0
    seen = set()
    for item in files:
        relative = item['path']
        if not edu_path(relative) or relative in seen or len(item['base64']) > 4000000:
            raise ValueError('invalid edu source path or encoding budget')
        seen.add(relative)
        content = base64.b64decode(item['base64'], validate=True)
        total += len(content)
        if total > EDU_LIMIT:
            raise ValueError('edu source byte budget exceeded')
        entries.append({'path': relative, 'sha256': hashlib.sha256(content).hexdigest(), 'bytes': len(content)})
    if not EDU_REQUIRED.issubset(seen):
        raise ValueError('required edu source missing')
    entries.sort(key=lambda item: item['path'].encode('utf-16-be'))
    digest = hashlib.sha256(json.dumps(entries, ensure_ascii=False, separators=(',', ':')).encode()).hexdigest()
    return entries, digest


def edu_profile(profile):
    if not isinstance(profile, dict) or set(profile) != {'projectKind', 'profileVersion', 'source'} or profile['projectKind'] != 'edu-web' or type(profile['profileVersion']) is not int or profile['profileVersion'] != 1:
        raise ValueError('unsupported edu profile')
    source = profile['source']
    if not isinstance(source, dict) or set(source) != {'repository', 'sourceSha256', 'files'}:
        raise ValueError('invalid edu provenance')
    repository = source['repository']
    if not isinstance(repository, dict) or set(repository) != {'commit', 'dirty'} or not re.fullmatch('[a-f0-9]{40}', repository['commit']) or type(repository['dirty']) is not bool:
        raise ValueError('invalid edu repository identity')
    if not isinstance(source['files'], list) or not 0 < len(source['files']) <= 256:
        raise ValueError('invalid edu baseline count')
    normalized = []
    for entry in source['files']:
        if set(entry) != {'path', 'sha256', 'bytes'} or not edu_path(entry['path']) or type(entry['bytes']) is not int or not 0 <= entry['bytes'] <= EDU_LIMIT or not re.fullmatch('[a-f0-9]{64}', entry['sha256']):
            raise ValueError('invalid edu baseline entry')
        normalized.append({'path': entry['path'], 'sha256': entry['sha256'], 'bytes': entry['bytes']})
    paths = [entry['path'] for entry in normalized]
    if len(set(paths)) != len(paths) or paths != sorted(paths, key=lambda value: value.encode('utf-16-be')) or sum(entry['bytes'] for entry in normalized) > EDU_LIMIT:
        raise ValueError('invalid edu baseline ordering or budget')
    if not EDU_REQUIRED.issubset(paths) or hashlib.sha256(json.dumps(normalized, ensure_ascii=False, separators=(',', ':')).encode()).hexdigest() != source['sourceSha256']:
        raise ValueError('edu baseline digest mismatch')
    return source


def edu_inventory(root):
    files = []
    total = 0
    visited = 0
    def walk(relative):
        nonlocal total, visited
        visited += 1
        if visited > 4096 or len(relative.split('/')) > 32:
            raise ValueError('edu directory traversal budget exceeded')
        source = root / relative
        if edu_excluded(source.name):
            return
        try:
            info = source.lstat()
        except FileNotFoundError:
            if relative in EDU_ROOT_FILES or relative == 'docs/development/webstudiolab.md':
                return
            raise
        if stat.S_ISLNK(info.st_mode) or source.resolve() != source:
            raise ValueError('edu source symlink')
        if stat.S_ISDIR(info.st_mode):
            for child in sorted(source.iterdir()):
                walk(child.relative_to(root).as_posix())
            return
        if not edu_path(relative):
            return
        if not stat.S_ISREG(info.st_mode) or info.st_nlink != 1 or info.st_size + total > EDU_LIMIT or len(files) >= 256:
            raise ValueError('invalid edu source file or byte budget')
        with os.fdopen(os.open(source, os.O_RDONLY | os.O_NOFOLLOW), 'rb') as handle:
            opened = os.fstat(handle.fileno())
            if (opened.st_dev, opened.st_ino, opened.st_nlink) != (info.st_dev, info.st_ino, 1):
                raise ValueError('edu source changed while reading')
            content = handle.read(EDU_LIMIT - total + 1)
            after = os.fstat(handle.fileno())
        if len(content) != info.st_size or (after.st_size, after.st_mtime_ns, after.st_ctime_ns) != (info.st_size, info.st_mtime_ns, info.st_ctime_ns) or source.resolve() != source:
            raise ValueError('edu source changed while reading')
        total += len(content)
        files.append({'path': relative, 'base64': base64.b64encode(content).decode()})
    for relative in [*sorted(EDU_ROOT_FILES), 'admin', 'server', 'docs/development/webstudiolab.md']:
        walk(relative)
    files.sort(key=lambda item: item['path'].encode('utf-16-be'))
    return files


def edu_validate_current(root, profile):
    baseline = edu_profile(profile)
    files = edu_inventory(root)
    metadata, digest = edu_metadata(files)
    protected = lambda entries: [entry for entry in entries if not entry['path'].startswith('admin/src/')]
    if protected(metadata) != protected(baseline['files']):
        raise ValueError('edu protected backend or lockfile changed; explicit source import required')
    return files, digest


def edu_apply_task(root, profile, files, task):
    # The check and replacement share the project write gate. The model never
    # receives this helper or a writable mount of the managed project.
    with (root / '.wsl-task-lock').open('a') as lock:
        fcntl.flock(lock, fcntl.LOCK_EX)
        before, digest = edu_validate_current(root, profile)
        metadata, _ = edu_metadata(before)
        proposed, _ = edu_metadata(files)
        protected = lambda entries: [item for item in entries if not item['path'].startswith('admin/src/')]
        if digest != task['sourceSha256'] or protected(metadata) != task['protectedFiles']:
            raise ValueError('edu task source changed')
        if protected(proposed) != task['protectedFiles']:
            raise ValueError('edu task changed protected files')
        parent = Path(tempfile.mkdtemp(prefix='.wsl-task-stage-', dir=root))
        current = root / 'admin/src'
        staged = parent / 'src'
        backup = parent / 'before'
        try:
            shutil.copytree(current, staged)
            new_files = {item['path']: item['base64'] for item in files if item['path'].startswith('admin/src/')}
            for item in before:
                if item['path'].startswith('admin/src/') and item['path'] not in new_files:
                    (staged / item['path'][len('admin/src/'):]).unlink()
            for relative, encoded in new_files.items():
                destination = staged / relative[len('admin/src/'):]
                destination.parent.mkdir(parents=True, exist_ok=True)
                destination.write_bytes(base64.b64decode(encoded, validate=True))
            _, actual = edu_validate_current(root, profile)
            if actual != digest:
                raise ValueError('edu task source changed before replacement')
            current.rename(backup)
            try:
                staged.rename(current)
            except BaseException:
                backup.rename(current)
                raise
            output({'applied': True})
        finally:
            shutil.rmtree(parent)


def edu_start(root, profile, identity, instance, verification=None):
    os.umask(0o077)
    _, before = edu_validate_current(root, profile)
    home = root / '.wsl-home'
    if home.is_symlink():
        raise ValueError('edu build home must not be a symlink')
    home.mkdir(mode=0o700, exist_ok=True)
    env = {'PATH': '/home/agent/.local/bin:/usr/local/bin:/usr/local/share/npm-global/bin:/usr/bin:/bin', 'HOME': str(home), 'LANG': 'C.UTF-8', 'PYTHONDONTWRITEBYTECODE': '1', 'PYTHONUNBUFFERED': '1', 'PYTHONNOUSERSITE': '1', 'EDU_AI_ENABLED': '0'}
    python = shutil.which('python3.12', path=env['PATH'])
    if not python:
        raise ValueError('edu requires guest Python 3.12; install the approved runtime before starting')
    foundation = str(Path(python).resolve(strict=True))
    version = subprocess.run([foundation, '-c', 'import json,sys; print(json.dumps(list(sys.version_info[:3])))'], env=env, check=True, capture_output=True, text=True)
    if json.loads(version.stdout)[:2] != [3, 12]:
        raise ValueError('edu requires Python 3.12')
    venv = root / '.venv'
    if venv.is_symlink() or (venv / 'bin').is_symlink():
        raise ValueError('edu virtual environment directory must not be a symlink')
    if not venv.exists():
        subprocess.run([foundation, '-m', 'venv', '--symlinks', str(venv)], cwd=root, env=env, check=True)
    python = str(venv / 'bin/python')
    if str(Path(python).resolve(strict=True)) != foundation:
        raise ValueError('edu virtual environment interpreter does not match the guest runtime')
    fingerprint = json.dumps({'python': foundation, 'version': json.loads(version.stdout), 'locks': {name: hashlib.sha256((root / name).read_bytes()).hexdigest() for name in ('server/requirements.lock', 'server/requirements-test.lock', 'admin/package-lock.json')}}, sort_keys=True)
    prepared = root / '.wsl-edu-prepared'
    if prepared.is_symlink() or (prepared.exists() and (not prepared.is_file() or prepared.stat().st_nlink != 1)):
        raise ValueError('invalid edu dependency receipt')
    commands = []
    if not prepared.exists() or prepared.read_text() != fingerprint:
        commands = [[python, '-m', 'pip', '--isolated', 'install', '--disable-pip-version-check', '--no-cache-dir', '--require-hashes', '--only-binary=:all:', '--retries', '0', '--timeout', '20', '--cert', '/etc/ssl/certs/ca-certificates.crt', '--index-url', 'https://pypi.org/simple', '-r', 'server/requirements-test.lock'], ['npm', '--prefix', 'admin', 'ci', '--ignore-scripts', '--no-audit', '--no-fund']]
    commands += [[python, '-m', 'pip', 'check'], [python, '-m', 'pytest', 'server/tests', '-q', '-p', 'no:cacheprovider'], ['npm', '--prefix', 'admin', 'run', 'typecheck'], ['npm', '--prefix', 'admin', 'run', 'build']]
    for command in commands:
        print('WSL_APP_PHASE:' + ' '.join(command), flush=True)
        subprocess.run(command, cwd=root, env=env, check=True)
    _, after = edu_validate_current(root, profile)
    if before != after:
        raise ValueError('edu source changed during validation; refusing stale build')
    if verification is not None:
        from uuid import UUID
        expected = {**identity, 'appInstanceId': instance}
        if (not isinstance(verification, dict) or set(verification) != {'schemaVersion', 'sessionId', 'identity', 'sourceSha256', 'expiresAtMs'}
                or type(verification['schemaVersion']) is not int or verification['schemaVersion'] != 1
                or verification['identity'] != expected or verification['sourceSha256'] != after
                or str(UUID(verification['sessionId'])) != verification['sessionId']
                or type(verification['expiresAtMs']) is not int or verification['expiresAtMs'] <= int(__import__('time').time() * 1000)):
            raise ValueError('verification identity, source or expiry mismatch')
        env['WSL_EDU_VERIFICATION'] = json.dumps(verification, separators=(',', ':'))
    prepared.write_text(fingerprint)
    env.update({'HOST': '0.0.0.0', 'PORT': '0', 'WSL_DATA_DIR': str(root / '.data'), 'WSL_WORKSPACE_ID': identity['workspaceId'], 'WSL_ENVIRONMENT_ID': 'sandbox', 'WSL_PROJECT_ID': identity['projectId'], 'WSL_APP_INSTANCE_ID': instance})
    print('WSL_APP_SOURCE:' + after, flush=True)
    os.chdir(root)
    os.execve(python, [python, '-m', 'server.wsl_runtime'], env)


def run(request):
    project = request['projectId']
    if not isinstance(project, str) or not re.fullmatch(r'[A-Za-z0-9][A-Za-z0-9_-]{0,127}', project):
        raise ValueError('invalid project identity')
    profile = request.get('profile', STANDARD_PROFILE)
    if not isinstance(profile, dict):
        raise ValueError('invalid project profile')
    edu = profile.get('projectKind') == 'edu-web'
    if edu:
        os.umask(0o077)
        baseline = edu_profile(profile)
        if request['operation'] == 'create':
            metadata, digest = edu_metadata(request['files'])
            if metadata != baseline['files'] or digest != baseline['sourceSha256']:
                raise ValueError('edu import source digest mismatch')
    elif profile != STANDARD_PROFILE:
        raise ValueError('unsupported project profile')
    ROOT.mkdir(mode=0o700, exist_ok=True)
    if ROOT.is_symlink():
        raise ValueError('app root must not be a symlink')
    root = ROOT.resolve(strict=True) / project
    identity = {'workspaceId': request['workspaceId'], 'environmentId': 'sandbox', 'projectId': project}
    if request['operation'] == 'create':
        # Exclusive mkdir is the project write gate, including across service processes.
        root.mkdir(mode=0o700)
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
        with (root / '.wsl-profile.json').open('x') as target:
            json.dump(profile, target)
        output({'created': True})
        return
    if root.is_symlink() or json.loads((root / '.wsl-identity.json').read_text()) != identity:
        raise ValueError('app workspace identity mismatch')
    saved_profile = root / '.wsl-profile.json'
    if saved_profile.is_symlink() or (saved_profile.exists() and (not saved_profile.is_file() or saved_profile.stat().st_nlink != 1 or saved_profile.stat().st_size > EDU_LIMIT)):
        raise ValueError('invalid app profile receipt')
    stored = json.loads(saved_profile.read_text()) if saved_profile.exists() else STANDARD_PROFILE
    if stored != profile:
        raise ValueError('app profile identity mismatch')
    if edu:
        if request['operation'] == 'export':
            files, _ = edu_validate_current(root, profile)
            output({'files': files})
        elif request['operation'] == 'recover-owned':
            _, digest = edu_validate_current(root, profile)
            expected=request['owner']
            if expected['identity'] != {**identity,'appInstanceId':request['appInstanceId']} or expected['sourceSha256'] != digest:
                raise ValueError('recovery source or identity mismatch')
            owned={'__name__':'wsl_edu_owned_recovery'}
            exec(compile(base64.b64decode(OWNED_PROCESS_BASE64),'<edu-owned-process>','exec'),owned)
            try:
                receipt=owned['reconcile'](expected)
            except owned['RecoveryError'] as error:
                receipt={'recoveryError':error.code}
            output(receipt)
            # Keep the same VM session alive until the host removes the exact owned mapping.
            sys.stdin.buffer.read()
        elif request['operation'] == 'apply-task':
            edu_apply_task(root, profile, request['files'], request['task'])
        elif request['operation'] == 'start':
            edu_start(root, profile, identity, request['appInstanceId'], request.get('verification'))
        else:
            raise ValueError('unsupported: standard-template operations are not available for edu-web')
        return
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
                with source.open('rb') as handle:
                    content = handle.read(LIMIT + 1)
                total += len(content)
                if total > LIMIT or len(files) >= 256:
                    raise ValueError('app export exceeds budget')
                files.append({'path': relative, 'base64': base64.b64encode(content).decode('ascii')})
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
    initial = sys.argv[1].encode() if len(sys.argv) > 1 else sys.stdin.buffer.readline(1048577)
    if len(initial) > 1048576:
        raise ValueError('app request exceeds budget')
    request = json.loads(initial)
    if request.get('operation') == 'dependencies':
        try:
            run(request)
        finally:
            # No descendants are started by this finite importer. Even a rejected
            # hash has a distinct process completion receipt, unlike lost transport.
            output({'dependenciesCleanup': True})
    else:
        run(request)
