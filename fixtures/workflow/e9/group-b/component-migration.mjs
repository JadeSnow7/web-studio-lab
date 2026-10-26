export const meta = {
  name: 'E9-B 组件迁移',
  description: 'B 组手写 workflow：盘点类组件 → 逐件迁移方案 → 校验清单。（E9 预注册任务 component-migration）',
  phases: ['inventory', 'migrate', 'verify'],
};

export default async function main() {
  phase('inventory');
  const list = await agent('盘点工程快照中需要迁移到函数组件的类组件清单（路径、props、state、生命周期使用）。', {
    label: '组件盘点',
  });
  if (list.status !== 'ok') return { ok: false, stage: 'inventory', error: list.message };
  phase('migrate');
  const plan = await agent('对下列每个类组件给出保持行为不变的函数组件迁移方案（含 hooks 等价物）：' + String(list.value), {
    label: '迁移方案',
  });
  if (plan.status !== 'ok') return { ok: false, stage: 'migrate', error: plan.message };
  phase('verify');
  const verify = await agent('核对迁移方案与既有测试套件的行为约定，列出需要复核的边界：' + String(plan.value), {
    label: '迁移核对',
  });
  if (verify.status !== 'ok') return { ok: false, stage: 'verify', error: verify.message };
  return { ok: true, plan: plan.value, verify: verify.value };
}
