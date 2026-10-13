import { createRequire } from 'node:module';
import process from 'node:process';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { mkdtemp, mkdir, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

// Sharp is an export tool, not a product dependency. Pass its installed module path.
const sharpModule = process.argv[2];
if (!sharpModule) throw new Error('Usage: node scripts/branding/export-icons.mjs /absolute/path/to/sharp');
if (process.platform !== 'darwin') throw new Error('macOS iconutil is required to export the ICNS asset');
const sharp = createRequire(import.meta.url)(path.resolve(sharpModule));
const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const resources = path.join(root, 'apps/desktop/resources/branding');
const master = await readFile(path.join(resources, 'logo.svg'));
const small = await readFile(path.join(resources, 'logo-small.svg'));
await sharp(master).resize(1024, 1024).png().toFile(path.join(resources, 'icon.png'));

// Let macOS encode the logical-size and Retina representations, rather than
// hand-writing ICNS types whose names do not consistently imply pixel sizes.
const representations = [
  ['icon_16x16.png', 16],
  ['icon_16x16@2x.png', 32],
  ['icon_32x32.png', 32],
  ['icon_32x32@2x.png', 64],
  ['icon_128x128.png', 128],
  ['icon_128x128@2x.png', 256],
  ['icon_256x256.png', 256],
  ['icon_256x256@2x.png', 512],
  ['icon_512x512.png', 512],
  ['icon_512x512@2x.png', 1024],
];
const temporary = await mkdtemp(path.join(tmpdir(), 'wsl-branding-'));
try {
  const iconset = path.join(temporary, 'icon.iconset');
  await mkdir(iconset);
  for (const [name, size] of representations) {
    await sharp(size < 128 ? small : master)
      .resize(size, size)
      .png()
      .toFile(path.join(iconset, name));
  }
  await promisify(execFile)('/usr/bin/iconutil', ['-c', 'icns', iconset, '-o', path.join(root, 'packaging/icon.icns')]);
} finally {
  await rm(temporary, { recursive: true, force: true });
}
