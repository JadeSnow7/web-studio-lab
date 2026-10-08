import { useEffect, useRef, useState } from 'react';
import type { WorkbenchSession, WorkspaceSnapshot, TargetRef } from '@wsl/protocol';
import { locationStore } from '../state/location';
import { captureContext } from '../state/capture';
import { SessionObservation } from './Observation';
import { sessionSelection } from './presentation';
import { RunDetails } from './RunDetails';
import { workspaceCommand } from '../state/workspace';

export function Session({ workspace, session }: { workspace: WorkspaceSnapshot; session: WorkbenchSession }) {
  const initialLocation = locationStore.get().location;
  const initial =
    initialLocation?.workspaceId === workspace.workspaceId && initialLocation.sessionId === session.sessionId ? initialLocation : null;
  const [view, setView] = useState<'conversation' | 'task' | 'context' | 'checks' | 'log' | 'diff' | 'report'>(
    initial?.view ?? 'conversation',
  );
  const [draft, setDraft] = useState(session.draft);
  const target = session.taskTargetRef?.resourceId ?? '';
  const savedAcceptance = session.taskAcceptance.join('\n');
  const savedScopes = session.taskAllowedScopes.join('\n');
  const [criteriaDraft, setCriteriaDraft] = useState({ acceptance: savedAcceptance, scopes: savedScopes });
  const criteriaRef = useRef(criteriaDraft),
    criteriaDirty = useRef(false);
  useEffect(() => {
    if (!criteriaDirty.current) {
      const draft = { acceptance: savedAcceptance, scopes: savedScopes };
      setCriteriaDraft(draft);
      criteriaRef.current = draft;
    }
  }, [savedAcceptance, savedScopes]);
  const saveCriteria = (field: 'acceptance' | 'scopes', value: string) => {
    const next = { ...criteriaRef.current, [field]: value };
    criteriaRef.current = next;
    criteriaDirty.current = true;
    setCriteriaDraft(next);
    void workspaceCommand(workspace.workspaceId, {
      type: 'saveTaskCriteria',
      sessionId: session.sessionId,
      acceptance: next.acceptance.split('\n').filter((x) => x.trim()),
      allowedScopes: next.scopes.split('\n').filter((x) => x.trim()),
    }).then((result) => {
      if (result?.ok && criteriaRef.current === next) criteriaDirty.current = false;
    });
  };

  const composing = useRef(false),
    dirty = useRef(false),
    draftValue = useRef(session.draft),
    saveTail = useRef(Promise.resolve());
  const [selectedVersionId, setSelectedVersionId] = useState(initial?.taskVersionId ?? '');
  const [selectedRunId, setSelectedRunId] = useState(initial?.runId ?? '');
  useEffect(
    () =>
      locationStore.subscribe(() => {
        const location = locationStore.get().location;
        if (location?.workspaceId !== workspace.workspaceId || location.sessionId !== session.sessionId) return;
        setSelectedRunId(location.runId ?? '');
        setSelectedVersionId(location.taskVersionId ?? '');
        setView(location.view ?? 'task');
      }),
    [workspace.workspaceId, session.sessionId],
  );
  const sessionRuns = workspace.runs.filter((r) => r.sessionId === session.sessionId);
  const currentRun = sessionRuns.at(-1);
  const { version, run, conversation } = sessionSelection(session, workspace.runs, selectedVersionId, selectedRunId);
  const context = selectedVersionId ? version?.capture : session.context;
  useEffect(() => {
    if (!dirty.current) {
      setDraft(session.draft);
      draftValue.current = session.draft;
    }
  }, [session.draft]);
  const save = (value: string) => {
    dirty.current = true;
    setDraft(value);
    draftValue.current = value;
    saveTail.current = saveTail.current.then(async () => {
      const result = await workspaceCommand(workspace.workspaceId, { type: 'saveDraft', sessionId: session.sessionId, draft: value });
      if (result?.ok) {
        if (value === draftValue.current) dirty.current = false;
      }
    });
  };
  const [submitting, setSubmitting] = useState(false);
  const submission = useRef(false);
  const busy = currentRun?.state === 'running' || currentRun?.state === 'starting' || currentRun?.state === 'cancelling';
  const perform = async (action: () => Promise<void>) => {
    if (submission.current) return;
    submission.current = true;
    setSubmitting(true);
    try {
      await action();
    } finally {
      submission.current = false;
      setSubmitting(false);
    }
  };
  const confirm = () =>
    perform(async () => {
      await saveTail.current;
      const resource = workspace.resources.find((r) => r.resourceId === target);
      const targetRef: TargetRef | null = resource ? { kind: resource.kind, resourceId: resource.resourceId } : null;
      await workspaceCommand(workspace.workspaceId, {
        type: 'confirmTask',
        sessionId: session.sessionId,
        goal: draftValue.current,
        targetRef,
      });
      setView('task');
    });
  const send = () =>
    perform(async () => {
      const text = draftValue.current;
      if (!text.trim() || busy) return;
      await saveTail.current;
      const resource = workspace.resources.find((r) => r.resourceId === target);
      const result = await workspaceCommand(workspace.workspaceId, {
        type: 'confirmTask',
        sessionId: session.sessionId,
        goal: text,
        targetRef: resource ? { kind: resource.kind, resourceId: resource.resourceId } : null,
      });
      if (!result?.ok) return;
      const next = result.snapshot.workspaces
        .find((w) => w.workspaceId === workspace.workspaceId)
        ?.sessions.find((s) => s.sessionId === session.sessionId)
        ?.taskVersions.at(-1);
      if (!next) throw new Error('任务确认成功但未返回版本');
      const started = await workspaceCommand(workspace.workspaceId, {
        type: 'startRun',
        sessionId: session.sessionId,
        taskVersionId: next.taskVersionId,
      });
      if (!started?.ok) return;
      const acceptedRun = started.snapshot.workspaces
        .find((w) => w.workspaceId === workspace.workspaceId)
        ?.runs.find((r) => r.taskVersionId === next.taskVersionId);
      if (acceptedRun && ['starting', 'running', 'completed'].includes(acceptedRun.state) && draftValue.current === text) save('');
    });
  return (
    <section className="session-workspace" aria-label="Agent 会话内容">
      <h2 className="sr-only" tabIndex={-1} id={`session-heading-${session.sessionId}`}>
        {session.title}
      </h2>
      <nav className="session-views" aria-label="会话视图">
        {(['conversation', 'task', 'context', 'checks', 'log', 'diff', 'report'] as const).map((v, i) => (
          <button
            type="button"
            key={v}
            className={`btn ${view === v ? 'btn-active' : ''}`}
            aria-pressed={view === v}
            onClick={() => setView(v)}
          >
            {['对话', '任务', '上下文', '检查', '日志', 'diff', '报告'][i]}
          </button>
        ))}
      </nav>
      <div className="session-scroll">
        {(selectedRunId && !run) || (selectedVersionId && !version) ? (
          <p role="alert">指定历史记录已不可用，请重新从任务历史定位。</p>
        ) : null}
        {run ? <p className="muted small">运行 {run.runId}</p> : null}
        {view === 'log' || view === 'diff' || view === 'report' ? run ? <RunDetails run={run} view={view} /> : <p>尚无运行记录。</p> : null}
        {session.historyRestored ? (
          <p role="status" className="history-restored">
            历史已恢复；新执行不会自动延续旧模型上下文。
          </p>
        ) : null}
        {view === 'conversation' ? (
          <>
            <p className="muted small">Codex CLI · {conversation?.state ?? '尚未运行'} · 沙箱由服务决定</p>
            <div role="log" aria-label="Codex 对话消息" aria-live="polite">
              {conversation?.messages.length ? (
                conversation.messages.map((m) => (
                  <div className={`message message-${m.role === 'user' ? 'user' : 'agent'}`} key={m.id}>
                    <p>{m.text}</p>
                    <span>{m.role === 'user' ? '你' : 'Codex CLI'}</span>
                  </div>
                ))
              ) : (
                <p className="workspace-empty">
                  {selectedVersionId && !run ? '此版本尚未运行。' : '描述想完成的工作；执行结果与检查分别记录。'}
                </p>
              )}
            </div>
            {conversation?.toolExecutions.length ? (
              <details>
                <summary>工具执行 · {conversation.toolExecutions.length} 条</summary>
                {conversation.toolExecutions.map((t) => (
                  <div key={`${t.turnId}:${t.id}`}>
                    <code>{t.command}</code>
                    <pre>{t.output}</pre>
                    <p>
                      退出码 {t.exitCode ?? '未返回'}
                      {t.truncated ? ' · 已截断' : ''}
                    </p>
                  </div>
                ))}
              </details>
            ) : null}
            {conversation?.warnings.map((w) => (
              <p key={w} role="status">
                {w}
              </p>
            ))}
          </>
        ) : null}
        {view === 'task' ? (
          <>
            <h2>任务与版本</h2>
            {session.taskVersions.length ? (
              <label className="field">
                任务版本
                <select
                  value={selectedVersionId}
                  onChange={(e) => {
                    setSelectedVersionId(e.target.value);
                    setSelectedRunId('');
                  }}
                >
                  <option value="">最新版本</option>
                  {session.taskVersions.map((v) => (
                    <option key={v.taskVersionId} value={v.taskVersionId}>
                      v{v.version} · {v.goal.slice(0, 40)}
                    </option>
                  ))}
                </select>
              </label>
            ) : null}
            <label className="field">
              <span>修改目标</span>
              <textarea className="resize-none" rows={3} value={draft} onChange={(e) => save(e.target.value)} />
            </label>
            <label className="field">
              <span>允许修改范围（每行一条）</span>
              <textarea
                className="resize-none"
                rows={2}
                value={criteriaDraft.scopes}
                onChange={(e) => saveCriteria('scopes', e.target.value)}
              />
            </label>
            <label className="field">
              <span>验收条件（每行一条）</span>
              <textarea
                className="resize-none"
                rows={3}
                value={criteriaDraft.acceptance}
                onChange={(e) => saveCriteria('acceptance', e.target.value)}
              />
            </label>
            <label className="field">
              <span>附加目标（明确选择）</span>
              <select
                value={target}
                onChange={(e) => {
                  const resource = workspace.resources.find((r) => r.resourceId === e.target.value);
                  void workspaceCommand(workspace.workspaceId, {
                    type: 'saveTaskTarget',
                    sessionId: session.sessionId,
                    targetRef: resource ? { kind: resource.kind, resourceId: resource.resourceId } : null,
                  });
                }}
              >
                <option value="">无页面目标</option>
                {workspace.resources
                  .filter((r) => r.kind !== 'session')
                  .map((r) => (
                    <option key={r.resourceId} value={r.resourceId}>
                      {r.title}
                    </option>
                  ))}
              </select>
            </label>
            <button
              type="button"
              className="btn"
              disabled={session.taskTargetRef?.kind !== 'web'}
              onClick={() => {
                if (session.taskTargetRef) void captureContext(workspace.workspaceId, session.sessionId, session.taskTargetRef.resourceId);
                setView('context');
              }}
            >
              采集目标元素
            </button>
            <button type="button" className="btn" disabled={!draft.trim() || submitting} onClick={() => void confirm()}>
              确认任务（生成新版本）
            </button>
            {version ? (
              <div className="version-card">
                <strong>任务 v{version.version}</strong>
                <p>{version.goal}</p>
                <p>修改范围：{version.allowedScopes.join('、') || '未指定（不增加写入权限）'}</p>
                <ul>
                  {version.acceptance.map((line) => (
                    <li key={line}>{line}</li>
                  ))}
                </ul>
                <p className="muted">
                  已确认 {new Date(version.confirmedAt).toLocaleString('zh-CN')} · 目标{' '}
                  {workspace.resources.find((r) => r.resourceId === version.targetRef?.resourceId)?.title ?? '未附加'}
                </p>
                <button
                  type="button"
                  className="btn btn-primary"
                  disabled={busy || submitting}
                  onClick={() =>
                    void perform(async () => {
                      await workspaceCommand(workspace.workspaceId, {
                        type: 'startRun',
                        sessionId: session.sessionId,
                        taskVersionId: version.taskVersionId,
                      });
                    })
                  }
                >
                  开始运行
                </button>
              </div>
            ) : (
              <p className="muted">还没有确认的任务版本。</p>
            )}
            {run ? <p role="status">执行：{run.state} · 原空间归属保持不变</p> : null}
          </>
        ) : null}
        {view === 'context' ? (
          <>
            <h2>任务上下文</h2>
            <SessionObservation workspace={workspace} session={session} />
            <p role="status">
              现场适用性：
              {selectedVersionId
                ? '历史采集（不表示当前现场）'
                : session.contextApplicability === 'current'
                  ? '有效'
                  : session.contextApplicability === 'stale'
                    ? '已失效'
                    : '未知'}
            </p>
            {context ? (
              <>
                <p>{context.element.text || context.element.tagName}</p>
                <p className="muted">
                  {context.page.title} · {context.page.url}
                </p>
                <p>采集于 {new Date(context.capturedAt).toLocaleString('zh-CN')}</p>
                <img className="context-image" src={context.screenshot.viewport} alt="任务页面采集截图" />
                {context.screenshot.element ? (
                  <img className="context-image" src={context.screenshot.element} alt="目标元素采集截图" />
                ) : null}
                {context.consoleIssues.map((issue, index) => (
                  <p key={index} role="status">
                    页面错误：{issue.message}
                  </p>
                ))}
                <details>
                  <summary>诊断详情</summary>
                  <pre>{JSON.stringify(context, null, 2)}</pre>
                </details>
              </>
            ) : (
              <p className="workspace-empty">尚未附加页面现场。先在网页选择元素，再确认相关任务。</p>
            )}
            <button
              type="button"
              className="btn"
              disabled={!session.taskTargetRef || session.taskTargetRef.kind !== 'web'}
              onClick={() => {
                if (session.taskTargetRef) void captureContext(workspace.workspaceId, session.sessionId, session.taskTargetRef.resourceId);
              }}
            >
              重新选择元素
            </button>
          </>
        ) : null}
        {view === 'checks' ? (
          <>
            <h2>检查与审阅</h2>
            {sessionRuns.length ? (
              <label className="field">
                执行记录
                <select
                  value={selectedRunId}
                  onChange={(e) => {
                    const id = e.target.value;
                    setSelectedRunId(id);
                    setSelectedVersionId(sessionRuns.find((r) => r.runId === id)?.taskVersionId ?? '');
                  }}
                >
                  <option value="">最新执行</option>
                  {sessionRuns.map((r) => (
                    <option key={r.runId} value={r.runId}>
                      {new Date(r.startedAt).toLocaleString('zh-CN')} · {r.state}
                    </option>
                  ))}
                </select>
              </label>
            ) : null}
            {run ? (
              <div className="version-card">
                <p>执行状态：{run.state}</p>
                <p>
                  检查：{run.validation.state} · 适用性：{run.validation.applicability}
                </p>
                {run.validation.reason ? <p>{run.validation.reason}</p> : null}
                <button
                  type="button"
                  className="btn"
                  onClick={() => void workspaceCommand(workspace.workspaceId, { type: 'runValidation', runId: run.runId })}
                >
                  运行检查
                </button>
                <p>审阅：{run.review?.decision ?? '尚未审阅'}</p>
                <div className="row gap-8">
                  <button
                    type="button"
                    className="btn"
                    disabled={run.state !== 'completed' || run.validation.state !== 'passed' || run.validation.applicability !== 'current'}
                    onClick={() =>
                      void workspaceCommand(workspace.workspaceId, {
                        type: 'recordReview',
                        runId: run.runId,
                        candidateId: run.candidateId,
                        decision: 'accepted',
                      })
                    }
                  >
                    接受结果
                  </button>
                  <button
                    type="button"
                    className="btn"
                    disabled={run.state !== 'completed'}
                    onClick={() =>
                      void workspaceCommand(workspace.workspaceId, {
                        type: 'recordReview',
                        runId: run.runId,
                        candidateId: run.candidateId,
                        decision: 'changes_requested',
                      })
                    }
                  >
                    要求修改
                  </button>
                </div>
                {run.validation.state !== 'passed' || run.validation.applicability !== 'current' ? (
                  <p role="status">固定验收通过且仍适用于当前版本后，才能接受结果。</p>
                ) : null}
                <p className="muted small">审阅绑定此候选，不会提交、合并或发布。</p>
              </div>
            ) : (
              <p className="workspace-empty">没有可检查的执行。没有真实检查记录时不会显示通过。</p>
            )}
          </>
        ) : null}
        {run?.error || conversation?.error ? (
          <p role="alert" className="text-bad">
            {run?.error ?? conversation?.error}
          </p>
        ) : null}
      </div>
      {busy ? (
        <div className="row space-between session-status" role="status">
          <span>{currentRun!.state === 'cancelling' ? '正在取消并核实退出…' : '正在执行…'}</span>
          <button
            type="button"
            className="btn"
            disabled={currentRun!.state === 'cancelling'}
            onClick={() => void workspaceCommand(workspace.workspaceId, { type: 'cancelRun', runId: currentRun!.runId })}
          >
            取消回复
          </button>
        </div>
      ) : null}
      <div className="workspace-composer">
        <label htmlFor={`draft-${session.sessionId}`}>
          发送到 · {workspace.name} / {session.title} / Codex CLI
        </label>
        <textarea
          id={`draft-${session.sessionId}`}
          aria-label="会话消息"
          className="resize-none"
          rows={3}
          value={draft}
          placeholder="继续描述想修改的内容…"
          onChange={(e) => save(e.target.value)}
          onCompositionStart={() => {
            composing.current = true;
          }}
          onCompositionEnd={() => {
            composing.current = false;
          }}
          onKeyDown={(e) => {
            if (e.key === 'Enter' && !e.shiftKey && !composing.current && !e.nativeEvent.isComposing && e.keyCode !== 229) {
              e.preventDefault();
              void send();
            }
          }}
        />
        <div className="row space-between">
          <span className="muted small">Enter 发送 · Shift+Enter 换行 · 草稿按会话保存</span>
          <button type="button" className="btn btn-primary" disabled={!draft.trim() || busy || submitting} onClick={() => void send()}>
            发送
          </button>
        </div>
      </div>
    </section>
  );
}
