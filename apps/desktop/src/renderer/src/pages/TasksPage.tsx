import { useState } from 'react';
import type { WorkbenchRun } from '@wsl/protocol';
import { useStore } from '../lib/store';
import { workspaceStore } from '../state/workspace';
import { locateSession } from '../state/location';
import { DEMO_RUNS } from '../demo/runScenarios';
import { LogView, DiffView, ReportView } from '../workbench/RunViews';
import { RunDetails, type RunView } from '../workspace/RunDetails';
import { StatusDot } from '../components/Status';
import { useStatusViewByKey } from '../state/status-view';
import { demoEntriesVisible, environmentStore } from '../state/execution';

/** 运行记录行：状态是展示层的形状（中文 label 视觉隐藏），runId 只在悬停里。 */
function RunRow({ run, goal, onSelect }: { run: WorkbenchRun; goal: string; onSelect: () => void }) {
  const view = useStatusViewByKey({ kind: 'session', workspaceId: run.workspaceId, sessionId: run.sessionId }, `run:${run.runId}:state`);
  return (
    <button type="button" className="conv-row run-row-status" title={run.runId} onClick={onSelect}>
      运行 · {goal}
      {view ? <StatusDot view={view} /> : null}
    </button>
  );
}

export function TasksPage() {
  const snapshot = useStore(workspaceStore, (s) => s.snapshot);
  const [selection, setSelection] = useState<{ workspaceId: string; runId: string } | null>(null);
  const [demoId, setDemoId] = useState('');
  const [view, setView] = useState<RunView>('log');
  const owner = snapshot?.workspaces.find((w) => w.workspaceId === selection?.workspaceId);
  const run = owner?.runs.find((r) => r.runId === selection?.runId);
  // 演示记录与真实历史分开，只在开发服务器或 WSL_DEBUG_STATUS=1 时显示（OPS-1 S4）；真实任务历史不受影响。
  const showDemo = useStore(environmentStore, demoEntriesVisible);
  const demo = showDemo ? DEMO_RUNS.find((r) => r.runId === demoId) : undefined;
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
                      <RunRow
                        key={r.runId}
                        run={r}
                        goal={v.goal}
                        onSelect={() => {
                          setSelection({ workspaceId: w.workspaceId, runId: r.runId });
                          setDemoId('');
                        }}
                      />
                    ))}
                </div>
              )),
            )}
            {!w.sessions.some((s) => s.taskVersions.length) ? <p className="muted">尚无确认的任务。</p> : null}
          </section>
        ))}
        {showDemo ? (
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
        ) : null}
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
