/* global process */
import path from 'node:path';
import { readFile, readdir, writeFile, mkdir } from 'node:fs/promises';
import { execFileSync, spawnSync } from 'node:child_process';
import { root, fileHash } from './payload-lib.mjs';
import { copyReleaseAttachments } from './release-attachments.mjs';
import { verifySignedRuntime } from './signed-runtime.mjs';
import { releasePreflight, verifyPayloads, sourceFingerprint, submitNotarization, builderSigningSelector } from './release-gates.mjs';

const unsigned = process.argv.includes('--unsigned');
if (process.argv.some((arg, index) => index > 1 && arg !== '--unsigned')) throw new Error('Usage: package-release.mjs [--unsigned]');
if (unsigned) await verifyPayloads();
else await releasePreflight();
const sourceInputs = unsigned ? null : await sourceFingerprint();
const env = { ...process.env, WSL_INTERNAL_UNSIGNED: unsigned ? '1' : '0' };
const pnpmEntry = process.env.npm_execpath;
if (!pnpmEntry || !/pnpm\.(?:cjs|mjs|js)$/.test(pnpmEntry))
  throw new Error('Invoke packaging through pnpm@10.34.6 package or package:unsigned');
const pnpmVersion = execFileSync(process.execPath, [pnpmEntry, '--version'], { encoding: 'utf8' }).trim();
if (pnpmVersion !== '10.34.6') throw new Error('Competition packaging requires pnpm@10.34.6');
function pnpm(args) {
  const result = spawnSync(process.execPath, [pnpmEntry, ...args], { cwd: root, env, stdio: 'inherit' });
  if (result.error) throw new Error('Unable to execute pinned pnpm');
  if (result.status !== 0) throw new Error(`Packaging step failed (exit ${result.status}): pnpm ${args.join(' ')}`);
}
pnpm(['build']);
const args = ['--filter', '@wsl/desktop', 'exec', 'electron-builder', '--mac', '--arm64', '--publish', 'never'];
if (unsigned)
  args.push(
    '--config.mac.identity=null',
    '--config.mac.notarize=false',
    '--config.forceCodeSigning=false',
    '--config.directories.output=release-internal',
  );
else args.push('--config.mac.identity=' + builderSigningSelector(env.CSC_NAME));
pnpm(args);
if (unsigned) {
  process.stdout.write('Internal unsigned test artifacts only: apps/desktop/release-internal. This is not a competition release.\n');
} else {
  const release = path.join(root, 'apps/desktop/release');
  const app = path.join(release, 'mac-arm64/Web Studio Lab.app');
  verifySignedRuntime(app);
  execFileSync('/usr/sbin/spctl', ['--assess', '--type', 'execute', '--verbose=2', app], { stdio: 'inherit' });
  execFileSync('/usr/bin/xcrun', ['stapler', 'validate', app], { stdio: 'inherit' });
  const artifacts = (await readdir(release)).filter((file) => /\.(dmg|zip)$/.test(file)).sort();
  if (artifacts.filter((file) => file.endsWith('.dmg')).length !== 1 || artifacts.filter((file) => file.endsWith('.zip')).length !== 1)
    throw new Error('Expected exactly one signed DMG and ZIP');
  const dmg = path.join(
    release,
    artifacts.find((file) => file.endsWith('.dmg')),
  );
  // The App has already been notarized by builder. Submit and staple the enclosing DMG too.
  const submission = submitNotarization(dmg, env);
  execFileSync('/usr/bin/xcrun', ['stapler', 'staple', dmg], { stdio: 'inherit' });
  execFileSync('/usr/bin/xcrun', ['stapler', 'validate', dmg], { stdio: 'inherit' });
  execFileSync('/usr/bin/codesign', ['--verify', '--strict', dmg], { stdio: 'inherit' });
  execFileSync('/usr/sbin/spctl', ['--assess', '--type', 'open', '--context', 'context:primary-signature', '--verbose=2', dmg], {
    stdio: 'inherit',
  });
  const resource = path.join(app, 'Contents/Resources/runtime');
  const dependencies = await verifyPayloads(resource);
  const checksums = await Promise.all(artifacts.map(async (file) => `${await fileHash(path.join(release, file))}  ${file}`));
  const finalSourceInputs = await sourceFingerprint();
  if (JSON.stringify(finalSourceInputs) !== JSON.stringify(sourceInputs))
    throw new Error('Source inputs changed during release build; no release manifest will be published');
  const metadata = JSON.parse(await readFile(path.join(root, 'apps/desktop/package.json'), 'utf8'));
  const gitCommit = execFileSync('git', ['rev-parse', 'HEAD'], { cwd: root, encoding: 'utf8' }).trim();
  const dirtyPaths = execFileSync('git', ['status', '--porcelain'], { cwd: root, encoding: 'utf8' }).trim().split('\n').filter(Boolean);
  await mkdir(path.join(release, 'artifacts'), { recursive: true });
  await copyReleaseAttachments(resource, path.join(release, 'artifacts'));
  await writeFile(path.join(release, 'artifacts/SHA256SUMS'), checksums.join('\n') + '\n');
  await writeFile(
    path.join(release, 'artifacts/release-manifest.json'),
    JSON.stringify(
      {
        schemaVersion: 1,
        version: metadata.version,
        gitCommit,
        dirtyPaths,
        sourceInputs,
        dependencies,
        notarization: { id: submission.id, status: submission.status },
        artifacts: checksums,
        validation: ['codesign', 'spctl', 'stapler'],
        cleanMachineAcceptance: 'not_run',
      },
      null,
      2,
    ) + '\n',
  );
  process.stdout.write('Signed and notarized artifacts validated. Clean-machine product acceptance is a separate check.\n');
}
