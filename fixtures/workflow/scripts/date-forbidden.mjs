export const meta = { name: 'date-forbidden', description: '负例：调用被禁用的时间 API', phases: ['探测'] };

export default async function main() {
  phase('探测');
  const t = Date.now();
  return { status: 'complete', t };
}
