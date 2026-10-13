import { randomUUID } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { appendFileSync, cpSync, existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { taskSchema, identitySchema, type ProductAdapter, type StartedApplication, type Observation } from './contracts.js';
import { assertObservation, postcondition } from './postcondition.js';
import { CdpConnection, timeout } from './cdp.js';
import { baselineFingerprint, changedPaths, generatedDirectories, hash, inventory, ProductTranscript, safePath, verifyManifest, type Manifest } from './evidence.js';

const repo = resolve(dirname(fileURLToPath(import.meta.url)), '../..');
const runId = randomUUID();
const startedAt = new Date().toISOString();
const runDir = join(repo, 'records/vertical-slice', runId);
mkdirSync(dirname(runDir), { recursive: true });
mkdirSync(runDir); // An existing run is never reused or overwritten.
const write = (path: string, bytes: string | Buffer) => writeFileSync(safePath(runDir, path), bytes, { flag: 'wx' });
const json = (path: string, value: unknown) => write(path, JSON.stringify(value, null, 2) + '\n');
const task = taskSchema.parse({
  schemaVersion: 1, taskId: 'VS001', runId,
  instruction: 'Change only src/App.tsx so the unique visible [data-testid="greeting"] reads exactly Hello Web Studio. Use one real Agent harness session.',
  allowedPaths: ['src/App.tsx'], initialText: 'Hello baseline', expectedText: 'Hello Web Studio', selector: '[data-testid="greeting"]',
});
const taskBytes = JSON.stringify(task, null, 2) + '\n';
const taskSha256 = hash(taskBytes);
write('task.json', taskBytes);
const transcript = new ProductTranscript(runId, taskSha256);
const append = (path: string, value: unknown) => appendFileSync(safePath(runDir, path), JSON.stringify(value) + '\n');
const bound = (value: Record<string, unknown>) => ({ runId, taskSha256, at: new Date().toISOString(), ...value });
for (const file of ['events.ndjson', 'harness.ndjson', 'app.ndjson', 'cdp.ndjson', 'runner.ndjson']) write(file, '');
for (const source of ['harness', 'app', 'cdp']) append(`${source}.ndjson`, bound({ kind: 'boundary', phase: 'begin' }));
const checks: Manifest['checks'] = ['B01', 'B02', 'B03', 'B04', 'B05'].map(id => ({
  id: id as Manifest['checks'][number]['id'], status: 'undetermined', performed: false, code: 'not_reached', detail: 'No observation was performed',
}));
let stage = 'setup';
let baseline: ReturnType<typeof baselineFingerprint> | undefined;
let before: ReturnType<typeof inventory> | undefined;
let identity: Manifest['identity'] = null;
let app: StartedApplication | undefined;
let cdp: CdpConnection | undefined;
let activeCheck = 0;
let observation: Observation | undefined;
let callbacksOpen = true;
const callbackErrors: string[] = [];
const cleanups: (() => Promise<void>)[] = [];
const cleanupErrors: string[] = [];
const controller = new AbortController();
const totalTimer = setTimeout(() => controller.abort(new Error('VS001 total deadline 120s exceeded')), 120_000);
const workspaceDir = join(runDir, 'work');
const adapterPath = join(repo, 'src/vertical-slice/adapter.ts');
function snapshot(label: string) {
  const files = inventory(workspaceDir, generatedDirectories);
  const snapshotDir = join(runDir, label);
  mkdirSync(snapshotDir);
  for (const file of files) {
    const destination = safePath(snapshotDir, file.path);
    mkdirSync(dirname(destination), { recursive: true });
    writeFileSync(destination, readFileSync(safePath(workspaceDir, file.path)), { flag: 'wx' });
  }
  return files;
}
function pass(index: number, detail: string) {
  checks[index] = { ...checks[index], status: 'passed', performed: true, code: 'ok', detail };
}
function callback<T>(path: string, parse: () => T): void {
  try {
    if (!callbacksOpen) throw new Error('Product callback after cleanup completed');
    append(path, parse());
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    callbackErrors.push(message);
    append('runner.ndjson', bound({ kind: 'callback-error', message }));
    throw error;
  }
}
try {
  baseline = baselineFingerprint(repo);
  json('environment.json', {
    runId, taskSha256, baseline, startedAt, node: process.version, platform: process.platform, arch: process.arch,
    gitHead: execFileSync('git', ['rev-parse', 'HEAD'], { cwd: repo, encoding: 'utf8' }).trim(),
    gitStatus: execFileSync('git', ['status', '--porcelain=v1', '--untracked-files=all'], { cwd: repo, encoding: 'utf8' }),
    adapterPath: 'src/vertical-slice/adapter.ts', adapterSha256: existsSync(adapterPath) ? hash(readFileSync(adapterPath)) : null,
    workspaceGeneratedDirectoriesIgnored: generatedDirectories,
    workspaceEvidence: 'before/ and after/ mirror every non-generated file; work/ is excluded from the artifact inventory',
    timeouts: { totalMs: 120_000, cdpRequestMs: 10_000, cleanupMs: 10_000 },
  });
  cpSync(join(repo, 'fixtures/vertical-slice/page'), workspaceDir, { recursive: true, errorOnExist: true, force: false });
  before = snapshot('before');
  json('before-files.json', before);
  if (!existsSync(adapterPath)) {
    stage = 'target_missing';
    for (const check of checks) Object.assign(check, { status: 'failed', performed: false, code: 'target_missing', detail: 'src/vertical-slice/adapter.ts does not exist' });
  } else {
    stage = 'adapter_import';
    const adapter: ProductAdapter = await timeout(import(pathToFileURL(adapterPath).href), 10_000, 'adapter import', controller.signal);
    if (typeof adapter.executeTask !== 'function') throw new Error('Adapter does not export executeTask(task, context)');
    stage = 'B01'; activeCheck = 0;
    app = await timeout(adapter.executeTask(task, {
      workspaceDir, taskSha256, signal: controller.signal,
      registerCleanup(cleanup) {
        if (!callbacksOpen || controller.signal.aborted) throw new Error('Cannot register a new resource after abort or cleanup');
        if (typeof cleanup !== 'function') throw new Error('Resource cleanup must be a function');
        cleanups.push(cleanup);
      },
      emit(event) { callback('events.ndjson', () => transcript.emit(event)); },
      log(entry) { callback(`${entry.source}.ndjson`, () => transcript.log(entry)); },
    }), 120_000, 'executeTask', controller.signal);
    if (typeof app.stop !== 'function') throw new Error('Returned app has no stop()');
    identity = identitySchema.parse({ pid: app.pid, webContentsId: app.webContentsId, targetId: app.targetId, previewUrl: app.previewUrl, cdpEndpoint: app.cdpEndpoint });
    transcript.assertHarness();
    const changed = changedPaths(before, inventory(workspaceDir, generatedDirectories));
    if (JSON.stringify(changed) !== JSON.stringify(task.allowedPaths)) throw new Error(`Expected only src/App.tsx to change; actual: ${JSON.stringify(changed)}`);
    if (callbackErrors.length) throw new Error(`Rejected product callbacks: ${callbackErrors.join('; ')}`);
    pass(0, 'Harness successfully exited with original output and only the allowed file changed');
    stage = 'B02'; activeCheck = 1;
    transcript.assertApplication(identity);
    process.kill(identity.pid, 0);
    cdp = await CdpConnection.connect(identity, entry => append('cdp.ndjson', bound({ kind: 'cdp', entry })), controller.signal);
    observation = await cdp.navigateAndObserve(task, identity, controller.signal);
    json('observation.json', { runId, taskSha256, identity, observedAt: new Date().toISOString(), value: observation });
    process.kill(identity.pid, 0);
    pass(1, 'Live pid, Electron discovery and the same page target navigated to the current preview URL');
    stage = 'B03'; activeCheck = 2;
    assertObservation(observation, task, identity.previewUrl);
    pass(2, 'Baseline Runtime.evaluate observed this run with a unique greeting selector');
    stage = 'B04'; activeCheck = 3;
    try {
      postcondition(observation, task, identity.previewUrl, cdp.exceptions);
    } catch (error) {
      checks[3] = { ...checks[3], status: 'failed', performed: true, code: 'postcondition_failed', detail: error instanceof Error ? error.message : String(error) };
    }
    if (checks[3].status !== 'failed') pass(3, 'Unique visible exact title and no observed Runtime.exceptionThrown');
    stage = 'B05'; activeCheck = 4;
    write('screenshot.png', await cdp.screenshot(controller.signal));
    // An exception emitted during screenshot collection also invalidates B04.
    if (cdp.exceptions.length) Object.assign(checks[3], { status: 'failed', performed: true, code: 'runtime_exception', detail: 'Runtime.exceptionThrown was captured during screenshot collection' });
    pass(4, 'Screenshot came from Page.captureScreenshot on the observed CDP connection');
  }
} catch (error) {
  const message = error instanceof Error ? error.stack ?? error.message : String(error);
  append('runner.ndjson', bound({ kind: 'error', stage, message }));
  if (stage.startsWith('B')) checks[activeCheck] = { ...checks[activeCheck], status: 'failed', performed: true, code: 'product_failure', detail: message };
  else for (const check of checks) Object.assign(check, { status: 'undetermined', code: 'baseline_or_environment_error', detail: message });
} finally {
  controller.abort(new Error('Acceptance completed; release this run resources'));
  if (cdp) {
    try { await cdp.close(); } catch (error) { cleanupErrors.push(`CDP: ${String(error)}`); }
  }
  if (app) {
    try { await timeout(app.stop(), 10_000, 'application stop'); } catch (error) { cleanupErrors.push(`stop: ${String(error)}`); }
  }
  for (const [index, cleanup] of cleanups.toReversed().entries()) {
    try { await timeout(cleanup(), 10_000, `registered cleanup ${index}`); } catch (error) { cleanupErrors.push(`registered cleanup ${index}: ${String(error)}`); }
  }
  callbacksOpen = false;
  clearTimeout(totalTimer);
  for (const source of ['harness', 'app', 'cdp']) append(`${source}.ndjson`, bound({ kind: 'boundary', phase: 'end' }));
}
try {
  if (before) {
    const after = snapshot('after');
    json('after-files.json', after);
    const changed = changedPaths(before, after);
    json('diff.json', { runId, taskSha256, ignoredGeneratedDirectories: generatedDirectories, changedPaths: changed, before, after });
    if (checks[0].status === 'passed' && JSON.stringify(changed) !== JSON.stringify(task.allowedPaths)) {
      Object.assign(checks[0], { status: 'failed', code: 'cleanup_modified_source', detail: 'Final source diff violates the task after cleanup' });
    }
  }
  if (callbackErrors.length) Object.assign(checks[4], { status: 'failed', performed: true, code: 'callback_rejected', detail: callbackErrors.join('; ') });
  if (cleanupErrors.length) {
    append('runner.ndjson', bound({ kind: 'cleanup-errors', errors: cleanupErrors }));
    Object.assign(checks[4], { status: 'failed', performed: true, code: 'cleanup_failed', detail: cleanupErrors.join('; ') });
  }
  if (!baseline) throw new Error('Initial baseline fingerprint could not be captured');
  if (baselineFingerprint(repo).sha256 !== baseline.sha256) throw new Error('Baseline files changed during acceptance');
  if (observation && identity && cdp) {
    let error: string | undefined;
    try { postcondition(observation, task, identity.previewUrl, cdp.exceptions); }
    catch (failure) {
      error = failure instanceof Error ? failure.message : String(failure);
      Object.assign(checks[3], { status: 'failed', performed: true, code: 'postcondition_failed', detail: error });
    }
    json('postcondition.json', { runId, taskSha256, passed: !error, ...(error ? { error } : {}), exceptions: cdp.exceptions });
  }
  const endedAt = new Date().toISOString();
  json('report.json', { schemaVersion: 1, runId, taskSha256, baselineSha256: baseline.sha256, startedAt, endedAt, stage, identity, cleanupErrors, checks });
  const manifest: Manifest = { schemaVersion: 1, runId, taskSha256, baseline, identity, startedAt, endedAt, checks, artifacts: inventory(runDir, ['work', 'manifest.json']) };
  verifyManifest(runDir, manifest);
  json('manifest.json', manifest);
} catch (error) {
  const message = error instanceof Error ? error.stack ?? error.message : String(error);
  append('runner.ndjson', bound({ kind: 'evidence-error', message }));
  console.error(message);
  for (const check of checks) Object.assign(check, { status: 'undetermined', code: 'evidence_error', detail: message });
  writeFileSync(join(runDir, 'report.json'), JSON.stringify({ runId, taskSha256, stage: 'evidence_error', checks }, null, 2) + '\n');
}
console.log(`run: ${runDir}`);
console.log('1..5');
for (const check of checks) console.log(`${check.status === 'passed' ? 'ok' : 'not ok'} ${check.id} - ${check.status} / ${check.code} / performed=${check.performed}`);
process.exitCode = checks.every(check => check.status === 'passed') ? 0 : checks.some(check => check.status === 'undetermined') ? 2 : 1;
