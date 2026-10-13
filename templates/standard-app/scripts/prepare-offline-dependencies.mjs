import process from 'node:process';
import console from 'node:console';
import { spawn } from 'node:child_process';
import { createHash, randomUUID } from 'node:crypto';
import { createReadStream } from 'node:fs';
import { access, copyFile, mkdir, mkdtemp, readFile, rename, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, resolve, sep } from 'node:path';
import { fileURLToPath, URL } from 'node:url';

const args = process.argv.slice(2);
if (args.length < 1 || args.length > 2 || (args[1] && args[1] !== '--offline')) {
  throw new Error('Usage: node scripts/prepare-offline-dependencies.mjs /absolute/output.tar.gz [--offline]');
}
const root = fileURLToPath(new URL('..', import.meta.url));
const archive = resolve(args[0]);
if (archive.startsWith(root.endsWith(sep) ? root : `${root}${sep}`)) {
  throw new Error('Write dependency archives outside the versioned template directory');
}
for (const path of [archive, `${archive}.json`]) {
  try {
    await access(path);
  } catch (error) {
    if (error.code === 'ENOENT') continue;
    throw error;
  }
  throw new Error(`Refusing to overwrite ${path}`);
}
async function hash(path) {
  const digest = createHash('sha256');
  for await (const chunk of createReadStream(path)) digest.update(chunk);
  return digest.digest('hex');
}
function run(command, commandArgs, cwd) {
  return new Promise((resolveRun, reject) => {
    const child = spawn(command, commandArgs, { cwd, stdio: 'inherit', env: { ...process.env, COPYFILE_DISABLE: '1' } });
    child.on('error', reject);
    child.on('exit', (code, signal) => (code === 0 ? resolveRun() : reject(new Error(`${command} failed: code=${code} signal=${signal}`))));
  });
}
const staging = await mkdtemp(resolve(tmpdir(), 'wsl-template-linux-arm64-'));
const partial = `${archive}.partial-${randomUUID()}`;
try {
  const lockSha256 = await hash(resolve(root, 'package-lock.json'));
  for (const file of ['package.json', 'package-lock.json', '.npmrc']) {
    await copyFile(resolve(root, file), resolve(staging, file));
  }
  await run(
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
      ...(args[1] ? ['--offline'] : []),
    ],
    staging,
  );
  const installedLockSha256 = await hash(resolve(staging, 'package-lock.json'));
  if (installedLockSha256 !== lockSha256 || (await hash(resolve(root, 'package-lock.json'))) !== lockSha256) {
    throw new Error('Lock changed during dependency preparation');
  }
  const lock = JSON.parse(await readFile(resolve(staging, 'package-lock.json'), 'utf8'));
  // npm optional packages must include the actual target binaries; host binaries cannot substitute them.
  for (const packageName of [
    '@esbuild/linux-arm64',
    '@rollup/rollup-linux-arm64-gnu',
    '@tailwindcss/oxide-linux-arm64-gnu',
    'lightningcss-linux-arm64-gnu',
  ]) {
    const installed = JSON.parse(await readFile(resolve(staging, 'node_modules', packageName, 'package.json'), 'utf8'));
    if (installed.version !== lock.packages[`node_modules/${packageName}`]?.version) {
      throw new Error(`Target binary package version mismatch: ${packageName}`);
    }
  }
  await mkdir(dirname(archive), { recursive: true });
  await run('tar', ['-czf', partial, 'node_modules'], staging);
  const manifest = { archiveSha256: await hash(partial), lockSha256: installedLockSha256, platform: 'linux', arch: 'arm64' };
  await writeFile(`${partial}.json`, JSON.stringify(manifest, null, 2) + '\n', { flag: 'wx' });
  await rename(partial, archive);
  await rename(`${partial}.json`, `${archive}.json`);
  console.log(JSON.stringify({ archive, manifestPath: `${archive}.json`, ...manifest }));
} finally {
  await rm(staging, { recursive: true, force: true });
  await rm(partial, { force: true });
  await rm(`${partial}.json`, { force: true });
}
