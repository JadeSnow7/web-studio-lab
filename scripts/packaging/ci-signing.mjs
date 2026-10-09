/* global process, Buffer */
import { randomBytes } from 'node:crypto';
import { readFile, writeFile, mkdir, rm, access, appendFile } from 'node:fs/promises';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

export function signingTool(command, args, execute = spawnSync) {
  const result = execute(command, args, { encoding: 'utf8' });
  // Import and notarization argv include secrets; do not return the raw process error or stderr.
  if (result.error || result.status !== 0) throw new Error(`CI signing tool failed: ${path.basename(command)}`);
  return result.stdout;
}
export function validateSigningSecrets(env) {
  for (const name of [
    'MACOS_CERTIFICATE_P12_BASE64',
    'MACOS_CERTIFICATE_PASSWORD',
    'MACOS_SIGNING_IDENTITY',
    'APPLE_ID',
    'APPLE_APP_SPECIFIC_PASSWORD',
    'APPLE_TEAM_ID',
  ]) {
    if (!env[name] || (/[\r\n]/.test(env[name]) && name !== 'MACOS_CERTIFICATE_P12_BASE64'))
      throw new Error(`Missing or invalid CI signing configuration: ${name}`);
  }
  if (!env.MACOS_SIGNING_IDENTITY.startsWith('Developer ID Application:'))
    throw new Error('CI requires a Developer ID Application identity');
  if (!/^[A-Z0-9]{10}$/.test(env.APPLE_TEAM_ID)) throw new Error('Invalid Apple team identifier');
  const encoded = env.MACOS_CERTIFICATE_P12_BASE64.replace(/\s/g, '');
  if (!encoded || !/^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/.test(encoded))
    throw new Error('Invalid certificate base64');
  for (const name of ['RUNNER_TEMP', 'GITHUB_ENV'])
    if (!env[name] || !path.isAbsolute(env[name])) throw new Error(`Invalid runner path: ${name}`);
  return encoded;
}
export async function setupSigning(env, run = signingTool) {
  const encoded = validateSigningSecrets(env);
  const directory = path.join(env.RUNNER_TEMP, 'wsl-release-signing');
  await mkdir(directory, { mode: 0o700 });
  const keychain = path.join(directory, 'release.keychain-db');
  const original = [...run('/usr/bin/security', ['list-keychains', '-d', 'user']).matchAll(/"([^"\n]+)"/g)].map((match) => match[1]);
  if (!original.length) throw new Error('Cannot determine runner keychain search list');
  await writeFile(path.join(directory, 'state.json'), JSON.stringify({ original, keychain }), { mode: 0o600 });
  const certificate = path.join(directory, 'certificate.p12');
  await writeFile(certificate, Buffer.from(encoded, 'base64'), { mode: 0o600 });
  const password = randomBytes(32).toString('hex');
  run('/usr/bin/security', ['create-keychain', '-p', password, keychain]);
  run('/usr/bin/security', ['set-keychain-settings', '-lut', '21600', keychain]);
  run('/usr/bin/security', ['unlock-keychain', '-p', password, keychain]);
  run('/usr/bin/security', [
    'import',
    certificate,
    '-k',
    keychain,
    '-P',
    env.MACOS_CERTIFICATE_PASSWORD,
    '-T',
    '/usr/bin/codesign',
    '-T',
    '/usr/bin/security',
  ]);
  run('/usr/bin/security', ['set-key-partition-list', '-S', 'apple-tool:,apple:,codesign:', '-s', '-k', password, keychain]);
  run('/usr/bin/security', ['list-keychains', '-d', 'user', '-s', keychain, ...original]);
  run('/usr/bin/xcrun', [
    'notarytool',
    'store-credentials',
    'wsl-release',
    '--apple-id',
    env.APPLE_ID,
    '--team-id',
    env.APPLE_TEAM_ID,
    '--password',
    env.APPLE_APP_SPECIFIC_PASSWORD,
    '--keychain',
    keychain,
  ]);
  await rm(certificate);
  await appendFile(
    env.GITHUB_ENV,
    `CSC_NAME=${env.MACOS_SIGNING_IDENTITY}\nAPPLE_KEYCHAIN=${keychain}\nAPPLE_KEYCHAIN_PROFILE=wsl-release\n`,
  );
}
export async function cleanupSigning(env, run = signingTool) {
  const directory = path.join(env.RUNNER_TEMP, 'wsl-release-signing');
  let state;
  try {
    state = JSON.parse(await readFile(path.join(directory, 'state.json'), 'utf8'));
  } catch (error) {
    if (error.code === 'ENOENT') {
      await rm(directory, { recursive: true, force: true });
      return;
    }
    throw error;
  }
  const expected = path.join(directory, 'release.keychain-db');
  if (
    state.keychain !== expected ||
    !Array.isArray(state.original) ||
    !state.original.length ||
    state.original.some((name) => typeof name !== 'string' || !path.isAbsolute(name))
  )
    throw new Error('Invalid CI keychain cleanup state');
  try {
    run('/usr/bin/security', ['list-keychains', '-d', 'user', '-s', ...state.original]);
    let exists = true;
    try {
      await access(expected);
    } catch (error) {
      if (error.code === 'ENOENT') exists = false;
      else throw error;
    }
    if (exists) run('/usr/bin/security', ['delete-keychain', expected]);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
}
if (process.argv[1] && fileURLToPath(import.meta.url) === path.resolve(process.argv[1])) {
  if (process.env.GITHUB_ACTIONS !== 'true' || process.platform !== 'darwin')
    throw new Error('Signing setup is only available on the macOS GitHub Actions runner');
  if (process.argv[2] === 'setup') await setupSigning(process.env);
  else if (process.argv[2] === 'cleanup') await cleanupSigning(process.env);
  else throw new Error('Usage: ci-signing.mjs setup|cleanup');
}
