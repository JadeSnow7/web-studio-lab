import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import path from 'node:path';
import process from 'node:process';
import { fileURLToPath } from 'node:url';

export const requiredGuestTests = [
  'returns the complete inventory after nonzero exit, then removes its exclusive directory',
  'rejects symlinks without transferring their targets and retains candidate after process cleanup',
  'retains the exclusive cwd and edits on a synthetic cleanup-confirmation failure (no descendants or model)',
  'close drains final output, preserves the edit and reaps a detached grandchild before acknowledgment',
  'eof drains final output, preserves the edit and reaps a detached grandchild before acknowledgment',
].map((title) => `actual guest run-copy and cleanup boundaries ${title}`);

export function checkLinuxGuestReport(report) {
  assert.ok(report && typeof report === 'object', 'Missing Linux guest report');
  assert.equal(report.success, true, 'Linux guest run did not succeed');
  for (const field of ['numFailedTests', 'numPendingTests', 'numTodoTests', 'numFailedTestSuites', 'numPendingTestSuites']) {
    assert.equal(report[field], 0, `${field} must be zero; NOT_RUN, skips and todos are not passes`);
  }
  assert.ok(Array.isArray(report.testResults) && report.testResults.length === 1, 'Expected exactly the guest-workspace test file');
  const [file] = report.testResults;
  assert.ok(
    typeof file.name === 'string' && file.name.endsWith('/apps/service/src/guest-workspace.test.ts'),
    'Wrong Linux guest test file',
  );
  assert.equal(file.status, 'passed', 'Linux guest test file did not pass');
  assert.ok(Array.isArray(file.assertionResults) && file.assertionResults.length > 0, 'Missing Linux guest test inventory');
  assert.equal(report.numTotalTests, file.assertionResults.length, 'Incomplete Linux guest test inventory');
  assert.equal(report.numPassedTests, file.assertionResults.length, 'Not every Linux guest test passed');
  const passed = new Set();
  for (const result of file.assertionResults) {
    assert.equal(typeof result.fullName, 'string', 'Missing Linux guest test name');
    assert.doesNotMatch(result.fullName, /not_run/i, 'NOT_RUN cannot satisfy the Linux guest gate');
    assert.equal(result.status, 'passed', `Linux guest test did not pass: ${result.fullName}`);
    assert.ok(!passed.has(result.fullName), `Duplicate Linux guest test: ${result.fullName}`);
    passed.add(result.fullName);
  }
  for (const name of requiredGuestTests) assert.ok(passed.has(name), `Required Linux guest test missing: ${name}`);
  return passed.size;
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try {
    assert.equal(process.argv.length, 3, 'Usage: node scripts/check-linux-guest.mjs <vitest-report.json>');
    const count = checkLinuxGuestReport(JSON.parse(await readFile(process.argv[2], 'utf8')));
    process.stdout.write(`Linux guest gate passed: ${count} tests, ${requiredGuestTests.length} required boundaries, no skips or todos.\n`);
  } catch (error) {
    process.stderr.write(`Linux guest gate failed: ${error.message}\n`);
    process.exitCode = 1;
  }
}
