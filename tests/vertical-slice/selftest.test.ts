import test from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { taskSchema, productEventSchema } from './contracts.js';
import { postcondition } from './postcondition.js';
import { changedPaths, hash, inventory, ProductTranscript, safePath, verifyManifest, type Manifest } from './evidence.js';
import { loopbackUrl } from './cdp.js';

// Synthetic self-checks exercise rejection capability, never the product acceptance path.
const task = taskSchema.parse({ schemaVersion: 1, taskId: 'VS001', runId: randomUUID(),
  instruction: 'Change only src/App.tsx so the unique visible [data-testid="greeting"] reads exactly Hello Web Studio. Use one real Agent harness session.',
  allowedPaths: ['src/App.tsx'], initialText: 'Hello baseline', expectedText: 'Hello Web Studio', selector: '[data-testid="greeting"]' });
const taskBytes = JSON.stringify(task, null, 2) + '\n';
const taskSha256 = hash(taskBytes);
const previewUrl = `http://127.0.0.1:5173/?runId=${task.runId}`;
const observation = { url: previewUrl, runId: task.runId, readyState: 'complete', matches: [{ text: 'Hello Web Studio', visible: true }] };
const event = { runId: task.runId, taskSha256, seq: 1, at: new Date().toISOString(), type: 'harness.started',
  pid: 123, sessionId: 'synthetic-session', harness: 'synthetic', version: '1', model: 'synthetic', command: ['synthetic'] };

test('synthetic: strict task and event contracts reject relaxed goals and extra pass claims', () => {
  assert.throws(() => taskSchema.parse({ ...task, allowedPaths: ['src/App.tsx', 'src/main.tsx'] }));
  assert.throws(() => taskSchema.parse({ ...task, expectedText: 'different' }));
  assert.throws(() => productEventSchema.parse({ ...event, passed: true }));
  const frozenBytes = JSON.stringify(task);
  assert.throws(() => Object.assign(task, { expectedText: 'different' }));
  assert.throws(() => Object.assign(task.allowedPaths, { 0: 'src/main.tsx' }));
  assert.throws(() => Object.assign(task.allowedPaths, { 1: 'src/main.tsx' }));
  assert.equal(JSON.stringify(task), frozenBytes);
});
test('synthetic: postcondition rejects initial/wrong/hidden/duplicate/mixed-run/exception observations', () => {
  postcondition(observation, task, previewUrl, []);
  for (const wrong of ['Hello baseline', 'Hello Web Studio ']) assert.throws(() => postcondition({ ...observation, matches: [{ text: wrong, visible: true }] }, task, previewUrl, []));
  assert.throws(() => postcondition({ ...observation, matches: [{ text: 'Hello Web Studio', visible: false }] }, task, previewUrl, []));
  assert.throws(() => postcondition({ ...observation, matches: [...observation.matches, ...observation.matches] }, task, previewUrl, []));
  assert.throws(() => postcondition({ ...observation, runId: randomUUID() }, task, previewUrl, []));
  assert.throws(() => postcondition(observation, task, previewUrl, [{ text: 'synthetic exception' }]));
});
test('synthetic: mixed run/hash, sequence, lifecycle, logs and nonzero exit are rejected', () => {
  const transcript = new ProductTranscript(task.runId, taskSha256);
  for (const wrong of [{ ...event, runId: randomUUID() }, { ...event, taskSha256: '0'.repeat(64) }, { ...event, seq: 2 }]) assert.throws(() => transcript.emit(wrong));
  transcript.emit(event);
  assert.throws(() => transcript.log({ runId: task.runId, taskSha256, at: event.at, source: 'harness', pid: 999, sessionId: event.sessionId, stream: 'stdout', text: 'wrong pid' }));
  transcript.emit({ runId: task.runId, taskSha256, at: event.at, type: 'harness.exited', seq: 2, pid: event.pid, sessionId: event.sessionId, exitCode: 1 });
  assert.throws(() => transcript.assertHarness());
  assert.throws(() => transcript.emit({ runId: task.runId, taskSha256, seq: 3, at: event.at, type: 'app.started', pid: 456, command: ['synthetic'] }));
});
test('synthetic: diff detects add/delete and paths/CDP URLs cannot escape boundaries', () => {
  assert.deepEqual(changedPaths([{ path: 'deleted', size: 1, sha256: 'a' }], [{ path: 'added', size: 1, sha256: 'a' }]), ['added', 'deleted']);
  assert.throws(() => safePath('/tmp/run', '../other/task.json'));
  assert.throws(() => safePath('/tmp/run', '/tmp/task.json'));
  assert.throws(() => loopbackUrl('http://example.com:9222/', 'http:'));
  assert.throws(() => loopbackUrl('http://user:password@localhost:9222/', 'http:'));
});
test('synthetic: manifest refuses content tampering, missing evidence and mixed-run events', () => {
  const root = mkdtempSync(join(tmpdir(), 'vs001-selftest-'));
  try {
    writeFileSync(join(root, 'task.json'), taskBytes);
    for (const name of ['events.ndjson', 'harness.ndjson', 'app.ndjson']) writeFileSync(join(root, name), '');
    const baselineFiles = [{ path: 'synthetic', sha256: hash('synthetic') }];
    const manifest: Manifest = { schemaVersion: 1, runId: task.runId, taskSha256, baseline: { files: baselineFiles, sha256: hash(JSON.stringify(baselineFiles)) },
      identity: null, startedAt: event.at, endedAt: event.at,
      checks: ['B01', 'B02', 'B03', 'B04', 'B05'].map(id => ({ id: id as Manifest['checks'][number]['id'], status: 'failed', performed: false, code: 'synthetic', detail: 'synthetic' })), artifacts: inventory(root) };
    verifyManifest(root, manifest);
    assert.throws(() => verifyManifest(root, { ...manifest, checks: manifest.checks.map(check => ({ ...check, status: 'passed', performed: true })) }));
    assert.throws(() => verifyManifest(root, { ...manifest, checks: manifest.checks.map(check => check.id === 'B05' ? { ...check, status: 'passed', performed: true } : check) }));
    writeFileSync(join(root, 'task.json'), taskBytes + ' ');
    assert.throws(() => verifyManifest(root, manifest));
    writeFileSync(join(root, 'task.json'), taskBytes);
    writeFileSync(join(root, 'events.ndjson'), JSON.stringify({ ...event, runId: randomUUID() }) + '\n');
    assert.throws(() => verifyManifest(root, { ...manifest, artifacts: inventory(root) }));
    writeFileSync(join(root, 'events.ndjson'), '');
    rmSync(join(root, 'app.ndjson'));
    assert.throws(() => verifyManifest(root, manifest));
    assert.equal(readFileSync(join(root, 'task.json'), 'utf8'), taskBytes);
  } finally { rmSync(root, { recursive: true }); }
});
