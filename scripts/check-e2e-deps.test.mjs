import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { test } from 'node:test';
import { checkTemplateDependencies } from './check-e2e-deps.mjs';

function json(directory, file, value) {
  mkdirSync(path.dirname(path.join(directory, file)), { recursive: true });
  writeFileSync(path.join(directory, file), JSON.stringify(value));
}
function fixture(t) {
  const directory = mkdtempSync(path.join(tmpdir(), 'wsl-e2e-deps-'));
  t.after(() => rmSync(directory, { recursive: true, force: true }));
  const packages = {
    'node_modules/tsx': { version: '4.21.0', resolved: 'registry:tsx', integrity: 'sha512-fixture-tsx' },
    'node_modules/@fixture/tool': { version: '1.0.0', resolved: 'registry:tool', integrity: 'sha512-fixture-tool' },
    'node_modules/tsx/node_modules/transitive': {
      version: '2.0.0',
      resolved: 'registry:transitive',
      integrity: 'sha512-fixture-transitive',
    },
  };
  const dependencies = { tsx: '4.21.0', '@fixture/tool': '1.0.0' };
  json(directory, 'package.json', { version: '1.1.0', dependencies });
  json(directory, 'package-lock.json', {
    lockfileVersion: 3,
    packages: {
      '': { version: '1.0.0', dependencies },
      ...packages,
      'node_modules/optional-platform': { version: '1.0.0', optional: true },
    },
  });
  json(directory, 'node_modules/.package-lock.json', { lockfileVersion: 3, packages });
  for (const [location, entry] of Object.entries(packages)) json(directory, `${location}/package.json`, { version: entry.version });
  return directory;
}

test('validates the installed graph, including scoped and nested packages, while allowing absent optional packages', (t) => {
  assert.equal(checkTemplateDependencies(fixture(t)), 3);
});

for (const kind of [
  'missing-tree',
  'missing-receipt',
  'missing-package',
  'stale-receipt',
  'wrong-version',
  'extra-package',
  'manifest-drift',
  'lock-drift',
  'invalid-json',
]) {
  test(`rejects ${kind} without installing or repairing dependencies`, (t) => {
    const directory = fixture(t);
    const lock = readFileSync(path.join(directory, 'package-lock.json'));
    const installed = JSON.parse(readFileSync(path.join(directory, 'node_modules/.package-lock.json'), 'utf8'));
    if (kind === 'missing-tree') rmSync(path.join(directory, 'node_modules'), { recursive: true });
    if (kind === 'missing-receipt') rmSync(path.join(directory, 'node_modules/.package-lock.json'));
    if (kind === 'missing-package') rmSync(path.join(directory, 'node_modules/@fixture/tool'), { recursive: true });
    if (kind === 'stale-receipt') {
      installed.packages['node_modules/tsx'].integrity = 'sha512-other';
      json(directory, 'node_modules/.package-lock.json', installed);
    }
    if (kind === 'wrong-version') json(directory, 'node_modules/tsx/node_modules/transitive/package.json', { version: '3.0.0' });
    if (kind === 'extra-package') json(directory, 'node_modules/tsx/node_modules/shadow/package.json', { version: '1.0.0' });
    if (kind === 'manifest-drift') json(directory, 'package.json', { dependencies: { tsx: '4.22.0' } });
    if (kind === 'lock-drift') {
      const changed = JSON.parse(lock);
      changed.packages['node_modules/tsx/node_modules/transitive'].version = '3.0.0';
      json(directory, 'package-lock.json', changed);
    }
    if (kind === 'invalid-json') writeFileSync(path.join(directory, 'node_modules/.package-lock.json'), '{');
    const before = readFileSync(path.join(directory, 'package-lock.json'));
    assert.throws(() => checkTemplateDependencies(directory));
    assert.deepEqual(readFileSync(path.join(directory, 'package-lock.json')), before);
  });
}

test('tsx alone does not satisfy the full lockfile inventory', (t) => {
  const directory = fixture(t);
  const installed = JSON.parse(readFileSync(path.join(directory, 'node_modules/.package-lock.json'), 'utf8'));
  delete installed.packages['node_modules/@fixture/tool'];
  rmSync(path.join(directory, 'node_modules/@fixture/tool'), { recursive: true });
  json(directory, 'node_modules/.package-lock.json', installed);
  assert.throws(() => checkTemplateDependencies(directory), /Missing locked dependency/);
});
