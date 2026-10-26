export const meta = {
  name: 'E9-C 类型错误修复',
  description: 'C 组 Ultra 指挥变体：先由指挥调用判断是否值得编排，再产出与 B 同构的执行序列。（E9 预注册任务 type-fix）',
  phases: ['direct', 'collect', 'fix'],
  ultra: true,
};

export default async function main() {
  phase('direct');
  const plan = await agent(
    '先判断这个任务是否值得编排：不值得就退化为单个调用直接完成；值得才给出确定性计划（phases、并行只读波次、预算分配），规划本身计入总预算。任务：修复冻结工程快照中的全部 TypeScript 类型错误。',
    { label: '指挥规划' },
  );
  if (plan.status !== 'ok') return { ok: false, stage: 'direct', error: plan.message };
  phase('collect');
  const errors = await agent('读取工程快照并运行类型检查，逐条列出全部 TypeScript 类型错误（文件、行、错误码）。', {
    label: '收集类型错误',
  });
  if (errors.status !== 'ok') return { ok: false, stage: 'collect', error: errors.message };
  phase('fix');
  const fix = await agent('针对下列类型错误逐一给出最小修复方案并按文件归组：' + String(errors.value), {
    label: '修复方案',
  });
  if (fix.status !== 'ok') return { ok: false, stage: 'fix', error: fix.message };
  return { ok: true, plan: plan.value, errors: errors.value, fix: fix.value };
}
