import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { existsSync, lstatSync, readFileSync, readdirSync } from 'node:fs';
import path from 'node:path';
import process from 'node:process';
import { fileURLToPath } from 'node:url';

const template = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../templates/standard-app');

export function checkTemplateDependencies(directory = template) {
  const read = (file) => JSON.parse(readFileSync(path.join(directory, file), 'utf8'));
  const manifest = read('package.json');
  const lock = read('package-lock.json');
  const installed = read('node_modules/.package-lock.json');
  assert.equal(lock.lockfileVersion, 3, 'Unsupported template lockfile');
  assert.equal(installed.lockfileVersion, 3, 'Unsupported installed dependency receipt');
  for (const field of ['dependencies', 'devDependencies', 'optionalDependencies']) {
    assert.deepEqual(manifest[field] ?? {}, lock.packages[''][field] ?? {}, `Template manifest/lock mismatch: ${field}`);
  }
  const actual = new Map();
  function inspect(location) {
    assert.ok(lstatSync(path.join(directory, location)).isDirectory(), `Non-directory dependency: ${location}`);
    for (const entry of readdirSync(path.join(directory, location))) {
      if (entry.startsWith('.')) continue;
      const packagePath = `${location}/${entry}`;
      if (entry.startsWith('@')) {
        inspect(packagePath);
        continue;
      }
      assert.ok(lstatSync(path.join(directory, packagePath)).isDirectory(), `Non-directory dependency: ${packagePath}`);
      actual.set(packagePath, read(`${packagePath}/package.json`));
      if (existsSync(path.join(directory, packagePath, 'node_modules'))) inspect(`${packagePath}/node_modules`);
    }
  }
  inspect('node_modules');
  for (const [location, expected] of Object.entries(lock.packages)) {
    if (!location) continue;
    if (!actual.has(location)) assert.equal(expected.optional, true, `Missing locked dependency: ${location}`);
  }
  for (const [location, current] of actual) {
    const expected = lock.packages[location];
    assert.ok(expected, `Unrecorded installed dependency: ${location}`);
    const receipt = installed.packages[location];
    assert.ok(receipt, `Missing installed dependency receipt: ${location}`);
    for (const field of ['version', 'resolved', 'integrity']) {
      assert.equal(receipt[field], expected[field], `Installed lock mismatch: ${location} ${field}`);
    }
    assert.equal(current.version, expected.version, `Installed version mismatch: ${location}`);
  }
  for (const location of Object.keys(installed.packages)) {
    assert.ok(actual.has(location) && lock.packages[location], `Stale installed dependency receipt: ${location}`);
  }
  return actual.size;
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try {
    assert.equal(process.argv.length, 2, 'Usage: node scripts/check-e2e-deps.mjs');
    const count = checkTemplateDependencies();
    execFileSync(
      process.execPath,
      [
        '--import',
        'tsx',
        '--input-type=module',
        '-e',
        'import { transformSync } from "esbuild"; transformSync("const value: number = 1", { loader: "ts" });',
      ],
      { cwd: template, stdio: 'pipe' },
    );
    process.stdout.write(
      `Template dependency preflight passed: ${count} installed packages match the lockfile; tsx/esbuild load successfully.\n`,
    );
  } catch (error) {
    process.stderr.write(
      `Template dependency preflight failed: ${error.message}\nRun pnpm test:e2e:prepare explicitly; no installation was attempted.\n`,
    );
    process.exitCode = 1;
  }
}
