export const meta = { name: 'result-too-large', description: '超限结果返回 failed', phases: ['读取'] };

export default async function main() {
  phase('读取');
  const r = await agent('读取大结果', { label: 'big', isolation: 'readonly' });
  return { status: 'complete', code: r.status === 'failed' ? r.code : 'ok' };
}
