import assert from 'node:assert/strict';
import { Buffer } from 'node:buffer';
import { execFileSync, spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import process from 'node:process';
import { test } from 'node:test';
import { fileURLToPath, URL } from 'node:url';
import { ESLint } from 'eslint';
import { checkFrozenInputs, checkFrozenProvenance, frozenInputs } from './check-frozen.mjs';

const root = fileURLToPath(new URL('../', import.meta.url));
const original = new Map(
  frozenInputs.map((input) => [input.path, execFileSync('git', ['show', `${input.commit}:${input.path}`], { cwd: root })]),
);
function fixture(t) {
  const directory = mkdtempSync(path.join(tmpdir(), 'wsl-frozen-'));
  t.after(() => rmSync(directory, { recursive: true, force: true }));
  for (const [file, bytes] of original) {
    mkdirSync(path.dirname(path.join(directory, file)), { recursive: true });
    writeFileSync(path.join(directory, file), bytes);
  }
  return directory;
}

test('pinned provenance and the complete original inventory pass without modifying inputs', (t) => {
  const directory = fixture(t);
  assert.equal(frozenInputs.length, 14);
  assert.equal(checkFrozenProvenance(), 14);
  assert.equal(checkFrozenInputs(directory), 14);
  for (const [file, bytes] of original) assert.deepEqual(readFileSync(path.join(directory, file)), bytes);
});

for (const input of frozenInputs) {
  test(`a one-byte change is rejected without repair: ${input.path}`, (t) => {
    const directory = fixture(t);
    const changed = Buffer.from(original.get(input.path));
    changed[0] ^= 1;
    writeFileSync(path.join(directory, input.path), changed);
    assert.throws(() => checkFrozenInputs(directory), /Frozen input changed/);
    assert.deepEqual(readFileSync(path.join(directory, input.path)), changed);
  });
}

for (const kind of ['missing', 'symlink', 'directory', 'extra']) {
  test(`rejects a ${kind} frozen input`, (t) => {
    const directory = fixture(t);
    const file = path.join(directory, 'tests/vertical-slice/cdp.ts');
    if (kind === 'extra') writeFileSync(path.join(directory, 'tests/vertical-slice/new.ts'), 'export {};');
    else {
      rmSync(file);
      if (kind === 'symlink') symlinkSync(path.join(root, 'tests/vertical-slice/cdp.ts'), file);
      if (kind === 'directory') mkdirSync(file);
    }
    assert.throws(() => checkFrozenInputs(directory));
  });
}

test('re-hashing changed bytes cannot silently replace the pinned Git baseline', () => {
  const changed = frozenInputs.map((input) => ({ ...input }));
  changed[0].sha256 = createHash('sha256').update('changed input').digest('hex');
  assert.throws(() => checkFrozenProvenance(changed), /Pinned source digest mismatch/);
});

test('rejects duplicate, unsafe and malformed inventory entries', (t) => {
  const directory = fixture(t);
  for (const entries of [
    [],
    [...frozenInputs, frozenInputs[0]],
    [{ ...frozenInputs[0], path: '../outside' }],
    [{ ...frozenInputs[0], sha256: 'invalid' }],
    [{ ...frozenInputs[0], commit: 'HEAD' }],
  ])
    assert.throws(() => checkFrozenInputs(directory, entries));
});

test('style exceptions are exact and other lint rules stay active', async () => {
  const eslint = new ESLint({ cwd: root });
  const frozen = await eslint.calculateConfigForFile('tests/vertical-slice/cdp.ts');
  const adjacent = await eslint.calculateConfigForFile('tests/vertical-slice/contracts.ts');
  assert.equal(frozen.rules['prefer-const'][0], 0);
  assert.equal(adjacent.rules['prefer-const'][0], 2);
  assert.equal(frozen.rules['@typescript-eslint/no-unused-vars'][0], 2);
  const [renderer] = await eslint.lintText("import fs from 'node:fs'; export const unsafe = fs;", {
    filePath: 'apps/desktop/src/renderer/frozen-negative.ts',
  });
  assert.ok(renderer.messages.some((message) => message.ruleId === 'no-restricted-imports'));
  const ignores = readFileSync(path.join(root, '.prettierignore'), 'utf8').split('\n');
  for (const input of frozenInputs) assert.ok(ignores.includes('/' + input.path) || ignores.includes(input.path), input.path);
  assert.ok(!ignores.some((entry) => /^(?:\/)?(?:tests|fixtures)\/vertical-slice(?:\/?|\/\*.*)$/.test(entry)));
});

test('CLI checks the repository and offers no refresh-from-working-tree mode', () => {
  const command = path.join(root, 'scripts/check-frozen.mjs');
  const passed = spawnSync(process.execPath, [command], { cwd: root, encoding: 'utf8' });
  assert.equal(passed.status, 0, passed.stderr);
  assert.match(passed.stdout, /14 frozen inputs/);
  const refresh = spawnSync(process.execPath, [command, '--update'], { cwd: root, encoding: 'utf8' });
  assert.equal(refresh.status, 1);
  assert.match(refresh.stderr, /does not update/);
});
