import test from 'node:test';
import assert from 'node:assert/strict';
import { Buffer } from 'node:buffer';
import { execFile, spawnSync } from 'node:child_process';
import { promisify } from 'node:util';
import { createHash } from 'node:crypto';
import fsModule, { mkdtemp, mkdir, writeFile, readFile, rm, lstat, symlink, link, readdir, access } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import process from 'node:process';
import { fileURLToPath } from 'node:url';
import {
  MAX_FILES,
  MAX_SOURCE_BYTES,
  MAX_BASE64_CHARS,
  MAX_PATH_CHARS,
  isEduSourcePath,
  createSnapshot,
  verifySnapshot,
  mergeSnapshots,
} from './edu-source.mjs';

const run = promisify(execFile);
const hash = (data) => createHash('sha256').update(data).digest('hex');
const REPOSITORY = { commit: 'a'.repeat(40), dirty: false };
const SCRIPT = path.join(path.dirname(fileURLToPath(import.meta.url)), 'edu-source.mjs');

const BASE_TREE = {
  'README.md': 'readme\n',
  'SPEC.md': 'spec\n',
  'API.md': 'api\n',
  'DESIGN.md': 'design\n',
  'UX-CONTRACT.md': 'ux\n',
  'AGENTS.md': 'agents\n',
  'admin/package.json': '{"name":"edu-admin"}\n',
  'admin/package-lock.json': '{"lockfileVersion":3}\n',
  'admin/src/app.ts': 'export const a = 1;\n',
  'admin/src/styles.css': 'body {}\n',
  'server/app.py': 'def create_app():\n    pass\n',
  'server/wsl_runtime.py': 'def main():\n    pass\n',
  'server/requirements.lock': 'fastapi==0.143.0\n',
  'server/requirements-test.lock': '-r requirements.lock\n',
  'server/requirements.txt': 'fastapi==0.143.0\n',
};

const IGNORED_TREE = {
  'android/app/src/main.kt': 'class A {}',
  'deploy/run.sh': '#!/bin/sh',
  'remote-agent/agent.js': 'x',
  'remote-codex/codex.js': 'x',
  'remote-executor/run.js': 'x',
  'evidence/run/results.json': '{}',
  '.env': 'SECRET=1',
  '.env.local': 'SECRET=2',
  '.wsl-cache/blob': 'x',
  'server/data/edu.db': 'sqlite',
  'server/.data/edu.db': 'sqlite',
  'admin/dist/index.js': 'built',
  'admin/node_modules/pkg/index.js': 'x',
  'admin/coverage/report.json': '{}',
  'server/__pycache__/app.cpython-312.pyc': 'x',
  'server/audio.wav': 'RIFF',
  'admin/src/notes.txt': 'not-whitelisted-suffix',
};

async function writeTree(directory, overrides = {}, { ignored = true } = {}) {
  const files = { ...BASE_TREE };
  for (const [relative, data] of Object.entries(overrides)) {
    if (data === null) delete files[relative];
    else files[relative] = data;
  }
  const all = ignored ? { ...files, ...IGNORED_TREE } : files;
  for (const [relative, data] of Object.entries(all)) {
    const absolute = path.join(directory, relative);
    await mkdir(path.dirname(absolute), { recursive: true });
    await writeFile(absolute, data);
  }
  return files;
}

async function fixture(t) {
  const directory = await mkdtemp(path.join(os.tmpdir(), 'edu-source-'));
  t.after(() => rm(directory, { recursive: true, force: true }));
  return directory;
}

async function bundle(t, overrides = {}, options) {
  const directory = await fixture(t);
  const root = path.join(directory, 'checkout');
  const files = await writeTree(root, overrides, options);
  const output = path.join(directory, 'bundle');
  const { manifest } = await createSnapshot(root, output, REPOSITORY);
  return { directory, root, output, manifest, files };
}

async function tampered(t, mutate, recompute = true) {
  const { output } = await bundle(t);
  const manifestPath = path.join(output, 'manifest.json');
  const manifest = JSON.parse(await readFile(manifestPath, 'utf8'));
  mutate(manifest);
  if (recompute) manifest.sourceSha256 = hash(JSON.stringify(manifest.files));
  await writeFile(manifestPath, JSON.stringify(manifest, null, 2));
  return output;
}

test('isEduSourcePath admits only the settled whitelist', () => {
  assert.equal(MAX_FILES, 256);
  assert.equal(MAX_SOURCE_BYTES, 524288);
  assert.equal(MAX_BASE64_CHARS, 4000000);
  assert.equal(MAX_PATH_CHARS, 500);
  for (const good of [
    'README.md',
    'SPEC.md',
    'API.md',
    'DESIGN.md',
    'UX-CONTRACT.md',
    'AGENTS.md',
    'docs/development/webstudiolab.md',
    'admin/package.json',
    'admin/src/deep/x.tsx',
    'admin/a.mjs',
    'admin/x.css',
    'admin/x.html',
    'server/app.py',
    'server/a/b.txt',
    'server/x.lock',
    'server/x.md',
  ]) {
    assert.equal(isEduSourcePath(good), true, good);
  }
  for (const bad of [
    '',
    'CONTRIBUTING.md',
    'docs/x.md',
    'docs/development/other.md',
    'admin/x.xyz',
    'server/x.js',
    'server/app.pyc',
    'admin/../x.md',
    'a/../README.md',
    './README.md',
    '/README.md',
    'admin//x.ts',
    'admin/x.ts/',
    'README.md ',
    'admin\\x.ts',
    'admin/.env/x.ts',
    'admin/.env',
    'x/.wsl-y/z.ts',
    'server/data/edu.db',
    'server/.data/x',
    'admin/dist/x.js',
    'admin/node_modules/x/index.js',
    'server/__pycache__/a.pyc',
    'admin/coverage/x.json',
    '.git/config',
    'android/x.kt',
    'evidence/x.md',
    'admin/.venv/x.ts',
    'admin/x.ts\0',
    'server/a/.mypy_cache/b.py',
  ]) {
    assert.equal(isEduSourcePath(bad), false, bad);
  }
  assert.equal(isEduSourcePath(null), false);
  assert.equal(isEduSourcePath('admin/.envrc'), false);
  const exact = 'admin/' + 'a/'.repeat(245) + 'f.ts';
  const over = 'admin/' + 'a/'.repeat(245) + 'ff.ts';
  assert.equal(exact.length, MAX_PATH_CHARS);
  assert.equal(over.length, MAX_PATH_CHARS + 1);
  assert.equal(isEduSourcePath(exact), true);
  assert.equal(isEduSourcePath(over), false);
  assert.equal(isEduSourcePath('admin/src/x\x01.ts'), false);
  assert.equal(isEduSourcePath('admin/src/x\x7f.ts'), false);
});

test('snapshot produces ordered manifest, byte-faithful copies and verifies', async (t) => {
  const { root, output, manifest } = await bundle(t, { 'docs/development/webstudiolab.md': 'entry doc\n' });
  assert.equal(manifest.schemaVersion, 1);
  assert.equal(manifest.projectKind, 'edu-web');
  assert.equal(manifest.profileVersion, 1);
  assert.equal(manifest.sourceKind, 'manual-source-snapshot');
  assert.deepEqual(manifest.repository, REPOSITORY);
  const paths = manifest.files.map((f) => f.path);
  assert.deepEqual(paths, [...paths].sort());
  assert.equal(new Set(paths).size, paths.length);
  assert.ok(paths.includes('docs/development/webstudiolab.md'));
  assert.equal(manifest.sourceSha256, hash(JSON.stringify(manifest.files)));
  for (const entry of manifest.files) {
    const expected = await readFile(path.join(root, entry.path));
    const actual = await readFile(path.join(output, 'source', entry.path));
    assert.deepEqual(actual, expected, entry.path);
    assert.equal(entry.bytes, expected.length);
    assert.equal(entry.sha256, hash(expected));
  }
  const verified = await verifySnapshot(output);
  assert.equal(verified.manifest.sourceSha256, manifest.sourceSha256);
  assert.equal(verified.entries.size, manifest.files.length);
  for (const [relative, data] of verified.entries) assert.equal(hash(data), manifest.files.find((f) => f.path === relative).sha256);
  assert.equal((await lstat(output)).mode & 0o777, 0o700);
  assert.equal((await lstat(path.join(output, 'manifest.json'))).mode & 0o777, 0o600);
});

test('snapshot never follows excluded directories or names', async (t) => {
  const directory = await fixture(t);
  const root = path.join(directory, 'checkout');
  const outside = path.join(directory, 'outside-secret');
  await mkdir(outside, { recursive: true });
  await writeFile(path.join(outside, 'secret.txt'), 'must-not-be-read');
  await writeTree(root);
  await rm(path.join(root, 'admin/node_modules'), { recursive: true, force: true });
  await rm(path.join(root, 'server/data'), { recursive: true, force: true });
  await symlink(outside, path.join(root, 'admin/node_modules'), 'dir');
  await symlink(outside, path.join(root, 'server/data'), 'dir');
  const output = path.join(directory, 'bundle');
  const { manifest } = await createSnapshot(root, output, REPOSITORY);
  const paths = manifest.files.map((f) => f.path);
  for (const ignored of Object.keys(IGNORED_TREE)) assert.ok(!paths.includes(ignored), ignored);
  assert.ok(!paths.some((p) => p.includes('secret')));
  const verified = await verifySnapshot(output);
  assert.equal(verified.entries.size, manifest.files.length);
});

test('selected symlink file rejects before output exists', async (t) => {
  const directory = await fixture(t);
  const root = path.join(directory, 'checkout');
  await writeTree(root);
  const target = path.join(directory, 'target.ts');
  await writeFile(target, 'x');
  await symlink(target, path.join(root, 'admin/src/link.ts'));
  const output = path.join(directory, 'bundle');
  await assert.rejects(createSnapshot(root, output, REPOSITORY), /symlink/i);
  await assert.rejects(access(output), /ENOENT/);
});

test('selected directory symlink rejects before output exists', async (t) => {
  const directory = await fixture(t);
  const root = path.join(directory, 'checkout');
  await writeTree(root);
  const target = path.join(directory, 'elsewhere');
  await mkdir(target);
  await writeFile(path.join(target, 'x.ts'), 'x');
  await symlink(target, path.join(root, 'admin/nested'), 'dir');
  const output = path.join(directory, 'bundle');
  await assert.rejects(createSnapshot(root, output, REPOSITORY), /symlink/i);
  await assert.rejects(access(output), /ENOENT/);
});

test('symlinked source root rejects', async (t) => {
  const directory = await fixture(t);
  const real = path.join(directory, 'real');
  await writeTree(real);
  const aliased = path.join(directory, 'alias');
  await symlink(real, aliased, 'dir');
  await assert.rejects(createSnapshot(aliased, path.join(directory, 'bundle'), REPOSITORY), /symlink/i);
  await assert.rejects(access(path.join(directory, 'bundle')), /ENOENT/);
});

test('hardlinked selected file rejects', async (t) => {
  const directory = await fixture(t);
  const root = path.join(directory, 'checkout');
  await writeTree(root);
  await link(path.join(root, 'admin/src/app.ts'), path.join(directory, 'clone.ts'));
  const output = path.join(directory, 'bundle');
  await assert.rejects(createSnapshot(root, output, REPOSITORY), /link/i);
  await assert.rejects(access(output), /ENOENT/);
});

test('fifo inside selected tree rejects before output exists', async (t) => {
  const directory = await fixture(t);
  const root = path.join(directory, 'checkout');
  await writeTree(root);
  await run('mkfifo', [path.join(root, 'server/pipe.py')]);
  const output = path.join(directory, 'bundle');
  await assert.rejects(createSnapshot(root, output, REPOSITORY));
  await assert.rejects(access(output), /ENOENT/);
});

test('missing required input rejects before output exists', async (t) => {
  const directory = await fixture(t);
  const root = path.join(directory, 'checkout');
  await writeTree(root, { 'server/wsl_runtime.py': null });
  const output = path.join(directory, 'bundle');
  await assert.rejects(createSnapshot(root, output, REPOSITORY), /wsl_runtime\.py/);
  await assert.rejects(access(output), /ENOENT/);
});

test('existing output path refuses and leaves sentinel untouched', async (t) => {
  const { root } = await bundle(t);
  const directory = await fixture(t);
  const output = path.join(directory, 'bundle');
  await mkdir(output);
  const sentinel = path.join(output, 'sentinel.txt');
  await writeFile(sentinel, 'keep-me');
  await assert.rejects(createSnapshot(root, output, REPOSITORY), /exist/i);
  assert.equal(await readFile(sentinel, 'utf8'), 'keep-me');
});

test('exactly 256 files accepted and 257 rejected without output', async (t) => {
  const allowed = MAX_FILES - Object.keys(BASE_TREE).length;
  const extra = Object.fromEntries(Array.from({ length: allowed }, (_, i) => [`admin/src/f${String(i).padStart(3, '0')}.ts`, 'x']));
  const { manifest } = await bundle(t, extra);
  assert.equal(manifest.files.length, MAX_FILES);
  const rejected = { ...extra, 'admin/src/overflow.ts': 'x' };
  assert.equal(Object.keys(BASE_TREE).length + Object.keys(rejected).length, MAX_FILES + 1);
  const directory = await fixture(t);
  const root = path.join(directory, 'checkout');
  await writeTree(root, rejected);
  await assert.rejects(createSnapshot(root, path.join(directory, 'bundle'), REPOSITORY), /256|files/i);
  await assert.rejects(access(path.join(directory, 'bundle')), /ENOENT/);
});

test('exact total byte budget accepted and one byte over rejected', async (t) => {
  const others = Object.values(BASE_TREE).reduce((sum, s) => sum + Buffer.byteLength(s), 0);
  const filler = MAX_SOURCE_BYTES - others - Buffer.byteLength('x.ts-pad-marker');
  assert.ok(filler > 0);
  await bundle(t, { 'admin/src/payload.ts': 'x.ts-pad-marker' + 'a'.repeat(filler) });
  const directory = await fixture(t);
  const root = path.join(directory, 'checkout');
  await writeTree(root, { 'admin/src/payload.ts': 'x.ts-pad-marker' + 'a'.repeat(filler + 1) });
  await assert.rejects(createSnapshot(root, path.join(directory, 'bundle'), REPOSITORY), /bytes|budget|size/i);
  await assert.rejects(access(path.join(directory, 'bundle')), /ENOENT/);
});

test('verify rejects traversal, absolute, backslash and NUL manifest paths', async (t) => {
  for (const bad of ['../escape.ts', '/absolute.ts', 'admin\\back.ts', 'nul\0.ts', 'admin/./x.ts', 'x/../../y.md']) {
    const output = await tampered(t, (m) => {
      m.files[0] = { path: bad, sha256: 'b'.repeat(64), bytes: 1 };
    });
    await assert.rejects(verifySnapshot(output), /path|invalid/i, bad);
  }
});

test('verify rejects duplicate manifest paths and unsorted order', async (t) => {
  let output = await tampered(t, (m) => {
    m.files.splice(1, 0, { ...m.files[0] });
  });
  await assert.rejects(verifySnapshot(output), /duplicate|order|unique/i);
  output = await tampered(t, (m) => {
    m.files.reverse();
  });
  await assert.rejects(verifySnapshot(output), /order|duplicate|unique/i);
});

test('verify rejects invalid digests, byte counts, kinds and extra fields', async (t) => {
  const cases = [
    (m) => {
      m.files[0].sha256 = 'not-hex';
    },
    (m) => {
      m.files[0].sha256 = 'c'.repeat(63);
    },
    (m) => {
      m.files[0].sha256 = ['c'.repeat(64)];
    },
    (m) => {
      m.repository.commit = ['a'.repeat(40)];
    },
    (m) => {
      m.files[0].bytes = -1;
    },
    (m) => {
      m.files[0].bytes = 1.5;
    },
    (m) => {
      m.files[0].bytes = '9';
    },
    (m) => {
      m.files[0].bytes = Number.MAX_SAFE_INTEGER + 1;
    },
    (m) => {
      m.schemaVersion = 2;
    },
    (m) => {
      m.projectKind = 'wsl-standard-app';
    },
    (m) => {
      m.profileVersion = 2;
    },
    (m) => {
      m.sourceKind = 'workbench-export';
    },
    (m) => {
      m.repository.commit = 'Z'.repeat(40);
    },
    (m) => {
      m.repository.dirty = 'yes';
    },
    (m) => {
      m.repository.extra = 1;
    },
    (m) => {
      m.unexpected = true;
    },
    (m) => {
      delete m.files[0].extra;
      m.files[0].extra = 1;
    },
    (m) => {
      m.files = m.files.filter((f) => f.path !== 'server/wsl_runtime.py');
    },
    (m) => {
      m.files = {};
    },
    (m) => {
      m.merge = { baseSourceSha256: 'e'.repeat(64), localSourceSha256: 'e'.repeat(64), upstreamSourceSha256: 'e'.repeat(64) };
    },
  ];
  for (const mutate of cases) {
    const output = await tampered(t, mutate);
    await assert.rejects(verifySnapshot(output));
  }
  const staleAggregate = await tampered(
    t,
    (m) => {
      m.sourceSha256 = 'd'.repeat(64);
    },
    false,
  );
  await assert.rejects(verifySnapshot(staleAggregate));
});

test('verify rejects extra, missing or symlinked source files', async (t) => {
  const { output } = await bundle(t);
  await writeFile(path.join(output, 'source/admin/src/sneak.ts'), 'x');
  await assert.rejects(verifySnapshot(output), /declared|manifest|source/i);
  const second = await bundle(t);
  await rm(path.join(second.output, 'source/README.md'));
  await assert.rejects(verifySnapshot(second.output));
  const third = await bundle(t);
  const victim = path.join(third.output, 'source/README.md');
  const payload = await readFile(victim);
  await rm(victim);
  await symlink(path.join(third.directory, 'elsewhere.md'), victim);
  await writeFile(path.join(third.directory, 'elsewhere.md'), payload);
  await assert.rejects(verifySnapshot(third.output), /symlink/i);
  const fourth = await bundle(t);
  await writeFile(path.join(fourth.output, 'stray.txt'), 'x');
  await assert.rejects(verifySnapshot(fourth.output));
});

test('verify refuses symlinked source parent before opening outside bytes', async (t) => {
  const { output } = await bundle(t);
  const outside = path.join(path.dirname(output), 'outside-src');
  await mkdir(outside, { recursive: true });
  for (const name of ['app.ts', 'styles.css']) {
    await writeFile(path.join(outside, name), await readFile(path.join(output, 'source/admin/src', name)));
  }
  await rm(path.join(output, 'source/admin/src'), { recursive: true });
  await symlink(outside, path.join(output, 'source/admin/src'), 'dir');
  const opened = [];
  const realOpen = fsModule.open;
  fsModule.open = async (file, ...args) => {
    opened.push(String(file));
    return realOpen.call(fsModule, file, ...args);
  };
  try {
    await assert.rejects(verifySnapshot(output), /symlink/i);
  } finally {
    fsModule.open = realOpen;
  }
  assert.ok(!opened.some((file) => file.startsWith(outside)), opened.join('\n'));
});

test('verify rejects oversized manifest and manifest symlink', async (t) => {
  const { output } = await bundle(t);
  await writeFile(path.join(output, 'manifest.json'), ' '.repeat(MAX_SOURCE_BYTES + 1));
  await assert.rejects(verifySnapshot(output), /bound|exceed/i);
  const second = await bundle(t);
  const victim = path.join(second.output, 'manifest.json');
  const payload = await readFile(victim);
  await writeFile(path.join(second.directory, 'manifest-copy.json'), payload);
  await rm(victim);
  await symlink(path.join(second.directory, 'manifest-copy.json'), victim);
  await assert.rejects(verifySnapshot(second.output));
});

test('exact 500 character path accepted and 501 rejected during collection', async (t) => {
  const exact = 'admin/' + 'a/'.repeat(245) + 'f.ts';
  const over = 'admin/' + 'a/'.repeat(245) + 'ff.ts';
  assert.equal(exact.length, MAX_PATH_CHARS);
  assert.equal(over.length, MAX_PATH_CHARS + 1);
  const { manifest } = await bundle(t, { [exact]: 'x' });
  assert.ok(manifest.files.some((f) => f.path === exact));
  const directory = await fixture(t);
  const root = path.join(directory, 'checkout');
  await writeTree(root, { [over]: 'x' });
  await assert.rejects(createSnapshot(root, path.join(directory, 'bundle'), REPOSITORY), /length|characters/i);
  await assert.rejects(access(path.join(directory, 'bundle')), /ENOENT/);
});

test('merge keeps independent local and upstream changes', async (t) => {
  const base = await bundle(t);
  const local = await bundle(t, { 'admin/src/app.ts': 'export const a = 2;\n' });
  const upstream = await bundle(t, { 'server/app.py': 'def create_app():\n    return 2\n' });
  const output = path.join(local.directory, 'merged');
  const { manifest } = await mergeSnapshots(base.output, local.output, upstream.output, output);
  assert.equal(manifest.sourceKind, 'manual-merge-candidate');
  assert.equal(manifest.repository.commit, local.manifest.repository.commit);
  assert.equal(manifest.repository.dirty, true);
  assert.deepEqual(manifest.merge, {
    baseSourceSha256: base.manifest.sourceSha256,
    localSourceSha256: local.manifest.sourceSha256,
    upstreamSourceSha256: upstream.manifest.sourceSha256,
  });
  const verified = await verifySnapshot(output);
  assert.equal(verified.entries.get('admin/src/app.ts').toString(), 'export const a = 2;\n');
  assert.equal(verified.entries.get('server/app.py').toString(), 'def create_app():\n    return 2\n');
});

test('merge accepts identical updates and removes clean upstream deletions only from result', async (t) => {
  const base = await bundle(t);
  const both = { 'README.md': 'new readme\n' };
  const local = await bundle(t, both);
  const upstream = await bundle(t, { ...both, 'SPEC.md': null });
  const output = path.join(local.directory, 'merged');
  const { manifest } = await mergeSnapshots(base.output, local.output, upstream.output, output);
  const paths = manifest.files.map((f) => f.path);
  assert.ok(!paths.includes('SPEC.md'));
  const verified = await verifySnapshot(output);
  assert.equal(verified.entries.get('README.md').toString(), 'new readme\n');
  assert.ok((await readFile(path.join(upstream.output, 'manifest.json'), 'utf8')).includes('SPEC.md') === false);
  const localFiles = JSON.parse(await readFile(path.join(local.output, 'manifest.json'), 'utf8')).files.map((f) => f.path);
  const baseFiles = JSON.parse(await readFile(path.join(base.output, 'manifest.json'), 'utf8')).files.map((f) => f.path);
  assert.ok(localFiles.includes('SPEC.md'));
  assert.ok(baseFiles.includes('SPEC.md'));
});

async function bundleBytes(directory) {
  const bytes = new Map();
  const walk = async (dir, relative) => {
    for (const entry of await readdir(dir, { withFileTypes: true })) {
      const rel = relative ? `${relative}/${entry.name}` : entry.name;
      if (entry.isDirectory()) await walk(path.join(dir, entry.name), rel);
      else bytes.set(rel, await readFile(path.join(dir, entry.name)));
    }
  };
  await walk(directory, '');
  return bytes;
}

test('merge conflict records all three digests and preserves every input', async (t) => {
  const base = await bundle(t);
  const local = await bundle(t, { 'server/app.py': 'local version\n' });
  const upstream = await bundle(t, { 'server/app.py': 'upstream version\n' });
  const before = new Map();
  for (const input of [base, local, upstream]) before.set(input.output, await bundleBytes(input.output));
  const output = path.join(local.directory, 'merged');
  const result = await mergeSnapshots(base.output, local.output, upstream.output, output);
  assert.equal(result.manifest, undefined);
  assert.equal(result.conflicts.length, 1);
  assert.deepEqual(result.conflicts[0], {
    path: 'server/app.py',
    baseSha256: hash(Buffer.from('def create_app():\n    pass\n')),
    localSha256: hash(Buffer.from('local version\n')),
    upstreamSha256: hash(Buffer.from('upstream version\n')),
  });
  await assert.rejects(access(path.join(output, 'manifest.json')), /ENOENT/);
  const conflicts = JSON.parse(await readFile(path.join(output, 'conflicts.json'), 'utf8'));
  assert.equal(conflicts.schemaVersion, 1);
  assert.equal(conflicts.baseSourceSha256, base.manifest.sourceSha256);
  assert.equal(conflicts.localSourceSha256, local.manifest.sourceSha256);
  assert.equal(conflicts.upstreamSourceSha256, upstream.manifest.sourceSha256);
  for (const [bundlePath, bytes] of before) assert.deepEqual(await bundleBytes(bundlePath), bytes);
});

test('merge reports modify-versus-delete and new-file collisions', async (t) => {
  const base = await bundle(t);
  const local = await bundle(t, { 'README.md': 'local edit\n' });
  const upstream = await bundle(t, { 'README.md': null, 'admin/src/brand.ts': 'upstream\n' });
  const colliding = await bundle(t, { 'admin/src/brand.ts': 'local\n' });
  const conflictOut = path.join(local.directory, 'merged');
  const result = await mergeSnapshots(base.output, local.output, upstream.output, conflictOut);
  assert.equal(result.conflicts.length, 1);
  assert.equal(result.conflicts[0].path, 'README.md');
  assert.equal(result.conflicts[0].upstreamSha256, null);
  const collisionOut = path.join(colliding.directory, 'merged');
  const second = await mergeSnapshots(base.output, colliding.output, upstream.output, collisionOut);
  const paths = second.conflicts.map((c) => c.path).sort();
  assert.ok(paths.includes('admin/src/brand.ts'));
  const brand = second.conflicts.find((c) => c.path === 'admin/src/brand.ts');
  assert.equal(brand.baseSha256, null);
});

test('tampered input and merged budget overflow block merge', async (t) => {
  const base = await bundle(t);
  const local = await bundle(t, { 'admin/src/app.ts': 'export const a = 2;\n' });
  const upstream = await bundle(t, { 'README.md': 'up\n' });
  await writeFile(path.join(local.output, 'source/admin/src/app.ts'), 'corrupted\n');
  await assert.rejects(mergeSnapshots(base.output, local.output, upstream.output, path.join(local.directory, 'merged')));
  const heavy = 'y'.repeat(MAX_SOURCE_BYTES - Object.values(BASE_TREE).reduce((s, v) => s + Buffer.byteLength(v), 0) - 90000);
  const bigBase = await bundle(t, { 'admin/src/big.ts': heavy });
  const bigLocal = await bundle(t, { 'admin/src/big.ts': heavy, 'admin/src/one.ts': 'a'.repeat(50000) });
  const bigUpstream = await bundle(t, { 'admin/src/big.ts': heavy, 'admin/src/two.ts': 'b'.repeat(50000) });
  await assert.rejects(mergeSnapshots(bigBase.output, bigLocal.output, bigUpstream.output, path.join(bigLocal.directory, 'merged')));
});

function cli(args) {
  return spawnSync(process.execPath, [SCRIPT, ...args], { encoding: 'utf8', timeout: 30000 });
}

test('CLI usage, invalid arguments and conflict exit codes', async (t) => {
  let result = cli([]);
  assert.equal(result.status, 0);
  assert.match(result.stdout, /snapshot|verify|merge/);
  for (const args of [
    ['frobnicate'],
    ['verify'],
    ['verify', '--bundle'],
    ['verify', '--bundle', 'x', '--bundle', 'y'],
    ['verify', '--unknown', 'x'],
    ['snapshot', '--root', 'x'],
    ['merge', '--base', 'a', '--local', 'b', '--upstream', 'c'],
    ['--help', 'extra'],
  ]) {
    result = cli(args);
    assert.equal(result.status, 1, args.join(' '));
  }
  const { output } = await bundle(t);
  result = cli(['verify', '--bundle', output]);
  assert.equal(result.status, 0, result.stderr);
  const line = JSON.parse(result.stdout.trim());
  assert.equal(line.sourceKind, 'manual-source-snapshot');
  assert.equal(line.files, JSON.parse(await readFile(path.join(output, 'manifest.json'), 'utf8')).files.length);
  assert.match(line.sourceSha256, /^[0-9a-f]{64}$/);
  result = cli(['verify', '--bundle', path.join(output, 'missing')]);
  assert.equal(result.status, 1);
  const base = await bundle(t);
  const local = await bundle(t, { 'README.md': 'left\n' });
  const upstream = await bundle(t, { 'README.md': 'right\n' });
  const merged = path.join(local.directory, 'merged');
  result = cli(['merge', '--base', base.output, '--local', local.output, '--upstream', upstream.output, '--output', merged]);
  assert.equal(result.status, 2, result.stderr);
  assert.match(result.stdout, /README\.md/);
});

test('CLI snapshot records clean then dirty repository state without touching source', async (t) => {
  const directory = await fixture(t);
  const root = path.join(directory, 'checkout');
  await writeTree(root, {}, { ignored: false });
  await run('git', ['-C', root, 'init', '-q']);
  await run('git', ['-C', root, 'add', '-A']);
  await run('git', ['-C', root, '-c', 'user.name=test', '-c', 'user.email=test@example.invalid', 'commit', '-qm', 'init']);
  const output = path.join(directory, 'bundle');
  let result = cli(['snapshot', '--root', root, '--output', output]);
  assert.equal(result.status, 0, result.stderr);
  const printed = JSON.parse(result.stdout.trim());
  assert.equal(printed.sourceKind, 'manual-source-snapshot');
  const manifest = JSON.parse(await readFile(path.join(output, 'manifest.json'), 'utf8'));
  assert.equal(manifest.repository.dirty, false);
  assert.match(manifest.repository.commit, /^[0-9a-f]{40}$/);
  assert.equal(manifest.sourceSha256, printed.sourceSha256);
  for (const [relative, data] of Object.entries(BASE_TREE)) {
    assert.equal(await readFile(path.join(root, relative), 'utf8'), data, relative);
  }
  await writeFile(path.join(root, 'README.md'), 'dirty change\n');
  const second = path.join(directory, 'bundle-dirty');
  result = cli(['snapshot', '--root', root, '--output', second]);
  assert.equal(result.status, 0, result.stderr);
  const dirtyManifest = JSON.parse(await readFile(path.join(second, 'manifest.json'), 'utf8'));
  assert.equal(dirtyManifest.repository.dirty, true);
  assert.equal(dirtyManifest.repository.commit, manifest.repository.commit);
});

async function workbenchBundle(t) {
  const b = await bundle(t);
  const base = { repository: b.manifest.repository, sourceSha256: b.manifest.sourceSha256, files: b.manifest.files };
  b.manifest.sourceKind = 'workbench-export';
  b.manifest.workbench = {
    workspaceId: 'space-edu',
    projectId: '11111111-1111-4111-8111-111111111111',
    environmentId: 'sandbox',
    exportId: '22222222-2222-4222-8222-222222222222',
    exportedAt: '2026-10-13T00:00:00.000Z',
    importBase: base,
  };
  await writeFile(path.join(b.output, 'manifest.json'), JSON.stringify(b.manifest));
  return b;
}
test('verifies genuine workbench-export and preserves manual merge identity', async (t) => {
  const b = await workbenchBundle(t);
  assert.equal((await verifySnapshot(b.output)).manifest.sourceKind, 'workbench-export');
  const upstream = await bundle(t);
  const result = await mergeSnapshots(b.output, b.output, upstream.output, path.join(b.directory, 'merged'));
  assert.equal(result.manifest.sourceKind, 'manual-merge-candidate');
});
for (const field of ['projectId', 'exportId']) {
  test('rejects array-valued workbench identity: ' + field, async (t) => {
    const b = await workbenchBundle(t);
    b.manifest.workbench[field] = [b.manifest.workbench[field]];
    await writeFile(path.join(b.output, 'manifest.json'), JSON.stringify(b.manifest));
    await assert.rejects(verifySnapshot(b.output), /invalid workbench identity/);
  });
}
for (const defect of ['extra', 'base-hash', 'base-files', 'instance', 'date', 'repository', 'protected']) {
  test('rejects workbench provenance defect: ' + defect, async (t) => {
    const b = await workbenchBundle(t);
    const m = b.manifest;
    if (defect === 'extra') m.workbench.untrusted = true;
    if (defect === 'base-hash') m.workbench.importBase.sourceSha256 = '0'.repeat(64);
    if (defect === 'base-files') m.workbench.importBase.files = [];
    if (defect === 'instance') m.workbench.exportId = 'not-uuid';
    if (defect === 'date') m.workbench.exportedAt = 'yesterday';
    if (defect === 'repository') m.repository = { commit: 'b'.repeat(40), dirty: false };
    if (defect === 'protected') {
      m.workbench.importBase.files = m.workbench.importBase.files.map((f) =>
        f.path === 'server/app.py' ? { ...f, sha256: '0'.repeat(64) } : f,
      );
      m.workbench.importBase.sourceSha256 = hash(JSON.stringify(m.workbench.importBase.files));
      m.repository = { ...m.repository, dirty: true };
    }
    await writeFile(path.join(b.output, 'manifest.json'), JSON.stringify(m));
    await assert.rejects(verifySnapshot(b.output));
  });
}

test('verifies a frontend-edited workbench export against its unchanged importBase', async (t) => {
  const b = await workbenchBundle(t);
  const data = 'export const a = 2;\n';
  await writeFile(path.join(b.output, 'source/admin/src/app.ts'), data);
  b.manifest.files = b.manifest.files.map((f) =>
    f.path === 'admin/src/app.ts' ? { ...f, sha256: hash(data), bytes: Buffer.byteLength(data) } : f,
  );
  b.manifest.sourceSha256 = hash(JSON.stringify(b.manifest.files));
  b.manifest.repository = { ...b.manifest.repository, dirty: true };
  await writeFile(path.join(b.output, 'manifest.json'), JSON.stringify(b.manifest));
  assert.equal((await verifySnapshot(b.output)).manifest.sourceSha256, b.manifest.sourceSha256);
});
test('rejects importBase file directory conflicts even with a valid digest', async (t) => {
  const b = await workbenchBundle(t);
  const base = b.manifest.workbench.importBase;
  base.files = [...base.files, { path: 'admin/src/app.ts/nested.ts', sha256: hash(''), bytes: 0 }].sort((a, b) =>
    a.path < b.path ? -1 : 1,
  );
  base.sourceSha256 = hash(JSON.stringify(base.files));
  b.manifest.repository = { ...b.manifest.repository, dirty: true };
  await writeFile(path.join(b.output, 'manifest.json'), JSON.stringify(b.manifest));
  await assert.rejects(verifySnapshot(b.output), /file directory conflict/);
});

async function resolutionInputs(t, resolvedChanges = {}) {
  const base = await bundle(t);
  const local = await bundle(t, { 'admin/src/app.ts': 'export const local = 2;\n', 'admin/src/styles.css': 'body { color: blue; }\n' });
  const upstream = await bundle(t, {
    'admin/src/app.ts': 'export const upstream = 3;\n',
    'admin/src/help.ts': 'export const help = true;\n',
    'README.md': null,
  });
  const resolved = await bundle(t, {
    'admin/src/app.ts': 'export const local = 2;\nexport const upstream = 3;\n',
    'admin/src/styles.css': 'body { color: blue; }\n',
    'admin/src/help.ts': 'export const help = true;\n',
    'README.md': null,
    ...resolvedChanges,
  });
  return { base, local, upstream, resolved, output: path.join(resolved.directory, 'resolution') };
}
function resolveCli(inputs, overrides = {}) {
  const f = {
    base: inputs.base.output,
    local: inputs.local.output,
    upstream: inputs.upstream.output,
    resolved: inputs.resolved.output,
    output: inputs.output,
    ...overrides,
  };
  return cli(['resolve', ...Object.entries(f).flatMap(([k, v]) => ['--' + k, v])]);
}
test('CLI resolve retains original three-way digests while preserving both conflicting contributions', async (t) => {
  const inputs = await resolutionInputs(t);
  const result = resolveCli(inputs);
  assert.equal(result.status, 0, result.stderr);
  const { manifest, entries } = await verifySnapshot(inputs.output);
  assert.equal(manifest.sourceKind, 'manual-merge-candidate');
  assert.deepEqual(manifest.merge, {
    baseSourceSha256: inputs.base.manifest.sourceSha256,
    localSourceSha256: inputs.local.manifest.sourceSha256,
    upstreamSourceSha256: inputs.upstream.manifest.sourceSha256,
  });
  assert.equal(entries.get('admin/src/app.ts').toString(), 'export const local = 2;\nexport const upstream = 3;\n');
  assert.equal(entries.get('admin/src/styles.css').toString(), 'body { color: blue; }\n');
  assert.equal(entries.get('admin/src/help.ts').toString(), 'export const help = true;\n');
  assert(!entries.has('README.md'));
});

test('resolve accepts deletion only for a genuinely conflicted optional path', async (t) => {
  const inputs = await resolutionInputs(t, { 'admin/src/app.ts': null });
  const result = resolveCli(inputs);
  assert.equal(result.status, 0, result.stderr);
  const { entries } = await verifySnapshot(inputs.output);
  assert(!entries.has('admin/src/app.ts'));
  assert(entries.has('admin/src/help.ts'));
});

test('resolve rejects nonconflicting edits, deletions, unrelated additions and resurrected clean deletions', async (t) => {
  for (const changes of [
    { 'admin/src/styles.css': 'body { color: red; }\n' },
    { 'admin/src/help.ts': null },
    { 'admin/src/unrelated.ts': 'export const extra = true;\n' },
    { 'README.md': 'resurrected outside conflict\n' },
  ]) {
    const inputs = await resolutionInputs(t, changes);
    const result = resolveCli(inputs);
    assert.equal(result.status, 1);
    assert.match(result.stderr, /nonconflicting|unrelated/);
    await assert.rejects(lstat(inputs.output), { code: 'ENOENT' });
  }
});

test('resolve refuses nonconflicting inputs without changing ordinary merge output', async (t) => {
  const inputs = await resolutionInputs(t);
  const result = resolveCli(inputs, { local: inputs.base.output, upstream: inputs.base.output });
  assert.equal(result.status, 1);
  assert.match(result.stderr, /requires actual conflicts/);
  await assert.rejects(lstat(inputs.output), { code: 'ENOENT' });
  const merged = await mergeSnapshots(inputs.base.output, inputs.base.output, inputs.base.output, inputs.output);
  assert.equal(merged.manifest.sourceKind, 'manual-merge-candidate');
});

test('resolve requires a manual snapshot instead of rebranding another source kind', async (t) => {
  for (const kind of ['manual-merge-candidate', 'workbench-export']) {
    const inputs = await resolutionInputs(t);
    const m = inputs.resolved.manifest;
    m.sourceKind = kind;
    if (kind === 'manual-merge-candidate')
      m.merge = { baseSourceSha256: 'a'.repeat(64), localSourceSha256: 'b'.repeat(64), upstreamSourceSha256: 'c'.repeat(64) };
    else
      m.workbench = {
        workspaceId: 'fixture',
        projectId: '11111111-1111-4111-8111-111111111111',
        exportId: '22222222-2222-4222-8222-222222222222',
        environmentId: 'sandbox',
        exportedAt: '2026-10-13T00:00:00.000Z',
        importBase: { repository: m.repository, sourceSha256: m.sourceSha256, files: m.files },
      };
    await writeFile(path.join(inputs.resolved.output, 'manifest.json'), JSON.stringify(m));
    await verifySnapshot(inputs.resolved.output);
    const result = resolveCli(inputs);
    assert.equal(result.status, 1);
    assert.match(result.stderr, /resolved input must be a manual-source-snapshot/);
  }
});

test('resolve reuses strict verification for tampered inputs, links, required paths and budgets', async (t) => {
  for (const side of ['base', 'local', 'upstream', 'resolved']) {
    const inputs = await resolutionInputs(t);
    await writeFile(path.join(inputs[side].output, 'source/admin/src/app.ts'), 'tampered\n');
    const result = resolveCli(inputs);
    assert.equal(result.status, 1);
    assert.match(result.stderr, /mismatch/);
    await assert.rejects(lstat(inputs.output), { code: 'ENOENT' });
  }
  for (const invalid of ['link', 'required', 'bytes', 'count']) {
    const inputs = await resolutionInputs(t),
      resolved = inputs.resolved;
    const m = resolved.manifest;
    if (invalid === 'link') {
      const filename = path.join(resolved.output, 'source/admin/src/app.ts');
      await rm(filename);
      await symlink(path.join(inputs.local.output, 'source/admin/src/app.ts'), filename);
    } else {
      if (invalid === 'required') m.files = m.files.filter((f) => f.path !== 'server/app.py');
      if (invalid === 'bytes') m.files[0].bytes = MAX_SOURCE_BYTES + 1;
      if (invalid === 'count')
        m.files = Array.from({ length: MAX_FILES + 1 }, (_, i) => ({
          path: 'admin/src/f' + String(i).padStart(3, '0') + '.ts',
          bytes: 0,
          sha256: hash(''),
        }));
      m.sourceSha256 = hash(JSON.stringify(m.files));
      await writeFile(path.join(resolved.output, 'manifest.json'), JSON.stringify(m));
    }
    const result = resolveCli(inputs);
    assert.equal(result.status, 1, invalid);
    assert.match(result.stderr, /symlink|regular|required|exceeds/);
    await assert.rejects(lstat(inputs.output), { code: 'ENOENT' });
  }
});

test('resolve output must be fresh and every verified input remains untouched', async (t) => {
  const inputs = await resolutionInputs(t),
    before = new Map();
  for (const name of ['base', 'local', 'upstream', 'resolved']) {
    const verified = await verifySnapshot(inputs[name].output);
    before.set(name, {
      manifest: await readFile(path.join(inputs[name].output, 'manifest.json'), 'utf8'),
      files: [...verified.entries].map(([p, b]) => [p, hash(b)]),
    });
  }
  await mkdir(inputs.output);
  await writeFile(path.join(inputs.output, 'preserved'), 'existing');
  assert.equal(resolveCli(inputs).status, 1);
  assert.equal(await readFile(path.join(inputs.output, 'preserved'), 'utf8'), 'existing');
  assert.equal(resolveCli(inputs, { output: inputs.resolved.output }).status, 1);
  assert.equal(resolveCli(inputs, { output: inputs.output + '-fresh' }).status, 0);
  for (const name of ['base', 'local', 'upstream', 'resolved']) {
    const verified = await verifySnapshot(inputs[name].output);
    assert.deepEqual(
      {
        manifest: await readFile(path.join(inputs[name].output, 'manifest.json'), 'utf8'),
        files: [...verified.entries].map(([p, b]) => [p, hash(b)]),
      },
      before.get(name),
    );
  }
});

test('CLI resolve keeps real snapshot repository commit/dirty while merge provenance stays original', async (t) => {
  const inputs = await resolutionInputs(t),
    directory = await fixture(t),
    root = path.join(directory, 'git-root');
  const files = inputs.resolved.files;
  for (const [relative, data] of Object.entries(files)) {
    await mkdir(path.dirname(path.join(root, relative)), { recursive: true });
    await writeFile(path.join(root, relative), data);
  }
  await run('git', ['-C', root, 'init', '-q']);
  await run('git', ['-C', root, 'add', '-A']);
  await run('git', ['-C', root, '-c', 'user.name=test', '-c', 'user.email=test@example.invalid', 'commit', '-qm', 'manual resolution']);
  for (const dirty of [false, true]) {
    if (dirty)
      await writeFile(path.join(root, 'admin/src/app.ts'), 'export const local = 2;\nexport const upstream = 3;\n// manual review\n');
    const snapshot = path.join(directory, dirty ? 'dirty' : 'clean');
    const captured = cli(['snapshot', '--root', root, '--output', snapshot]);
    assert.equal(captured.status, 0, captured.stderr);
    const input = await verifySnapshot(snapshot);
    assert.equal(input.manifest.repository.dirty, dirty);
    const out = inputs.output + (dirty ? '-dirty' : '-clean');
    const result = resolveCli(inputs, { resolved: snapshot, output: out });
    assert.equal(result.status, 0, result.stderr);
    const { manifest } = await verifySnapshot(out);
    assert.deepEqual(manifest.repository, input.manifest.repository);
    assert.notEqual(manifest.repository.commit, inputs.local.manifest.repository.commit);
    assert.deepEqual(manifest.merge, {
      baseSourceSha256: inputs.base.manifest.sourceSha256,
      localSourceSha256: inputs.local.manifest.sourceSha256,
      upstreamSourceSha256: inputs.upstream.manifest.sourceSha256,
    });
  }
});

test('CLI resolve requires exact flags and original conflict merge still exits two', async (t) => {
  for (const args of [
    ['resolve'],
    ['resolve', '--base', 'a', '--local', 'b', '--upstream', 'c', '--output', 'o'],
    ['resolve', '--base', 'a', '--local', 'b', '--upstream', 'c', '--resolved', 'd', '--output', 'o', '--unknown', 'x'],
    ['resolve', '--base', 'a', '--base', 'b'],
    ['resolve', '--resolved'],
  ])
    assert.equal(cli(args).status, 1);
  const inputs = await resolutionInputs(t);
  const conflict = cli([
    'merge',
    '--base',
    inputs.base.output,
    '--local',
    inputs.local.output,
    '--upstream',
    inputs.upstream.output,
    '--output',
    inputs.output,
  ]);
  assert.equal(conflict.status, 2);
  assert.match(conflict.stdout, /admin\/src\/app.ts/);
  const record = JSON.parse(await readFile(path.join(inputs.output, 'conflicts.json'), 'utf8'));
  assert.equal(record.baseSourceSha256, inputs.base.manifest.sourceSha256);
  assert.equal(resolveCli(inputs, { output: inputs.output + '-resolved' }).status, 0);
});
