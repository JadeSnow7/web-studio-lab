"""Synthetic-file tests for the trusted Mota importer; source files are never executed."""
import base64
from contextlib import redirect_stdout
import copy
import hashlib
import importlib.util
import io
import json
import os
from pathlib import Path
import tempfile
import unittest
from unittest.mock import patch


def load_helper(name, filename):
    spec = importlib.util.spec_from_file_location(name, Path(__file__).with_name(filename))
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    return module


app_helper = load_helper('mota_test_app_helper', 'app-helper.py')
mota = load_helper('mota_test_helper', 'mota-helper.py')

PREFIX = 'WSL_MOTA_TRANSFER:'
WORKSPACE = 'synthetic-mota-space'
PROJECT = '11111111-1111-4111-8111-111111111111'
OPERATION = '22222222-2222-4222-8222-222222222222'


def digest(data):
    return hashlib.sha256(data).hexdigest()


def json_bytes(value):
    return json.dumps(value, ensure_ascii=False, separators=(',', ':')).encode('utf-8')


def source_profile(files):
    entries = [
        {'path': name, 'sha256': digest(files[name]), 'bytes': len(files[name])}
        for name in sorted(files, key=lambda name: name.encode('utf-16-be'))
    ]
    return {
        'projectKind': 'mota-web', 'profileVersion': 1,
        'source': {'sourceSha256': digest(json_bytes(entries)), 'files': entries},
    }


def source_files():
    return {
        'index.html': b'<!doctype html><title>Synthetic game</title>\n',
        'editor.html': b'<!doctype html><title>Synthetic editor</title>\n',
        'main.js': b'var main = { floors: {} };\n',
        'libs/core.js': b'// Synthetic core; never executed.\n',
        'project/data.js': b'var data_synthetic = {};\n',
        'project/floors/MT1.js': b'main.floors.MT1 = {"floorId":"MT1","map":[[0]]};\n',
        'project/floors/MT2.js': b'main.floors.MT2 = {"floorId":"MT2","map":[[0]]};\n',
        '_server/editor.js': b'// Synthetic editor; never executed.\n',
        '_server/editor_file.js': b'// Synthetic editor file adapter; never executed.\n',
    }


def transfer_frames(files, operation=OPERATION):
    profile = source_profile(files)
    binding = {
        'workspaceId': WORKSPACE, 'environmentId': 'sandbox', 'projectId': PROJECT,
        'importOperationId': operation, 'sourceSha256': profile['source']['sourceSha256'],
    }
    frames = []

    def append(kind, **fields):
        frames.append({'type': kind, 'binding': copy.deepcopy(binding), 'seq': len(frames), **fields})

    total = sum(len(content) for content in files.values())
    append('begin', fileCount=len(files), totalBytes=total)
    for index, entry in enumerate(profile['source']['files']):
        append('file', fileIndex=index, **entry)
        content = files[entry['path']]
        for offset in range(0, len(content), 32 * 1024):
            append('chunk', fileIndex=index, offset=offset,
                   base64=base64.b64encode(content[offset:offset + 32 * 1024]).decode('ascii'))
        append('file-end', fileIndex=index, bytes=entry['bytes'], sha256=entry['sha256'])
    append('finish', fileCount=len(files), totalBytes=total, sourceSha256=binding['sourceSha256'])
    return frames


class ObservedInput(io.BytesIO):
    """Record an actual EOF read and expose deterministic frame-boundary hooks."""
    def __init__(self, frames, before_read=None):
        super().__init__(b''.join(json_bytes(frame) + b'\n' for frame in frames))
        self.before_read = before_read
        self.eof_observed = False

    def readline(self, size=-1):
        if self.before_read:
            self.before_read(self)
        result = super().readline(size)
        self.eof_observed |= result == b''
        return result

    def read(self, size=-1):
        if self.before_read:
            self.before_read(self)
        result = super().read(size)
        self.eof_observed |= result == b''
        return result


class MotaHelperTests(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory(prefix='wsl-mota-helper-test-')
        self.addCleanup(self.temp.cleanup)
        self.root = Path(self.temp.name).resolve() / 'managed'
        self.root.mkdir(mode=0o700)
        self.project = self.root / PROJECT
        self.files = source_files()
        self.profile = source_profile(self.files)
        self.support = vars(app_helper).copy()
        self.support['ROOT'] = self.root
        root_patch = patch.object(mota, 'ROOT', self.root)
        root_patch.start()
        self.addCleanup(root_patch.stop)
        self.stdout = io.StringIO()
        original_umask = os.umask(0o077)
        self.addCleanup(os.umask, original_umask)
        self.process_guards = []
        for module, name in ((app_helper.subprocess, 'run'), (app_helper.subprocess, 'Popen'), (os, 'execve')):
            guard = patch.object(module, name, side_effect=AssertionError('source/process execution forbidden'))
            self.process_guards.append(guard.start())
            self.addCleanup(guard.stop)

    def tearDown(self):
        for guard in self.process_guards:
            guard.assert_not_called()

    def write(self, name, content, root=None):
        target = (root or self.project) / name
        target.parent.mkdir(mode=0o700, parents=True, exist_ok=True)
        target.write_bytes(content)
        target.chmod(0o600)
        return target

    def materialize(self, files=None):
        self.transfer(transfer_frames(self.files if files is None else files))
        return self.project

    def reconcile(self, **changes):
        request = {
            'operation': 'reconcile-import', 'profileKind': 'mota-web', 'workspaceId': WORKSPACE,
            'projectId': PROJECT, 'importOperationId': OPERATION, 'cancel': True,
        }
        return mota.reconcile({**request, **changes}, self.support)

    def receipt_path(self, operation=OPERATION):
        return self.root / '.wsl-import-operations' / (operation + '.json')

    def stage_path(self, operation=OPERATION):
        return self.root / ('.wsl-import-stage-' + operation)

    def replies(self):
        lines = self.stdout.getvalue().splitlines()
        self.assertTrue(all(line.startswith(PREFIX) for line in lines))
        return [json.loads(line[len(PREFIX):]) for line in lines]

    def transfer(self, frames=None, stream=None):
        frames = transfer_frames(self.files) if frames is None else frames
        stream = ObservedInput(frames[1:]) if stream is None else stream
        with redirect_stdout(self.stdout):
            mota.transfer(frames[0], stream, self.support)
        return stream

    def assert_transfer_rejected(self, frames, stream=None):
        self.stdout = io.StringIO()
        with self.assertRaises((ValueError, OSError, app_helper.ImportFailure)):
            self.transfer(frames, stream)
        self.assertFalse(self.project.exists())
        self.assertFalse(any(reply['type'] == 'receipt' for reply in self.replies()))

    def test_transfer_publishes_exact_bytes_and_acknowledges_each_frame(self):
        self.files['libs/binary.dat'] = bytes(range(256)) * 129
        self.files['_docs/空文件.txt'] = b''
        frames = transfer_frames(self.files)
        stream = self.transfer(frames)
        replies = self.replies()
        self.assertTrue(stream.eof_observed)
        self.assertEqual(len(replies), len(frames))
        for frame, reply in zip(frames[:-1], replies[:-1]):
            with self.subTest(seq=frame['seq']):
                expected_hash = frame['sha256'] if frame['type'] in ('file', 'file-end') else None
                offset = (frame['offset'] + len(base64.b64decode(frame['base64']))
                          if frame['type'] == 'chunk' else frame['bytes'] if frame['type'] == 'file-end' else 0)
                self.assertEqual(reply, {
                    'type': 'ack', 'binding': frames[0]['binding'], 'seq': frame['seq'],
                    'operation': frame['type'], 'fileIndex': frame.get('fileIndex'),
                    'offset': offset, 'sha256': expected_hash,
                })
        self.assertEqual(replies[-1], {
            'type': 'receipt', 'binding': frames[0]['binding'], 'seq': frames[-1]['seq'],
            'outcome': 'imported', 'fileCount': len(self.files),
            'totalBytes': sum(map(len, self.files.values())),
            'sourceSha256': source_profile(self.files)['source']['sourceSha256'],
        })
        for name, content in self.files.items():
            self.assertEqual((self.project / name).read_bytes(), content)
        self.assertEqual(json.loads((self.project / '.wsl-profile.json').read_bytes()), source_profile(self.files))
        self.assertEqual(json.loads((self.project / '.wsl-identity.json').read_bytes()), {
            'workspaceId': WORKSPACE, 'environmentId': 'sandbox', 'projectId': PROJECT,
        })
        self.assertEqual((self.project / '.wsl-mota-copy').read_bytes(), b'mota-managed-copy-v1\n')

    def test_transfer_rejects_sequence_binding_index_offset_and_hash_mismatches(self):
        cases = (
            ('sequence', 1, 'seq', 2),
            ('file-index', 1, 'fileIndex', 1),
            ('chunk-offset', 2, 'offset', 1),
            ('chunk-base64', 2, 'base64', '%%%='),
            ('file-end-bytes', 3, 'bytes', 0),
            ('file-end-hash', 3, 'sha256', '0' * 64),
            ('finish-hash', -1, 'sourceSha256', '0' * 64),
        )
        for index, (name, frame_index, field, value) in enumerate(cases):
            with self.subTest(name=name):
                frames = transfer_frames(self.files, operation=f'{index + 10:08x}-2222-4222-8222-222222222222')
                frames[frame_index][field] = value
                self.assert_transfer_rejected(frames)
        for index, field in enumerate(('workspaceId', 'environmentId', 'projectId', 'importOperationId', 'sourceSha256')):
            with self.subTest(binding_field=field):
                frames = transfer_frames(self.files, operation=f'{index + 30:08x}-2222-4222-8222-222222222222')
                frames[1]['binding'][field] = 'mismatched-binding'
                self.assert_transfer_rejected(frames)

    def test_transfer_rejects_wrong_chunk_content_even_with_matching_declared_hashes(self):
        frames = transfer_frames(self.files)
        original = base64.b64decode(frames[2]['base64'])
        frames[2]['base64'] = base64.b64encode(b'X' + original[1:]).decode('ascii')
        self.assert_transfer_rejected(frames)
        self.assertFalse(any(reply.get('operation') == 'file-end' for reply in self.replies()))

    def test_transfer_rejects_unsafe_and_duplicate_file_paths(self):
        for index, name in enumerate(('../outside.js', 'project/../outside.js',
                                      'project/credentials.json', '_server/server.js',
                                      'project/file.py', 'project/.env', 'project//bad.js')):
            with self.subTest(name=name):
                frames = transfer_frames(self.files, operation=f'{index + 50:08x}-2222-4222-8222-222222222222')
                frames[1]['path'] = name
                self.assert_transfer_rejected(frames)
                self.assertFalse((self.root / 'outside.js').exists())
        frames = transfer_frames(self.files)
        files = [frame for frame in frames if frame['type'] == 'file']
        files[1]['path'] = files[0]['path']
        self.assert_transfer_rejected(frames)

    def test_finish_receipt_is_emitted_before_waiting_for_input_eof(self):
        class InputStillOpen(Exception):
            pass

        frames = transfer_frames(self.files)

        def before_read(stream):
            if stream.tell() == len(stream.getvalue()):
                self.assertEqual(self.replies()[-1]['type'], 'receipt')
                self.assertEqual((self.project / 'index.html').read_bytes(), self.files['index.html'])
                raise InputStillOpen()

        stream = ObservedInput(frames[1:], before_read)
        with self.assertRaises(InputStillOpen):
            self.transfer(frames, stream)
        self.assertFalse(stream.eof_observed)
        self.assertEqual(sum(reply['type'] == 'receipt' for reply in self.replies()), 1)

    def test_existing_destination_is_preserved_without_replacement(self):
        self.project.mkdir(mode=0o700)
        sentinel = self.write('owned-by-someone-else.txt', b'untouched destination\n')
        identity = (self.project.stat().st_dev, self.project.stat().st_ino)
        with self.assertRaises((ValueError, OSError, app_helper.ImportFailure)):
            self.transfer()
        self.assertEqual((self.project.stat().st_dev, self.project.stat().st_ino), identity)
        self.assertEqual(sentinel.read_bytes(), b'untouched destination\n')
        self.assertEqual({item.name for item in self.project.iterdir()}, {sentinel.name})
        self.assertFalse(any(reply['type'] == 'receipt' for reply in self.replies()))

    def test_atomic_publication_does_not_replace_a_destination_created_after_begin(self):
        publish = self.support['import_publish']

        def competing_destination(staging, destination):
            destination.mkdir(mode=0o700)
            self.write('foreign.txt', b'competing publisher\n', root=destination)
            publish(staging, destination)

        self.support['import_publish'] = competing_destination
        with self.assertRaisesRegex(app_helper.ImportFailure, 'import_target_conflict'):
            self.transfer()
        self.assertEqual((self.project / 'foreign.txt').read_bytes(), b'competing publisher\n')
        self.assertEqual({item.name for item in self.project.iterdir()}, {'foreign.txt'})
        self.assertTrue(self.stage_path().is_dir())
        self.assertFalse(any(reply['type'] == 'receipt' for reply in self.replies()))

    def test_partial_transfer_cancel_cleans_only_owned_stage_and_blocks_late_import(self):
        frames = transfer_frames(self.files)
        self.assert_transfer_rejected(frames, ObservedInput(frames[1:3]))
        self.assertTrue(self.stage_path().is_dir())
        receipt = json.loads(self.receipt_path().read_bytes())
        self.assertEqual(receipt['state'], 'pending')
        self.assertEqual(receipt['completedFiles'], 0)
        self.assertEqual(receipt['files'], [{key: frames[1][key] for key in ('path', 'sha256', 'bytes')}])
        expected = {'outcome': 'cancelled', 'retryable': False, 'errorCode': None, 'importOperationId': OPERATION}
        self.assertEqual(self.reconcile(), expected)
        self.assertFalse(self.stage_path().exists())
        self.assertFalse(self.project.exists())
        self.assertEqual(self.reconcile(), expected)
        saved = self.receipt_path().read_bytes()
        with self.assertRaisesRegex(app_helper.ImportFailure, 'import_cancelled'):
            self.transfer(frames)
        self.assertEqual(self.receipt_path().read_bytes(), saved)
        self.assertFalse(self.project.exists())

    def test_staging_directory_symlink_is_never_followed_or_removed_as_owned(self):
        outside = self.root / 'outside'
        outside.mkdir(mode=0o700)
        sentinel = self.write('sentinel.txt', b'outside stays unchanged\n', root=outside)
        frames = transfer_frames(self.files)

        def replace_directory(stream):
            if stream.tell() == 0:
                (self.stage_path() / '_server').symlink_to(outside, target_is_directory=True)

        self.assert_transfer_rejected(frames, ObservedInput(frames[1:], replace_directory))
        self.assertEqual({item.name for item in outside.iterdir()}, {'sentinel.txt'})
        self.assertEqual(sentinel.read_bytes(), b'outside stays unchanged\n')
        result = self.reconcile()
        self.assertEqual(result['outcome'], 'failed')
        self.assertEqual(result['errorCode'], 'import_cleanup_unknown')
        self.assertTrue((self.stage_path() / '_server').is_symlink())
        self.assertEqual(sentinel.read_bytes(), b'outside stays unchanged\n')

    def test_cancel_retains_stage_when_an_unannounced_file_was_added(self):
        frames = transfer_frames(self.files)
        self.assert_transfer_rejected(frames, ObservedInput(frames[1:3]))
        extra = self.write('project/unannounced.js', b'unowned file\n', root=self.stage_path())
        result = self.reconcile()
        self.assertEqual(result['outcome'], 'failed')
        self.assertEqual(result['errorCode'], 'import_cleanup_unknown')
        self.assertEqual(extra.read_bytes(), b'unowned file\n')
        self.assertEqual(json.loads(self.receipt_path().read_bytes())['state'], 'cancelled')
        self.assertFalse(self.project.exists())

    def test_legacy_v1_cancellation_receipt_blocks_delayed_mota_dispatch(self):
        legacy = {
            'schemaVersion': 1, 'importOperationId': OPERATION, 'workspaceId': WORKSPACE,
            'projectId': PROJECT, 'profile': None, 'directory': None, 'state': 'cancelled',
        }
        self.write('.wsl-import-operations/' + OPERATION + '.json', json_bytes(legacy), root=self.root)
        saved = self.receipt_path().read_bytes()
        self.assertEqual(self.reconcile()['outcome'], 'cancelled')
        with self.assertRaisesRegex(app_helper.ImportFailure, 'import_cancelled'):
            self.transfer()
        self.assertEqual(self.receipt_path().read_bytes(), saved)
        self.assertFalse(self.stage_path().exists())
        self.assertFalse(self.project.exists())

    def test_cancellation_before_dispatch_persists_a_v2_tombstone(self):
        self.assertEqual(self.reconcile()['outcome'], 'cancelled')
        receipt = json.loads(self.receipt_path().read_bytes())
        self.assertEqual(receipt['schemaVersion'], 2)
        self.assertIsNone(receipt['binding']['sourceSha256'])
        self.assertIsNone(receipt['directory'])
        with self.assertRaisesRegex(app_helper.ImportFailure, 'import_cancelled'):
            self.transfer()
        self.assertFalse(self.project.exists())

    def test_extra_input_after_finish_is_rejected_without_rolling_back_publication(self):
        frames = transfer_frames(self.files)
        stream = io.BytesIO(b''.join(json_bytes(frame) + b'\n' for frame in frames[1:]) + b'x')
        with self.assertRaisesRegex(ValueError, 'after finish'):
            self.transfer(frames, stream)
        self.assertEqual(self.replies()[-1]['type'], 'receipt')
        self.assertEqual((self.project / 'index.html').read_bytes(), self.files['index.html'])
        result = self.reconcile(profile=self.profile)
        self.assertEqual(result['outcome'], 'imported')
        self.assertEqual(result['profile'], self.profile)
        self.assertEqual(result['sourceSha256'], self.profile['source']['sourceSha256'])

    def test_profile_checks_full_manifest_identity(self):
        self.assertEqual(mota.profile(self.profile), self.profile['source'])
        bad_profiles = []
        for version in (True, 1.0, 2):
            value = copy.deepcopy(self.profile)
            value['profileVersion'] = version
            bad_profiles.append(value)
        value = copy.deepcopy(self.profile)
        value['source']['sourceSha256'] = '0' * 64
        bad_profiles.append(value)
        value = copy.deepcopy(self.profile)
        value['unexpected'] = True
        bad_profiles.append(value)
        value = copy.deepcopy(self.profile)
        value['source']['files'][0]['bytes'] = True
        bad_profiles.append(value)
        value = copy.deepcopy(self.profile)
        value['source']['files'].append(copy.deepcopy(value['source']['files'][0]))
        bad_profiles.append(value)
        missing = self.files.copy()
        del missing['libs/core.js']
        bad_profiles.append(source_profile(missing))
        for value in bad_profiles:
            with self.subTest(profile=value):
                with self.assertRaises((ValueError, app_helper.ImportFailure)):
                    mota.profile(value)

    def test_profile_rejects_noncanonical_and_executable_source_paths(self):
        for name in ('../outside.js', 'project/../outside.js', 'project//empty.js',
                     'project\\windows.js', '/project/absolute.js', 'project/%2e%2e/file.js',
                     'project/credentials.json', '_server/server.js', '_server/safe-mota-server.cjs',
                     'project/.env', 'project/task.py', 'project/task.sh', 'project/private.key',
                     'project/node_modules/file.js', 'project/name\x00.js'):
            with self.subTest(name=name):
                files = {**self.files, name: b'not executable source'}
                with self.assertRaises((ValueError, app_helper.ImportFailure)):
                    mota.profile(source_profile(files))

    def test_restart_accepts_only_mt1_and_optional_config_edits(self):
        self.materialize()
        metadata, baseline = mota.validate_current(self.project, self.profile)
        self.assertEqual(metadata, self.profile['source']['files'])
        self.assertEqual(baseline, self.profile['source']['sourceSha256'])
        edited = dict(self.files)
        edited['project/floors/MT1.js'] = b'main.floors.MT1 = {"floorId":"MT1","map":[[1]]};\n'
        edited['_server/config.json'] = b'{"lastFloorId":"MT1"}\n'
        self.write('project/floors/MT1.js', edited['project/floors/MT1.js'])
        self.write('_server/config.json', edited['_server/config.json'])
        metadata, current = mota.validate_current(self.project, self.profile)
        self.assertEqual(metadata, source_profile(edited)['source']['files'])
        self.assertEqual(current, source_profile(edited)['source']['sourceSha256'])
        self.assertNotEqual(current, baseline)

    def test_restart_rejects_other_changes_additions_and_required_deletions(self):
        self.materialize()
        for name in ('index.html', 'main.js', 'libs/core.js', 'project/data.js',
                     'project/floors/MT2.js', '_server/editor_file.js'):
            with self.subTest(changed=name):
                self.write(name, b'protected source changed\n')
                try:
                    with self.assertRaises((ValueError, app_helper.ImportFailure)):
                        mota.validate_current(self.project, self.profile)
                finally:
                    self.write(name, self.files[name])
        extra = self.write('project/floors/MT3.js', b'new floor outside fixed edit scope\n')
        try:
            with self.assertRaises((ValueError, app_helper.ImportFailure)):
                mota.validate_current(self.project, self.profile)
        finally:
            extra.unlink()
        for name in ('project/floors/MT1.js', 'project/floors/MT2.js'):
            with self.subTest(deleted=name):
                (self.project / name).unlink()
                try:
                    with self.assertRaises((ValueError, app_helper.ImportFailure)):
                        mota.validate_current(self.project, self.profile)
                finally:
                    self.write(name, self.files[name])

    def test_restart_does_not_follow_file_links_or_accept_special_files(self):
        self.materialize()
        outside = self.root / 'outside.txt'
        outside.write_bytes(b'outside sentinel\n')
        target = self.project / 'project/floors/MT1.js'
        target.unlink()
        for kind, create in (
            ('symlink', lambda: target.symlink_to(outside)),
            ('hardlink', lambda: os.link(outside, target)),
            ('fifo', lambda: os.mkfifo(target)),
        ):
            with self.subTest(kind=kind):
                create()
                try:
                    with self.assertRaises((ValueError, OSError, app_helper.ImportFailure)):
                        mota.validate_current(self.project, self.profile)
                    self.assertEqual(outside.read_bytes(), b'outside sentinel\n')
                finally:
                    target.unlink()
        self.write('project/floors/MT1.js', self.files['project/floors/MT1.js'])
        directory = self.project / 'project/floors'
        saved = self.root / 'saved-floors'
        directory.rename(saved)
        directory.symlink_to(saved, target_is_directory=True)
        with self.assertRaises((ValueError, OSError, app_helper.ImportFailure)):
            mota.validate_current(self.project, self.profile)
        self.assertEqual((saved / 'MT1.js').read_bytes(), self.files['project/floors/MT1.js'])

    def test_restart_rejects_changed_profile_identity_marker_and_inode_receipts(self):
        self.materialize()
        owner = json.loads((self.project / '.wsl-import.json').read_bytes())
        owner['directory']['inode'] += 1
        wrong_identity = {'workspaceId': 'different-space', 'environmentId': 'sandbox', 'projectId': PROJECT}
        wrong_profile = copy.deepcopy(self.profile)
        wrong_profile['source']['sourceSha256'] = '0' * 64
        for name, content in (
            ('.wsl-import.json', json_bytes(owner)),
            ('.wsl-identity.json', json_bytes(wrong_identity)),
            ('.wsl-profile.json', json_bytes(wrong_profile)),
            ('.wsl-mota-copy', b'not a managed copy\n'),
        ):
            with self.subTest(receipt=name):
                target = self.project / name
                saved = target.read_bytes()
                self.write(name, content)
                try:
                    with self.assertRaises(ValueError):
                        mota.validate_current(self.project, self.profile)
                finally:
                    self.write(name, saved)
        self.assertEqual(mota.validate_current(self.project, self.profile)[1], self.profile['source']['sourceSha256'])

    def test_restart_detects_receipt_changed_after_it_was_read(self):
        self.materialize()
        read = mota._read
        changed = False

        def read_then_mutate(fd, name, limit, private=False):
            nonlocal changed
            result = read(fd, name, limit, private)
            if name == 'index.html' and not changed:
                changed = True
                receipt = self.project / '.wsl-profile.json'
                self.write('.wsl-profile.json', receipt.read_bytes() + b' ')
            return result

        with patch.object(mota, '_read', read_then_mutate):
            with self.assertRaisesRegex(ValueError, 'changed'):
                mota.validate_current(self.project, self.profile)
        self.assertTrue(changed)

    def test_reconcile_preserves_partial_stage_when_transaction_binding_was_changed(self):
        frames = transfer_frames(self.files)
        self.assert_transfer_rejected(frames, ObservedInput(frames[1:3]))
        receipt = json.loads(self.receipt_path().read_bytes())
        receipt['binding']['workspaceId'] = 'foreign-space'
        self.receipt_path().write_bytes(json_bytes(receipt))
        saved = self.receipt_path().read_bytes()
        result = self.reconcile()
        self.assertEqual(result['outcome'], 'failed')
        self.assertEqual(result['errorCode'], 'import_cleanup_unknown')
        self.assertEqual(self.receipt_path().read_bytes(), saved)
        self.assertTrue(self.stage_path().is_dir())
        self.assertFalse(self.project.exists())


if __name__ == '__main__':
    unittest.main()
