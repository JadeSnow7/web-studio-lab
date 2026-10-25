export const meta = { name: 'fanout-4097', description: '负例：parallel 超出 4096 上限', phases: ['扇出'] };

export default async function main() {
  phase('扇出');
  await parallel(Array.from({ length: 4097 }, (_, i) => () => agent(`分支 ${i}`, { label: `f-${i}`, isolation: 'readonly' })));
  return { status: 'complete' };
}
