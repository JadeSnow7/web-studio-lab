import base64
import importlib.util
import json
import os
from pathlib import Path
import tempfile
import unittest
from unittest.mock import patch

spec = importlib.util.spec_from_file_location('app_helper', Path(__file__).with_name('app-helper.py'))
helper = importlib.util.module_from_spec(spec)
spec.loader.exec_module(helper)


class SourceSnapshotTests(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory(prefix='wsl-source-')
        self.root = Path(self.temp.name).resolve()
        self.project = self.root / 'project-test'
        self.project.mkdir()
        self.identity = {'workspaceId': 'space-test', 'environmentId': 'sandbox', 'projectId': 'project-test'}
        self.write('.wsl-identity.json', json.dumps(self.identity).encode())
        self.frames = []
        self.root_patch = patch.object(helper, 'ROOT', self.root)
        self.output_patch = patch.object(helper, 'source_frame', self.frames.append)
        self.root_patch.start()
        self.output_patch.start()
        self.addCleanup(self.root_patch.stop)
        self.addCleanup(self.output_patch.stop)
        self.addCleanup(self.temp.cleanup)

    def write(self, name, data=b'content\n'):
        target = self.project / name
        target.parent.mkdir(parents=True, exist_ok=True)
        target.write_bytes(data)
        return target

    def snapshot(self):
        self.frames.clear()
        with patch.object(helper.subprocess, 'run', side_effect=AssertionError('must not execute project or Git')):
            helper.run({'operation': 'source-snapshot', 'workspaceId': 'space-test', 'projectId': 'project-test'})
        files = {}
        current = None
        for frame in self.frames:
            if frame['type'] == 'file':
                current = frame['path']
                files[current] = {'mode': frame['mode'], 'content': b''}
            if frame['type'] == 'chunk':
                files[current]['content'] += base64.b64decode(frame['base64'], validate=True)
        self.assertEqual(self.frames[-1]['type'], 'complete')
        self.assertEqual(self.frames[-1]['totalBytes'], sum(len(file['content']) for file in files.values()))
        return files

    def test_empty(self):
        self.assertEqual(self.snapshot(), {})

    def test_fixed_exclusions_at_every_depth_and_hostile_gitignore(self):
        for name in ('node_modules', 'dist', 'data', '.data', '.git', '.vite', '.wsl-private'):
            self.write(name + '/hidden')
            self.write('src/nested/' + name + '/hidden')
        self.write('.git/HEAD', b'ref: refs/heads/original\n')
        self.write('.git/index', b'original index bytes')
        before = [(self.project / '.git' / name).read_bytes() for name in ('HEAD', 'index')]
        self.write('.gitignore', b'*\n')
        self.write('src/new.ts', b'new source\n')
        self.write('src/ignored.ts', b'cannot hide me\n')
        files = self.snapshot()
        self.assertEqual(set(files), {'.gitignore', 'src/new.ts', 'src/ignored.ts'})
        self.assertEqual(before, [(self.project / '.git' / name).read_bytes() for name in ('HEAD', 'index')])

    def test_fixed_credential_exclusions_never_read_synthetic_secrets(self):
        names = ('.env', '.env.local', '.env.example', '.npmrc', '.netrc', '.pypirc',
                 '.git-credentials', '.ssh/id_rsa', '.aws/credentials', '.azure/accessTokens.json',
                 '.gnupg/private-keys-v1.d/key', '.codex/auth.json', '.docker/config.json',
                 'id_rsa', 'id_dsa', 'id_ecdsa', 'id_ed25519', 'id_ecdsa_sk', 'id_ed25519_sk')
        for name in names:
            self.write(name, b'SYNTHETIC_NOT_A_REAL_SECRET')
            self.write('nested/' + name.upper(), b'SYNTHETIC_NOT_A_REAL_SECRET')
        self.write('.gitignore', b'!**/*\n')
        self.write('src/auth.ts', b'export const authorized = false;\n')
        self.write('example.env.ts', b'example source\n')
        files = self.snapshot()
        self.assertEqual(set(files), {'.gitignore', 'src/auth.ts', 'example.env.ts'})
        self.assertNotIn('SYNTHETIC_NOT_A_REAL_SECRET', str(files))

    def test_modified_deleted_new_binary_and_executable(self):
        old = self.write('deleted.ts')
        self.write('modified.ts', b'before\n')
        self.snapshot()
        old.unlink()
        self.write('modified.ts', b'after\n')
        self.write('binary.dat', bytes(range(256)))
        executable = self.write('new.sh', b'printf never-executed\n')
        executable.chmod(0o755)
        result = self.snapshot()
        self.assertNotIn('deleted.ts', result)
        self.assertEqual(result['modified.ts']['content'], b'after\n')
        self.assertEqual(result['binary.dat']['content'], bytes(range(256)))
        self.assertEqual(result['new.sh']['mode'], '100755')

    def test_chunk_boundary_and_exact_byte_budget(self):
        self.write('large', b'a' * (helper.SOURCE_CHUNK_BYTES + 1))
        with patch.object(helper, 'SOURCE_MAX_BYTES', helper.SOURCE_CHUNK_BYTES + 1):
            self.assertEqual(len(self.snapshot()['large']['content']), helper.SOURCE_CHUNK_BYTES + 1)
        with patch.object(helper, 'SOURCE_MAX_BYTES', helper.SOURCE_CHUNK_BYTES):
            with self.assertRaisesRegex(ValueError, 'budget'):
                self.snapshot()
            self.assertFalse(any(frame['type'] == 'complete' for frame in self.frames))

    def test_file_count_budget_rejects_whole_snapshot(self):
        self.write('one')
        self.write('two')
        with patch.object(helper, 'SOURCE_MAX_FILES', 1):
            with self.assertRaisesRegex(ValueError, 'budget'):
                self.snapshot()
        self.assertFalse(any(frame['type'] == 'complete' for frame in self.frames))

    def test_links_and_special_files(self):
        target = self.write('normal')
        for name, create in (
            ('link', lambda file: file.symlink_to(target)),
            ('outside', lambda file: file.symlink_to(self.root / 'missing')),
            ('fifo', os.mkfifo),
            ('hardlink', lambda file: os.link(target, file)),
        ):
            with self.subTest(name=name):
                file = self.project / name
                create(file)
                try:
                    with self.assertRaises((ValueError, OSError)):
                        self.snapshot()
                finally:
                    file.unlink()
        # This macOS test environment clears setuid/setgid on chmod. Sticky is
        # a real retained special-mode bit, so exercise rejection without
        # mistaking a stripped fixture bit for an accepted privileged mode.
        target.chmod(0o1755)
        self.assertEqual(target.stat().st_mode & 0o7000, 0o1000, 'fixture filesystem did not retain the special bit')
        with self.assertRaisesRegex(ValueError, 'special modes'):
            self.snapshot()

    def test_identity_and_root_symlinks(self):
        identity = self.project / '.wsl-identity.json'
        saved = self.root / 'identity'
        identity.rename(saved)
        identity.symlink_to(saved)
        with self.assertRaises(OSError):
            self.snapshot()
        identity.unlink()
        saved.rename(identity)
        helper.run({'operation': 'source-snapshot', 'workspaceId': 'space-test', 'projectId': 'project-test'})
        self.project.rename(self.root / 'real-project')
        self.project.symlink_to(self.root / 'real-project')
        with self.assertRaises(OSError):
            self.snapshot()

    def test_invalid_paths_and_identity(self):
        bad = self.write('bad\\name')
        with self.assertRaisesRegex(ValueError, 'path'):
            self.snapshot()
        bad.unlink()
        self.write('.wsl-identity.json', b'{}')
        with self.assertRaisesRegex(ValueError, 'identity'):
            self.snapshot()
        with self.assertRaisesRegex(ValueError, 'identity'):
            helper.run({'operation': 'source-snapshot', 'workspaceId': 'space-test', 'projectId': '../escape'})

    def test_snapshot_fails_when_file_changes_after_read(self):
        target = self.write('source.ts', b'before\n')
        def mutate(frame):
            self.frames.append(frame)
            if frame['type'] == 'end-file':
                target.write_bytes(b'changed after reading\n')
        with patch.object(helper, 'source_frame', mutate):
            with self.assertRaisesRegex(ValueError, 'changed'):
                self.snapshot()
        self.assertFalse(any(frame['type'] == 'complete' for frame in self.frames))

    def test_utf8_names_binary_bytes_and_invalid_utf8_path(self):
        self.write('源码.ts', '中文\n'.encode('utf-8'))
        self.write('binary.bin', b'\x00\xff\xfe')
        snapshot = self.snapshot()
        self.assertEqual(snapshot['源码.ts']['content'], '中文\n'.encode('utf-8'))
        self.assertEqual(snapshot['binary.bin']['content'], b'\x00\xff\xfe')
        with self.assertRaises(UnicodeEncodeError):
            helper.source_path('invalid\udcff')
        for name in ['e\u0301.ts', 'bad\u0085.ts', 'bad\u202e.ts', 'bad\u2028.ts']:
            with self.subTest(name=name):
                with self.assertRaises(ValueError):
                    helper.source_path(name)

    def test_directory_depth_and_budget(self):
        self.write('one/two/file')
        with patch.object(helper, 'SOURCE_MAX_DIRECTORIES', 1):
            with self.assertRaisesRegex(ValueError, 'budget'):
                self.snapshot()
        with self.assertRaisesRegex(ValueError, 'path'):
            helper.source_path('/'.join(['deep'] * 65))

    def test_missing_root_is_not_created(self):
        missing = self.root / 'absent'
        with patch.object(helper, 'ROOT', missing):
            with self.assertRaises(FileNotFoundError):
                self.snapshot()
        self.assertFalse(missing.exists())

    def test_rejects_profiles_and_unknown_request_fields_before_reading(self):
        for extra in ({'profile': {'projectKind': 'standard-app', 'profileVersion': 1}}, {'path': '/tmp/other'}):
            with self.subTest(extra=extra):
                with self.assertRaisesRegex(ValueError, 'unsupported source request'):
                    helper.run({'operation': 'source-snapshot', 'workspaceId': 'space-test', 'projectId': 'project-test', **extra})
                self.assertEqual(self.frames, [])

    def test_rejects_imported_profile_receipts_without_opening_them(self):
        receipt = self.write('.wsl-profile.json', b'unsupported imported profile')
        original_open = os.open
        def guarded_open(name, *args, **kwargs):
            self.assertNotEqual(os.fspath(name), '.wsl-profile.json', 'unsupported receipt must not be read')
            return original_open(name, *args, **kwargs)
        before = receipt.read_bytes()
        with patch.object(helper.os, 'open', guarded_open):
            with self.assertRaisesRegex(ValueError, 'unsupported source profile'):
                self.snapshot()
        self.assertEqual(receipt.read_bytes(), before)
        receipt.unlink()
        receipt.symlink_to(self.root / 'not-present')
        with patch.object(helper.os, 'open', guarded_open):
            with self.assertRaisesRegex(ValueError, 'unsupported source profile'):
                self.snapshot()
        self.assertTrue(receipt.is_symlink())
        self.assertEqual(self.frames, [])

    def test_identity_replacement_after_read_rejects_whole_snapshot(self):
        self.write('source.ts')
        def mutate(frame):
            self.frames.append(frame)
            if frame['type'] == 'end-file':
                self.write('.wsl-identity.json', b'{}')
        with patch.object(helper, 'source_frame', mutate):
            with self.assertRaisesRegex(ValueError, 'changed'):
                self.snapshot()
        self.assertFalse(any(frame['type'] == 'complete' for frame in self.frames))

    def test_growth_during_read_rejects_whole_snapshot(self):
        target = self.write('source.ts', b'a' * helper.SOURCE_CHUNK_BYTES)
        def grow(frame):
            self.frames.append(frame)
            if frame['type'] == 'chunk' and target.stat().st_size == helper.SOURCE_CHUNK_BYTES:
                with target.open('ab') as handle:
                    handle.write(b'growth')
        with patch.object(helper, 'source_frame', grow):
            with self.assertRaisesRegex(ValueError, 'changed'):
                self.snapshot()
        self.assertFalse(any(frame['type'] == 'complete' for frame in self.frames))

    def test_root_and_identity_unchanged_after_readonly_capture(self):
        source = self.write('source.ts', b'unchanged source')
        identity = self.project / '.wsl-identity.json'
        before = [(item.read_bytes(), item.stat().st_mtime_ns, item.stat().st_mode) for item in (source, identity)]
        self.snapshot()
        self.assertEqual(before, [(item.read_bytes(), item.stat().st_mtime_ns, item.stat().st_mode) for item in (source, identity)])


if __name__ == '__main__':
    unittest.main(verbosity=2)
