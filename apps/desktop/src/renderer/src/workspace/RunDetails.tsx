import type { WorkbenchRun } from '@wsl/protocol';
export type RunView = 'log' | 'diff' | 'report';
export function RunDetails({ run, view }: { run: WorkbenchRun; view: RunView }) {
  return (
    <section aria-label="运行详情" className="version-card">
      <p>
        运行 {run.runId} · 执行：{run.state}
      </p>
      {view === 'log' ? (
        <>
          {run.conversation ? (
            <>
              <div role="log" aria-label="运行消息">
                {run.conversation.messages.map((m) => (
                  <p key={m.id}>
                    {m.role}：{m.text}
                  </p>
                ))}
              </div>
              {run.conversation.toolExecutions.map((t) => (
                <details key={`${t.turnId}:${t.id}`}>
                  <summary>{t.command}</summary>
                  <pre>{t.output}</pre>
                  <p>
                    退出码 {t.exitCode ?? '未返回'}
                    {t.truncated ? ' · 已截断' : ''}
                  </p>
                </details>
              ))}
              {run.conversation.warnings.map((w) => (
                <p key={w}>{w}</p>
              ))}
            </>
          ) : (
            <p>此运行缺少可可靠归属的消息与工具日志；旧会话日志不会并入此运行。</p>
          )}
          {run.error || run.conversation?.error ? <p role="alert">{run.error ?? run.conversation?.error}</p> : null}
          <p className="muted small">
            执行绑定：
            {run.executionBinding ? `${run.executionBinding.generation} / ${run.executionBinding.turnId ?? '未返回 turnId'}` : '未记录'}
          </p>
        </>
      ) : view === 'diff' ? (
        <p>真实 diff 尚未记录，无法展示文件修改证据。</p>
      ) : (
        <>
          <p>
            检查：{run.validation.state} · 适用性：{run.validation.applicability}
          </p>
          <p>{run.validation.reason}</p>
          <p>真实检查报告尚未记录；执行完成不代表检查通过。</p>
          <p>审阅：{run.review?.decision ?? '尚未审阅'}</p>
        </>
      )}
    </section>
  );
}
