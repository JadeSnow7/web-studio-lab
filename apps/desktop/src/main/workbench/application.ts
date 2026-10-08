import { createHash, randomUUID } from 'node:crypto';
import {
  type ChatConversation,
  type PageCapture,
  type PageIdentity,
  type PreviewState,
  type TerminalSnapshot,
  type WorkbenchCommand,
  type WorkbenchNotification,
  type WorkbenchEvent,
  type WorkbenchResource,
  type WorkbenchResult,
  type WorkbenchRun,
  type WorkbenchSnapshot,
  type WorkspaceSnapshot,
} from '@wsl/protocol';
import { activateTab, closePane, closeTab, panes, setRatio, splitPane } from './layout';
import type { WorkbenchRepository } from './repository';
import type { WorkbenchRuntime } from './ports';

const activeStates = ['starting', 'running', 'cancelling'];
function workspace(workspaceId: string, name: string): WorkspaceSnapshot {
  const paneId = randomUUID();
  return {
    workspaceId,
    name,
    revision: 0,
    tabs: [],
    resources: [],
    layout: { kind: 'pane', paneId, tabId: null },
    activePaneId: paneId,
    sessions: [],
    runs: [],
    publicResources: null,
    publicResourcesError: null,
    theme: 'system',
  };
}
export function validateSnapshot(snapshot: WorkbenchSnapshot): void {
  const allIds = new Set<string>();
  for (const item of snapshot.workspaces) {
    for (const id of [
      item.workspaceId,
      ...item.tabs.map((t) => t.tabId),
      ...item.resources.map((r) => r.resourceId),
      ...item.sessions.map((s) => s.sessionId),
      ...panes(item.layout).map((p) => p.paneId),
    ]) {
      if (allIds.has(id)) throw new Error('conflict: 持久记录包含重复身份');
      allIds.add(id);
    }
    const leaves = panes(item.layout);
    if (leaves.length > 4 || !leaves.some((p) => p.paneId === item.activePaneId)) throw new Error('conflict: 持久布局无效');
    const visible = leaves.flatMap((p) => (p.tabId ? [p.tabId] : []));
    if (new Set(visible).size !== visible.length || visible.some((id) => !item.tabs.some((t) => t.tabId === id)))
      throw new Error('conflict: 持久标签显示无效');
    if (item.tabs.some((t) => !item.resources.some((r) => r.resourceId === t.targetRef.resourceId && r.kind === t.targetRef.kind)))
      throw new Error('denied: 标签引用不属于空间');
    if (item.sessions.some((s) => !item.resources.some((r) => r.resourceId === s.resourceId && r.kind === 'session')))
      throw new Error('denied: 会话不属于空间');
    const targetBelongs = (target: WorkbenchRun['targetRef']) =>
      !target || item.resources.some((resource) => resource.resourceId === target.resourceId && resource.kind === target.kind);
    const sessionResources = item.sessions.map((session) => session.resourceId);
    if (new Set(sessionResources).size !== sessionResources.length) throw new Error('conflict: 同一资源引用重复会话');
    for (const session of item.sessions) {
      if (session.conversation && session.conversation.conversationId !== session.sessionId) throw new Error('denied: 对话不属于该会话');
      if (!targetBelongs(session.taskTargetRef) || !targetBelongs(session.contextTarget)) throw new Error('denied: 会话目标不属于空间');
      if (session.captureRequest && !item.resources.some((r) => r.resourceId === session.captureRequest!.resourceId && r.kind === 'web'))
        throw new Error('denied: 采集请求网页不属于会话空间');
      if (session.context && session.contextTarget?.kind !== 'web') throw new Error('denied: 页面采集缺少对应网页目标');
      const versions = new Set<number>();
      for (const version of session.taskVersions) {
        if (allIds.has(version.taskVersionId) || versions.has(version.version)) throw new Error('conflict: 任务版本身份重复');
        allIds.add(version.taskVersionId);
        versions.add(version.version);
        if (version.workspaceId !== item.workspaceId || version.sessionId !== session.sessionId || !targetBelongs(version.targetRef))
          throw new Error('denied: 任务版本归属无效');
        if (version.capture && version.targetRef?.kind !== 'web') throw new Error('denied: 任务页面采集与目标不匹配');
      }
      if (item.runs.filter((run) => run.sessionId === session.sessionId && activeStates.includes(run.state)).length > 1)
        throw new Error('conflict: 会话存在重复活动执行');
    }
    for (const run of item.runs) {
      if (run.runId === run.candidateId || allIds.has(run.runId) || allIds.has(run.candidateId))
        throw new Error('conflict: 执行或候选身份重复');
      allIds.add(run.runId);
      allIds.add(run.candidateId);
      const session = item.sessions.find((session) => session.sessionId === run.sessionId);
      const version = session?.taskVersions.find((version) => version.taskVersionId === run.taskVersionId);
      if (run.workspaceId !== item.workspaceId || !session || !version || !targetBelongs(run.targetRef))
        throw new Error('denied: 执行归属无效');
      if (run.targetRef?.kind !== version.targetRef?.kind || run.targetRef?.resourceId !== version.targetRef?.resourceId)
        throw new Error('denied: 执行目标与冻结版本不匹配');
      if (run.conversation) {
        if (
          !run.executionBinding ||
          run.conversation.conversationId !== run.sessionId ||
          run.conversation.generation !== run.executionBinding.generation ||
          run.conversation.turnId !== run.executionBinding.turnId ||
          run.conversation.toolExecutions.some((tool) => tool.turnId !== run.executionBinding!.turnId)
        )
          throw new Error('denied: 运行日志与执行绑定归属不一致');
      }
      if (run.review && (run.review.candidateId !== run.candidateId || run.state !== 'completed'))
        throw new Error('denied: 审阅不属于可审候选');
    }
  }
  if (!snapshot.workspaces.some((w) => w.workspaceId === snapshot.activeWorkspaceId)) throw new Error('not_found: 活动空间不存在');
}
export class WorkbenchApplication {
  private snapshot: WorkbenchSnapshot = {
    appInstanceId: randomUUID(),
    storageError: null,
    activeWorkspaceId: 'taskflow-demo',
    seq: 0,
    workspaces: [],
    notifications: [],
    notificationReadReceipts: [],
  };
  private queue: Promise<unknown> = Promise.resolve();
  private readonly commands = new Map<
    string,
    { fingerprint: string; outcome: { ok: true } | { ok: false; error: Extract<WorkbenchResult, { ok: false }>['error'] } }
  >();
  private readonly runLogBaselines = new Map<string, { messageIds: Set<string>; warnings: Set<string> }>();
  private readonly runTurns = new Map<string, { generation: string; turnId: string | null }>();
  private readonly captures = new Map<
    string,
    { requestId: string; workspaceId: string; sessionId: string; instanceId: string; generation: number; page: PageIdentity }
  >();
  private ready: Promise<void>;
  private initialized = false;
  private initializationFailed = false;
  private resourceRefresh: Promise<void> | null = null;
  private emissionTimer: ReturnType<typeof setTimeout> | null = null;
  constructor(
    private readonly repository: WorkbenchRepository,
    private readonly runtime: WorkbenchRuntime,
    private readonly emit: (event: WorkbenchEvent) => void,
  ) {
    this.ready = this.beginInitialization();
  }
  private beginInitialization(): Promise<void> {
    const attempt = this.initialize().then(() => {
      this.initialized = true;
    });
    void attempt.catch(() => {
      this.initializationFailed = true;
    });
    return attempt;
  }
  async retryInitialization(): Promise<WorkbenchSnapshot> {
    if (!this.initialized && this.initializationFailed) {
      this.initializationFailed = false;
      this.ready = this.beginInitialization();
    }
    await this.ready;
    void this.refreshPublicResources();
    return this.getSnapshot();
  }
  private async initialize() {
    const saved = await this.repository.load();
    if (saved) {
      let recoveredExecution = false;
      validateSnapshot(saved);
      for (const w of saved.workspaces) for (const r of w.resources) if (r.kind === 'web' && r.url) this.runtime.validateBrowserUrl(r.url);
      this.snapshot = { ...saved, appInstanceId: this.snapshot.appInstanceId, seq: 0 };
      for (const w of this.snapshot.workspaces) {
        for (const session of w.sessions) session.historyRestored = Boolean(session.conversation?.messages.length);
        for (const r of w.resources) {
          r.instanceId = null;
          r.preview = null;
          if (r.terminal)
            r.terminal = { ...r.terminal, sessionId: null, state: 'closed', cleanupPending: false, error: '应用重启；终端需明确重新连接' };
        }
        for (const s of w.sessions)
          if (s.conversation && activeStates.includes(s.conversation.state))
            s.conversation = {
              ...s.conversation,
              state: 'failed',
              cleanupPending: false,
              error: '应用重启；历史执行已中断',
              threadId: null,
            };
        for (const run of w.runs)
          if (activeStates.includes(run.state)) {
            recoveredExecution = true;
            run.state = 'interrupted';
            run.endedAt = new Date().toISOString();
            run.error = '应用重启；未重放执行';
          }
        for (const s of w.sessions) {
          if (s.context) s.contextApplicability = 'stale';
          if (s.captureRequest?.state === 'pending') {
            recoveredExecution = true;
            s.captureRequest = { ...s.captureRequest, state: 'cancelled', error: '应用重启；页面采集未完成，不重放' };
          }
        }
      }
      if (recoveredExecution) {
        // Persist terminal facts once so read-only restarts keep the same event time and notification identity.
        this.snapshot.storageError = null;
        try {
          await this.repository.save(this.snapshot);
        } catch (error) {
          this.snapshot.storageError = '恢复终态保存失败：' + (error as Error).message;
        }
      }
    } else {
      const w = workspace('taskflow-demo', 'TaskFlow');
      this.snapshot.workspaces = [w];
      this.createResource(w, 'web', 'TaskFlow 预览', 'wsl-demo://taskflow/index.html');
      this.createResource(w, 'terminal', '开发终端');
      this.createResource(w, 'session', 'Agent 会话');
      const web = w.tabs.find((t) => t.targetRef.kind === 'web');
      if (web) w.layout = { kind: 'pane', paneId: w.activePaneId, tabId: web.tabId };
      await this.repository.save(this.snapshot);
    }
    // Local history is usable before the independent service connection becomes available.
    queueMicrotask(() => {
      void this.refreshPublicResources();
    });
  }
  private refreshPublicResources(): Promise<void> {
    if (this.resourceRefresh) return this.resourceRefresh;
    const taskflow = this.snapshot.workspaces.find((w) => w.workspaceId === 'taskflow-demo');
    if (!taskflow) return Promise.resolve();
    const revisionAtStart = taskflow.publicResources?.revision ?? -1;
    this.resourceRefresh = Promise.resolve()
      .then(() => this.runtime.publicResourcesList())
      .then(
        async (collection) => {
          await this.updateRuntime(() => {
            const current = this.requireWorkspace('taskflow-demo');
            if (current.publicResources && current.publicResources.revision > collection.revision) return null;
            current.publicResources = collection;
            current.publicResourcesError = null;
            return current;
          }, true);
        },
        async (error) => {
          await this.updateRuntime(() => {
            const current = this.requireWorkspace('taskflow-demo');
            if ((current.publicResources?.revision ?? -1) !== revisionAtStart) return null;
            current.publicResourcesError = '公开资源刷新失败：' + (error as Error).message;
            return current;
          }, true);
        },
      )
      .finally(() => {
        this.resourceRefresh = null;
      });
    return this.resourceRefresh;
  }
  async getSnapshot(): Promise<WorkbenchSnapshot> {
    await this.ready;
    await this.queue;
    return this.publicSnapshot();
  }
  private publicSnapshot(): WorkbenchSnapshot {
    const snapshot = structuredClone(this.snapshot);
    const receipts = new Map(snapshot.notificationReadReceipts.map((receipt) => [receipt.notificationId, receipt.readAt]));
    snapshot.notifications = snapshot.workspaces
      .flatMap((w) =>
        w.runs.flatMap((run) => {
          if (activeStates.includes(run.state)) return [];
          const kind = run.state as WorkbenchNotification['kind'];
          const notificationId = w.workspaceId + ':' + run.runId + ':' + kind;
          return [
            {
              notificationId,
              workspaceId: w.workspaceId,
              sessionId: run.sessionId,
              taskVersionId: run.taskVersionId,
              runId: run.runId,
              kind,
              occurredAt: run.endedAt ?? run.startedAt,
              readAt: receipts.get(notificationId) ?? null,
            },
          ];
        }),
      )
      .sort((a, b) => b.occurredAt.localeCompare(a.occurredAt));
    return snapshot;
  }
  command(command: WorkbenchCommand): Promise<WorkbenchResult> {
    const next = this.queue.then(async () => {
      await this.ready;
      return this.execute(command);
    });
    this.queue = next.then(
      () => undefined,
      () => undefined,
    );
    return next;
  }
  private requireWorkspace(id: string) {
    const w = this.snapshot.workspaces.find((w) => w.workspaceId === id);
    if (!w) throw new Error('not_found: 空间不存在');
    return w;
  }
  private resource(w: WorkspaceSnapshot, id: string, kind?: string) {
    const r = w.resources.find((r) => r.resourceId === id);
    if (!r) throw new Error('denied: 资源不属于该空间');
    if (kind && r.kind !== kind) throw new Error('invalid_input: 资源类型不匹配');
    return r;
  }
  private session(w: WorkspaceSnapshot, id: string) {
    const s = w.sessions.find((s) => s.sessionId === id);
    if (!s) throw new Error('denied: 会话不属于该空间');
    return s;
  }
  private run(w: WorkspaceSnapshot, id: string) {
    const r = w.runs.find((r) => r.runId === id);
    if (!r) throw new Error('denied: 执行不属于该空间');
    return r;
  }
  private createResource(w: WorkspaceSnapshot, kind: WorkbenchResource['kind'], title: string, url?: string) {
    const resourceId = randomUUID();
    const r: WorkbenchResource = {
      resourceId,
      kind,
      title,
      url: url ?? null,
      instanceId: null,
      generation: 0,
      preview: null,
      terminal: null,
      unavailableReason: kind === 'ssh' ? 'SSH 适配器尚未接入' : kind === 'file' ? '文件编辑适配器尚未接入' : null,
    };
    w.resources.push(r);
    if (kind === 'session')
      w.sessions.push({
        sessionId: 'session-' + randomUUID(),
        resourceId,
        title,
        draft: '',
        conversation: null,
        historyRestored: false,
        context: null,
        captureRequest: null,
        contextTarget: null,
        taskTargetRef: null,
        taskAcceptance: [],
        taskAllowedScopes: [],
        contextApplicability: 'unknown',
        taskVersions: [],
      });
    const tab = { tabId: randomUUID(), title, pinned: false, group: null, targetRef: { kind, resourceId } };
    w.tabs.push(tab);
    return tab;
  }
  private openResource(w: WorkspaceSnapshot, resourceId: string) {
    const r = this.resource(w, resourceId);
    let tab = w.tabs.find((t) => t.targetRef.resourceId === resourceId);
    if (!tab) {
      tab = { tabId: randomUUID(), title: r.title, pinned: false, group: null, targetRef: { kind: r.kind, resourceId } };
      w.tabs.push(tab);
    }
    const active = activateTab(w.layout, w.activePaneId, tab.tabId);
    w.layout = active.layout;
    w.activePaneId = active.activePaneId;
  }
  private async persist(w: WorkspaceSnapshot, entityId: string) {
    const candidate = structuredClone(this.snapshot);
    const saved = candidate.workspaces.find((item) => item.workspaceId === w.workspaceId);
    if (!saved) throw new Error('not_found: 空间不存在');
    saved.revision++;
    candidate.seq++;
    candidate.storageError = null;
    await this.repository.save(candidate);
    w.revision = saved.revision;
    this.snapshot.seq = candidate.seq;
    this.snapshot.storageError = null;
    this.emitSnapshot(w.workspaceId, entityId);
  }
  private emitSnapshot(workspaceId: string, entityId: string) {
    this.emit({
      eventId: randomUUID(),
      workspaceId,
      entityId,
      occurredAt: new Date().toISOString(),
      seq: this.snapshot.seq,
      instanceId: null,
      generation: 0,
      type: 'snapshot',
      snapshot: this.publicSnapshot(),
    });
  }
  private result(): WorkbenchResult {
    return { ok: true, snapshot: this.publicSnapshot() };
  }
  private rememberCommand(commandId: string, fingerprint: string, result: WorkbenchResult) {
    this.commands.set(commandId, { fingerprint, outcome: result.ok ? { ok: true } : { ok: false, error: result.error } });
    // Deduplication is bounded to the last 2048 commands in this app instance; reconnects query facts instead of replaying writes.
    if (this.commands.size > 2048) {
      const oldest = this.commands.keys().next().value;
      if (oldest) this.commands.delete(oldest);
    }
  }
  private async execute(c: WorkbenchCommand): Promise<WorkbenchResult> {
    const fingerprint = createHash('sha256').update(JSON.stringify(c)).digest('hex');
    const old = this.commands.get(c.commandId);
    if (old)
      return old.fingerprint === fingerprint
        ? { ...structuredClone(old.outcome), snapshot: this.publicSnapshot() }
        : { ok: false, error: { code: 'conflict', message: '同一命令身份不能用于不同内容' }, snapshot: this.publicSnapshot() };
    const before = structuredClone(this.snapshot);
    const runtimeCommand = [
      'startRun',
      'cancelRun',
      'terminalOpen',
      'stopInstance',
      'browserAction',
      'browserLayout',
      'terminalWrite',
      'terminalResize',
      'captureContext',
      'cancelCapture',
      'hideBrowsers',
      'capturePublicResource',
      'removePublicResource',
    ].includes(c.type);
    const rememberResult = () => {
      const result = this.result();
      this.rememberCommand(c.commandId, fingerprint, result);
      return result;
    };
    let w: WorkspaceSnapshot | undefined;
    try {
      if (c.type === 'createWorkspace') {
        if (this.snapshot.workspaces.some((w) => w.workspaceId === c.workspaceId)) throw new Error('conflict: 空间身份已存在');
        w = workspace(c.workspaceId, c.name);
        this.snapshot.workspaces.unshift(w);
        this.snapshot.activeWorkspaceId = w.workspaceId;
      } else {
        w = this.requireWorkspace(c.workspaceId);
        if (c.expectedRevision !== undefined && c.expectedRevision !== w.revision)
          throw new Error('conflict: 空间已有较新修改，请重新加载');
        switch (c.type) {
          case 'renameWorkspace':
            w.name = c.name;
            break;
          case 'switchWorkspace':
            this.snapshot.activeWorkspaceId = w.workspaceId;
            this.snapshot.workspaces = [w, ...this.snapshot.workspaces.filter((item) => item.workspaceId !== c.workspaceId)];
            break;
          case 'createTab': {
            if (c.url && c.kind !== 'web') throw new Error('invalid_input: 只有网页资源接受URL');
            if (c.url) this.runtime.validateBrowserUrl(c.url);
            const tab = this.createResource(w, c.kind, c.title, c.url);
            const a = activateTab(w.layout, w.activePaneId, tab.tabId);
            w.layout = a.layout;
            w.activePaneId = a.activePaneId;
            break;
          }
          case 'locateSession': {
            const session = this.session(w, c.sessionId);
            if (c.taskVersionId && !session.taskVersions.some((v) => v.taskVersionId === c.taskVersionId))
              throw new Error('denied: 任务版本不属于会话');
            if (c.runId) {
              const run = this.run(w, c.runId);
              if (run.sessionId !== session.sessionId || (c.taskVersionId && run.taskVersionId !== c.taskVersionId))
                throw new Error('denied: 执行不属于指定会话或任务版本');
            }
            this.snapshot.activeWorkspaceId = w.workspaceId;
            this.snapshot.workspaces = [w, ...this.snapshot.workspaces.filter((item) => item.workspaceId !== w!.workspaceId)];
            this.openResource(w, session.resourceId);
            break;
          }
          case 'markNotificationRead': {
            const notification = this.publicSnapshot().notifications.find(
              (item) => item.notificationId === c.notificationId && item.workspaceId === w!.workspaceId,
            );
            if (!notification) throw new Error('not_found: 通知不存在');
            if (!notification.readAt)
              this.snapshot.notificationReadReceipts.push({
                notificationId: notification.notificationId,
                readAt: new Date().toISOString(),
              });
            break;
          }
          case 'openTab': {
            this.openResource(w, c.resourceId);
            break;
          }
          case 'activateTab': {
            if (!w.tabs.some((t) => t.tabId === c.tabId)) throw new Error('not_found: 标签不存在');
            const a = activateTab(w.layout, w.activePaneId, c.tabId);
            w.layout = a.layout;
            w.activePaneId = a.activePaneId;
            break;
          }
          case 'closeTab':
            w.tabs = w.tabs.filter((t) => t.tabId !== c.tabId);
            w.layout = closeTab(w.layout, c.tabId);
            break;
          case 'updateTab': {
            const t = w.tabs.find((t) => t.tabId === c.tabId);
            if (!t) throw new Error('not_found: 标签不存在');
            if (c.title !== undefined) t.title = c.title;
            if (c.pinned !== undefined) t.pinned = c.pinned;
            if (c.group !== undefined) t.group = c.group;
            break;
          }
          case 'reorderTabs': {
            if (
              c.tabIds.length !== w.tabs.length ||
              new Set(c.tabIds).size !== w.tabs.length ||
              c.tabIds.some((id) => !w?.tabs.some((t) => t.tabId === id))
            )
              throw new Error('invalid_input: 标签排序身份无效');
            w.tabs = c.tabIds.map((id) => {
              const t = w?.tabs.find((t) => t.tabId === id);
              if (!t) throw new Error('not_found: 标签不存在');
              return t;
            });
            break;
          }
          case 'splitPane': {
            if (c.tabId && !w.tabs.some((t) => t.tabId === c.tabId)) throw new Error('not_found: 标签不存在');
            const newPaneId = randomUUID();
            w.layout = splitPane(w.layout, c.paneId, c.direction, newPaneId, c.tabId ?? null);
            w.activePaneId = newPaneId;
            break;
          }
          case 'closePane':
            w.layout = closePane(w.layout, c.paneId);
            if (!panes(w.layout).some((p) => p.paneId === w?.activePaneId)) {
              const first = panes(w.layout)[0];
              if (!first) throw new Error('invalid_input: 无窗格');
              w.activePaneId = first.paneId;
            }
            break;
          case 'focusPane':
            if (!panes(w.layout).some((p) => p.paneId === c.paneId)) throw new Error('not_found: 窗格不存在');
            w.activePaneId = c.paneId;
            break;
          case 'setRatio':
            w.layout = setRatio(w.layout, c.paneId, c.ratio);
            break;
          case 'setPreferences':
            if (c.theme !== undefined) w.theme = c.theme;
            break;
          case 'saveTaskCriteria': {
            const session = this.session(w, c.sessionId);
            session.taskAcceptance = [...c.acceptance];
            session.taskAllowedScopes = [...c.allowedScopes];
            break;
          }
          case 'saveTaskTarget': {
            const s = this.session(w, c.sessionId);
            if (c.targetRef) this.resource(w, c.targetRef.resourceId, c.targetRef.kind);
            s.taskTargetRef = c.targetRef;
            break;
          }
          case 'saveDraft':
            this.session(w, c.sessionId).draft = c.draft;
            break;
          case 'capturePublicResource': {
            if (w.workspaceId !== 'taskflow-demo') throw new Error('unsupported: 当前公开资源接口仅对TaskFlow空间开放');
            const r = this.resource(w, c.resourceId, 'web');
            this.ensureBrowser(w, r);
            w.publicResources = await this.runtime.publicResourcesCapture(r.resourceId, c.savedResourceId);
            w.publicResourcesError = null;
            break;
          }
          case 'removePublicResource': {
            if (w.workspaceId !== 'taskflow-demo') throw new Error('unsupported: 当前公开资源接口仅对TaskFlow空间开放');
            w.publicResources = await this.runtime.publicResourcesRemove(c.savedResourceId);
            w.publicResourcesError = null;
            break;
          }
          case 'captureContext': {
            const r = this.resource(w, c.resourceId, 'web');
            this.ensureBrowser(w, r);
            const receiver = this.session(w, c.sessionId);
            if (!r.instanceId) throw new Error('网页实例未建立');
            const binding = {
              requestId: c.requestId,
              workspaceId: w.workspaceId,
              sessionId: c.sessionId,
              instanceId: r.instanceId,
              generation: r.generation,
              page: this.runtime.browserState(r.resourceId).page,
            };
            // Replacing either endpoint cancels the old request without transferring its ownership.
            for (const [resourceId, old] of this.captures) {
              if (resourceId !== r.resourceId && (old.workspaceId !== w.workspaceId || old.sessionId !== c.sessionId)) continue;
              this.captures.delete(resourceId);
              const oldSession = this.session(this.requireWorkspace(old.workspaceId), old.sessionId);
              if (oldSession.captureRequest?.requestId === old.requestId)
                oldSession.captureRequest = { ...oldSession.captureRequest, state: 'cancelled', error: '页面采集已被新请求替换' };
              await this.runtime.browserAction(resourceId, 'cancelPick', undefined, old.requestId);
            }
            receiver.captureRequest = { requestId: c.requestId, resourceId: r.resourceId, state: 'pending', error: null };
            this.captures.set(r.resourceId, binding);
            try {
              await this.runtime.browserAction(r.resourceId, 'pick', undefined, c.requestId);
            } catch (error) {
              if (this.captures.get(r.resourceId) === binding) {
                this.captures.delete(r.resourceId);
                receiver.captureRequest = { ...receiver.captureRequest, state: 'failed', error: (error as Error).message };
              }
              throw error;
            }
            break;
          }
          case 'cancelCapture': {
            this.resource(w, c.resourceId, 'web');
            const pending = this.captures.get(c.resourceId);
            if (pending?.workspaceId === w.workspaceId && pending.requestId === c.requestId) {
              this.captures.delete(c.resourceId);
              const receiver = this.session(w, pending.sessionId);
              if (receiver.captureRequest?.requestId === pending.requestId)
                receiver.captureRequest = { ...receiver.captureRequest, state: 'cancelled', error: null };
              await this.runtime.browserAction(c.resourceId, 'cancelPick', undefined, c.requestId);
            }
            break;
          }
          case 'confirmTask': {
            const s = this.session(w, c.sessionId);
            if (c.targetRef) {
              const r = this.resource(w, c.targetRef.resourceId, c.targetRef.kind);
              if (r.kind === 'web') {
                if (
                  !r.instanceId ||
                  !s.context ||
                  s.contextTarget?.resourceId !== r.resourceId ||
                  s.contextApplicability !== 'current' ||
                  s.context.page.documentGeneration !== this.runtime.browserState(r.resourceId).page.documentGeneration ||
                  s.context.page.webContentsId !== this.runtime.browserState(r.resourceId).page.webContentsId
                )
                  throw new Error('conflict: 页面现场已失效，请重新选择元素');
              }
            }
            s.taskVersions.push({
              taskVersionId: randomUUID(),
              version: s.taskVersions.length + 1,
              workspaceId: w.workspaceId,
              sessionId: s.sessionId,
              goal: c.goal,
              targetRef: c.targetRef,
              capture:
                c.targetRef?.kind === 'web' && s.contextTarget?.resourceId === c.targetRef.resourceId && s.context
                  ? structuredClone(s.context)
                  : null,
              confirmedAt: new Date().toISOString(),
              acceptance: [...(c.acceptance ?? s.taskAcceptance)],
              allowedScopes: [...(c.allowedScopes ?? s.taskAllowedScopes)],
            });
            break;
          }
          case 'startRun':
            await this.startRun(w, c.sessionId, c.taskVersionId);
            break;
          case 'cancelRun': {
            const run = this.run(w, c.runId);
            if (!activeStates.includes(run.state)) break;
            const previousState = run.state;
            run.state = 'cancelling';
            try {
              await this.persist(w, c.commandId);
            } catch (error) {
              run.state = previousState;
              throw error;
            }
            this.requestCancellation(w.workspaceId, run.runId, this.runTurns.get(run.runId));
            return rememberResult();
          }
          case 'runValidation': {
            const run = this.run(w, c.runId);
            run.validation = { state: 'blocked', applicability: 'unknown', reason: '独立检查适配器尚未接入；Agent 文本不能作为检查结果' };
            break;
          }
          case 'recordReview': {
            const run = this.run(w, c.runId);
            if (run.candidateId !== c.candidateId || run.state !== 'completed' || (run.review && run.review.decision !== c.decision))
              throw new Error('conflict: 候选版本或执行状态已变化');
            if (c.decision === 'accepted' && (run.validation.state !== 'passed' || run.validation.applicability !== 'current'))
              throw new Error('conflict: 当前候选尚未通过适用的独立检查，不能接受');
            run.review = { candidateId: c.candidateId, decision: c.decision, reviewedAt: new Date().toISOString() };
            break;
          }
          case 'hideBrowsers':
            this.runtime.hideBrowsers();
            return rememberResult();
          case 'browserLayout': {
            const r = this.resource(w, c.resourceId, 'web');
            this.ensureBrowser(w, r);
            if (c.layout.visible && this.snapshot.activeWorkspaceId !== w.workspaceId) throw new Error('denied: 不能显示后台空间网页');
            this.runtime.browserLayout(r.resourceId, c.layout);
            return rememberResult();
          }
          case 'browserAction': {
            const r = this.resource(w, c.resourceId, 'web');
            this.ensureBrowser(w, r);
            await this.runtime.browserAction(r.resourceId, c.action, c.url);
            return rememberResult();
          }
          case 'terminalOpen': {
            const r = this.resource(w, c.resourceId, 'terminal');
            if (r.terminal?.cleanupPending || r.terminal?.state === 'running') return rememberResult();
            r.generation++;
            r.terminal = await this.runtime.terminalOpen(r.resourceId, c.cols, c.rows);
            r.instanceId = r.terminal.sessionId;
            break;
          }
          case 'terminalWrite': {
            const r = this.resource(w, c.resourceId, 'terminal');
            this.checkInstance(r, c.instanceId);
            await this.runtime.terminalWrite(r.resourceId, c.instanceId, c.data);
            return rememberResult();
          }
          case 'terminalResize': {
            const r = this.resource(w, c.resourceId, 'terminal');
            this.checkInstance(r, c.instanceId);
            await this.runtime.terminalResize(r.resourceId, c.instanceId, c.cols, c.rows);
            return rememberResult();
          }
          case 'stopInstance': {
            const r = this.resource(w, c.resourceId);
            this.checkInstance(r, c.instanceId);
            if (r.kind !== 'terminal') throw new Error('unsupported: 该资源没有可停止的进程');
            if (!r.terminal) throw new Error('执行实例缺少终端快照');
            if (r.terminal.state === 'closing' || (r.terminal.state === 'closed' && !r.terminal.cleanupPending)) return rememberResult();
            if (r.terminal.state === 'failed' && r.terminal.cleanupPending)
              throw new Error('execution_failed: 终端清理未确认，不能重复停止或重新连接');
            const beforeStop = r.terminal;
            r.terminal = { ...beforeStop, state: 'closing', cleanupPending: true };
            try {
              await this.persist(w, c.commandId);
            } catch (error) {
              r.terminal = beforeStop;
              throw error;
            }
            this.requestTerminalStop(w.workspaceId, r.resourceId, c.instanceId, r.generation);
            return rememberResult();
          }
        }
      }
      validateSnapshot(this.snapshot);
      await this.persist(w, c.commandId);
      if (
        c.type === 'switchWorkspace' ||
        c.type === 'createWorkspace' ||
        (c.type === 'locateSession' && before.activeWorkspaceId !== this.snapshot.activeWorkspaceId)
      )
        this.runtime.hideBrowsers();
      const result = this.result();
      this.rememberCommand(c.commandId, fingerprint, result);
      return result;
    } catch (error) {
      if (!runtimeCommand) this.snapshot = before;
      const message = (error as Error).message;
      if (w?.workspaceId === 'taskflow-demo' && (c.type === 'capturePublicResource' || c.type === 'removePublicResource'))
        w.publicResourcesError = message;
      const code = message.split(':')[0];
      const allowed = [
        'unsupported',
        'disconnected',
        'conflict',
        'not_found',
        'denied',
        'execution_failed',
        'invalid_input',
        'pane_limit',
      ] as const;
      const matched = allowed.find((c) => c === code) ?? 'execution_failed';
      const result: WorkbenchResult = { ok: false, error: { code: matched, message }, snapshot: this.publicSnapshot() };
      this.rememberCommand(c.commandId, fingerprint, result);
      return result;
    }
  }
  private checkInstance(r: WorkbenchResource, id: string) {
    if (r.instanceId !== id) throw new Error('conflict: 运行实例已变化');
  }
  private ensureBrowser(w: WorkspaceSnapshot, r: WorkbenchResource) {
    if (!r.instanceId) {
      const candidate = { ...r, instanceId: randomUUID(), generation: r.generation + 1 };
      this.runtime.ensureBrowser(w.workspaceId, candidate);
      r.preview = this.runtime.browserState(r.resourceId);
      r.instanceId = candidate.instanceId;
      r.generation = candidate.generation;
    }
  }
  performActiveBrowserAction(action: 'reload' | 'openDevTools'): Promise<void> {
    const next = this.queue.then(async () => {
      await this.ready;
      const resourceId = this.activeBrowserResourceId();
      if (!resourceId) return;
      const w = this.requireWorkspace(this.snapshot.activeWorkspaceId);
      this.ensureBrowser(w, this.resource(w, resourceId, 'web'));
      await this.runtime.browserAction(resourceId, action);
    });
    this.queue = next.then(
      () => undefined,
      () => undefined,
    );
    return next;
  }
  activeBrowserResourceId(): string | null {
    const w = this.snapshot.workspaces.find((w) => w.workspaceId === this.snapshot.activeWorkspaceId);
    const pane = w && panes(w.layout).find((p) => p.paneId === w.activePaneId);
    const tab = pane && w?.tabs.find((t) => t.tabId === pane.tabId);
    return tab?.targetRef.kind === 'web' ? tab.targetRef.resourceId : null;
  }
  onBrowserFocus(workspaceId: string, resourceId: string, instanceId: string | null, generation: number) {
    void this.updateRuntime(() => {
      if (this.snapshot.activeWorkspaceId !== workspaceId) return null;
      const w = this.requireWorkspace(workspaceId);
      const r = this.resource(w, resourceId, 'web');
      if (r.instanceId !== instanceId || r.generation !== generation) return null;
      const pane = panes(w.layout).find((p) => w.tabs.some((t) => t.tabId === p.tabId && t.targetRef.resourceId === resourceId));
      if (!pane || w.activePaneId === pane.paneId) return null;
      w.activePaneId = pane.paneId;
      return w;
    });
  }
  private async startRun(w: WorkspaceSnapshot, sessionId: string, versionId: string) {
    const s = this.session(w, sessionId);
    const v = s.taskVersions.find((v) => v.taskVersionId === versionId);
    if (!v) throw new Error('not_found: 任务版本不存在');
    if (w.runs.some((r) => r.sessionId === sessionId && activeStates.includes(r.state))) throw new Error('conflict: 会话已有执行');
    if (v.targetRef?.kind === 'web') {
      const r = this.resource(w, v.targetRef.resourceId, 'web');
      this.ensureBrowser(w, r);
      if (
        !v.capture ||
        v.capture.page.documentGeneration !== this.runtime.browserState(r.resourceId).page.documentGeneration ||
        v.capture.page.webContentsId !== this.runtime.browserState(r.resourceId).page.webContentsId
      )
        throw new Error('conflict: 确认后的页面已导航，请重新确认');
    }
    const previousRuns = structuredClone(w.runs);
    for (const old of w.runs.filter((r) => r.sessionId === sessionId)) old.validation.applicability = 'unknown';
    const run: WorkbenchRun = {
      runId: randomUUID(),
      workspaceId: w.workspaceId,
      sessionId,
      taskVersionId: versionId,
      targetRef: structuredClone(v.targetRef),
      state: 'starting',
      startedAt: new Date().toISOString(),
      endedAt: null,
      error: null,
      candidateId: randomUUID(),
      validation: { state: 'not_run', applicability: 'unknown', reason: null },
      review: null,
      conversation: null,
      executionBinding: null,
    };
    w.runs.push(run);
    this.runLogBaselines.set(run.runId, {
      messageIds: new Set(s.conversation?.messages.map((m) => m.id)),
      warnings: new Set(s.conversation?.warnings),
    });
    // Freeze and persist ownership before invoking the existing runner.
    try {
      await this.repository.save(this.snapshot);
    } catch (error) {
      w.runs = previousRuns;
      this.runLogBaselines.delete(run.runId);
      throw error;
    }
    try {
      await this.runtime.registerSession(sessionId, w.workspaceId);
      const conversation = await this.runtime.send(
        sessionId,
        `任务版本 ${v.taskVersionId}\n空间 ${w.workspaceId}\n目标 ${JSON.stringify(v.targetRef)}\n上下文 ${v.capture?.element.text ?? '未附加'}\n允许范围 ${v.allowedScopes.join(', ')}\n验收条件 ${v.acceptance.join('; ')}\n\n${v.goal}`,
      );
      this.applyConversation(w, conversation);
    } catch (error) {
      run.state = 'failed';
      run.error = (error as Error).message;
      run.endedAt = new Date().toISOString();
      this.runLogBaselines.delete(run.runId);
    }
  }
  private requestTerminalStop(workspaceId: string, resourceId: string, instanceId: string, generation: number) {
    void Promise.resolve()
      .then(() => this.runtime.terminalStop(resourceId, instanceId))
      .then(
        (terminal) =>
          this.updateRuntime(() => {
            const w = this.requireWorkspace(workspaceId);
            const resource = this.resource(w, resourceId, 'terminal');
            if (
              resource.instanceId !== instanceId ||
              resource.generation !== generation ||
              terminal.sessionId !== instanceId ||
              (resource.terminal?.seq ?? -1) > terminal.seq
            )
              return null;
            resource.terminal =
              terminal.cleanupPending || !['closed', 'failed'].includes(terminal.state)
                ? { ...terminal, state: 'failed', cleanupPending: true, error: terminal.error ?? '停止返回但guest清理未确认' }
                : terminal;
            return w;
          }),
        (error) =>
          this.updateRuntime(() => {
            const w = this.requireWorkspace(workspaceId);
            const resource = this.resource(w, resourceId, 'terminal');
            if (resource.instanceId !== instanceId || resource.generation !== generation) return null;
            if (resource.terminal && !resource.terminal.cleanupPending && ['closed', 'failed'].includes(resource.terminal.state))
              return null;
            if (!resource.terminal) throw new Error('执行实例缺少终端快照');
            resource.terminal = {
              ...resource.terminal,
              state: 'failed',
              cleanupPending: true,
              error: '终端停止失败；guest清理未确认：' + (error as Error).message,
            };
            return w;
          }),
      );
  }
  private requestCancellation(workspaceId: string, runId: string, binding: { generation: string; turnId: string | null } | undefined) {
    const run = this.run(this.requireWorkspace(workspaceId), runId);
    // Cleanup can take arbitrarily long; its completion rejoins the metadata queue with the original run binding.
    void Promise.resolve()
      .then(() => this.runtime.cancel(run.sessionId))
      .then(
        (conversation) =>
          this.updateRuntime(() => {
            const w = this.requireWorkspace(workspaceId);
            const current = this.run(w, runId);
            if (!activeStates.includes(current.state)) return null;
            if (binding && (conversation.generation !== binding.generation || conversation.turnId !== binding.turnId)) return null;
            this.applyConversation(w, conversation);
            return w;
          }),
        (error) =>
          this.updateRuntime(() => {
            const w = this.requireWorkspace(workspaceId);
            const current = this.run(w, runId);
            if (!activeStates.includes(current.state)) return null;
            const latest = this.runTurns.get(runId);
            if (binding && (latest?.generation !== binding.generation || latest.turnId !== binding.turnId)) return null;
            current.error = '取消失败；停止尚未确认：' + (error as Error).message;
            return w;
          }),
      );
  }
  private applyConversation(w: WorkspaceSnapshot, conversation: ChatConversation) {
    const s = w.sessions.find((s) => s.sessionId === conversation.conversationId);
    if (!s) return;
    const executing = w.runs.findLast((r) => r.sessionId === s.sessionId && activeStates.includes(r.state));
    const bound = executing ? this.runTurns.get(executing.runId) : null;
    if (bound && (bound.generation !== conversation.generation || bound.turnId !== conversation.turnId)) return;
    if (!executing && s.conversation && s.conversation.generation !== conversation.generation) return;
    if (s.conversation?.generation === conversation.generation && s.conversation.seq >= conversation.seq) return;
    if (executing && !bound) this.runTurns.set(executing.runId, { generation: conversation.generation, turnId: conversation.turnId });
    if (executing) {
      const binding = this.runTurns.get(executing.runId);
      if (!binding) throw new Error('执行缺少已建立的消息绑定');
      executing.executionBinding = { ...binding };
      const baseline = this.runLogBaselines.get(executing.runId);
      if (!baseline) throw new Error('执行缺少启动前日志基准');
      executing.conversation = {
        ...structuredClone(conversation),
        messages: structuredClone(conversation.messages.filter((m) => !baseline.messageIds.has(m.id))),
        toolExecutions: structuredClone(conversation.toolExecutions.filter((tool) => tool.turnId === binding.turnId)),
        warnings: conversation.warnings.filter((warning) => !baseline.warnings.has(warning)),
      };
    }
    const previous = s.conversation;
    const messageIds = new Set(conversation.messages.map((message) => message.id));
    s.conversation = {
      ...conversation,
      messages: [...(previous?.messages.filter((message) => !messageIds.has(message.id)) ?? []), ...conversation.messages],
    };
    const run = w.runs.findLast((r) => r.sessionId === s.sessionId && activeStates.includes(r.state));
    if (!run) return;
    run.state = conversation.state === 'idle' ? 'completed' : conversation.state;
    run.error = conversation.error;
    if (!activeStates.includes(run.state)) {
      run.endedAt = new Date().toISOString();
      this.runLogBaselines.delete(run.runId);
    }
  }
  onConversation(conversation: ChatConversation) {
    void this.updateRuntime(() => {
      const w = this.snapshot.workspaces.find((w) => w.sessions.some((s) => s.sessionId === conversation.conversationId));
      if (!w) return null;
      this.applyConversation(w, conversation);
      return w;
    });
  }
  onTerminal(resourceId: string, snapshot: TerminalSnapshot) {
    void this.updateRuntime(() => {
      const w = this.snapshot.workspaces.find((w) => w.resources.some((r) => r.resourceId === resourceId));
      if (!w) return null;
      const r = this.resource(w, resourceId, 'terminal');
      if (r.instanceId && snapshot.sessionId !== r.instanceId) return null;
      if (r.terminal?.sessionId === snapshot.sessionId && r.terminal.seq >= snapshot.seq) return null;
      r.terminal = snapshot;
      r.instanceId = snapshot.sessionId;
      return w;
    }, true);
  }
  onPreview(resourceId: string, state: PreviewState, instanceId: string | null, generation: number) {
    void this.updateRuntime(() => {
      const w = this.snapshot.workspaces.find((w) => w.resources.some((r) => r.resourceId === resourceId));
      if (!w) return null;
      const r = this.resource(w, resourceId, 'web');
      if (r.instanceId !== instanceId || r.generation !== generation) return null;
      const pending = this.captures.get(resourceId);
      if (
        pending &&
        (state.loading ||
          state.page.documentGeneration !== pending.page.documentGeneration ||
          state.page.webContentsId !== pending.page.webContentsId)
      ) {
        this.captures.delete(resourceId);
        const receiver = this.session(w, pending.sessionId);
        if (receiver.captureRequest?.requestId === pending.requestId)
          receiver.captureRequest = { ...receiver.captureRequest, state: 'cancelled', error: '页面已经变化，本次采集已取消' };
      }
      r.preview = state;
      if (!state.loading && !state.loadError && state.page.url) r.url = state.page.url;
      for (const s of w.sessions)
        if (s.contextTarget?.resourceId === resourceId && s.context && s.context.page.documentGeneration !== state.page.documentGeneration)
          s.contextApplicability = 'stale';
      return w;
    });
  }
  onCapture(resourceId: string, capture: PageCapture, instanceId: string | null, generation: number, requestId: string) {
    void this.updateRuntime(() => {
      const pending = this.captures.get(resourceId);
      if (!pending || pending.requestId !== requestId) return null;
      const w = this.requireWorkspace(pending.workspaceId);
      const s = this.session(w, pending.sessionId);
      if (s.captureRequest?.requestId !== requestId || s.captureRequest.state !== 'pending') return null;
      const r = this.resource(w, resourceId, 'web');
      if (r.instanceId !== instanceId || r.generation !== generation) return null;
      const current = this.runtime.browserState(resourceId);
      if (
        current.loading ||
        r.instanceId !== pending.instanceId ||
        r.generation !== pending.generation ||
        capture.page.documentGeneration !== pending.page.documentGeneration ||
        capture.page.webContentsId !== pending.page.webContentsId ||
        capture.page.documentGeneration !== current.page.documentGeneration ||
        capture.page.webContentsId !== current.page.webContentsId
      )
        return null;
      s.context = capture;
      s.contextTarget = { kind: 'web', resourceId: r.resourceId };
      s.contextApplicability = 'current';
      s.captureRequest = { ...s.captureRequest, state: 'completed', error: null };
      this.captures.delete(resourceId);
      return w;
    });
  }
  onCaptureError(
    resourceId: string,
    requestId: string,
    instanceId: string | null,
    generation: number,
    kind: 'failed' | 'cancelled',
    error: string,
  ) {
    void this.updateRuntime(() => {
      const pending = this.captures.get(resourceId);
      if (!pending || pending.requestId !== requestId || pending.instanceId !== instanceId || pending.generation !== generation)
        return null;
      this.captures.delete(resourceId);
      const w = this.requireWorkspace(pending.workspaceId);
      const receiver = this.session(w, pending.sessionId);
      if (receiver.captureRequest?.requestId !== requestId || receiver.captureRequest.state !== 'pending') return null;
      receiver.captureRequest = { ...receiver.captureRequest, state: kind, error };
      return w;
    });
  }
  private updateRuntime(update: () => WorkspaceSnapshot | null, batch = false) {
    const next = this.queue.then(async () => {
      await this.ready;
      const w = update();
      if (!w) return;
      this.snapshot.seq++;
      if (batch) {
        if (this.emissionTimer === null)
          this.emissionTimer = setTimeout(() => {
            this.emissionTimer = null;
            this.emitSnapshot(w.workspaceId, w.workspaceId);
          }, 50);
      } else {
        await this.repository.save(this.snapshot);
        this.emitSnapshot(w.workspaceId, w.workspaceId);
      }
    });
    this.queue = next.catch((error: unknown) => {
      this.snapshot.storageError = '工作现场保存失败：' + (error as Error).message;
      this.snapshot.seq++;
      this.emitSnapshot(this.snapshot.activeWorkspaceId, this.snapshot.activeWorkspaceId);
    });
    return this.queue;
  }
}
