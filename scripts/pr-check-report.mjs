// Keep this independent of Playwright so malformed/missing evidence can be tested without launching Electron.
export function assessPlaywrightReport(report) {
  const errors = [];
  const tests = [];
  function visit(suite, parents = []) {
    const titles = [...parents, suite.title].filter(Boolean);
    for (const spec of suite.specs ?? []) {
      for (const test of spec.tests ?? []) {
        const results = test.results ?? [];
        const annotations = [...(test.annotations ?? []), ...results.flatMap((result) => result.annotations ?? [])];
        const reasons = [
          ...new Set(
            annotations
              .filter((annotation) => ['skip', 'fixme'].includes(annotation.type))
              .map((annotation) => annotation.description?.trim())
              .filter(Boolean),
          ),
        ];
        const skipped = test.status === 'skipped';
        const configuredSkip =
          skipped && test.expectedStatus === 'skipped' && reasons.length > 0 && results.length === 1 && results[0].status === 'skipped';
        const passed =
          test.status === 'expected' &&
          test.expectedStatus === 'passed' &&
          results.length === 1 &&
          results[0].status === 'passed' &&
          results[0].retry === 0;
        const row = {
          file: spec.file ?? suite.file,
          line: spec.line,
          title: [...titles, spec.title].join(' > '),
          project: test.projectName,
          status: passed ? 'passed' : configuredSkip ? 'skipped' : skipped ? 'not_run' : 'failed',
          outcome: test.status,
          expectedStatus: test.expectedStatus,
          attempts: results.map((result) => ({ status: result.status, retry: result.retry })),
          skipReasons: configuredSkip ? reasons : [],
          notRunReason: skipped && !configuredSkip ? 'No explicit skip reason; possibly blocked by a failed serial dependency.' : undefined,
        };
        tests.push(row);
        if (!passed && !configuredSkip) errors.push(`${row.file}:${row.line} ${row.title}: ${row.status}`);
      }
    }
    for (const child of suite.suites ?? []) visit(child, titles);
  }
  if (!report || !Array.isArray(report.suites)) throw new Error('Missing Playwright suites.');
  for (const suite of report.suites) visit(suite);
  const stats = report.stats;
  const counts = ['expected', 'unexpected', 'flaky', 'skipped'];
  if (!stats || counts.some((key) => !Number.isSafeInteger(stats[key]) || stats[key] < 0)) {
    errors.push('Missing or invalid Playwright statistics.');
  } else {
    if (counts.reduce((sum, key) => sum + stats[key], 0) !== tests.length) {
      errors.push('Total test count does not match report statistics.');
    }
    for (const key of counts) {
      const actual = tests.filter((test) => test.outcome === key).length;
      if (actual !== stats[key]) errors.push(`Report statistics mismatch for ${key}: reported ${stats[key]}, actual ${actual}.`);
    }
    if (stats.unexpected || stats.flaky) errors.push(`Unexpected: ${stats.unexpected}; flaky: ${stats.flaky}.`);
  }
  if (!tests.some((test) => test.status === 'passed')) errors.push('No executed passing tests (empty or all-skipped run).');
  if (!Array.isArray(report.errors) || report.errors.length) errors.push('Missing error list or global Playwright errors.');
  return { status: errors.length ? 'failed' : 'passed', stats, tests, errors };
}
