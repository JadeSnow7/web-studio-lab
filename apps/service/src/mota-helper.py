"""Bounded Mota source ingest. This module never executes imported code."""
import base64
import hashlib
import json
import os
from pathlib import Path
import re
import shutil
import stat
from uuid import UUID

ROOT = Path('/home/agent/workspace/.wsl-apps')
PREFIX = 'WSL_MOTA_TRANSFER:'
MARKER = b'mota-managed-copy-v1\n'
MAX_FILES = 512
MAX_BYTES = 64 * 1024 * 1024
FILE_BYTES = 12 * 1024 * 1024
CHUNK_BYTES = 32 * 1024
LINE_BYTES = 64 * 1024
INPUT_BYTES = 96 * 1024 * 1024
MAX_FRAMES = 4096
ROOT_FILES = {'index.html', 'editor.html', 'editor-mobile.html', 'styles.css', 'main.js', 'logo.png'}
ROOT_DIRS = {'project', 'libs', 'extensions', '_server', '_docs'}
REQUIRED = {'index.html', 'editor.html', 'main.js', 'libs/core.js', 'project/data.js',
            'project/floors/MT1.js', '_server/editor.js', '_server/editor_file.js'}
WRITABLE = {'project/floors/MT1.js', '_server/config.json'}
INTERNAL = {'.wsl-import.json', '.wsl-identity.json', '.wsl-profile.json', '.wsl-mota-copy'}
EXCLUDED = {'node_modules', '__pycache__', 'credentials', 'credential', 'secrets', 'secret',
            'password', 'passwords', 'passwd', 'token', 'tokens', 'access_token', 'refresh_token',
            'authorized_keys', 'known_hosts'}
BAD_NAME = re.compile(r'^(?:(?:credentials?|secrets?|passwords?|passwd|tokens?|access_token|refresh_token)\.(?:json|txt|ya?ml|toml|ini|conf|env)|(?:id_rsa|id_dsa|id_ecdsa|id_ed25519)(?:\..*)?|(?:(?:safe-)?mota-)?server\.(?:js|cjs|mjs|py))$', re.I)
BAD_EXT = re.compile(r'\.(?:pem|key|p12|pfx|keystore|py|pyc|sh|bash|zsh|bat|cmd|ps1|exe|dll|so|dylib)$', re.I)
FLAGS = os.O_RDONLY | os.O_NOFOLLOW | os.O_NONBLOCK
DIR_FLAGS = FLAGS | os.O_DIRECTORY


def _integer(value, low, high):
    return type(value) is int and low <= value <= high


def _hash(value):
    return isinstance(value, str) and re.fullmatch('[0-9a-f]{64}', value) is not None


def _uuid(value):
    try:
        return isinstance(value, str) and str(UUID(value)) == value
    except ValueError:
        return False


def _path(value):
    if not isinstance(value, str) or not value:
        raise ValueError('invalid Mota path')
    # JavaScript string lengths and ordering are UTF-16 code units.
    if len(value.encode('utf-16-be')) > 1000 or any(ord(c) < 32 or ord(c) == 127 for c in value) or re.search(r'[\\%?#:]', value):
        raise ValueError('invalid Mota path')
    value.encode('utf-8')
    parts = value.split('/')
    if any(not part or part.startswith('.') or part.lower() in EXCLUDED or BAD_NAME.fullmatch(part) or BAD_EXT.search(part) for part in parts):
        raise ValueError('excluded Mota path')
    if (len(parts) == 1 and value not in ROOT_FILES) or (len(parts) > 1 and parts[0] not in ROOT_DIRS):
        raise ValueError('Mota path outside source roots')
    return value


def _metadata(items, complete=True):
    if not isinstance(items, list) or not 0 <= len(items) <= MAX_FILES:
        raise ValueError('invalid Mota file count')
    result = []
    seen = set()
    for item in items:
        if not isinstance(item, dict) or set(item) != {'path', 'sha256', 'bytes'} or not _hash(item['sha256']) or not _integer(item['bytes'], 0, FILE_BYTES):
            raise ValueError('invalid Mota file metadata')
        name = _path(item['path'])
        if name in seen:
            raise ValueError('duplicate Mota path')
        seen.add(name)
        result.append({'path': name, 'sha256': item['sha256'], 'bytes': item['bytes']})
    if sum(item['bytes'] for item in result) > MAX_BYTES or (complete and not REQUIRED.issubset(seen)):
        raise ValueError('Mota source budget or required file mismatch')
    # Disallow a file as another file's parent, independently of arrival order.
    if any(parent.as_posix() in seen for name in seen for parent in Path(name).parents if parent.as_posix() != '.'):
        raise ValueError('Mota file/directory collision')
    result.sort(key=lambda item: item['path'].encode('utf-16-be'))
    return result


def _digest(items):
    return hashlib.sha256(json.dumps(_metadata(items), ensure_ascii=False, separators=(',', ':')).encode('utf-8')).hexdigest()


def profile(value):
    if (not isinstance(value, dict) or set(value) != {'projectKind', 'profileVersion', 'source'}
            or value['projectKind'] != 'mota-web' or type(value['profileVersion']) is not int or value['profileVersion'] != 1):
        raise ValueError('unsupported Mota profile')
    source = value['source']
    if not isinstance(source, dict) or set(source) != {'sourceSha256', 'files'} or not _hash(source['sourceSha256']):
        raise ValueError('invalid Mota source')
    entries = _metadata(source['files'])
    if _digest(entries) != source['sourceSha256']:
        raise ValueError('Mota manifest digest mismatch')
    return {'sourceSha256': source['sourceSha256'], 'files': entries}


def _binding(value, missing_hash=False):
    if (not isinstance(value, dict) or set(value) != {'workspaceId', 'environmentId', 'projectId', 'importOperationId', 'sourceSha256'}
            or not isinstance(value['workspaceId'], str) or not 1 <= len(value['workspaceId'].encode('utf-16-be')) // 2 <= 200
            or value['environmentId'] != 'sandbox' or not _uuid(value['projectId']) or not _uuid(value['importOperationId'])
            or not (_hash(value['sourceSha256']) or missing_hash and value['sourceSha256'] is None)):
        raise ValueError('invalid Mota binding')
    value['workspaceId'].encode('utf-8')
    return dict(value)


def _facts(info):
    return (info.st_dev, info.st_ino, info.st_mode, info.st_nlink, info.st_size, info.st_mtime_ns, info.st_ctime_ns)


def _open_directory(path):
    path = Path(path)
    if not path.is_absolute() or any(part in ('.', '..') for part in path.parts):
        raise ValueError('invalid managed root')
    fd = os.open('/', DIR_FLAGS)
    try:
        for part in path.parts[1:]:
            child = os.open(part, DIR_FLAGS, dir_fd=fd)
            os.close(fd)
            fd = child
        info = os.fstat(fd)
        if info.st_uid != os.getuid() or info.st_mode & 0o7022:
            raise ValueError('unsafe managed directory')
        return fd
    except BaseException:
        os.close(fd)
        raise


def _json(data):
    def unique(pairs):
        result = {}
        for key, value in pairs:
            if key in result:
                raise ValueError('duplicate Mota JSON field')
            result[key] = value
        return result
    return json.loads(data, object_pairs_hook=unique)


def _read(fd, name, limit, private=False):
    handle = os.open(name, FLAGS, dir_fd=fd)
    try:
        info = os.fstat(handle)
        if (not stat.S_ISREG(info.st_mode) or info.st_nlink != 1 or info.st_uid != os.getuid()
                or info.st_mode & (0o7077 if private else 0o7022) or info.st_size > limit):
            raise ValueError('unsafe Mota file')
        chunks = []
        total = 0
        while True:
            chunk = os.read(handle, min(CHUNK_BYTES, limit + 1 - total))
            if not chunk:
                break
            chunks.append(chunk)
            total += len(chunk)
            if total > limit:
                raise ValueError('Mota file exceeds budget')
        if total != info.st_size or _facts(info) != _facts(os.fstat(handle)):
            raise ValueError('Mota file changed while reading')
        return b''.join(chunks), _facts(info)
    finally:
        os.close(handle)


def _owner(receipt):
    return {key: receipt[key] for key in ('schemaVersion', 'binding', 'fileCount', 'totalBytes', 'directory')}


def _receipt(value, binding, expected_profile=None):
    if not isinstance(value, dict):
        raise ValueError('invalid Mota transaction receipt')
    # Old edu cancellation can precede knowledge of the selected source kind.
    if type(value.get('schemaVersion')) is int and value['schemaVersion'] == 1:
        if (set(value) != {'schemaVersion', 'importOperationId', 'workspaceId', 'projectId', 'profile', 'directory', 'state'}
                or value['profile'] is not None or value['directory'] is not None or value['state'] != 'cancelled'
                or any(value[key] != binding[key] for key in ('importOperationId', 'workspaceId', 'projectId'))):
            raise ValueError('foreign legacy import receipt')
        return value
    if (set(value) != {'schemaVersion', 'binding', 'fileCount', 'totalBytes', 'directory', 'state', 'files', 'completedFiles', 'profile'}
            or type(value['schemaVersion']) is not int or value['schemaVersion'] != 2
            or value['state'] not in ('pending', 'imported', 'cancelled', 'failed')):
        raise ValueError('invalid Mota transaction receipt')
    actual = _binding(value['binding'], missing_hash=True)
    if any(actual[key] != binding[key] for key in actual if key != 'sourceSha256') or (actual['sourceSha256'] is not None and binding['sourceSha256'] is not None and actual['sourceSha256'] != binding['sourceSha256']):
        raise ValueError('Mota transaction binding mismatch')
    directory = value['directory']
    if directory is not None and (not isinstance(directory, dict) or set(directory) != {'device', 'inode'} or any(not _integer(item, 0, 2**64 - 1) for item in directory.values())):
        raise ValueError('invalid Mota transaction directory')
    entries = _metadata(value['files'], complete=False)
    if value['files'] != entries or not _integer(value['completedFiles'], 0, len(entries)) or len(entries) - value['completedFiles'] > 1:
        raise ValueError('invalid Mota transaction progress')
    if actual['sourceSha256'] is None:
        if value['state'] not in ('cancelled', 'failed') or directory is not None or entries or value['profile'] is not None or value['fileCount'] is not None or value['totalBytes'] is not None:
            raise ValueError('invalid empty Mota tombstone')
    elif (not _integer(value['fileCount'], len(REQUIRED), MAX_FILES) or not _integer(value['totalBytes'], 0, MAX_BYTES)
          or len(entries) > value['fileCount'] or sum(entry['bytes'] for entry in entries) > value['totalBytes']):
        raise ValueError('invalid Mota transaction budget')
    if expected_profile is not None and actual['sourceSha256'] is not None:
        expected = profile(expected_profile)['files']
        if (entries != expected[:len(entries)] or value['fileCount'] != len(expected)
                or value['totalBytes'] != sum(entry['bytes'] for entry in expected)):
            raise ValueError('Mota partial receipt differs from supplied manifest')
    if value['profile'] is not None:
        baseline = profile(value['profile'])
        if (baseline['sourceSha256'] != actual['sourceSha256'] or baseline['files'] != entries
                or len(entries) != value['fileCount'] or value['completedFiles'] != len(entries)
                or sum(entry['bytes'] for entry in entries) != value['totalBytes']
                or expected_profile is not None and value['profile'] != expected_profile):
            raise ValueError('Mota receipt profile mismatch')
    elif value['state'] == 'imported':
        raise ValueError('published Mota receipt has no profile')
    return value


def validate_current(root, value):
    """Verify receipts and protected assets; return current metadata and its digest."""
    baseline = profile(value)
    root = Path(root)
    if root.parent != ROOT or not _uuid(root.name):
        raise ValueError('Mota project outside fixed root')
    fd = _open_directory(root)
    try:
        root_info = os.fstat(fd)
        receipts = {}
        facts = {}
        for name in sorted(INTERNAL):
            content, facts[name] = _read(fd, name, 524288, private=True)
            receipts[name] = content if name == '.wsl-mota-copy' else _json(content)
        profile(receipts['.wsl-profile.json'])
        identity = receipts['.wsl-identity.json']
        owner = receipts['.wsl-import.json']
        if (receipts['.wsl-mota-copy'] != MARKER or receipts['.wsl-profile.json'] != value
                or not isinstance(identity, dict) or set(identity) != {'workspaceId', 'environmentId', 'projectId'}
                or identity['environmentId'] != 'sandbox' or identity['projectId'] != root.name
                or not isinstance(owner, dict) or set(owner) != {'schemaVersion', 'binding', 'fileCount', 'totalBytes', 'directory'}
                or type(owner['schemaVersion']) is not int or owner['schemaVersion'] != 2):
            raise ValueError('Mota copy receipt mismatch')
        binding = _binding(owner['binding'])
        if (any(identity[key] != binding[key] for key in identity) or binding['sourceSha256'] != baseline['sourceSha256']
                or not isinstance(owner['directory'], dict) or set(owner['directory']) != {'device', 'inode'}
                or any(type(item) is not int for item in owner['directory'].values())
                or owner['directory'] != {'device': root_info.st_dev, 'inode': root_info.st_ino}
                or type(owner['fileCount']) is not int or owner['fileCount'] != len(baseline['files'])
                or type(owner['totalBytes']) is not int or owner['totalBytes'] != sum(entry['bytes'] for entry in baseline['files'])):
            raise ValueError('Mota owner mismatch')
        entries = []
        total = 0
        directories = 0
        directory_facts = {}

        def walk(parent, prefix):
            nonlocal total, directories
            before = _facts(os.fstat(parent))
            names = os.listdir(parent)
            if len(names) > MAX_FILES * 2 + len(INTERNAL):
                raise ValueError('Mota directory budget exceeded')
            for name in sorted(names):
                relative = prefix + name
                if not prefix and name in INTERNAL:
                    continue
                info = os.stat(name, dir_fd=parent, follow_symlinks=False)
                if stat.S_ISDIR(info.st_mode):
                    # Appended placeholder checks the same protocol policy for dirs.
                    _path(relative + '/asset.json')
                    if info.st_uid != os.getuid() or info.st_mode & 0o7022:
                        raise ValueError('unsafe Mota directory')
                    directories += 1
                    if directories > MAX_FILES * 64:
                        raise ValueError('Mota directory budget exceeded')
                    child = os.open(name, DIR_FLAGS, dir_fd=parent)
                    try:
                        if _facts(info) != _facts(os.fstat(child)):
                            raise ValueError('Mota directory replaced')
                        walk(child, relative + '/')
                    finally:
                        os.close(child)
                else:
                    _path(relative)
                    content, facts[relative] = _read(parent, name, FILE_BYTES)
                    total += len(content)
                    if total > MAX_BYTES or len(entries) >= MAX_FILES:
                        raise ValueError('Mota source exceeds budget')
                    entries.append({'path': relative, 'sha256': hashlib.sha256(content).hexdigest(), 'bytes': len(content)})
            if _facts(os.fstat(parent)) != before:
                raise ValueError('Mota directory changed during validation')
            directory_facts[prefix.rstrip('/')] = before

        walk(fd, '')
        entries = _metadata(entries)
        protected = lambda items: [entry for entry in items if entry['path'] not in WRITABLE]
        if protected(entries) != protected(baseline['files']):
            raise ValueError('Mota protected source changed')
        # Re-stat through no-follow directory handles; no receipt/source may
        # change after its bytes were hashed within this validation window.
        for relative, before in {**facts, **directory_facts}.items():
            current = os.dup(fd)
            try:
                if relative == '':
                    if _facts(os.fstat(current)) != before:
                        raise ValueError('Mota root changed')
                    continue
                parts = relative.split('/')
                for part in parts[:-1]:
                    child = os.open(part, DIR_FLAGS, dir_fd=current)
                    os.close(current)
                    current = child
                if _facts(os.stat(parts[-1], dir_fd=current, follow_symlinks=False)) != before:
                    raise ValueError('Mota source or receipt changed')
            finally:
                os.close(current)
        if _facts(os.fstat(fd)) != _facts(root_info):
            raise ValueError('Mota project changed')
        current = _open_directory(root)
        try:
            if _facts(os.fstat(current)) != _facts(root_info):
                raise ValueError('Mota project path replaced')
        finally:
            os.close(current)
        return entries, _digest(entries)
    finally:
        os.close(fd)


def _setup(support):
    if Path(support['ROOT']) != ROOT:
        raise ValueError('Mota support root mismatch')
    os.umask(0o077)
    # Validate ancestors before creating either fixed private directory.
    parent = _open_directory(ROOT.parent)
    os.close(parent)
    ROOT.mkdir(mode=0o700, exist_ok=True)
    fd = _open_directory(ROOT)
    os.close(fd)
    support['import_directory'](ROOT)
    operations = ROOT / '.wsl-import-operations'
    operations.mkdir(mode=0o700, exist_ok=True)
    support['import_directory'](operations)
    support['import_sync_directory'](ROOT)
    return operations


def _owned(path, receipt, support):
    if receipt.get('directory') is None or support['import_directory'](path) != receipt['directory'] or support['import_read_json'](path / '.wsl-import.json') != _owner(receipt):
        raise support['ImportFailure']('import_ownership_unknown')


def _cleanup(path, receipt, support):
    if not os.path.lexists(path):
        return
    _owned(path, receipt, support)
    allowed = {entry['path'] for entry in receipt['files']} | INTERNAL
    parents = {parent.as_posix() for name in allowed for parent in Path(name).parents if parent.as_posix() != '.'}
    for parent, directories, names in os.walk(path, followlinks=False):
        for name in directories + names:
            item = Path(parent) / name
            relative = item.relative_to(path).as_posix()
            info = item.lstat()
            if (info.st_uid != os.getuid() or info.st_mode & 0o7022
                    or not (stat.S_ISDIR(info.st_mode) and relative in parents
                            or stat.S_ISREG(info.st_mode) and info.st_nlink == 1 and relative in allowed)):
                raise support['ImportFailure']('import_cleanup_unknown')
    _owned(path, receipt, support)
    if not shutil.rmtree.avoids_symlink_attacks:
        raise support['ImportFailure']('import_cleanup_unknown')
    shutil.rmtree(path)
    support['import_sync_directory'](path.parent)


def _published(path, receipt, support):
    _owned(path, receipt, support)
    if receipt['profile'] is None:
        raise support['ImportFailure']('import_ownership_unknown')
    validate_current(path, receipt['profile'])


def _frame(value):
    line = PREFIX + json.dumps(value, ensure_ascii=False, separators=(',', ':'))
    if len(line.encode('utf-8')) + 1 > 8192:
        raise ValueError('Mota reply exceeds budget')
    print(line, flush=True)


def _new_receipt(binding, count=None, total=None, state='pending'):
    return {'schemaVersion': 2, 'binding': binding, 'fileCount': count, 'totalBytes': total, 'directory': None,
            'state': state, 'files': [], 'completedFiles': 0, 'profile': None}


def transfer(begin, stream, support):
    """Consume raw JSON lines after the separately decoded begin prompt."""
    if (not isinstance(begin, dict) or set(begin) != {'type', 'binding', 'seq', 'fileCount', 'totalBytes'}
            or begin['type'] != 'begin' or type(begin['seq']) is not int or begin['seq'] != 0
            or not _integer(begin['fileCount'], len(REQUIRED), MAX_FILES) or not _integer(begin['totalBytes'], 0, MAX_BYTES)):
        raise ValueError('invalid Mota begin')
    binding = _binding(begin['binding'])
    operation = binding['importOperationId']
    operations = _setup(support)
    with support['import_lock'](operations / (operation + '.lock')), support['import_lock'](operations / ('target-' + binding['projectId'] + '.lock')):
        receipt_path = operations / (operation + '.json')
        staging = ROOT / ('.wsl-import-stage-' + operation)
        destination = ROOT / binding['projectId']
        receipt = None
        if os.path.lexists(receipt_path):
            receipt = _receipt(support['import_read_json'](receipt_path), binding)
            if receipt['state'] == 'cancelled':
                raise support['ImportFailure']('import_cancelled')
            if (receipt.get('fileCount'), receipt.get('totalBytes')) != (begin['fileCount'], begin['totalBytes']):
                raise support['ImportFailure']('import_operation_conflict')
            # A repeated transfer is never a replay of uncertain side effects.
            raise support['ImportFailure']('import_cleanup_unknown')
        if os.path.lexists(destination) or os.path.lexists(staging):
            raise support['ImportFailure']('import_target_conflict')
        receipt = _new_receipt(binding, begin['fileCount'], begin['totalBytes'])
        write = lambda: support['import_write_json'](receipt_path, receipt, replace=True)
        support['import_write_json'](receipt_path, receipt)
        staging.mkdir(mode=0o700)
        receipt['directory'] = support['import_directory'](staging)
        write()
        support['import_write_json'](staging / '.wsl-import.json', _owner(receipt))
        root_fd = _open_directory(staging)
        active = None
        seq = 0
        input_bytes = len(json.dumps(begin, ensure_ascii=False, separators=(',', ':')).encode()) + 1

        def ack(kind, index=None, offset=0, digest=None):
            _frame({'type': 'ack', 'binding': binding, 'seq': seq, 'operation': kind,
                    'fileIndex': index, 'offset': offset, 'sha256': digest})

        def create_file(relative):
            fd = os.dup(root_fd)
            try:
                parts = relative.split('/')
                for name in parts[:-1]:
                    try:
                        os.mkdir(name, 0o700, dir_fd=fd)
                        os.fsync(fd)
                    except FileExistsError:
                        pass
                    child = os.open(name, DIR_FLAGS, dir_fd=fd)
                    info = os.fstat(child)
                    if info.st_uid != os.getuid() or info.st_mode & 0o7077:
                        os.close(child)
                        raise ValueError('unsafe Mota staging directory')
                    os.close(fd)
                    fd = child
                result = os.open(parts[-1], os.O_WRONLY | os.O_CREAT | os.O_EXCL | os.O_NOFOLLOW, 0o600, dir_fd=fd)
                os.fsync(fd)
                return result
            finally:
                os.close(fd)

        try:
            ack('begin')
            while True:
                seq += 1
                if seq >= MAX_FRAMES:
                    raise ValueError('Mota frame budget exceeded')
                line = stream.readline(LINE_BYTES + 1)
                if not isinstance(line, bytes) or not line or len(line) > LINE_BYTES or not line.endswith(b'\n'):
                    raise ValueError('Mota input truncated or over budget')
                input_bytes += len(line)
                if input_bytes > INPUT_BYTES:
                    raise ValueError('Mota input budget exceeded')
                frame = _json(line)
                if (not isinstance(frame, dict) or frame.get('binding') != binding or type(frame.get('seq')) is not int or frame['seq'] != seq):
                    raise ValueError('Mota frame binding or sequence mismatch')
                _binding(frame['binding'])
                kind = frame.get('type')
                index = receipt['completedFiles']
                if kind == 'file':
                    if set(frame) != {'type', 'binding', 'seq', 'fileIndex', 'path', 'bytes', 'sha256'} or active is not None or type(frame['fileIndex']) is not int or frame['fileIndex'] != index or index >= begin['fileCount']:
                        raise ValueError('unexpected Mota file')
                    item = {key: frame[key] for key in ('path', 'sha256', 'bytes')}
                    entries = _metadata([*receipt['files'], item], complete=False)
                    if entries != [*receipt['files'], item] or sum(entry['bytes'] for entry in entries) > begin['totalBytes']:
                        raise ValueError('Mota path ordering or byte budget mismatch')
                    receipt['files'] = entries
                    write()  # Record cleanup ownership before any path is created.
                    active = {'fd': create_file(item['path']), 'item': item, 'offset': 0, 'hash': hashlib.sha256()}
                    ack(kind, index, 0, item['sha256'])
                elif kind == 'chunk':
                    if set(frame) != {'type', 'binding', 'seq', 'fileIndex', 'offset', 'base64'} or active is None or type(frame['fileIndex']) is not int or frame['fileIndex'] != index or type(frame['offset']) is not int or frame['offset'] != active['offset'] or not isinstance(frame['base64'], str):
                        raise ValueError('unexpected Mota chunk')
                    encoded = frame['base64']
                    if len(encoded) > ((CHUNK_BYTES + 2) // 3) * 4:
                        raise ValueError('Mota chunk exceeds budget')
                    data = base64.b64decode(encoded, validate=True)
                    if not 0 < len(data) <= CHUNK_BYTES or base64.b64encode(data).decode('ascii') != encoded or active['offset'] + len(data) > active['item']['bytes']:
                        raise ValueError('invalid Mota chunk encoding or length')
                    view = memoryview(data)
                    while view:
                        written = os.write(active['fd'], view)
                        if written <= 0:
                            raise OSError('short Mota source write')
                        view = view[written:]
                    os.fsync(active['fd'])
                    active['hash'].update(data)
                    active['offset'] += len(data)
                    ack(kind, index, active['offset'])
                elif kind == 'file-end':
                    if (set(frame) != {'type', 'binding', 'seq', 'fileIndex', 'bytes', 'sha256'} or active is None
                            or type(frame['fileIndex']) is not int or frame['fileIndex'] != index or type(frame['bytes']) is not int
                            or frame['bytes'] != active['item']['bytes'] or frame['sha256'] != active['item']['sha256']
                            or active['offset'] != frame['bytes'] or active['hash'].hexdigest() != frame['sha256']):
                        raise ValueError('Mota file hash or length mismatch')
                    os.fsync(active['fd'])
                    os.close(active['fd'])
                    active = None
                    receipt['completedFiles'] += 1
                    write()
                    ack(kind, index, frame['bytes'], frame['sha256'])
                elif kind == 'finish':
                    if (set(frame) != {'type', 'binding', 'seq', 'fileCount', 'totalBytes', 'sourceSha256'} or active is not None
                            or type(frame['fileCount']) is not int or frame['fileCount'] != begin['fileCount'] or index != begin['fileCount']
                            or type(frame['totalBytes']) is not int or frame['totalBytes'] != begin['totalBytes']
                            or sum(entry['bytes'] for entry in receipt['files']) != begin['totalBytes']
                            or frame['sourceSha256'] != binding['sourceSha256'] or _digest(receipt['files']) != binding['sourceSha256']):
                        raise ValueError('Mota finish manifest mismatch')
                    receipt['profile'] = {'projectKind': 'mota-web', 'profileVersion': 1,
                                          'source': {'sourceSha256': binding['sourceSha256'], 'files': receipt['files']}}
                    write()
                    identity = {key: binding[key] for key in ('workspaceId', 'environmentId', 'projectId')}
                    support['import_write_json'](staging / '.wsl-identity.json', identity)
                    support['import_write_json'](staging / '.wsl-profile.json', receipt['profile'])
                    marker_fd = os.open('.wsl-mota-copy', os.O_WRONLY | os.O_CREAT | os.O_EXCL | os.O_NOFOLLOW, 0o600, dir_fd=root_fd)
                    try:
                        if os.write(marker_fd, MARKER) != len(MARKER):
                            raise OSError('short Mota marker write')
                        os.fsync(marker_fd)
                    finally:
                        os.close(marker_fd)
                    os.fsync(root_fd)
                    _owned(staging, receipt, support)
                    # Validate before publication without weakening fixed-root checks.
                    _validate_staging(staging, receipt, support)
                    support['import_publish'](staging, destination)
                    receipt['state'] = 'imported'
                    write()
                    _frame({'type': 'receipt', 'binding': binding, 'seq': seq, 'outcome': 'imported',
                            'fileCount': index, 'totalBytes': begin['totalBytes'], 'sourceSha256': binding['sourceSha256']})
                    if stream.read(1) != b'':
                        raise ValueError('unexpected Mota input after finish')
                    return
                else:
                    raise ValueError('unknown Mota frame')
        finally:
            if active is not None:
                os.close(active['fd'])
            os.close(root_fd)


def _validate_staging(staging, receipt, support):
    """Staging is not a public project; verify each announced byte and all names."""
    _owned(staging, receipt, support)
    expected = {entry['path']: entry for entry in receipt['files']}
    found = set()
    fd = _open_directory(staging)
    try:
        def walk(parent, prefix):
            for name in os.listdir(parent):
                relative = prefix + name
                info = os.stat(name, dir_fd=parent, follow_symlinks=False)
                if stat.S_ISDIR(info.st_mode):
                    if not any(path.startswith(relative + '/') for path in expected) or info.st_mode & 0o7077 or info.st_uid != os.getuid():
                        raise ValueError('unowned Mota staging directory')
                    child = os.open(name, DIR_FLAGS, dir_fd=parent)
                    try:
                        walk(child, relative + '/')
                        os.fsync(child)
                    finally:
                        os.close(child)
                else:
                    if relative not in expected and relative not in INTERNAL:
                        raise ValueError('unowned Mota staging file')
                    content, _ = _read(parent, name, FILE_BYTES if relative in expected else 524288, private=True)
                    found.add(relative)
                    if relative in expected and (len(content) != expected[relative]['bytes'] or hashlib.sha256(content).hexdigest() != expected[relative]['sha256']):
                        raise ValueError('Mota staging source changed')
        walk(fd, '')
        if found != set(expected) | INTERNAL:
            raise ValueError('incomplete Mota staging tree')
        identity = {key: receipt['binding'][key] for key in ('workspaceId', 'environmentId', 'projectId')}
        stored_profile = support['import_read_json'](staging / '.wsl-profile.json')
        profile(stored_profile)
        if (stored_profile != receipt['profile']
                or support['import_read_json'](staging / '.wsl-identity.json') != identity or _read(fd, '.wsl-mota-copy', 64, private=True)[0] != MARKER):
            raise ValueError('Mota staging receipt changed')
        _owned(staging, receipt, support)
        os.fsync(fd)
    finally:
        os.close(fd)


def reconcile(request, support):
    operation = request.get('importOperationId')
    result = {'outcome': 'failed', 'retryable': False, 'errorCode': 'import_invalid_request', 'importOperationId': operation}
    try:
        supplied = request.get('profile')
        baseline = profile(supplied) if supplied is not None else None
        if request.get('operation') != 'reconcile-import' or request.get('profileKind', 'mota-web') != 'mota-web' or type(request.get('cancel', True)) is not bool:
            raise ValueError('invalid Mota reconciliation request')
        binding = _binding({'workspaceId': request['workspaceId'], 'environmentId': 'sandbox', 'projectId': request['projectId'],
                            'importOperationId': operation, 'sourceSha256': baseline['sourceSha256'] if baseline else None}, missing_hash=True)
        operations = _setup(support)
        with support['import_lock'](operations / (operation + '.lock')), support['import_lock'](operations / ('target-' + binding['projectId'] + '.lock')):
            receipt_path = operations / (operation + '.json')
            staging = ROOT / ('.wsl-import-stage-' + operation)
            destination = ROOT / binding['projectId']
            cancel = request.get('cancel', True)
            if os.path.lexists(receipt_path):
                receipt = _receipt(support['import_read_json'](receipt_path), binding, supplied)
            else:
                # Preserve cancellation even when a foreign destination exists.
                receipt = _new_receipt({**binding, 'sourceSha256': None}, state='cancelled' if cancel else 'failed')
                support['import_write_json'](receipt_path, receipt)
            if receipt['schemaVersion'] == 1:
                if os.path.lexists(staging) or os.path.lexists(destination):
                    raise support['ImportFailure']('import_ownership_unknown')
                return {**result, 'outcome': 'cancelled', 'errorCode': None}
            if cancel and receipt['state'] != 'imported':
                receipt['state'] = 'cancelled'
                support['import_write_json'](receipt_path, receipt, replace=True)
            if os.path.lexists(destination):
                _published(destination, receipt, support)
                receipt['state'] = 'imported'
                support['import_write_json'](receipt_path, receipt, replace=True)
                return {**result, 'outcome': 'imported', 'errorCode': None, 'profile': receipt['profile'],
                        'sourceSha256': receipt['binding']['sourceSha256']}
            if receipt['state'] == 'imported':
                raise support['ImportFailure']('import_ownership_unknown')
            _cleanup(staging, receipt, support)
            receipt['directory'] = None
            receipt['state'] = 'cancelled' if cancel or receipt['state'] == 'cancelled' else 'failed'
            support['import_write_json'](receipt_path, receipt, replace=True)
            if receipt['state'] == 'cancelled':
                return {**result, 'outcome': 'cancelled', 'errorCode': None}
            return {**result, 'errorCode': 'import_failed', 'retryable': False}
    except support['ImportFailure'] as error:
        result['errorCode'] = error.code
    except (OSError, ValueError, TypeError, KeyError, AttributeError):
        result['errorCode'] = 'import_cleanup_unknown'
    return result
