export const meta = {
  name: 'E9-C 组件迁移',
  description: 'C 组 Ultra 指挥变体：指挥调用决定迁移次序与校验口径，执行与 B 同构。（E9 预注册任务 component-migration）',
  phases: ['direct', 'inventory', 'migrate', 'verify'],
  ultra: true,
};

export default async function main() {
  phase('direct');
  const plan = await agent(
    '先判断这个任务是否值得编排：不值得就退化为单个调用直接完成；值得才给出确定性计划（phases、并行只读波次、预算分配），规划本身计入总预算。任务：把冻结工程快照中的指定类组件迁移到函数组件并保持既有测试通过。',
    { label: '指挥规划' },
  );
  if (plan.status !== 'ok') return { ok: false, stage: 'direct', error: plan.message };
  phase('inventory');
  const list = await agent('盘点工程快照中需要迁移到函数组件的类组件清单（路径、props、state、生命周期使用）。', {
    label: '组件盘点',
  });
  if (list.status !== 'ok') return { ok: false, stage: 'inventory', error: list.message };
  phase('migrate');
  const plan2 = await agent('对下列每个类组件给出保持行为不变的函数组件迁移方案（含 hooks 等价物）：' + String(list.value), {
    label: '迁移方案',
  });
  if (plan2.status !== 'ok') return { ok: false, stage: 'migrate', error: plan2.message };
  phase('verify');
  const verify = await agent('核对迁移方案与既有测试套件的行为约定，列出需要复核的边界：' + String(plan2.value), {
    label: '迁移核对',
  });
  if (verify.status !== 'ok') return { ok: false, stage: 'verify', error: verify.message };
  return { ok: true, plan: plan.value, migration: plan2.value, verify: verify.value };
}
