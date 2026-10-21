import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { lstatSync, readFileSync, readdirSync } from 'node:fs';
import path from 'node:path';
import process from 'node:process';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const manifest = JSON.parse(readFileSync(path.join(root, 'scripts/frozen-inputs.json'), 'utf8'));
assert.equal(manifest.schemaVersion, 1);
export const frozenInputs = manifest.sources.flatMap(({ commit, files }) =>
  Object.entries(files).map(([path, sha256]) => ({ path, sha256, commit })),
);
const directories = ['fixtures/vertical-slice', 'tests/vertical-slice'];

function validateInventory(inputs) {
  assert.ok(Array.isArray(inputs) && inputs.length > 0, 'Missing frozen inventory');
  const paths = new Set();
  for (const input of inputs) {
    assert.ok(typeof input.path === 'string' && !path.isAbsolute(input.path) && !input.path.includes('\\'), 'Unsafe frozen path');
    assert.ok(
      input.path.split('/').every((part) => part && part !== '.' && part !== '..'),
      'Unsafe frozen path',
    );
    assert.match(input.sha256, /^[a-f0-9]{64}$/);
    assert.match(input.commit, /^[a-f0-9]{40}$/);
    assert.ok(!paths.has(input.path), `Duplicate frozen input: ${input.path}`);
    paths.add(input.path);
  }
}

export function checkFrozenProvenance(inputs = frozenInputs) {
  validateInventory(inputs);
  const baseline = inputs.find((input) => input.path === 'docs/acceptance/VS001.md');
  assert.ok(baseline, 'Missing pinned VS001 source');
  const expected = execFileSync(
    'git',
    [
      'ls-tree',
      '-r',
      '--name-only',
      baseline.commit,
      '--',
      'docs/acceptance/VS001.md',
      'package-lock.json',
      'tsconfig.json',
      ...directories,
    ],
    { cwd: root, encoding: 'utf8' },
  )
    .trim()
    .split('\n');
  expected.push('docs/acceptance/consolidation-20261011/closeout-20261014.md');
  assert.deepEqual(inputs.map((input) => input.path).sort(), expected.sort(), 'Incomplete pinned inventory');
  for (const input of inputs) {
    const bytes = execFileSync('git', ['show', `${input.commit}:${input.path}`], { cwd: root });
    assert.equal(createHash('sha256').update(bytes).digest('hex'), input.sha256, `Pinned source digest mismatch: ${input.path}`);
  }
  return inputs.length;
}

export function checkFrozenInputs(directory = root, inputs = frozenInputs) {
  validateInventory(inputs);
  for (const input of inputs) {
    const parts = input.path.split('/');
    for (let index = 1; index < parts.length; index++) {
      assert.ok(lstatSync(path.join(directory, ...parts.slice(0, index))).isDirectory(), `Non-directory frozen parent: ${input.path}`);
    }
    const file = path.join(directory, input.path);
    assert.ok(lstatSync(file).isFile(), `Non-file frozen input: ${input.path}`);
    assert.equal(createHash('sha256').update(readFileSync(file)).digest('hex'), input.sha256, `Frozen input changed: ${input.path}`);
  }
  function inventory(relative) {
    return readdirSync(path.join(directory, relative), { withFileTypes: true }).flatMap((entry) => {
      const file = `${relative}/${entry.name}`;
      if (entry.isDirectory()) return inventory(file);
      assert.ok(entry.isFile(), `Non-file frozen input: ${file}`);
      return [file];
    });
  }
  for (const prefix of directories) {
    assert.deepEqual(
      inventory(prefix).sort(),
      inputs
        .filter((input) => input.path.startsWith(prefix + '/'))
        .map((input) => input.path)
        .sort(),
      `Frozen directory inventory changed: ${prefix}`,
    );
  }
  return inputs.length;
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try {
    assert.equal(process.argv.length, 2, 'Usage: node scripts/check-frozen.mjs; this check does not update expected hashes');
    checkFrozenProvenance();
    process.stdout.write(`Frozen input gate passed: ${checkFrozenInputs()} frozen inputs match pinned Git sources and SHA-256 digests.\n`);
  } catch (error) {
    process.stderr.write(`Frozen input gate failed: ${error.message}\n`);
    process.exitCode = 1;
  }
}
