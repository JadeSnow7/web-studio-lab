#!/usr/bin/env node
/**
 * E8 结构化输出验收 runner（W5）。
 *
 *   node scripts/workflow-e8.mjs --fixture --report out/e8-report.json [--limit N]
 *   node scripts/workflow-e8.mjs --report out/e8-report.json        # live（需显式授权）
 *
 * --fixture：MockHarness + 真实内核全链路自检（确定性，可跑通并产出报告）。
 * live：真 SbxConnection + ReadonlyGuestAdapter + codex readonly argv；
 * 必须 WSL_WORKFLOW_LIVE=1 且 WSL_SBX_BIN / WSL_SBX_NAME 显式设置，否则拒绝并非零退出。
 * 一次修复 attempt：首次输出 schema_mismatch → 追加修复 prompt 重试一次，仍不合记 failed。
 */
import { randomUUID } from 'node:crypto';
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { registerHooks } from 'node:module';
import { tsImport } from 'tsx/esm/api';
import * as rawHooks from './raw-loader-hooks.mjs';

// 源码经 tsx 直跑时 vite `?raw` 导入无 loader——注册本仓库的最小 ?raw 钩子（live 路径依赖 sbx.ts）。
registerHooks(rawHooks);

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const args = process.argv.slice(2);
const flag = (name) => args.includes(name);
const opt = (name, fallback) => {
  const i = args.indexOf(name);
  return i >= 0 ? args[i + 1] : fallback;
};

const fixtureMode = flag('--fixture');
const reportPath = opt('--report', null);
const limit = Number(opt('--limit', '0')) || null;
// live 节流：--offset N 从第 N 个 prompt 起切批，配合 --limit 控制单轮调用数；
// 批间等待由调用方（shell）负责——VM 内无定时器，脚本自身不能节流。
const offset = Number(opt('--offset', '0')) || 0;

if (!reportPath) {
  console.error('用法：node scripts/workflow-e8.mjs [--fixture] --report <path> [--limit N]');
  process.exit(2);
}

// 真实模型授权闸：三个环境变量都显式设置才允许走 live 路径。
if (!fixtureMode) {
  const ok = process.env['WSL_WORKFLOW_LIVE'] === '1' && process.env['WSL_SBX_BIN'] && process.env['WSL_SBX_NAME'];
  if (!ok) {
    console.error('拒绝执行 live E8：需要 WSL_WORKFLOW_LIVE=1 且 WSL_SBX_BIN/WSL_SBX_NAME 显式设置（真实模型授权闸）。');
    process.exit(2);
  }
}

const service = (p) => resolve(root, 'apps/service/src', p);
const { createRun } = await tsImport(service('workflow/kernel.ts'), import.meta.url);
const { MockHarness } = await tsImport(service('workflow/mock-harness.ts'), import.meta.url);

const prompts = JSON.parse(readFileSync(resolve(root, 'fixtures/workflow/e8/prompts.json'), 'utf8'));
const schemas = JSON.parse(readFileSync(resolve(root, 'fixtures/workflow/e8/schemas.json'), 'utf8'));

const DRIVER = `export const meta = { name: 'e8', description: 'structured output matrix' };
export default async function main() {
  const prompts = args.prompts;
  const schemas = args.schemas;
  const base = args.base ?? 0;
  const out = [];
  for (let i = 0; i < prompts.length; i++) {
    for (let j = 0; j < schemas.length; j++) {
      const schema = schemas[j].schema;
      const prompt = prompts[i] + '\\n只输出符合此 JSON Schema 的 JSON 对象：' + JSON.stringify(schema);
      const first = await agent(prompt, { label: 'e8-p' + (i + base) + '-s' + j, schema });
      const rec = { promptIdx: i + base, schemaIdx: j, firstOk: false, repairedOk: false, category: 'ok', attempts: 1 };
      if (first.status === 'ok') {
        rec.firstOk = true;
      } else if (first.status === 'failed' && first.code === 'schema_mismatch') {
        rec.attempts = 2;
        const fix = await agent(
          '上一次输出不满足 JSON Schema（' + first.message + '）。只输出符合 schema 的 JSON：' + JSON.stringify(schema),
          { label: 'e8-p' + (i + base) + '-s' + j + '-fix', schema },
        );
        if (fix.status === 'ok') {
          rec.repairedOk = true;
          rec.category = 'repaired';
        } else {
          rec.category = fix.status === 'failed' ? fix.code : 'failed';
        }
      } else {
        rec.category = first.status === 'failed' ? first.code : 'failed';
      }
      out.push(rec);
    }
  }
  return out;
}`;

// fixture 计划：按全局 prompt 下标 p=offset+i 键入——与 DRIVER 的 label（e8-p<p>-s<j>）逐格对齐。
// 确定性分布：(p+j)%7===0 首次 schema_mismatch 后修复成功；(p+j)%11===0 两次均不合 → failed。
const VALID = [
  { summary: 's', findings: [{ title: 't', severity: 'low' }] },
  { verdict: 'pass', confidence: 0.9, reasons: [] },
  [{ key: 'k', value: 'v' }],
  { rootCause: 'r', fixes: [{ action: 'a', effort: 'small' }] },
  { total: 1, breakdown: { ok: 1 } },
];
function fixturePlan(selected) {
  const plan = {};
  for (let i = 0; i < selected.length; i++) {
    const p = offset + i;
    for (let j = 0; j < schemas.length; j++) {
      const bad = { text: '这不是 JSON' };
      const mismatch = (p + j) % 7 === 0 || (p + j) % 11 === 0;
      plan[`e8-p${p}-s${j}`] = mismatch ? [bad] : [{ json: VALID[j] }];
      plan[`e8-p${p}-s${j}-fix`] = (p + j) % 11 === 0 ? [bad] : [{ json: VALID[j] }];
    }
  }
  return plan;
}

const selected = limit === null ? prompts.slice(offset) : prompts.slice(offset, offset + limit);
// 空切片不能产出验收矩阵：不写报告、非零退出，避免把空数据当作通过。
if (selected.length === 0) {
  console.error(`E8 无有效调用：offset=${offset} limit=${limit ?? '∞'} 超出 prompts 范围（共 ${prompts.length} 条）。`);
  process.exit(4);
}

let adapter;
let connection = null;
if (fixtureMode) {
  adapter = new MockHarness(fixturePlan(selected));
} else {
  const { SbxConnection } = await tsImport(service('sbx.ts'), import.meta.url);
  const { codexAdapter } = await tsImport(service('harness/codex/adapter.ts'), import.meta.url);
  const { IsolatedGuestAdapter } = await tsImport(service('workflow/isolated-guest-adapter.ts'), import.meta.url);
  connection = new SbxConnection({ sbxBinary: process.env['WSL_SBX_BIN'], sandbox: process.env['WSL_SBX_NAME'] });
  const status = await connection.initialize();
  if (!status.available) {
    console.error(`sbx 不可用：${status.reason}`);
    process.exit(3);
  }
  const runId = randomUUID(); // guest-helper 对 start 帧 runId 做 UUID 校验
  adapter = new IsolatedGuestAdapter({ start: connection.start.bind(connection), harness: codexAdapter, runId });
}

const dir = resolve(root, 'out/e8');
mkdirSync(dir, { recursive: true });
const journalEvents = [];
const run = await createRun({
  script: DRIVER,
  args: {
    prompts: selected,
    schemas,
    base: offset,
  },
  journalDir: dir,
  adapter,
});
const outcome = await run.done;
if (connection) await connection.close?.();

if (outcome.status !== 'completed') {
  console.error(`E8 驱动 run 未正常完成：${outcome.status} ${outcome.failureCode ?? ''}`);
  process.exit(4);
}
const calls = outcome.result;
const total = calls.length;
const firstOk = calls.filter((c) => c.firstOk).length;
const repairedOk = calls.filter((c) => c.repairedOk).length;
const byCategory = {};
for (const c of calls) byCategory[c.category] = (byCategory[c.category] ?? 0) + 1;
const report = {
  experiment: 'workflow-e8',
  mode: fixtureMode ? 'fixture' : 'live',
  total,
  calls,
  summary: {
    firstOk,
    repairedOk,
    totalValid: firstOk + repairedOk,
    firstRate: total ? firstOk / total : 0,
    repairedRate: total ? (firstOk + repairedOk) / total : 0,
    byCategory,
  },
};
mkdirSync(dirname(resolve(reportPath)), { recursive: true });
writeFileSync(resolve(reportPath), JSON.stringify(report, null, 2));
// unplanned_call 意味着 driver label 与计划错位——runner 缺陷，报告只供诊断，退出码必须非零。
const unplanned = byCategory['unplanned_call'] ?? 0;
if (unplanned > 0) {
  console.error(`E8 报告含 ${unplanned} 个 unplanned_call：runner 计划错位，数据无效，不能作为验收依据。`);
  process.exit(5);
}
console.log(
  `E8 报告已写入 ${reportPath}：total=${total} firstRate=${report.summary.firstRate.toFixed(3)} repairedRate=${report.summary.repairedRate.toFixed(3)}`,
);
void journalEvents;
process.exit(0);
