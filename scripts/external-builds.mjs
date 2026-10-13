/* global process, console, URL */
import { createHash } from 'node:crypto';
import { lstat, mkdir, readFile, readlink, realpath, stat, symlink, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

export const volume = '/Volumes/Developer';
export const artifactsRoot = path.join(volume, 'BuildArtifacts');
const configPath = '.local/external-builds.json';
const outputs = [
  'apps/desktop/out',
  'apps/service/out',
  'apps/desktop/release',
  'apps/desktop/release-internal',
  'packaging/generated',
  'packaging/cache',
];

async function optionalStat(file) {
  try {
    return await lstat(file);
  } catch (error) {
    if (error.code === 'ENOENT') return null;
    throw error;
  }
}

export async function plan(checkout, destination = artifactsRoot) {
  const physical = await realpath(checkout);
  const id = createHash('sha256').update(physical).digest('hex').slice(0, 16);
  const base = path.join(destination, 'web-studio-lab', id);
  return outputs.map((relative) => ({ source: path.join(physical, relative), target: path.join(base, relative) }));
}

export async function requireMountedVolume(mount = volume) {
  const mounted = await stat(mount);
  const parent = await stat(path.dirname(mount));
  if (!mounted.isDirectory() || mounted.dev === parent.dev) throw new Error(`External build volume is not mounted: ${mount}`);
}

async function inspectLinks(entries, allowMissing) {
  for (const { source, target } of entries) {
    const current = await optionalStat(source);
    if (!current && allowMissing) continue;
    if (!current?.isSymbolicLink() || path.resolve(path.dirname(source), await readlink(source)) !== target)
      throw new Error(
        `External build path must be a symlink: ${source} -> ${target}. Preserve and migrate existing artifacts before setup.`,
      );
  }
}

export async function setup(checkout, destination = artifactsRoot) {
  if (await optionalStat(path.join(checkout, configPath))) await readConfig(checkout);
  const entries = await plan(checkout, destination);
  // Inspect every source before writing so existing artifacts are never replaced.
  await inspectLinks(entries, true);
  for (const { source, target } of entries) {
    await mkdir(target, { recursive: true });
    await mkdir(path.dirname(source), { recursive: true });
    if (!(await optionalStat(source))) await symlink(target, source, 'dir');
  }
  await mkdir(path.join(checkout, '.local'), { recursive: true });
  await writeFile(path.join(checkout, configPath), JSON.stringify({ schemaVersion: 1 }) + '\n', { flag: 'wx' }).catch(async (error) => {
    if (error.code !== 'EEXIST') throw error;
    await readConfig(checkout);
  });
  return entries;
}

async function readConfig(checkout) {
  const config = JSON.parse(await readFile(path.join(checkout, configPath), 'utf8'));
  if (config.schemaVersion !== 1 || Object.keys(config).length !== 1) throw new Error('Invalid .local/external-builds.json');
}

export async function verify(checkout, destination = artifactsRoot) {
  await readConfig(checkout);
  const entries = await plan(checkout, destination);
  await inspectLinks(entries, false);
  for (const { target } of entries) {
    if (!(await stat(target)).isDirectory()) throw new Error(`Missing external build directory: ${target}`);
  }
}

async function main() {
  const checkout = await realpath(fileURLToPath(new URL('..', import.meta.url)));
  const command = process.argv[2];
  if (process.argv.length !== 3 || !['setup', 'verify', 'plan'].includes(command))
    throw new Error('Usage: node scripts/external-builds.mjs setup|verify|plan');
  if (command === 'plan') {
    console.log(JSON.stringify(await plan(checkout), null, 2));
    return;
  }
  if (command === 'verify' && !(await optionalStat(path.join(checkout, configPath)))) return;
  await requireMountedVolume();
  if (command === 'setup') console.log(JSON.stringify(await setup(checkout), null, 2));
  else await verify(checkout);
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) await main();
