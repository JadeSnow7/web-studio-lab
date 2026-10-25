export const meta = { name: 'schema-ok', description: '带 schema 的结构化返回', phases: ['查询'] };

export default async function main() {
  phase('查询');
  const r = await agent('给出数量', {
    label: 'count',
    isolation: 'readonly',
    schema: { type: 'object', required: ['count'], properties: { count: { type: 'number' } }, additionalProperties: false },
  });
  return { status: 'complete', count: r.status === 'ok' ? r.value.count : -1 };
}
