/* global process */
import { readFile, writeFile } from 'node:fs/promises';
import { execFileSync } from 'node:child_process';
import path from 'node:path';
import { root, runtimeRoot, inventory, fileHash, expandedBytes } from './payload-lib.mjs';
import { auditService, releasePreflight, verifyPayloads } from './release-gates.mjs';

export async function beforePack() {
  await verifyPayloads();
  await auditService();
  if (process.env.WSL_INTERNAL_UNSIGNED === '1') return;
  await releasePreflight();
  const pythonFiles = (await inventory(path.join(runtimeRoot, 'python')))
    .filter((entry) => entry.stat.isFile())
    .sort((a, b) => b.relative.split('/').length - a.relative.split('/').length || a.relative.localeCompare(b.relative));
  const magics = new Set(['cffaedfe', 'feedfacf', 'cafebabe', 'bebafeca']);
  for (const entry of pythonFiles) {
    const bytes = await readFile(entry.absolute);
    if (!magics.has(bytes.subarray(0, 4).toString('hex'))) continue;
    const arches = execFileSync('/usr/bin/lipo', ['-archs', entry.absolute], { encoding: 'utf8' }).trim().split(/\s+/);
    if (!arches.includes('arm64')) throw new Error(`Host Python contains incompatible Mach-O: ${entry.relative}`);
    execFileSync(
      '/usr/bin/codesign',
      [
        '--force',
        '--sign',
        process.env.CSC_NAME,
        '--timestamp',
        '--options',
        'runtime',
        '--entitlements',
        path.join(root, 'packaging/python-entitlements.plist'),
        entry.absolute,
      ],
      { stdio: 'inherit' },
    );
    execFileSync('/usr/bin/codesign', ['--verify', '--strict', entry.absolute], { stdio: 'inherit' });
  }
  // Builder skips re-signing this already-signed tree; final app signature seals all Python resources.
  const file = path.join(runtimeRoot, 'dependencies.json');
  const manifest = JSON.parse(await readFile(file, 'utf8'));
  manifest.python.sha256 = await fileHash(path.join(runtimeRoot, manifest.python.path));
  manifest.python.expandedBytes = await expandedBytes(path.join(runtimeRoot, 'python'));
  manifest.minimumFreeBytes =
    2 * (manifest.python.expandedBytes + manifest.guest.expandedBytes + manifest.template.expandedBytes) + 8 * 1024 ** 3;
  await writeFile(file, JSON.stringify(manifest, null, 2) + '\n');
  await verifyPayloads();
}
