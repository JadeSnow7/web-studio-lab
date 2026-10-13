import { auditTemplateArchive } from './template-payload.mjs';
/* global process */
import { readFile, access } from 'node:fs/promises';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { root, runtimeRoot, fileHash } from './payload-lib.mjs';
import { readReleaseDocuments, releaseDocuments } from './release-attachments.mjs';
import { auditGuestArchive } from './guest-platform.mjs';

export function requireReleaseCredentials(env, identities) {
  if (!env.CSC_NAME?.startsWith('Developer ID Application:'))
    throw new Error('Release requires CSC_NAME identifying a Developer ID Application certificate');
  if (!identities.includes('"' + env.CSC_NAME + '"')) throw new Error('Selected Developer ID Application signing identity is unavailable');
  const api = env.APPLE_API_KEY && env.APPLE_API_KEY_ID && env.APPLE_API_ISSUER;
  const apple = env.APPLE_ID && env.APPLE_APP_SPECIFIC_PASSWORD && env.APPLE_TEAM_ID;
  const profile = env.APPLE_KEYCHAIN_PROFILE && env.APPLE_KEYCHAIN;
  if (!api && !apple && !profile) throw new Error('Release requires complete notarization credentials or a keychain profile');
}
export function builderSigningSelector(fullIdentity) {
  const prefix = 'Developer ID Application:';
  if (!fullIdentity?.startsWith(prefix)) throw new Error('Builder selector requires a full Developer ID Application identity');
  const selector = fullIdentity.slice(prefix.length).trim();
  if (!selector) throw new Error('Developer ID Application identity has an empty certificate name');
  return selector;
}
export function notaryArgs(env) {
  if (env.APPLE_API_KEY && env.APPLE_API_KEY_ID && env.APPLE_API_ISSUER)
    return ['--key', env.APPLE_API_KEY, '--key-id', env.APPLE_API_KEY_ID, '--issuer', env.APPLE_API_ISSUER];
  if (env.APPLE_KEYCHAIN && env.APPLE_KEYCHAIN_PROFILE)
    return ['--keychain', env.APPLE_KEYCHAIN, '--keychain-profile', env.APPLE_KEYCHAIN_PROFILE];
  return ['--apple-id', env.APPLE_ID, '--password', env.APPLE_APP_SPECIFIC_PASSWORD, '--team-id', env.APPLE_TEAM_ID];
}
export async function verifyPayloads(directory = runtimeRoot) {
  const manifest = JSON.parse(await readFile(path.join(directory, 'dependencies.json'), 'utf8'));
  const lock = JSON.parse(await readFile(path.join(root, 'packaging/dependencies.lock.json'), 'utf8'));
  if (manifest.schemaVersion !== 1 || manifest.platform !== 'darwin-arm64' || manifest.baseImage !== lock.baseImage.reference)
    throw new Error('Invalid dependency manifest or sandbox image');
  const python = lock.sources.find((source) => source.id === 'python');
  if (
    manifest.python.archiveSha256 !== python.sha256 ||
    manifest.python.version !== python.version ||
    manifest.python.path !== 'python/bin/python3' ||
    manifest.python.executable !== manifest.python.path
  )
    throw new Error('Host Python does not match source lock');
  if (
    manifest.guest.path !== 'guest-tools.tar.gz' ||
    manifest.guest.node !== '24.21.0' ||
    manifest.guest.pnpm !== '10.34.6' ||
    manifest.guest.codex !== '0.160.0'
  )
    throw new Error('Guest tools do not match source lock');
  for (const payload of [manifest.python, manifest.guest]) {
    if (
      !Number.isSafeInteger(payload.expandedBytes) ||
      payload.expandedBytes <= 0 ||
      (await fileHash(path.join(directory, payload.path))) !== payload.sha256
    )
      throw new Error(`Missing or corrupt prepared payload: ${payload.path}`);
  }
  auditGuestArchive(await readFile(path.join(directory, manifest.guest.path)));
  if (
    !manifest.template ||
    manifest.template.path !== 'template-dependencies.tar.gz' ||
    manifest.template.platform !== 'linux' ||
    manifest.template.arch !== 'arm64' ||
    manifest.template.libc !== 'glibc'
  )
    throw new Error('Missing template Linux ARM64/glibc payload');
  const templateRoot = path.join(root, 'templates/standard-app');
  execFileSync(process.execPath, ['scripts/template-hash.mjs', '--verify'], { cwd: templateRoot });
  const templateSource = JSON.parse(await readFile(path.join(templateRoot, 'template-manifest.json'), 'utf8'));
  if (
    manifest.template.lockSha256 !== (await fileHash(path.join(templateRoot, 'package-lock.json'))) ||
    manifest.template.contentSha256 !== templateSource.contentSha256
  )
    throw new Error('Prepared template does not match source/lock');
  if ((await fileHash(path.join(directory, manifest.template.path))) !== manifest.template.sha256)
    throw new Error('Missing or corrupt prepared template payload');
  auditTemplateArchive(await readFile(path.join(directory, manifest.template.path)));
  await access(path.join(directory, 'licenses/template/manifest.json'));
  const sourceLock = JSON.parse(await readFile(path.join(directory, 'dependency-sources.json'), 'utf8'));
  if (JSON.stringify(sourceLock) !== JSON.stringify(lock)) throw new Error('Prepared payload source lock differs from tracked lock');
  await access(path.join(directory, 'THIRD-PARTY-NOTICES.md'));
  await access(path.join(directory, 'python/lib'));
  await access(path.join(directory, 'licenses/app/manifest.json'));
  await access(path.join(directory, 'licenses/codex-license.txt'));
  return manifest;
}
export async function releasePreflight(env = process.env, run = execFileSync) {
  if (process.platform !== 'darwin' || process.arch !== 'arm64')
    throw new Error('Competition release requires a macOS Apple Silicon build host');
  await readReleaseDocuments();
  requireReleaseCredentials(env, run('/usr/bin/security', ['find-identity', '-v', '-p', 'codesigning'], { encoding: 'utf8' }));
  await verifyPayloads();
}
export async function auditService(file = path.join(root, 'apps/service/out/index.cjs')) {
  const bytes = await readFile(file, 'utf8');
  if (!bytes.includes('ssh2') || !bytes.includes('SFTP')) throw new Error('Packaged service is missing SSH/SFTP implementation');
  const externalRequires = [...bytes.matchAll(/require\(\s*['"]([^'"]+)['"]\s*\)/g)].map((match) => match[1]);
  const builtins = new Set((await import('node:module')).builtinModules.flatMap((name) => [name, 'node:' + name]));
  // ssh2 deliberately catches absence of its optional accelerators; no remote feature depends on them.
  const optional = new Set(['cpu-features', './crypto/build/Release/sshcrypto.node']);
  const missing = [...new Set(externalRequires.filter((id) => !builtins.has(id) && !optional.has(id)))];
  if (missing.length) throw new Error('Service has unbundled required assets: ' + missing.join(', '));
  return { optionalNativeModules: [...new Set(externalRequires.filter((id) => optional.has(id)))] };
}

export async function sourceFingerprint() {
  const files = execFileSync('git', ['ls-files', '-z', '--cached', '--others', '--exclude-standard'], { cwd: root, encoding: 'utf8' })
    .split('\0')
    .filter(Boolean);
  const inputs = [...new Set(files)]
    .filter(
      (file) =>
        /^(apps|packages|scripts|packaging|templates|\.github)\//.test(file) ||
        releaseDocuments.some((document) => document.source === file) ||
        file === 'docs/development/github-release.md' ||
        /^(package\.json|pnpm-lock\.yaml|pnpm-workspace\.yaml|tsconfig.*\.json|eslint\.config\.js|vitest\.config\.ts|\.gitignore|THIRD-PARTY-NOTICES\.md|LICENSE)$/.test(
          file,
        ),
    )
    .filter((file) => !/(^|\/)(node_modules|out|release|release-internal|generated|cache|\.env|credentials)(\/|$)/.test(file))
    .sort();
  const entries = await Promise.all(inputs.map(async (file) => ({ path: file, sha256: await fileHash(path.join(root, file)) })));
  return { algorithm: 'sha256', lockSha256: await fileHash(path.join(root, 'pnpm-lock.yaml')), files: entries };
}
export function submitNotarization(file, env, run = execFileSync) {
  let output;
  try {
    output = run('/usr/bin/xcrun', ['notarytool', 'submit', file, ...notaryArgs(env), '--wait', '--output-format', 'json'], {
      encoding: 'utf8',
    });
  } catch {
    // execFileSync errors include secret-bearing argv; never propagate that object.
    throw new Error('Notarization submission failed; inspect the Apple notarization account using protected credentials');
  }
  const submission = JSON.parse(output);
  if (submission.status !== 'Accepted') throw new Error(`DMG notarization failed: ${submission.status}`);
  return { id: submission.id, status: submission.status };
}
