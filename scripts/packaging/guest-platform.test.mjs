/* global Buffer */
import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, writeFile, readFile, rm, access } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { auditGuestArchive, auditGuestDirectory, prunePnpmForeignTargets, requiredGuestBinaries } from './guest-platform.mjs';
import { deterministicArchive, digest, root } from './payload-lib.mjs';
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
  }
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
