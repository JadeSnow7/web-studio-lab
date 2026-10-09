/* global process, fetch */
import { createReadStream } from 'node:fs';
import { createHash } from 'node:crypto';
import { readFile, writeFile, mkdir, cp, readdir, stat, appendFile } from 'node:fs/promises';
import { execFileSync } from 'node:child_process';
import path from 'node:path';
import { fileURLToPath, URL } from 'node:url';
import { root, fileHash, digest } from './payload-lib.mjs';

const attachments = [
  'SHA256SUMS',
  'release-manifest.json',
  'INSTALLATION.zh-CN.md',
  'ACCEPTANCE.md',
  'dependencies.json',
  'dependency-sources.json',
  'THIRD-PARTY-NOTICES.md',
  'LICENSE',
];
export function validateReleaseTag(tag, version) {
  if (!/^v\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?$/.test(tag) || tag !== 'v' + version)
    throw new Error('Release tag must equal v plus the desktop package version');
  return tag;
}
function parseChecksums(text) {
  const entries = text
    .trim()
    .split('\n')
    .map((line) => {
      const match = /^([a-f0-9]{64}) {2}([^/\\\r\n]+\.(?:dmg|zip))$/.exec(line);
      if (!match) throw new Error('Invalid release checksum entry');
      return { name: match[2], sha256: match[1] };
    });
  if (entries.length !== 2 || new Set(entries.map((entry) => path.extname(entry.name))).size !== 2)
    throw new Error('Expected one DMG and one ZIP checksum');
  return entries;
}
export async function prepareReleaseAssets(release, destination, tag, commit) {
  const manifest = JSON.parse(await readFile(path.join(release, 'artifacts/release-manifest.json'), 'utf8'));
  validateReleaseTag(tag, manifest.version);
  if (manifest.gitCommit !== commit || !/^[a-f0-9]{40}$/.test(commit) || !Array.isArray(manifest.dirtyPaths) || manifest.dirtyPaths.length)
    throw new Error('Release assets do not describe a clean tagged commit');
  if (
    manifest.notarization?.status !== 'Accepted' ||
    !['codesign', 'spctl', 'stapler'].every((check) => manifest.validation?.includes(check))
  )
    throw new Error('Release assets lack successful signing/notarization validation');
  const checksumText = await readFile(path.join(release, 'artifacts/SHA256SUMS'), 'utf8');
  if (JSON.stringify(manifest.artifacts) !== JSON.stringify(checksumText.trim().split('\n')))
    throw new Error('Manifest artifacts differ from SHA256SUMS');
  const binaries = parseChecksums(checksumText);
  for (const binary of binaries)
    if ((await fileHash(path.join(release, binary.name))) !== binary.sha256)
      throw new Error(`Release artifact hash mismatch: ${binary.name}`);
  await mkdir(destination, { recursive: false });
  for (const name of attachments) await cp(path.join(release, 'artifacts', name), path.join(destination, name));
  for (const binary of binaries) await cp(path.join(release, binary.name), path.join(destination, binary.name));
  const files = await assetInventory(destination);
  await writeFile(path.join(destination, 'release-assets.json'), JSON.stringify({ schemaVersion: 1, tag, commit, files }, null, 2) + '\n');
}
async function responseDigest(response) {
  const hash = createHash('sha256');
  if (!response.body) throw new Error('GitHub returned an empty asset stream');
  for await (const chunk of response.body) hash.update(chunk);
  return hash.digest('hex');
}
async function assetInventory(directory) {
  return Promise.all(
    (await readdir(directory)).sort().map(async (name) => {
      const file = path.join(directory, name);
      const metadata = await stat(file);
      if (!metadata.isFile()) throw new Error('Unexpected directory in release assets');
      return { name, sha256: await fileHash(file), size: metadata.size };
    }),
  );
}
export async function verifyReleaseAssets(directory, tag, commit) {
  const descriptor = JSON.parse(await readFile(path.join(directory, 'release-assets.json'), 'utf8'));
  if (descriptor.schemaVersion !== 1 || descriptor.tag !== tag || descriptor.commit !== commit)
    throw new Error('Release artifact source identity mismatch');
  const manifest = JSON.parse(await readFile(path.join(directory, 'release-manifest.json'), 'utf8'));
  validateReleaseTag(tag, manifest.version);
  if (
    manifest.gitCommit !== commit ||
    manifest.dirtyPaths?.length !== 0 ||
    manifest.notarization?.status !== 'Accepted' ||
    !['codesign', 'spctl', 'stapler'].every((check) => manifest.validation?.includes(check))
  )
    throw new Error('Unverified release manifest');
  const files = await assetInventory(directory);
  const dataFiles = files.filter((file) => file.name !== 'release-assets.json');
  if (JSON.stringify(dataFiles) !== JSON.stringify(descriptor.files)) throw new Error('Release asset inventory/hash mismatch');
  const checksumText = await readFile(path.join(directory, 'SHA256SUMS'), 'utf8');
  if (JSON.stringify(manifest.artifacts) !== JSON.stringify(checksumText.trim().split('\n')))
    throw new Error('Manifest artifacts differ from SHA256SUMS');
  const binaries = parseChecksums(checksumText);
  const names = [...attachments, ...binaries.map((binary) => binary.name)].sort();
  if (JSON.stringify(dataFiles.map((file) => file.name)) !== JSON.stringify(names)) throw new Error('Unexpected release asset set');
  for (const binary of binaries)
    if (!dataFiles.some((file) => file.name === binary.name && file.sha256 === binary.sha256)) throw new Error('Release checksum mismatch');
  return files;
}
export async function publishRelease({ directory, tag, commit, repository, token }, request = fetch) {
  if (!/^[\w.-]+\/[\w.-]+$/.test(repository) || !token) throw new Error('Missing GitHub publication configuration');
  const files = await verifyReleaseAssets(directory, tag, commit);
  const marker = `<!-- wsl-release:${commit}:${digest(JSON.stringify(files))} -->`;
  const api = `https://api.github.com/repos/${repository}/releases`;
  const headers = { Authorization: `Bearer ${token}`, Accept: 'application/vnd.github+json', 'X-GitHub-Api-Version': '2022-11-28' };
  async function call(url, method = 'GET', data) {
    const response = await request(url, {
      method,
      headers: { ...headers, 'Content-Type': 'application/json' },
      ...(data ? { body: JSON.stringify(data) } : {}),
    });
    if (!response.ok) throw new Error(`GitHub release API failed: HTTP ${response.status}`);
    return response.json();
  }
  async function verifyRemoteTag() {
    let object = (await call(`https://api.github.com/repos/${repository}/git/ref/tags/${encodeURIComponent(tag)}`)).object;
    const seen = new Set();
    while (object?.type === 'tag') {
      if (seen.has(object.sha)) throw new Error('Invalid annotated tag chain');
      seen.add(object.sha);
      object = (await call(`https://api.github.com/repos/${repository}/git/tags/${object.sha}`)).object;
    }
    if (object?.type !== 'commit' || object.sha !== commit) throw new Error('Remote release tag moved or does not match the built commit');
  }
  await verifyRemoteTag();
  // List includes drafts for push-authorized callers; get-by-tag alone cannot establish their absence.
  const matching = [];
  for (let page = 1; ; page++) {
    const list = await call(`${api}?per_page=100&page=${page}`);
    if (!Array.isArray(list)) throw new Error('Invalid GitHub release listing');
    matching.push(...list.filter((release) => release.tag_name === tag));
    if (list.length < 100) break;
  }
  if (matching.length > 1) throw new Error('Multiple releases exist for this tag');
  let release = matching[0];
  if (!release) {
    release = await call(api, 'POST', {
      tag_name: tag,
      target_commitish: commit,
      name: `${tag} — macOS Apple Silicon`,
      draft: true,
      prerelease: tag.includes('-'),
      body: `${marker}\n\nDeveloper ID signed and notarized competition package. Installation needs the first-run Docker downloads and login. See INSTALLATION.zh-CN.md and ACCEPTANCE.md for installation and functional acceptance limits; hosted CI does not establish clean-machine or live-model acceptance.`,
    });
  } else {
    if (!release.draft) throw new Error('Published releases are immutable in this workflow');
    if (!release.body?.includes(marker)) throw new Error('Existing draft belongs to a different commit or asset set');
  }
  const allowedNames = new Set(files.map((file) => file.name));
  if (
    release.assets.some((asset) => !allowedNames.has(asset.name)) ||
    new Set(release.assets.map((asset) => asset.name)).size !== release.assets.length
  )
    throw new Error('Existing draft has unexpected assets');
  for (const file of files) {
    const previous = release.assets.find((asset) => asset.name === file.name);
    if (previous) {
      const response = await request(previous.url, { headers: { ...headers, Accept: 'application/octet-stream' } });
      if (!response.ok || (await responseDigest(response)) !== file.sha256) throw new Error(`Draft asset hash mismatch: ${file.name}`);
      continue;
    }
    const upload = new URL(release.upload_url.replace(/\{.*$/, ''));
    upload.searchParams.set('name', file.name);
    const response = await request(upload, {
      method: 'POST',
      headers: { ...headers, 'Content-Type': 'application/octet-stream', 'Content-Length': String(file.size) },
      body: createReadStream(path.join(directory, file.name)),
      duplex: 'half',
    });
    if (!response.ok) throw new Error(`Release asset upload failed: HTTP ${response.status}`);
    const uploaded = await response.json();
    const verify = await request(uploaded.url, { headers: { ...headers, Accept: 'application/octet-stream' } });
    if (!verify.ok || (await responseDigest(verify)) !== file.sha256) throw new Error(`Uploaded release asset hash mismatch: ${file.name}`);
  }
  const final = await call(`${api}/${release.id}`);
  if (
    !final.draft ||
    !final.body?.includes(marker) ||
    final.assets.length !== files.length ||
    final.assets.some((asset) => !allowedNames.has(asset.name))
  )
    throw new Error('Draft changed before publication');
  await verifyRemoteTag();
  await call(`${api}/${release.id}`, 'PATCH', { draft: false, prerelease: tag.includes('-') });
}
if (process.argv[1] && fileURLToPath(import.meta.url) === path.resolve(process.argv[1])) {
  const tag = process.env.RELEASE_TAG;
  const commit = execFileSync('git', ['rev-parse', 'HEAD'], { cwd: root, encoding: 'utf8' }).trim();
  if (process.argv[2] === 'validate-tag') {
    const metadata = JSON.parse(await readFile(path.join(root, 'apps/desktop/package.json'), 'utf8'));
    validateReleaseTag(tag, metadata.version);
    const tagged = execFileSync('git', ['rev-parse', `refs/tags/${tag}^{commit}`], { cwd: root, encoding: 'utf8' }).trim();
    if (commit !== tagged || execFileSync('git', ['status', '--porcelain'], { cwd: root, encoding: 'utf8' }).trim())
      throw new Error('Release requires a clean checkout of the exact existing tag');
    await appendFile(process.env.GITHUB_OUTPUT, `tag=${tag}\ncommit=${commit}\n`);
  } else if (process.argv[2] === 'prepare-assets')
    await prepareReleaseAssets(path.join(root, 'apps/desktop/release'), path.join(root, 'apps/desktop/release/github-assets'), tag, commit);
  else if (process.argv[2] === 'publish')
    await publishRelease({
      directory: path.resolve(process.argv[3]),
      tag,
      commit,
      repository: process.env.GITHUB_REPOSITORY,
      token: process.env.GH_TOKEN,
    });
  else throw new Error('Usage: release-ci.mjs validate-tag|prepare-assets|publish directory');
}
