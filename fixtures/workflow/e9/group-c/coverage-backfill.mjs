export const meta = {
  name: 'E9-C 覆盖率补齐',
  description: 'C 组 Ultra 指挥变体：指挥调用决定补测优先级，执行与 B 同构。（E9 预注册任务 coverage-backfill）',
  phases: ['direct', 'gaps', 'tests'],
  ultra: true,
};

export default async function main() {
  phase('direct');
  const plan = await agent(
    '先判断这个任务是否值得编排：不值得就退化为单个调用直接完成；值得才给出确定性计划（phases、并行只读波次、预算分配），规划本身计入总预算。任务：为冻结工程快照补齐测试使行覆盖率达到封存阈值。',
    { label: '指挥规划' },
  );
  if (plan.status !== 'ok') return { ok: false, stage: 'direct', error: plan.message };
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
  return { ok: true, plan: plan.value, gaps: gaps.value, tests: tests.value };
}
