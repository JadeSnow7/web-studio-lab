export const meta = {
  name: 'E9-B 鉴权缺陷审计',
  description: 'B 组手写 workflow：三个区域并行审计后汇总去重。（E9 预注册任务 authz-audit）',
  phases: ['scan', 'triage', 'report'],
};

export default async function main() {
  phase('scan');
  const [routes, services, views] = await parallel([
    () => agent('审计快照中路由/入口层的鉴权检查缺陷，逐条给出路径与证据。', { label: '审计-路由' }),
    () => agent('审计快照中服务/数据访问层的鉴权检查缺陷，逐条给出路径与证据。', { label: '审计-服务' }),
    () => agent('审计快照中视图/接口暴露面的鉴权检查缺陷，逐条给出路径与证据。', { label: '审计-视图' }),
  ]);
  phase('triage');
  const merged = await agent(
    '合并下列三份审计清单，去除重复并标注每条的可信度：' +
      [routes, services, views].map((r) => String(r.status === 'ok' ? r.value : r.message)).join('\n---\n'),
    { label: '归并审计' },
  );
  if (merged.status !== 'ok') return { ok: false, stage: 'triage', error: merged.message };
  phase('report');
  const report = await agent('把归并后的缺陷清单整理为审计报告（按严重度排序）：' + String(merged.value), {
    label: '审计报告',
  });
  if (report.status !== 'ok') return { ok: false, stage: 'report', error: report.message };
  return { ok: true, findings: merged.value, report: report.value };
}
