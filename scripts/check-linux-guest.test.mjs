import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import process from 'node:process';
import { test } from 'node:test';
import { fileURLToPath, URL } from 'node:url';
import { checkLinuxGuestReport, requiredGuestTests } from './check-linux-guest.mjs';

function reportFixture() {
  return {
    success: true,
    numTotalTests: requiredGuestTests.length,
    numPassedTests: requiredGuestTests.length,
    numFailedTests: 0,
    numPendingTests: 0,
    numTodoTests: 0,
    numFailedTestSuites: 0,
    numPendingTestSuites: 0,
    testResults: [
      {
        name: '/checkout/apps/service/src/guest-workspace.test.ts',
        status: 'passed',
        assertionResults: requiredGuestTests.map((fullName) => ({ fullName, status: 'passed' })),
      },
    ],
  };
}

test('requires all five process boundaries and accepts a complete passing inventory', () => {
  assert.equal(requiredGuestTests.length, 5);
  assert.equal(checkLinuxGuestReport(reportFixture()), 5);
});

for (const name of requiredGuestTests) {
  test(`rejects a missing required test even when the total stays green: ${name}`, () => {
    const report = reportFixture();
    report.testResults[0].assertionResults.find((result) => result.fullName === name).fullName = 'unrelated passing test';
    assert.throws(() => checkLinuxGuestReport(report), /Required Linux guest test missing/);
  });
}

for (const status of ['pending', 'skipped', 'todo', 'failed', 'disabled', undefined]) {
  test(`rejects an individual ${status} result even when the summary claims success`, () => {
    const report = reportFixture();
    report.testResults[0].assertionResults[0].status = status;
    assert.throws(() => checkLinuxGuestReport(report), /Linux guest test did not pass/);
  });
}

for (const field of ['numFailedTests', 'numPendingTests', 'numTodoTests', 'numFailedTestSuites', 'numPendingTestSuites']) {
  test(`rejects a nonzero ${field}`, () => {
    const report = reportFixture();
    report[field] = 1;
    assert.throws(() => checkLinuxGuestReport(report), /must be zero/);
  });
}

test('rejects NOT_RUN labels, duplicate names and inconsistent counts', () => {
  for (const fullName of ['NOT_RUN cleanup', '[not_run: host /proc ancestry/session mismatch] close', requiredGuestTests[1]]) {
    const report = reportFixture();
    report.testResults[0].assertionResults[0].fullName = fullName;
    assert.throws(() => checkLinuxGuestReport(report), /NOT_RUN|Duplicate/);
  }
  for (const field of ['numTotalTests', 'numPassedTests']) {
    const report = reportFixture();
    report[field] += 1;
    assert.throws(() => checkLinuxGuestReport(report), /inventory|Not every/);
  }
});

test('rejects missing, malformed, empty, wrong-file and failed-suite reports', () => {
  const reports = [undefined, null, {}, { ...reportFixture(), success: false }, { ...reportFixture(), testResults: [] }];
  for (const change of [
    (file) => (file.assertionResults = []),
    (file) => (file.name = '/checkout/other.test.ts'),
    (file) => (file.status = 'failed'),
  ]) {
    const report = reportFixture();
    change(report.testResults[0]);
    reports.push(report);
  }
  for (const report of reports) assert.throws(() => checkLinuxGuestReport(report));
});

for (const kind of ['passed', 'skipped', 'invalid-json', 'missing']) {
  test(`CLI exits truthfully for a ${kind} report`, async (t) => {
    const root = await mkdtemp(path.join(os.tmpdir(), 'wsl-linux-guest-gate-'));
    t.after(() => rm(root, { recursive: true, force: true }));
    const file = path.join(root, 'report.json');
    const report = reportFixture();
    if (kind === 'skipped') report.numPendingTests = 1;
    if (kind !== 'missing') await writeFile(file, kind === 'invalid-json' ? '{' : JSON.stringify(report));
    const result = spawnSync(process.execPath, [fileURLToPath(new URL('./check-linux-guest.mjs', import.meta.url)), file], {
      encoding: 'utf8',
    });
    assert.equal(result.status, kind === 'passed' ? 0 : 1, result.stderr);
    assert.match(kind === 'passed' ? result.stdout : result.stderr, /Linux guest gate (passed|failed)/);
  });
}
