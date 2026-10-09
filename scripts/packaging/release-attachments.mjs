import { readFile, writeFile, mkdir } from 'node:fs/promises';
import path from 'node:path';
import { root } from './payload-lib.mjs';

export const releaseDocuments = [
  { source: 'docs/development/competition-installer.md', destination: 'INSTALLATION.zh-CN.md' },
  { source: 'docs/acceptance/installer-20261009/RESULTS.md', destination: 'ACCEPTANCE.md' },
];
export async function readReleaseDocuments(projectRoot = root) {
  return Promise.all(
    releaseDocuments.map(async ({ source, destination }) => {
      const content = await readFile(path.join(projectRoot, source));
      if (!content.toString('utf8').trim()) throw new Error(`Release document is empty: ${source}`);
      return { destination, content };
    }),
  );
}
export async function copyReleaseAttachments(resourceRoot, destination, projectRoot = root) {
  const documents = await readReleaseDocuments(projectRoot);
  // Copy the manifests and notices sealed in the validated App, rather than a staging copy.
  const resourceNames = ['dependencies.json', 'dependency-sources.json', 'THIRD-PARTY-NOTICES.md', 'LICENSE'];
  const resources = await Promise.all(
    resourceNames.map(async (name) => ({ destination: name, content: await readFile(path.join(resourceRoot, name)) })),
  );
  await mkdir(destination, { recursive: true });
  for (const file of [...documents, ...resources]) await writeFile(path.join(destination, file.destination), file.content);
}
