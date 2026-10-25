export const meta = { name: 'args-echo', description: '使用 args 构造 prompt', phases: ['执行'] };

export default async function main() {
  phase('执行');
  const r = await agent(`分析主题：${args.topic}`, { label: 'echo', isolation: 'readonly' });
  return { status: 'complete', value: r.status === 'ok' ? r.value : null };
}
