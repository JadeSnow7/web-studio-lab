import { Buffer } from 'node:buffer';
import { execFile } from 'node:child_process';
import console from 'node:console';
import { createHash } from 'node:crypto';
import { constants } from 'node:fs';
import fs from 'node:fs/promises';
import path from 'node:path';
import process from 'node:process';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';

export const MAX_FILES = 256;
export const MAX_SOURCE_BYTES = 524288;
export const MAX_BASE64_CHARS = 4000000;
export const MAX_PATH_CHARS = 500;

const ROOT_FILES = new Set(['README.md', 'SPEC.md', 'API.md', 'DESIGN.md', 'UX-CONTRACT.md', 'AGENTS.md']);
const OPTIONAL_DOC = 'docs/development/webstudiolab.md';
const REQUIRED_FILES = [
  'admin/package.json',
  'admin/package-lock.json',
  'server/app.py',
  'server/requirements.lock',
  'server/requirements-test.lock',
  'server/wsl_runtime.py',
];
const ADMIN_SUFFIXES = new Set(['.json', '.ts', '.tsx', '.js', '.mjs', '.css', '.html', '.md']);
const SERVER_SUFFIXES = new Set(['.py', '.txt', '.lock', '.md']);
const EXCLUDED_SEGMENTS = new Set([
  '.git',
  'node_modules',
  'dist',
  '.venv',
  'venv',
  '__pycache__',
  '.pytest_cache',
  '.ruff_cache',
  '.mypy_cache',
  '.vite',
  '.data',
  'data',
  '.runtime',
  'coverage',
]);
const SOURCE_KINDS = new Set(['manual-source-snapshot', 'manual-merge-candidate', 'workbench-export']);
const HEX64 = /^[0-9a-f]{64}$/;
const HEX40 = /^[0-9a-f]{40}$/;

const run = promisify(execFile);
const hash = (data) => createHash('sha256').update(data).digest('hex');
const MAX_BIGINT = BigInt(MAX_SOURCE_BYTES);

function fail(message) {
  throw new Error(message);
}

function sourceShape(relative) {
  if (typeof relative !== 'string' || relative === '') return null;
  if (path.isAbsolute(relative)) return null;
  const segments = relative.split('/');
  for (const segment of segments) {
    if (segment === '' || segment === '.' || segment === '..') return null;
    if (EXCLUDED_SEGMENTS.has(segment) || segment.startsWith('.env') || segment.startsWith('.wsl-')) return null;
  }
  if (segments.length === 1) return ROOT_FILES.has(segments[0]) ? 'root' : null;
  if (relative === OPTIONAL_DOC) return 'doc';
  const suffix = path.extname(segments[segments.length - 1]);
  if (segments[0] === 'admin' && ADMIN_SUFFIXES.has(suffix)) return 'admin';
  if (segments[0] === 'server' && SERVER_SUFFIXES.has(suffix)) return 'server';
  return null;
}

export function isEduSourcePath(relative) {
  if (sourceShape(relative) === null) return false;
  if (relative.length > MAX_PATH_CHARS) return false;
  for (const char of relative) {
    const code = char.codePointAt(0);
    if (code <= 0x1f || code === 0x7f || char === '\\') return false;
  }
  return true;
}

function isExcludedName(name) {
  return EXCLUDED_SEGMENTS.has(name) || name.startsWith('.env') || name.startsWith('.wsl-');
}

async function assertParents(root, realRoot, relative) {
  const parts = relative.split('/');
  parts.pop();
  let current = root;
  for (const name of parts) {
    current = path.join(current, name);
    const info = await fs.lstat(current);
    if (info.isSymbolicLink() || !info.isDirectory()) fail(`selected parent is not a real directory: ${relative}`);
  }
  const real = await fs.realpath(current);
  if (real !== realRoot && !real.startsWith(realRoot + path.sep)) fail(`selected parent escapes real root: ${relative}`);
}

async function readBounded(absolute) {
  const link0 = await fs.lstat(absolute, { bigint: true });
  if (link0.isSymbolicLink()) fail(`refusing symlink: ${absolute}`);
  if (!link0.isFile()) fail(`not a regular file: ${absolute}`);
  if (link0.nlink !== 1n) fail(`hardlinked file: ${absolute}`);
  if (link0.size > MAX_BIGINT) fail(`file exceeds per-file bound: ${absolute}`);
  const handle = await fs.open(absolute, constants.O_RDONLY | constants.O_NOFOLLOW);
  try {
    const before = await handle.stat({ bigint: true });
    if (!before.isFile()) fail(`not a regular file: ${absolute}`);
    if (before.nlink !== 1n) fail(`hardlinked file: ${absolute}`);
    if (
      before.dev !== link0.dev ||
      before.ino !== link0.ino ||
      before.size !== link0.size ||
      before.mtimeNs !== link0.mtimeNs ||
      before.ctimeNs !== link0.ctimeNs
    ) {
      fail(`file changed before read: ${absolute}`);
    }
    if (before.size > MAX_BIGINT) fail(`file exceeds per-file bound: ${absolute}`);
    const expected = Number(before.size);
    const buffer = Buffer.alloc(MAX_SOURCE_BYTES + 1);
    let total = 0;
    while (total < buffer.length) {
      const { bytesRead } = await handle.read(buffer, total, buffer.length - total, total);
      if (bytesRead === 0) break;
      total += bytesRead;
      if (total > expected) fail(`file grew while reading: ${absolute}`);
    }
    if (total !== expected) fail(`file size changed while reading: ${absolute}`);
    const after = await handle.stat({ bigint: true });
    if (
      after.dev !== before.dev ||
      after.ino !== before.ino ||
      after.size !== before.size ||
      after.mtimeNs !== before.mtimeNs ||
      after.ctimeNs !== before.ctimeNs
    ) {
      fail(`file changed while reading: ${absolute}`);
    }
    const link1 = await fs.lstat(absolute, { bigint: true });
    if (link1.dev !== before.dev || link1.ino !== before.ino) fail(`file was replaced while reading: ${absolute}`);
    return buffer.subarray(0, total);
  } finally {
    await handle.close();
  }
}

async function collectFromTree(root, top, accept) {
  const absolute = path.join(root, top);
  let info;
  try {
    info = await fs.lstat(absolute);
  } catch (error) {
    if (error.code !== 'ENOENT') throw error;
    return;
  }
  if (info.isSymbolicLink()) fail(`refusing symlink at selected root: ${top}`);
  if (!info.isDirectory()) fail(`selected source root is not a directory: ${top}`);
  const walk = async (directory, relative) => {
    for (const dirent of await fs.readdir(directory, { withFileTypes: true })) {
      const name = dirent.name;
      if (isExcludedName(name)) continue;
      const rel = relative ? `${relative}/${name}` : name;
      const entry = path.join(directory, name);
      if (dirent.isSymbolicLink()) fail(`refusing symlink in selected source: ${rel}`);
      if (dirent.isDirectory()) {
        await walk(entry, rel);
      } else if (dirent.isFile()) {
        if (isEduSourcePath(rel)) await accept(rel, entry);
        else if (sourceShape(rel) !== null) fail(`selected source path has invalid length or characters: ${rel}`);
      } else {
        fail(`unsupported special file in selected source: ${rel}`);
      }
    }
  };
  await walk(absolute, top);
}

async function collect(root) {
  const realRoot = await fs.realpath(root);
  const rootInfo = await fs.lstat(root);
  if (rootInfo.isSymbolicLink()) fail('source root must not be a symlink');
  if (!rootInfo.isDirectory()) fail('source root must be a directory');
  const entries = [];
  const budget = { count: 0, bytes: 0 };
  const accept = async (relative, absolute) => {
    budget.count += 1;
    if (budget.count > MAX_FILES) fail(`source file count exceeds ${MAX_FILES}`);
    const data = await readBounded(absolute);
    budget.bytes += data.length;
    if (budget.bytes > MAX_SOURCE_BYTES) fail(`source bytes exceed ${MAX_SOURCE_BYTES}`);
    if (4 * Math.ceil(data.length / 3) > MAX_BASE64_CHARS) fail('source file exceeds base64 bound');
    entries.push({ path: relative, data });
  };
  const include = async (relative) => {
    const absolute = path.join(root, relative);
    let info;
    try {
      info = await fs.lstat(absolute);
    } catch (error) {
      if (error.code !== 'ENOENT') throw error;
      return;
    }
    if (info.isSymbolicLink()) fail(`refusing symlink in selected source: ${relative}`);
    if (!info.isFile()) fail(`root document is not a regular file: ${relative}`);
    await assertParents(root, realRoot, relative);
    await accept(relative, absolute);
  };
  for (const name of ROOT_FILES) await include(name);
  let docsReal = true;
  for (const parent of ['docs', 'docs/development']) {
    let info;
    try {
      info = await fs.lstat(path.join(root, parent));
    } catch (error) {
      if (error.code !== 'ENOENT') throw error;
      docsReal = false;
      break;
    }
    if (info.isSymbolicLink()) fail(`refusing symlink at selected parent: ${parent}`);
    if (!info.isDirectory()) {
      docsReal = false;
      break;
    }
  }
  if (docsReal) await include(OPTIONAL_DOC);
  for (const top of ['admin', 'server']) {
    await collectFromTree(root, top, async (relative, absolute) => {
      await assertParents(root, realRoot, relative);
      await accept(relative, absolute);
    });
  }
  const seen = new Set();
  for (const { path: relative } of entries) {
    if (seen.has(relative)) fail(`duplicate source path: ${relative}`);
    seen.add(relative);
    if (!path.resolve(realRoot, relative).startsWith(realRoot + path.sep)) fail(`source path escapes root: ${relative}`);
  }
  return entries;
}

function checkBudgets(files) {
  if (files.length > MAX_FILES) fail(`source file count ${files.length} exceeds ${MAX_FILES}`);
  let total = 0;
  for (const { data } of files) {
    if (4 * Math.ceil(data.length / 3) > MAX_BASE64_CHARS) fail('source file exceeds base64 bound');
    total += data.length;
  }
  if (total > MAX_SOURCE_BYTES) fail(`source bytes ${total} exceed ${MAX_SOURCE_BYTES}`);
}

function checkRequired(paths) {
  for (const required of REQUIRED_FILES) {
    if (!paths.has(required)) fail(`required source input missing: ${required}`);
  }
}

async function publish(output, manifest, entries) {
  try {
    await fs.lstat(output);
    fail(`output path already exists: ${output}`);
  } catch (error) {
    if (error.code !== 'ENOENT') throw error;
  }
  const directories = new Set([output, path.join(output, 'source')]);
  for (const relative of entries.keys()) {
    let current = path.dirname(path.join(output, 'source', relative));
    while (current !== output) {
      directories.add(current);
      const parent = path.dirname(current);
      if (parent === current) break;
      current = parent;
    }
  }
  await fs.mkdir(output, { mode: 0o700 });
  for (const directory of [...directories].sort()) {
    if (directory !== output) await fs.mkdir(directory, { mode: 0o700 });
  }
  for (const [relative, data] of entries) {
    await fs.writeFile(path.join(output, 'source', relative), data, { mode: 0o600, flag: 'wx' });
  }
  await fs.writeFile(path.join(output, 'manifest.json'), JSON.stringify(manifest, null, 2) + '\n', { mode: 0o600, flag: 'wx' });
}

function authorManifest(repository, sourceKind, sorted, extra = {}) {
  const files = sorted.map(({ path: relative, data }) => ({ path: relative, sha256: hash(data), bytes: data.length }));
  return {
    schemaVersion: 1,
    projectKind: 'edu-web',
    profileVersion: 1,
    sourceKind,
    repository,
    sourceSha256: hash(JSON.stringify(files)),
    files,
    ...extra,
  };
}

function checkDigest(value, label, pattern) {
  if (typeof value !== 'string' || !pattern.test(value)) fail(`${label} must be a hex digest string`);
}

function checkRepository(repository) {
  if (typeof repository !== 'object' || repository === null || Array.isArray(repository)) fail('repository must be an object');
  const keys = Object.keys(repository).sort();
  if (keys.join(',') !== 'commit,dirty') fail('repository must contain exactly commit and dirty');
  checkDigest(repository.commit, 'repository commit', HEX40);
  if (typeof repository.dirty !== 'boolean') fail('repository dirty must be a boolean');
}

async function prepareSnapshot(root, repository) {
  checkRepository(repository);
  const entries = await collect(path.resolve(root));
  const sorted = entries.sort((a, b) => (a.path < b.path ? -1 : a.path > b.path ? 1 : 0));
  checkBudgets(sorted);
  checkRequired(new Set(sorted.map((entry) => entry.path)));
  const manifest = authorManifest(repository, 'manual-source-snapshot', sorted);
  return { manifest, entries: new Map(sorted.map((entry) => [entry.path, entry.data])) };
}

export async function createSnapshot(root, output, repository) {
  const prepared = await prepareSnapshot(root, repository);
  await publish(path.resolve(output), prepared.manifest, prepared.entries);
  return { manifest: prepared.manifest };
}

function checkExactKeys(value, allowed, label) {
  const keys = Object.keys(value).sort();
  const expected = [...allowed].sort();
  if (keys.join(',') !== expected.join(',')) fail(`manifest ${label} must contain exactly: ${expected.join(',')}`);
}

async function listSourceFiles(sourceDir) {
  const found = [];
  const walk = async (directory, relative) => {
    for (const dirent of await fs.readdir(directory, { withFileTypes: true })) {
      const name = dirent.name;
      const rel = relative ? `${relative}/${name}` : name;
      if (dirent.isSymbolicLink()) fail(`symlink inside bundle source: ${rel}`);
      if (dirent.isDirectory()) await walk(path.join(directory, name), rel);
      else if (dirent.isFile()) found.push(rel);
      else fail(`special file inside bundle source: ${rel}`);
    }
  };
  await walk(sourceDir, '');
  return found;
}

export async function verifySnapshot(directory) {
  const bundle = path.resolve(directory);
  const info = await fs.lstat(bundle);
  if (info.isSymbolicLink() || !info.isDirectory()) fail('bundle path must be a real directory');
  const top = await fs.readdir(bundle, { withFileTypes: true });
  const names = top.map((entry) => entry.name).sort();
  if (names.join(',') !== 'manifest.json,source') fail('bundle must contain exactly manifest.json and source/');
  for (const entry of top) {
    if (entry.isSymbolicLink()) fail(`symlink inside bundle root: ${entry.name}`);
    if (entry.name === 'manifest.json' && !entry.isFile()) fail('manifest.json must be a regular file');
    if (entry.name === 'source' && !entry.isDirectory()) fail('source must be a directory');
  }
  const raw = await readBounded(path.join(bundle, 'manifest.json'));
  let manifest;
  try {
    manifest = JSON.parse(raw.toString('utf8'));
  } catch {
    fail('manifest.json is not valid JSON');
  }
  if (typeof manifest !== 'object' || manifest === null || Array.isArray(manifest)) fail('manifest must be a JSON object');
  const allowed = ['schemaVersion', 'projectKind', 'profileVersion', 'sourceKind', 'repository', 'sourceSha256', 'files'];
  if (manifest.sourceKind === 'manual-merge-candidate') allowed.push('merge');
  if (manifest.sourceKind === 'workbench-export') allowed.push('workbench');
  checkExactKeys(manifest, allowed, 'fields');
  if (manifest.schemaVersion !== 1) fail('unsupported manifest schemaVersion');
  if (manifest.projectKind !== 'edu-web') fail('unsupported manifest projectKind');
  if (manifest.profileVersion !== 1) fail('unsupported manifest profileVersion');
  if (!SOURCE_KINDS.has(manifest.sourceKind)) fail('unsupported manifest sourceKind');
  checkRepository(manifest.repository);
  checkDigest(manifest.sourceSha256, 'manifest sourceSha256', HEX64);
  if (!Array.isArray(manifest.files)) fail('manifest files must be an array');
  if (manifest.files.length > MAX_FILES) fail(`manifest exceeds ${MAX_FILES} files`);
  if (manifest.sourceKind === 'manual-merge-candidate') {
    const merge = manifest.merge;
    if (typeof merge !== 'object' || merge === null || Array.isArray(merge)) fail('merge provenance must be an object');
    checkExactKeys(merge, ['baseSourceSha256', 'localSourceSha256', 'upstreamSourceSha256'], 'merge fields');
    for (const key of ['baseSourceSha256', 'localSourceSha256', 'upstreamSourceSha256']) checkDigest(merge[key], `merge ${key}`, HEX64);
  }
  const declared = new Set();
  let previous = '';
  let declaredBytes = 0;
  for (const entry of manifest.files) {
    if (typeof entry !== 'object' || entry === null || Array.isArray(entry)) fail('manifest file entries must be objects');
    checkExactKeys(entry, ['path', 'sha256', 'bytes'], 'file entry fields');
    if (!isEduSourcePath(entry.path)) fail(`manifest path violates allowlist: ${entry.path}`);
    if (entry.path <= previous) fail('manifest files must be sorted by path without duplicates');
    previous = entry.path;
    if (declared.has(entry.path)) fail(`duplicate manifest path: ${entry.path}`);
    declared.add(entry.path);
    checkDigest(entry.sha256, `file digest for ${entry.path}`, HEX64);
    if (!Number.isSafeInteger(entry.bytes) || entry.bytes < 0) fail(`invalid byte count for: ${entry.path}`);
    declaredBytes += entry.bytes;
  }
  if (declaredBytes > MAX_SOURCE_BYTES) fail(`manifest exceeds ${MAX_SOURCE_BYTES} bytes`);
  checkRequired(declared);
  if (manifest.sourceKind === 'workbench-export') {
    const w = manifest.workbench;
    if (!w || typeof w !== 'object' || Array.isArray(w)) fail('workbench must be an object');
    checkExactKeys(w, ['workspaceId', 'projectId', 'environmentId', 'exportId', 'exportedAt', 'importBase'], 'workbench');
    const uuid = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;
    if (
      typeof w.workspaceId !== 'string' ||
      !w.workspaceId.length ||
      w.workspaceId.length > 200 ||
      !uuid.test(w.projectId) ||
      !uuid.test(w.exportId) ||
      w.environmentId !== 'sandbox'
    )
      fail('invalid workbench identity');
    if (
      typeof w.exportedAt !== 'string' ||
      !Number.isFinite(Date.parse(w.exportedAt)) ||
      new Date(w.exportedAt).toISOString() !== w.exportedAt
    )
      fail('invalid workbench exportedAt');
    const base = w.importBase;
    if (!base || typeof base !== 'object' || Array.isArray(base)) fail('invalid workbench importBase');
    checkExactKeys(base, ['repository', 'sourceSha256', 'files'], 'importBase');
    checkRepository(base.repository);
    checkDigest(base.sourceSha256, 'importBase sourceSha256', HEX64);
    if (!Array.isArray(base.files) || !base.files.length || base.files.length > MAX_FILES) fail('invalid importBase files');
    let prior = '',
      size = 0;
    for (const f of base.files) {
      if (!f || typeof f !== 'object' || Array.isArray(f)) fail('invalid importBase file');
      checkExactKeys(f, ['path', 'sha256', 'bytes'], 'importBase file');
      if (!isEduSourcePath(f.path) || f.path <= prior || !Number.isSafeInteger(f.bytes) || f.bytes < 0)
        fail('invalid importBase inventory');
      checkDigest(f.sha256, 'importBase file sha256', HEX64);
      prior = f.path;
      size += f.bytes;
    }
    const paths = new Set(base.files.map((f) => f.path));
    for (const f of base.files) {
      const parts = f.path.split('/');
      for (let i = 1; i < parts.length; i++) if (paths.has(parts.slice(0, i).join('/'))) fail('importBase file directory conflict');
    }
    checkRequired(paths);
    if (size > MAX_SOURCE_BYTES || hash(JSON.stringify(base.files)) !== base.sourceSha256) fail('invalid importBase digest or budget');
    const protectedFiles = (files) => files.filter((f) => !f.path.startsWith('admin/src/'));
    if (JSON.stringify(protectedFiles(base.files)) !== JSON.stringify(protectedFiles(manifest.files)))
      fail('workbench protected source changed');
    if (
      manifest.repository.commit !== base.repository.commit ||
      manifest.repository.dirty !== (base.repository.dirty || manifest.sourceSha256 !== base.sourceSha256)
    )
      fail('workbench repository provenance mismatch');
  }
  const sourceDir = path.join(bundle, 'source');
  const sourceInfo = await fs.lstat(sourceDir);
  if (sourceInfo.isSymbolicLink() || !sourceInfo.isDirectory()) fail('source must be a real directory');
  const realSource = await fs.realpath(sourceDir);
  const onDisk = await listSourceFiles(sourceDir);
  if (onDisk.length !== declared.size) fail('bundle source contains files not declared in manifest');
  for (const relative of onDisk) {
    if (!declared.has(relative)) fail(`bundle source contains undeclared file: ${relative}`);
  }
  const entries = new Map();
  for (const entry of manifest.files) {
    const absolute = path.resolve(sourceDir, entry.path);
    if (!absolute.startsWith(sourceDir + path.sep)) fail(`manifest path escapes bundle source: ${entry.path}`);
    await assertParents(sourceDir, realSource, entry.path);
    const data = await readBounded(absolute);
    if (data.length !== entry.bytes) fail(`byte count mismatch for: ${entry.path}`);
    if (hash(data) !== entry.sha256) fail(`digest mismatch for: ${entry.path}`);
    if (4 * Math.ceil(data.length / 3) > MAX_BASE64_CHARS) fail(`file exceeds base64 bound: ${entry.path}`);
    entries.set(entry.path, data);
  }
  if (hash(JSON.stringify(manifest.files)) !== manifest.sourceSha256) fail('manifest aggregate digest mismatch');
  return { manifest, entries };
}

function selectMergeEntries(base, local, upstream) {
  const paths = [...new Set([...base.entries.keys(), ...local.entries.keys(), ...upstream.entries.keys()])].sort();
  const same = (a, b) => (a === undefined ? b === undefined : b !== undefined && a.equals(b));
  const chosen = new Map();
  const conflicts = [];
  for (const relative of paths) {
    const b = base.entries.get(relative);
    const l = local.entries.get(relative);
    const u = upstream.entries.get(relative);
    if (same(l, u)) {
      if (l !== undefined) chosen.set(relative, l);
    } else if (same(l, b)) {
      if (u !== undefined) chosen.set(relative, u);
    } else if (same(u, b)) {
      if (l !== undefined) chosen.set(relative, l);
    } else {
      conflicts.push({
        path: relative,
        baseSha256: b === undefined ? null : hash(b),
        localSha256: l === undefined ? null : hash(l),
        upstreamSha256: u === undefined ? null : hash(u),
      });
    }
  }
  return { chosen, conflicts };
}

export async function mergeSnapshots(baseDirectory, localDirectory, upstreamDirectory, output) {
  const base = await verifySnapshot(baseDirectory);
  const local = await verifySnapshot(localDirectory);
  const upstream = await verifySnapshot(upstreamDirectory);
  const { chosen, conflicts } = selectMergeEntries(base, local, upstream);
  const target = path.resolve(output);
  try {
    await fs.lstat(target);
    fail(`output path already exists: ${target}`);
  } catch (error) {
    if (error.code !== 'ENOENT') throw error;
  }
  if (conflicts.length) {
    await fs.mkdir(target, { mode: 0o700 });
    const record = {
      schemaVersion: 1,
      baseSourceSha256: base.manifest.sourceSha256,
      localSourceSha256: local.manifest.sourceSha256,
      upstreamSourceSha256: upstream.manifest.sourceSha256,
      conflicts,
    };
    await fs.writeFile(path.join(target, 'conflicts.json'), JSON.stringify(record, null, 2) + '\n', { mode: 0o600, flag: 'wx' });
    return { conflicts };
  }
  const sorted = [...chosen.entries()].map(([relative, data]) => ({ path: relative, data }));
  for (const { path: relative } of sorted) {
    if (!isEduSourcePath(relative)) fail(`merged path violates whitelist: ${relative}`);
  }
  checkBudgets(sorted);
  checkRequired(new Set(sorted.map((entry) => entry.path)));
  const manifest = authorManifest({ commit: local.manifest.repository.commit, dirty: true }, 'manual-merge-candidate', sorted, {
    merge: {
      baseSourceSha256: base.manifest.sourceSha256,
      localSourceSha256: local.manifest.sourceSha256,
      upstreamSourceSha256: upstream.manifest.sourceSha256,
    },
  });
  await publish(target, manifest, chosen);
  return { manifest };
}

export async function resolveSnapshots(baseDirectory, localDirectory, upstreamDirectory, resolvedDirectory, output) {
  const base = await verifySnapshot(baseDirectory);
  const local = await verifySnapshot(localDirectory);
  const upstream = await verifySnapshot(upstreamDirectory);
  const resolved = await verifySnapshot(resolvedDirectory);
  if (resolved.manifest.sourceKind !== 'manual-source-snapshot') fail('resolved input must be a manual-source-snapshot');
  const { chosen, conflicts } = selectMergeEntries(base, local, upstream);
  if (!conflicts.length) fail('resolve requires actual conflicts; use merge for nonconflicting inputs');
  const conflicted = new Set(conflicts.map((conflict) => conflict.path));
  for (const [relative, data] of chosen) {
    const actual = resolved.entries.get(relative);
    if (actual === undefined || !actual.equals(data)) fail(`resolved input changes nonconflicting path: ${relative}`);
  }
  for (const relative of resolved.entries.keys()) {
    if (!chosen.has(relative) && !conflicted.has(relative)) fail(`resolved input adds unrelated path: ${relative}`);
  }
  const sorted = [...resolved.entries].map(([relative, data]) => ({ path: relative, data }));
  checkBudgets(sorted);
  checkRequired(new Set(resolved.entries.keys()));
  // snapshot records its Git root's commit/dirty metadata. Resolving does not
  // replace that history with local's HEAD or claim a workbench product export.
  const manifest = authorManifest(resolved.manifest.repository, 'manual-merge-candidate', sorted, {
    merge: {
      baseSourceSha256: base.manifest.sourceSha256,
      localSourceSha256: local.manifest.sourceSha256,
      upstreamSourceSha256: upstream.manifest.sourceSha256,
    },
  });
  await publish(path.resolve(output), manifest, resolved.entries);
  return { manifest };
}

async function gitLine(root, args) {
  try {
    return (await run('git', ['-C', root, ...args])).stdout;
  } catch (error) {
    const detail = (error.stderr || error.message || 'unknown error').trim().split('\n')[0];
    fail(`git ${args[0]} failed: ${detail}`);
  }
}

async function deriveRepository(root) {
  const toplevel = (await gitLine(root, ['rev-parse', '--show-toplevel'])).trim();
  const realRoot = await fs.realpath(root);
  const realTop = await fs.realpath(toplevel);
  if (realRoot !== realTop) fail('snapshot root must be the git work tree top level');
  const commit = (await gitLine(root, ['rev-parse', 'HEAD'])).trim();
  checkDigest(commit, 'git HEAD', HEX40);
  const status = await gitLine(root, ['status', '--porcelain=v1', '--untracked-files=all']);
  return { repository: { commit, dirty: status.length > 0 }, status };
}

function parseFlags(args) {
  const flags = new Map();
  for (let i = 0; i < args.length; i += 1) {
    const arg = args[i];
    if (!arg.startsWith('--') || arg === '--') fail(`unexpected argument: ${arg}`);
    const name = arg.slice(2);
    if (flags.has(name)) fail(`duplicate flag: --${name}`);
    const value = args[i + 1];
    if (value === undefined || value.startsWith('--')) fail(`missing value for --${name}`);
    flags.set(name, value);
    i += 1;
  }
  return flags;
}

function needFlags(flags, names) {
  const given = [...flags.keys()].sort();
  const expected = [...names].sort();
  if (given.join(',') !== expected.join(',')) fail(`expected flags: ${expected.map((n) => '--' + n).join(' ')}`);
}

const USAGE =
  'usage: edu-source.mjs <command>\n  snapshot --root <checkout> --output <bundle>\n  verify --bundle <bundle>\n  merge --base <bundle> --local <bundle> --upstream <bundle> --output <result>\n  resolve --base <bundle> --local <bundle> --upstream <bundle> --resolved <snapshot> --output <bundle>';

async function cli(argv) {
  const [command, ...rest] = argv;
  if (command === undefined || ((command === '--help' || command === '-h') && rest.length === 0)) {
    console.log(USAGE);
    return 0;
  }
  if (command === 'snapshot') {
    const flags = parseFlags(rest);
    needFlags(flags, ['root', 'output']);
    const root = flags.get('root');
    const before = await deriveRepository(root);
    const prepared = await prepareSnapshot(root, before.repository);
    const recollected = await collect(path.resolve(root));
    const second = recollected.sort((a, b) => (a.path < b.path ? -1 : a.path > b.path ? 1 : 0));
    if (authorManifest(before.repository, 'manual-source-snapshot', second).sourceSha256 !== prepared.manifest.sourceSha256) {
      fail('source changed while capturing snapshot');
    }
    const after = await deriveRepository(root);
    if (after.repository.commit !== before.repository.commit || after.status !== before.status) {
      fail('repository changed while capturing snapshot');
    }
    await publish(path.resolve(flags.get('output')), prepared.manifest, prepared.entries);
    console.log(
      JSON.stringify({
        sourceKind: prepared.manifest.sourceKind,
        files: prepared.manifest.files.length,
        sourceSha256: prepared.manifest.sourceSha256,
      }),
    );
    return 0;
  }
  if (command === 'verify') {
    const flags = parseFlags(rest);
    needFlags(flags, ['bundle']);
    const { manifest } = await verifySnapshot(flags.get('bundle'));
    console.log(JSON.stringify({ sourceKind: manifest.sourceKind, files: manifest.files.length, sourceSha256: manifest.sourceSha256 }));
    return 0;
  }
  if (command === 'merge') {
    const flags = parseFlags(rest);
    needFlags(flags, ['base', 'local', 'upstream', 'output']);
    const result = await mergeSnapshots(flags.get('base'), flags.get('local'), flags.get('upstream'), flags.get('output'));
    if (result.conflicts) {
      for (const conflict of result.conflicts) console.log(conflict.path);
      return 2;
    }
    console.log(
      JSON.stringify({
        sourceKind: result.manifest.sourceKind,
        files: result.manifest.files.length,
        sourceSha256: result.manifest.sourceSha256,
      }),
    );
    return 0;
  }
  if (command === 'resolve') {
    const flags = parseFlags(rest);
    needFlags(flags, ['base', 'local', 'upstream', 'resolved', 'output']);
    const { manifest } = await resolveSnapshots(
      flags.get('base'),
      flags.get('local'),
      flags.get('upstream'),
      flags.get('resolved'),
      flags.get('output'),
    );
    console.log(JSON.stringify({ sourceKind: manifest.sourceKind, files: manifest.files.length, sourceSha256: manifest.sourceSha256 }));
    return 0;
  }
  fail(`unknown command: ${command}`);
  return 1;
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  cli(process.argv.slice(2))
    .then((code) => {
      process.exitCode = code;
    })
    .catch((error) => {
      console.error(error instanceof Error ? error.message : String(error));
      process.exitCode = 1;
    });
}
