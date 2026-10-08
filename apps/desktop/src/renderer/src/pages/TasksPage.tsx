import { useState } from 'react';
import { useStore } from '../lib/store';
import { workspaceStore } from '../state/workspace';
import { locateSession } from '../state/location';
import { DEMO_RUNS } from '../demo/runScenarios';
import { LogView, DiffView, ReportView } from '../workbench/RunViews';
import { RunDetails, type RunView } from '../workspace/RunDetails';
export function TasksPage() {
  const snapshot = useStore(workspaceStore, (s) => s.snapshot);
  const [selection, setSelection] = useState<{ workspaceId: string; runId: string } | null>(null);
  const [demoId, setDemoId] = useState('');
  const [view, setView] = useState<RunView>('log');
  const owner = snapshot?.workspaces.find((w) => w.workspaceId === selection?.workspaceId);
  const run = owner?.runs.find((r) => r.runId === selection?.runId);
  const demo = DEMO_RUNS.find((r) => r.runId === demoId);
  return (
    <div className="page-columns">
      <nav className="page-sidebar page-sidebar-wide" aria-label="任务与运行记录">
        <h2>任务历史</h2>
        {snapshot?.workspaces.map((w) => (
          <section key={w.workspaceId}>
            <h3>{w.name}</h3>
            {w.sessions.flatMap((s) =>
              s.taskVersions.map((v) => (
                <div key={v.taskVersionId}>
                  <button
                    type="button"
                    className="btn"
                    onClick={() =>
                      void locateSession({
                        workspaceId: w.workspaceId,
                        sessionId: s.sessionId,
                        taskVersionId: v.taskVersionId,
                        view: 'task',
                      })
                    }
                  >
                    任务 v{v.version} · {v.goal}
                  </button>
                  {w.runs
                    .filter((r) => r.taskVersionId === v.taskVersionId)
                    .map((r) => (
                      <button
                        type="button"
                        className="conv-row"
                        key={r.runId}
                        onClick={() => {
                          setSelection({ workspaceId: w.workspaceId, runId: r.runId });
                          setDemoId('');
                        }}
                      >
                        运行 · {v.goal} · {r.runId} · {r.state}
                      </button>
                    ))}
                </div>
              )),
            )}
            {!w.sessions.some((s) => s.taskVersions.length) ? <p className="muted">尚无确认的任务。</p> : null}
          </section>
        ))}
        <details>
          <summary>演示记录（独立，只读）</summary>
          {DEMO_RUNS.map((r) => (
            <button
              className="conv-row"
              type="button"
              key={r.runId}
              onClick={() => {
                setDemoId(r.runId);
                setSelection(null);
              }}
            >
              {r.runId} · 演示记录
            </button>
          ))}
        </details>
      </nav>
      <section className="page-main" aria-label="任务详情">
        {run || demo ? (
          <nav className="row gap-8" aria-label="运行视图">
            {(['log', 'diff', 'report'] as const).map((v, i) => (
              <button className="btn" type="button" key={v} aria-pressed={view === v} onClick={() => setView(v)}>
                {['日志', 'diff', '报告'][i]}
              </button>
            ))}
          </nav>
        ) : null}
        {run && owner ? (
          <>
            <p>历史记录 · 查看不会执行或改变审阅。</p>
            <RunDetails run={run} view={view} />
            <button
              type="button"
              className="btn"
              onClick={() =>
                void locateSession({
                  workspaceId: owner.workspaceId,
                  sessionId: run.sessionId,
                  taskVersionId: run.taskVersionId,
                  runId: run.runId,
                  view,
                })
              }
            >
              定位原会话
            </button>
          </>
        ) : null}
        {demo ? (
          <>{view === 'log' ? <LogView record={demo} /> : view === 'diff' ? <DiffView record={demo} /> : <ReportView record={demo} />}</>
        ) : null}
        {!run && !demo ? <p className="muted">选择任务版本或运行记录。</p> : null}
      </section>
    </div>
  );
}
