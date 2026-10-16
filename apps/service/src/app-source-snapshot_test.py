import base64
import hashlib
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
        self.profile = {'projectKind': 'standard-app', 'profileVersion': 1}
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
            helper.run({'operation': 'source-snapshot', 'workspaceId': 'space-test', 'projectId': 'project-test', 'profile': self.profile})
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
        target.chmod(0o4755)
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

    def make_edu(self):
        sources = {
            'admin/package.json': b'{"name":"synthetic-edu"}',
            'admin/package-lock.json': b'{"lockfileVersion":3}',
            'admin/src/App.tsx': b'export const value = "synthetic";\n',
            'server/app.py': b'# synthetic source, never executed\n',
            'server/requirements.lock': b'# synthetic lock\n',
            'server/requirements-test.lock': b'# synthetic test lock\n',
            'server/wsl_runtime.py': b'# synthetic runtime source\n',
        }
        entries = []
        for name in sorted(sources, key=lambda value: value.encode('utf-16-be')):
            content = sources[name]
            self.write(name, content)
            entries.append({'path': name, 'sha256': hashlib.sha256(content).hexdigest(), 'bytes': len(content)})
        self.profile = {
            'projectKind': 'edu-web', 'profileVersion': 1,
            'source': {'repository': {'commit': 'a' * 40, 'dirty': False}, 'files': entries,
                       'sourceSha256': hashlib.sha256(json.dumps(entries, ensure_ascii=False, separators=(',', ':')).encode()).hexdigest()},
        }
        self.write('.wsl-profile.json', json.dumps(self.profile).encode())
        return sources

    def test_standard_legacy_missing_and_matching_profile_receipt(self):
        self.write('source.ts')
        self.assertEqual(set(self.snapshot()), {'source.ts'})
        self.assertFalse((self.project / '.wsl-profile.json').exists())
        self.write('.wsl-profile.json', json.dumps(self.profile).encode())
        self.assertEqual(set(self.snapshot()), {'source.ts'})

    def test_request_profile_rejects_bool_float_version_and_unknown_shape(self):
        for profile in (None, {'projectKind': 'standard-app', 'profileVersion': True},
                        {'projectKind': 'standard-app', 'profileVersion': 1.0},
                        {'projectKind': 'standard-app', 'profileVersion': 2},
                        {'projectKind': 'standard-app', 'profileVersion': 1, 'source': {}},
                        {'projectKind': 'unknown-app', 'profileVersion': 1}):
            with self.subTest(profile=profile):
                self.profile = profile
                with self.assertRaisesRegex(ValueError, 'profile'):
                    self.snapshot()
                self.assertEqual(self.frames, [])

    def test_profile_receipt_rejects_malformed_bool_and_unknown_fields(self):
        for content in (b'{', b'null', b'{"projectKind":"standard-app","profileVersion":true}',
                        b'{"projectKind":"standard-app","profileVersion":1.0}',
                        b'{"projectKind":"standard-app","profileVersion":1,"extra":1}'):
            with self.subTest(content=content):
                self.write('.wsl-profile.json', content)
                with self.assertRaises(ValueError):
                    self.snapshot()
                self.assertEqual(self.frames, [])

    def test_profile_receipt_rejects_links_special_files_and_oversize(self):
        target = self.root / 'synthetic-profile'
        target.write_text(json.dumps(self.profile))
        receipt = self.project / '.wsl-profile.json'
        cases = (
            ('symlink', lambda: receipt.symlink_to(target)),
            ('dangling-symlink', lambda: receipt.symlink_to(self.root / 'absent-profile')),
            ('hardlink', lambda: os.link(target, receipt)),
            ('fifo', lambda: os.mkfifo(receipt)),
            ('directory', lambda: receipt.mkdir()),
            ('oversize', lambda: receipt.write_bytes(b' ' * (helper.EDU_LIMIT + 1))),
        )
        for name, create in cases:
            with self.subTest(name=name):
                create()
                try:
                    with self.assertRaises((ValueError, OSError)):
                        self.snapshot()
                    self.assertEqual(self.frames, [])
                finally:
                    if receipt.is_dir() and not receipt.is_symlink():
                        receipt.rmdir()
                    else:
                        receipt.unlink()

    def test_edu_receipt_required_and_cannot_downgrade_to_standard(self):
        self.make_edu()
        receipt = self.project / '.wsl-profile.json'
        receipt.unlink()
        with self.assertRaisesRegex(ValueError, 'profile.*missing'):
            self.snapshot()
        self.assertFalse(receipt.exists())
        self.write('.wsl-profile.json', json.dumps(helper.STANDARD_PROFILE).encode())
        with self.assertRaisesRegex(ValueError, 'profile identity mismatch'):
            self.snapshot()
        self.write('.wsl-profile.json', json.dumps(self.profile).encode())
        self.profile = dict(helper.STANDARD_PROFILE)
        with self.assertRaisesRegex(ValueError, 'profile identity mismatch'):
            self.snapshot()
        self.assertEqual(self.frames, [])

    def test_edu_profile_requires_the_same_complete_provenance(self):
        self.make_edu()
        self.profile['source']['repository']['commit'] = 'b' * 40
        with self.assertRaisesRegex(ValueError, 'profile identity mismatch'):
            self.snapshot()
        self.assertEqual(self.frames, [])

    def test_edu_excludes_runtime_credentials_and_non_sources_before_open(self):
        expected = set(self.make_edu())
        for name in ('.venv', 'venv', '__pycache__', '.pytest_cache', '.ruff_cache', '.mypy_cache',
                     '.runtime', 'coverage', 'node_modules', 'dist', '.data', '.git', '.wsl-home', '.ssh', '.aws'):
            self.write('admin/nested/' + name + '/synthetic-private.py', b'SYNTHETIC_NOT_A_REAL_SECRET')
        (self.project / '.venv').symlink_to(self.root / 'unavailable-interpreter')
        for name in ('.ENVRC', '.env.local', '.npmrc', '.netrc', '.pypirc', '.git-credentials', 'id_rsa'):
            self.write('admin/nested/' + name, b'SYNTHETIC_NOT_A_REAL_SECRET')
        for name in ('private/hidden.ts', 'admin/generated.tsbuildinfo', 'admin/source.sqlite', 'server/hidden.json', 'docs/other.md'):
            self.write(name, b'SYNTHETIC_NOT_A_REAL_SECRET')
        self.write('README.md', b'synthetic documentation')
        self.write('docs/development/webstudiolab.md', b'synthetic integration notes')
        expected.update({'README.md', 'docs/development/webstudiolab.md'})
        original_open = os.open
        forbidden = {'.venv', '.ENVRC', '.env.local', '.npmrc', '.netrc', '.pypirc', '.git-credentials', 'id_rsa',
                     'synthetic-private.py', 'hidden.ts', 'generated.tsbuildinfo', 'source.sqlite', 'hidden.json', 'other.md'}
        def guarded_open(path, *args, **kwargs):
            self.assertNotIn(os.fspath(path), forbidden, 'excluded input must never be opened')
            return original_open(path, *args, **kwargs)
        with patch.object(helper.os, 'open', guarded_open):
            files = self.snapshot()
        self.assertEqual(set(files), expected)
        self.assertNotIn('SYNTHETIC_NOT_A_REAL_SECRET', str(files))

    def test_edu_snapshot_reports_protected_source_changes_without_authorizing_them(self):
        self.make_edu()
        receipt = (self.project / '.wsl-profile.json').read_bytes()
        self.write('server/app.py', b'# changed protected backend\n')
        self.write('admin/package-lock.json', b'{"changed":true}')
        files = self.snapshot()
        self.assertEqual(files['server/app.py']['content'], b'# changed protected backend\n')
        self.assertEqual(files['admin/package-lock.json']['content'], b'{"changed":true}')
        self.assertEqual((self.project / '.wsl-profile.json').read_bytes(), receipt)
        with self.assertRaisesRegex(ValueError, 'protected'):
            helper.edu_validate_current(self.project, self.profile)

    def test_edu_selected_source_links_still_fail(self):
        self.make_edu()
        (self.project / 'admin/src/linked.ts').symlink_to(self.project / 'server/app.py')
        with self.assertRaisesRegex(ValueError, 'links'):
            self.snapshot()
        self.assertFalse(any(frame['type'] == 'complete' for frame in self.frames))

    def test_edu_snapshot_keeps_edu_byte_and_file_budgets(self):
        sources = self.make_edu()
        self.write('admin/src/App.tsx', b'a' * helper.EDU_LIMIT)
        with self.assertRaisesRegex(ValueError, 'budget'):
            self.snapshot()
        self.assertFalse(any(frame['type'] == 'complete' for frame in self.frames))
        self.write('admin/src/App.tsx', sources['admin/src/App.tsx'])
        for index in range(257 - len(sources)):
            self.write('admin/src/extra-%03d.ts' % index, b'')
        with self.assertRaisesRegex(ValueError, 'budget'):
            self.snapshot()
        self.assertFalse(any(frame['type'] == 'complete' for frame in self.frames))

    def test_profile_receipt_creation_or_change_during_snapshot_fails(self):
        self.write('source.ts')
        receipt = self.project / '.wsl-profile.json'
        for exists in (False, True):
            with self.subTest(existing_receipt=exists):
                if exists:
                    self.write('.wsl-profile.json', json.dumps(self.profile).encode())
                def mutate(frame):
                    self.frames.append(frame)
                    if frame['type'] == 'end-file':
                        receipt.write_bytes(b'{}')
                with patch.object(helper, 'source_frame', mutate):
                    with self.assertRaisesRegex(ValueError, 'changed'):
                        self.snapshot()
                self.assertFalse(any(frame['type'] == 'complete' for frame in self.frames))
                receipt.unlink()


if __name__ == '__main__':
    unittest.main()
