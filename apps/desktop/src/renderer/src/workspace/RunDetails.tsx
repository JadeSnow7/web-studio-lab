import { useEffect, useState } from 'react';
import type { CapturedSourceChange, StatusScope, WorkbenchRun } from '@wsl/protocol';
import { sourceChangeStatus } from '../../../shared/status';
import { PatchView } from '../components/PatchView';
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

function CapturedRunPatch({ workspaceId, runId, source }: { workspaceId: string; runId: string; source: CapturedSourceChange }) {
  const [result, setResult] = useState<{ patch: string; error: null } | { patch: null; error: string } | null>(null);
  const [readAttempt, setReadAttempt] = useState(0);
  const patchSha256 = source.patchSha256;
  useEffect(() => {
    let current = true;
    void window.studio.workbench.runPatch(workspaceId, runId).then(
      (response) => {
        if (!current) return;
        if (response.workspaceId !== workspaceId || response.runId !== runId || response.patchSha256 !== patchSha256) {
          setResult({ patch: null, error: '源码 diff 返回的运行或摘要身份不一致' });
          return;
        }
        setResult({ patch: response.patch, error: null });
      },
      (error: unknown) => {
        if (current) setResult({ patch: null, error: `源码 diff 读取失败：${error instanceof Error ? error.message : '不可用'}` });
      },
    );
    return () => {
      current = false;
    };
  }, [workspaceId, runId, patchSha256, readAttempt]);
  return (
    <>
      <p className="muted">
        合计 <span className="text-ok">+{source.additions}</span> / <span className="text-bad">−{source.deletions}</span>
      </p>
      {source.truncated ? (
        <p className="muted">摘要最多显示 200 个文件，patch 最多 256 KiB；此证据已截断，行数合计仍覆盖完整差异。</p>
      ) : null}
      <PatchView files={source.files} patch={result?.patch ?? null} emptyText="没有改动文件。" />
      {!result ? (
        <p role="status">正在读取源码 diff…</p>
      ) : result.error ? (
        <div>
          <p role="alert">{result.error}</p>
          <button
            type="button"
            className="btn"
            onClick={() => {
              setResult(null);
              setReadAttempt((attempt) => attempt + 1);
            }}
          >
            重新读取
          </button>
        </div>
      ) : null}
    </>
  );
}

function RunDiff({ run }: { run: WorkbenchRun }) {
  const source = run.sourceChange;
  const fact = sourceChangeStatus(run);
  return (
    <>
      <RunStatusFields run={run} fields={['run']} />
      {source ? (
        <StatusField scope={sessionScopeOf(run)} statusKey={`run:${run.runId}:source-change`} name="源码" />
      ) : (
        <p role="status">{fact.label}</p>
      )}
      <StatusField scope={sessionScopeOf(run)} statusKey={`run:${run.runId}:source-cleanup`} />
      {fact.detail ? <p className="muted">{fact.detail}</p> : null}
      {source?.state === 'captured' ? (
        <CapturedRunPatch
          key={`${run.workspaceId}:${run.runId}:${source.patchSha256}`}
          workspaceId={run.workspaceId}
          runId={run.runId}
          source={source}
        />
      ) : null}
      <p className="muted small">源码差异是本次执行前后的内容证据，不代表独立检查通过或用户接受。</p>
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
        </>
      ) : view === 'diff' ? (
        <RunDiff run={run} />
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
