import { DEMO_FEED } from '../demo/sampleData';
import { useStore } from '../lib/store';
import { workspaceStore, workspaceCommand } from '../state/workspace';
import { locateSession } from '../state/location';
export function Notifications({ onOpen }: { onOpen?: (sessionId: string) => void } = {}) {
  const snapshot = useStore(workspaceStore, (s) => s.snapshot);
  return (
    <aside role="region" className="workspace-notifications" aria-label="通知">
      <h2>通知</h2>
      <p className="muted small">打开运行与标记已读分别记录。</p>
      {snapshot?.notifications.map((n) => (
        <article className="version-card" data-run-id={n.runId} key={n.notificationId}>
          <p>
            {snapshot.workspaces.find((w) => w.workspaceId === n.workspaceId)?.name} ·{' '}
            {{ completed: '执行完成', failed: '执行失败', cancelled: '已取消', interrupted: '中断待核对' }[n.kind]}
          </p>
          <p className="wrap">
            {n.runId} · {n.readAt ? '已读' : '未读'}
          </p>
          <p>
            检查：
            {
              snapshot.workspaces.find((w) => w.workspaceId === n.workspaceId)?.runs.find((r) => r.runId === n.runId)?.validation.state
            } ·{' '}
            {snapshot.workspaces.find((w) => w.workspaceId === n.workspaceId)?.runs.find((r) => r.runId === n.runId)?.review?.decision ??
              (n.kind === 'completed' ? '待审阅' : '尚未审阅')}
          </p>
          <p className="muted small">{new Date(n.occurredAt).toLocaleString('zh-CN')}</p>
          <div className="row gap-8 wrap">
            <button
              className="btn"
              type="button"
              onClick={() =>
                void locateSession({
                  workspaceId: n.workspaceId,
                  sessionId: n.sessionId,
                  taskVersionId: n.taskVersionId,
                  runId: n.runId,
                  view: 'log',
                }).then((opened) => {
                  if (opened) onOpen?.(n.sessionId);
                })
              }
            >
              打开运行
            </button>
            <button
              className="btn"
              type="button"
              disabled={!!n.readAt}
              onClick={() => void workspaceCommand(n.workspaceId, { type: 'markNotificationRead', notificationId: n.notificationId })}
            >
              标记已读
            </button>
          </div>
        </article>
      ))}
      <details>
        <summary>历史演示动态（只读）</summary>
        <p className="muted">以下保存历史演示文案，不是真实执行、阅读回执或审阅结果。</p>
        {DEMO_FEED.map((item) => (
          <article className="version-card" key={item.id}>
            <strong>{item.title}</strong>
            <blockquote>{item.note}</blockquote>
            <span>{item.meta}</span>
          </article>
        ))}
      </details>
      {!snapshot?.notifications.length ? <p className="muted">暂无运行通知。</p> : null}
    </aside>
  );
}
