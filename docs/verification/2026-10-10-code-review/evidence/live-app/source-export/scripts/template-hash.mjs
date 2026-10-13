import process from 'node:process';
import console from 'node:console';
import { createHash } from 'node:crypto';
import { readdir, readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
const excluded = new Set(['node_modules', 'dist', '.data', '.test-data', 'template-manifest.json']);
async function entries(dir = '.') {
  const result = [];
  for (const entry of await readdir(dir, { withFileTypes: true })) {
    if (excluded.has(entry.name) || entry.name.endsWith('.log')) continue;
    const path = join(dir, entry.name);
    if (entry.isDirectory()) result.push(...(await entries(path)));
    else if (entry.isFile()) result.push(path);
    else throw new Error(`Unsupported template entry: ${path}`);
  }
  return result.sort();
}
const files = {};
for (const path of await entries())
  files[path] = createHash('sha256')
    .update(await readFile(path))
    .digest('hex');
const contentSha256 = createHash('sha256').update(JSON.stringify(files)).digest('hex');
const manifest = { templateId: 'wsl-standard-app', version: '1.0.0', algorithm: 'sha256', contentSha256, files };
if (process.argv.includes('--verify')) {
  if (JSON.stringify(JSON.parse(await readFile('template-manifest.json', 'utf8'))) !== JSON.stringify(manifest))
    throw new Error('Template source hash mismatch');
  console.log(`Verified template sha256:${contentSha256}`);
} else {
  await writeFile('template-manifest.json', JSON.stringify(manifest, null, 2) + '\n');
  console.log(contentSha256);
}
