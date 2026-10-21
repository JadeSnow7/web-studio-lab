import assert from 'node:assert/strict';
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import process from 'node:process';
import { test } from 'node:test';
import { childEnvironment, runE2e, summarizeReport } from './run-e2e.mjs';

function report() {
  return {
    stats: { expected: 1, unexpected: 0, flaky: 0, skipped: 1 },
    suites: [
      {
        title: 'fixture.spec.ts',
        suites: [
          {
            title: 'suite',
            specs: [
              {
                title: 'normal',
                file: 'fixture.spec.ts',
                tests: [{ status: 'expected', expectedStatus: 'passed', results: [{ status: 'passed' }], annotations: [] }],
              },
              {
                title: 'live',
                file: 'fixture.spec.ts',
                tests: [
                  {
                    status: 'skipped',
                    expectedStatus: 'skipped',
                    results: [{ status: 'skipped' }],
                    annotations: [{ type: 'skip', description: 'requires explicit live authorization' }],
                  },
                ],
              },
            ],
          },
        ],
      },
    ],
  };
}

test('removes Electron Node mode only from the child and retains explicit caller configuration', () => {
  const parent = { ELECTRON_RUN_AS_NODE: '1', PATH: '/fixture', WSL_MOTA_MODEL_LIVE: '1', WSL_APP_CONTROL_EVIDENCE: '/chosen' };
  const child = childEnvironment(parent, '/evidence');
  assert.equal(parent.ELECTRON_RUN_AS_NODE, '1');
  assert.equal(child.ELECTRON_RUN_AS_NODE, undefined);
  assert.equal(child.PATH, parent.PATH);
  assert.equal(child.WSL_MOTA_MODEL_LIVE, '1');
  assert.equal(child.WSL_APP_CONTROL_EVIDENCE, '/chosen');
  assert.equal(child.PLAYWRIGHT_JSON_OUTPUT_FILE, path.join('/evidence', 'report.json'));
});

test('summarizes actual skip reasons and does not count skipped tests as passes', () => {
  const summary = summarizeReport(report());
  assert.deepEqual(summary.stats, { expected: 1, unexpected: 0, flaky: 0, skipped: 1 });
  assert.equal(summary.skipped.length, 1);
  assert.match(summary.skipped[0].title, /suite.*live/);
  assert.equal(summary.skipped[0].annotations[0].description, 'requires explicit live authorization');
});

test('rejects malformed or inconsistent reports instead of inventing a green result', () => {
  for (const value of [null, {}, { stats: report().stats, suites: [] }, { ...report(), stats: { ...report().stats, expected: 9 } }]) {
    assert.throws(() => summarizeReport(value));
  }
});

test('rejects a claimed green outcome when the recorded attempt failed', () => {
  const value = report();
  value.suites[0].suites[0].specs[0].tests[0].results[0].status = 'failed';
  assert.throws(() => summarizeReport(value), /final attempt/);
});

for (const kind of ['passed', 'failed', 'missing-report', 'all-skipped', 'listed', 'mutated-build']) {
  test(`runner preserves independent artifacts and truthful outcome: ${kind}`, async (t) => {
    const root = mkdtempSync(path.join(tmpdir(), 'wsl-e2e-runner-'));
    t.after(() => rmSync(root, { recursive: true, force: true }));
    const cli = path.join(root, 'fixture.cjs');
    const fixtureReport = report();
    if (kind === 'all-skipped') {
      fixtureReport.stats = { expected: 0, unexpected: 0, flaky: 0, skipped: 2 };
      Object.assign(fixtureReport.suites[0].suites[0].specs[0].tests[0], {
        status: 'skipped',
        expectedStatus: 'skipped',
        results: [{ status: 'skipped' }],
      });
    }
    if (kind === 'mutated-build') {
      mkdirSync(path.join(root, 'apps/desktop/out/main'), { recursive: true });
      writeFileSync(path.join(root, 'apps/desktop/out/main/index.js'), 'initial');
    }
    writeFileSync(
      cli,
      `const fs = require('node:fs');
if (process.env.ELECTRON_RUN_AS_NODE !== undefined) process.exit(31);
process.stdout.write('fixture stdout\\n'); process.stderr.write('fixture stderr\\n');
${kind === 'missing-report' ? '' : `fs.writeFileSync(process.env.PLAYWRIGHT_JSON_OUTPUT_FILE, ${JSON.stringify(JSON.stringify(fixtureReport))});`}
${kind === 'mutated-build' ? "fs.appendFileSync('apps/desktop/out/main/index.js', 'changed');" : ''}
process.exitCode = ${kind === 'failed' ? 7 : 0};
`,
    );
    const options = { root, cli, env: { ...process.env, ELECTRON_RUN_AS_NODE: '1' }, args: kind === 'listed' ? ['--list'] : [] };
    const first = await runE2e(options);
    const second = await runE2e(options);
    assert.notEqual(first.directory, second.directory);
    const summary = JSON.parse(readFileSync(path.join(first.directory, 'summary.json'), 'utf8'));
    assert.equal(first.exitCode, kind === 'passed' || kind === 'listed' ? 0 : kind === 'failed' ? 7 : 1);
    assert.equal(summary.status, kind === 'listed' ? 'not_run' : kind === 'passed' ? 'passed' : 'failed');
    const log = readFileSync(path.join(first.directory, 'run.log'), 'utf8');
    assert.match(log, /fixture stdout/);
    assert.match(log, /fixture stderr/);
    assert.ok(readFileSync(path.join(second.directory, 'summary.json')).length > 0);
  });
}

function packagedFixture(t, useDefault = false) {
  const base = mkdtempSync(path.join(tmpdir(), 'wsl-e2e-package-'));
  t.after(() => rmSync(base, { recursive: true, force: true }));
  const root = path.join(base, 'repo');
  const bundle = useDefault ? path.join(root, 'apps/desktop/release/mac-arm64/Web Studio Lab.app') : path.join(base, 'Selected Bundle.app');
  mkdirSync(root, { recursive: true });
  for (const directory of ['MacOS', 'Resources', 'Frameworks/Fixture.framework/Versions/A', 'Frameworks/Fixture.framework/Versions/B'])
    mkdirSync(path.join(bundle, 'Contents', directory), { recursive: true });
  for (const file of [
    'MacOS/Web Studio Lab',
    'Resources/app.asar',
    'Resources/payload.tar.gz',
    'Frameworks/Fixture.framework/Versions/A/Fixture',
    'Frameworks/Fixture.framework/Versions/B/Fixture',
  ])
    writeFileSync(path.join(bundle, 'Contents', file), file);
  chmodSync(path.join(bundle, 'Contents/MacOS/Web Studio Lab'), 0o755);
  symlinkSync('A', path.join(bundle, 'Contents/Frameworks/Fixture.framework/Versions/Current'));
  const cli = path.join(root, 'fixture.cjs');
  const env = { ...process.env, WSL_E2E_TARGET: 'packaged' };
  if (useDefault) delete env.WSL_E2E_APP_PATH;
  else env.WSL_E2E_APP_PATH = bundle;
  const prepare = (mutation = '') =>
    writeFileSync(
      cli,
      `const fs = require('node:fs');
fs.writeFileSync('launched', 'yes');
fs.writeFileSync(process.env.PLAYWRIGHT_JSON_OUTPUT_FILE, ${JSON.stringify(JSON.stringify(report()))});
${mutation}
`,
    );
  prepare();
  return { root, bundle, cli, env, prepare };
}

for (const useDefault of [false, true]) {
  test(`fingerprints the selected packaged bundle and its internal links: default=${useDefault}`, async (t) => {
    const fixture = packagedFixture(t, useDefault);
    const result = await runE2e(fixture);
    assert.equal(result.exitCode, 0);
    const { packagedArtifact } = JSON.parse(readFileSync(path.join(result.directory, 'summary.json'), 'utf8'));
    assert.equal(packagedArtifact.path, fixture.bundle);
    assert.equal(packagedArtifact.realPath, realpathSync(fixture.bundle));
    assert.match(packagedArtifact.entries['Contents/Resources/app.asar'].sha256, /^[a-f0-9]{64}$/);
    assert.equal(packagedArtifact.entries['Contents/MacOS/Web Studio Lab'].mode, 0o755);
    assert.equal(packagedArtifact.entries['Contents/Frameworks/Fixture.framework/Versions/Current'].target, 'A');
  });
}

for (const kind of ['binary', 'asar', 'payload', 'permissions', 'link', 'added-file', 'deleted-file']) {
  test(`rejects packaged ${kind} drift despite an unchanged workspace build and green test report`, async (t) => {
    const fixture = packagedFixture(t);
    const files = { binary: 'MacOS/Web Studio Lab', asar: 'Resources/app.asar', payload: 'Resources/payload.tar.gz' };
    const file = JSON.stringify(path.join(fixture.bundle, 'Contents', files[kind] ?? 'MacOS/Web Studio Lab'));
    const link = JSON.stringify(path.join(fixture.bundle, 'Contents/Frameworks/Fixture.framework/Versions/Current'));
    const mutation =
      kind === 'permissions'
        ? `fs.chmodSync(${file}, 0o700);`
        : kind === 'link'
          ? `fs.unlinkSync(${link}); fs.symlinkSync('B', ${link});`
          : kind === 'added-file'
            ? `fs.writeFileSync(${JSON.stringify(path.join(fixture.bundle, 'new-file'))}, 'new');`
            : kind === 'deleted-file'
              ? `fs.unlinkSync(${JSON.stringify(path.join(fixture.bundle, 'Contents/Resources/payload.tar.gz'))});`
              : `fs.appendFileSync(${file}, 'changed');`;
    fixture.prepare(mutation);
    const result = await runE2e(fixture);
    assert.equal(result.exitCode, 1);
    const summary = JSON.parse(readFileSync(path.join(result.directory, 'summary.json'), 'utf8'));
    assert.equal(summary.childExitCode, 0);
    assert.equal(summary.status, 'failed');
    assert.match(summary.reportError, /Packaged App changed/);
  });
}

for (const kind of ['missing', 'incomplete', 'escaping-link']) {
  test(`rejects a ${kind} packaged input before launching tests`, async (t) => {
    const fixture = packagedFixture(t);
    if (kind === 'missing') fixture.env.WSL_E2E_APP_PATH += '.missing.app';
    else if (kind === 'incomplete') rmSync(path.join(fixture.bundle, 'Contents/Resources/app.asar'));
    else symlinkSync(fixture.root, path.join(fixture.bundle, 'outside'));
    await assert.rejects(runE2e(fixture));
    assert.equal(existsSync(path.join(fixture.root, 'launched')), false);
  });
}
