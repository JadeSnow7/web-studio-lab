import { useEffect, useId, useLayoutEffect, useMemo, useRef, useState, type KeyboardEvent } from 'react';
import type { StatusScope, WorkbenchSession, WorkspaceSnapshot, TargetRef } from '@wsl/protocol';
import { StatusDot, StatusSlot } from '../components/Status';
import { useStore } from '../lib/store';
import { locationStore } from '../state/location';
import { cancelContextCapture, captureContext } from '../state/capture';
import { occlusion } from '../state/occlusion';
import { reportError } from '../state/errors';
import {
  ackScope,
  entityOf,
  statusLabel,
  statusPresentationActions,
  statusPresentationStore,
  useScopeViews,
  useStatusView,
  useStatusViewByKey,
  type StatusView,
} from '../state/status-view';
import { SessionObservation, cancelObservationRequest } from './Observation';
import { sessionSelection } from './presentation';
import { RunDetails, RunStatusFields, type RunView } from './RunDetails';
import { workspaceCommand, workspaceStore, beginNavigation } from '../state/workspace';

type SessionView = 'conversation' | 'task' | 'context' | 'checks' | RunView;

const RUN_VIEWS: ReadonlyArray<readonly [RunView, string]> = [
  ['log', '日志'],
  ['diff', 'diff'],
  ['report', '报告'],
];

const GLOBAL_SCOPE: StatusScope = { kind: 'global' };

/**
 * 「运行记录 ⌄」：日志 / diff / 报告收入一个 menu。展开前进入 occlusion 遮挡集合
 * （分屏时旁边的原生网页可能落在菜单下方，必须让位）；方向键 / Home / End 移动，Esc 关闭并回到触发器，
 * 点击外部、焦点移出或窗格被隐藏时关闭。
 */
function RunRecordMenu({ sessionId, view, onSelect }: { sessionId: string; view: SessionView; onSelect: (view: RunView) => void }) {
  const [open, setOpen] = useState(false);
  const trigger = useRef<HTMLButtonElement>(null);
  const root = useRef<HTMLDivElement>(null);
  const mounted = useRef(true);
  const source = `session-runs:${sessionId}`;
  const menuId = useId();
  const active = view === 'log' || view === 'diff' || view === 'report';

  const close = (restoreFocus: boolean) => {
    setOpen(false);
    occlusion.close(source);
    if (restoreFocus) trigger.current?.focus();
  };
  const show = async () => {
    if (open) return close(true);
    try {
      if (!(await occlusion.open(source))) return;
    } catch (error) {
      reportError('打开菜单', error);
      return;
    }
    if (!mounted.current) occlusion.close(source);
    else setOpen(true);
  };

  useEffect(() => {
    mounted.current = true;
    return () => {
      mounted.current = false;
      occlusion.close(source);
    };
  }, [source]);
  useEffect(() => {
    if (!open) return;
    const items = Array.from(root.current?.querySelectorAll<HTMLElement>('[role="menuitem"]') ?? []);
    (items.find((item) => item.getAttribute('aria-current') === 'true') ?? items[0])?.focus();
  }, [open]);
  useEffect(() => {
    if (!open || !root.current) return;
    const element = root.current;
    const onPointerDown = (event: PointerEvent) => {
      if (event.target instanceof Node && !element.contains(event.target)) close(false);
    };
    document.addEventListener('pointerdown', onPointerDown);
    // 窗格被隐藏（切换标签 / 空间）时尺寸变为 0：收起并释放遮挡。
    const observer = new ResizeObserver(([entry]) => {
      if (entry && entry.contentRect.width === 0 && entry.contentRect.height === 0) close(false);
    });
    observer.observe(element);
    return () => {
      document.removeEventListener('pointerdown', onPointerDown);
      observer.disconnect();
    };
    // close 只依赖稳定的 source 与 ref。
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open, source]);

  const onKeyDown = (event: KeyboardEvent<HTMLDivElement>) => {
    if (event.nativeEvent.isComposing) return;
    if (!open) {
      if (event.key === 'ArrowDown' && event.target === trigger.current) {
        event.preventDefault();
        void show();
      }
      return;
    }
    if (event.key === 'Escape') {
      event.preventDefault();
      event.stopPropagation();
      close(true);
      return;
    }
    const items = Array.from(root.current?.querySelectorAll<HTMLElement>('[role="menuitem"]') ?? []);
    if (!items.length) return;
    const index = items.findIndex((item) => item === document.activeElement);
    const next =
      event.key === 'ArrowDown'
        ? index + 1
        : event.key === 'ArrowUp'
          ? index - 1
          : event.key === 'Home'
            ? 0
            : event.key === 'End'
              ? items.length - 1
              : null;
    if (next === null) return;
    event.preventDefault();
    items[(next + items.length) % items.length]?.focus();
  };

  return (
    <div
      className="session-run-anchor"
      ref={root}
      onKeyDown={onKeyDown}
      onBlur={(event) => {
        if (open && event.relatedTarget instanceof Node && !root.current?.contains(event.relatedTarget)) close(false);
      }}
    >
      <button
        type="button"
        ref={trigger}
        className={`btn ${active ? 'btn-active' : ''}`}
        aria-haspopup="menu"
        aria-expanded={open}
        aria-controls={open ? menuId : undefined}
        onClick={() => void show()}
      >
        运行记录<span aria-hidden="true"> ⌄</span>
      </button>
      {open ? (
        <div className="session-run-menu" role="menu" id={menuId} aria-label="运行记录">
          {RUN_VIEWS.map(([id, label]) => (
            <button
              key={id}
              type="button"
              role="menuitem"
              aria-current={view === id ? 'true' : undefined}
              onClick={() => {
                close(true);
                onSelect(id);
              }}
            >
              {label}
            </button>
          ))}
        </div>
      ) : null}
    </div>
  );
}

export function Session({ workspace, session }: { workspace: WorkspaceSnapshot; session: WorkbenchSession }) {
  const { sessionId } = session;
  const scope = useMemo<StatusScope>(
    () => ({ kind: 'session', workspaceId: workspace.workspaceId, sessionId }),
    [workspace.workspaceId, sessionId],
  );
  const initialLocation = locationStore.get().location;
  const initial =
    initialLocation?.workspaceId === workspace.workspaceId && initialLocation.sessionId === sessionId ? initialLocation : null;
  const [view, setView] = useState<SessionView>(initial?.view ?? 'conversation');
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
  // 版本 / 运行选择是展示状态：写入展示 store（statusPresentationActions.selectHistory），状态视图与本页数据都从这里读取。
  const selection = useStore(statusPresentationStore, (state) => state.selections[sessionId]);
  const selectedVersionId = selection?.taskVersionId ?? '';
  const selectedRunId = selection?.runId ?? '';
  const select = (next: { taskVersionId?: string; runId?: string }) => statusPresentationActions.selectHistory(sessionId, next);
  const initialSelection = useRef(initial ? { taskVersionId: initial.taskVersionId, runId: initial.runId } : null);
  // 挂载时按定位（locateSession）带来的初始选择写入；没有定位时清除上一次遗留的选择（与原局部 state 的初始值一致）。
  useLayoutEffect(() => {
    statusPresentationActions.selectHistory(sessionId, initialSelection.current);
  }, [sessionId]);
  useEffect(
    () =>
      locationStore.subscribe(() => {
        const location = locationStore.get().location;
        if (location?.workspaceId !== workspace.workspaceId || location.sessionId !== sessionId) return;
        select({ runId: location.runId, taskVersionId: location.taskVersionId });
        setView(location.view ?? 'task');
      }),
    // select 只依赖稳定的 sessionId。
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [workspace.workspaceId, sessionId],
  );
  const sessionRuns = workspace.runs.filter((r) => r.sessionId === session.sessionId);
  const currentRun = sessionRuns.at(-1);
  const { version, run, conversation } = sessionSelection(session, workspace.runs, selectedVersionId, selectedRunId);
  const context = selectedVersionId ? version?.capture : session.context;
  // 状态文案与形状都来自展示层（run / validation / review / context 视图），本组件不再自行拼接。
  const scopeViews = useScopeViews(scope);
  const contextStatus = useStatusViewByKey(scope, `context:${sessionId}:applicability`);
  const runStatus = useStatusViewByKey(scope, `run:${run?.runId ?? ''}:state`);
  // 对话的版本 · 沙箱 · cwd（不可用时为原因）：不常驻正文，并入对话视图顶部状态点的悬停（合同 A3 chat 段）。
  const chatStatus = useStatusViewByKey(GLOBAL_SCOPE, 'chat:global:state');
  // 状态槽与上下文页内联的「现场适用性」用同一份分组结果，槽里已是问题的不再在页内重复。
  const slot = useStatusView(scope);
  const composerInput = useRef<HTMLTextAreaElement>(null);
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
      const result = await workspaceCommand(workspace.workspaceId, {
        type: 'confirmTask',
        sessionId: session.sessionId,
        goal: draftValue.current,
        targetRef,
        acceptance: criteriaRef.current.acceptance.split('\n').filter((x) => x.trim()),
        allowedScopes: criteriaRef.current.scopes.split('\n').filter((x) => x.trim()),
      });
      if (result?.ok) setView('task');
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
        acceptance: criteriaRef.current.acceptance.split('\n').filter((x) => x.trim()),
        allowedScopes: criteriaRef.current.scopes.split('\n').filter((x) => x.trim()),
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
      // A delayed start receipt may predate cancellation; only the current Main projection can acknowledge input.
      const acceptedRun = workspaceStore
        .get()
        .snapshot?.workspaces.find((w) => w.workspaceId === workspace.workspaceId)
        ?.runs.find((r) => r.taskVersionId === next.taskVersionId);
      if (acceptedRun && ['starting', 'running', 'completed'].includes(acceptedRun.state) && draftValue.current === text) save('');
    });
  // 运行失败的原因已是状态槽里「执行失败」的 detail；其余情况（如中断后的对话错误）仍原文显示。
  const standaloneError = run?.state === 'failed' && run.error ? null : (run?.error ?? conversation?.error);
  const onAction = (item: StatusView) => {
    const id = item.action?.id;
    if (!id || item.action?.disabled) return;
    if (id === 'run.cancel') {
      void workspaceCommand(workspace.workspaceId, { type: 'cancelRun', runId: entityOf(item) });
      // 取消后「取消回复」按钮随状态卸载：先把焦点交给输入框，避免落到 body。
      composerInput.current?.focus();
    } else if (id === 'web.cancelPick' && session.captureRequest) {
      const { resourceId } = session.captureRequest;
      void (async () => {
        try {
          await cancelContextCapture(workspace.workspaceId, resourceId);
        } catch (error) {
          reportError('取消采集', error);
        }
      })();
    } else if (id === 'observation.cancel') {
      void cancelObservationRequest(workspace.workspaceId, sessionId, entityOf(item));
      // 取消后「取消读取」按钮随状态卸载：先把焦点交给输入框，避免落到 body（同 run.cancel）。
      composerInput.current?.focus();
    } else if (id === 'run.reconcileCleanup')
      void workspaceCommand(workspace.workspaceId, { type: 'reconcileRunCleanup', runId: entityOf(item) });
    else if (id === 'context.recapture' && session.taskTargetRef)
      void captureContext(workspace.workspaceId, sessionId, session.taskTargetRef.resourceId);
  };
  // 「重新选择元素」：上下文页自带同名按钮，槽里不再重复；没有网页目标时无处可选，也不提供。
  const omitActions = view === 'context' || session.taskTargetRef?.kind !== 'web' ? ['context.recapture'] : undefined;
  // 与会话交互（点击、按键）后确认其中的 confirmation（如「历史已恢复」）；control / unresolved / progress 不受影响。
  // 用 click 而不是 pointerdown：确认会让提示消失、槽高度变化，pointerdown 时位移会让同一次点击落空。
  // 不监听焦点：通知栏打开会话时会程序性聚焦标题，那不是用户与会话的交互。
  const acknowledge = () => ackScope(scope);
  // 状态槽内的按键不算与窗格交互：槽内按钮由 Enter / 空格触发的 click 自行处理，避免按钮在 keydown 时被卸载。
  const acknowledgeKey = (event: React.KeyboardEvent<HTMLElement>) => {
    if (!(event.target as HTMLElement).closest('.status-slot')) acknowledge();
  };
  return (
    <section className="session-workspace" aria-label="Agent 会话内容" onClickCapture={acknowledge} onKeyDownCapture={acknowledgeKey}>
      <h2 className="sr-only" tabIndex={-1} id={`session-heading-${session.sessionId}`}>
        {session.title}
      </h2>
      <nav className="session-views" aria-label="会话视图">
        {(['conversation', 'task', 'context', 'checks'] as const).map((v, i) => (
          <button
            type="button"
            key={v}
            className={`btn ${view === v ? 'btn-active' : ''}`}
            aria-pressed={view === v}
            onClick={() => {
              beginNavigation();
              setView(v);
            }}
          >
            {['对话', '任务', '上下文', '检查'][i]}
          </button>
        ))}
        <RunRecordMenu
          sessionId={sessionId}
          view={view}
          onSelect={(next) => {
            beginNavigation();
            setView(next);
          }}
        />
      </nav>
      <div className="session-scroll">
        {view === 'log' || view === 'diff' || view === 'report' ? run ? <RunDetails run={run} view={view} /> : <p>尚无运行记录。</p> : null}
        {view === 'conversation' ? (
          <>
            {/* 当前查看的运行的执行状态：只画形状，文字为视觉隐藏文本；进行中、失败与待确认由底部状态槽呈现。 */}
            {(run && runStatus) || chatStatus ? (
              <div className="session-run-state">
                <StatusDot
                  view={(run && runStatus) || chatStatus!}
                  title={[((run && runStatus) || chatStatus!).label, chatStatus?.detail ? `Codex CLI · ${chatStatus.detail}` : null]
                    .filter(Boolean)
                    .join('\n')}
                />
              </div>
            ) : null}
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
                <select value={selectedVersionId} onChange={(e) => select({ taskVersionId: e.target.value })}>
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
            {run ? (
              <>
                <RunStatusFields run={run} fields={['run']} />
                <p className="muted small">原空间归属保持不变</p>
              </>
            ) : null}
          </>
        ) : null}
        {view === 'context' ? (
          <>
            <h2>任务上下文</h2>
            <SessionObservation workspace={workspace} session={session} />
            {/* 稳态与历史采集在此显示；失效（问题）已是底部状态槽的那一条时不在此重复，折叠进「另有 N 项」时才补充。 */}
            {contextStatus && slot.problem?.key !== contextStatus.key ? (
              <p className="status-field">
                <StatusDot view={contextStatus} visibleLabel />
              </p>
            ) : null}
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
                    select({ runId: id, taskVersionId: sessionRuns.find((r) => r.runId === id)?.taskVersionId });
                  }}
                >
                  <option value="">最新执行</option>
                  {sessionRuns.map((r) => (
                    <option key={r.runId} value={r.runId}>
                      {new Date(r.startedAt).toLocaleString('zh-CN')} · {statusLabel(scopeViews, `run:${r.runId}:state`)}
                    </option>
                  ))}
                </select>
              </label>
            ) : null}
            {run ? (
              <div className="version-card">
                <RunStatusFields run={run} fields={['run', 'validation']} />
                <button
                  type="button"
                  className="btn"
                  onClick={() => void workspaceCommand(workspace.workspaceId, { type: 'runValidation', runId: run.runId })}
                >
                  运行检查
                </button>
                <RunStatusFields run={run} fields={['review']} />
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
        {standaloneError ? (
          <p role="alert" className="text-bad">
            {standaloneError}
          </p>
        ) : null}
      </div>
      {/* 会话的状态槽：取消（执行中 / 取消中）、「App 数据操作待确认 · 重新核对」与观察进行中（取消读取）在常驻通道，可同时出现；问题（含读取失败、覆盖不完整）与提示在其下。 */}
      <StatusSlot scope={scope} onAction={onAction} omitActions={omitActions} />
      <div className="workspace-composer">
        <span className="sr-only" id={`draft-hint-${sessionId}`}>
          发送到 · {workspace.name} / {session.title} / Codex CLI
        </span>
        <textarea
          ref={composerInput}
          id={`draft-${sessionId}`}
          aria-label="会话消息"
          aria-describedby={`draft-hint-${sessionId}`}
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
        <div className="workspace-composer-actions">
          <button
            type="button"
            className="btn btn-primary"
            title="Enter 发送 · Shift+Enter 换行 · 草稿按会话保存"
            disabled={!draft.trim() || busy || submitting}
            onClick={() => void send()}
          >
            发送
          </button>
        </div>
      </div>
    </section>
  );
}
