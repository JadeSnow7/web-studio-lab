export const meta = { name: 'parallel-collect', description: '按输入顺序收集并行分支', phases: ['并行'] };

export default async function main() {
  phase('并行');
  const results = await parallel([0, 1, 2].map((i) => () => agent(`分支 ${i}`, { label: `p-${i}`, isolation: 'readonly' })));
  return { status: 'complete', values: results.map((r) => (r.status === 'ok' ? r.value : null)) };
}
