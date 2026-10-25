export const meta = { name: 'schema-retry', description: 'schema 违约后重试成功', phases: ['查询'] };

export default async function main() {
  phase('查询');
  const r = await agent('给出数量', {
    label: 'count-retry',
    isolation: 'readonly',
    retries: 2,
    schema: { type: 'object', required: ['count'], properties: { count: { type: 'number' } }, additionalProperties: false },
  });
  return { status: 'complete', count: r.status === 'ok' ? r.value.count : -1 };
}
