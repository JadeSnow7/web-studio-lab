export const meta = { name: 'seq-two-calls', description: '顺序两次调用并汇总', phases: ['诊断', '汇总'] };

export default async function main() {
  phase('诊断');
  const a = await agent('读取诊断输入', { label: 'diag', isolation: 'readonly' });
  phase('汇总');
  const b = await agent('汇总诊断结果', { label: 'sum', isolation: 'readonly' });
  return { status: 'complete', a: a.status === 'ok' ? a.value : null, b: b.status === 'ok' ? b.value : null };
}
