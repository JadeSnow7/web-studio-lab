import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, writeFile, readFile, rm, symlink, realpath, lstat, stat } from 'node:fs/promises';
import { setTimeout as delay } from 'node:timers/promises';
import path from 'node:path';
import os from 'node:os';
import { createRequire } from 'node:module';
import { root } from './payload-lib.mjs';

// Use the installed builder's real matcher, walker, ASAR writer and sanity checker.
// No Electron download/signing is needed to reproduce which bytes enter app.asar.
const require = createRequire(await realpath(path.join(root, 'apps/desktop/node_modules/electron-builder/package.json')));
const { getMainFileMatchers } = require('app-builder-lib/out/fileMatcher.js');
const { computeFileSets } = require('app-builder-lib/out/util/appFileCopier.js');
const { AsarPackager } = require('app-builder-lib/out/asar/asarUtil.js');
const { checkFileInArchive } = require('app-builder-lib/out/asar/asarFileChecker.js');
const { dynamicImport } = require('app-builder-lib/out/util/dynamicImport.js');
const yaml = require('js-yaml');
// Offset/size values are the ASAR header's own declaration; data starts at 8 + headerSize.
function archiveDataEnd(header) {
  let end = 0n;
  const visit = (node) => {
    if (node.files) for (const child of Object.values(node.files)) visit(child);
    if (node.unpacked || node.offset === undefined || node.size === undefined) return;
    const endOf = BigInt(node.offset) + BigInt(node.size);
    if (endOf > end) end = endOf;
  };
  visit(header);
  return end;
}
const content = {
  'out/main/index.js': 'require("electron");\n',
  'out/preload/index.js': '/* isolated preload */\n',
  'out/renderer/index.html': '<html><body>renderer</body></html>\n',
  'out/renderer/assets/main.js': 'console.log("renderer");\n',
  'resources/branding/logo.svg': '<svg xmlns="http://www.w3.org/2000/svg"/>\n',
  'package.json': JSON.stringify({ name: 'packaging-fixture', version: '1.0.0', main: 'out/main/index.js' }),
};
async function archive(t, files) {
  const temporary = await mkdtemp(path.join(os.tmpdir(), 'wsl-external-output-asar-'));
  t.after(() => rm(temporary, { recursive: true, force: true }));
  const base = await realpath(temporary),
    appDir = path.join(base, 'app'),
    external = path.join(base, 'external-output');
  await mkdir(appDir);
  await mkdir(external);
  for (const [relative, value] of Object.entries(content)) {
    const file = relative.startsWith('out/') ? path.join(external, relative.slice(4)) : path.join(appDir, relative);
    await mkdir(path.dirname(file), { recursive: true });
    await writeFile(file, value);
  }
  await writeFile(path.join(base, 'outside-private.txt'), 'must not enter archive');
  await symlink(external, path.join(appDir, 'out'), 'dir');
  await symlink(path.join(base, 'outside-private.txt'), path.join(appDir, 'unapproved-link.txt'));
  const resourcePath = path.join(base, 'resources'),
    destination = path.join(resourcePath, 'app');
  await mkdir(resourcePath);
  const info = {
    config: { files },
    projectDir: appDir,
    buildResourcesDir: 'build',
    isPrepackedAppAsar: false,
    debugLogger: { isEnabled: false },
    getWorkspaceRoot: async () => appDir,
  };
  const packager = { info };
  const matchers = getMainFileMatchers(appDir, destination, (value) => value, {}, packager, path.join(appDir, 'release'), false);
  const fileSets = await computeFileSets(matchers, null, packager, false);
  const asarPath = path.join(resourcePath, 'app.asar');
  await new AsarPackager(packager, { resourcePath, defaultDestination: destination, options: { smartUnpack: false } }).pack(fileSets);
  // @electron/asar 3.4.1 streamFilesystem returns out.end() without awaiting stream close, so
  // pack() can resolve while tail bytes are still in flight; reads then return zero-padded data.
  // Fixed upstream in electron/asar 79686b6 (#414); wait (bounded) for the header-declared size.
  const api = await dynamicImport('@electron/asar');
  const { header, headerSize } = api.getRawHeader(asarPath);
  const expectedSize = 8 + headerSize + Number(archiveDataEnd(header));
  const deadline = Date.now() + 5000;
  let size;
  for (;;) {
    size = (await stat(asarPath)).size;
    if (size >= expectedSize) break;
    if (Date.now() > deadline) throw new Error(`archive not flushed: size ${size} < expected ${expectedSize} after 5000 ms`);
    await delay(10);
  }
  assert.equal(size, expectedSize, `archive oversized: size ${size} > expected ${expectedSize}`);
  assert.equal((await lstat(path.join(appDir, 'out'))).isSymbolicLink(), true, 'test must retain the external-output symlink');
  return { asar: asarPath, matchers };
}
test('old out glob reproduces installed builder missing the symlinked Main entry', async (t) => {
  const { asar } = await archive(t, ['out/**', 'resources/branding/**', 'package.json']);
  await assert.rejects(checkFileInArchive(asar, 'out/main/index.js', 'Application entry file'), /not found|does not exist/);
  await checkFileInArchive(asar, 'package.json', 'Package metadata');
});
test('release config explicitly packages external out bytes at their original ASAR paths', async (t) => {
  const config = yaml.load(await readFile(path.join(root, 'apps/desktop/electron-builder.yml'), 'utf8'));
  const { asar } = await archive(t, config.files);
  const api = await dynamicImport('@electron/asar');
  for (const [file, expected] of Object.entries(content)) {
    await checkFileInArchive(asar, file, 'Required packaged file');
    assert.equal(api.extractFile(asar, file).toString(), expected, file);
  }
  assert.throws(() => api.statFile(asar, 'outside-private.txt'), /not found|undefined/);
  assert.throws(() => api.statFile(asar, 'unapproved-link.txt'), /not found|undefined/);
  assert.equal(config.asar, true);
  assert.equal(config.forceCodeSigning, true);
  assert.equal(config.mac.hardenedRuntime, true);
  assert.equal(config.mac.entitlements, '../../packaging/app-entitlements.plist');
  assert.equal(config.mac.entitlementsInherit, '../../packaging/app-entitlements.plist');
  assert.equal(config.mac.notarize, true);
});
