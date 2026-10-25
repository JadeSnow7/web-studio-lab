import { shortcutModalOpen } from '../state/shortcuts';
import { useEffect, useId, useLayoutEffect, useMemo, useRef, useState } from 'react';
import {
  type CheckerCapability,
  type StatusScope,
  type WorkbenchRun,
  type WorkbenchSession,
  type WorkspaceSnapshot,
  type TargetRef,
} from '@wsl/protocol';
import { StatusDot, StatusSlot } from '../components/Status';
import { useStore } from '../lib/store';
import { locationStore } from '../state/location';
import { chatStore, selectedHarnessName } from '../state/chat';
import { HarnessSelectField } from './HarnessSelect';
import { PermissionRequests } from '../components/PermissionRequests';
import { cancelCapture, captureContext } from '../state/capture';
import { receiverActions, taskReference, taskSettingsSummary } from '../state/capture-receiver';
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
import { CHECKER_UNAVAILABLE_NOTE, checkerCapability, environmentStore } from '../state/execution';
import {
  menuAnchorFromClick,
  menuView,
  nativeMenuKey,
  openNativeMenu,
  runRecordsMenuEffect,
  useNativeMenuExpanded,
} from '../state/native-menu';

type SessionView = 'conversation' | 'task' | 'context' | 'checks' | RunView;

const GLOBAL_SCOPE: StatusScope = { kind: 'global' };

/**
 * 「运行记录 ⌄」：日志 / diff / 报告收入一个 Main 原生菜单（OPS-1 S5）。原生菜单不进入遮挡集合，
 * 分屏时旁边的原生网页保持可见；键盘打开时菜单位于触发器下方，Esc 或点击外部取消，焦点留在触发器。
 */
function RunRecordMenu({
  workspaceId,
  sessionId,
  view,
  onSelect,
}: {
  workspaceId: string;
  sessionId: string;
  view: SessionView;
  onSelect: (view: RunView) => void;
}) {
  const current = view === 'log' || view === 'diff' || view === 'report' ? view : undefined;
  const expanded = useNativeMenuExpanded(nativeMenuKey('run-records', { workspaceId, sessionId }));
  return (
    <button
      type="button"
      className={`btn ${current ? 'btn-active' : ''}`}
      aria-haspopup="menu"
      aria-expanded={expanded}
      onClick={async (event) => {
        // current 只用于在菜单里标出当前视图（单选项），不参与授权。
        const choice = await openNativeMenu('run-records', {
          workspaceId,
          sessionId,
          ...(current ? { current } : {}),
          anchor: menuAnchorFromClick(event, event.currentTarget),
        });
        if (choice?.menuId !== 'run-records') return;
        const effect = runRecordsMenuEffect(choice, menuView());
        if (effect) onSelect(effect.view);
      }}
    >
      运行记录<span aria-hidden="true"> ⌄</span>
    </button>
  );
}

/**
 * 工程开关（OPS-1 R5，B1）：空间有 App 时显示可移除的「工程：{App 名}」，移除后可再次开启；没有多工程选择。
 * 只提交 appId | null，Main 核对为本空间 App 后保存；首次采集受管 App 页面时由 Main 自动开启。无工程时明确显示“未选择工程”，
 * 不从任务文字推断。发送前先等待这里尚未返回的切换（onChoose 由会话串行），避免按旧状态冻结。
 */
function ProjectToggle({
  workspace,
  session,
  onChoose,
}: {
  workspace: WorkspaceSnapshot;
  session: WorkbenchSession;
  onChoose: (appId: string | null) => void;
}) {
  const app = workspace.app ?? null;
  const bound = app && session.taskProject?.appId === app.appId ? app : null;
  return (
    <div className="composer-project" role="group" aria-label="工程绑定">
      {bound ? (
        <span className="chip">
          工程：{bound.name}
          <button
            type="button"
            className="chip-remove"
            aria-label={`移除工程：${bound.name}`}
            title="移除工程"
            onClick={() => onChoose(null)}
          >
            <span aria-hidden="true">×</span>
          </button>
        </span>
      ) : (
        <>
          <span className="chip">未选择工程</span>
          {app ? (
            <button type="button" className="chip chip-button" onClick={() => onChoose(app.appId)}>
              开启工程：{app.name}
            </button>
          ) : null}
        </>
      )}
    </div>
  );
}

const lineCount = (value: string) => value.split('\n').filter((line) => line.trim()).length;

/**
 * 页面引用标签（OPS-1 S1）：会话输入框上方显示「{元素文字或标签名} · {页面标题}」，可展开查看截图、来源与有效性，可移除。
 * 移除只取消本轮的任务目标（saveTaskTarget(null)），保留已保存的采集证据与工程选择。网页目标没有该页的采集时也显示，并说明尚未选择元素。
 */
function ReferenceChip({
  workspace,
  session,
  applicability,
  onRemove,
}: {
  workspace: WorkspaceSnapshot;
  session: WorkbenchSession;
  applicability: StatusView | null;
  onRemove: () => void;
}) {
  const [open, setOpen] = useState(false);
  const detailId = useId();
  const reference = taskReference(workspace, session);
  if (reference.kind !== 'page') return null;
  const { capture } = reference;
  return (
    <div className="composer-reference" role="group" aria-label="页面引用">
      <span className="chip chip-reference">
        <button
          type="button"
          className="chip-label"
          aria-expanded={open}
          aria-controls={detailId}
          title="查看引用详情"
          onClick={() => setOpen((value) => !value)}
        >
          {reference.label}
        </button>
        <button
          type="button"
          className="chip-remove"
          aria-label={`移除引用：${reference.label}`}
          title="移除引用（保留已保存的采集与工程选择）"
          onClick={onRemove}
        >
          <span aria-hidden="true">×</span>
        </button>
      </span>
      {open ? (
        <div id={detailId} className="reference-detail">
          {capture ? (
            <>
              <img
                className="reference-image"
                src={capture.screenshot.element ?? capture.screenshot.viewport}
                alt={capture.screenshot.element ? '引用元素截图' : '引用页面截图'}
              />
              <p>
                来源：{capture.page.title} · {capture.page.url}
              </p>
              <p>采集于 {new Date(capture.capturedAt).toLocaleString('zh-CN')}</p>
              {applicability ? (
                <p className="status-field">
                  <StatusDot view={applicability} visibleLabel />
                </p>
              ) : null}
            </>
          ) : (
            <p className="muted">尚未在此网页选择元素；发送前请先在网页选择元素，或移除引用。</p>
          )}
        </div>
      ) : null}
    </div>
  );
}

/**
 * 「任务设置」（OPS-1 S2）：输入框上方默认折叠，折叠时显示摘要。允许修改范围与验收条件仍经 saveTaskCriteria 保存；
 * 文件 / 终端 / SSH 目标经 saveTaskTarget（替换页面引用，单一目标）；Harness 与 Profile 经 setSessionHarness（W4，从「任务」视图移来）。
 * 网页目标由引用标签决定，不在这里选择。展开状态只是展示状态。
 */
function TaskSettings({
  workspace,
  session,
  criteria,
  onCriteria,
  onTarget,
}: {
  workspace: WorkspaceSnapshot;
  session: WorkbenchSession;
  criteria: { acceptance: string; scopes: string };
  onCriteria: (field: 'acceptance' | 'scopes', value: string) => void;
  onTarget: (target: TargetRef | null) => void;
}) {
  const [open, setOpen] = useState(false);
  const bodyId = useId();
  const reference = taskReference(workspace, session);
  const settingsTarget = reference.kind === 'resource' ? reference : null;
  const options = workspace.resources.filter((r) => r.kind === 'file' || r.kind === 'terminal' || r.kind === 'ssh');
  const summary = taskSettingsSummary({
    scopes: lineCount(criteria.scopes),
    acceptance: lineCount(criteria.acceptance),
    target: settingsTarget?.title ?? null,
  });
  return (
    <div className="task-settings">
      <button
        type="button"
        className="task-settings-toggle"
        aria-expanded={open}
        aria-controls={bodyId}
        onClick={() => setOpen((value) => !value)}
      >
        任务设置<span className="muted"> · {summary}</span>
        <span aria-hidden="true">{open ? ' ⌃' : ' ⌄'}</span>
      </button>
      {open ? (
        <div id={bodyId} className="task-settings-body" role="group" aria-label="任务设置">
          <label className="field">
            <span>允许修改范围（每行一条）</span>
            <textarea className="resize-none" rows={2} value={criteria.scopes} onChange={(e) => onCriteria('scopes', e.target.value)} />
          </label>
          <label className="field">
            <span>验收条件（每行一条）</span>
            <textarea
              className="resize-none"
              rows={3}
              value={criteria.acceptance}
              onChange={(e) => onCriteria('acceptance', e.target.value)}
            />
          </label>
          <label className="field">
            <span>附加目标（文件 / 终端 / SSH）</span>
            <select
              value={settingsTarget?.resourceId ?? ''}
              onChange={(e) => {
                const resource = workspace.resources.find((r) => r.resourceId === e.target.value);
                onTarget(resource ? { kind: resource.kind, resourceId: resource.resourceId } : null);
              }}
            >
              <option value="">{reference.kind === 'page' ? '无（使用页面引用）' : '无'}</option>
              {options.map((r) => (
                <option key={r.resourceId} value={r.resourceId}>
                  {r.title}
                </option>
              ))}
              {settingsTarget && !options.some((r) => r.resourceId === settingsTarget.resourceId) ? (
                <option value={settingsTarget.resourceId}>{settingsTarget.title}</option>
              ) : null}
            </select>
          </label>
          <HarnessSelectField
            selection={session.harnessSelection}
            onChange={(selection) =>
              void workspaceCommand(workspace.workspaceId, { type: 'setSessionHarness', sessionId: session.sessionId, selection })
            }
          />
        </div>
      ) : null}
    </div>
  );
}

const ACCEPT_REQUIRES_VALIDATION = '固定验收通过且仍适用于当前版本后，才能接受结果。';
const ACCEPT_WITHOUT_CHECKER = '产品检查器尚未接入：接受需要独立检查通过且适用于当前版本，目前不能接受结果。';

/**
 * 检查与审阅卡片（OPS-1 S3）。检查器能力来自 Main（ExecutionStatus.checker）：只有明确已接入时才提供「运行检查」。
 * 「接受结果」始终可见，仍只在执行完成且检查 passed + current 时可用（D1 = A）；禁用原因可见，并作为按钮的可访问描述。
 */
function CheckReviewCard({ workspaceId, run, checker }: { workspaceId: string; run: WorkbenchRun; checker: CheckerCapability | null }) {
  const reasonId = useId();
  const validated = run.validation.state === 'passed' && run.validation.applicability === 'current';
  const canAccept = run.state === 'completed' && validated;
  const acceptReason = validated ? null : checker && !checker.connected ? ACCEPT_WITHOUT_CHECKER : ACCEPT_REQUIRES_VALIDATION;
  const review = (decision: 'accepted' | 'changes_requested') =>
    void workspaceCommand(workspaceId, { type: 'recordReview', runId: run.runId, candidateId: run.candidateId, decision });
  return (
    <div className="version-card">
      <RunStatusFields run={run} fields={['run', 'validation']} />
      {checker?.connected ? (
        <button
          type="button"
          className="btn"
          onClick={() => void workspaceCommand(workspaceId, { type: 'runValidation', runId: run.runId })}
        >
          运行检查
        </button>
      ) : null}
      <RunStatusFields run={run} fields={['review']} />
      <div className="row gap-8">
        <button
          type="button"
          className="btn"
          disabled={!canAccept}
          aria-describedby={!canAccept && acceptReason ? reasonId : undefined}
          onClick={() => review('accepted')}
        >
          接受结果
        </button>
        <button type="button" className="btn" disabled={run.state !== 'completed'} onClick={() => review('changes_requested')}>
          要求修改
        </button>
      </div>
      {acceptReason ? (
        <p role="status" id={reasonId}>
          {acceptReason}
        </p>
      ) : null}
      <p className="muted small">审阅绑定此候选，不会提交、合并或发布。</p>
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
  // 选中执行冻结的 Harness 优先；否则显示本会话的选择（空为全局默认，W4-7）。
  const sessionHarness = useStore(chatStore, (state) => selectedHarnessName(state, session.harnessSelection));
  // 检查器能力由 Main 发布（OPS-1 S3）；尚未读取时为 null，此时不提供「运行检查」，也不声称未接入。
  const checker = useStore(environmentStore, checkerCapability);
  const harnessName = run?.harness?.displayName ?? sessionHarness;
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
  const eduTasksUnavailable =
    workspace.managedApp?.profile?.projectKind === 'edu-web' ||
    !!workspace.pendingAppImport ||
    ['selecting', 'scanning', 'ready', 'copying', 'starting', 'cancelling'].includes(workspace.appImport?.phase ?? '');
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
  /**
   * 发送时冻结的任务输入（OPS-1 S2）：唯一目标、用户看到的工程选择与页面引用。网页目标只带本会话对该网页的当前采集身份，
   * 是否仍有效由 Main 核对；工程只提交 appId。
   */
  // 工程开关的切换按会话串行；发送前等待它返回，并从最新投影读取开关与引用（不用点击时的旧渲染）。
  const projectTail = useRef<Promise<boolean>>(Promise.resolve(true));
  const chooseProject = (appId: string | null) => {
    projectTail.current = projectTail.current.then(async () => {
      const result = await workspaceCommand(workspace.workspaceId, { type: 'saveTaskProject', sessionId: session.sessionId, appId });
      return result?.ok === true;
    });
  };
  // 任务目标（引用标签的移除、任务设置中的文件 / 终端 / SSH 目标）同样按会话串行，发送前必须保存成功（单一目标，§9.1）。
  const targetTail = useRef<Promise<boolean>>(Promise.resolve(true));
  const chooseTarget = (targetRef: TargetRef | null) => {
    targetTail.current = targetTail.current.then(async () => {
      const result = await workspaceCommand(workspace.workspaceId, { type: 'saveTaskTarget', sessionId: session.sessionId, targetRef });
      return result?.ok === true;
    });
  };
  const choicesSaved = async () => {
    // Either choice may change while the other save is pending. Confirmation needs
    // both latest choices to settle successfully; a failure persists until reselected.
    for (;;) {
      const pendingProject = projectTail.current;
      const pendingTarget = targetTail.current;
      const [projectSaved, targetSaved] = await Promise.all([pendingProject, pendingTarget]);
      if (pendingProject !== projectTail.current || pendingTarget !== targetTail.current) continue;
      if (!projectSaved) reportError('工程选择未保存', '请重新选择工程并保存成功后再发送。');
      if (!targetSaved) reportError('任务目标未保存', '请重新选择任务目标并保存成功后再发送。');
      return projectSaved && targetSaved;
    }
  };
  const taskInput = (goal: string) => {
    // A send can wait for save receipts while new resources arrive; resolve both from the same current projection.
    const latestWorkspace = workspaceStore.get().snapshot?.workspaces.find((w) => w.workspaceId === workspace.workspaceId) ?? workspace;
    const latest = latestWorkspace.sessions.find((s) => s.sessionId === session.sessionId) ?? session;
    const targetId = latest.taskTargetRef?.resourceId ?? '';
    const resource = latestWorkspace.resources.find((r) => r.resourceId === targetId);
    const targetRef: TargetRef | null = resource ? { kind: resource.kind, resourceId: resource.resourceId } : null;
    const captureId =
      targetRef?.kind === 'web' && latest.contextTarget?.resourceId === targetRef.resourceId ? (latest.context?.captureId ?? null) : null;
    return {
      type: 'confirmTask' as const,
      sessionId: session.sessionId,
      goal,
      targetRef,
      appId: latest.taskProject?.appId ?? null,
      captureId,
      acceptance: criteriaRef.current.acceptance.split('\n').filter((x) => x.trim()),
      allowedScopes: criteriaRef.current.scopes.split('\n').filter((x) => x.trim()),
    };
  };
  // 底部输入框是唯一的目标输入（OPS-1 S2）：「发送」= confirmTask + startRun，防重复提交；任一步失败都保留草稿。
  const send = () =>
    perform(async () => {
      const text = draftValue.current;
      if (!text.trim() || busy || eduTasksUnavailable) return;
      await saveTail.current;
      if (!(await choicesSaved())) return;
      const result = await workspaceCommand(workspace.workspaceId, taskInput(text));
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
      receiverActions.record(workspace.workspaceId, session.sessionId);
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
      void cancelCapture(workspace.workspaceId, resourceId).catch((error: unknown) => reportError('取消采集', error));
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
  // 在会话里的点击与按键同时记为本设备的“最近活动”（默认接收者规则 ②③ 的展示偏好，OPS-1 S1）。
  const acknowledge = () => {
    ackScope(scope);
    receiverActions.record(workspace.workspaceId, sessionId);
  };
  // 状态槽内的按键不算与窗格交互：槽内按钮由 Enter / 空格触发的 click 自行处理，避免按钮在 keydown 时被卸载。
  const acknowledgeKey = (event: React.KeyboardEvent<HTMLElement>) => {
    if (!(event.target as HTMLElement).closest('.status-slot')) acknowledge();
  };
  return (
    <section
      data-session-id={sessionId}
      onCompositionStartCapture={() => {
        composing.current = true;
      }}
      onCompositionEndCapture={() => {
        composing.current = false;
      }}
      onKeyDown={(event) => {
        if (event.key !== 'Enter' || !(event.metaKey || event.ctrlKey) || event.shiftKey || event.altKey || event.defaultPrevented) return;
        const target = event.target;
        if (!(target instanceof HTMLElement) || !target.closest('.task-settings, .workspace-composer textarea')) return;
        if (composing.current || event.nativeEvent.isComposing || event.keyCode === 229 || shortcutModalOpen()) return;
        event.preventDefault();
        void send();
      }}
      className="session-workspace"
      aria-label="Agent 会话内容"
      onClickCapture={acknowledge}
      onKeyDownCapture={acknowledgeKey}
    >
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
          workspaceId={workspace.workspaceId}
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
                  title={[((run && runStatus) || chatStatus!).label, chatStatus?.detail ? `${sessionHarness} · ${chatStatus.detail}` : null]
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
                    <span>{m.role === 'user' ? '你' : harnessName}</span>
                  </div>
                ))
              ) : (
                <p className="workspace-empty">
                  {selectedVersionId && !run ? '此版本尚未运行。' : '描述想完成的工作；执行结果与检查分别记录。'}
                </p>
              )}
            </div>
            <PermissionRequests
              conversation={conversation}
              onAnswer={(requestId, optionId) =>
                workspaceCommand(workspace.workspaceId, { type: 'answerPermission', sessionId: session.sessionId, requestId, optionId })
              }
            />
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
            {/* 目标只在底部输入框（OPS-1 S2）；范围、验收、文件 / 终端 / SSH 目标与执行 Agent 在输入框上方的「任务设置」。 */}
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
                {/* 「重新运行」使用这个已冻结的版本（目标、页面证据、工程与范围都不重建）。 */}
                <button
                  type="button"
                  className="btn btn-primary"
                  disabled={busy || submitting || eduTasksUnavailable}
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
                  重新运行
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
            {checker && !checker.connected ? <p className="muted">{CHECKER_UNAVAILABLE_NOTE[checker.reason]}</p> : null}
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
              <CheckReviewCard workspaceId={workspace.workspaceId} run={run} checker={checker} />
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
        <TaskSettings workspace={workspace} session={session} criteria={criteriaDraft} onCriteria={saveCriteria} onTarget={chooseTarget} />
        <div className="composer-context">
          <ReferenceChip workspace={workspace} session={session} applicability={contextStatus} onRemove={() => chooseTarget(null)} />
          <ProjectToggle workspace={workspace} session={session} onChoose={chooseProject} />
        </div>
        <span className="sr-only" id={`draft-hint-${sessionId}`}>
          发送到 · {workspace.name} / {session.title} / {sessionHarness}
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
            if (
              e.key === 'Enter' &&
              !e.shiftKey &&
              !e.altKey &&
              !shortcutModalOpen() &&
              !composing.current &&
              !e.nativeEvent.isComposing &&
              e.keyCode !== 229
            ) {
              e.preventDefault();
              void send();
            }
          }}
        />
        {eduTasksUnavailable ? <p className="muted small">edu 工程的任务写回尚未开放；草稿会保留。</p> : null}
        <div className="workspace-composer-actions">
          <button
            type="button"
            className="btn btn-primary"
            title="Enter 发送 · Shift+Enter 换行 · 草稿按会话保存"
            disabled={!draft.trim() || busy || submitting || eduTasksUnavailable}
            onClick={() => void send()}
          >
            发送
          </button>
        </div>
      </div>
    </section>
  );
}
