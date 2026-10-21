import { createHash } from 'node:crypto';
import process from 'node:process';
import console from 'node:console';
import { readFile, writeFile, mkdir, readdir, lstat, copyFile } from 'node:fs/promises';
import { createRequire } from 'node:module';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
export const staging = path.join(root, '.local/build/mota-editor');
export const manifestPath = path.join(root, '.local/build/mota-editor-manifest.json');
const digest = (bytes) => createHash('sha256').update(bytes).digest('hex');
async function assertRealDirectory(directory) {
  let current = path.resolve(directory);
  while (true) {
    const info = await lstat(current);
    if (!info.isDirectory() || info.isSymbolicLink()) throw new Error('Editor directory contains a link');
    const parent = path.dirname(current);
    if (parent === current) return;
    current = parent;
  }
}
export async function collectAssets(directory) {
  await assertRealDirectory(directory);
  const files = [];
  for (const name of (await readdir(directory)).sort()) {
    if (!['index.html', 'editor.js', 'editor.css', 'LICENSES.txt'].includes(name)) throw new Error('Unknown editor asset: ' + name);
    const info = await lstat(path.join(directory, name));
    if (!info.isFile() || info.isSymbolicLink() || info.nlink !== 1) throw new Error('Editor assets must be regular unlinked files');
    const bytes = await readFile(path.join(directory, name));
    files.push({ path: name, length: bytes.length, sha256: digest(bytes) });
  }
  if (files.length !== 4) throw new Error('Incomplete editor staging');
  return { schemaVersion: 1, version: digest(JSON.stringify(files)), files };
}
export async function copyValidatedAssets(directory, destination, expected) {
  const actual = await collectAssets(directory);
  if (JSON.stringify(actual) !== JSON.stringify(expected)) throw new Error('Editor staging changed after manifest anchoring');
  await mkdir(destination, { recursive: true });
  await assertRealDirectory(destination);
  for (const file of expected.files) {
    // Read, hash and publish the same bytes; never copy a reread source after validation.
    const bytes = await readFile(path.join(directory, file.path));
    if (bytes.length !== file.length || digest(bytes) !== file.sha256) throw new Error('Editor asset changed during copy');
    await writeFile(path.join(destination, file.path), bytes);
  }
  await writeFile(path.join(destination, 'manifest.json'), JSON.stringify(expected, null, 2) + '\n');
}
export async function buildEditor() {
  await mkdir(path.dirname(staging), { recursive: true });
  await assertRealDirectory(path.dirname(staging));
  try {
    await assertRealDirectory(staging);
  } catch (error) {
    if (error.code !== 'ENOENT') throw error;
  }
  const desktopRequire = createRequire(path.join(root, 'apps/desktop/package.json'));
  const { build } = await import(desktopRequire.resolve('vite'));
  await build({
    configFile: false,
    root: path.join(root, 'apps/desktop/src/renderer/mota-editor'),
    base: './',
    build: {
      outDir: staging,
      emptyOutDir: true,
      modulePreload: false,
      cssCodeSplit: false,
      rollupOptions: {
        input: path.join(root, 'apps/desktop/src/renderer/mota-editor/index.html'),
        output: { entryFileNames: 'editor.js', chunkFileNames: 'editor-[name].js', assetFileNames: 'editor.[ext]' },
      },
    },
  });
  await copyFile(path.join(root, 'LICENSE'), path.join(staging, 'LICENSES.txt'));
  const manifest = await collectAssets(staging);
  const inputs = [];
  for (const name of [
    'apps/desktop/src/renderer/mota-editor/index.html',
    'apps/desktop/src/renderer/mota-editor/editor.ts',
    'apps/desktop/src/renderer/mota-editor/editor.css',
    'apps/desktop/src/renderer/src/styles/app.css',
    'apps/desktop/package.json',
    'pnpm-lock.yaml',
    'scripts/build-mota-editor.mjs',
  ]) {
    inputs.push({ path: name, sha256: digest(await readFile(path.join(root, name))) });
  }
  await writeFile(
    manifestPath,
    JSON.stringify(
      {
        ...manifest,
        inputs,
        provenance:
          'Original Web Studio Lab product assets; repository LICENSE. Built with the pinned desktop Vite; no imported Mota executable assets.',
      },
      null,
      2,
    ) + '\n',
  );
  console.log('Prebuilt trusted Mota editor:', manifest.version);
}
if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) await buildEditor();
