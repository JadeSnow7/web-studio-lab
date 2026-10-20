import { Buffer } from 'node:buffer';
import process from 'node:process';
import { spawnSync } from 'node:child_process';
import { URL } from 'node:url';
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, writeFile, readFile, rm, symlink, unlink, realpath, mkdir } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { collectAssets, copyValidatedAssets } from './build-mota-editor.mjs';
test('deterministic build inventory, anchored same-byte copy, tamper and link rejection', async () => {
  const root = await mkdtemp(path.join(await realpath(tmpdir()), 'mota-build-'));
  const destination = root + '-out';
  try {
    for (const name of ['index.html', 'editor.js', 'editor.css', 'LICENSES.txt']) await writeFile(path.join(root, name), name);
    const expected = await collectAssets(root);
    assert.deepEqual(await collectAssets(root), expected);
    await copyValidatedAssets(root, destination, expected);
    for (const file of expected.files)
      assert.equal(Buffer.compare(await readFile(path.join(root, file.path)), await readFile(path.join(destination, file.path))), 0);
    await writeFile(path.join(root, 'editor.js'), 'tampered');
    await assert.rejects(copyValidatedAssets(root, destination, expected), /changed/);
    await unlink(path.join(root, 'editor.js'));
    await symlink(path.join(root, 'index.html'), path.join(root, 'editor.js'));
    await assert.rejects(collectAssets(root), /regular/);
  } finally {
    await rm(root, { recursive: true, force: true });
    await rm(destination, { recursive: true, force: true });
  }
});
test('actual Main config fails without prebuild and rejects staging drift at closeBundle', async () => {
  const root = await mkdtemp(path.join(await realpath(tmpdir()), 'mota-config-'));
  const desktop = path.join(root, 'apps/desktop');
  const staged = path.join(root, '.local/build/mota-editor');
  const configUrl = new URL('../apps/desktop/electron.vite.config.ts', import.meta.url).href;
  const run = (suffix) =>
    spawnSync(
      process.execPath,
      [
        '--experimental-strip-types',
        '--input-type=module',
        '-e',
        `const config=(await import(${JSON.stringify(configUrl)})).default;${suffix}`,
      ],
      { cwd: desktop, encoding: 'utf8' },
    );
  try {
    await mkdir(desktop, { recursive: true });
    assert.notEqual(run('').status, 0);
    await mkdir(staged, { recursive: true });
    for (const name of ['index.html', 'editor.js', 'editor.css', 'LICENSES.txt']) await writeFile(path.join(staged, name), name);
    const manifest = await collectAssets(staged);
    await writeFile(path.join(root, '.local/build/mota-editor-manifest.json'), JSON.stringify(manifest));
    const copied = run('config.main.plugins[0].closeBundle();');
    assert.equal(copied.status, 0, copied.stderr);
    assert.equal(await readFile(path.join(desktop, 'out/main/mota-editor/editor.js'), 'utf8'), 'editor.js');
    const drifted = run(
      `await (await import('node:fs/promises')).writeFile(${JSON.stringify(path.join(staged, 'editor.js'))},'tampered');config.main.plugins[0].closeBundle();`,
    );
    assert.notEqual(drifted.status, 0);
    assert.match(drifted.stderr, /integrity failed/);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
test('desktop entrypoints prebuild before electron-vite; Main anchors before closeBundle copy', async () => {
  const scripts = JSON.parse(await readFile(new URL('../apps/desktop/package.json', import.meta.url))).scripts;
  for (const name of ['dev', 'build', 'package'])
    assert.ok(scripts[name].indexOf('build-mota-editor.mjs') < scripts[name].indexOf('electron-vite'));
  const config = await readFile(new URL('../apps/desktop/electron.vite.config.ts', import.meta.url), 'utf8');
  assert.ok(config.indexOf('readFileSync(resolve') < config.indexOf('closeBundle'));
  assert.match(config, /__MOTA_EDITOR_MANIFEST__/);
  assert.match(config, /stagedBytes\(\)/);
  assert.match(config, /'mota-editor': resolve\('src\/preload\/mota-editor.ts'\)/);
});
