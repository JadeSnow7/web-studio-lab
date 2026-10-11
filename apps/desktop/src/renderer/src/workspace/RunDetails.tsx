import type { StatusScope, WorkbenchRun } from '@wsl/protocol';
import { StatusDot } from '../components/Status';
import { useStatusViewByKey } from '../state/status-view';

export type RunView = 'log' | 'diff' | 'report';

const sessionScopeOf = (run: WorkbenchRun): StatusScope => ({ kind: 'session', workspaceId: run.workspaceId, sessionId: run.sessionId });

/** 字段名 + 展示层视图（形状 + 可见的中文 label）；视图不存在时整行不渲染。 */
function StatusField({ scope, statusKey, name }: { scope: StatusScope; statusKey: string; name?: string }) {
  const view = useStatusViewByKey(scope, statusKey);
  if (!view) return null;
  return (
    <p className="status-field">
      {name ? <span>{name}：</span> : null}
      <StatusDot view={view} visibleLabel />
    </p>
  );
}

/**
 * 执行 / 检查（含适用性）/ 审阅：文案与形状都来自展示层的 run / validation / review 视图，
 * 会话页与任务历史页共用，不再各自拼接原始枚举。
 * 检查失败 / 无法执行的原因在此无条件可见：页内是记录，会话状态槽是告警，两处重复可以接受，也不必推断槽是否承载了原因。
 */
export function RunStatusFields({ run, fields }: { run: WorkbenchRun; fields: ReadonlyArray<'run' | 'validation' | 'review'> }) {
  const scope = sessionScopeOf(run);
  return (
    <>
      {fields.includes('run') ? <StatusField scope={scope} statusKey={`run:${run.runId}:state`} name="执行" /> : null}
      {fields.includes('validation') ? (
        <>
          <StatusField scope={scope} statusKey={`validation:${run.runId}:state`} name="检查" />
          <StatusField scope={scope} statusKey={`validation:${run.runId}:applicability`} />
          {run.validation.reason ? <p className="muted">{run.validation.reason}</p> : null}
        </>
      ) : null}
      {fields.includes('review') ? <StatusField scope={scope} statusKey={`review:${run.runId}:state`} name="审阅" /> : null}
    </>
  );
}

export function RunDetails({ run, view }: { run: WorkbenchRun; view: RunView }) {
  return (
    <section aria-label="运行详情" className="version-card">
      {view === 'log' ? (
        <>
          <RunStatusFields run={run} fields={['run']} />
          {run.conversation ? (
            <>
              <div role="log" aria-label="运行消息">
                {run.conversation.messages.map((m) => (
                  <p key={m.id}>
                    {m.role === 'user' ? '你' : 'Codex CLI'}：{m.text}
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
        <>
          <RunStatusFields run={run} fields={['run']} />
          <p>真实 diff 尚未记录，无法展示文件修改证据。</p>
        </>
      ) : (
        <>
          <RunStatusFields run={run} fields={['run', 'validation']} />
          <p>真实检查报告尚未记录；执行完成不代表检查通过。</p>
          <RunStatusFields run={run} fields={['review']} />
        </>
      )}
    </section>
  );
}
