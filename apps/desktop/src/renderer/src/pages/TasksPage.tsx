import { useState } from 'react';
import type { RunRecord, TaskVersion } from '@wsl/protocol';
import { DemoBadge, DisabledAction, Notice, StatusPill } from '../components/Badges';
import { CASE_PRESETS, SCOPE_LABELS } from '../domain/cases';
import { DEMO_SCENARIOS } from '../demo/runScenarios';
import { useStore } from '../lib/store';
import { formatDateTime } from '../lib/time';
import { runsActions, runsStore } from '../state/runs';
import { shellActions } from '../state/shell';
import { workbenchStore } from '../state/workbench';
import { RunSummary } from '../workbench/RunSummary';

type Selection = { kind: 'version'; version: number } | { kind: 'run'; runId: string } | null;

function VersionDetail({ version }: { version: TaskVersion }) {
  return (
    <>
      <span className="muted small">已确认的任务版本（本次启动内，尚未持久化）</span>
      <h2>
        任务 v{version.version} · {CASE_PRESETS[version.caseId].label} {CASE_PRESETS[version.caseId].title}
      </h2>
      <p>{version.goal}</p>
      <dl className="kv">
        <dt>确认时间</dt>
        <dd>{formatDateTime(version.confirmedAt)}</dd>
        <dt>允许修改</dt>
        <dd>{version.allowedScopes.map((s) => SCOPE_LABELS[s]).join('、')}</dd>
        <dt>验收</dt>
        <dd>
          <ul className="tight-list">
            {version.acceptance.map((a) => (
              <li key={a}>{a}</li>
            ))}
          </ul>
        </dd>
        <dt>预算</dt>
        <dd>
          最多 {version.budget.maxAttempts} 次 attempt · {version.budget.timeLimitMinutes} 分钟
        </dd>
        <dt>页面现场</dt>
        <dd>
          <code className="wrap">{version.capture.page.url}</code> · webContents #{version.capture.page.webContentsId} · 文档代次{' '}
          {version.capture.page.documentGeneration}
        </dd>
      </dl>
    </>
  );
}

function HistoryDetail({ record }: { record: RunRecord }) {
  return (
    <>
      <Notice tone="history">
        <strong>历史记录 · 只读。</strong>这里显示保存的结果，查看不会重新运行，也不会调用模型或恢复进程。
      </Notice>
      <h2>{DEMO_SCENARIOS.find((s) => s.runId === record.runId)?.title ?? record.runId}</h2>
      <RunSummary record={record} readOnly />
      <div className="row gap-8 wrap">
        <button
          type="button"
          className="btn"
          onClick={() => {
            runsActions.select(record.runId);
            shellActions.navigate('space');
            shellActions.setBrowserTab('report');
          }}
        >
          在工作台查看报告与 diff
        </button>
        <DisabledAction label="无模型复验" reason="无模型复验入口待 T09 实现；复验会新建 revalidate 记录，不改写这条记录" icon="reload" />
      </div>
    </>
  );
}

/** 任务页：已确认的任务版本与运行记录（历史查看）。 */
export function TasksPage() {
  const versions = useStore(workbenchStore, (s) => s.versions);
  const runs = useStore(runsStore, (s) => s);
  const [selection, setSelection] = useState<Selection>(null);
  const records = [...runs.liveRecords, ...runs.demoRecords];
  const selectedVersion = selection?.kind === 'version' ? versions.find((v) => v.version === selection.version) : undefined;
  const selectedRun = selection?.kind === 'run' ? records.find((r) => r.runId === selection.runId) : undefined;

  return (
    <div className="page-columns">
      <nav className="page-sidebar page-sidebar-wide" aria-label="任务与运行记录">
        <h2 className="side-title">任务版本</h2>
        {versions.length === 0 ? <p className="muted small">还没有确认的任务。在空间的 Workshop 里采集现场并确认任务。</p> : null}
        {versions.map((v) => (
          <button
            key={v.version}
            type="button"
            className="conv-row"
            aria-current={selection?.kind === 'version' && selection.version === v.version ? 'true' : undefined}
            onClick={() => setSelection({ kind: 'version', version: v.version })}
          >
            <strong>
              v{v.version} · {CASE_PRESETS[v.caseId].label} {CASE_PRESETS[v.caseId].title}
            </strong>
            <span className="muted small">{formatDateTime(v.confirmedAt)}</span>
          </button>
        ))}
        <h2 className="side-title">
          运行记录 <DemoBadge />
        </h2>
        {runs.liveRecords.length === 0 ? <p className="muted small">没有真实运行记录；以下是演示记录。</p> : null}
        {records.map((r) => (
          <button
            key={r.runId}
            type="button"
            className="conv-row"
            aria-current={selection?.kind === 'run' && selection.runId === r.runId ? 'true' : undefined}
            onClick={() => setSelection({ kind: 'run', runId: r.runId })}
          >
            <span className="row space-between">
              <strong>{DEMO_SCENARIOS.find((s) => s.runId === r.runId)?.title ?? r.runId}</strong>
              <StatusPill status={r.status} />
            </span>
            <span className="muted small">
              {CASE_PRESETS[r.caseId].label} · {r.mode === 'online' ? '在线运行' : '无模型复验'} · {r.origin === 'demo' ? '演示' : '真实'}
            </span>
          </button>
        ))}
      </nav>
      <section className="page-main" aria-label="详情">
        {selectedVersion ? <VersionDetail version={selectedVersion} /> : null}
        {selectedRun ? <HistoryDetail record={selectedRun} /> : null}
        {!selectedVersion && !selectedRun ? <p className="muted">选择左侧的任务版本或运行记录。</p> : null}
      </section>
    </div>
  );
}
