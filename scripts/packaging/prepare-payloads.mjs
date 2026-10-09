import { prepareTemplatePayload } from './template-payload.mjs';
/* global process */
import { cp, mkdir, readFile, rm, symlink, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { collectLicenses } from './collect-licenses.mjs';
import { prunePnpmForeignTargets, auditGuestDirectory, auditGuestArchive } from './guest-platform.mjs';
import { root, runtimeRoot, download, extractSafe, expandedBytes, deterministicArchive, fileHash } from './payload-lib.mjs';

export async function preparePayloads(cache = path.join(root, 'packaging/cache')) {
  const lock = JSON.parse(await readFile(path.join(root, 'packaging/dependencies.lock.json'), 'utf8'));
  const temporary = path.join(root, 'packaging/generated/staging');
  await rm(temporary, { recursive: true, force: true });
  await rm(runtimeRoot, { recursive: true, force: true });
  await mkdir(runtimeRoot, { recursive: true });
  for (const source of lock.sources) {
    const archive = await download(source, cache);
    await extractSafe(archive, path.join(temporary, source.id));
  }
  await cp(path.join(temporary, 'python', 'python'), path.join(runtimeRoot, 'python'), { recursive: true, verbatimSymlinks: true });
  const guest = path.join(temporary, 'guest');
  const prefix = path.join(guest, 'usr/local');
  await mkdir(prefix, { recursive: true });
  await cp(path.join(temporary, 'node', 'node-v24.21.0-linux-arm64'), prefix, { recursive: true, verbatimSymlinks: true });
  const globals = path.join(prefix, 'lib/node_modules');
  await mkdir(path.join(globals, '@openai'), { recursive: true });
  await cp(path.join(temporary, 'pnpm', 'package'), path.join(globals, 'pnpm'), { recursive: true, verbatimSymlinks: true });
  await cp(path.join(temporary, 'codex', 'package'), path.join(globals, '@openai/codex'), { recursive: true, verbatimSymlinks: true });
  // The optional package alias must match the CLI's require.resolve lookup.
  await cp(path.join(temporary, 'codex-arm64', 'package'), path.join(globals, '@openai/codex-linux-arm64'), {
    recursive: true,
    verbatimSymlinks: true,
  });
  for (const [name, target] of Object.entries({
    pnpm: '../lib/node_modules/pnpm/bin/pnpm.cjs',
    pnpx: '../lib/node_modules/pnpm/bin/pnpx.cjs',
    codex: '../lib/node_modules/@openai/codex/bin/codex.js',
  })) {
    await symlink(target, path.join(prefix, 'bin', name));
  }
  for (const [relative, version] of [
    ['pnpm', '10.34.6'],
    ['@openai/codex', '0.160.0'],
    ['@openai/codex-linux-arm64', '0.160.0-linux-arm64'],
  ]) {
    const metadata = JSON.parse(await readFile(path.join(globals, relative, 'package.json'), 'utf8'));
    if (metadata.version !== version || Object.keys(metadata.dependencies || {}).length)
      throw new Error(`Incomplete or unexpected package dependency tree: ${relative}`);
  }
  for (const source of lock.licenseSources) {
    const file = await download(source, cache);
    const runtimeLicenses = path.join(runtimeRoot, 'licenses');
    const guestLicenses = path.join(prefix, 'share/licenses/web-studio-lab');
    await mkdir(runtimeLicenses, { recursive: true });
    await mkdir(guestLicenses, { recursive: true });
    await cp(file, path.join(runtimeLicenses, source.id + '.txt'));
    if (source.scope !== 'app') await cp(file, path.join(guestLicenses, source.id + '.txt'));
  }
  const removedPnpmTargets = await prunePnpmForeignTargets(path.join(globals, 'pnpm'));
  const platformAudit = await auditGuestDirectory(guest);
  await deterministicArchive(guest, path.join(runtimeRoot, 'guest-tools.tar.gz'));
  auditGuestArchive(await readFile(path.join(runtimeRoot, 'guest-tools.tar.gz')));
  await writeFile(
    path.join(runtimeRoot, 'guest-platform-audit.json'),
    JSON.stringify({ ...platformAudit, removedPnpmTargets }, null, 2) + '\n',
  );
  const pythonSource = lock.sources.find((source) => source.id === 'python');
  const pythonBytes = await expandedBytes(path.join(runtimeRoot, 'python'));
  const guestBytes = await expandedBytes(guest);
  const template = await prepareTemplatePayload(runtimeRoot, path.join(temporary, 'template'));
  const manifest = {
    template,
    schemaVersion: 1,
    platform: 'darwin-arm64',
    minimumFreeBytes: 2 * (pythonBytes + guestBytes + template.expandedBytes) + 8 * 1024 ** 3,
    python: {
      path: 'python/bin/python3',
      executable: 'python/bin/python3',
      sha256: await fileHash(path.join(runtimeRoot, 'python/bin/python3')),
      archiveSha256: pythonSource.sha256,
      expandedBytes: pythonBytes,
      source: pythonSource.url,
      license: pythonSource.license,
      version: pythonSource.version,
    },
    guest: {
      path: 'guest-tools.tar.gz',
      sha256: await fileHash(path.join(runtimeRoot, 'guest-tools.tar.gz')),
      expandedBytes: guestBytes,
      source: 'https://github.com/JadeSnow7/web-studio-lab/blob/main/packaging/dependencies.lock.json',
      license: 'Node.js MIT and bundled third-party notices; pnpm MIT; Codex Apache-2.0 and bundled third-party notices',
      node: '24.21.0',
      pnpm: '10.34.6',
      codex: '0.160.0',
    },
    baseImage: lock.baseImage.reference,
  };
  await writeFile(path.join(runtimeRoot, 'dependencies.json'), JSON.stringify(manifest, null, 2) + '\n');
  await writeFile(path.join(runtimeRoot, 'dependency-sources.json'), JSON.stringify(lock, null, 2) + '\n');
  await cp(path.join(root, 'THIRD-PARTY-NOTICES.md'), path.join(runtimeRoot, 'THIRD-PARTY-NOTICES.md'));
  // Release archives carry the license documents embedded by their publishers.
  await cp(path.join(root, 'LICENSE'), path.join(runtimeRoot, 'LICENSE'));
  await collectLicenses(path.join(runtimeRoot, 'licenses/app'));
  await rm(temporary, { recursive: true, force: true });
  return manifest;
}
if (process.argv[1] && fileURLToPath(import.meta.url) === path.resolve(process.argv[1])) {
  const manifest = await preparePayloads(process.argv[2]);
  process.stdout.write(JSON.stringify(manifest, null, 2) + '\n');
}
