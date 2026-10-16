/* global Buffer, process */
import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, writeFile, readFile, rm, access, chmod, symlink, lstat } from 'node:fs/promises';
import os from 'node:os';
import { URL } from 'node:url';
import { execFileSync } from 'node:child_process';
import { gzipSync, gunzipSync } from 'node:zlib';
import path from 'node:path';
import {
  auditGuestArchive,
  auditGuestDirectory,
  prunePnpmForeignTargets,
  requiredGuestBinaries,
  requiredGuestExecutables,
} from './guest-platform.mjs';
import { deterministicArchive, digest, root, inspectTar, normalizePayloadPermissions } from './payload-lib.mjs';
import { verifyPayloads } from './release-gates.mjs';

function elf(machine = 183) {
  const header = Buffer.alloc(64);
  header.set([127, 69, 76, 70, 2, 1, 1]);
  header.writeUInt16LE(machine, 18);
  return header;
}
async function fixture(t) {
  const directory = await mkdtemp(path.join(os.tmpdir(), 'wsl-guest-platform-'));
  t.after(() => rm(directory, { recursive: true, force: true }));
  for (const relative of requiredGuestBinaries) {
    await mkdir(path.dirname(path.join(directory, relative)), { recursive: true });
    await writeFile(path.join(directory, relative), elf());
    await chmod(path.join(directory, relative), 0o755);
  }
  for (const relative of requiredGuestExecutables.filter((name) => !requiredGuestBinaries.includes(name))) {
    await mkdir(path.dirname(path.join(directory, relative)), { recursive: true });
    await writeFile(path.join(directory, relative), '#!/usr/bin/env node', { mode: 0o755 });
    await chmod(path.join(directory, relative), 0o755);
  }
  await normalizePayloadPermissions(directory);
  return directory;
}
test('pnpm platform pruning removes only macOS/Windows targets and preserves Linux ARM64 native bytes', async (t) => {
  const directory = await fixture(t);
  const pnpm = path.join(directory, 'usr/local/lib/node_modules/pnpm');
  await mkdir(path.join(pnpm, 'dist/vendor'), { recursive: true });
  await writeFile(path.join(pnpm, 'dist/reflink.darwin-arm64-locked.node'), Buffer.from('cffaedfe', 'hex'));
  await writeFile(path.join(pnpm, 'dist/vendor/fastlist-0.3.0-x64.exe'), Buffer.from('MZ'));
  const linux = path.join(pnpm, 'dist/reflink.linux-arm64-gnu.node');
  const bytes = elf();
  await writeFile(linux, bytes);
  await writeFile(path.join(pnpm, 'dist/pnpm.cjs'), 'platform-specific loader');
  const removed = await prunePnpmForeignTargets(pnpm);
  assert.equal(removed.length, 2);
  await assert.rejects(access(path.join(pnpm, removed[0])), /ENOENT/);
  assert.deepEqual(await readFile(linux), bytes);
  await normalizePayloadPermissions(directory);
  const audit = await auditGuestDirectory(directory);
  assert.equal(audit.elfFiles.length, 3);
  const archive = path.join(os.tmpdir(), path.basename(directory) + '.tar.gz');
  t.after(() => rm(archive, { force: true }));
  await deterministicArchive(directory, archive);
  assert.deepEqual(auditGuestArchive(await readFile(archive)), audit);
});
test('guest archive audit rejects residual Mach-O and PE even outside pnpm', async (t) => {
  const directory = await fixture(t);
  const runtime = await mkdtemp(path.join(os.tmpdir(), 'wsl-stale-payload-'));
  t.after(() => rm(runtime, { recursive: true, force: true }));
  const lock = JSON.parse(await readFile(path.join(root, 'packaging/dependencies.lock.json'), 'utf8'));
  const python = lock.sources.find((source) => source.id === 'python');
  await mkdir(path.join(runtime, 'python/bin'), { recursive: true });
  await writeFile(path.join(runtime, 'python/bin/python3'), 'python');
  const archive = path.join(os.tmpdir(), path.basename(directory) + '.tar.gz');
  t.after(() => rm(archive, { force: true }));
  for (const [kind, bytes] of [
    ['Mach-O', Buffer.from('cffaedfe', 'hex')],
    ['PE', Buffer.from('MZ')],
  ]) {
    await writeFile(path.join(directory, 'unexpected-native'), bytes);
    await deterministicArchive(directory, archive);
    const readBytes = await readFile(archive);
    assert.throws(() => auditGuestArchive(readBytes), new RegExp(kind));
    await writeFile(path.join(runtime, 'guest-tools.tar.gz'), readBytes);
    await writeFile(
      path.join(runtime, 'dependencies.json'),
      JSON.stringify({
        schemaVersion: 1,
        platform: 'darwin-arm64',
        baseImage: lock.baseImage.reference,
        python: {
          path: 'python/bin/python3',
          executable: 'python/bin/python3',
          version: python.version,
          archiveSha256: python.sha256,
          sha256: digest(Buffer.from('python')),
          expandedBytes: 6,
        },
        guest: {
          path: 'guest-tools.tar.gz',
          node: '24.21.0',
          pnpm: '10.34.6',
          codex: '0.160.0',
          sha256: digest(readBytes),
          expandedBytes: 100,
        },
      }),
    );
    await assert.rejects(verifyPayloads(runtime), new RegExp(`Foreign ${kind}`));
  }
});
test('guest audit rejects wrong ELF architecture or a missing required native executable', async (t) => {
  const directory = await fixture(t);
  await writeFile(path.join(directory, 'wrong-architecture.so'), elf(62));
  await assert.rejects(auditGuestDirectory(directory), /Incompatible ELF/);
  await rm(path.join(directory, 'wrong-architecture.so'));
  await rm(path.join(directory, requiredGuestBinaries[0]));
  await assert.rejects(auditGuestDirectory(directory), /Required Linux ARM64 executable is missing/);
});

function changeTarMode(archive, name, mode) {
  const bytes = gunzipSync(archive);
  for (let offset = 0; offset + 512 <= bytes.length;) {
    const header = bytes.subarray(offset, offset + 512);
    const text = (part) => part.toString().replace(/\0.*$/s, '');
    const entry = text(header.subarray(345, 500));
    const current = (entry ? entry + '/' : '') + text(header.subarray(0, 100));
    if (current === name) {
      header.write(mode.toString(8).padStart(7, '0') + '\0', 100, 8);
      header.write('        ', 148, 8);
      const sum = header.reduce((total, byte) => total + byte, 0);
      header.write(sum.toString(8).padStart(6, '0') + '\0 ', 148, 8);
      return gzipSync(bytes);
    }
    offset += 512 + Math.ceil(parseInt(text(header.subarray(124, 136)) || '0', 8) / 512) * 512;
  }
  throw new Error('fixture member missing: ' + name);
}
test('guest permission audit refuses root-private directories, unreadable data and non-agent executables', async (t) => {
  const directory = await fixture(t),
    archive = path.join(directory, '../' + path.basename(directory) + '.tar.gz');
  t.after(() => rm(archive, { force: true }));
  for (const file of requiredGuestBinaries) await chmod(path.join(directory, file), 0o755);
  await writeFile(path.join(directory, 'usr/local/data.json'), '{}');
  await deterministicArchive(directory, archive);
  const bytes = await readFile(archive);
  for (const [name, mode] of [
    ['usr', 0o700],
    ['usr/local', 0o750],
    ['usr/local/data.json', 0o600],
    [requiredGuestBinaries[0], 0o744],
    [requiredGuestExecutables[2], 0o644],
  ])
    assert.throws(() => auditGuestArchive(changeTarMode(bytes, name, mode)), /payload permissions/);
});
test('guest and template-style archives are identical and agent-accessible under umask 077 and 022', async (t) => {
  const directory = await mkdtemp(path.join(os.tmpdir(), 'wsl-payload-umask-'));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const moduleUrl = new URL('./payload-lib.mjs', import.meta.url).href;
  const script = `import {mkdir,writeFile,symlink} from 'node:fs/promises';import path from 'node:path';import {deterministicArchive} from ${JSON.stringify(moduleUrl)};process.umask(parseInt(process.argv[3],8));const root=process.argv[1];await mkdir(path.join(root,'usr/local/bin'),{recursive:true});await mkdir(path.join(root,'node_modules/tool/bin'),{recursive:true});await writeFile(path.join(root,'usr/local/bin/tool'),${JSON.stringify('#!/bin/sh\nexit 0\n')},{mode:0o755});await writeFile(path.join(root,'node_modules/tool/bin/cli'),${JSON.stringify('#!/bin/sh\nexit 0\n')},{mode:0o755});await writeFile(path.join(root,'node_modules/tool/package.json'),'{}');await symlink('tool/bin/cli',path.join(root,'node_modules/tool-link'));await deterministicArchive(root,process.argv[2]);`;
  for (const mask of ['077', '022'])
    execFileSync(process.execPath, [
      '--input-type=module',
      '-e',
      script,
      path.join(directory, mask),
      path.join(directory, mask + '.tar.gz'),
      mask,
    ]);
  const a = await readFile(path.join(directory, '077.tar.gz')),
    b = await readFile(path.join(directory, '022.tar.gz'));
  const extracted = path.join(directory, 'extracted');
  await mkdir(extracted);
  execFileSync('/usr/bin/tar', ['-xzpf', path.join(directory, '077.tar.gz'), '-C', extracted]);
  execFileSync(path.join(extracted, 'usr/local/bin/tool'));
  execFileSync(path.join(extracted, 'node_modules/tool-link'));
  assert.equal(await readFile(path.join(extracted, 'node_modules/tool/package.json'), 'utf8'), '{}');
  assert.deepEqual(a, b);
  for (const entry of inspectTar(a))
    assert.equal(
      entry.mode,
      entry.type === '5' ? 0o755 : entry.type === '2' ? 0o777 : entry.name.endsWith('/cli') || entry.name.endsWith('/tool') ? 0o755 : 0o644,
    );
  assert.equal((await lstat(path.join(directory, '077.tar.gz'))).mode & 0o777, 0o644);
});

test('staging normalization fixes guest directories and data without following links outside the payload', async (t) => {
  const directory = await fixture(t);
  const outside = path.join(os.tmpdir(), path.basename(directory) + '-outside');
  await writeFile(outside, 'private', { mode: 0o600 });
  t.after(() => rm(outside, { force: true }));
  await symlink(outside, path.join(directory, 'outside-link'));
  await chmod(path.join(directory, 'usr'), 0o700);
  await writeFile(path.join(directory, 'usr/data'), '{}', { mode: 0o600 });
  await normalizePayloadPermissions(directory);
  assert.equal((await lstat(path.join(directory, 'usr'))).mode & 0o777, 0o755);
  assert.equal((await lstat(path.join(directory, 'usr/data'))).mode & 0o777, 0o644);
  assert.equal((await lstat(outside)).mode & 0o777, 0o600);
  await auditGuestDirectory(directory);
});
