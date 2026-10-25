export const meta = { name: 'pipeline-ok', description: '两阶段流水线全部成功', phases: ['流水'] };

export default async function main() {
  phase('流水');
  const out = await pipeline(
    ['a', 'b', 'c'],
    (item) => agent(`分析 ${item}`, { label: `s1-${item}`, isolation: 'readonly' }),
    (prev) => agent(`汇总 ${prev}`, { label: `s2-${prev}`, isolation: 'readonly' }),
  );
  return { status: 'complete', values: out.map((r) => (r.status === 'ok' ? r.value : null)) };
}
