#!/usr/bin/env node
/**
 * E9 端到端收益对照的报告机械（W9）。
 *
 *   node scripts/e9-report.mjs --input <runs.json> [--report <out.json>]
 *
 * 输入形状见 fixtures/workflow/e9/README.md「报告机械输入 schema」；
 * 输出逐对比较表（B/A、C/B、D/C 的通过率/审计召回/误报/人工干预/预算）
 * 与预注册门槛判定（meets_gate / below_gate / insufficient_data）。
 * 纯数据机械：不跑真实模型、不批准任何默认启用。
 */
import { readFileSync, writeFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const PAIRS = [
  ['B', 'A'],
  ['C', 'B'],
  ['D', 'C'],
];
/** 预注册门槛：≥3/4 任务通过率不低于基准组（plan.md §70）。 */
const PASS_FRACTION = 0.75;
/** 先导样本量：每组每任务至少 3 次配对记录，否则该对判 insufficient_data。 */
const MIN_RUNS_PER_TASK = 3;
// The committed task file defines this experiment; callers cannot replace its gate.
const REGISTERED_TASKS = JSON.parse(readFileSync(new URL('../fixtures/workflow/e9/tasks.json', import.meta.url), 'utf8')).tasks.map(
  ({ id, audit }) => ({ id, audit }),
);
const NO_DEFAULT_ENABLE_NOTE = '未冻结成本容许值前，E9 只报告数据，不批准 Ultra 默认启用。';

export class E9InputError extends Error {
  constructor(message) {
    super(message);
    this.name = 'E9InputError';
    this.code = 'e9_input_invalid';
  }
}

function fail(message) {
  throw new E9InputError(message);
}

function isObject(value) {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

function isNonNegInt(value) {
  return Number.isSafeInteger(value) && value >= 0;
}

function nullableNumber(value, field) {
  if (value === null) return null;
  if (typeof value !== 'number' || !Number.isFinite(value) || value < 0) {
    fail(`budget.${field} must be a finite non-negative number or null`);
  }
  return value;
}

function sumNumbers(values, field, integer = false) {
  const total = values.reduce((sum, value) => sum + value, 0);
  if (!Number.isFinite(total) || (integer && !Number.isSafeInteger(total))) {
    fail(`${field} total is outside the supported numeric range`);
  }
  return total;
}

function normalizeRun(raw, where) {
  if (!isObject(raw)) fail(`${where} 必须是对象`);
  if (typeof raw.taskId !== 'string' || raw.taskId.length === 0) fail(`${where}.taskId 必填非空字符串`);
  if (!Number.isSafeInteger(raw.pair) || raw.pair < 1) fail(`${where}.pair 必须是 ≥1 的整数（配对序号）`);
  if (typeof raw.passed !== 'boolean') fail(`${where}.passed 必须是布尔值`);
  if (!isNonNegInt(raw.interventions)) fail(`${where}.interventions 必须是 ≥0 整数`);
  for (const field of ['overBudget', 'infraFailure']) {
    if (raw[field] !== undefined && typeof raw[field] !== 'boolean') fail(`${where}.${field} must be boolean`);
  }
  const run = {
    taskId: raw.taskId,
    pair: raw.pair,
    ranAt: typeof raw.ranAt === 'string' ? raw.ranAt : null,
    passed: raw.passed,
    overBudget: raw.overBudget === true,
    infraFailure: raw.infraFailure === true,
    interventions: raw.interventions,
    audit: null,
    budget: null,
  };
  if (raw.audit !== undefined) {
    if (!isObject(raw.audit)) fail(`${where}.audit 必须是对象`);
    const { expectedFindings, truePositives, falsePositives } = raw.audit;
    if (!isNonNegInt(expectedFindings) || !isNonNegInt(truePositives) || !isNonNegInt(falsePositives)) {
      fail(`${where}.audit.{expectedFindings,truePositives,falsePositives} 必须是 ≥0 整数`);
    }
    if (truePositives > expectedFindings) fail(`${where}.audit.truePositives exceeds expectedFindings`);
    run.audit = { expectedFindings, truePositives, falsePositives };
  }
  if (!isObject(raw.budget)) fail(`${where}.budget 必填对象`);
  if (!isNonNegInt(raw.budget.attempts)) fail(`${where}.budget.attempts 必须是 ≥0 整数`);
  if (typeof raw.budget.wallMs !== 'number' || !Number.isFinite(raw.budget.wallMs) || raw.budget.wallMs < 0)
    fail(`${where}.budget.wallMs 必须是 ≥0 数字`);
  run.budget = {
    attempts: raw.budget.attempts,
    wallMs: raw.budget.wallMs,
    // token/成本口径未知记 null（unknown）：不折算、不记 0。
    inputTokens: nullableNumber(raw.budget.inputTokens, 'inputTokens'),
    outputTokens: nullableNumber(raw.budget.outputTokens, 'outputTokens'),
    cost: nullableNumber(raw.budget.cost, 'cost'),
  };
  return run;
}

/** 输入校验与归一化；形状不符抛 E9InputError。 */
export function normalizeInput(raw) {
  if (!isObject(raw)) fail('顶层必须是对象');
  if (raw.schemaVersion !== 1) fail('schemaVersion 必须为 1');
  if (!isObject(raw.groups)) fail('groups 必填对象');
  const groups = {};
  for (const [name, group] of Object.entries(raw.groups)) {
    if (!isObject(group) || !Array.isArray(group.runs)) fail(`groups.${name}.runs 必须是数组`);
    groups[name] = { runs: group.runs.map((run, index) => normalizeRun(run, `groups.${name}.runs[${index}]`)) };
  }
  return {
    schemaVersion: 1,
    window: isObject(raw.window) ? { startedAt: raw.window.startedAt ?? null, endedAt: raw.window.endedAt ?? null } : null,
    groups,
  };
}

function groupStats(runs) {
  const sum = (key, integer = false) =>
    sumNumbers(
      runs.map((run) => run.budget[key]),
      `budget.${key}`,
      integer,
    );
  const nullableSum = (key) => (runs.some((run) => run.budget[key] === null) ? null : sum(key));
  const interventions = sumNumbers(
    runs.map((run) => run.interventions),
    'interventions',
    true,
  );
  const passed = runs.filter((run) => run.passed).length;
  return {
    runs: runs.length,
    passed,
    passRate: runs.length === 0 ? null : passed / runs.length,
    infraFailures: runs.filter((run) => run.infraFailure).length,
    overBudget: runs.filter((run) => run.overBudget).length,
    interventions: { total: interventions, mean: runs.length === 0 ? null : interventions / runs.length },
    budget: {
      attempts: sum('attempts', true),
      wallMs: sum('wallMs'),
      inputTokens: nullableSum('inputTokens'),
      outputTokens: nullableSum('outputTokens'),
      cost: nullableSum('cost'),
    },
  };
}

function auditTotals(runs) {
  const audited = runs.filter((run) => run.audit !== null);
  if (audited.length === 0) return null;
  const expected = sumNumbers(
    audited.map((run) => run.audit.expectedFindings),
    'expectedFindings',
    true,
  );
  const tp = sumNumbers(
    audited.map((run) => run.audit.truePositives),
    'truePositives',
    true,
  );
  const fp = sumNumbers(
    audited.map((run) => run.audit.falsePositives),
    'falsePositives',
    true,
  );
  const claimed = sumNumbers([tp, fp], 'audit claims', true);
  return {
    runs: audited.length,
    expected,
    truePositives: tp,
    falsePositives: fp,
    recall: expected === 0 ? null : tp / expected,
    falsePositiveRate: claimed === 0 ? 0 : fp / claimed,
  };
}

function comparePair(name, runsX, runsY, expectedTasks) {
  const known = new Map(expectedTasks.map((task) => [task.id, task]));
  for (const run of [...runsX, ...runsY]) {
    const task = known.get(run.taskId);
    if (!task) fail(`unregistered task: ${run.taskId}`);
    if (!task.audit && run.audit !== null) fail(`audit data is not registered for ${run.taskId}`);
  }
  const tasks = [...expectedTasks]
    .sort((a, b) => a.id.localeCompare(b.id))
    .map(({ id: taskId, audit: required }) => {
      const x = runsX.filter((run) => run.taskId === taskId);
      const y = runsY.filter((run) => run.taskId === taskId);
      const passRateX = x.length === 0 ? null : x.filter((run) => run.passed).length / x.length;
      const passRateY = y.length === 0 ? null : y.filter((run) => run.passed).length / y.length;
      const pairsX = x.map((run) => run.pair);
      const pairsY = y.map((run) => run.pair);
      const uniqueX = new Set(pairsX);
      const uniqueY = new Set(pairsY);
      const duplicatePairs = uniqueX.size !== pairsX.length || uniqueY.size !== pairsY.length;
      const matched = uniqueX.size === uniqueY.size && [...uniqueX].every((p) => uniqueY.has(p));
      const complete = !required || [...x, ...y].every((run) => run.audit !== null);
      const comparable =
        !required ||
        (complete &&
          x.every((run) => {
            const paired = y.find((candidate) => candidate.pair === run.pair);
            return paired?.audit?.expectedFindings === run.audit.expectedFindings;
          }));
      const sufficient =
        x.length >= MIN_RUNS_PER_TASK && y.length >= MIN_RUNS_PER_TASK && !duplicatePairs && matched && complete && comparable;
      return {
        taskId,
        runsX: x.length,
        runsY: y.length,
        passRateX,
        passRateY,
        passNotBelow: passRateX !== null && passRateY !== null && passRateX >= passRateY,
        sufficient,
        pairs: { x: [...uniqueX].sort((a, b) => a - b), y: [...uniqueY].sort((a, b) => a - b), duplicatePairs, matched },
        audit: { required, complete, comparable },
      };
    });
  const sufficient = tasks.length > 0 && tasks.every((task) => task.sufficient);
  const tasksNotBelow = tasks.filter((task) => task.passNotBelow).length;
  const required = Math.ceil(PASS_FRACTION * tasks.length);
  const auditIds = new Set(expectedTasks.filter((task) => task.audit).map((task) => task.id));
  const auditX = auditTotals(runsX.filter((run) => auditIds.has(run.taskId)));
  const auditY = auditTotals(runsY.filter((run) => auditIds.has(run.taskId)));
  const auditAvailable =
    auditIds.size > 0 &&
    tasks.filter((task) => task.audit.required).every((task) => task.sufficient) &&
    auditX !== null &&
    auditY !== null &&
    auditX.recall !== null &&
    auditY.recall !== null;
  const checks = {
    passRate: { tasksCompared: tasks.length, tasksNotBelow, required, ok: tasksNotBelow >= required },
    auditRecall: {
      available: auditAvailable,
      challenger: auditX?.recall ?? null,
      baseline: auditY?.recall ?? null,
      ok: auditAvailable && auditX.recall > auditY.recall,
    },
    falsePositiveRate: {
      available: auditAvailable,
      challenger: auditX?.falsePositiveRate ?? null,
      baseline: auditY?.falsePositiveRate ?? null,
      ok: auditAvailable && auditX.falsePositiveRate <= auditY.falsePositiveRate,
    },
    interventions: {
      challenger:
        runsX.length === 0
          ? null
          : sumNumbers(
              runsX.map((run) => run.interventions),
              'interventions',
              true,
            ) / runsX.length,
      baseline:
        runsY.length === 0
          ? null
          : sumNumbers(
              runsY.map((run) => run.interventions),
              'interventions',
              true,
            ) / runsY.length,
      ok:
        runsX.length > 0 &&
        runsY.length > 0 &&
        sumNumbers(
          runsX.map((run) => run.interventions),
          'interventions',
          true,
        ) /
          runsX.length <=
          sumNumbers(
            runsY.map((run) => run.interventions),
            'interventions',
            true,
          ) /
            runsY.length,
    },
  };
  const verdict =
    !sufficient || !auditAvailable
      ? 'insufficient_data'
      : checks.passRate.ok && checks.auditRecall.ok && checks.falsePositiveRate.ok && checks.interventions.ok
        ? 'meets_gate'
        : 'below_gate';
  return { pair: name, tasks, sufficient, checks, verdict };
}

/** 预注册任务集：E9 对照只对这组任务判定门槛；不提供即无门槛口径，直接判输入无效。 */
function normalizeTasks(tasks) {
  if (!Array.isArray(tasks) || tasks.length !== REGISTERED_TASKS.length) fail('tasks must match the frozen E9 registration');
  const seen = new Set();
  return tasks.map((task) => {
    if (!isObject(task) || typeof task.id !== 'string' || task.id.length === 0 || typeof task.audit !== 'boolean') {
      fail('each task requires an id and an explicit audit boolean');
    }
    const registered = REGISTERED_TASKS.find((candidate) => candidate.id === task.id);
    if (!registered || registered.audit !== task.audit) fail(`task declaration differs from frozen E9 registration: ${task.id}`);
    if (seen.has(task.id)) fail(`duplicate registered task: ${task.id}`);
    seen.add(task.id);
    return { id: task.id, audit: task.audit };
  });
}

/** Build the E9 report against the frozen id/audit task declarations. */
export function buildReport(raw, { now = () => new Date().toISOString(), tasks } = {}) {
  const input = normalizeInput(raw);
  const expectedTasks = normalizeTasks(tasks);
  const groups = {};
  for (const [name, group] of Object.entries(input.groups)) groups[name] = groupStats(group.runs);
  const pairs = PAIRS.map(([x, y]) => ({
    challenger: x,
    baseline: y,
    ...comparePair(`${x}/${y}`, input.groups[x]?.runs ?? [], input.groups[y]?.runs ?? [], expectedTasks),
  }));
  return {
    schemaVersion: 1,
    generatedAt: now(),
    window: input.window,
    groups,
    pairs,
    note: NO_DEFAULT_ENABLE_NOTE,
  };
}

const pct = (value) => (value === null || value === undefined ? '—' : `${(value * 100).toFixed(1)}%`);
const num = (value) => (value === null || value === undefined ? 'unknown' : String(Number(value.toFixed(3))));

/** 文本报告：逐对门槛判定表 + 组级统计（供终端查看；机器消费用 --report JSON）。 */
export function formatReport(report) {
  const lines = [];
  lines.push('E9 端到端收益对照报告（逐对门槛判定）');
  if (report.window) lines.push(`时段：${report.window.startedAt ?? '?'} → ${report.window.endedAt ?? '?'}`);
  lines.push('');
  for (const pair of report.pairs) {
    lines.push(`== ${pair.pair}（${pair.challenger} 对 ${pair.baseline}）→ ${pair.verdict}`);
    for (const task of pair.tasks) {
      const insufficiency = task.sufficient
        ? ''
        : task.runsX < MIN_RUNS_PER_TASK || task.runsY < MIN_RUNS_PER_TASK
          ? ' (insufficient runs)'
          : task.pairs.duplicatePairs
            ? ' (duplicate pairs)'
            : !task.pairs.matched
              ? ' (unmatched pairs)'
              : !task.audit.complete
                ? ' (missing required audit samples)'
                : ' (paired audit truth differs)';
      lines.push(
        `   ${task.taskId}: ${pair.challenger} ${task.runsX} 次 / ${pct(task.passRateX)} vs ${pair.baseline} ${task.runsY} 次 / ${pct(task.passRateY)}${insufficiency}`,
      );
    }
    const c = pair.checks;
    lines.push(
      `   通过率：不低于基准的任务 ${c.passRate.tasksNotBelow}/${c.passRate.tasksCompared}（要求 ≥${c.passRate.required}）→ ${c.passRate.ok}`,
    );
    lines.push(`   审计召回：${pct(c.auditRecall.challenger)} vs ${pct(c.auditRecall.baseline)}（须严格更高）→ ${c.auditRecall.ok}`);
    lines.push(
      `   误报率：${pct(c.falsePositiveRate.challenger)} vs ${pct(c.falsePositiveRate.baseline)}（须 ≤ 基准）→ ${c.falsePositiveRate.ok}`,
    );
    lines.push(`   人工干预：${num(c.interventions.challenger)} vs ${num(c.interventions.baseline)}（须不增）→ ${c.interventions.ok}`);
    lines.push('');
  }
  lines.push('组级统计：');
  for (const [name, stats] of Object.entries(report.groups)) {
    lines.push(
      `   ${name}: runs ${stats.runs} · 通过率 ${pct(stats.passRate)} · infraFailure ${stats.infraFailures} · overBudget ${stats.overBudget} · attempts ${stats.budget.attempts} · wallMs ${stats.budget.wallMs} · tokens in ${num(stats.budget.inputTokens)} / out ${num(stats.budget.outputTokens)} · cost ${num(stats.budget.cost)}`,
    );
  }
  lines.push('');
  lines.push(`注：${report.note}`);
  return lines.join('\n');
}

/** CLI 主入口；模块被测试 import 时不执行。 */
function main() {
  const args = process.argv.slice(2);
  const opt = (name) => {
    const index = args.indexOf(name);
    return index >= 0 ? args[index + 1] : null;
  };
  const inputPath = opt('--input');
  if (!inputPath) {
    console.error('用法：node scripts/e9-report.mjs --input <runs.json> [--tasks <tasks.json>] [--report <out.json>]');
    process.exit(2);
  }
  // --tasks may select an equivalent registration file, not change this experiment.
  const tasksPath = opt('--tasks') ?? resolve(dirname(fileURLToPath(import.meta.url)), '../fixtures/workflow/e9/tasks.json');
  let tasks;
  try {
    const parsed = JSON.parse(readFileSync(tasksPath, 'utf8'));
    tasks = Array.isArray(parsed) ? parsed : parsed.tasks;
  } catch (error) {
    console.error(`E9 任务集读取失败：${error instanceof Error ? error.message : String(error)}`);
    process.exit(2);
  }
  let report;
  try {
    report = buildReport(JSON.parse(readFileSync(inputPath, 'utf8')), { tasks });
  } catch (error) {
    console.error(`E9 输入无效：${error instanceof Error ? error.message : String(error)}`);
    process.exit(2);
  }
  const outPath = opt('--report');
  if (outPath) writeFileSync(outPath, JSON.stringify(report, null, 2), 'utf8');
  process.stdout.write(formatReport(report) + '\n');
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) main();
