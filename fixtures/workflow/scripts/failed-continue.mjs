export const meta = { name: 'failed-continue', description: '中途失败不中断脚本', phases: ['批量'] };

export default async function main() {
  phase('批量');
  const labels = ['ok-1', 'bad', 'ok-2'];
  let ok = 0,
    failed = 0;
  for (const label of labels) {
    const r = await agent(`处理 ${label}`, { label, isolation: 'readonly' });
    if (r.status === 'ok') ok++;
    else failed++;
  }
  return { status: 'complete', ok, failed };
}
