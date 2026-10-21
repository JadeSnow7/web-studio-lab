import { spawn, execFileSync } from 'node:child_process';
import { createWriteStream } from 'node:fs';
import { appendFile, mkdir, mkdtemp, readFile, writeFile } from 'node:fs/promises';
import { dirname, join, resolve } from 'node:path';
import process from 'node:process';
import { finished } from 'node:stream/promises';
import { fileURLToPath } from 'node:url';
import { assessPlaywrightReport } from './pr-check-report.mjs';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
process.chdir(root);
await mkdir('test-results/pr-check', { recursive: true });
const directory = await mkdtemp(resolve('test-results/pr-check/run-'));
const reportPath = join(directory, 'playwright.json');
const manifest = {
  schemaVersion: 1,
  status: 'running',
  startedAt: new Date().toISOString(),
  expectedHead: process.env.PR_HEAD_SHA,
  base: process.env.PR_BASE_SHA,
  workflowEventSha: process.env.GITHUB_SHA,
  workflowDefinitionSha: process.env.GITHUB_WORKFLOW_SHA,
  runId: process.env.GITHUB_RUN_ID,
  runAttempt: process.env.GITHUB_RUN_ATTEMPT,
  platform: process.platform,
  architecture: process.arch,
  node: process.version,
  steps: [],
  errors: [],
};
const save = () => writeFile(join(directory, 'summary.json'), JSON.stringify(manifest, null, 2) + '\n');
const git = (...args) => execFileSync('git', args, { cwd: root, encoding: 'utf8' }).trim();
const environment = { ...process.env };
// Only change child environment. These checks never opt into a real model, guest or packaged target.
for (const name of Object.keys(environment)) {
  if (name.startsWith('WSL_') || ['ELECTRON_RUN_AS_NODE', 'NODE_OPTIONS', 'TSESTREE_SINGLE_RUN'].includes(name)) delete environment[name];
}

async function run(name, command, args, extraEnvironment = {}) {
  const step = { name, command: [command, ...args], startedAt: new Date().toISOString(), status: 'running', log: `${name}.log` };
  manifest.steps.push(step);
  await save();
  const log = createWriteStream(join(directory, step.log), { flags: 'wx' });
  log.write(`$ ${JSON.stringify(step.command)}\n`);
  const child = spawn(command, args, { cwd: root, env: { ...environment, ...extraEnvironment }, stdio: ['ignore', 'pipe', 'pipe'] });
  for (const stream of [child.stdout, child.stderr]) {
    stream.on('data', (data) => {
      log.write(data);
      process.stdout.write(data);
    });
  }
  child.on('error', (error) => {
    step.error = error.message;
    log.write(`${error.stack}\n`);
  });
  await new Promise((resolveExit) => {
    child.on('close', (code, signal) => {
      step.exitCode = code;
      step.signal = signal;
      resolveExit();
    });
  });
  step.status = step.exitCode === 0 && !step.error ? 'passed' : 'failed';
  step.finishedAt = new Date().toISOString();
  log.end(`\nstatus=${step.status} exitCode=${step.exitCode} signal=${step.signal}\n`);
  await finished(log);
  await save();
  return step.status === 'passed';
}

async function notRun(name, reason, emptyDiff = false) {
  manifest.steps.push({ name, status: emptyDiff ? 'skipped' : 'not_run', reason });
  await save();
}

try {
  if (![manifest.expectedHead, manifest.base].every((sha) => /^[a-f0-9]{40}$/.test(sha ?? ''))) {
    throw new Error('PR_HEAD_SHA and PR_BASE_SHA must be full immutable commit SHAs.');
  }
  manifest.actualHead = git('rev-parse', 'HEAD');
  manifest.tree = git('rev-parse', 'HEAD^{tree}');
  manifest.initialWorktree = git('status', '--porcelain', '--untracked-files=all');
  if (manifest.actualHead !== manifest.expectedHead || manifest.initialWorktree) {
    throw new Error('Expected exact PR head and a clean worktree.');
  }
  if (process.platform !== 'darwin' || process.arch !== 'arm64' || process.version !== 'v24.21.0') {
    throw new Error('PR checks require macOS ARM64 with Node 24.21.0.');
  }
  manifest.pnpm = execFileSync('pnpm', ['--version'], { encoding: 'utf8', env: environment }).trim();
  if (manifest.pnpm !== '10.34.6') throw new Error('PR checks require pnpm 10.34.6.');
  manifest.mergeBase = git('merge-base', manifest.base, manifest.expectedHead);
  manifest.changedFiles = execFileSync(
    'git',
    ['diff', '--name-only', '--diff-filter=ACMR', '-z', `${manifest.base}...${manifest.expectedHead}`],
    { cwd: root, encoding: 'utf8' },
  )
    .split('\0')
    .filter(Boolean);
  manifest.maintainedDirectories = ['apps', 'packages', 'e2e', 'scripts', 'templates/standard-app'];
  await save();
  const rootInstalled = await run('install-root', 'pnpm', ['install', '--frozen-lockfile']);
  const templateInstalled = await run('install-template', 'npm', [
    '--prefix',
    'templates/standard-app',
    'ci',
    '--ignore-scripts',
    '--no-audit',
    '--no-fund',
  ]);
  if (!rootInstalled || !templateInstalled) throw new Error('Dependency installation failed; remaining checks cannot run.');

  await run('report-gate-tests', 'node', ['--test', 'scripts/pr-check-report.test.mjs']);
  await run('lint-maintained', 'pnpm', ['exec', 'eslint', ...manifest.maintainedDirectories]);
  await run('format-maintained', 'pnpm', ['exec', 'prettier', '--check', ...manifest.maintainedDirectories]);
  const changedCode = manifest.changedFiles.filter((file) => /\.(?:[cm]?js|jsx|tsx?)$/.test(file));
  if (changedCode.length) await run('lint-changed', 'pnpm', ['exec', 'eslint', '--no-warn-ignored', '--', ...changedCode]);
  else await notRun('lint-changed', 'No changed JavaScript or TypeScript files; maintained-directory lint still runs.', true);
  if (manifest.changedFiles.length) {
    await run('format-changed', 'pnpm', ['exec', 'prettier', '--check', '--ignore-unknown', '--', ...manifest.changedFiles]);
  } else await notRun('format-changed', 'No added/modified/renamed/copied files against the PR merge base.', true);
  await run('typecheck', 'pnpm', ['typecheck']);
  // Preserve every stage of pnpm test, collecting later results even when an earlier stage fails.
  await run('offline-vitest', 'pnpm', ['exec', 'vitest', 'run']);
  await run('offline-packaging', 'pnpm', ['test:packaging']);
  await run('offline-external-builds', 'pnpm', ['test:external-builds']);
  await run('offline-edu-source', 'pnpm', ['test:edu-source']);
  await run('baseline-selftest', 'pnpm', ['baseline:selftest']);
  await run('docs', 'node', ['scripts/check-docs.mjs']);
  if (await run('build', 'pnpm', ['build'])) {
    manifest.buildHead = git('rev-parse', 'HEAD');
    if (manifest.buildHead !== manifest.expectedHead || git('status', '--porcelain', '--untracked-files=all')) {
      throw new Error('Source changed during checks/build; E2E would not validate the expected PR head.');
    }
    await run('electron-e2e', 'pnpm', ['exec', 'playwright', 'test', '--workers=1', '--retries=0', '--reporter=list,json'], {
      PLAYWRIGHT_JSON_OUTPUT_NAME: reportPath,
    });
  } else await notRun('electron-e2e', 'Build failed; no valid current-head application is available.');
  try {
    manifest.e2e = assessPlaywrightReport(JSON.parse(await readFile(reportPath, 'utf8')));
    await writeFile(join(directory, 'e2e-verdict.json'), JSON.stringify(manifest.e2e, null, 2) + '\n');
    manifest.errors.push(...manifest.e2e.errors);
  } catch (error) {
    manifest.errors.push(`Missing or invalid E2E report: ${error.message}`);
  }
} catch (error) {
  manifest.errors.push(error.message);
} finally {
  const required = [
    'install-root',
    'install-template',
    'report-gate-tests',
    'lint-maintained',
    'format-maintained',
    'lint-changed',
    'format-changed',
    'typecheck',
    'offline-vitest',
    'offline-packaging',
    'offline-external-builds',
    'offline-edu-source',
    'baseline-selftest',
    'docs',
    'build',
    'electron-e2e',
  ];
  for (const name of required) {
    if (!manifest.steps.some((step) => step.name === name))
      await notRun(name, 'Earlier preparation or source validation failed; see errors.');
  }
  try {
    manifest.finalHead = git('rev-parse', 'HEAD');
    manifest.finalWorktree = git('status', '--porcelain', '--untracked-files=all');
    if (manifest.finalHead !== manifest.expectedHead || manifest.finalWorktree) {
      manifest.errors.push('Final source differs from the exact clean PR head.');
    }
  } catch (error) {
    manifest.errors.push(`Final source could not be verified: ${error.message}`);
  }
  const failedStep = manifest.steps.some((step) => !['passed', 'skipped'].includes(step.status));
  manifest.status = !manifest.errors.length && !failedStep && manifest.e2e?.status === 'passed' ? 'passed' : 'failed';
  manifest.finishedAt = new Date().toISOString();
  await save();
  const summary = `PR head checks: ${manifest.status}\nCandidate: ${manifest.expectedHead}\nChecked HEAD: ${manifest.actualHead ?? 'unverified'}\nBase: ${manifest.base}\nReports: ${directory}\n`;
  process.stdout.write(summary);
  if (process.env.GITHUB_STEP_SUMMARY) await appendFile(process.env.GITHUB_STEP_SUMMARY, summary);
  process.exitCode = manifest.status === 'passed' ? 0 : 1;
}
