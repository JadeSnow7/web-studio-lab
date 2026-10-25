import type { WorkbenchNotification } from '@wsl/protocol';
import { DEMO_FEED } from '../demo/sampleData';
import { useStore } from '../lib/store';
import { workspaceStore, workspaceCommand } from '../state/workspace';
import { locateSession } from '../state/location';
import { statusLabel, useScopeViews } from '../state/status-view';
import { demoEntriesVisible, environmentStore } from '../state/execution';

/** 检查与审阅用展示层的中文 label（validation / review 的 state 事实），不外露原始枚举。 */
function ResultSummary({ notification: n }: { notification: WorkbenchNotification }) {
  const views = useScopeViews({ kind: 'session', workspaceId: n.workspaceId, sessionId: n.sessionId });
  const validation = statusLabel(views, `validation:${n.runId}:state`);
  const review = statusLabel(views, `review:${n.runId}:state`);
  const text = [validation, review].filter(Boolean).join(' · ');
  return text ? <p>{text}</p> : null;
}
export function Notifications({ onOpen }: { onOpen?: (sessionId: string) => void } = {}) {
  const snapshot = useStore(workspaceStore, (s) => s.snapshot);
  // 历史演示动态是演示条目：正式构建隐藏，开发服务器或 WSL_DEBUG_STATUS=1 时才显示（OPS-1 S4）；真实通知不受影响。
  const showDemo = useStore(environmentStore, demoEntriesVisible);
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
          <ResultSummary notification={n} />
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
      {showDemo ? (
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
      ) : null}
      {!snapshot?.notifications.length ? <p className="muted">暂无运行通知。</p> : null}
    </aside>
  );
}
