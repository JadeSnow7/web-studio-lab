import assert from 'node:assert/strict';
import { mkdtemp, mkdir, readFile, rm, stat, symlink, unlink, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { test } from 'node:test';
import { plan, requireMountedVolume, setup, verify } from './external-builds.mjs';

async function fixture(t) {
  const temporary = await mkdtemp(path.join(os.tmpdir(), 'wsl-external-builds-'));
  t.after(() => rm(temporary, { recursive: true, force: true }));
  const checkout = path.join(temporary, 'checkout');
  const destination = path.join(temporary, 'artifacts');
  await mkdir(checkout);
  return { checkout, destination, temporary };
}

test('setup preserves paths, writes through external links and remains idempotent', async (t) => {
  const { checkout, destination } = await fixture(t);
  const entries = await setup(checkout, destination);
  await setup(checkout, destination);
  await verify(checkout, destination);
  assert.equal(entries.length, 6);
  for (const { source, target } of entries) {
    await writeFile(path.join(source, 'artifact'), 'external artifact');
    assert.equal(await readFile(path.join(target, 'artifact'), 'utf8'), 'external artifact');
  }
});

test('existing artifacts reject setup before any directory is linked', async (t) => {
  const { checkout, destination } = await fixture(t);
  const entries = await plan(checkout, destination);
  await mkdir(entries[5].source, { recursive: true });
  await writeFile(path.join(entries[5].source, 'keep'), 'original');
  await assert.rejects(setup(checkout, destination), /Preserve and migrate/);
  await assert.rejects(stat(entries[0].source), { code: 'ENOENT' });
  assert.equal(await readFile(path.join(entries[5].source, 'keep'), 'utf8'), 'original');
});

test('verification rejects missing external directories and replaced links', async (t) => {
  const { checkout, destination } = await fixture(t);
  const entries = await setup(checkout, destination);
  await rm(entries[0].target, { recursive: true });
  await assert.rejects(verify(checkout, destination), { code: 'ENOENT' });
  await mkdir(entries[0].target);
  await unlink(entries[0].source);
  await mkdir(entries[0].source);
  await assert.rejects(verify(checkout, destination), /must be a symlink/);
});

test('checkout identity follows physical paths and isolates separate checkouts', async (t) => {
  const { checkout, destination, temporary } = await fixture(t);
  const other = path.join(temporary, 'other');
  await mkdir(other);
  const alias = path.join(temporary, 'alias');
  await symlink(checkout, alias);
  assert.deepEqual(await plan(checkout, destination), await plan(alias, destination));
  assert.notEqual((await plan(checkout, destination))[0].target, (await plan(other, destination))[0].target);
});

test('a normal directory cannot stand in for a mounted external volume', async (t) => {
  const { temporary } = await fixture(t);
  const mount = path.join(temporary, 'unmounted');
  await assert.rejects(requireMountedVolume(mount), { code: 'ENOENT' });
  await mkdir(mount);
  await assert.rejects(requireMountedVolume(mount), /not mounted/);
});

test('invalid opt-in config is rejected before setup changes artifacts', async (t) => {
  const { checkout, destination } = await fixture(t);
  await mkdir(path.join(checkout, '.local'));
  await writeFile(path.join(checkout, '.local/external-builds.json'), '{"schemaVersion":2}');
  await assert.rejects(setup(checkout, destination), /Invalid/);
  await assert.rejects(stat(destination), { code: 'ENOENT' });
});
