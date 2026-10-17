import assert from 'node:assert/strict';
import { spawn, spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import {
  createWriteStream,
  existsSync,
  lstatSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  readlinkSync,
  realpathSync,
  writeFileSync,
} from 'node:fs';
import { createRequire } from 'node:module';
import path from 'node:path';
import process from 'node:process';
import { finished } from 'node:stream/promises';
import { fileURLToPath } from 'node:url';
import { fileHash } from './packaging/payload-lib.mjs';

const repository = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const sha256 = (bytes) => createHash('sha256').update(bytes).digest('hex');

export function childEnvironment(parent, directory) {
  const env = { ...parent, WSL_E2E_EVIDENCE_DIR: directory, PLAYWRIGHT_JSON_OUTPUT_FILE: path.join(directory, 'report.json') };
  delete env.ELECTRON_RUN_AS_NODE;
  env.WSL_APP_CONTROL_EVIDENCE ??= path.join(directory, 'app-control');
  return env;
}

export function summarizeReport(report) {
  assert.ok(report && Array.isArray(report.suites) && report.stats, 'Missing Playwright report');
  const tests = [];
  function visit(suite, parents) {
    const titles = [...parents, suite.title].filter(Boolean);
    for (const spec of suite.specs ?? []) {
      for (const test of spec.tests) {
        assert.ok(['expected', 'unexpected', 'flaky', 'skipped'].includes(test.status), 'Unknown Playwright test outcome');
        if (test.status === 'expected') {
          assert.ok(['passed', 'failed'].includes(test.expectedStatus), 'Unexecuted test cannot count as expected');
          assert.equal(test.results.at(-1)?.status, test.expectedStatus, 'Claimed outcome does not match the final attempt');
        }
        tests.push({
          file: spec.file,
          title: [...titles, spec.title].join(' > '),
          project: test.projectName,
          status: test.status,
          expectedStatus: test.expectedStatus,
          attempts: test.results.map((result) => result.status),
          annotations: test.annotations ?? [],
        });
      }
    }
    for (const child of suite.suites ?? []) visit(child, titles);
  }
  for (const suite of report.suites) visit(suite, []);
  for (const status of ['expected', 'unexpected', 'flaky', 'skipped']) {
    assert.equal(report.stats[status], tests.filter((test) => test.status === status).length, `Inconsistent Playwright ${status} count`);
  }
  return { stats: report.stats, tests, skipped: tests.filter((test) => test.status === 'skipped') };
}

function sourceFingerprint(root) {
  const git = (args) => spawnSync('git', args, { cwd: root, encoding: 'utf8', maxBuffer: 16 * 1024 * 1024 });
  const revision = git(['rev-parse', 'HEAD']);
  if (revision.status !== 0) return null;
  const diff = git(['diff', '--binary', 'HEAD']);
  const untracked = git(['ls-files', '--others', '--exclude-standard', '-z']);
  assert.equal(diff.status, 0, 'Cannot fingerprint tracked changes');
  assert.equal(untracked.status, 0, 'Cannot inventory untracked source');
  const files = untracked.stdout
    .split('\0')
    .filter(Boolean)
    .sort()
    .map((file) => {
      const full = path.join(root, file);
      const stat = lstatSync(full);
      assert.ok(stat.isFile() || stat.isSymbolicLink(), `Unsupported untracked source: ${file}`);
      return { path: file, sha256: sha256(stat.isSymbolicLink() ? readlinkSync(full) : readFileSync(full)) };
    });
  return { commit: revision.stdout.trim(), trackedDiffSha256: sha256(diff.stdout), untracked: files };
}

function buildFingerprint(root) {
  const files = {};
  function visit(directory) {
    for (const entry of readdirSync(path.join(root, directory), { withFileTypes: true })) {
      const file = `${directory}/${entry.name}`;
      if (entry.isDirectory()) visit(file);
      else {
        assert.ok(entry.isFile(), `Non-file build artifact: ${file}`);
        files[file] = sha256(readFileSync(path.join(root, file)));
      }
    }
  }
  for (const directory of ['apps/service/out', 'apps/desktop/out']) {
    if (existsSync(path.join(root, directory))) visit(directory);
  }
  return files;
}

async function packagedFingerprint(root, env) {
  if (env.WSL_E2E_TARGET !== 'packaged') return null;
  const selected = path.resolve(root, env.WSL_E2E_APP_PATH ?? 'apps/desktop/release/mac-arm64/Web Studio Lab.app');
  assert.ok(selected.endsWith('.app'), 'Packaged target must select an .app bundle');
  const realPath = realpathSync(selected);
  assert.ok(lstatSync(realPath).isDirectory(), 'Packaged target must be a directory');
  const entries = Object.create(null);
  async function visit(relative) {
    const file = path.join(realPath, relative);
    const stat = lstatSync(file);
    const mode = stat.mode & 0o7777;
    if (stat.isSymbolicLink()) {
      const resolved = path.relative(realPath, realpathSync(file));
      assert.ok(
        resolved !== '..' && !resolved.startsWith(`..${path.sep}`) && !path.isAbsolute(resolved),
        `Link outside packaged bundle: ${relative}`,
      );
      entries[relative] = { type: 'symlink', mode, target: readlinkSync(file) };
    } else if (stat.isDirectory()) {
      entries[relative] = { type: 'directory', mode };
      for (const name of readdirSync(file).sort()) await visit(path.join(relative, name));
    } else {
      assert.ok(stat.isFile(), `Non-file packaged artifact: ${relative}`);
      entries[relative] = { type: 'file', mode, sha256: await fileHash(file) };
    }
  }
  await visit('.');
  for (const file of ['Contents/MacOS/Web Studio Lab', 'Contents/Resources/app.asar'])
    assert.equal(entries[file]?.type, 'file', `Missing packaged artifact: ${file}`);
  return { path: selected, realPath, entries };
}

export async function runE2e({
  root = repository,
  args = [],
  env = process.env,
  cli = createRequire(import.meta.url).resolve('@playwright/test/cli'),
} = {}) {
  const parent = path.join(root, 'test-results/e2e-runs');
  mkdirSync(parent, { recursive: true });
  const directory = mkdtempSync(path.join(parent, 'run-'));
  const metadata = {
    schemaVersion: 1,
    startedAt: new Date().toISOString(),
    node: process.version,
    platform: process.platform,
    arch: process.arch,
    target: env.WSL_E2E_TARGET ?? 'build',
    args,
    source: sourceFingerprint(root),
    buildSha256: buildFingerprint(root),
    packagedArtifact: await packagedFingerprint(root, env),
  };
  writeFileSync(path.join(directory, 'run.json'), JSON.stringify(metadata, null, 2) + '\n', { flag: 'wx' });
  process.stdout.write(`E2E evidence: ${directory}\n`);
  const log = createWriteStream(path.join(directory, 'run.log'), { flags: 'wx' });
  const child = spawn(process.execPath, [cli, 'test', ...args], {
    cwd: root,
    env: childEnvironment(env, directory),
    stdio: ['inherit', 'pipe', 'pipe'],
  });
  let logError = null;
  log.on('error', (error) => {
    logError = error.message;
    child.kill('SIGTERM');
  });
  child.stdout.on('data', (bytes) => {
    process.stdout.write(bytes);
    log.write(bytes);
  });
  child.stderr.on('data', (bytes) => {
    process.stderr.write(bytes);
    log.write(bytes);
  });
  child.on('error', (error) => log.write(error.message + '\n'));
  const interrupt = () => child.kill('SIGINT');
  const terminate = () => child.kill('SIGTERM');
  process.on('SIGINT', interrupt);
  process.on('SIGTERM', terminate);
  const result = await new Promise((resolve) => child.once('close', (code, signal) => resolve({ code, signal })));
  process.off('SIGINT', interrupt);
  process.off('SIGTERM', terminate);
  log.end();
  try {
    await finished(log);
  } catch (error) {
    logError ??= error.message;
  }
  let exitCode = Number.isInteger(result.code) && result.code >= 0 ? result.code : 1;
  if (logError) exitCode ||= 1;
  const summary = {
    ...metadata,
    endedAt: new Date().toISOString(),
    childExitCode: result.code,
    signal: result.signal,
    logError,
    status: 'failed',
  };
  try {
    assert.deepEqual(sourceFingerprint(root), metadata.source, 'Source changed during E2E; the result does not describe one fixed input');
    assert.deepEqual(
      buildFingerprint(root),
      metadata.buildSha256,
      'Build changed during E2E; the result does not describe one fixed build',
    );
    assert.deepEqual(await packagedFingerprint(root, env), metadata.packagedArtifact, 'Packaged App changed during E2E');
    if (args.includes('--list')) summary.status = exitCode === 0 ? 'not_run' : 'failed';
    else {
      Object.assign(summary, summarizeReport(JSON.parse(readFileSync(path.join(directory, 'report.json'), 'utf8'))));
      if (summary.stats.expected === 0 || summary.stats.unexpected > 0 || summary.stats.flaky > 0) exitCode ||= 1;
      summary.status = exitCode === 0 ? 'passed' : 'failed';
    }
  } catch (error) {
    summary.reportError = error.message;
    exitCode ||= 1;
  }
  summary.exitCode = exitCode;
  writeFileSync(path.join(directory, 'summary.json'), JSON.stringify(summary, null, 2) + '\n', { flag: 'wx' });
  process.stdout.write(`E2E ${summary.status}; exit ${exitCode}; evidence retained at ${directory}\n`);
  return { directory, exitCode };
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try {
    process.exitCode = (await runE2e({ args: process.argv.slice(2) })).exitCode;
  } catch (error) {
    process.stderr.write(`E2E runner failed: ${error.message}\n`);
    process.exitCode = 1;
  }
}
