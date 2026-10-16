"""Narrow edu app receipt; recovery asks its original helper to perform owned cleanup."""
import json
import os
from pathlib import Path
import stat
import time
import uuid

BASE = Path('/home/agent/workspace/.wsl-owned-edu')


def process_identity(pid):
    try:
        fields = Path('/proc/%d/stat' % pid).read_text().rsplit(')', 1)[1].split()
        return {'pid': pid, 'startTicks': fields[19]}, int(fields[1]), int(fields[3])
    except FileNotFoundError:
        return None


def same_process(identity):
    current = process_identity(identity['pid'])
    return current is not None and current[0] == identity


def receipt_path(instance):
    if not isinstance(instance, str) or str(uuid.UUID(instance)) != instance:
        raise ValueError('invalid owned instance')
    BASE.mkdir(mode=0o700, parents=True, exist_ok=True)
    info=BASE.lstat()
    if BASE.is_symlink() or not BASE.is_dir() or info.st_uid != os.getuid() or info.st_mode & 0o022:
        raise ValueError('invalid owned receipt directory')
    return BASE / (instance + '.json')


def atomic(path, value):
    if path.exists() or path.is_symlink():
        info = path.lstat()
        if not stat.S_ISREG(info.st_mode) or info.st_nlink != 1 or info.st_uid != os.getuid() or info.st_mode & 0o077:
            raise ValueError('invalid owned receipt file')
    temporary = path.with_name(path.name + '.' + str(uuid.uuid4()) + '.tmp')
    fd = os.open(temporary, os.O_WRONLY | os.O_CREAT | os.O_EXCL | os.O_NOFOLLOW, 0o600)
    try:
        with os.fdopen(fd, 'w') as target:
            json.dump(value, target, separators=(',', ':'))
            target.write('\n'); target.flush(); os.fsync(target.fileno())
        os.replace(temporary, path)
        directory = os.open(path.parent, os.O_RDONLY | os.O_DIRECTORY | os.O_NOFOLLOW)
        try: os.fsync(directory)
        finally: os.close(directory)
    finally:
        if temporary.exists(): temporary.unlink()


def begin(payload, leader):
    if not isinstance(payload, dict) or set(payload) != {'identity', 'sourceSha256'}:
        raise ValueError('invalid owned receipt payload')
    identity = payload['identity']
    path = receipt_path(identity['appInstanceId'])
    if path.exists():
        raise ValueError('owned instance was already used')
    helper = process_identity(os.getpid())[0]
    child = process_identity(leader)[0]
    value = {'schemaVersion': 1, **payload, 'bootId': Path('/proc/sys/kernel/random/boot_id').read_text().strip(),
             'helper': helper, 'leader': child, 'members': [child], 'cleanupConfirmed': False}
    atomic(path, value)
    return path, value


def update(owner, members):
    path, value = owner
    known = {(item['pid'], item['startTicks']) for item in value['members']}
    changed=False
    for pid in members:
        current = process_identity(pid)
        if current and (pid, current[0]['startTicks']) not in known:
            value['members'].append(current[0]);changed=True
    if len(value['members']) > 4096:
        raise ValueError('owned process budget exceeded')
    if changed: atomic(path, value)


def revoked(owner):
    path, value = owner
    revoke = path.with_suffix('.revoke')
    if not revoke.exists(): return False
    fd = os.open(revoke, os.O_RDONLY | os.O_NOFOLLOW | os.O_NONBLOCK)
    with os.fdopen(fd) as source:
        info = os.fstat(source.fileno())
        if not stat.S_ISREG(info.st_mode) or info.st_nlink != 1 or info.st_size > 200:
            raise ValueError('invalid owned revoke file')
        return json.load(source) == {'appInstanceId': value['identity']['appInstanceId']}


def complete(owner):
    path, value = owner
    if any(same_process(item) for item in value['members']):
        raise ValueError('owned processes remain')
    value['cleanupConfirmed'] = True
    atomic(path, value)


def unique_pairs(pairs):
    value={}
    for key,item in pairs:
        if key in value:raise ValueError('duplicate owned receipt key')
        value[key]=item
    return value


def read(instance):
    path = receipt_path(instance)
    fd = os.open(path, os.O_RDONLY | os.O_NOFOLLOW | os.O_NONBLOCK)
    with os.fdopen(fd) as source:
        info = os.fstat(source.fileno())
        if not stat.S_ISREG(info.st_mode) or info.st_nlink != 1 or info.st_size > 1048576 or info.st_mode & 0o077 or info.st_uid != os.getuid():
            raise ValueError('invalid owned receipt file')
        value = json.load(source,object_pairs_hook=unique_pairs)
    fields = {'schemaVersion','identity','sourceSha256','bootId','helper','leader','members','cleanupConfirmed'}
    if not isinstance(value, dict) or set(value) not in (fields, fields | {'bootReplacement'}) or value['schemaVersion'] != 1:
        raise ValueError('invalid owned receipt')
    if not isinstance(value['bootId'], str) or str(uuid.UUID(value['bootId'])) != value['bootId']:
        raise ValueError('invalid owned receipt boot')
    if 'bootReplacement' in value:
        proof = value['bootReplacement']
        if (not isinstance(proof, dict) or set(proof) != {'previousBootId','currentBootId'}
                or proof['previousBootId'] != value['bootId'] or not value['cleanupConfirmed']
                or not isinstance(proof['currentBootId'], str)
                or str(uuid.UUID(proof['currentBootId'])) != proof['currentBootId']
                or proof['currentBootId'] == value['bootId']):
            raise ValueError('invalid owned receipt boot replacement')
    if not isinstance(value['members'],list) or len(value['members'])>4096:
        raise ValueError('invalid owned process history')
    for item in [value['helper'],value['leader'],*value['members']]:
        if not isinstance(item, dict) or set(item) != {'pid','startTicks'} or type(item['pid']) is not int or item['pid'] <= 0 or not isinstance(item['startTicks'], str) or not item['startTicks'].isdigit() or str(int(item['startTicks'])) != item['startTicks']:
            raise ValueError('invalid owned process identity')
    if not isinstance(value['members'],list) or type(value['cleanupConfirmed']) is not bool or len(value['members']) > 4096:
        raise ValueError('invalid owned process history')
    if value['leader'] not in value['members'] or value['helper']==value['leader'] or len({(p['pid'],p['startTicks']) for p in value['members']})!=len(value['members']):
        raise ValueError('inconsistent owned process history')
    return path, value


class RecoveryError(ValueError):
    def __init__(self, code):
        super().__init__(code)
        self.code=code


def boot_identity():
    return Path('/proc/sys/kernel/random/boot_id').read_text().strip()


def reconcile(expected):
    try:
        path, value = read(expected['identity']['appInstanceId'])
    except FileNotFoundError as error:
        raise RecoveryError('verification_recovery_receipt_missing') from error
    except (OSError,ValueError,KeyError,TypeError) as error:
        raise RecoveryError('verification_recovery_receipt_invalid') from error
    if value['identity'] != expected['identity'] or value['sourceSha256'] != expected['sourceSha256']:
        raise RecoveryError('verification_recovery_receipt_mismatch')
    current_boot = boot_identity()
    if value['bootId'] != current_boot:
        if not isinstance(current_boot, str) or str(uuid.UUID(current_boot)) != current_boot or boot_identity() != current_boot:
            raise RecoveryError('verification_recovery_boot_changed')
        # The receipt's PIDs belong to the previous kernel boot. Never look them
        # up or signal a same-number process in this boot. Keep that old history.
        value = {**value, 'cleanupConfirmed': True,
                 'bootReplacement': {'previousBootId': value['bootId'], 'currentBootId': current_boot}}
        try:
            # Repeat the barrier even for an existing proof: an earlier replace
            # could have succeeded before directory fsync reported an I/O error.
            atomic(path, value)
        except OSError as error:
            raise RecoveryError('verification_recovery_receipt_unconfirmed') from error
        if boot_identity() != current_boot:
            raise RecoveryError('verification_recovery_boot_changed')
        return {'cleanupConfirmed': True, 'identity': value['identity'], 'sourceSha256': value['sourceSha256'],
                'bootId': value['bootId'], 'leader': value['leader'], 'members': value['members'],
                'bootReplacement': value['bootReplacement']}
    if 'bootReplacement' in value:
        raise RecoveryError('verification_recovery_boot_changed')
    if not value['cleanupConfirmed']:
        if not same_process(value['helper']):
            raise RecoveryError('verification_recovery_helper_lost')
        atomic(path.with_suffix('.revoke'), {'appInstanceId': expected['identity']['appInstanceId']})
        deadline = time.monotonic() + 8
        while time.monotonic() < deadline:
            time.sleep(.05)
            _, value = read(expected['identity']['appInstanceId'])
            if value['cleanupConfirmed']: break
    if not value['cleanupConfirmed'] or any(same_process(item) for item in value['members']):
        raise RecoveryError('verification_recovery_processes_remain')
    deadline=time.monotonic()+1.5
    while same_process(value['helper']) and time.monotonic()<deadline:
        time.sleep(.02)
    if same_process(value['helper']):
        raise RecoveryError('verification_recovery_processes_remain')
    return {'cleanupConfirmed': True, 'identity': value['identity'], 'sourceSha256': value['sourceSha256'],
            'bootId': value['bootId'], 'leader': value['leader'], 'members': value['members']}
