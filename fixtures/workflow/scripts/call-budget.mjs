export const meta = { name: 'call-budget', description: '调用预算耗尽后正常退出', phases: ['刷屏'] };

export default async function main() {
  phase('刷屏');
  let i = 0,
    stoppedAt;
  while (true) {
    const r = await agent(`调用 ${i}`, { label: `c-${i}`, isolation: 'readonly' });
    if (r.status === 'failed' && r.code === 'call_budget_exceeded') {
      stoppedAt = i;
      break;
    }
    i++;
  }
  return { status: 'complete', stoppedAt };
}
