import { useState } from 'react';
import type { CheckResult, RunRecord } from '@wsl/protocol';
import { DemoBadge, Notice, StatusPill } from '../components/Badges';
import { formatTime } from '../lib/time';
import { PatchView } from '../components/PatchView';

function EmptyRun() {
  return (
    <div className="view-empty">
      <strong>还没有可显示的运行记录</strong>
      <p>真实运行需要执行服务（T04）与 Codex CLI（T02）接入。要检查界面，可以在 Workshop 的“演示状态检查”里选择一条演示记录。</p>
    </div>
  );
}

function OriginBanner({ record }: { record: RunRecord }) {
  if (record.origin !== 'demo') return null;
  return (
    <div className="view-banner">
      <DemoBadge /> <span>演示记录 · {record.runId} · 不是真实运行结果</span>
    </div>
  );
}

export function LogView({ record }: { record: RunRecord | null }) {
  if (!record) return <EmptyRun />;
  return (
    <div className="view">
      <OriginBanner record={record} />
      <div className="log" role="log" aria-label="运行事件">
        {record.events.map((e) => (
          <div key={e.seq} className="log-line">
            <span className="log-seq">{e.seq}</span>
            <span className="log-time">{formatTime(e.timestamp)}</span>
            <span className="log-type">{e.type}</span>
            <span className="log-detail">{e.detail}</span>
          </div>
        ))}
      </div>
    </div>
  );
}

export function DiffView({ record }: { record: RunRecord | null }) {
  if (!record) return <EmptyRun />;
  const files = record.attempts.at(-1)?.files ?? [];
  return (
    <div className="view">
      <OriginBanner record={record} />
      <PatchView
        files={files}
        patch={record.diff ?? null}
        emptyText={`这次记录没有改动文件${record.mode === 'revalidate' ? '（无模型复验不修改代码）' : ''}。`}
      />
    </div>
  );
}

const RESULT_LABEL: Record<CheckResult, string> = {
  pass: '通过',
  fail: '未通过',
  error: '无法判断（工具故障）',
  running: '进行中',
  pending: '等待',
  not_run: '未执行',
};

export function ReportView({ record }: { record: RunRecord | null }) {
  const [attemptIndex, setAttemptIndex] = useState<number | null>(null);
  if (!record) return <EmptyRun />;
  const attempt = record.attempts.find((a) => a.index === attemptIndex) ?? record.attempts.at(-1) ?? null;
  return (
    <div className="view view-doc">
      <OriginBanner record={record} />
      <div className="row space-between">
        <h2 className="view-title">固定验收报告</h2>
        <StatusPill status={record.status} />
      </div>
      {record.statusReason ? <p>{record.statusReason}</p> : null}
      {record.status === 'inconclusive' ? <Notice tone="warn">检查工具故障导致无法判断，不能当作业务验收失败或通过。</Notice> : null}
      {record.attempts.length > 1 ? (
        <div className="segmented" role="tablist" aria-label="attempt">
          {record.attempts.map((a) => (
            <button
              key={a.attemptId}
              type="button"
              role="tab"
              aria-selected={attempt?.index === a.index}
              onClick={() => setAttemptIndex(a.index)}
            >
              attempt {a.index}
            </button>
          ))}
        </div>
      ) : null}
      {attempt ? (
        <table className="table">
          <thead>
            <tr>
              <th>检查项</th>
              <th>执行方</th>
              <th>结果</th>
              <th>说明</th>
            </tr>
          </thead>
          <tbody>
            {attempt.checks.map((c) => (
              <tr key={c.id}>
                <td>{c.label}</td>
                <td>{c.runner === 'playwright' ? 'Playwright' : c.runner === 'api' ? 'API 检查' : '服务'}</td>
                <td>
                  <span className={`result result-${c.result}`}>{RESULT_LABEL[c.result]}</span>
                </td>
                <td className="muted">{c.detail ?? ''}</td>
              </tr>
            ))}
          </tbody>
        </table>
      ) : (
        <p className="muted">还没有 attempt。</p>
      )}
      <p className="muted small">固定验收在独立的 Playwright Chromium（全新 context）中运行，结果与 Browser 区预览分开标注。</p>
    </div>
  );
}
