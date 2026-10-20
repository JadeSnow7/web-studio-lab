import { resolve, dirname } from 'node:path';
import react from '@vitejs/plugin-react';
import { defineConfig } from 'electron-vite';
import { readFileSync, lstatSync, readdirSync, mkdirSync, writeFileSync } from 'node:fs';
import { createHash } from 'node:crypto';

// Main is built first: expectations must already exist, never derive them from runtime assets.
const staging = resolve('../../.local/build/mota-editor');
const manifest = JSON.parse(readFileSync(resolve('../../.local/build/mota-editor-manifest.json'), 'utf8')) as {
  schemaVersion: number;
  version: string;
  files: { path: string; length: number; sha256: string }[];
};
const hash = (bytes: string | Buffer) => createHash('sha256').update(bytes).digest('hex');
if (
  manifest.schemaVersion !== 1 ||
  manifest.version !== hash(JSON.stringify(manifest.files)) ||
  JSON.stringify(manifest.files.map((file) => file.path)) !== JSON.stringify(['LICENSES.txt', 'editor.css', 'editor.js', 'index.html'])
)
  throw new Error('Invalid prebuilt Mota editor manifest; run the desktop build script');
function stagedBytes() {
  assertRealDirectory(staging);
  if (
    lstatSync(staging).isSymbolicLink() ||
    JSON.stringify(readdirSync(staging).sort()) !== JSON.stringify(manifest.files.map((file) => file.path))
  )
    throw new Error('Mota editor staging inventory changed');
  return manifest.files.map((file) => {
    const source = resolve(staging, file.path);
    const info = lstatSync(source);
    const bytes = readFileSync(source);
    if (!info.isFile() || info.isSymbolicLink() || info.nlink !== 1 || bytes.length !== file.length || hash(bytes) !== file.sha256)
      throw new Error('Mota editor staging integrity failed');
    return { name: file.path, bytes };
  });
}
stagedBytes();
function assertRealDirectory(directory: string) {
  let current = resolve(directory);
  while (true) {
    const info = lstatSync(current);
    if (!info.isDirectory() || info.isSymbolicLink()) throw new Error('Editor build directory contains a link');
    const parent = dirname(current);
    if (parent === current) return;
    current = parent;
  }
}

// main 与 preload 把依赖（含 @wsl/protocol 与 zod）全部打进产物：
// 沙箱 preload 不能 require 第三方模块，打包后的应用也不携带 node_modules。
export default defineConfig({
  main: {
    define: { __MOTA_EDITOR_MANIFEST__: JSON.stringify(manifest) },
    plugins: [
      {
        name: 'copy-anchored-mota-editor',
        closeBundle() {
          const files = stagedBytes();
          const destination = resolve('out/main/mota-editor');
          mkdirSync(destination, { recursive: true });
          assertRealDirectory(destination);
          for (const file of files) writeFileSync(resolve(destination, file.name), file.bytes);
          writeFileSync(resolve(destination, 'manifest.json'), JSON.stringify(manifest, null, 2) + '\n');
        },
      },
    ],
    build: {
      externalizeDeps: false,
    },
  },
  preload: {
    build: {
      externalizeDeps: false,
      rollupOptions: { input: { index: resolve('src/preload/index.ts'), 'mota-editor': resolve('src/preload/mota-editor.ts') } },
    },
  },
  renderer: {
    root: resolve('src/renderer'),
    plugins: [react()],
    build: {
      rollupOptions: {
        input: resolve('src/renderer/index.html'),
      },
    },
  },
});
