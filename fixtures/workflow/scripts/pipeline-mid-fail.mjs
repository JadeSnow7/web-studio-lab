export const meta = { name: 'pipeline-mid-fail', description: '中段失败的槽位短路', phases: ['流水'] };

export default async function main() {
  phase('流水');
  const out = await pipeline(
    ['a', 'b', 'c'],
    (item) => agent(`分析 ${item}`, { label: `s1-${item}`, isolation: 'readonly' }),
    (prev) => agent(`汇总 ${prev}`, { label: `s2-${prev}`, isolation: 'readonly' }),
  );
  return {
    status: 'complete',
    ok: out.filter((r) => r.status === 'ok').length,
    codes: out.map((r) => (r.status === 'ok' ? 'ok' : r.code)),
  };
}
