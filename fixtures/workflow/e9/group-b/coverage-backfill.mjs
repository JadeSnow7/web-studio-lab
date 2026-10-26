export const meta = {
  name: 'E9-B 覆盖率补齐',
  description: 'B 组手写 workflow：找出未覆盖分支 → 补测试建议 → 复核达标口径。（E9 预注册任务 coverage-backfill）',
  phases: ['gaps', 'tests'],
};

export default async function main() {
  phase('gaps');
  const gaps = await agent('分析工程快照的覆盖率报告，列出低于封存阈值的未覆盖分支清单（文件、分支、原因）。', {
    label: '缺口清单',
  });
  if (gaps.status !== 'ok') return { ok: false, stage: 'gaps', error: gaps.message };
  phase('tests');
  const tests = await agent('为下列未覆盖分支逐一设计最小测试用例（输入、断言、夹具）：' + String(gaps.value), {
    label: '补测试',
  });
  if (tests.status !== 'ok') return { ok: false, stage: 'tests', error: tests.message };
  return { ok: true, gaps: gaps.value, tests: tests.value };
}
