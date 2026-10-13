import process from 'node:process';
import { execFileSync } from 'node:child_process';
import { mkdir, readFile, writeFile, cp, readdir } from 'node:fs/promises';
import path from 'node:path';
import { inspectLinuxBinary } from './guest-platform.mjs';
import { root, inspectTar, fileHash, inventory, expandedBytes, deterministicArchive } from './payload-lib.mjs';

export const templateBinaries = [
  'node_modules/@esbuild/linux-arm64/bin/esbuild',
  'node_modules/@rollup/rollup-linux-arm64-gnu/rollup.linux-arm64-gnu.node',
  'node_modules/@tailwindcss/oxide-linux-arm64-gnu/tailwindcss-oxide.linux-arm64-gnu.node',
  'node_modules/lightningcss-linux-arm64-gnu/lightningcss.linux-arm64-gnu.node',
];
export function auditTemplateArchive(bytes) {
  const elf = new Set();
  const entries = inspectTar(bytes);
  for (const entry of entries) {
    if (entry.name !== 'node_modules' && !entry.name.startsWith('node_modules/')) throw new Error('Template payload outside node_modules');
    if (entry.type === '0') inspectLinuxBinary(entry.name, entry.header, elf);
    if (/linux-(?:x64|ia32)|darwin-|win32-|linux-arm64-musl/.test(entry.name)) throw new Error(`Foreign template target: ${entry.name}`);
    if (entry.name === templateBinaries[0] && !(entry.mode & 0o111)) throw new Error('Template esbuild is not executable');
  }
  for (const name of templateBinaries) if (!elf.has(name)) throw new Error(`Required template Linux ARM64 binary missing: ${name}`);
  return { platform: 'linux', arch: 'arm64', libc: 'glibc', elfFiles: [...elf].sort(), entries: entries.length };
}
export async function prepareTemplatePayload(destination, staging) {
  const source = path.join(root, 'templates/standard-app');
  execFileSync(process.execPath, ['scripts/template-hash.mjs', '--verify'], { cwd: source, stdio: 'inherit' });
  await mkdir(staging, { recursive: true });
  for (const name of ['package.json', 'package-lock.json', '.npmrc']) await cp(path.join(source, name), path.join(staging, name));
  execFileSync(
    'npm',
    [
      'ci',
      '--workspaces=false',
      '--os=linux',
      '--cpu=arm64',
      '--libc=glibc',
      '--ignore-scripts',
      '--no-audit',
      '--no-fund',
      ...(process.env.WSL_PAYLOAD_OFFLINE === '1' ? ['--offline'] : []),
    ],
    { cwd: staging, stdio: 'inherit' },
  );
  const lock = JSON.parse(await readFile(path.join(source, 'package-lock.json'), 'utf8'));
  const packages = [];
  const licenses = path.join(destination, 'licenses/template');
  await mkdir(licenses, { recursive: true });
  for (const item of await inventory(path.join(staging, 'node_modules'))) {
    if (!item.stat.isFile() || !item.relative.endsWith('/package.json')) continue;
    const relative = 'node_modules/' + path.posix.dirname(item.relative);
    const pinned = lock.packages[relative];
    if (!pinned) continue; // nested package.json exports are not installed packages
    const metadata = JSON.parse(await readFile(item.absolute, 'utf8'));
    if (metadata.version !== pinned.version) throw new Error(`Template dependency differs from lock: ${relative}`);
    const files = [];
    for (const name of await readdir(path.dirname(item.absolute))) {
      if (!/^(licen[sc]e|copying|notice)([.-]|$)/i.test(name)) continue;
      const target = `${packages.length}-${name}`;
      await cp(path.join(path.dirname(item.absolute), name), path.join(licenses, target), { recursive: true });
      files.push(target);
    }
    let licenseSource = 'published-package';
    if (!files.length) {
      const companions = { '@esbuild/linux-arm64': 'esbuild', '@rollup/rollup-linux-arm64-gnu': 'rollup' };
      const companion = companions[metadata.name];
      if (companion) {
        const companionRoot = path.join(staging, 'node_modules', companion);
        const companionMetadata = JSON.parse(await readFile(path.join(companionRoot, 'package.json'), 'utf8'));
        if (companionMetadata.version !== metadata.version) throw new Error(`Native license companion version mismatch: ${metadata.name}`);
        const target = `${packages.length}-LICENSE-companion.txt`;
        await cp(path.join(companionRoot, 'LICENSE.md'), path.join(licenses, target));
        files.push(target);
        licenseSource = `same-version ${companion}`;
      } else if (metadata.name === 'drizzle-orm' && metadata.license === 'Apache-2.0') {
        const target = `${packages.length}-Apache-2.0.txt`;
        await cp(path.join(root, 'LICENSE'), path.join(licenses, target));
        const notice = `${packages.length}-published-README.md`;
        await cp(path.join(path.dirname(item.absolute), 'README.md'), path.join(licenses, notice));
        files.push(target, notice);
        licenseSource = 'SPDX Apache-2.0 standard text and published README; npm package omits LICENSE';
      } else throw new Error(`Missing template dependency license: ${metadata.name}`);
    }
    packages.push({
      path: relative,
      name: metadata.name,
      version: metadata.version,
      license: metadata.license ?? pinned.license ?? 'SEE PACKAGE',
      files,
      licenseSource,
    });
  }
  await writeFile(path.join(licenses, 'manifest.json'), JSON.stringify(packages, null, 2) + '\n');
  const archive = path.join(destination, 'template-dependencies.tar.gz');
  // Only node_modules belongs in the runtime archive; root package files remain in the separate source template.
  const archiveRoot = path.join(staging, 'payload');
  await mkdir(archiveRoot);
  await cp(path.join(staging, 'node_modules'), path.join(archiveRoot, 'node_modules'), { recursive: true, verbatimSymlinks: true });
  await deterministicArchive(archiveRoot, archive);
  const audit = auditTemplateArchive(await readFile(archive));
  await writeFile(path.join(destination, 'template-platform-audit.json'), JSON.stringify(audit, null, 2) + '\n');
  const template = JSON.parse(await readFile(path.join(source, 'template-manifest.json'), 'utf8'));
  const payload = {
    path: 'template-dependencies.tar.gz',
    sha256: await fileHash(archive),
    expandedBytes: await expandedBytes(archiveRoot),
    source: 'https://registry.npmjs.org/',
    license: 'SEE licenses/template/manifest.json',
    lockSha256: await fileHash(path.join(source, 'package-lock.json')),
    contentSha256: template.contentSha256,
    platform: 'linux',
    arch: 'arm64',
    libc: 'glibc',
  };
  await writeFile(
    archive + '.json',
    JSON.stringify({ archiveSha256: payload.sha256, lockSha256: payload.lockSha256, platform: 'linux', arch: 'arm64' }, null, 2) + '\n',
  );
  return payload;
}
