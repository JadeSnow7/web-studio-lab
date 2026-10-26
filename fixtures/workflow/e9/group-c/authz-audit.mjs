export const meta = {
  name: 'E9-C 鉴权缺陷审计',
  description: 'C 组 Ultra 指挥变体：指挥调用决定并行审计波次，执行与 B 同构。（E9 预注册任务 authz-audit）',
  phases: ['direct', 'scan', 'triage', 'report'],
  ultra: true,
};

export default async function main() {
  phase('direct');
  const plan = await agent(
    '先判断这个任务是否值得编排：不值得就退化为单个调用直接完成；值得才给出确定性计划（phases、并行只读波次、预算分配），规划本身计入总预算。任务：审计冻结工程快照中的鉴权检查缺陷并给出召回口径。',
    { label: '指挥规划' },
  );
  if (plan.status !== 'ok') return { ok: false, stage: 'direct', error: plan.message };
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
  return { ok: true, plan: plan.value, findings: merged.value, report: report.value };
}
