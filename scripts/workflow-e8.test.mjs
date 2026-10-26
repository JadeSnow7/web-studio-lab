// E8 runner 离线回归：fixture 模式下 offset/limit 的全局下标对齐、空切片拒绝、live 授权闸。
// 运行：node --test scripts/workflow-e8.test.mjs（不经 vitest；与其它 scripts/*.test.mjs 一致）。
import test from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { existsSync, mkdtempSync, readFileSync, readdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const SCRIPT = path.join(ROOT, 'scripts/workflow-e8.mjs');
const PROMPTS = JSON.parse(readFileSync(path.join(ROOT, 'fixtures/workflow/e8/prompts.json'), 'utf8'));
const SCHEMAS = JSON.parse(readFileSync(path.join(ROOT, 'fixtures/workflow/e8/schemas.json'), 'utf8'));

function runE8(args, env = {}) {
  const dir = mkdtempSync(path.join(tmpdir(), 'wsl-e8-'));
  const report = path.join(dir, 'report.json');
  const result = spawnSync(process.execPath, [SCRIPT, ...args, '--report', report], {
    encoding: 'utf8',
    timeout: 120000,
    cwd: ROOT,
    // 默认清掉真实模型授权变量：本文件的用例都不得触达 live 路径。
    env: { ...process.env, WSL_WORKFLOW_LIVE: '', WSL_SBX_BIN: '', WSL_SBX_NAME: '', ...env },
  });
  return { ...result, report: existsSync(report) ? JSON.parse(readFileSync(report, 'utf8')) : null };
}

// 与 workflow-e8.mjs 的确定性 fixture 分布一致（按全局 prompt 下标 p=offset+i）。
function expected(offset, count) {
  let firstOk = 0;
  let repaired = 0;
  let failed = 0;
  for (let p = offset; p < offset + count; p++) {
    for (let j = 0; j < SCHEMAS.length; j++) {
      if ((p + j) % 11 === 0) failed += 1;
      else if ((p + j) % 7 === 0) repaired += 1;
      else firstOk += 1;
    }
  }
  return { firstOk, repaired, failed, total: count * SCHEMAS.length };
}

test('完整矩阵（offset 0）：150 调用按确定性分布完成，无 unplanned_call', () => {
  const r = runE8(['--fixture']);
  assert.equal(r.status, 0, r.stderr);
  const exp = expected(0, PROMPTS.length);
  assert.equal(r.report.total, exp.total);
  assert.equal(r.report.summary.byCategory['unplanned_call'] ?? 0, 0);
  assert.equal(r.report.summary.firstOk, exp.firstOk);
  assert.equal(r.report.summary.repairedOk, exp.repaired);
  // 两次修复仍不合的调用归入 schema_mismatch 类别（fix.code 透传）。
  assert.equal(r.report.summary.byCategory['schema_mismatch'] ?? 0, exp.failed);
});

test('offset=5：driver 全局 label 与计划对齐，无 unplanned_call', () => {
  const r = runE8(['--fixture', '--offset', '5', '--limit', '5']);
  assert.equal(r.status, 0, r.stderr);
  const exp = expected(5, 5);
  assert.equal(r.report.total, exp.total);
  assert.equal(r.report.summary.byCategory['unplanned_call'] ?? 0, 0);
  assert.equal(r.report.summary.firstOk, exp.firstOk);
  assert.equal(r.report.summary.repairedOk, exp.repaired);
  assert.deepEqual(
    [...new Set(r.report.calls.map((c) => c.promptIdx))].sort((a, b) => a - b),
    [5, 6, 7, 8, 9],
  );
});

test('offset=29：末段一条 prompt 共 5 调用，全局下标 29', () => {
  const r = runE8(['--fixture', '--offset', '29']);
  assert.equal(r.status, 0, r.stderr);
  assert.equal(r.report.total, SCHEMAS.length);
  assert.equal(r.report.summary.byCategory['unplanned_call'] ?? 0, 0);
  assert.deepEqual([...new Set(r.report.calls.map((c) => c.promptIdx))], [29]);
});

for (const offset of [30, 31]) {
  test(`offset=${offset} 超出范围：退出 4 且不产报告`, () => {
    const r = runE8(['--fixture', '--offset', String(offset)]);
    assert.equal(r.status, 4, r.stderr);
    assert.equal(r.report, null);
  });
}

test('live 未授权：退出 2 且不产报告', () => {
  const r = runE8([]);
  assert.equal(r.status, 2);
  assert.equal(r.report, null);
});

const JOURNAL_DIR = path.join(ROOT, 'out/e8');
function journalNames() {
  return existsSync(JOURNAL_DIR) ? readdirSync(JOURNAL_DIR).sort() : [];
}
for (const [name, args] of [
  ['negative offset', ['--offset', '-1', '--limit', '1']],
  ['fractional offset', ['--offset', '0.5', '--limit', '1']],
  ['NaN offset', ['--offset', 'oops', '--limit', '1']],
  ['infinite offset', ['--offset', 'Infinity', '--limit', '1']],
  ['unsafe offset', ['--offset', '9007199254740992', '--limit', '1']],
  ['missing offset', ['--limit', '1', '--offset']],
  ['negative limit', ['--offset', '29', '--limit', '-1']],
  ['fractional limit', ['--offset', '29', '--limit', '1.5']],
  ['NaN limit', ['--offset', '29', '--limit', 'oops']],
  ['infinite limit', ['--offset', '29', '--limit', 'Infinity']],
  ['missing limit', ['--offset', '29', '--limit']],
  ['unknown option', ['--offset', '29', '--limti', '1']],
  ['duplicate option', ['--offset', '29', '--offset', '0']],
  ['duplicate fixture', ['--offset', '29', '--fixture']],
  ['positional argument', ['extra', '--offset', '29']],
]) {
  test(`argument boundary: ${name} is rejected before writing or calling`, () => {
    const before = journalNames();
    const r = runE8(['--fixture', ...args]);
    assert.equal(r.status, 2, r.stderr);
    assert.equal(r.report, null);
    assert.deepEqual(journalNames(), before);
  });
}
test('explicit limit=0 keeps unlimited semantics at offset=29', () => {
  const r = runE8(['--fixture', '--offset', '29', '--limit', '0']);
  assert.equal(r.status, 0, r.stderr);
  assert.equal(r.report.total, 5);
  assert.deepEqual([...new Set(r.report.calls.map((c) => c.promptIdx))], [29]);
});

test('missing report value is rejected before journal writes', () => {
  const before = journalNames();
  const result = spawnSync(process.execPath, [SCRIPT, '--fixture', '--report'], {
    cwd: ROOT,
    encoding: 'utf8',
    timeout: 120000,
    env: { ...process.env, WSL_WORKFLOW_LIVE: '', WSL_SBX_BIN: '', WSL_SBX_NAME: '' },
  });
  assert.equal(result.status, 2);
  assert.deepEqual(journalNames(), before);
});
