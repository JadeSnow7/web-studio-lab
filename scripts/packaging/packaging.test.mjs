/* global Buffer, Response */
import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, writeFile, readFile, rm, symlink, readdir, realpath } from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import { createRequire } from 'node:module';
import { gzipSync, gunzipSync } from 'node:zlib';
import { digest, verifyBytes, download, inspectTar, deterministicArchive } from './payload-lib.mjs';
import { requireReleaseCredentials, verifyPayloads, auditService } from './release-gates.mjs';

async function temporary(t) {
  const dir = await mkdtemp(path.join(os.tmpdir(), 'wsl-packaging-'));
  t.after(() => rm(dir, { recursive: true, force: true }));
  return dir;
}
function renameTarEntry(archive, name, offset = 0) {
  const all = gunzipSync(archive);
  const tar = all.subarray(offset);
  tar.fill(0, 0, 100);
  tar.write(name, 0, 100);
  tar.fill(32, 148, 156);
  const checksum = tar.subarray(0, 512).reduce((sum, byte) => sum + byte, 0);
  tar.write(checksum.toString(8).padStart(6, '0') + '\0 ', 148, 8);
  return gzipSync(all);
}
test('download refuses hash and registry-integrity mismatch', () => {
  const bytes = Buffer.from('vendor bytes');
  assert.throws(() => verifyBytes(bytes, { id: 'python', sha256: '0'.repeat(64) }), /SHA-256 mismatch/);
  assert.throws(() => verifyBytes(bytes, { id: 'npm', sha256: digest(bytes), integrity: 'sha512-YQ==' }), /Registry integrity mismatch/);
});
test('interrupted and corrupt downloads never publish a cache hit', async (t) => {
  const dir = await temporary(t);
  const source = { id: 'node', url: 'https://vendor.invalid/node.tar.gz', sha256: digest(Buffer.from('expected')) };
  t.mock.method(globalThis, 'fetch', async () => new Response('wrong'));
  await assert.rejects(download(source, dir), /SHA-256 mismatch/);
  assert.deepEqual(await readdir(dir), []);
  t.mock.method(
    globalThis,
    'fetch',
    async () =>
      new Response(
        new globalThis.ReadableStream({
          start(controller) {
            controller.error(new Error('connection interrupted'));
          },
        }),
      ),
  );
  await assert.rejects(download(source, dir), /connection interrupted/);
  assert.deepEqual(await readdir(dir), []);
  await writeFile(path.join(dir, 'node.tar.gz'), 'wrong');
  await assert.rejects(download(source, dir), /SHA-256 mismatch/);
});
test('safe archive validation rejects parent and absolute traversal', async (t) => {
  const dir = await temporary(t);
  const source = path.join(dir, 'source');
  await mkdir(source);
  await writeFile(path.join(source, 'file'), 'payload');
  const archive = path.join(dir, 'safe.tar.gz');
  await deterministicArchive(source, archive);
  const bytes = await readFile(archive);
  assert.equal(inspectTar(bytes)[0].name, 'file');
  assert.throws(() => inspectTar(renameTarEntry(bytes, '../outside')), /Unsafe archive path/);
  assert.throws(() => inspectTar(renameTarEntry(bytes, '/absolute')), /Unsafe archive path/);
});
test('safe archive validation rejects escaping symlink', async (t) => {
  const dir = await temporary(t);
  const source = path.join(dir, 'source');
  await mkdir(source);
  await symlink('../../outside', path.join(source, 'link'));
  const archive = path.join(dir, 'bad.tar.gz');
  await deterministicArchive(source, archive);
  const bytes = await readFile(archive);
  assert.throws(() => inspectTar(bytes), /Unsafe archive path/);
});
test('archives are byte reproducible including links and executable modes', async (t) => {
  const dir = await temporary(t);
  const source = path.join(dir, 'source');
  await mkdir(source);
  await writeFile(path.join(source, 'node'), 'node', { mode: 0o755 });
  await symlink('node', path.join(source, 'node-link'));
  await deterministicArchive(source, path.join(dir, 'a.tar.gz'));
  await deterministicArchive(source, path.join(dir, 'b.tar.gz'));
  assert.equal(digest(await readFile(path.join(dir, 'a.tar.gz'))), digest(await readFile(path.join(dir, 'b.tar.gz'))));
  assert.equal(inspectTar(await readFile(path.join(dir, 'a.tar.gz')))[1].link, 'node');
});
test('release rejects missing/development signing and incomplete notarization', () => {
  assert.throws(() => requireReleaseCredentials({}, ''), /Developer ID Application/);
  assert.throws(
    () => requireReleaseCredentials({ CSC_NAME: 'Apple Development: Person' }, '"Apple Development: Person"'),
    /Developer ID Application/,
  );
  const env = { CSC_NAME: 'Developer ID Application: Team (TEAMID)' };
  assert.throws(() => requireReleaseCredentials(env, ''), /unavailable/);
  assert.throws(() => requireReleaseCredentials(env, '"' + env.CSC_NAME + '"'), /notarization credentials/);
  assert.doesNotThrow(() =>
    requireReleaseCredentials({ ...env, APPLE_KEYCHAIN: '/build/keychain', APPLE_KEYCHAIN_PROFILE: 'release' }, '"' + env.CSC_NAME + '"'),
  );
});
test('payload gate rejects an absent manifest', async (t) => {
  await assert.rejects(verifyPayloads(await temporary(t)), /ENOENT/);
});
test('service audit rejects unbundled required assets while accepting optional accelerators', async (t) => {
  const dir = await temporary(t);
  const service = path.join(dir, 'service.cjs');
  await writeFile(
    service,
    '/* ssh2 SFTP */ require("node:fs"); require("cpu-features"); require("./crypto/build/Release/sshcrypto.node");',
  );
  assert.equal((await auditService(service)).optionalNativeModules.length, 2);
  await writeFile(service, '/* ssh2 SFTP */ require("ssh2");');
  await assert.rejects(auditService(service), /unbundled required assets: ssh2/);
});

test('notarization failure does not leak secret-bearing exec argv', async () => {
  const { submitNotarization } = await import('./release-gates.mjs');
  const secret = 'TOP-SECRET-PASSWORD';
  assert.throws(
    () =>
      submitNotarization('/release.dmg', { APPLE_ID: 'user', APPLE_APP_SPECIFIC_PASSWORD: secret, APPLE_TEAM_ID: 'team' }, () => {
        throw new Error('Command failed: xcrun --password ' + secret);
      }),
    (error) => !String(error.stack).includes(secret) && error.message.includes('Notarization submission failed'),
  );
});

test('safe archive validation rejects writes through a symlink', async (t) => {
  const dir = await temporary(t);
  const source = path.join(dir, 'source');
  await mkdir(source);
  await symlink('target', path.join(source, 'link'));
  await writeFile(path.join(source, 'zfile'), 'payload');
  const archive = path.join(dir, 'bad.tar.gz');
  await deterministicArchive(source, archive);
  const bytes = await readFile(archive);
  assert.throws(() => inspectTar(renameTarEntry(bytes, 'link/file', 512)), /writes through link/);
});

test('payload gate rejects a changed source version and corrupted payload bytes', async (t) => {
  const { root } = await import('./payload-lib.mjs');
  const dir = await temporary(t);
  const lock = JSON.parse(await readFile(path.join(root, 'packaging/dependencies.lock.json'), 'utf8'));
  const pythonSource = lock.sources.find((source) => source.id === 'python');
  const pythonBytes = Buffer.from('python executable');
  const guestBytes = Buffer.from('guest archive');
  await mkdir(path.join(dir, 'python/bin'), { recursive: true });
  await writeFile(path.join(dir, 'python/bin/python3'), pythonBytes);
  await writeFile(path.join(dir, 'guest-tools.tar.gz'), guestBytes);
  const manifest = {
    schemaVersion: 1,
    platform: 'darwin-arm64',
    baseImage: lock.baseImage.reference,
    python: {
      path: 'python/bin/python3',
      executable: 'python/bin/python3',
      expandedBytes: 100,
      sha256: digest(pythonBytes),
      archiveSha256: pythonSource.sha256,
      version: pythonSource.version,
    },
    guest: {
      path: 'guest-tools.tar.gz',
      expandedBytes: 100,
      sha256: digest(guestBytes),
      node: 'latest',
      pnpm: '10.34.6',
      codex: '0.160.0',
    },
  };
  const file = path.join(dir, 'dependencies.json');
  await writeFile(file, JSON.stringify(manifest));
  await assert.rejects(verifyPayloads(dir), /Guest tools do not match source lock/);
  manifest.guest.node = '24.21.0';
  await writeFile(file, JSON.stringify(manifest));
  await writeFile(path.join(dir, 'guest-tools.tar.gz'), 'tampered');
  await assert.rejects(verifyPayloads(dir), /Missing or corrupt prepared payload/);
});

test('release documents are required and nonempty before artifact publication', async (t) => {
  const { readReleaseDocuments } = await import('./release-attachments.mjs');
  const dir = await temporary(t);
  await mkdir(path.join(dir, 'docs/development'), { recursive: true });
  await writeFile(path.join(dir, 'docs/development/competition-installer.md'), '安装说明');
  await assert.rejects(readReleaseDocuments(dir), /RESULTS.md/);
  await mkdir(path.join(dir, 'docs/acceptance/installer-20261009'), { recursive: true });
  await writeFile(path.join(dir, 'docs/acceptance/installer-20261009/RESULTS.md'), ' \n');
  await assert.rejects(readReleaseDocuments(dir), /Release document is empty/);
});
test('release attachments preserve Chinese documents and signed App manifests byte for byte', async (t) => {
  const { copyReleaseAttachments } = await import('./release-attachments.mjs');
  const dir = await temporary(t);
  await mkdir(path.join(dir, 'docs/development'), { recursive: true });
  await mkdir(path.join(dir, 'docs/acceptance/installer-20261009'), { recursive: true });
  await writeFile(path.join(dir, 'docs/development/competition-installer.md'), '安装说明：依赖需要首次联网。\n');
  await writeFile(path.join(dir, 'docs/acceptance/installer-20261009/RESULTS.md'), '验收状态：undetermined。\n');
  const resources = path.join(dir, 'signed-resources');
  await mkdir(resources);
  for (const name of ['dependencies.json', 'dependency-sources.json', 'THIRD-PARTY-NOTICES.md', 'LICENSE'])
    await writeFile(path.join(resources, name), name + '\n');
  const artifacts = path.join(dir, 'artifacts');
  await copyReleaseAttachments(resources, artifacts, dir);
  assert.equal(await readFile(path.join(artifacts, 'INSTALLATION.zh-CN.md'), 'utf8'), '安装说明：依赖需要首次联网。\n');
  assert.equal(await readFile(path.join(artifacts, 'ACCEPTANCE.md'), 'utf8'), '验收状态：undetermined。\n');
  for (const name of ['dependencies.json', 'dependency-sources.json', 'THIRD-PARTY-NOTICES.md', 'LICENSE'])
    assert.deepEqual(await readFile(path.join(artifacts, name)), await readFile(path.join(resources, name)));
});

test('formal builder selector removes only the Developer ID prefix and preserves full signing identity', async () => {
  const { builderSigningSelector } = await import('./release-gates.mjs');
  const env = {
    CSC_NAME: 'Developer ID Application: Aodong Hu (6429YPLDYU)',
    APPLE_KEYCHAIN: '/build/keychain',
    APPLE_KEYCHAIN_PROFILE: 'release',
  };
  requireReleaseCredentials(env, '"' + env.CSC_NAME + '"');
  assert.equal(builderSigningSelector(env.CSC_NAME), 'Aodong Hu (6429YPLDYU)');
  assert.equal(env.CSC_NAME, 'Developer ID Application: Aodong Hu (6429YPLDYU)');
  assert.throws(() => builderSigningSelector('Apple Development: Aodong Hu (6429YPLDYU)'), /full Developer ID Application identity/);
  assert.throws(() => builderSigningSelector('Developer ID Application: '), /empty certificate name/);
});
test('installed electron-builder selects the same Developer ID certificate with the sanitized qualifier', async (t) => {
  const { root } = await import('./payload-lib.mjs');
  const { builderSigningSelector } = await import('./release-gates.mjs');
  const require = createRequire(await realpath(path.join(root, 'apps/desktop/node_modules/electron-builder/package.json')));
  const builder = require('app-builder-lib/out/codeSign/macCodeSign.js');
  const previous = builder.findIdentityRawResult;
  t.after(() => {
    builder.findIdentityRawResult = previous;
  });
  const full = 'Developer ID Application: Aodong Hu (6429YPLDYU)';
  const hash = '1'.repeat(40);
  // Supply the discovery result in memory; this test never queries or modifies the keychain.
  builder.findIdentityRawResult = Promise.resolve([
    '2'.repeat(40) + ' "Apple Development: Aodong Hu (6429YPLDYU)"',
    hash + ' "' + full + '"',
  ]);
  assert.throws(() => builder.findIdentity('Developer ID Application', full), /Please remove prefix/);
  const identity = await builder.findIdentity('Developer ID Application', builderSigningSelector(full));
  assert.equal(identity.name, full);
  assert.equal(identity.hash, hash);
});
