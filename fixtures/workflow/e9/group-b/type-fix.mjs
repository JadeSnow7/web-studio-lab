export const meta = {
  name: 'E9-B 类型错误修复',
  description: 'B 组手写 workflow：先收集类型错误，再给出修复方案。（E9 预注册任务 type-fix）',
  phases: ['collect', 'fix'],
};

export default async function main() {
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
  return { ok: true, errors: errors.value, fix: fix.value };
}
