import { createHash, randomUUID } from 'node:crypto';
import {
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
  private resourceRefresh: Promise<void> | null = null;
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
    if (
      command.type === 'startRun' ||
      command.type === 'terminalOpen' ||
      (command.type === 'createTab' && ['file', 'terminal', 'ssh'].includes(command.kind))
    )
      return this.environments().then(() => this.enqueueCommand(command));
    return this.enqueueCommand(command);
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
    return next;
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
          await this.repository.save(this.snapshot);
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
        await this.repository.save(this.snapshot);
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
            if (['file', 'terminal', 'ssh'].includes(c.kind)) {
              if (!c.environmentId) throw new Error('invalid_input: 请选择已配置环境');
              const environment = this.snapshot.environments.find((e) => e.environmentId === c.environmentId);
              const capability = c.kind === 'file' ? 'files' : 'terminal';
              if (!environment?.capabilities[capability] || (c.kind === 'ssh' && c.environmentId !== 'ssh'))
                throw new Error('unsupported: 该环境未配置此资源能力');
            }
            if (c.kind === 'web' && c.environmentId && c.environmentId !== 'local') throw new Error('unsupported: 原生网页属于本设备');
            const tab = this.createResource(w, c.kind, c.title, c.url, c.environmentId ?? (c.kind === 'web' ? 'local' : null));
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
          case 'startRun':
            await this.startRun(w, c.sessionId, c.taskVersionId);
            break;
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
      await this.repository.save(this.snapshot);
    } catch (error) {
      w.runs = previousRuns;
      this.runLogBaselines.delete(run.runId);
      this.observationScopes.delete(run.runId);
      this.observationCounts.delete(run.runId);
      throw error;
    }
    try {
      await this.runtime.registerSession(sessionId, w.workspaceId);
      const conversation = await this.runtime.send(
        sessionId,
        `任务版本 ${v.taskVersionId}\n空间 ${w.workspaceId}\n目标 ${JSON.stringify(v.targetRef)}\n上下文 ${v.capture?.element.text ?? '未附加'}\n允许范围 ${v.allowedScopes.join(', ')}\n验收条件 ${v.acceptance.join('; ')}\n\n${v.goal}`,
        structuredClone(scope),
      );
      this.applyConversation(w, conversation);
    } catch (error) {
      run.state = 'failed';
      run.error = (error as Error).message;
      run.endedAt = new Date().toISOString();
      this.runLogBaselines.delete(run.runId);
      this.releaseObservationScope(w, run.runId);
    }
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
          }, true),
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
          }, true),
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
          }, true),
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
          }, true),
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
      this.releaseObservationScope(w, run.runId);
    }
  }
  private releaseObservationScope(workspace: WorkspaceSnapshot, runId: string) {
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
    void this.updateRuntime(() => {
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
      r.terminal = r.terminal?.state === 'closing' && snapshot.cleanupPending ? { ...snapshot, state: 'closing' } : snapshot;
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
