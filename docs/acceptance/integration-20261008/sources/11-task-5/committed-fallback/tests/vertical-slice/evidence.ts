import { createHash } from 'node:crypto';
import { readdirSync, readFileSync, lstatSync } from 'node:fs';
import { join, resolve, sep } from 'node:path';
import { z } from 'zod';
import { identitySchema, productEventSchema, rawLogSchema, sha256Schema, taskSchema } from './contracts.js';
import { postcondition } from './postcondition.js';

export const hash = (bytes: string | Buffer): string => createHash('sha256').update(bytes).digest('hex');
export const generatedDirectories = ['node_modules', 'dist', '.vite'] as const;
export function safePath(root: string, relative: string): string {
  if (!relative || relative.includes('\\') || relative.startsWith('/') || relative.split('/').some(p => p === '..' || p === '.' || p === '')) {
    throw new Error(`Unsafe evidence path: ${relative}`);
  }
  const path = resolve(root, relative);
  if (!path.startsWith(resolve(root) + sep)) throw new Error(`Path escapes root: ${relative}`);
  return path;
}
export function fileList(root: string, excludedTopLevel: readonly string[] = []): string[] {
  function walk(dir: string, prefix: string): string[] {
    return readdirSync(dir).sort().flatMap(name => {
      if (!prefix && excludedTopLevel.includes(name)) return [];
      const relative = prefix ? `${prefix}/${name}` : name;
      const path = safePath(root, relative);
      const stat = lstatSync(path);
      if (stat.isSymbolicLink()) throw new Error(`Symlink is not permitted in evidence: ${relative}`);
      if (stat.isDirectory()) return walk(path, relative);
      if (!stat.isFile()) throw new Error(`Non-file artifact: ${relative}`);
      return [relative];
    });
  }
  return walk(root, '');
}
export function inventory(root: string, excluded: readonly string[] = []) {
  return fileList(root, excluded).map(path => {
    const bytes = readFileSync(safePath(root, path));
    return { path, size: bytes.length, sha256: hash(bytes) };
  });
}
export function baselineFingerprint(repo: string) {
  const paths = ['docs/acceptance/VS001.md', 'package.json', 'package-lock.json', 'tsconfig.json',
    ...fileList(join(repo, 'tests/vertical-slice')).map(p => `tests/vertical-slice/${p}`),
    ...fileList(join(repo, 'fixtures/vertical-slice')).map(p => `fixtures/vertical-slice/${p}`)].sort();
  const files = paths.map(path => ({ path, sha256: hash(readFileSync(safePath(repo, path))) }));
  return { sha256: hash(JSON.stringify(files)), files };
}
export function changedPaths(before: ReturnType<typeof inventory>, after: ReturnType<typeof inventory>): string[] {
  const previous = new Map(before.map(file => [file.path, file.sha256]));
  const current = new Map(after.map(file => [file.path, file.sha256]));
  return [...new Set([...previous.keys(), ...current.keys()])].sort().filter(path => previous.get(path) !== current.get(path));
}

export class ProductTranscript {
  private events: ReturnType<typeof productEventSchema.parse>[] = [];
  private logs: ReturnType<typeof rawLogSchema.parse>[] = [];
  constructor(readonly runId: string, readonly taskSha256: string) {}
  emit(input: unknown) {
    const event = productEventSchema.parse(input);
    if (event.runId !== this.runId || event.taskSha256 !== this.taskSha256 || event.seq !== this.events.length + 1) {
      throw new Error('Product event run/task/sequence mismatch');
    }
    const order = ['harness.started', 'harness.exited', 'app.started', 'app.ready'];
    if (event.type !== order[this.events.length]) throw new Error('Product event lifecycle is out of order');
    const start = this.events[0];
    if (event.type === 'harness.exited') {
      if (start?.type !== 'harness.started' || start.pid !== event.pid || start.sessionId !== event.sessionId) throw new Error('Harness provenance mismatch');
    }
    if (event.type === 'app.started') {
      const exit = this.events[1];
      if (exit?.type !== 'harness.exited' || exit.exitCode !== 0) throw new Error('App cannot start after a failed harness');
    }
    if (event.type === 'app.ready') {
      const app = this.events[2];
      if (app?.type !== 'app.started' || app.pid !== event.identity.pid) throw new Error('App provenance mismatch');
    }
    const last = this.events.at(-1);
    if (last && event.at < last.at) throw new Error('Event time moved backwards');
    this.events.push(event);
    return event;
  }
  log(input: unknown) {
    const entry = rawLogSchema.parse(input);
    if (entry.runId !== this.runId || entry.taskSha256 !== this.taskSha256) throw new Error('Raw log run/task mismatch');
    const source = this.events.find(event => event.type === `${entry.source}.started`);
    if (!source || !('pid' in source) || source.pid !== entry.pid) throw new Error('Raw log pid has no matching start event');
    if (entry.source === 'harness' && (source.type !== 'harness.started' || source.sessionId !== entry.sessionId)) throw new Error('Raw log harness session mismatch');
    if (entry.source === 'app' && entry.sessionId !== undefined) throw new Error('App log cannot claim a harness session');
    if (entry.at < source.at) throw new Error('Raw log precedes process start');
    this.logs.push(entry);
    return entry;
  }
  assertHarness() {
    const exit = this.events[1];
    if (exit?.type !== 'harness.exited' || exit.exitCode !== 0) throw new Error('Real harness successful exit is missing');
    if (!this.logs.some(log => log.source === 'harness')) throw new Error('Harness raw output is missing');
  }
  assertApplication(identity: unknown) {
    const ready = this.events[3];
    if (ready?.type !== 'app.ready' || JSON.stringify(ready.identity) !== JSON.stringify(identity)) throw new Error('Ready event does not match returned app identity');
    // A silent application is valid; begin/end records delimit its raw output window.
  }
}

export const checkSchema = z.object({
  id: z.enum(['B01', 'B02', 'B03', 'B04', 'B05']),
  status: z.enum(['passed', 'failed', 'undetermined']), performed: z.boolean(), code: z.string(), detail: z.string(),
}).strict();
export const manifestSchema = z.object({
  schemaVersion: z.literal(1), runId: z.uuid(), taskSha256: sha256Schema,
  baseline: z.object({ sha256: sha256Schema, files: z.array(z.object({ path: z.string(), sha256: sha256Schema }).strict()) }).strict(),
  identity: z.object({ pid: z.number(), webContentsId: z.number(), targetId: z.string(), previewUrl: z.string(), cdpEndpoint: z.string() }).strict().nullable(),
  startedAt: z.iso.datetime(), endedAt: z.iso.datetime(), checks: z.array(checkSchema).length(5),
  artifacts: z.array(z.object({ path: z.string(), size: z.number().int().nonnegative(), sha256: sha256Schema }).strict()),
}).strict();
export type Manifest = z.infer<typeof manifestSchema>;
export function verifyManifest(root: string, raw: unknown): void {
  const manifest = manifestSchema.parse(raw);
  if (hash(readFileSync(join(root, 'task.json'))) !== manifest.taskSha256) throw new Error('Frozen task bytes do not match manifest');
  const task = taskSchema.parse(JSON.parse(readFileSync(join(root, 'task.json'), 'utf8')));
  if (task.runId !== manifest.runId) throw new Error('Frozen task belongs to another run');
  if (hash(JSON.stringify(manifest.baseline.files)) !== manifest.baseline.sha256) throw new Error('Baseline fingerprint mismatch');
  if (new Set(manifest.artifacts.map(file => file.path)).size !== manifest.artifacts.length) throw new Error('Duplicate manifest artifact');
  for (const artifact of manifest.artifacts) {
    const bytes = readFileSync(safePath(root, artifact.path));
    if (bytes.length !== artifact.size || hash(bytes) !== artifact.sha256) throw new Error(`Artifact was changed: ${artifact.path}`);
  }
  const actual = fileList(root, ['work', 'manifest.json']);
  if (JSON.stringify(actual.sort()) !== JSON.stringify(manifest.artifacts.map(file => file.path).sort())) throw new Error('Manifest omits or invents artifacts');
  if (manifest.endedAt < manifest.startedAt) throw new Error('Evidence end precedes start');
  if (manifest.checks.map(check => check.id).join(',') !== 'B01,B02,B03,B04,B05') throw new Error('Manifest does not contain the five ordered checks');
  for (const file of ['environment.json', 'report.json', 'observation.json', 'postcondition.json', 'diff.json']) {
    if (!manifest.artifacts.some(artifact => artifact.path === file)) continue;
    const value = JSON.parse(readFileSync(join(root, file), 'utf8'));
    if (value.runId !== manifest.runId || value.taskSha256 !== manifest.taskSha256) throw new Error(`${file} belongs to another run/task`);
    if ((file === 'observation.json' || file === 'report.json') && JSON.stringify(value.identity) !== JSON.stringify(manifest.identity)) throw new Error(`${file} app identity mismatch`);
    if (file === 'report.json' && JSON.stringify(value.checks) !== JSON.stringify(manifest.checks)) throw new Error('Report checks differ from manifest');
  }
  if (manifest.artifacts.some(artifact => artifact.path === 'cdp.ndjson')) {
    for (const line of readFileSync(join(root, 'cdp.ndjson'), 'utf8').split('\n').filter(Boolean)) {
      const entry = JSON.parse(line);
      if (entry.runId !== manifest.runId || entry.taskSha256 !== manifest.taskSha256) throw new Error('CDP evidence belongs to another run/task');
    }
  }
  const transcript = new ProductTranscript(manifest.runId, manifest.taskSha256);
  for (const line of readFileSync(join(root, 'events.ndjson'), 'utf8').split('\n').filter(Boolean)) transcript.emit(JSON.parse(line));
  for (const source of ['harness', 'app']) {
    for (const line of readFileSync(join(root, `${source}.ndjson`), 'utf8').split('\n').filter(Boolean)) {
      const entry = JSON.parse(line);
      if (entry.kind === 'boundary') {
        if (entry.runId !== manifest.runId || entry.taskSha256 !== manifest.taskSha256) throw new Error('Log boundary belongs to another run');
      } else transcript.log(entry);
    }
  }
  if (manifest.checks[0].status === 'passed') transcript.assertHarness();
  if (manifest.checks[1].status === 'passed') {
    if (!manifest.identity) throw new Error('Passed B02 requires app identity');
    transcript.assertApplication(identitySchema.parse(manifest.identity));
  }
  if (manifest.checks[4].status === 'passed') {
    if (!manifest.identity) throw new Error('Passed B05 requires app identity');
    for (const path of ['environment.json', 'report.json', 'before-files.json', 'after-files.json', 'diff.json',
      'events.ndjson', 'harness.ndjson', 'app.ndjson', 'cdp.ndjson', 'observation.json', 'postcondition.json', 'screenshot.png']) {
      if (!manifest.artifacts.some(artifact => artifact.path === path)) throw new Error(`Passed B05 lacks ${path}`);
    }
    const observation = JSON.parse(readFileSync(join(root, 'observation.json'), 'utf8'));
    const condition = JSON.parse(readFileSync(join(root, 'postcondition.json'), 'utf8'));
    const cdpEntries = readFileSync(join(root, 'cdp.ndjson'), 'utf8').split('\n').filter(Boolean).map(line => JSON.parse(line));
    const exceptions = cdpEntries.filter(entry => entry.entry?.message?.method === 'Runtime.exceptionThrown').map(entry => entry.entry.message.params);
    let conditionError: string | undefined;
    try { postcondition(observation.value, task, manifest.identity.previewUrl, exceptions); }
    catch (error) { conditionError = error instanceof Error ? error.message : String(error); }
    const conditionPassed = conditionError === undefined;
    if (condition.error !== conditionError || JSON.stringify(condition.exceptions) !== JSON.stringify(exceptions)) throw new Error('Postcondition error/exception evidence differs from re-evaluation');
    if (condition.passed !== conditionPassed || (manifest.checks[3].status === 'passed') !== conditionPassed) throw new Error('Recorded B04/postcondition disagrees with CDP observation');
    const capture = cdpEntries.find(entry => entry.entry?.direction === 'sent' && entry.entry?.message?.method === 'Page.captureScreenshot');
    const response = capture && cdpEntries.find(entry => entry.entry?.direction === 'received' && entry.entry?.message?.id === capture.entry.message.id);
    if (!response?.entry.message.result?.data) throw new Error('Screenshot has no matching CDP capture response');
    const screenshot = readFileSync(join(root, 'screenshot.png'));
    if (!screenshot.equals(Buffer.from(response.entry.message.result.data, 'base64'))) throw new Error('PNG does not match the CDP capture response');
    if (screenshot.length <= 8 || !screenshot.subarray(0, 8).equals(Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]))) throw new Error('Screenshot has no PNG signature');
    const observedResponse = cdpEntries.find(entry => entry.entry?.direction === 'received' && entry.entry?.message?.result?.result?.value === JSON.stringify(observation.value));
    if (!observedResponse || !cdpEntries.some(entry => entry.entry?.direction === 'sent' && entry.entry.message.id === observedResponse.entry.message.id && entry.entry.message.method === 'Runtime.evaluate')) throw new Error('Observation has no matching raw Runtime.evaluate request/response');
  }
}
