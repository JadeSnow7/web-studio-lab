"""Trusted application commands; process ownership remains in guest-helper.py."""
import base64
import ctypes
import errno
import fcntl
from contextlib import contextmanager
import tempfile
import shutil
from uuid import UUID
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

OWNED_PROCESS_BASE64 = ""
ROOT = Path('/home/agent/workspace/.wsl-apps')
LIMIT = 8 * 1024 * 1024
EXCLUDED = {'node_modules', 'dist', '.data', 'data', '.git', '.vite', '.wsl-identity.json', '.wsl-profile.json', '.wsl-prepared', '.wsl-deps.tar.gz', '.wsl-dependency-lock'}

EDU_LIMIT = 524288
EDU_ROOT_FILES = {'README.md', 'SPEC.md', 'API.md', 'DESIGN.md', 'UX-CONTRACT.md', 'AGENTS.md'}
EDU_REQUIRED = {'admin/package.json', 'admin/package-lock.json', 'server/app.py', 'server/requirements.lock', 'server/requirements-test.lock', 'server/wsl_runtime.py'}
EDU_EXCLUDED = EXCLUDED | {'.venv', 'venv', '__pycache__', '.pytest_cache', '.ruff_cache', '.mypy_cache', '.runtime', 'coverage'}
STANDARD_PROFILE = {'projectKind': 'standard-app', 'profileVersion': 1}
EXPORT_CONTRACTS = {
    'standard-app': {'maxFiles': 256, 'maxSourceBytes': 524288},
    'edu-web': {'maxFiles': 256, 'maxSourceBytes': 524288},
}


def export_policy(request):
    profile = request.get('profile', STANDARD_PROFILE)
    if not isinstance(profile, dict) or profile.get('projectKind') not in ('standard-app', 'edu-web') or type(profile.get('profileVersion')) is not int or profile['profileVersion'] != 1:
        raise ValueError('unsupported source export profile')
    if profile['projectKind'] == 'edu-web':
        edu_profile(profile)
    elif set(profile) != {'projectKind', 'profileVersion'}:
        raise ValueError('invalid standard source export profile')
    expected = EXPORT_CONTRACTS[profile['projectKind']]
    budget = request.get('exportBudget')
    if not isinstance(budget, dict) or set(budget) != set(expected) or any(type(budget[key]) is not int or budget[key] != expected[key] for key in expected):
        raise ValueError('invalid source export budget')
    return expected


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


def edu_inventory(root, export_budget=None):
    max_files = 256 if export_budget is None else export_budget['maxFiles']
    max_bytes = EDU_LIMIT if export_budget is None else export_budget['maxSourceBytes']
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
            names = []
            remaining = 4096 - visited
            with os.scandir(source) as entries:
                for entry in entries:
                    if len(names) >= remaining:
                        raise ValueError('edu directory traversal budget exceeded')
                    names.append(entry.name)
            for name in sorted(names):
                walk((source / name).relative_to(root).as_posix())
            return
        if not edu_path(relative):
            return
        if not stat.S_ISREG(info.st_mode) or info.st_nlink != 1 or info.st_size + total > max_bytes or len(files) >= max_files:
            raise ValueError('invalid edu source file or byte budget')
        with os.fdopen(os.open(source, os.O_RDONLY | os.O_NOFOLLOW), 'rb') as handle:
            opened = os.fstat(handle.fileno())
            if (opened.st_dev, opened.st_ino, opened.st_nlink) != (info.st_dev, info.st_ino, 1):
                raise ValueError('edu source changed while reading')
            content = handle.read(max_bytes - total + 1)
            after = os.fstat(handle.fileno())
        if export_budget is not None and total + len(content) > max_bytes:
            raise ValueError('edu export exceeds byte budget')
        if len(content) != info.st_size or (after.st_size, after.st_mtime_ns, after.st_ctime_ns) != (info.st_size, info.st_mtime_ns, info.st_ctime_ns) or source.resolve() != source:
            raise ValueError('edu source changed while reading')
        total += len(content)
        files.append({'path': relative, 'base64': base64.b64encode(content).decode()})
    for relative in [*sorted(EDU_ROOT_FILES), 'admin', 'server', 'docs/development/webstudiolab.md']:
        walk(relative)
    files.sort(key=lambda item: item['path'].encode('utf-16-be'))
    return files


def edu_validate_current(root, profile, export_budget=None):
    baseline = edu_profile(profile)
    files = edu_inventory(root, export_budget)
    metadata, digest = edu_metadata(files)
    protected = lambda entries: [entry for entry in entries if not entry['path'].startswith('admin/src/')]
    if protected(metadata) != protected(baseline['files']):
        raise ValueError('edu protected backend or lockfile changed; explicit source import required')
    return files, digest


class ImportFailure(Exception):
    def __init__(self, code):
        super().__init__(code)
        self.code = code


def import_directory(path):
    info = path.lstat()
    if not stat.S_ISDIR(info.st_mode) or info.st_uid != os.getuid() or info.st_mode & 0o022:
        raise ImportFailure('import_ownership_unknown')
    return {'device': info.st_dev, 'inode': info.st_ino}


def import_read_json(path):
    before = path.lstat()
    if not stat.S_ISREG(before.st_mode):
        raise ImportFailure('import_ownership_unknown')
    with os.fdopen(os.open(path, os.O_RDONLY | os.O_NOFOLLOW | os.O_NONBLOCK), 'rb') as handle:
        info = os.fstat(handle.fileno())
        if (info.st_dev, info.st_ino) != (before.st_dev, before.st_ino) or not stat.S_ISREG(info.st_mode) or info.st_nlink != 1 or info.st_uid != os.getuid() or info.st_mode & 0o077 or info.st_size > EDU_LIMIT:
            raise ImportFailure('import_ownership_unknown')
        data = handle.read(EDU_LIMIT + 1)
        after = os.fstat(handle.fileno())
    if len(data) != info.st_size or (after.st_size, after.st_mtime_ns, after.st_ctime_ns) != (info.st_size, info.st_mtime_ns, info.st_ctime_ns):
        raise ImportFailure('import_ownership_unknown')
    return json.loads(data)


def import_sync_directory(path):
    fd = os.open(path, os.O_RDONLY | os.O_DIRECTORY | os.O_NOFOLLOW)
    try:
        os.fsync(fd)
    finally:
        os.close(fd)


def import_write_json(path, value, replace=False):
    data = json.dumps(value, ensure_ascii=False, separators=(',', ':')).encode()
    if not replace:
        with os.fdopen(os.open(path, os.O_WRONLY | os.O_CREAT | os.O_EXCL | os.O_NOFOLLOW, 0o600), 'wb') as handle:
            handle.write(data)
            handle.flush()
            os.fsync(handle.fileno())
        import_sync_directory(path.parent)
        return
    fd, name = tempfile.mkstemp(prefix=path.name + '.', suffix='.pending', dir=path.parent)
    try:
        with os.fdopen(fd, 'wb') as handle:
            handle.write(data)
            handle.flush()
            os.fsync(handle.fileno())
        os.replace(name, path)
        import_sync_directory(path.parent)
    finally:
        if os.path.lexists(name):
            os.unlink(name)


@contextmanager
def import_lock(path):
    # Lock a permanent inode, never the atomically replaced receipt. A live or
    # unknown worker is a reconciliation failure, not permission to wait/replay.
    fd = os.open(path, os.O_RDWR | os.O_CREAT | os.O_NOFOLLOW, 0o600)
    try:
        info = os.fstat(fd)
        if not stat.S_ISREG(info.st_mode) or info.st_nlink != 1 or info.st_uid != os.getuid() or info.st_mode & 0o077:
            raise ImportFailure('import_ownership_unknown')
        try:
            fcntl.flock(fd, fcntl.LOCK_EX | fcntl.LOCK_NB)
        except BlockingIOError:
            raise ImportFailure('import_cleanup_unknown') from None
        yield
    finally:
        os.close(fd)


def import_publish(staging, destination):
    # Plain rename may replace an existing empty directory. There is deliberately
    # no check-then-rename fallback on platforms without atomic no-replace.
    libc = ctypes.CDLL(None, use_errno=True)
    if sys.platform == 'linux' and hasattr(libc, 'renameat2'):
        rename = libc.renameat2
        rename.argtypes = [ctypes.c_int, ctypes.c_char_p, ctypes.c_int, ctypes.c_char_p, ctypes.c_uint]
        result = rename(-100, os.fsencode(staging), -100, os.fsencode(destination), 1)
    elif sys.platform == 'darwin' and hasattr(libc, 'renamex_np'):
        rename = libc.renamex_np
        rename.argtypes = [ctypes.c_char_p, ctypes.c_char_p, ctypes.c_uint]
        result = rename(os.fsencode(staging), os.fsencode(destination), 4)
    else:
        raise ImportFailure('import_publish_unsupported')
    if result:
        code = ctypes.get_errno()
        if code in (errno.EEXIST, errno.ENOTEMPTY):
            raise ImportFailure('import_target_conflict')
        if code in (errno.ENOSYS, errno.EINVAL, errno.ENOTSUP):
            raise ImportFailure('import_publish_unsupported')
        raise OSError(code, 'import publication failed')
    import_sync_directory(destination.parent)


def import_owner(receipt):
    return {key: receipt[key] for key in ('schemaVersion', 'importOperationId', 'workspaceId', 'projectId', 'profile', 'directory')}


def import_owned(path, receipt):
    if receipt['directory'] is None or import_directory(path) != receipt['directory'] or import_read_json(path / '.wsl-import.json') != import_owner(receipt):
        raise ImportFailure('import_ownership_unknown')


def import_published(path, receipt):
    import_owned(path, receipt)
    profile = receipt['profile']
    baseline = edu_profile(profile)
    identity = {'workspaceId': receipt['workspaceId'], 'environmentId': 'sandbox', 'projectId': receipt['projectId']}
    if import_read_json(path / '.wsl-identity.json') != identity or import_read_json(path / '.wsl-profile.json') != profile:
        raise ImportFailure('import_ownership_unknown')
    metadata, digest = edu_metadata(edu_inventory(path))
    if metadata != baseline['files'] or digest != baseline['sourceSha256']:
        raise ImportFailure('import_source_changed')


def import_cleanup(staging, receipt):
    if not os.path.lexists(staging):
        return
    import_owned(staging, receipt)
    # A marker alone does not authorize deleting arbitrary added files/links.
    allowed = {entry['path'] for entry in edu_profile(receipt['profile'])['files']}
    allowed.update({'.wsl-import.json', '.wsl-identity.json', '.wsl-profile.json'})
    directories = {parent.as_posix() for name in allowed for parent in Path(name).parents if parent.as_posix() != '.'}
    for parent, children, names in os.walk(staging, followlinks=False):
        for name in children + names:
            item = Path(parent) / name
            relative = item.relative_to(staging).as_posix()
            info = item.lstat()
            if stat.S_ISDIR(info.st_mode):
                valid = relative in directories and info.st_uid == os.getuid()
            else:
                valid = stat.S_ISREG(info.st_mode) and info.st_nlink == 1 and info.st_uid == os.getuid() and relative in allowed
            if not valid:
                raise ImportFailure('import_cleanup_unknown')
    import_owned(staging, receipt)
    if not shutil.rmtree.avoids_symlink_attacks:
        raise ImportFailure('import_cleanup_unknown')
    shutil.rmtree(staging)
    import_sync_directory(staging.parent)
    if os.path.lexists(staging):
        raise ImportFailure('import_cleanup_unknown')


def import_receipt(path, operation, workspace, project, profile):
    if not os.path.lexists(path):
        return None
    receipt = import_read_json(path)
    if (not isinstance(receipt, dict) or set(receipt) != {'schemaVersion', 'importOperationId', 'workspaceId', 'projectId', 'profile', 'directory', 'state'}
            or type(receipt['schemaVersion']) is not int or receipt['schemaVersion'] != 1
            or receipt['state'] not in ('pending', 'imported', 'cancelled', 'failed')):
        raise ImportFailure('import_ownership_unknown')
    if (receipt['importOperationId'], receipt['workspaceId'], receipt['projectId']) != (operation, workspace, project):
        raise ImportFailure('import_operation_conflict')
    if receipt['profile'] is not None:
        edu_profile(receipt['profile'])
        if profile is not None and receipt['profile'] != profile:
            raise ImportFailure('import_operation_conflict')
    directory = receipt['directory']
    if directory is not None and (not isinstance(directory, dict) or set(directory) != {'device', 'inode'} or any(type(value) is not int or value < 0 for value in directory.values())):
        raise ImportFailure('import_ownership_unknown')
    return receipt


def edu_import_transaction(request):
    operation = request.get('importOperationId')
    result = {'outcome': 'failed', 'retryable': False, 'errorCode': 'import_invalid_request', 'importOperationId': operation}
    try:
        workspace, project = request['workspaceId'], request['projectId']
        if (not isinstance(operation, str) or str(UUID(operation)) != operation
                or not isinstance(workspace, str) or not 1 <= len(workspace) <= 200 or any(ord(char) < 32 for char in workspace)
                or not isinstance(project, str) or not re.fullmatch(r'[A-Za-z0-9][A-Za-z0-9_-]{0,127}', project)):
            raise ImportFailure('import_invalid_request')
        importing = request['operation'] == 'import-source'
        cancel = request.get('cancel', True)
        if type(cancel) is not bool:
            raise ImportFailure('import_invalid_request')
        profile = request.get('profile')
        if importing or profile is not None:
            baseline = edu_profile(profile)
        if importing:
            metadata, digest = edu_metadata(request['files'])
            if metadata != baseline['files'] or digest != baseline['sourceSha256']:
                raise ImportFailure('import_source_mismatch')
        os.umask(0o077)
        ROOT.mkdir(mode=0o700, exist_ok=True)
        import_directory(ROOT)
        root = ROOT.resolve(strict=True)
        import_sync_directory(root.parent)
        operations = root / '.wsl-import-operations'
        operations.mkdir(mode=0o700, exist_ok=True)
        import_directory(operations)
        import_sync_directory(root)
        with import_lock(operations / (operation + '.lock')):
            receipt_path = operations / (operation + '.json')
            receipt = import_receipt(receipt_path, operation, workspace, project, profile)
            with import_lock(operations / ('target-' + project + '.lock')):
                if receipt is None:
                    receipt = {'schemaVersion': 1, 'importOperationId': operation, 'workspaceId': workspace, 'projectId': project,
                               'profile': profile, 'directory': None, 'state': 'pending' if importing else ('cancelled' if cancel else 'failed')}
                    import_write_json(receipt_path, receipt)
                if not importing and cancel and receipt['state'] != 'imported':
                    # Even a foreign destination must not erase cancellation:
                    # it may disappear before a delayed import arrives.
                    receipt['state'] = 'cancelled'
                    import_write_json(receipt_path, receipt, replace=True)
                destination = root / project
                staging = root / ('.wsl-import-stage-' + operation)
                try:
                    if os.path.lexists(destination):
                        import_published(destination, receipt)
                        receipt['state'] = 'imported'
                        import_write_json(receipt_path, receipt, replace=True)
                    elif receipt['state'] == 'imported':
                        raise ImportFailure('import_ownership_unknown')
                    elif not importing or receipt['state'] == 'cancelled':
                        if cancel or receipt['state'] == 'cancelled':
                            receipt['state'] = 'cancelled'
                            import_write_json(receipt_path, receipt, replace=True)
                        import_cleanup(staging, receipt)
                        receipt['directory'] = None
                        receipt['state'] = 'cancelled' if cancel or receipt['state'] == 'cancelled' else 'failed'
                        import_write_json(receipt_path, receipt, replace=True)
                    else:
                        if receipt['profile'] is None:
                            receipt['profile'] = profile
                        import_cleanup(staging, receipt)
                        receipt.update(state='pending', directory=None)
                        import_write_json(receipt_path, receipt, replace=True)
                        staging.mkdir(mode=0o700)
                        receipt['directory'] = import_directory(staging)
                        import_write_json(receipt_path, receipt, replace=True)
                        import_write_json(staging / '.wsl-import.json', import_owner(receipt))
                        for entry in request['files']:
                            path = staging / entry['path']
                            path.parent.mkdir(parents=True, exist_ok=True, mode=0o700)
                            with os.fdopen(os.open(path, os.O_WRONLY | os.O_CREAT | os.O_EXCL | os.O_NOFOLLOW, 0o600), 'wb') as handle:
                                handle.write(base64.b64decode(entry['base64'], validate=True))
                                handle.flush()
                                os.fsync(handle.fileno())
                        identity = {'workspaceId': workspace, 'environmentId': 'sandbox', 'projectId': project}
                        import_write_json(staging / '.wsl-identity.json', identity)
                        import_write_json(staging / '.wsl-profile.json', profile)
                        import_published(staging, receipt)
                        for parent, _, _ in os.walk(staging, topdown=False):
                            import_sync_directory(Path(parent))
                        import_publish(staging, destination)
                        receipt['state'] = 'imported'
                        import_write_json(receipt_path, receipt, replace=True)
                except (OSError, ValueError, TypeError, KeyError, ImportFailure) as error:
                    # The no-replace rename is the commit point. A lost final
                    # receipt must never roll back or delete a published app.
                    if os.path.lexists(destination):
                        import_published(destination, receipt)
                        receipt['state'] = 'imported'
                    else:
                        if receipt['state'] == 'imported':
                            raise
                        import_cleanup(staging, receipt)
                        receipt.update(state='cancelled' if receipt['state'] == 'cancelled' or not importing and cancel else 'failed', directory=None)
                        import_write_json(receipt_path, receipt, replace=True)
                        if receipt['state'] == 'cancelled':
                            result.update(outcome='cancelled', retryable=False, errorCode=None)
                        else:
                            result.update(errorCode=error.code if isinstance(error, ImportFailure) else 'import_failed', retryable=isinstance(error, OSError))
                        output(result)
                        return
                if receipt['state'] == 'imported':
                    result.update(outcome='imported', retryable=False, errorCode=None, profile=receipt['profile'], sourceSha256=receipt['profile']['source']['sourceSha256'])
                elif receipt['state'] == 'cancelled':
                    result.update(outcome='cancelled', retryable=False, errorCode=None)
                else:
                    result.update(retryable=True, errorCode='import_failed')
    except ImportFailure as error:
        result['errorCode'] = error.code
    except (OSError, ValueError, TypeError, KeyError, AttributeError):
        result['errorCode'] = 'import_cleanup_unknown'
    output(result)


def edu_start(root, profile, identity, instance, expected_source_sha256):
    os.umask(0o077)
    _, before = edu_validate_current(root, profile)
    if not isinstance(expected_source_sha256, str) or not re.fullmatch('[a-f0-9]{64}', expected_source_sha256) or before != expected_source_sha256:
        raise ValueError('edu source changed after startup preflight')
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
    prepared.write_text(fingerprint)
    env.update({'HOST': '0.0.0.0', 'PORT': '0', 'WSL_DATA_DIR': str(root / '.data'), 'WSL_WORKSPACE_ID': identity['workspaceId'], 'WSL_ENVIRONMENT_ID': 'sandbox', 'WSL_PROJECT_ID': identity['projectId'], 'WSL_APP_INSTANCE_ID': instance})
    print('WSL_APP_SOURCE:' + after, flush=True)
    os.chdir(root)
    os.execve(python, [python, '-m', 'server.wsl_runtime'], env)


def run(request):
    budget = export_policy(request) if request.get("operation") == "export" else None
    if request.get("operation") in ("import-source", "reconcile-import"):
        edu_import_transaction(request)
        return
    project = request['projectId']
    if not isinstance(project, str) or not re.fullmatch(r'[A-Za-z0-9][A-Za-z0-9_-]{0,127}', project):
        raise ValueError('invalid project identity')
    if request['operation'] == 'source-snapshot':
        if set(request) != {'operation', 'workspaceId', 'projectId'}:
            raise ValueError('unsupported source request')
        source_snapshot(project, request['workspaceId'])
        return
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
    root = (ROOT.resolve(strict=True) if edu else ROOT) / project
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
        if edu:
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
            files, _ = edu_validate_current(root, profile, budget)
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
        elif request['operation'] == 'start':
            edu_start(root, profile, identity, request['appInstanceId'], request.get('expectedSourceSha256'))
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
