import { createHash, randomUUID } from 'node:crypto';
import {
  AppSourceSnapshotResultSchema,
  SourceChangeSchema,
  CapturedSourceChangeSchema,
  RunPatchQuerySchema,
  RunPatchResultSchema,
  type AppTarget,
  type RunPatchResult,
  CatalogActionSchema,
  PageResourceSnapshotSchema,
  ResourceBundleSchema,
  type CatalogAction,
  type CatalogReferenceSnapshot,
  type ResourceCatalogState,
  type ResourceRevision,
  type ResourceDescriptor,
  type ChatConversation,
  EnvironmentListSchema,
  ObservationErrorSchema,
  WorkbenchObservationInputSchema,
  ObservationResultSchema,
  validateObservationData,
  type EnvironmentDescription,
  type ObservationRecord,
  type ObservationRequest,
  type ResourceInstanceIdentity,
  type FileInvalidationHint,
  type ObservationTurnScope,
  type ObservationSources,
  type WorkbenchObservationInput,
  type WorkspaceObservationResult,
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
  APP_DATA_RESET_SCOPE,
  type AppControlResult,
} from '@wsl/protocol';
import {
  applyCatalogCommand,
  appendResourceRevision,
  createResourceCatalog,
  freezeCatalogReferences,
  recordAppliedCommand,
} from './resource-catalog';
import { parseResourceCatalog } from './resource-catalog-repository';
import { activateTab, closePane, closeTab, panes, setRatio, splitPane } from './layout';
import type { WorkbenchRepository } from './repository';
import { RunDispatchFailure, type WorkbenchRuntime } from './ports';
import type { AppControl, AppControlContext } from './app-control';
import { AppControlFailure } from './app-control-failure';
import { conflictMessage } from './guest-write-lease';

type SourceRun = { target: AppTarget; baseline: AbortController; ready: boolean; capturing: boolean };
const activeStates = ['starting', 'running', 'cancelling'];
function workspace(workspaceId: string, name: string): WorkspaceSnapshot {
  const paneId = randomUUID();
  return {
    workspaceId,
    name,
    revision: 0,
    app: null,
    tabs: [],
    resources: [],
    layout: { kind: 'pane', paneId, tabId: null },
    activePaneId: paneId,
    sessions: [],
    runs: [],
    fileHints: [],
    observations: [],
    theme: 'system',
  };
}
export function validateSnapshot(snapshot: WorkbenchSnapshot): void {
  const allIds = new Set<string>();
  for (const item of snapshot.workspaces) {
    for (const id of [
      item.workspaceId,
      ...(item.app ? [item.app.appId] : []),
      ...item.tabs.map((t) => t.tabId),
      ...item.resources.map((r) => r.resourceId),
      ...item.sessions.map((s) => s.sessionId),
      ...panes(item.layout).map((p) => p.paneId),
    ]) {
      if (allIds.has(id)) throw new Error('conflict: 持久记录包含重复身份');
      allIds.add(id);
    }
    if (item.managedApp && item.managedApp.workspaceId !== item.workspaceId) throw new Error('denied: 应用运行状态不属于空间');
    if (item.app && (item.app.workspaceId !== item.workspaceId || item.app.projectId !== item.managedApp?.projectId))
      throw new Error('denied: App 描述与空间工程身份不一致');
    const leaves = panes(item.layout);
    if (leaves.length > 4 || !leaves.some((p) => p.paneId === item.activePaneId)) throw new Error('conflict: 持久布局无效');
    const visible = leaves.flatMap((p) => (p.tabId ? [p.tabId] : []));
    if (new Set(visible).size !== visible.length || visible.some((id) => !item.tabs.some((t) => t.tabId === id)))
      throw new Error('conflict: 持久标签显示无效');
    if (item.tabs.some((t) => !item.resources.some((r) => r.resourceId === t.targetRef.resourceId && r.kind === t.targetRef.kind)))
      throw new Error('denied: 标签引用不属于空间');
    if (item.sessions.some((s) => !item.resources.some((r) => r.resourceId === s.resourceId && r.kind === 'session')))
      throw new Error('denied: 会话不属于空间');
    for (const [sessionId, records] of [
      [null, item.observations],
      ...item.sessions.map((session) => [session.sessionId, session.observations]),
    ] as [string | null, ObservationRecord[]][]) {
      for (const record of records) {
        const request = record.request;
        if (
          request.workspaceId !== item.workspaceId ||
          request.sessionId !== sessionId ||
          (request.target && request.target.workspaceId !== item.workspaceId)
        )
          throw new Error('denied: 观察记录归属无效');
        if (sessionId === null && (request.runId !== null || request.target?.kind !== 'file' || !request.tool.startsWith('files.')))
          throw new Error('denied: 无会话观察记录不是文件只读浏览');
        if (request.runId && !item.runs.some((run) => run.runId === request.runId && run.sessionId === sessionId))
          throw new Error('denied: 观察记录执行归属无效');
      }
    }
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
        if (
          version.appTarget &&
          (version.appTarget.workspaceId !== item.workspaceId ||
            version.appTarget.appId !== item.app?.appId ||
            version.appTarget.projectId !== item.app?.projectId ||
            !item.resources.some(
              (resource) => resource.resourceId === version.targetRef?.resourceId && resource.appProjectId === version.appTarget?.projectId,
            ))
        )
          throw new Error('denied: 任务 App 工程与目标不匹配');
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
    environments: [],
    notifications: [],
    notificationReadReceipts: [],
  };
  private queue: Promise<unknown> = Promise.resolve();
  private readonly observations = new Map<string, AbortController>();
  private readonly observationCounts = new Map<string, number>();
  private readonly observationScopes = new Map<string, ObservationTurnScope>();
  private readonly runLaunches = new Map<string, () => Promise<void>>();
  private readonly runLaunchPhases = new Map<string, 'registering' | 'baseline' | 'sending'>();
  private readonly sourceRuns = new Map<string, SourceRun>();
  private readonly projectWriters = new Map<string, string>();
  private readonly runOperations = new Set<Promise<unknown>>();
  private closing = false;
  private readonly terminalLaunches = new Map<string, Promise<TerminalSnapshot>>();
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
  private catalog: ResourceCatalogState = createResourceCatalog(randomUUID());
  private environmentRequest = 0;
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
    return this.getSnapshot();
  }
  private async initialize() {
    const saved = await this.repository.load();
    await this.appControl?.ready();
    const migrateOwnership = this.repository.migrationPending;
    let recoveredExecution = false;
    this.catalog = await this.repository.loadCatalog(saved);
    if (saved)
      for (const binding of this.catalog.migration?.runtimeBindings ?? []) {
        const resource = saved.workspaces
          .find((workspace) => workspace.workspaceId === binding.workspaceId)
          ?.resources.find((resource) => resource.resourceId === binding.runtimeResourceId);
        if (resource && !resource.catalogResourceId) resource.catalogResourceId = binding.catalogResourceId;
      }
    if (saved) {
      validateSnapshot(saved);
      for (const w of saved.workspaces)
        for (const r of w.resources) if (r.kind === 'web' && r.url && !r.appProjectId) this.runtime.validateBrowserUrl(r.url);
      this.snapshot = { ...saved, appInstanceId: this.snapshot.appInstanceId, seq: 0 };
      for (const w of this.snapshot.workspaces) {
        if (w.managedApp) {
          const previous = w.managedApp;
          try {
            if (!this.runtime.appGet) throw new Error('应用恢复查询不可用');
            const restored = await this.runtime.appGet({ workspaceId: w.workspaceId, projectId: previous.projectId });
            if (
              restored.workspaceId !== w.workspaceId ||
              restored.projectId !== previous.projectId ||
              restored.environmentId !== previous.environmentId ||
              restored.url ||
              ['running', 'starting', 'stopping'].includes(restored.state)
            )
              throw new Error('应用恢复身份或状态不匹配');
            w.managedApp = restored;
          } catch (error) {
            w.managedApp = { ...previous, state: 'failed', url: null, cleanupConfirmed: false, error: `应用恢复未确认：${String(error)}` };
          }
        }
        for (const r of w.resources) if (r.appProjectId) r.unavailableReason = '应用服务未启动';
        for (const session of w.sessions) session.historyRestored = Boolean(session.conversation?.messages.length);
        for (const r of w.resources) {
          r.instanceId = null;
          r.preview = null;
          if (r.terminal)
            r.terminal = {
              ...r.terminal,
              sessionId: null,
              state: r.terminal.cleanupPending ? 'failed' : 'closed',
              error: r.terminal.cleanupPending ? '应用重启；旧进程清理未确认，不重放' : '应用重启；终端需明确重新连接',
            };
        }
        for (const s of w.sessions)
          if (s.conversation && activeStates.includes(s.conversation.state))
            s.conversation = {
              ...s.conversation,
              state: w.runs.some((run) => run.sessionId === s.sessionId && this.appControl?.hasPending(w.workspaceId, run.runId))
                ? 'cancelling'
                : 'failed',
              cleanupPending: w.runs.some((run) => run.sessionId === s.sessionId && this.appControl?.hasPending(w.workspaceId, run.runId)),
              error: '应用重启；历史执行已中断',
              threadId: null,
            };
        for (const run of w.runs)
          if (run.sourceChange?.state === 'baseline') {
            run.sourceChange = { state: 'unavailable', reason: '重启前未完成采集' };
            recoveredExecution = true;
          }
        for (const run of w.runs)
          if (activeStates.includes(run.state) || run.sourceCleanupPending) {
            recoveredExecution = true;
            if (
              !run.sourceChange &&
              w.sessions
                .find((session) => session.sessionId === run.sessionId)
                ?.taskVersions.find((version) => version.taskVersionId === run.taskVersionId)?.appTarget
            )
              run.sourceChange = { state: 'unavailable', reason: '重启前未完成采集' };
            run.appCleanupPending = this.appControl?.hasPending(w.workspaceId, run.runId) ?? false;
            run.cleanupRetryAvailable = this.appControl?.canRetryCleanup(run.runId) ?? false;
            const boundProject = w.sessions
              .find((session) => session.sessionId === run.sessionId)
              ?.taskVersions.find((version) => version.taskVersionId === run.taskVersionId)?.appTarget;
            const modelCleanupUnknown =
              !run.executorState || run.executorState.cleanupPending || activeStates.includes(run.executorState.state);
            run.cleanupPending = run.appCleanupPending || Boolean(run.sourceCleanupPending) || Boolean(boundProject && modelCleanupUnknown);
            if (!run.sourceCleanupPending || !['completed', 'failed'].includes(run.state)) {
              run.state = run.cleanupPending ? 'cancelling' : 'interrupted';
              run.endedAt = run.cleanupPending ? null : new Date().toISOString();
            }
            run.error = run.appCleanupPending
              ? modelCleanupUnknown
                ? '应用重启；旧模型进程清理未确认，App 数据操作结果待确认；未重放执行'
                : '应用重启；App 数据操作结果待确认；未重放执行'
              : boundProject && modelCleanupUnknown
                ? '应用重启；旧模型进程清理未确认，项目仍被占用；未重放执行'
                : '应用重启；未重放执行';
            if (run.sourceCleanupPending) run.error += '；源码 helper 清理未确认，未重放采集，项目仍被占用';
            if (run.appCleanupPending) {
              if (run.conversation) run.conversation = { ...run.conversation, state: 'cancelling', cleanupPending: true, error: run.error };
              const session = w.sessions.find((item) => item.sessionId === run.sessionId);
              const binding = run.executionBinding;
              if (
                session &&
                session.conversation &&
                binding &&
                session.conversation.generation === binding.generation &&
                session.conversation.turnId === binding.turnId
              )
                session.conversation = { ...session.conversation, state: 'cancelling', cleanupPending: true, error: run.error };
            }
          }
        for (const record of w.observations)
          if (record.state === 'pending') {
            record.state = 'cancelled';
            record.endedAt = new Date().toISOString();
            record.result = { error: 'cancelled', message: '应用重启；观察未完成，不重放' };
            recoveredExecution = true;
          }
        for (const s of w.sessions) {
          for (const record of s.observations)
            if (record.state === 'pending') {
              record.state = 'cancelled';
              record.endedAt = new Date().toISOString();
              record.result = { error: 'cancelled', message: '应用重启；观察未完成，不重放' };
              recoveredExecution = true;
            }
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
          await this.saveState(this.snapshot);
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
      await this.saveState(this.snapshot);
    }
    if (saved && migrateOwnership && !recoveredExecution) await this.saveState(this.snapshot);
  }
  async getSnapshot(): Promise<WorkbenchSnapshot> {
    await this.ready;
    await this.queue;
    return this.publicSnapshot();
  }
  private publicSnapshot(): WorkbenchSnapshot {
    const snapshot = structuredClone(this.snapshot);
    snapshot.catalog = {
      accountId: this.catalog.accountId,
      revision: this.catalog.revision,
      resources: this.catalog.resources.map((resource) => ({
        ...resource,
        versions: this.catalog.revisions
          .filter((revision) => revision.resourceId === resource.resourceId)
          .map((revision) => revision.version),
        latestVersion: Math.max(
          0,
          ...this.catalog.revisions.filter((revision) => revision.resourceId === resource.resourceId).map((revision) => revision.version),
        ),
      })),
      library: structuredClone(this.catalog.library),
      links: structuredClone(this.catalog.links),
    };
    for (const workspace of snapshot.workspaces)
      for (const run of workspace.runs) {
        if (run.referenceSnapshot)
          run.referenceSummary = run.referenceSnapshot.resources.map(({ resourceId, version, contentSha256 }) => ({
            resourceId,
            version,
            contentSha256,
          }));
        delete run.referenceSnapshot;
      }
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
    if (command.type === 'reconcileRunCleanup') return this.reconcileRunCleanup(command.workspaceId, command.runId);
    if (command.type === 'answerPermission') return this.answerPermission(command);
    if (command.type === 'createApp' || command.type === 'startApp' || command.type === 'stopApp' || command.type === 'exportApp')
      return this.appCommand(command);
    if (
      command.type === 'startRun' ||
      command.type === 'terminalOpen' ||
      (command.type === 'createTab' && ['file', 'terminal', 'ssh'].includes(command.kind))
    )
      return this.environments().then(() => this.enqueueCommand(command));
    return this.enqueueCommand(command);
  }
  async onApp(app: NonNullable<WorkspaceSnapshot['managedApp']>) {
    await this.serialize(async () => {
      if (this.appOperations.has(app.workspaceId)) {
        if (app.state === 'failed') this.pendingAppFailures.set(app.workspaceId, app);
        return;
      }
      const w = this.snapshot.workspaces.find((w) => w.workspaceId === app.workspaceId);
      if (!w?.managedApp || w.managedApp.projectId !== app.projectId || w.managedApp.appInstanceId !== app.appInstanceId) return;
      w.managedApp = app;
      if (app.cleanupConfirmed && app.state === 'stopped')
        await this.appControl?.confirmStopped(w.workspaceId, app.projectId, app.appInstanceId);
      if (app.state !== 'running')
        for (const r of w.resources.filter((r) => r.appProjectId === app.projectId)) {
          r.preview = null;
          r.instanceId = null;
          r.generation++;
          r.unavailableReason = app.error ?? '应用服务已停止';
        }
      await this.persist(w, app.projectId);
    });
  }
  private readonly pendingAppFailures = new Map<string, NonNullable<WorkspaceSnapshot['managedApp']>>();
  private readonly appOperations = new Map<string, string>();
  private readonly appCommands = new Map<string, { fingerprint: string; promise: Promise<WorkbenchResult> }>();
  private appCommand(
    c: Extract<WorkbenchCommand, { type: 'createApp' | 'startApp' | 'stopApp' | 'exportApp' }>,
    activateApp = true,
  ): Promise<WorkbenchResult> {
    const fingerprint = createHash('sha256').update(JSON.stringify(c)).digest('hex');
    const previous = this.appCommands.get(c.commandId);
    if (previous)
      return previous.fingerprint === fingerprint
        ? previous.promise.then((result) => ({ ...result, snapshot: this.publicSnapshot() }))
        : Promise.resolve({
            ok: false,
            error: { code: 'conflict', message: '同一命令身份不能用于不同内容' },
            snapshot: this.publicSnapshot(),
          });
    if (this.commands.has(c.commandId))
      return Promise.resolve({ ok: false, error: { code: 'conflict', message: '命令身份已使用' }, snapshot: this.publicSnapshot() });
    const promise = this.executeAppCommand(c, activateApp);
    this.appCommands.set(c.commandId, { fingerprint, promise });
    return promise;
  }
  private async executeAppCommand(
    c: Extract<WorkbenchCommand, { type: 'createApp' | 'startApp' | 'stopApp' | 'exportApp' }>,
    activateApp: boolean,
  ): Promise<WorkbenchResult> {
    await this.appControl?.ready();
    let invoked = false;
    let target: { workspaceId: string; projectId: string } | undefined;
    try {
      await this.serialize(async () => {
        const w = this.requireWorkspace(c.workspaceId);
        if (c.expectedRevision !== undefined && c.expectedRevision !== w.revision) throw new Error('conflict: 空间已有较新修改');
        const appBefore = structuredClone(w.managedApp ?? null);
        if (c.type !== 'stopApp' && this.appControl?.hasPending(w.workspaceId)) throw new Error('conflict: App 数据操作结果待确认');
        const writerId = w.managedApp ? this.projectWriters.get(w.managedApp.projectId) : undefined;
        const sourceOwner = writerId ? this.sourceRuns.get(writerId) : undefined;
        if (
          c.type === 'startApp' &&
          ((sourceOwner && (!sourceOwner.ready || sourceOwner.capturing)) ||
            w.runs.some((run) => run.sourceCleanupPending || (run.cleanupPending && !this.runLogBaselines.has(run.runId))))
        )
          throw new Error('conflict: 项目源码采集或 helper 清理未确认，暂不能启动写入工程的构建');
        const pending = this.appOperations.get(w.workspaceId);
        if (pending && c.type !== 'stopApp') throw new Error('conflict: 应用操作正在进行');
        if (c.type === 'createApp') {
          if (w.managedApp) throw new Error('conflict: 空间已绑定标准应用');
          if (!this.runtime.appCreate) throw new Error('unsupported: 标准应用服务未配置');
          const projectId = randomUUID();
          w.app = {
            appId: randomUUID(),
            workspaceId: w.workspaceId,
            projectId,
            name: c.name ?? '标准应用',
            description: c.description ?? '',
            revision: 0,
          };
          w.managedApp = {
            workspaceId: w.workspaceId,
            projectId,
            environmentId: 'sandbox',
            appInstanceId: null,
            state: 'starting',
            url: null,
            guestCwd: '',
            error: null,
            cleanupConfirmed: false,
          };
        }
        if (!w.managedApp) throw new Error('not_found: 请先创建标准应用');
        target = { workspaceId: w.workspaceId, projectId: w.managedApp.projectId };
        if (c.type === 'startApp' && ['starting', 'running', 'stopping'].includes(w.managedApp.state))
          throw new Error('conflict: 应用已启动或正在操作');
        if (c.type !== 'exportApp') {
          w.managedApp.state = c.type === 'stopApp' ? 'stopping' : 'starting';
          w.managedApp.error = null;
          for (const resource of w.resources.filter((r) => r.appProjectId === target!.projectId)) {
            this.runtime.releaseAppBrowser?.(resource.resourceId);
            resource.instanceId = null;
            resource.preview = null;
            resource.generation++;
            resource.unavailableReason = '应用服务正在操作';
          }
        }
        this.appOperations.set(w.workspaceId, c.commandId);
        try {
          await this.persist(w, target.projectId);
        } catch (error) {
          if (c.type === 'createApp') w.app = null;
          w.managedApp = appBefore;
          this.appOperations.delete(w.workspaceId);
          throw error;
        }
      });
      if (!target) throw new Error('not_found: 应用身份缺失');
      invoked = true;
      const result =
        c.type === 'createApp'
          ? await this.runtime.appCreate!(target)
          : c.type === 'startApp'
            ? await this.runtime.appStart!(target)
            : c.type === 'stopApp'
              ? await this.runtime.appStop!(target)
              : await this.runtime.appExport!(target);
      await this.serialize(async () => {
        if (this.appOperations.get(c.workspaceId) !== c.commandId) return;
        const w = this.requireWorkspace(c.workspaceId);
        if (c.type === 'exportApp') w.appExport = result as { path: string; manifestPath?: string; sha256: string };
        else {
          let app = result as NonNullable<WorkspaceSnapshot['managedApp']>;
          const interrupted = this.pendingAppFailures.get(c.workspaceId);
          this.pendingAppFailures.delete(c.workspaceId);
          if (app.state === 'running' && interrupted?.appInstanceId === app.appInstanceId && interrupted.projectId === app.projectId)
            app = interrupted;
          if (app.workspaceId !== w.workspaceId || app.projectId !== target!.projectId) throw new Error('denied: 应用返回身份不一致');
          w.managedApp = app;
          if (app.cleanupConfirmed && app.state === 'stopped')
            await this.appControl?.confirmStopped(w.workspaceId, app.projectId, app.appInstanceId);
          if (app.state === 'running' && app.url) {
            let resource = w.resources.find((r) => r.appProjectId === app.projectId);
            if (!resource) {
              const tab = this.createResource(w, 'web', w.app?.name ?? '标准应用', app.url, 'sandbox');
              resource = this.resource(w, tab.targetRef.resourceId);
              resource.appProjectId = app.projectId;
            }
            resource.url = app.url;
            resource.unavailableReason = null;
            if (activateApp) this.openResource(w, resource.resourceId);
            // AI restarts need a live browser without changing the user's current or intervening navigation.
            else this.ensureBrowser(w, resource);
          }
        }
        this.appOperations.delete(c.workspaceId);
        await this.persist(w, target!.projectId);
      });
      const current = this.requireWorkspace(c.workspaceId).managedApp;
      if (c.type === 'createApp' && current?.state === 'failed')
        return {
          ok: false,
          error: { code: 'execution_failed', message: current.error ?? '创建应用失败；工程身份已保留，请核对后重试启动' },
          snapshot: this.publicSnapshot(),
        };
      return this.result();
    } catch (error) {
      await this.serialize(async () => {
        if (!invoked || this.appOperations.get(c.workspaceId) !== c.commandId) return;
        const w = this.requireWorkspace(c.workspaceId);
        if (w.managedApp) {
          w.managedApp.state = 'failed';
          w.managedApp.error = (error as Error).message;
        }
        this.appOperations.delete(c.workspaceId);
        await this.persist(w, target?.projectId ?? w.workspaceId);
      });
      const message = (error as Error).message;
      const prefix = message.split(':')[0];
      const code =
        prefix === 'conflict' || prefix === 'denied' || prefix === 'not_found' || prefix === 'unsupported' ? prefix : 'execution_failed';
      return { ok: false, error: { code, message }, snapshot: this.publicSnapshot() };
    }
  }
  private enqueueCommand(command: WorkbenchCommand): Promise<WorkbenchResult> {
    const next = this.queue.then(async () => {
      await this.ready;
      return this.execute(command);
    });
    this.queue = next.then(
      () => undefined,
      () => undefined,
    );
    return next.then(async (result) => {
      const launch = this.runLaunches.get(command.commandId);
      if (!launch) return result;
      this.runLaunches.delete(command.commandId);
      const operation = launch();
      this.trackRunOperation(operation);
      await operation;
      return { ...result, snapshot: this.publicSnapshot() };
    });
  }
  private serialize<T>(work: () => T | Promise<T>): Promise<T> {
    const next = this.queue.then(async () => {
      await this.ready;
      return work();
    });
    this.queue = next.then(
      () => undefined,
      () => undefined,
    );
    return next;
  }
  async environments(): Promise<EnvironmentDescription[]> {
    const request = ++this.environmentRequest;
    const environments = EnvironmentListSchema.parse(await this.runtime.environmentsList());
    await this.serialize(() => {
      if (request !== this.environmentRequest) return;
      this.snapshot.environments = environments;
      this.snapshot.seq++;
      this.emitSnapshot(this.snapshot.activeWorkspaceId, this.snapshot.activeWorkspaceId);
    });
    return structuredClone(environments);
  }
  async onChatStatus(): Promise<void> {
    const request = this.environmentRequest + 1;
    try {
      await this.environments();
    } catch (error) {
      const reason = `执行环境查询失败：${error instanceof Error ? error.message : String(error)}`;
      await this.serialize(() => {
        if (request !== this.environmentRequest) return;
        this.snapshot.environments = this.snapshot.environments.map((environment) => ({
          ...environment,
          state: 'unavailable',
          reason,
          capabilities: { browser: environment.capabilities.browser, files: false, terminal: false },
        }));
        this.snapshot.seq++;
        this.emitSnapshot(this.snapshot.activeWorkspaceId, this.snapshot.activeWorkspaceId);
      });
    }
  }
  private observationRecords(workspace: WorkspaceSnapshot, sessionId: string | null) {
    return sessionId === null ? workspace.observations : this.session(workspace, sessionId).observations;
  }
  private instance(workspace: WorkspaceSnapshot, resource: WorkbenchResource): ResourceInstanceIdentity {
    if (!resource.environmentId || !resource.instanceId) throw new Error('unavailable: 资源没有已授权实例');
    return {
      workspaceId: workspace.workspaceId,
      environmentId: resource.environmentId,
      resourceId: resource.resourceId,
      kind: resource.kind === 'web' ? 'browser' : resource.kind === 'file' ? 'file' : 'terminal',
      instanceId: resource.instanceId,
      instanceGeneration: resource.generation,
    };
  }
  private fileInstance(resource: WorkbenchResource) {
    if (resource.kind === 'file' && resource.environmentId && !resource.instanceId) {
      resource.instanceId = randomUUID();
      resource.generation++;
    }
  }
  private sources(workspace: WorkspaceSnapshot): ObservationSources {
    const resources = workspace.resources.filter((resource) => resource.kind !== 'session');
    if (resources.length > 500) throw new Error('budget_exceeded: 空间资源数量超过来源枚举预算');
    return {
      kind: 'sources',
      workspaceId: workspace.workspaceId,
      sources: resources.map((resource) => {
        const environment = this.snapshot.environments.find((environment) => environment.environmentId === resource.environmentId);
        const kind = resource.kind === 'web' ? 'browser' : resource.kind === 'file' ? 'file' : 'terminal';
        const allowed =
          kind === 'browser'
            ? environment?.capabilities.browser
            : kind === 'file'
              ? environment?.capabilities.files
              : environment?.capabilities.terminal;
        return {
          resource: { workspaceId: workspace.workspaceId, environmentId: resource.environmentId, resourceId: resource.resourceId, kind },
          instance: resource.instanceId && resource.environmentId ? this.instance(workspace, resource) : null,
          title: resource.title,
          capabilities: !allowed
            ? []
            : kind === 'browser'
              ? ['browser.snapshot', 'browser.query', 'browser.screenshot', 'browser.read_events']
              : kind === 'file'
                ? ['files.list', 'files.search', 'files.read']
                : ['terminal.read_screen', 'terminal.read_output', 'terminal.read_command'],
          state: !allowed ? 'unavailable' : resource.instanceId ? 'live' : 'closed',
          reason: !allowed
            ? (resource.unavailableReason ?? environment?.reason ?? '环境未配置')
            : resource.instanceId
              ? null
              : '实例未打开',
        };
      }),
    };
  }
  async observe(input: WorkbenchObservationInput, signal?: AbortSignal): Promise<WorkspaceObservationResult> {
    const parsed = WorkbenchObservationInputSchema.safeParse(input);
    if (!parsed.success) return { error: 'invalid_request', message: '观察输入无效或超过预算' };
    input = parsed.data;
    await this.ready;
    const controller = new AbortController();
    let settled = false;
    const externalAbort = () => {
      if (!settled) controller.abort();
    };
    signal?.addEventListener('abort', externalAbort, { once: true });
    if (signal?.aborted) controller.abort();
    let request: ObservationRequest;
    let record: ObservationRecord;
    let listing: ObservationSources | null = null;
    let browser: WorkbenchResource | null = null;
    try {
      await this.serialize(async () => {
        const before = structuredClone(this.snapshot);
        const workspace = this.requireWorkspace(input.workspaceId);
        const records = this.observationRecords(workspace, input.sessionId);
        if (input.sessionId === null && (input.runId !== null || !input.tool.startsWith('files.')))
          throw new Error('unauthorized: 无会话请求仅允许文件标签只读浏览');
        if (this.observations.size >= 4 || (input.runId && (this.observationCounts.get(input.runId) ?? 0) >= 64))
          throw new Error('budget_exceeded: 观察并发或历史预算已用完');
        if (
          this.snapshot.workspaces.some((workspace) =>
            [workspace.observations, ...workspace.sessions.map((session) => session.observations)].some((records) =>
              records.some((record) => record.request.requestId === input.requestId),
            ),
          )
        )
          throw new Error('invalid_request: 观察请求身份重复');
        const scope = input.runId ? this.observationScopes.get(input.runId) : null;
        if (
          input.runId &&
          (!scope ||
            scope.workspaceId !== workspace.workspaceId ||
            scope.sessionId !== input.sessionId ||
            !activeStates.includes(this.run(workspace, input.runId).state) ||
            this.run(workspace, input.runId).state === 'cancelling')
        )
          throw new Error('unauthorized: 执行观察归属失效');
        let target: ResourceInstanceIdentity | null = null;
        const { environmentId, ...args } = input.args;
        if (input.tool === 'workspace.list_sources') {
          if (input.resourceId !== null || Object.keys(args).length || environmentId !== undefined)
            throw new Error('invalid_request: 来源列表不接受资源或权限参数');
          listing = scope
            ? { kind: 'sources', workspaceId: scope.workspaceId, sources: structuredClone(scope.sources) }
            : this.sources(workspace);
        } else {
          if (!input.resourceId) throw new Error('invalid_request: 请显式选择资源');
          const resource = this.resource(workspace, input.resourceId);
          if (input.sessionId === null && resource.kind !== 'file') throw new Error('unauthorized: 无会话请求不允许此资源');
          if (!resource.environmentId || resource.kind === 'session') throw new Error('unavailable: 资源没有授权环境');
          if (environmentId !== undefined && environmentId !== resource.environmentId) throw new Error('unauthorized: 环境不属于资源');
          const toolPrefix = resource.kind === 'web' ? 'browser.' : resource.kind === 'file' ? 'files.' : 'terminal.';
          if (!input.tool.startsWith(toolPrefix)) throw new Error('unsupported: 工具与资源类型不匹配');
          if (scope) {
            const frozen = scope.sources.find((source) => source.resource.resourceId === resource.resourceId)?.instance;
            if (!frozen || resource.instanceId !== frozen.instanceId || resource.generation !== frozen.instanceGeneration)
              throw new Error('unavailable: 执行冻结的资源实例已失效');
          } else if (resource.kind === 'web' && !resource.instanceId) {
            browser = { ...structuredClone(resource), instanceId: randomUUID(), generation: resource.generation + 1 };
          } else this.fileInstance(resource);
          target = this.instance(workspace, browser ?? resource);
          if (environmentId !== undefined && environmentId !== target.environmentId) throw new Error('unauthorized: 环境不属于资源');
          if (!input.tool.startsWith(target.kind === 'browser' ? 'browser.' : target.kind === 'file' ? 'files.' : 'terminal.'))
            throw new Error('unsupported: 工具与资源类型不匹配');
        }
        request = {
          requestId: input.requestId,
          workspaceId: workspace.workspaceId,
          sessionId: input.sessionId,
          runId: input.runId,
          target,
          tool: input.tool,
          args,
        };
        record = {
          request: structuredClone(request),
          state: 'pending',
          startedAt: new Date().toISOString(),
          endedAt: null,
          result: null,
          evidenceRef: null,
        };
        if (records.length >= 200) {
          const old = records.findIndex((record) => record.state !== 'pending' && !this.observations.has(record.request.requestId));
          if (old < 0) throw new Error('budget_exceeded: 历史窗口中观察均未结束');
          records.splice(old, 1);
        }
        records.push(record);
        this.observations.set(request.requestId, controller);
        try {
          await this.saveState(this.snapshot);
        } catch (error) {
          this.snapshot = before;
          this.snapshot.storageError = '观察请求保存失败：' + (error as Error).message;
          throw error;
        }
        if (input.runId) this.observationCounts.set(input.runId, (this.observationCounts.get(input.runId) ?? 0) + 1);
        this.emitSnapshot(workspace.workspaceId, request.requestId);
      });
    } catch (error) {
      if (this.observations.get(input.requestId) === controller) this.observations.delete(input.requestId);
      signal?.removeEventListener('abort', externalAbort);
      return this.observationFailure(error);
    }
    let timedOut = false;
    let abort!: () => void;
    const cancelled = new Promise<WorkspaceObservationResult>((resolve) => {
      abort = () => resolve(timedOut ? { error: 'timeout', message: '观察超时' } : { error: 'cancelled', message: '观察已取消' });
      controller.signal.addEventListener('abort', abort, { once: true });
      if (controller.signal.aborted) abort();
    });
    const timer = setTimeout(() => {
      timedOut = true;
      controller.abort();
    }, 10000);
    let result: WorkspaceObservationResult;
    try {
      const read = async () => {
        if (controller.signal.aborted) return { error: 'cancelled' as const, message: '观察已取消' };
        // Freeze and persist ownership before discovery so preflight is cancellable too.
        const environments = await this.environments();
        if (controller.signal.aborted) return { error: 'cancelled' as const, message: '观察已取消' };
        if (listing) {
          if (!request!.runId)
            listing.sources = listing.sources.map((source) => {
              const environment = environments.find((environment) => environment.environmentId === source.resource.environmentId);
              const capability = source.resource.kind === 'browser' ? 'browser' : source.resource.kind === 'file' ? 'files' : 'terminal';
              const allowed = !!environment?.capabilities[capability];
              return {
                ...source,
                capabilities: allowed
                  ? source.resource.kind === 'browser'
                    ? ['browser.snapshot', 'browser.query', 'browser.screenshot', 'browser.read_events']
                    : source.resource.kind === 'file'
                      ? ['files.list', 'files.search', 'files.read']
                      : ['terminal.read_screen', 'terminal.read_output', 'terminal.read_command']
                  : [],
                state: allowed ? (source.instance ? ('live' as const) : ('closed' as const)) : ('unavailable' as const),
                reason: allowed ? (source.instance ? null : '实例未打开') : (environment?.reason ?? '环境未配置'),
              };
            });
          return listing;
        }
        await this.serialize(() => {
          const resource = this.resource(this.requireWorkspace(request!.workspaceId), request!.target!.resourceId);
          const unchanged = browser
            ? resource.instanceId === null && resource.generation === browser.generation - 1
            : resource.instanceId === request!.target!.instanceId && resource.generation === request!.target!.instanceGeneration;
          if (!unchanged) throw new Error('unavailable: 观察预处理期间资源实例已更换');
          const environment = environments.find((environment) => environment.environmentId === request!.target!.environmentId);
          const capability = request!.target!.kind === 'browser' ? 'browser' : request!.target!.kind === 'file' ? 'files' : 'terminal';
          if (!environment?.capabilities[capability]) throw new Error('unavailable: 资源环境未配置此能力');
          if (browser && !controller.signal.aborted) {
            this.runtime.ensureBrowser(request!.workspaceId, browser);
            resource.preview = this.runtime.browserState(resource.resourceId);
            resource.instanceId = browser.instanceId;
            resource.generation = browser.generation;
          }
        });
        if (controller.signal.aborted) return { error: 'cancelled' as const, message: '观察已取消' };
        const result = ObservationResultSchema.parse(await this.runtime.observe(request!, controller.signal));
        if (!('error' in result)) {
          validateObservationData(result);
          if (
            (Object.keys(request!.target!) as (keyof ResourceInstanceIdentity)[]).some(
              (key) => result.resource[key] !== request!.target![key],
            )
          )
            throw new Error('unauthorized: Provider结果不属于冻结资源实例');
        }
        return result;
      };
      result = await Promise.race([read(), cancelled]);
    } catch (error) {
      result = this.observationFailure(error);
    } finally {
      clearTimeout(timer);
      controller.signal.removeEventListener('abort', abort);
    }
    await this.serialize(() => {
      const workspace = this.requireWorkspace(request!.workspaceId);
      record = this.observationRecords(workspace, request!.sessionId).find((record) => record.request.requestId === request!.requestId)!;
      if (!record) throw new Error('观察记录身份丢失');
      const resource = request!.target ? this.resource(workspace, request!.target.resourceId) : null;
      if (controller.signal.aborted || record!.state === 'cancelled')
        result = timedOut ? { error: 'timeout', message: '观察超时' } : { error: 'cancelled', message: '观察已取消' };
      else if (
        resource &&
        !('error' in result) &&
        (resource.instanceId !== request!.target!.instanceId || resource.generation !== request!.target!.instanceGeneration)
      )
        result = { error: 'unavailable', message: '观察期间资源实例已更换' };
      else if (request!.runId && !['starting', 'running'].includes(this.run(workspace, request!.runId).state))
        result = { error: 'cancelled', message: '执行观察已结束' };
      record!.state = 'error' in result ? (result.error === 'cancelled' ? 'cancelled' : 'failed') : 'completed';
      record!.endedAt = new Date().toISOString();
      record!.result = structuredClone(result);
      settled = true;
      signal?.removeEventListener('abort', externalAbort);
    });
    try {
      const ref = await this.repository.appendObservation(structuredClone(record!));
      await this.serialize(async () => {
        record = this.observationRecords(this.requireWorkspace(request!.workspaceId), request!.sessionId).find(
          (record) => record.request.requestId === request!.requestId,
        )!;
        if (!record) throw new Error('观察记录身份丢失');
        record!.evidenceRef = ref;
        if (!('error' in result) && 'resource' in result) result = { ...result, evidenceRef: ref };
        record!.result = structuredClone(result);
        await this.saveState(this.snapshot);
        this.emitSnapshot(request!.workspaceId, request!.requestId);
      });
    } catch (error) {
      result = { error: 'unavailable', message: '观察证据保存失败：' + (error as Error).message };
      await this.serialize(() => {
        record = this.observationRecords(this.requireWorkspace(request!.workspaceId), request!.sessionId).find(
          (record) => record.request.requestId === request!.requestId,
        )!;
        record.state = 'failed';
        record.result = structuredClone(result);
        this.snapshot.storageError = '观察证据保存失败：' + (error as Error).message;
        this.emitSnapshot(request!.workspaceId, request!.requestId);
      });
    } finally {
      this.observations.delete(input.requestId);
      signal?.removeEventListener('abort', externalAbort);
    }
    return result;
  }
  async observeForTurn(
    scope: ObservationTurnScope,
    tool: string,
    args: Record<string, unknown>,
    signal: AbortSignal,
  ): Promise<WorkspaceObservationResult> {
    const frozen = this.observationScopes.get(scope.runId);
    if (!scope.sessionId || !scope.runId || !frozen || frozen.workspaceId !== scope.workspaceId || frozen.sessionId !== scope.sessionId)
      return { error: 'unauthorized', message: 'MCP缺少有效会话与运行归属' };
    const { resourceId, ...readArgs } = args;
    const parsed = WorkbenchObservationInputSchema.safeParse({
      requestId: randomUUID(),
      workspaceId: frozen.workspaceId,
      sessionId: frozen.sessionId,
      runId: frozen.runId,
      resourceId: resourceId ?? null,
      tool,
      args: readArgs,
    });
    if (!parsed.success) return { error: 'invalid_request', message: 'MCP观察参数无效或超过预算' };
    return this.observe(parsed.data, signal);
  }
  private appControl: AppControl | null = null;
  /** 由装配入口注入唯一控制面 dispatcher；应用只提供冻结授权事实并在 run 结束时释放。 */
  setAppControl(control: AppControl) {
    this.appControl = control;
  }
  /** 控制面授权上下文：冻结 scope 必须属于仍在执行（非 cancelling）的 run。 */
  async appControlContext(scope: ObservationTurnScope): Promise<AppControlContext> {
    return this.serialize(() => {
      const frozen = this.observationScopes.get(scope.runId);
      if (!frozen || frozen.workspaceId !== scope.workspaceId || frozen.sessionId !== scope.sessionId)
        throw new AppControlFailure('no_active_run', '控制面缺少有效的会话与运行归属');
      const workspace = this.requireWorkspace(frozen.workspaceId);
      const run = workspace.runs.find((candidate) => candidate.runId === frozen.runId);
      if (!run || !activeStates.includes(run.state) || run.state === 'cancelling')
        throw new AppControlFailure('no_active_run', '执行已结束或正在取消，控制面不可用');
      const executionBinding = run.executionBinding ?? this.runTurns.get(run.runId);
      if (!executionBinding) throw new AppControlFailure('no_active_run', '执行缺少原会话轮次归属');
      const version = workspace.sessions
        .find((session) => session.sessionId === run.sessionId)
        ?.taskVersions.find((candidate) => candidate.taskVersionId === run.taskVersionId);
      const app = workspace.managedApp ?? null;
      const browser = app
        ? workspace.resources.find((resource) => resource.kind === 'web' && resource.appProjectId === app.projectId)
        : undefined;
      return {
        workspaceId: workspace.workspaceId,
        sessionId: run.sessionId,
        runId: run.runId,
        executionBinding,
        allowsReset: !!version?.allowedScopes.includes(APP_DATA_RESET_SCOPE),
        app: app
          ? {
              projectId: app.projectId,
              appInstanceId: app.appInstanceId,
              state: app.state,
              url: app.url,
              cleanupConfirmed: app.cleanupConfirmed,
              error: app.error,
            }
          : null,
        browser: browser ? { resourceId: browser.resourceId, instanceId: browser.instanceId, generation: browser.generation } : null,
      };
    });
  }
  async appControlForTurn(
    scope: ObservationTurnScope,
    tool: string,
    args: Record<string, unknown>,
    signal: AbortSignal,
  ): Promise<AppControlResult> {
    if (!this.appControl) return { ok: false, tool: null, error: { code: 'unsupported', message: '控制面未接入' } };
    return this.appControl.call(scope, tool, args, signal);
  }
  /** app.restart：仅当目标仍是请求时的实例才停止并按当前源码重新启动；完成情况经 app.status 查询。 */
  restartAppForControl(workspaceId: string, appInstanceId: string) {
    if (this.appControl?.hasPending(workspaceId)) throw new AppControlFailure('app_busy', 'App 数据操作结果待确认');
    void (async () => {
      const current = this.snapshot.workspaces.find((workspace) => workspace.workspaceId === workspaceId)?.managedApp;
      if (current?.appInstanceId !== appInstanceId) return;
      const stopped = await this.command({ type: 'stopApp', commandId: randomUUID(), workspaceId });
      if (stopped.ok) await this.appCommand({ type: 'startApp', commandId: randomUUID(), workspaceId }, false);
    })().catch((error: unknown) => console.error('控制面重启应用失败', error));
  }
  private observationFailure(error: unknown): WorkspaceObservationResult {
    const message = error instanceof Error ? error.message : String(error);
    const prefix = message.split(':')[0];
    const mapped = prefix === 'denied' ? 'unauthorized' : prefix === 'invalid_input' ? 'invalid_request' : prefix;
    const code = ObservationErrorSchema.shape.error.safeParse(mapped);
    return { error: code.success ? code.data : 'unavailable', message };
  }
  onFileHint(hint: FileInvalidationHint) {
    void this.updateRuntime(() => {
      const workspace = this.snapshot.workspaces.find((workspace) => workspace.workspaceId === hint.workspaceId);
      const resource = workspace?.resources.find((resource) => resource.resourceId === hint.resourceId);
      if (
        !workspace ||
        !resource ||
        resource.instanceId !== hint.instanceId ||
        resource.generation !== hint.instanceGeneration ||
        resource.environmentId !== hint.environmentId
      )
        return null;
      const previous = workspace.fileHints.find((previous) => previous.resourceId === hint.resourceId);
      if (previous && previous.watchGeneration === hint.watchGeneration && previous.sequence >= hint.sequence) return null;
      workspace.fileHints = [hint, ...workspace.fileHints.filter((previous) => previous.resourceId !== hint.resourceId)].slice(0, 100);
      return workspace;
    });
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
  private createResource(
    w: WorkspaceSnapshot,
    kind: WorkbenchResource['kind'],
    title: string,
    url?: string,
    environmentId: WorkbenchResource['environmentId'] = kind === 'web' ? 'local' : kind === 'terminal' ? 'sandbox' : null,
  ) {
    const resourceId = randomUUID();
    const r: WorkbenchResource = {
      resourceId,
      environmentId,
      kind,
      title,
      url: url ?? null,
      instanceId: null,
      generation: 0,
      preview: null,
      terminal: null,
      unavailableReason: ['ssh', 'file'].includes(kind) && !environmentId ? '资源未绑定授权环境' : null,
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
        observations: [],
        context: null,
        captureRequest: null,
        contextTarget: null,
        taskTargetRef: null,
        taskAcceptance: [],
        taskAllowedScopes: [],
        contextApplicability: 'unknown',
        taskVersions: [],
        harnessSelection: null,
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
  private descriptor(resource: WorkbenchResource): ResourceDescriptor {
    if (resource.appProjectId)
      return {
        kind: 'development',
        entryKind: 'project',
        environmentId: resource.environmentId,
        projectId: resource.appProjectId,
        path: null,
      };
    if (resource.kind === 'web') {
      if (!resource.url) throw new Error('invalid_input: 网页资源缺少 URL');
      return { kind: 'web', url: new URL(resource.url).href };
    }
    if (resource.kind === 'file') return { kind: 'document', environmentId: resource.environmentId, path: resource.url };
    if (resource.kind === 'session') throw new Error('invalid_input: 会话不能收藏');
    return { kind: 'development', entryKind: resource.kind, environmentId: resource.environmentId, projectId: null, path: null };
  }
  private materializeCurrentPage(workspaceId: string, runtime: WorkbenchResource, url: string): void {
    if (runtime.kind !== 'web' || runtime.appProjectId) return;
    const existing = this.catalog.resources.find((resource) => resource.resourceId === runtime.catalogResourceId);
    if (existing?.descriptor.kind === 'web' && existing.descriptor.url === url) return;
    const resourceId = randomUUID(),
      now = new Date().toISOString();
    this.catalog = structuredClone(this.catalog);
    this.catalog.resources.push({
      resourceId,
      ownerAccountId: this.catalog.accountId,
      title: runtime.preview?.page.title || runtime.title,
      descriptor: { kind: 'web', url },
      createdAt: now,
    });
    this.catalog.links.push({ workspaceId, resourceId, connectedAt: now, referenceVersion: null });
    runtime.catalogResourceId = resourceId;
    this.catalog.revision++;
  }
  private syncCatalogBindings(snapshot: WorkbenchSnapshot): void {
    for (const workspace of snapshot.workspaces)
      for (const resource of workspace.resources) {
        if (resource.kind === 'session') continue;
        if (!resource.catalogResourceId) {
          const resourceId = randomUUID();
          const now = new Date().toISOString();
          this.catalog.resources.push({
            resourceId,
            ownerAccountId: this.catalog.accountId,
            title: resource.title,
            descriptor: this.descriptor(resource),
            createdAt: now,
          });
          this.catalog.links.push({ resourceId, workspaceId: workspace.workspaceId, connectedAt: now, referenceVersion: null });
          resource.catalogResourceId = resourceId;
          this.catalog.revision++;
        }
      }
  }
  private async saveState(snapshot: WorkbenchSnapshot): Promise<void> {
    this.syncCatalogBindings(snapshot);
    await this.repository.save(snapshot, this.catalog);
  }
  private catalogContext() {
    return {
      accountId: this.catalog.accountId,
      now: new Date().toISOString(),
      workspaceIds: this.snapshot.workspaces.map((workspace) => workspace.workspaceId),
      dependencies: this.snapshot.workspaces
        .flatMap((workspace) =>
          workspace.resources.flatMap((resource) => {
            if (!resource.catalogResourceId) return [];
            const dependency = { workspaceId: workspace.workspaceId, resourceId: resource.catalogResourceId };
            return [
              ...(resource.instanceId ? [{ ...dependency, kind: 'instance' as const }] : []),
              ...(workspace.tabs.some((tab) => tab.targetRef.resourceId === resource.resourceId)
                ? [{ ...dependency, kind: 'tab' as const }]
                : []),
              ...(workspace.runs.some(
                (run) =>
                  activeStates.includes(run.state) &&
                  (run.targetRef?.resourceId === resource.resourceId ||
                    run.referenceSnapshot?.resources.some((revision) => revision.resourceId === resource.catalogResourceId)),
              )
                ? [{ ...dependency, kind: 'turn' as const }]
                : []),
            ];
          }),
        )
        .concat(
          this.snapshot.workspaces.flatMap((workspace) =>
            workspace.runs
              .filter((run) => activeStates.includes(run.state))
              .flatMap((run) =>
                (run.referenceSnapshot?.resources ?? []).map((revision) => ({
                  workspaceId: workspace.workspaceId,
                  resourceId: revision.resourceId,
                  kind: 'turn' as const,
                })),
              ),
          ),
        ),
    };
  }
  /** Task targets, captured context and frozen history keep their runtime binding; removing it would orphan durable records. */
  private assertUnreferencedBinding(workspace: WorkspaceSnapshot, resourceId: string): void {
    const sessionTarget = workspace.sessions.some(
      (session) =>
        session.taskTargetRef?.resourceId === resourceId ||
        session.contextTarget?.resourceId === resourceId ||
        session.captureRequest?.resourceId === resourceId,
    );
    if (sessionTarget) throw new Error('conflict: 会话任务目标或页面采集记录仍引用该资源，请先在会话中改选目标或采集其他页面后再移除');
    const history =
      workspace.sessions.some((session) => session.taskVersions.some((version) => version.targetRef?.resourceId === resourceId)) ||
      workspace.runs.some((run) => run.targetRef?.resourceId === resourceId);
    if (history) throw new Error('conflict: 已确认的任务版本或执行记录引用该资源；为保留任务记录，不能从空间移除');
  }
  async catalogRevision(resourceId: string, version: number): Promise<ResourceRevision> {
    await this.ready;
    await this.queue;
    const revision = this.catalog.revisions.find((revision) => revision.resourceId === resourceId && revision.version === version);
    if (!revision) throw new Error('not_found: 资源版本不存在');
    return structuredClone(revision);
  }
  async runReferences(workspaceId: string, runId: string): Promise<CatalogReferenceSnapshot | null> {
    await this.ready;
    await this.queue;
    return structuredClone(this.run(this.requireWorkspace(workspaceId), runId).referenceSnapshot ?? null);
  }
  async personalReferences(references: { resourceId: string; version: number }[]): Promise<CatalogReferenceSnapshot> {
    await this.ready;
    await this.queue;
    return freezeCatalogReferences(this.catalog, { workspaceId: null, sessionId: 'conv-personal-default', references });
  }
  private readonly catalogOperations = new Map<string, { fingerprint: string; result: Promise<WorkbenchResult> }>();
  catalogCommand(input: CatalogAction): Promise<WorkbenchResult> {
    const action = CatalogActionSchema.parse(input);
    const fingerprint = createHash('sha256').update(JSON.stringify(action)).digest('hex');
    const pending = this.catalogOperations.get(action.commandId);
    if (pending) {
      if (pending.fingerprint !== fingerprint) return Promise.reject(new Error('conflict: 命令 ID 已被不同请求使用'));
      return pending.result;
    }
    const result = this.performCatalogCommand(action, fingerprint);
    this.catalogOperations.set(action.commandId, { fingerprint, result });
    const clear = () => {
      this.catalogOperations.delete(action.commandId);
    };
    void result.then(clear, clear);
    return result;
  }
  private async performCatalogCommand(action: CatalogAction, fingerprint: string): Promise<WorkbenchResult> {
    await this.ready;
    const previous = this.catalog.appliedCommands.find((command) => command.commandId === action.commandId);
    if (previous) {
      if (previous.fingerprint !== fingerprint) throw new Error('conflict: 命令 ID 已被不同请求使用');
      return this.result();
    }
    let captured:
      | {
          snapshot: Awaited<ReturnType<WorkbenchRuntime['captureResource']>>;
          instanceId: string | null;
          generation: number;
          catalogResourceId: string | undefined;
        }
      | undefined;
    if (action.type === 'captureResourceRevision') {
      const binding = await this.serialize(() => {
        if (action.expectedCatalogRevision !== this.catalog.revision) throw new Error('conflict: 资源目录版本冲突');
        const workspace = this.requireWorkspace(action.workspaceId);
        const resource = this.resource(workspace, action.runtimeResourceId, 'web');
        if (resource.appProjectId) throw new Error('unsupported: 项目预览不是独立网页资源');
        this.ensureBrowser(workspace, resource);
        return { instanceId: resource.instanceId, generation: resource.generation, catalogResourceId: resource.catalogResourceId };
      });
      captured = { ...binding, snapshot: PageResourceSnapshotSchema.parse(await this.runtime.captureResource(action.runtimeResourceId)) };
    }
    return this.serialize(async () => {
      const before = structuredClone(this.snapshot),
        oldCatalog = this.catalog;
      try {
        if (
          action.expectedCatalogRevision !== this.catalog.revision &&
          !this.catalog.appliedCommands.some((command) => command.commandId === action.commandId)
        )
          throw new Error('conflict: 资源目录版本冲突，请刷新');
        let next = this.catalog;
        if (action.type === 'captureResourceRevision') {
          if (!captured) throw new Error('invalid_input: 缺少捕获结果');
          const workspace = this.requireWorkspace(action.workspaceId),
            resource = this.resource(workspace, action.runtimeResourceId, 'web');
          const page = this.runtime.browserState(resource.resourceId).page;
          if (
            resource.instanceId !== captured.instanceId ||
            resource.generation !== captured.generation ||
            resource.catalogResourceId !== captured.catalogResourceId ||
            JSON.stringify(page) !== JSON.stringify(captured.snapshot.page)
          )
            throw new Error('conflict: 捕获页面身份已变化');
          this.materializeCurrentPage(workspace.workspaceId, resource, captured.snapshot.url);
          if (!resource.catalogResourceId) throw new Error('not_found: 资源未进入账户目录');
          next = appendResourceRevision(
            this.catalog,
            {
              resourceId: resource.catalogResourceId,
              text: captured.snapshot.text,
              capturedAt: captured.snapshot.capturedAt,
              contentSha256: captured.snapshot.contentSha256,
              sourceSha256: captured.snapshot.sourceSha256,
              truncated: captured.snapshot.truncated,
              evidence: { kind: 'web', snapshot: captured.snapshot },
            },
            this.catalog.revision,
            this.catalogContext(),
          );
        } else if (action.type === 'bookmarkRuntimeResource') {
          const resource = this.resource(this.requireWorkspace(action.workspaceId), action.runtimeResourceId);
          if (resource.kind === 'session' || !resource.catalogResourceId) throw new Error('invalid_input: 会话不能收藏');
          if (resource.kind === 'web' && !resource.appProjectId) {
            const page = resource.instanceId ? this.runtime.browserState(resource.resourceId) : null;
            const url = page?.page.url ?? resource.url;
            if (!url) throw new Error('invalid_input: 当前网页缺少真实 URL');
            this.materializeCurrentPage(action.workspaceId, resource, url);
          }
          next = applyCatalogCommand(
            this.catalog,
            {
              type: 'bookmarkResource',
              commandId: action.commandId,
              expectedCatalogRevision: this.catalog.revision,
              resourceId: resource.catalogResourceId,
            },
            this.catalogContext(),
          );
        } else if (action.type === 'openCatalogResource') {
          const workspace = this.requireWorkspace(action.workspaceId);
          const resource = this.catalog.resources.find((resource) => resource.resourceId === action.resourceId);
          if (
            !resource ||
            !this.catalog.links.some((link) => link.workspaceId === workspace.workspaceId && link.resourceId === resource.resourceId)
          )
            throw new Error('denied: 资源未连接到空间');
          let runtime = workspace.resources.find(
            (runtime) =>
              runtime.catalogResourceId === resource.resourceId &&
              (resource.descriptor.kind !== 'web' ||
                (runtime.instanceId ? this.runtime.browserState(runtime.resourceId).page.url : runtime.url) === resource.descriptor.url),
          );
          if (!runtime) {
            const descriptor = resource.descriptor;
            if (descriptor.kind === 'development' && descriptor.entryKind === 'project')
              throw new Error('unsupported: 受管项目只能在原空间管理和启动');
            const kind =
              descriptor.kind === 'web'
                ? 'web'
                : descriptor.kind === 'document'
                  ? 'file'
                  : descriptor.entryKind === 'ssh'
                    ? 'ssh'
                    : 'terminal';
            const environmentId = descriptor.kind === 'web' ? 'local' : descriptor.environmentId;
            if (!environmentId) throw new Error('unsupported: 资源没有已授权环境');
            if (descriptor.kind === 'web') this.runtime.validateBrowserUrl(descriptor.url);
            else if (
              !this.snapshot.environments.find((environment) => environment.environmentId === environmentId)?.capabilities[
                kind === 'file' ? 'files' : 'terminal'
              ]
            )
              throw new Error('unsupported: 环境能力不可用');
            const tab = this.createResource(
              workspace,
              kind,
              resource.title.slice(0, 200),
              descriptor.kind === 'web' ? descriptor.url : undefined,
              environmentId,
            );
            runtime = this.resource(workspace, tab.targetRef.resourceId);
            runtime.catalogResourceId = resource.resourceId;
            if (descriptor.kind === 'document') runtime.url = descriptor.path;
          }
          this.openResource(workspace, runtime.resourceId);
          workspace.revision++;
        } else next = applyCatalogCommand(this.catalog, action, this.catalogContext());
        if (!next.appliedCommands.some((command) => command.commandId === action.commandId)) {
          next = structuredClone(next);
          recordAppliedCommand(next, { commandId: action.commandId, fingerprint });
        } else
          next.appliedCommands = next.appliedCommands.map((command) =>
            command.commandId === action.commandId ? { commandId: action.commandId, fingerprint } : command,
          );
        this.catalog = parseResourceCatalog(next);
        if (action.type === 'disconnectResource' || action.type === 'deleteResource')
          for (const workspace of this.snapshot.workspaces) {
            const removed = workspace.resources.filter(
              (resource) =>
                resource.catalogResourceId === action.resourceId &&
                (action.type === 'deleteResource' || workspace.workspaceId === action.workspaceId),
            );
            for (const resource of removed) this.assertUnreferencedBinding(workspace, resource.resourceId);
            workspace.resources = workspace.resources.filter((resource) => !removed.includes(resource));
          }
        // Catalogue writes persist the workspace snapshot too; never store a state that cannot be reloaded.
        validateSnapshot(this.snapshot);
        this.snapshot.seq++;
        await this.saveState(this.snapshot);
        this.emitSnapshot('workspaceId' in action ? action.workspaceId : this.snapshot.activeWorkspaceId, action.commandId);
        return this.result();
      } catch (error) {
        this.snapshot = before;
        this.catalog = oldCatalog;
        return { ok: false, error: { code: 'execution_failed', message: (error as Error).message }, snapshot: this.publicSnapshot() };
      }
    });
  }
  private async persist(w: WorkspaceSnapshot, entityId: string) {
    this.syncCatalogBindings(this.snapshot);
    const candidate = structuredClone(this.snapshot);
    const saved = candidate.workspaces.find((item) => item.workspaceId === w.workspaceId);
    if (!saved) throw new Error('not_found: 空间不存在');
    saved.revision++;
    candidate.seq++;
    candidate.storageError = null;
    await this.saveState(candidate);
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
    if (this.appCommands.has(c.commandId))
      return { ok: false, error: { code: 'conflict', message: '命令身份已使用' }, snapshot: this.publicSnapshot() };
    const old = this.commands.get(c.commandId);
    if (old)
      return old.fingerprint === fingerprint
        ? { ...structuredClone(old.outcome), snapshot: this.publicSnapshot() }
        : { ok: false, error: { code: 'conflict', message: '同一命令身份不能用于不同内容' }, snapshot: this.publicSnapshot() };
    const before = structuredClone(this.snapshot);
    const catalogBefore = structuredClone(this.catalog);
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
          case 'updateApp': {
            if (!w.app || w.app.appId !== c.appId) throw new Error('denied: App 不属于此空间');
            if (w.app.revision !== c.expectedAppRevision) throw new Error('conflict: App 已有较新修改，请重新打开编辑');
            w.app = { ...w.app, name: c.name, description: c.description, revision: w.app.revision + 1 };
            const projectId = w.app.projectId;
            for (const resource of w.resources.filter((resource) => resource.appProjectId === projectId)) {
              resource.title = c.name;
              for (const tab of w.tabs.filter((tab) => tab.targetRef.resourceId === resource.resourceId)) tab.title = c.name;
            }
            break;
          }
          case 'renameWorkspace':
            w.name = c.name;
            break;
          case 'switchWorkspace':
            this.snapshot.activeWorkspaceId = w.workspaceId;
            this.snapshot.workspaces = [w, ...this.snapshot.workspaces.filter((item) => item.workspaceId !== c.workspaceId)];
            break;
          case 'createTab': {
            if (c.url && c.kind !== 'web') throw new Error('invalid_input: 只有网页资源接受URL');
            const url = c.kind === 'web' && (c.url === undefined || c.url === '') ? 'wsl-demo://taskflow/index.html' : c.url;
            if (url) this.runtime.validateBrowserUrl(url);
            if (['file', 'terminal', 'ssh'].includes(c.kind)) {
              if (!c.environmentId) throw new Error('invalid_input: 请选择已配置环境');
              const environment = this.snapshot.environments.find((e) => e.environmentId === c.environmentId);
              const capability = c.kind === 'file' ? 'files' : 'terminal';
              if (!environment?.capabilities[capability] || (c.kind === 'ssh' && c.environmentId !== 'ssh'))
                throw new Error('unsupported: 该环境未配置此资源能力');
            }
            if (c.kind === 'web' && c.environmentId && c.environmentId !== 'local') throw new Error('unsupported: 原生网页属于本设备');
            const tab = this.createResource(w, c.kind, c.title, url, c.environmentId ?? (c.kind === 'web' ? 'local' : null));
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
          case 'setSessionHarness':
            // 只记录选择；能否执行在 startRun 时按最新的 Profile 与自检结果判断（W4a），已创建的执行不受影响。
            this.session(w, c.sessionId).harnessSelection = c.selection;
            break;
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
              appTarget:
                w.app && w.managedApp?.guestCwd && c.targetRef && this.resource(w, c.targetRef.resourceId).appProjectId === w.app.projectId
                  ? { ...structuredClone(w.app), guestCwd: w.managedApp.guestCwd }
                  : null,
              targetRef: c.targetRef,
              capture:
                c.targetRef?.kind === 'web' && s.contextTarget?.resourceId === c.targetRef.resourceId && s.context
                  ? structuredClone(s.context)
                  : null,
              captureBinding:
                c.targetRef?.kind === 'web'
                  ? {
                      appInstanceId: this.snapshot.appInstanceId,
                      instanceId: this.resource(w, c.targetRef.resourceId).instanceId!,
                      generation: this.resource(w, c.targetRef.resourceId).generation,
                    }
                  : null,
              confirmedAt: new Date().toISOString(),
              acceptance: [...(c.acceptance ?? s.taskAcceptance)],
              allowedScopes: [...(c.allowedScopes ?? s.taskAllowedScopes)],
            });
            break;
          }
          case 'startRun': {
            const launch = await this.startRun(w, c.sessionId, c.taskVersionId);
            this.runLaunches.set(c.commandId, launch);
            return rememberResult();
          }
          case 'cancelObservation': {
            const record = this.observationRecords(w, c.sessionId).find((r) => r.request.requestId === c.requestId);
            if (!record) throw new Error('not_found: 观察请求不存在');
            if (record.state === 'pending') {
              this.observations.get(c.requestId)?.abort();
              record.state = 'cancelled';
              record.endedAt = new Date().toISOString();
              record.result = { error: 'cancelled', message: '用户取消观察' };
            }
            break;
          }
          case 'cancelRun': {
            const run = this.run(w, c.runId);
            if (!activeStates.includes(run.state)) break;
            if (run.cleanupPending && !this.runLogBaselines.has(run.runId) && !this.sourceRuns.has(run.runId)) {
              // Restart restores an obligation, not an executor handle. A fresh
              // service's idle slot cannot confirm the old process has stopped.
              const target = this.session(w, run.sessionId).taskVersions.find(
                (version) => version.taskVersionId === run.taskVersionId,
              )?.appTarget;
              if (target) return rememberResult();
            }
            const phase = this.runLaunchPhases.get(run.runId);
            const executor = run.executorState;
            if (
              run.sourceCleanupPending &&
              (phase === 'baseline' ||
                !this.runTurns.has(run.runId) ||
                (executor && !executor.cleanupPending && !activeStates.includes(executor.state)))
            ) {
              run.state = 'cancelling';
              if (phase === 'baseline') run.executorState = { state: 'cancelled', cleanupPending: false };
              run.cleanupPending = true;
              run.endedAt = null;
              this.sourceRuns.get(run.runId)?.baseline.abort();
              if (!run.sourceChange) run.sourceChange = { state: 'unavailable', reason: '执行启动前已取消，等待源码 helper 清理确认' };
              this.runLogBaselines.delete(run.runId);
              this.releaseObservationScope(w, run.runId);
              await this.persist(w, c.commandId);
              return rememberResult();
            }
            if (phase === 'registering' || phase === 'baseline') {
              // No executor was dispatched, so cancellation is already a confirmed fact.
              // Keep that fact in memory even if disk fails; a late registration must never launch it.
              run.state = 'cancelled';
              run.executorState = { state: 'cancelled', cleanupPending: false };
              run.cleanupPending = false;
              run.endedAt = new Date().toISOString();
              this.sourceRuns.get(run.runId)?.baseline.abort();
              if (!run.sourceChange) run.sourceChange = { state: 'unavailable', reason: '执行启动前已取消，未完成源码基线采集' };
              if (phase === 'registering') this.releaseSourceRun(run.runId);
              this.runLogBaselines.delete(run.runId);
              this.releaseObservationScope(w, run.runId);
              try {
                await this.persist(w, c.commandId);
              } catch (error) {
                this.snapshot.storageError = '工作现场保存失败：' + (error as Error).message;
                throw error;
              }
              return rememberResult();
            }
            const previousState = run.state;
            run.state = 'cancelling';
            for (const record of this.session(w, run.sessionId).observations)
              if (record.request.runId === run.runId && record.state === 'pending')
                this.observations.get(record.request.requestId)?.abort();
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
            const r = this.terminalResource(w, c.resourceId);
            if (r.terminal?.state === 'failed' && r.terminal.cleanupPending)
              throw new Error('execution_failed: 终端清理未确认，不能重新连接');
            if (r.terminal?.cleanupPending || ['running', 'starting', 'closing'].includes(r.terminal?.state ?? '')) return rememberResult();
            const environment = this.snapshot.environments.find((environment) => environment.environmentId === r.environmentId);
            if (!environment?.capabilities.terminal) throw new Error('unsupported: 终端环境未配置');
            const beforeOpen = { instanceId: r.instanceId, generation: r.generation, terminal: r.terminal };
            r.instanceId = randomUUID();
            r.generation++;
            r.terminal = {
              seq: 0,
              sessionId: null,
              sandbox: null,
              cwd: null,
              state: 'starting',
              output: '',
              outputOffset: 0,
              cleanupPending: true,
              error: null,
            };
            try {
              await this.persist(w, c.commandId);
            } catch (error) {
              Object.assign(r, beforeOpen);
              throw error;
            }
            this.requestTerminalOpen(this.instance(w, r), c.cols, c.rows);
            return rememberResult();
          }
          case 'terminalWrite': {
            const r = this.terminalResource(w, c.resourceId);
            this.checkInstance(r, c.instanceId);
            if (!r.terminal?.sessionId || r.terminal.state !== 'running') throw new Error('conflict: 终端尚未运行');
            await this.runtime.terminalWrite(r.resourceId, r.terminal.sessionId, c.data);
            return rememberResult();
          }
          case 'terminalResize': {
            const r = this.terminalResource(w, c.resourceId);
            this.checkInstance(r, c.instanceId);
            if (!r.terminal?.sessionId || r.terminal.state !== 'running') throw new Error('conflict: 终端尚未运行');
            await this.runtime.terminalResize(r.resourceId, r.terminal.sessionId, c.cols, c.rows);
            return rememberResult();
          }
          case 'stopInstance': {
            const r = this.resource(w, c.resourceId);
            this.checkInstance(r, c.instanceId);
            if (r.kind === 'web' || r.kind === 'file') {
              if (w.tabs.some((tab) => tab.targetRef.resourceId === r.resourceId)) throw new Error('conflict: 请先关闭该资源的标签');
              if (
                w.runs.some(
                  (run) =>
                    activeStates.includes(run.state) &&
                    (run.targetRef?.resourceId === r.resourceId ||
                      run.referenceSnapshot?.resources.some((reference) => reference.resourceId === r.catalogResourceId)),
                ) ||
                [...w.observations, ...w.sessions.flatMap((session) => session.observations)].some(
                  (record) => record.state === 'pending' && record.request.target?.resourceId === r.resourceId,
                )
              )
                throw new Error('conflict: 资源仍被执行或观察使用');
              if (!r.environmentId || !r.instanceId) throw new Error('conflict: 资源实例不存在');
              await this.runtime.releaseResource({
                workspaceId: w.workspaceId,
                environmentId: r.environmentId,
                resourceId: r.resourceId,
                kind: r.kind === 'web' ? 'browser' : 'file',
                instanceId: r.instanceId,
                instanceGeneration: r.generation,
              });
              r.instanceId = null;
              r.preview = null;
              r.generation++;
              await this.persist(w, c.commandId);
              return rememberResult();
            }
            if (!['terminal', 'ssh'].includes(r.kind)) throw new Error('unsupported: 该资源没有可停止的进程');
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
      if (!runtimeCommand) {
        this.snapshot = before;
        this.catalog = catalogBefore;
      }
      const message = (error as Error).message;
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
  private trackRunOperation(operation: Promise<unknown>) {
    this.runOperations.add(operation);
    void operation.then(
      () => this.runOperations.delete(operation),
      () => this.runOperations.delete(operation),
    );
  }
  private releaseSourceRun(runId: string) {
    const control = this.sourceRuns.get(runId);
    if (control) {
      const run = this.run(this.requireWorkspace(control.target.workspaceId), runId);
      if (run.sourceCleanupPending) return;
    }
    if (control && this.projectWriters.get(control.target.projectId) === runId) this.projectWriters.delete(control.target.projectId);
    this.sourceRuns.delete(runId);
  }
  private markSourceCleanupUnknown(run: WorkbenchRun) {
    if (!run.sourceCleanupPending) return;
    run.cleanupPending = true;
    if (!['completed', 'failed'].includes(run.state)) {
      run.state = 'cancelling';
      run.endedAt = null;
    }
    run.executorState ??= { state: 'failed', cleanupPending: false };
    run.error = '源码 helper 清理未确认，项目仍被占用；不能确认取消或正常退出';
  }
  private async sourceSnapshot(runId: string, control: SourceRun, signal: AbortSignal) {
    if (!this.runtime.appSourceSnapshot) throw new Error('源码采集服务未配置');
    signal.throwIfAborted();
    const { target } = control;
    const terminal = await this.serialize(async () => {
      const w = this.requireWorkspace(target.workspaceId);
      const current = this.run(w, runId);
      if (this.sourceRuns.get(runId) !== control || this.projectWriters.get(target.projectId) !== runId)
        throw new Error('源码采集归属已失效');
      const before = {
        sourceCleanupPending: current.sourceCleanupPending,
        cleanupPending: current.cleanupPending,
        state: current.state,
        endedAt: current.endedAt,
      };
      current.sourceCleanupPending = true;
      current.cleanupPending = true;
      if (current.state === 'cancelled') {
        current.state = 'cancelling';
        current.endedAt = null;
      }
      try {
        await this.persist(w, runId);
      } catch (error) {
        Object.assign(current, before);
        throw error;
      }
      return ['completed', 'failed', 'cancelled'].includes(before.state) ? { state: before.state, endedAt: before.endedAt } : null;
    });
    const parsed = AppSourceSnapshotResultSchema.safeParse(await this.runtime.appSourceSnapshot(target, signal));
    if (!parsed.success) throw new Error('源码快照归属、路径、清理事实或预算无效');
    const result = parsed.data;
    const identity = result.ok ? result.snapshot : result.target;
    if (identity.workspaceId !== target.workspaceId || identity.projectId !== target.projectId)
      throw new Error('源码快照归属无效，所属 helper 清理未确认');
    await this.serialize(async () => {
      const w = this.requireWorkspace(target.workspaceId);
      const current = this.run(w, runId);
      if (this.sourceRuns.get(runId) !== control || this.projectWriters.get(target.projectId) !== runId)
        throw new Error('源码采集归属已失效');
      current.sourceCleanupPending = !result.cleanupConfirmed;
      current.cleanupPending = current.sourceCleanupPending || Boolean(current.appCleanupPending || current.executorState?.cleanupPending);
      this.markSourceCleanupUnknown(current);
      const model = current.executorState;
      if (!current.cleanupPending && current.state === 'cancelling' && model && !activeStates.includes(model.state)) {
        // An idle executor may have produced a candidate the user cancelled.
        // Source collection must preserve that business outcome.
        current.state = terminal?.state ?? (model.state === 'idle' ? 'completed' : model.state);
        current.endedAt = terminal?.endedAt ?? new Date().toISOString();
      }
      await this.persist(w, runId);
    });
    if (!result.ok) throw new Error(result.error);
    signal.throwIfAborted();
    return result.snapshot;
  }
  private async collectRunBaseline(workspaceId: string, runId: string) {
    const control = await this.serialize(() => {
      const current = this.run(this.requireWorkspace(workspaceId), runId);
      const owner = this.sourceRuns.get(runId);
      if (!owner || current.state !== 'starting' || this.closing || this.projectWriters.get(owner.target.projectId) !== runId) return null;
      this.runLaunchPhases.set(runId, 'baseline');
      return owner;
    });
    if (!control) return;
    try {
      if (!this.repository.createSourceBaseline) throw new Error('宿主源码证据存储未配置');
      const snapshot = await this.sourceSnapshot(runId, control, control.baseline.signal);
      const baseline = await this.repository.createSourceBaseline(runId, snapshot, control.baseline.signal);
      const sourceChange = SourceChangeSchema.parse({ state: 'baseline', baseTree: baseline.baseTree });
      await this.serialize(async () => {
        const w = this.requireWorkspace(workspaceId);
        const current = this.run(w, runId);
        if (this.sourceRuns.get(runId) !== control || this.projectWriters.get(control.target.projectId) !== runId) return;
        current.sourceChange = sourceChange;
        await this.persist(w, runId);
      });
    } catch (error) {
      await this.updateRuntime(() => {
        const w = this.requireWorkspace(workspaceId);
        const current = this.run(w, runId);
        if (this.sourceRuns.get(runId) !== control) return null;
        this.markSourceCleanupUnknown(current);
        current.sourceChange = {
          state: 'unavailable',
          reason: `${control.baseline.signal.aborted ? '执行启动前已取消，未完成源码基线采集' : '源码基线不可用'}：${error instanceof Error ? error.message.slice(0, 900) : '采集失败'}`,
        };
        return w;
      });
    } finally {
      await this.serialize(() => {
        if (this.sourceRuns.get(runId) !== control) return;
        control.ready = true;
        const w = this.requireWorkspace(workspaceId);
        this.captureRunSource(w, this.run(w, runId));
      });
    }
  }
  private captureRunSource(w: WorkspaceSnapshot, run: WorkbenchRun) {
    const control = this.sourceRuns.get(run.runId);
    if (!control || !control.ready || control.capturing || !['completed', 'failed', 'cancelled'].includes(run.state)) return;
    const executor = run.executorState;
    if (!executor || executor.cleanupPending || activeStates.includes(executor.state) || run.cleanupPending) return;
    if (run.sourceChange?.state !== 'baseline') {
      this.releaseSourceRun(run.runId);
      return;
    }
    control.capturing = true;
    const { runId } = run;
    const workspaceId = w.workspaceId;
    const { baseTree } = run.sourceChange;
    const signal = new AbortController().signal;
    const operation = Promise.resolve().then(async () => {
      await this.queue;
      try {
        if (!this.repository.captureSourceChange) throw new Error('宿主 diff 存储未配置');
        const snapshot = await this.sourceSnapshot(runId, control, signal);
        const captured = CapturedSourceChangeSchema.parse(await this.repository.captureSourceChange(runId, baseTree, snapshot, signal));
        if (captured.baseTree !== baseTree) throw new Error('源码 diff 与宿主基线不一致');
        await this.serialize(async () => {
          const workspace = this.requireWorkspace(workspaceId);
          const current = this.run(workspace, runId);
          if (
            this.sourceRuns.get(runId) !== control ||
            this.projectWriters.get(control.target.projectId) !== runId ||
            current.sourceChange?.state !== 'baseline' ||
            current.sourceChange.baseTree !== baseTree
          )
            return null;
          current.sourceChange = captured;
          await this.persist(workspace, runId);
        });
      } catch (error) {
        await this.updateRuntime(() => {
          const workspace = this.requireWorkspace(workspaceId);
          const current = this.run(workspace, runId);
          if (this.sourceRuns.get(runId) !== control) return null;
          this.markSourceCleanupUnknown(current);
          current.sourceChange = {
            state: 'unavailable',
            reason: `结束源码采集不可用：${error instanceof Error ? error.message.slice(0, 900) : '采集失败'}`,
          };
          return workspace;
        });
      } finally {
        await this.serialize(() => {
          if (this.sourceRuns.get(runId) === control) this.releaseSourceRun(runId);
        });
      }
    });
    this.trackRunOperation(operation);
  }
  async runPatch(workspaceId: string, runId: string): Promise<RunPatchResult> {
    RunPatchQuerySchema.parse({ workspaceId, runId });
    const patchSha256 = await this.serialize(() => {
      const run = this.run(this.requireWorkspace(workspaceId), runId);
      if (run.workspaceId !== workspaceId || run.sourceChange?.state !== 'captured')
        throw new Error('not_found: 此运行没有已采集的源码 diff');
      return run.sourceChange.patchSha256;
    });
    if (!this.repository.readRunPatch) throw new Error('unavailable: diff 存储未配置');
    const patch = await this.repository.readRunPatch(runId, patchSha256);
    if (createHash('sha256').update(patch, 'utf8').digest('hex') !== patchSha256) throw new Error('conflict: diff SHA-256 不匹配');
    return RunPatchResultSchema.parse({ workspaceId, runId, patchSha256, patch });
  }
  async shutdown(): Promise<void> {
    this.closing = true;
    try {
      await this.ready;
    } catch (error) {
      if (!this.initialized && !this.sourceRuns.size && !this.runOperations.size) return;
      throw error;
    }
    const active = await this.serialize(() =>
      this.snapshot.workspaces.flatMap((w) =>
        w.runs.filter((run) => activeStates.includes(run.state)).map((run) => ({ workspaceId: w.workspaceId, runId: run.runId })),
      ),
    );
    for (const run of active) await this.command({ type: 'cancelRun', commandId: randomUUID(), ...run });
    while (this.runOperations.size) {
      await Promise.allSettled([...this.runOperations]);
      await this.queue;
    }
    await this.serialize(async () => {
      let pending = false;
      for (const workspace of this.snapshot.workspaces) {
        let changed = false;
        for (const run of workspace.runs) {
          if (activeStates.includes(run.state) || run.cleanupPending || run.sourceCleanupPending) {
            pending = true;
            if (run.sourceChange?.state === 'baseline') {
              run.sourceChange = { state: 'unavailable', reason: '退出前未完成采集：执行器或所属操作清理未确认' };
              changed = true;
            }
          }
        }
        if (changed) await this.persist(workspace, randomUUID());
      }
      if (pending) throw new Error('任务执行或所属操作清理未确认，结束源码尚不能采集');
    });
  }
  private async startRun(w: WorkspaceSnapshot, sessionId: string, versionId: string) {
    if (this.closing) throw new Error('unavailable: 工作台正在关闭，不能开始新执行');
    const s = this.session(w, sessionId);
    const v = s.taskVersions.find((v) => v.taskVersionId === versionId);
    if (!v) throw new Error('not_found: 任务版本不存在');
    if (
      v.appTarget &&
      (this.projectWriters.has(v.appTarget.projectId) ||
        this.snapshot.workspaces.some((space) =>
          space.runs.some(
            (run) =>
              (activeStates.includes(run.state) || run.cleanupPending || run.sourceCleanupPending) &&
              space.sessions
                .find((session) => session.sessionId === run.sessionId)
                ?.taskVersions.find((version) => version.taskVersionId === run.taskVersionId)?.appTarget?.projectId ===
                v.appTarget?.projectId,
          ),
        ))
    )
      throw new Error('conflict: 同项目执行、清理或结束源码采集尚未完成');
    if (w.runs.some((r) => r.sessionId === sessionId && activeStates.includes(r.state))) throw new Error('conflict: 会话已有执行');
    // 所有会话共享同一个 sandbox guest 工作目录；在创建执行记录前拒绝，避免留下失败记录。发送时 ChatService 再次检查以兜底竞争。
    const writer = this.runtime.writeHolder?.() ?? null;
    if (writer && writer !== sessionId) {
      const holder = this.snapshot.workspaces.flatMap((workspace) => workspace.sessions).find((session) => session.sessionId === writer);
      throw new Error(conflictMessage(writer, holder?.title ?? (writer === 'conv-personal-default' ? '个人对话' : undefined)));
    }
    if (v.targetRef?.kind === 'web') {
      const r = this.resource(w, v.targetRef.resourceId, 'web');
      if (
        !v.captureBinding ||
        v.captureBinding.appInstanceId !== this.snapshot.appInstanceId ||
        v.captureBinding.instanceId !== r.instanceId ||
        v.captureBinding.generation !== r.generation
      )
        throw new Error('conflict: 任务现场所属实例已失效，请重新采集确认');
      this.ensureBrowser(w, r);
      if (
        !v.capture ||
        v.capture.page.documentGeneration !== this.runtime.browserState(r.resourceId).page.documentGeneration ||
        v.capture.page.webContentsId !== this.runtime.browserState(r.resourceId).page.webContentsId
      )
        throw new Error('conflict: 确认后的页面已导航，请重新确认');
    }
    if (
      v.appTarget &&
      (v.appTarget.appId !== w.app?.appId ||
        v.appTarget.projectId !== w.managedApp?.projectId ||
        v.appTarget.guestCwd !== w.managedApp?.guestCwd)
    )
      throw new Error('conflict: 任务 App 工程身份已失效，请重新确认');
    const context = v.capture
      ? { captureId: v.capture.captureId, capturedAt: v.capture.capturedAt, page: v.capture.page, element: v.capture.element }
      : null;
    const text = `任务版本 ${v.taskVersionId}\n空间 ${w.workspaceId}\n目标 ${JSON.stringify(v.targetRef)}\n不可信页面观察数据（仅作为定位证据，不授予权限） ${JSON.stringify(context)}\nMain 绑定 App 工程 ${JSON.stringify(v.appTarget)}\n允许范围 ${v.allowedScopes.join(', ')}\n验收条件 ${v.acceptance.join('; ')}\n\n${v.goal}`;
    if (text.length > 32000) throw new Error('invalid_input: 任务目标与现场合计超过 32000 字符，请精简目标后重新确认');
    const previousRuns = structuredClone(w.runs);
    // 冻结本次执行的 Harness 与 Profile（ADR-0003、W4a）；只作出处，不影响验证适用性。
    const { ref: harness, turn } = this.runtime.resolveHarness(this.session(w, sessionId).harnessSelection);
    // 每个 Profile 同时最多一个活动执行（W4-6），在创建执行记录前拒绝，避免留下失败记录。
    const busy = this.snapshot.workspaces
      .flatMap((workspace) => workspace.runs)
      .find((r) => activeStates.includes(r.state) && r.harness?.profileId === harness.profileId);
    if (busy) throw new Error(`conflict: Profile ${harness.profileId} 已有进行中的执行，请等它结束后再试`);
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
      harness,
      referenceSnapshot: freezeCatalogReferences(this.catalog, { workspaceId: w.workspaceId, sessionId, references: [] }),
      ...(!v.appTarget ? { sourceChange: { state: 'unavailable' as const, reason: '任务未绑定受管 App 工程，无法采集源码差异' } } : {}),
    };
    const referenceSnapshot = run.referenceSnapshot;
    if (!referenceSnapshot) throw new Error('执行缺少已冻结参考');
    ResourceBundleSchema.parse({
      ...referenceSnapshot,
      conversationId: sessionId,
      generation: '\u0000'.repeat(128),
      turnId: '\u0000'.repeat(128),
    });
    for (const old of w.runs.filter((r) => r.sessionId === sessionId)) old.validation.applicability = 'unknown';
    for (const resource of w.resources) this.fileInstance(resource);
    const scope: ObservationTurnScope = { workspaceId: w.workspaceId, sessionId, runId: run.runId, sources: this.sources(w).sources };
    this.observationScopes.set(run.runId, scope);
    this.observationCounts.set(run.runId, 0);
    w.runs.push(run);
    this.runLogBaselines.set(run.runId, {
      messageIds: new Set(s.conversation?.messages.map((m) => m.id)),
      warnings: new Set(s.conversation?.warnings),
    });
    // Freeze and persist ownership before invoking the existing runner.
    try {
      await this.persist(w, run.runId);
    } catch (error) {
      w.runs = previousRuns;
      this.runLogBaselines.delete(run.runId);
      this.observationScopes.delete(run.runId);
      this.observationCounts.delete(run.runId);
      throw error;
    }
    this.runLaunchPhases.set(run.runId, 'registering');
    if (v.appTarget) {
      this.sourceRuns.set(run.runId, {
        target: { workspaceId: w.workspaceId, projectId: v.appTarget.projectId },
        baseline: new AbortController(),
        ready: false,
        capturing: false,
      });
      this.projectWriters.set(v.appTarget.projectId, run.runId);
    }
    const workspaceId = w.workspaceId;
    return async () => {
      try {
        await this.runtime.registerSession(sessionId, workspaceId);
        // 尚未自检的 Profile 在这里补做（不占用元数据队列）；未登录时抛出，按“从未启动”记为失败，不换用其他 Profile。
        await this.runtime.prepareHarness(structuredClone(turn));
        await this.collectRunBaseline(workspaceId, run.runId);
        const launch = await this.serialize(() => {
          const current = this.run(this.requireWorkspace(workspaceId), run.runId);
          if (current.state !== 'starting' || this.closing) return false;
          this.runLaunchPhases.set(run.runId, 'sending');
          // Dispatch under the ownership check, but never await external I/O on the metadata queue.
          return {
            receipt: this.runtime.send(sessionId, text, structuredClone(scope), structuredClone(referenceSnapshot), structuredClone(turn)),
          };
        });
        if (!launch) return;
        const conversation = await launch.receipt;
        await this.updateRuntime(() => {
          const workspace = this.requireWorkspace(workspaceId);
          const current = this.run(workspace, run.runId);
          if (!activeStates.includes(current.state) || current.state === 'cancelling') return null;
          this.applyConversation(workspace, conversation);
          return workspace;
        });
      } catch (error) {
        await this.updateRuntime(() => {
          const workspace = this.requireWorkspace(workspaceId);
          const current = this.run(workspace, run.runId);
          if (!activeStates.includes(current.state)) return null;
          if (current.sourceCleanupPending) {
            this.markSourceCleanupUnknown(current);
            return workspace;
          }
          if ((error instanceof RunDispatchFailure && error.cleanupPending) || current.executorState?.cleanupPending) {
            current.state = 'cancelling';
            current.cleanupPending = true;
            current.executorState = { state: 'failed', cleanupPending: true };
            current.error = '启动回执失败；模型清理未确认，结束源码尚不能采集';
            return workspace;
          }
          // A rejected dispatch started no executor, so a pending cancellation is already settled here;
          // the later cancel receipt only reflects the unchanged conversation and must not decide this run.
          const cancelled = current.state === 'cancelling';
          current.state = cancelled ? 'cancelled' : 'failed';
          current.executorState = { state: cancelled ? 'cancelled' : 'failed', cleanupPending: false };
          current.cleanupPending = false;
          current.error = (cancelled ? '取消前启动已失败：' : '') + (error as Error).message;
          current.endedAt = new Date().toISOString();
          this.runLogBaselines.delete(run.runId);
          this.releaseObservationScope(workspace, run.runId);
          return workspace;
        });
      } finally {
        await this.updateRuntime(() => {
          this.runLaunchPhases.delete(run.runId);
          const workspace = this.requireWorkspace(workspaceId);
          const current = this.run(workspace, run.runId);
          const control = this.sourceRuns.get(run.runId);
          if (!control) return null;
          control.ready = true;
          if (!current.sourceChange) current.sourceChange = { state: 'unavailable', reason: '执行启动前未完成源码基线采集' };
          this.captureRunSource(workspace, current);
          return workspace;
        });
      }
    };
  }
  private terminalResource(workspace: WorkspaceSnapshot, resourceId: string) {
    const resource = this.resource(workspace, resourceId);
    if (!['terminal', 'ssh'].includes(resource.kind)) throw new Error('invalid_input: 资源不是终端');
    return resource;
  }
  private requestTerminalOpen(binding: ResourceInstanceIdentity, cols: number, rows: number) {
    const launch = Promise.resolve().then(async () => {
      await this.runtime.registerResource(binding);
      return this.runtime.terminalOpen(binding.resourceId, cols, rows);
    });
    this.terminalLaunches.set(binding.instanceId, launch);
    void launch
      .then(
        (terminal) =>
          this.updateRuntime(() => {
            const workspace = this.requireWorkspace(binding.workspaceId);
            const resource = this.terminalResource(workspace, binding.resourceId);
            if (resource.instanceId !== binding.instanceId || resource.generation !== binding.instanceGeneration) return null;
            if ((resource.terminal?.seq ?? -1) > terminal.seq) return null;
            if (resource.terminal?.state === 'closing') {
              resource.terminal = { ...terminal, state: 'closing', cleanupPending: true };
            } else if ((resource.terminal?.seq ?? -1) <= terminal.seq) resource.terminal = terminal;
            return workspace;
          }),
        (error) =>
          this.updateRuntime(() => {
            const workspace = this.requireWorkspace(binding.workspaceId);
            const resource = this.terminalResource(workspace, binding.resourceId);
            if (resource.instanceId !== binding.instanceId || resource.generation !== binding.instanceGeneration) return null;
            resource.terminal = {
              ...resource.terminal!,
              state: 'failed',
              cleanupPending: resource.terminal?.state === 'failed' ? resource.terminal.cleanupPending : true,
              error: (error as Error).message,
            };
            return workspace;
          }),
      )
      .finally(() => {
        if (this.terminalLaunches.get(binding.instanceId) === launch) this.terminalLaunches.delete(binding.instanceId);
      });
  }
  private requestTerminalStop(workspaceId: string, resourceId: string, instanceId: string, generation: number) {
    const launch = this.terminalLaunches.get(instanceId);
    const ptySessionId = this.terminalResource(this.requireWorkspace(workspaceId), resourceId).terminal?.sessionId;
    void Promise.resolve()
      .then(async () => {
        const sessionId = launch ? (await launch).sessionId : ptySessionId;
        if (!sessionId) throw new Error('终端启动结果未知；清理未确认');
        return this.runtime.terminalStop(resourceId, sessionId);
      })
      .then(
        (terminal) =>
          this.updateRuntime(() => {
            const workspace = this.requireWorkspace(workspaceId);
            const resource = this.terminalResource(workspace, resourceId);
            if (resource.instanceId !== instanceId || resource.generation !== generation || (resource.terminal?.seq ?? -1) > terminal.seq)
              return null;
            resource.terminal =
              terminal.cleanupPending || !['closed', 'failed'].includes(terminal.state)
                ? { ...terminal, state: 'failed', cleanupPending: true, error: terminal.error ?? '停止返回但清理未确认' }
                : terminal;
            return workspace;
          }),
        (error) =>
          this.updateRuntime(() => {
            const workspace = this.requireWorkspace(workspaceId);
            const resource = this.terminalResource(workspace, resourceId);
            if (resource.instanceId !== instanceId || resource.generation !== generation) return null;
            if (resource.terminal && !resource.terminal.cleanupPending && ['closed', 'failed'].includes(resource.terminal.state))
              return null;
            resource.terminal = {
              ...resource.terminal!,
              state: 'failed',
              cleanupPending: true,
              error: '终端停止失败；清理未确认：' + (error as Error).message,
            };
            return workspace;
          }),
      );
  }
  private requestCancellation(workspaceId: string, runId: string, binding: { generation: string; turnId: string | null } | undefined) {
    const run = this.run(this.requireWorkspace(workspaceId), runId);
    // Cleanup can take arbitrarily long; its completion rejoins the metadata queue with the original run binding.
    const operation = Promise.resolve()
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
    this.trackRunOperation(operation);
  }
  private applyConversation(w: WorkspaceSnapshot, conversation: ChatConversation) {
    const s = w.sessions.find((s) => s.sessionId === conversation.conversationId);
    if (!s) return;
    const executing = w.runs.findLast((r) => r.sessionId === s.sessionId && activeStates.includes(r.state));
    if (executing?.state === 'cancelling' && ['starting', 'running'].includes(conversation.state)) return;
    if (
      executing?.sourceCleanupPending &&
      executing.executorState &&
      !executing.executorState.cleanupPending &&
      !activeStates.includes(executing.executorState.state)
    )
      return;
    if (
      w.runs.some(
        (run) =>
          run.sessionId === s.sessionId &&
          run.runId !== executing?.runId &&
          !activeStates.includes(run.state) &&
          run.executionBinding?.generation === conversation.generation &&
          run.executionBinding.turnId === conversation.turnId,
      )
    )
      return;
    const bound = executing ? this.runTurns.get(executing.runId) : null;
    if (executing && !bound && ['registering', 'baseline'].includes(this.runLaunchPhases.get(executing.runId) ?? '')) return;
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
      executing.executorState = { state: conversation.state, cleanupPending: conversation.cleanupPending };
      executing.conversation = {
        ...structuredClone(conversation),
        messages: structuredClone(conversation.messages.filter((m) => !baseline.messageIds.has(m.id))),
        toolExecutions: structuredClone(conversation.toolExecutions.filter((tool) => tool.turnId === binding.turnId)),
        warnings: conversation.warnings.filter((warning) => !baseline.warnings.has(warning)),
      };
    }
    if (executing) {
      executing.appCleanupPending = this.appControl?.hasPending(w.workspaceId, executing.runId) ?? false;
      executing.cleanupPending = executing.appCleanupPending || conversation.cleanupPending || Boolean(executing.sourceCleanupPending);
      executing.cleanupRetryAvailable = this.appControl?.canRetryCleanup(executing.runId) ?? false;
      executing.cleanupReconciling = this.appControl?.isReconciling(executing.runId) ?? false;
      if (executing.cleanupPending && !['starting', 'running'].includes(conversation.state)) {
        conversation = { ...conversation, state: 'cancelling', cleanupPending: true };
        executing.conversation = { ...executing.conversation!, state: 'cancelling', cleanupPending: true };
      }
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
      this.releaseObservationScope(w, run.runId);
    }
  }
  onAppCleanupChanged(workspaceId: string, runId: string) {
    void this.updateRuntime(() => {
      const w = this.requireWorkspace(workspaceId);
      const run = this.run(w, runId);
      run.appCleanupPending = this.appControl?.hasPending(workspaceId, runId) ?? false;
      const model = run.executorState;
      // 历史 conversation 是展示记录，不能替代旧执行器的退出回执。
      const modelCleanupUnknown = !model || model.cleanupPending || activeStates.includes(model.state);
      run.cleanupPending = run.appCleanupPending || modelCleanupUnknown || Boolean(run.sourceCleanupPending);
      run.cleanupRetryAvailable = this.appControl?.canRetryCleanup(runId) ?? false;
      run.cleanupReconciling = this.appControl?.isReconciling(runId) ?? false;
      if (
        !run.cleanupPending &&
        run.state === 'cancelling' &&
        model &&
        !['starting', 'running', 'cancelling'].includes(model.state) &&
        !model.cleanupPending
      ) {
        run.state = model.state === 'idle' ? 'completed' : model.state;
        run.endedAt = new Date().toISOString();
        if (run.conversation) run.conversation = { ...run.conversation, state: model.state, cleanupPending: false };
        const session = w.sessions.find((item) => item.sessionId === run.sessionId);
        const binding = run.executionBinding;
        if (
          session &&
          session.conversation &&
          binding &&
          session.conversation.generation === binding.generation &&
          session.conversation.turnId === binding.turnId
        )
          session.conversation = { ...session.conversation, state: model.state, cleanupPending: false };
        this.releaseObservationScope(w, runId);
      }
      if (run.state === 'cancelling' && modelCleanupUnknown && !run.appCleanupPending) {
        run.error = this.observationScopes.has(runId)
          ? '模型进程清理未确认；App 数据操作已完成，停止尚未确认'
          : '旧模型进程清理未确认；App 数据操作已完成，停止尚未确认';
        if (run.conversation) run.conversation = { ...run.conversation, state: 'cancelling', cleanupPending: true, error: run.error };
        const session = w.sessions.find((item) => item.sessionId === run.sessionId);
        const binding = run.executionBinding;
        if (
          session &&
          session.conversation &&
          binding &&
          session.conversation.generation === binding.generation &&
          session.conversation.turnId === binding.turnId
        )
          session.conversation = { ...session.conversation, state: 'cancelling', cleanupPending: true, error: run.error };
      }
      return w;
    });
  }
  /**
   * 权限请求的回复（W4b）：Main 只核对会话、当前执行与请求仍待决，再转给执行服务；不改写本地状态，
   * 决定由执行服务的新快照发布。请求内容来自 Agent，不授予额外权限。
   */
  private async answerPermission(c: Extract<WorkbenchCommand, { type: 'answerPermission' }>): Promise<WorkbenchResult> {
    await this.getSnapshot();
    const fail = (code: 'conflict' | 'not_found', message: string): WorkbenchResult => ({
      ok: false,
      error: { code, message },
      snapshot: this.publicSnapshot(),
    });
    const w = this.snapshot.workspaces.find((workspace) => workspace.workspaceId === c.workspaceId);
    if (!w?.sessions.some((session) => session.sessionId === c.sessionId)) return fail('not_found', '会话不存在');
    const run = w.runs.findLast((r) => r.sessionId === c.sessionId && activeStates.includes(r.state));
    const request = run?.conversation?.permissionRequests?.find((item) => item.requestId === c.requestId);
    if (!run || run.state === 'cancelling' || !request) return fail('conflict', '权限请求已结束或不属于该会话的当前执行');
    if (c.optionId !== null && !request.options.some((option) => option.optionId === c.optionId))
      return fail('conflict', '选项不属于该权限请求');
    try {
      await this.runtime.answerPermission(c.sessionId, c.requestId, c.optionId);
    } catch (error) {
      return fail('conflict', error instanceof Error ? error.message : String(error));
    }
    return this.result();
  }
  private async reconcileRunCleanup(workspaceId: string, runId: string): Promise<WorkbenchResult> {
    await this.getSnapshot();
    this.run(this.requireWorkspace(workspaceId), runId);
    await this.appControl?.reconcileRun(workspaceId, runId);
    await this.getSnapshot();
    return this.result();
  }
  private releaseObservationScope(workspace: WorkspaceSnapshot, runId: string) {
    this.captureRunSource(workspace, this.run(workspace, runId));
    this.appControl?.releaseRun(runId);
    this.observationScopes.delete(runId);
    this.observationCounts.delete(runId);
    for (const session of workspace.sessions)
      for (const record of session.observations)
        if (record.request.runId === runId && record.state === 'pending') this.observations.get(record.request.requestId)?.abort();
  }
  onConversation(conversation: ChatConversation) {
    void this.updateRuntime(() => {
      const w = this.snapshot.workspaces.find((w) => w.sessions.some((s) => s.sessionId === conversation.conversationId));
      if (!w) return null;
      this.applyConversation(w, conversation);
      return w;
    });
  }
  onTerminal(resourceId: string, snapshot: TerminalSnapshot, binding: ResourceInstanceIdentity) {
    let batch = false;
    void this.updateRuntime(
      () => {
        const w = this.snapshot.workspaces.find((w) => w.workspaceId === binding.workspaceId);
        const r = w?.resources.find((r) => r.resourceId === resourceId);
        if (
          !w ||
          !r ||
          r.environmentId !== binding.environmentId ||
          r.instanceId !== binding.instanceId ||
          r.generation !== binding.instanceGeneration
        )
          return null;
        if (r.terminal?.sessionId && snapshot.sessionId !== r.terminal.sessionId) return null;
        if (r.terminal?.sessionId === snapshot.sessionId && r.terminal.seq >= snapshot.seq) return null;
        batch =
          r.terminal?.sessionId === snapshot.sessionId &&
          r.terminal.state === snapshot.state &&
          r.terminal.cleanupPending === snapshot.cleanupPending &&
          r.terminal.error === snapshot.error;
        r.terminal = r.terminal?.state === 'closing' && snapshot.cleanupPending ? { ...snapshot, state: 'closing' } : snapshot;
        return w;
      },
      () => batch,
    );
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
  private updateRuntime(update: () => WorkspaceSnapshot | null, batch: boolean | (() => boolean) = false) {
    const next = this.queue.then(async () => {
      await this.ready;
      const w = update();
      if (!w) return;
      this.snapshot.seq++;
      if (typeof batch === 'function' ? batch() : batch) {
        if (this.emissionTimer === null)
          this.emissionTimer = setTimeout(() => {
            this.emissionTimer = null;
            this.emitSnapshot(w.workspaceId, w.workspaceId);
          }, 50);
      } else {
        await this.saveState(this.snapshot);
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
