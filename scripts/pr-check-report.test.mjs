import assert from 'node:assert/strict';
import test from 'node:test';
import { assessPlaywrightReport } from './pr-check-report.mjs';

function report(testOverrides = {}, statsOverrides = {}) {
  return {
    suites: [
      {
        file: 'example.spec.ts',
        specs: [
          {
            file: 'example.spec.ts',
            line: 1,
            title: 'example',
            tests: [
              {
                status: 'expected',
                expectedStatus: 'passed',
                results: [{ status: 'passed', retry: 0 }],
                ...testOverrides,
              },
            ],
          },
        ],
      },
    ],
    stats: { expected: 1, unexpected: 0, flaky: 0, skipped: 0, ...statsOverrides },
    errors: [],
  };
}

test('accepts an executed pass and lists a separately configured skip with its reason', () => {
  const value = report();
  value.suites[0].specs[0].tests.push({
    status: 'skipped',
    expectedStatus: 'skipped',
    annotations: [{ type: 'skip', description: 'Requires separately authorized live sandbox.' }],
    results: [{ status: 'skipped', retry: 0 }],
  });
  value.stats.skipped = 1;
  const result = assessPlaywrightReport(value);
  assert.equal(result.status, 'passed');
  assert.deepEqual(result.tests[1].skipReasons, ['Requires separately authorized live sandbox.']);
});

test('rejects missing, truncated and internally inconsistent reports', () => {
  assert.throws(() => assessPlaywrightReport(undefined), /Missing Playwright suites/);
  for (const value of [{ suites: [] }, { ...report(), stats: undefined }, report({}, { expected: 2 })]) {
    assert.equal(assessPlaywrightReport(value).status, 'failed');
  }
});

test('rejects per-outcome count swaps even when the total test count is unchanged', () => {
  const result = assessPlaywrightReport(report({}, { expected: 0, skipped: 1 }));
  assert.equal(result.status, 'failed');
  assert.ok(result.errors.some((error) => error.includes('mismatch for expected')));
  assert.ok(result.errors.some((error) => error.includes('mismatch for skipped')));
});

test('rejects a lone passing result labelled retry 1', () => {
  const result = assessPlaywrightReport(report({ results: [{ status: 'passed', retry: 1 }] }));
  assert.equal(result.status, 'failed');
  assert.equal(result.tests[0].status, 'failed');
});

test('rejects serial did-not-run even when aggregate unexpected is zero', () => {
  const value = report({ status: 'skipped', results: [{ status: 'skipped' }] }, { expected: 0, skipped: 1 });
  const result = assessPlaywrightReport(value);
  assert.equal(result.status, 'failed');
  assert.equal(result.tests[0].status, 'not_run');
});

test('rejects all-skipped reports, including otherwise valid explicit skips', () => {
  const value = report(
    {
      status: 'skipped',
      expectedStatus: 'skipped',
      annotations: [{ type: 'skip', description: 'Explicit reason.' }],
      results: [{ status: 'skipped' }],
    },
    { expected: 0, skipped: 1 },
  );
  assert.equal(assessPlaywrightReport(value).status, 'failed');
});

test('rejects flaky, failed and unexpected-pass outcomes and global errors', () => {
  for (const status of ['flaky', 'unexpected']) {
    assert.equal(assessPlaywrightReport(report({ status })).status, 'failed');
  }
  assert.equal(assessPlaywrightReport(report({ results: [{ status: 'failed' }, { status: 'passed' }] })).status, 'failed');
  assert.equal(assessPlaywrightReport(report({ expectedStatus: 'failed' })).status, 'failed');
  const value = report();
  value.errors.push({ message: 'Worker failed during teardown.' });
  assert.equal(assessPlaywrightReport(value).status, 'failed');
});
