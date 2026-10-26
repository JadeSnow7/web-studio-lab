// E9 报告机械回归：固定任务集、配对唯一性/一致性校验与负例。node --test scripts/e9-report.test.mjs
import test from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { buildReport, E9InputError, formatReport } from './e9-report.mjs';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const SCRIPT = path.join(ROOT, 'scripts/e9-report.mjs');
const TASKS = JSON.parse(readFileSync(path.join(ROOT, 'fixtures/workflow/e9/tasks.json'), 'utf8')).tasks;
const TASK_IDS = TASKS.map((task) => task.id);

function run(taskId, pair, { passed = true, interventions = 0, audit } = {}) {
  return {
    taskId,
    pair,
    passed,
    interventions,
    budget: { attempts: 1, wallMs: 1000, inputTokens: null, outputTokens: null, cost: null },
    ...(audit === undefined ? {} : { audit }),
  };
}

/** 每组生成 tasks × pairs 的记录网格；perTask 可按任务覆盖 pair 列表。 */
function groupRuns({ tasks = TASK_IDS, pairs = [1, 2, 3], perTask = {} } = {}) {
  const runs = [];
  for (const taskId of tasks) for (const pair of perTask[taskId] ?? pairs) runs.push(run(taskId, pair));
  return runs;
}

function input(overrides = {}) {
  return {
    schemaVersion: 1,
    groups: {
      A: { runs: groupRuns() },
      B: { runs: groupRuns() },
      C: { runs: groupRuns() },
      D: { runs: groupRuns() },
      ...overrides,
    },
  };
}

function verdicts(report) {
  return Object.fromEntries(report.pairs.map((pair) => [pair.pair, pair.verdict]));
}

test('existing sample missing type-fix audit stays insufficient without changing the frozen data', () => {
  const runs = JSON.parse(readFileSync(path.join(ROOT, 'fixtures/workflow/e9/sample-runs.json'), 'utf8'));
  const tasks = JSON.parse(readFileSync(path.join(ROOT, 'fixtures/workflow/e9/tasks.json'), 'utf8')).tasks;
  const report = buildReport(runs, { tasks });
  assert.equal(report.pairs.length, 3);
  assert.equal(verdicts(report)['B/A'], 'insufficient_data');
  assert.equal(verdicts(report)['C/B'], 'insufficient_data');
  assert.equal(verdicts(report)['D/C'], 'insufficient_data');
});

test('只有部分任务（单任务数据）→ 全部对判 insufficient_data', () => {
  const sparse = { tasks: ['type-fix'] };
  const report = buildReport(input({ A: { runs: groupRuns(sparse) }, B: { runs: groupRuns(sparse) } }), {
    tasks: TASKS,
  });
  assert.deepEqual(verdicts(report), { 'B/A': 'insufficient_data', 'C/B': 'insufficient_data', 'D/C': 'insufficient_data' });
  const ba = report.pairs[0];
  assert.equal(ba.sufficient, false);
  assert.equal(ba.tasks.length, TASKS.length);
});

test('组内同一任务 pair 序号重复 → insufficient_data', () => {
  const dup = { perTask: { 'type-fix': [1, 1, 2] } };
  const report = buildReport(input({ B: { runs: groupRuns(dup) } }), { tasks: TASKS });
  assert.equal(verdicts(report)['B/A'], 'insufficient_data');
  const task = report.pairs[0].tasks.find((t) => t.taskId === 'type-fix');
  assert.equal(task.sufficient, false);
  assert.equal(task.pairs.duplicatePairs, true);
});

test('两侧 pair 集合不一致（{1,2,3} vs {1,2,4}）→ insufficient_data', () => {
  const mismatched = { perTask: { 'authz-audit': [1, 2, 4] } };
  const report = buildReport(input({ A: { runs: groupRuns(mismatched) } }), { tasks: TASKS });
  assert.equal(verdicts(report)['B/A'], 'insufficient_data');
  const task = report.pairs[0].tasks.find((t) => t.taskId === 'authz-audit');
  assert.equal(task.sufficient, false);
  assert.equal(task.pairs.matched, false);
});

test('未注册 taskId 的记录 → E9InputError', () => {
  const bad = input();
  bad.groups.A.runs.push(run('mystery-task', 1));
  assert.throws(() => buildReport(bad, { tasks: TASKS }), E9InputError);
});

test('缺一组 → 涉及该组的对判 insufficient_data', () => {
  const missingD = input();
  delete missingD.groups['D'];
  const report = buildReport(missingD, { tasks: TASKS });
  assert.equal(verdicts(report)['D/C'], 'insufficient_data');
});

test('不传 tasks 即无门槛口径 → E9InputError', () => {
  assert.throws(() => buildReport(input()), E9InputError);
});

test('CLI：样例数据退出 0，非法数据退出 2', () => {
  const ok = spawnSync(process.execPath, [SCRIPT, '--input', 'fixtures/workflow/e9/sample-runs.json'], {
    encoding: 'utf8',
    cwd: ROOT,
  });
  assert.equal(ok.status, 0, ok.stderr);
  assert.match(ok.stdout, /B\/A[^\n]*insufficient_data/);

  const dir = mkdtempSync(path.join(tmpdir(), 'wsl-e9-'));
  const badPath = path.join(dir, 'bad.json');
  const bad = input();
  bad.groups.A.runs.push(run('mystery-task', 1));
  writeFileSync(badPath, JSON.stringify(bad));
  const failed = spawnSync(process.execPath, [SCRIPT, '--input', badPath], { encoding: 'utf8', cwd: ROOT });
  assert.equal(failed.status, 2);
});

const DECLARATIONS = TASKS;
function auditedInput() {
  return {
    schemaVersion: 1,
    groups: Object.fromEntries(
      ['A', 'B', 'C', 'D'].map((group) => [
        group,
        {
          runs: DECLARATIONS.flatMap((task) =>
            [1, 2, 3].map((pair) =>
              run(task.id, pair, {
                ...(task.audit ? { audit: { expectedFindings: 2, truePositives: group === 'A' ? 1 : 2, falsePositives: 0 } } : {}),
              }),
            ),
          ),
        },
      ]),
    ),
  };
}
function cliReport(value, declarations) {
  const dir = mkdtempSync(path.join(tmpdir(), 'wsl-e9-boundary-'));
  const inputPath = path.join(dir, 'input.json');
  const outputPath = path.join(dir, 'report.json');
  writeFileSync(inputPath, typeof value === 'string' ? value : JSON.stringify(value));
  const args = [SCRIPT, '--input', inputPath, '--report', outputPath];
  if (declarations !== undefined) {
    const tasksPath = path.join(dir, 'tasks.json');
    writeFileSync(tasksPath, JSON.stringify(declarations));
    args.push('--tasks', tasksPath);
  }
  const result = spawnSync(process.execPath, args, { cwd: ROOT, encoding: 'utf8' });
  return { ...result, report: result.status === 0 ? JSON.parse(readFileSync(outputPath, 'utf8')) : null };
}
test('audit boundary: non-audit tasks cannot affect the audit gate', () => {
  const data = auditedInput();
  for (const r of data.groups.B.runs)
    if (!DECLARATIONS.find((t) => t.id === r.taskId).audit) {
      r.audit = { expectedFindings: 100, truePositives: 100, falsePositives: 0 };
    }
  const result = cliReport(data);
  assert.equal(result.status, 2);
  assert.equal(result.report, null);
});
test('audit boundary: single unmatched audit samples cannot pass', () => {
  const data = auditedInput();
  for (const [g, group] of Object.entries(data.groups))
    for (const r of group.runs) {
      if (!(r.taskId === 'authz-audit' && r.pair === (g === 'A' ? 3 : 1))) delete r.audit;
    }
  const result = cliReport(data);
  assert.equal(result.status, 0, result.stderr);
  assert.equal(result.report.pairs[0].verdict, 'insufficient_data');
});
test('audit boundary: paired truth counts must match', () => {
  const data = auditedInput();
  data.groups.B.runs.find((r) => r.taskId === 'authz-audit' && r.pair === 1).audit.expectedFindings = 4;
  const result = cliReport(data);
  assert.equal(result.status, 0, result.stderr);
  assert.equal(result.report.pairs[0].verdict, 'insufficient_data');
});
test('audit boundary: true positives cannot exceed the truth count', () => {
  const data = auditedInput();
  data.groups.B.runs.find((r) => r.audit).audit.truePositives = 100;
  assert.equal(cliReport(data).status, 2);
});
for (const [name, mutate] of [
  [
    'negative cost',
    (r) => {
      r.budget.cost = -1;
    },
  ],
  [
    'negative token count',
    (r) => {
      r.budget.inputTokens = -1;
    },
  ],
  [
    'unsafe attempts sum',
    (r) => {
      r.budget.attempts = Number.MAX_SAFE_INTEGER;
    },
  ],
]) {
  test(`numeric boundary: ${name} is rejected`, () => {
    const data = auditedInput();
    for (const r of data.groups.B.runs) mutate(r);
    assert.equal(cliReport(data).status, 2);
  });
}
test('numeric boundary: JSON exponent overflow cannot become infinite time', () => {
  const raw = JSON.stringify(auditedInput()).replace('"wallMs":1000', '"wallMs":1e999');
  assert.equal(cliReport(raw).status, 2);
});

test('complete registered audits can meet the unchanged gate', () => {
  const report = buildReport(auditedInput(), { tasks: TASKS });
  assert.equal(report.pairs[0].verdict, 'meets_gate');
  assert.equal(report.pairs[0].checks.passRate.required, 3);
  assert.equal(report.pairs[0].checks.auditRecall.challenger, 1);
  assert.equal(report.pairs[0].checks.auditRecall.baseline, 0.5);
});
test('complete but worse audit recall remains below gate', () => {
  const data = auditedInput();
  for (const r of data.groups.B.runs) if (r.audit) r.audit.truePositives = 0;
  assert.equal(buildReport(data, { tasks: TASKS }).pairs[0].verdict, 'below_gate');
});
test('task declarations cannot omit the audit policy or repeat an id', () => {
  assert.throws(() => buildReport(auditedInput(), { tasks: TASK_IDS }), E9InputError);
  assert.throws(() => buildReport(auditedInput(), { tasks: [...TASKS, TASKS[0]] }), E9InputError);
});

function registrationBypass(shrink) {
  const data = auditedInput();
  const tasks = shrink
    ? TASKS.filter((task) => task.id === 'type-fix')
    : TASKS.map((task) => ({ ...task, audit: task.id === 'type-fix' ? false : task.audit }));
  for (const group of Object.values(data.groups)) {
    if (shrink) group.runs = group.runs.filter((run) => run.taskId === 'type-fix');
    else for (const run of group.runs) if (run.taskId === 'type-fix') delete run.audit;
  }
  return { data, tasks };
}
for (const shrink of [true, false]) {
  test(`registration boundary: pure API rejects ${shrink ? 'reduced tasks' : 'changed audit policy'}`, () => {
    const { data, tasks } = registrationBypass(shrink);
    assert.throws(() => buildReport(data, { tasks }), E9InputError);
  });
  test(`registration boundary: CLI rejects ${shrink ? 'reduced tasks' : 'changed audit policy'}`, () => {
    const { data, tasks } = registrationBypass(shrink);
    assert.equal(cliReport(data, tasks).status, 2);
  });
}
test('a copy of the same registered declarations remains valid', () => {
  const tasks = [...TASKS].reverse().map(({ id, audit }) => ({ id, audit }));
  const result = cliReport(auditedInput(), { tasks });
  assert.equal(result.status, 0, result.stderr);
  assert.equal(result.report.pairs[0].verdict, 'meets_gate');
});

for (const field of ['wallMs', 'inputTokens', 'outputTokens', 'cost']) {
  for (const value of [-1, NaN, Infinity, -Infinity]) {
    test(`numeric input: ${field} rejects ${value}`, () => {
      const data = auditedInput();
      data.groups.B.runs[0].budget[field] = value;
      assert.throws(() => buildReport(data, { tasks: TASKS }), E9InputError);
    });
  }
  test(`numeric total: ${field} rejects finite values whose sum overflows`, () => {
    const data = auditedInput();
    for (const r of data.groups.B.runs) r.budget[field] = Number.MAX_VALUE;
    assert.throws(() => buildReport(data, { tasks: TASKS }), E9InputError);
  });
}
for (const field of ['overBudget', 'infraFailure']) {
  test(`invalid ${field} is not silently treated as false`, () => {
    const data = auditedInput();
    data.groups.B.runs[0][field] = 'true';
    assert.throws(() => buildReport(data, { tasks: TASKS }), E9InputError);
  });
}
test('unsafe pair identity and aggregate audit counts are rejected', () => {
  const badPair = auditedInput();
  badPair.groups.B.runs[0].pair = Number.MAX_SAFE_INTEGER + 1;
  assert.throws(() => buildReport(badPair, { tasks: TASKS }), E9InputError);
  const badCount = auditedInput();
  for (const r of badCount.groups.B.runs) if (r.audit) r.audit.expectedFindings = Number.MAX_SAFE_INTEGER;
  assert.throws(() => buildReport(badCount, { tasks: TASKS }), E9InputError);
});

test('large finite budget values remain finite in the text report', () => {
  const data = auditedInput();
  for (const r of data.groups.B.runs) {
    r.budget.cost = 0;
    r.budget.inputTokens = 0;
    r.budget.outputTokens = 0;
  }
  for (const field of ['cost', 'inputTokens', 'outputTokens']) data.groups.B.runs[0].budget[field] = Number.MAX_VALUE;
  const report = buildReport(data, { tasks: TASKS });
  assert.equal(report.groups.B.budget.cost, Number.MAX_VALUE);
  assert.doesNotMatch(formatReport(report), /Infinity|NaN/);
});

for (const missing of [true, false]) {
  for (const entry of ['pure API', 'CLI']) {
    test(`interventions boundary: ${entry} rejects ${missing ? 'missing' : 'null'} counts instead of passing the gate`, () => {
      const data = auditedInput();
      for (const run of data.groups.A.runs) run.interventions = 1;
      for (const run of data.groups.B.runs) run.interventions = 3;
      assert.equal(buildReport(data, { tasks: TASKS }).pairs[0].verdict, 'below_gate');
      for (const run of data.groups.B.runs) {
        if (missing) delete run.interventions;
        else run.interventions = null;
      }
      if (entry === 'pure API') assert.throws(() => buildReport(data, { tasks: TASKS }), E9InputError);
      else assert.equal(cliReport(data).status, 2);
    });
  }
}
