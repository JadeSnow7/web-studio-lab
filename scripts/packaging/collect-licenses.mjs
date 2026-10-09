import { createRequire } from 'node:module';
import { readFile, writeFile, mkdir, access } from 'node:fs/promises';
import path from 'node:path';
import { root } from './payload-lib.mjs';

async function locate(name, from) {
  const require = createRequire(from);
  let directory = path.dirname(require.resolve(name));
  while (directory !== path.dirname(directory)) {
    try {
      const metadata = JSON.parse(await readFile(path.join(directory, 'package.json'), 'utf8'));
      if (metadata.name === name) return { directory, metadata };
    } catch (error) {
      if (error.code !== 'ENOENT') throw error;
    }
    directory = path.dirname(directory);
  }
  throw new Error(`Cannot locate license package: ${name}`);
}
export async function collectLicenses(destination) {
  await mkdir(destination, { recursive: true });
  const queue = [
    ['ssh2', path.join(root, 'apps/service/package.json')],
    ['zod', path.join(root, 'apps/service/package.json')],
    ['@xterm/headless', path.join(root, 'apps/service/package.json')],
    ['parse5', path.join(root, 'apps/desktop/package.json')],
    ['react', path.join(root, 'apps/desktop/package.json')],
    ['react-dom', path.join(root, 'apps/desktop/package.json')],
    ['@xterm/xterm', path.join(root, 'apps/desktop/package.json')],
    ['@xterm/addon-fit', path.join(root, 'apps/desktop/package.json')],
  ];
  const lock = JSON.parse(await readFile(path.join(root, 'packaging/dependencies.lock.json'), 'utf8'));
  const result = [];
  const seen = new Set();
  for (const [name, from] of queue) {
    if (seen.has(name)) continue;
    seen.add(name);
    const { directory, metadata } = await locate(name, from);
    let license;
    for (const candidate of ['LICENSE', 'LICENSE.txt', 'LICENSE.md', 'LICENCE']) {
      try {
        await access(path.join(directory, candidate));
        license = candidate;
        break;
      } catch (error) {
        if (error.code !== 'ENOENT') throw error;
      }
    }
    let licensePath;
    if (license) licensePath = path.join(directory, license);
    else {
      // headless's published package omits LICENSE; the exact upstream commit is pinned.
      const source = lock.licenseSources.find((source) => source.packages?.includes(name));
      if (!source || metadata.commit !== source.version) throw new Error(`Missing bundled library license: ${name}`);
      licensePath = path.join(destination, '..', source.id + '.txt');
    }
    const target = name.replaceAll('/', '__').replace('@', '') + '-LICENSE.txt';
    await writeFile(path.join(destination, target), await readFile(licensePath));
    result.push({ name, version: metadata.version, license: metadata.license, file: target });
    for (const dependency of Object.keys(metadata.dependencies || {})) queue.push([dependency, path.join(directory, 'package.json')]);
  }
  await writeFile(path.join(destination, 'manifest.json'), JSON.stringify(result, null, 2) + '\n');
  return result;
}
