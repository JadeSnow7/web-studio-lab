export const meta = { name: 'while-until-done', description: '数据依赖循环直到完成', phases: ['轮询'] };

export default async function main() {
  phase('轮询');
  let round = 0;
  while (round < 5) {
    const r = await agent(`第 ${round} 轮探测`, {
      label: `probe-${round}`,
      isolation: 'readonly',
      schema: { type: 'object', required: ['done'], properties: { done: { type: 'boolean' } }, additionalProperties: false },
    });
    round++;
    if (r.status !== 'ok' || r.value.done) break;
  }
  return { status: 'complete', rounds: round };
}
