import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, writeFile, readFile, rm, symlink, realpath, lstat } from 'node:fs/promises';
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
  await new AsarPackager(packager, { resourcePath, defaultDestination: destination, options: { smartUnpack: false } }).pack(fileSets);
  assert.equal((await lstat(path.join(appDir, 'out'))).isSymbolicLink(), true, 'test must retain the external-output symlink');
  return { asar: path.join(resourcePath, 'app.asar'), matchers };
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
