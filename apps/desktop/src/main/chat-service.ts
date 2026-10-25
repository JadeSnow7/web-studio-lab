import { AppImportOutcomeSchema, type AppImportRequest, type AppImportTarget } from '@wsl/protocol';
import path from 'node:path';
import { RunDispatchFailure } from './workbench/ports';
import { randomUUID } from 'node:crypto';
import { app, utilityProcess, type UtilityProcess } from 'electron';
import {
  ManagedAppSchema,
  AppSourceSchema,
  AppSourceApplyResultSchema,
  AppSourceSnapshotResultSchema,
  type AppSourceApplyResult,
  type AppSourceSnapshotResult,
  type AppTarget,
  type AppSource,
  type ManagedApp,
  EnvironmentListSchema,
  ServiceRuntimeConfigSchema,
  type ServiceRuntimeConfig,
  ObservationResultSchema,
  type ResourceInstanceIdentity,
  type ObservationRequest,
  type ObservationTurnScope,
  type WorkspaceObservationResult,
  type FileInvalidationHint,
  type CatalogReferenceSnapshot,
  ChatConversationSchema,
  TerminalSnapshotSchema,
  type TerminalSnapshot,
  ChatServiceMessageSchema,
  type ChatServiceMessage,
  ChatServiceRequestSchema,
  ChatStatusSchema,
  type ChatConversation,
  type ChatServiceRequest,
  type ChatSlot,
  type ChatStatus,
  AppAgentResultSchema,
  AppLogsSchema,
  type AppAgentOperation,
  type AppControlResult,
  type HarnessAvailability,
  type ProfileCheckResult,
  type ProfileDir,
  type TurnHarness,
  ProfileCheckResultSchema,
} from '@wsl/protocol';
import { GuestWriteLease } from './workbench/guest-write-lease';

export class ChatService {
  private child: UtilityProcess;
  /** 所有会话槽共享同一个 guest 工作目录；轮次发送前在此取得写入许可。 */
  private readonly writeLease = new GuestWriteLease();
  private readonly managedApps = new Map<string, ManagedApp>();
  private appListener: ((snapshot: ManagedApp) => void) | null = null;
  setAppListener(listener: (snapshot: ManagedApp) => void) {
    this.appListener = listener;
  }
  private readonly pending = new Map<
    string,
    {
      resolve: (result: unknown) => void;
      reject: (error: Error) => void;
      resourceId?: string;
      conversationSlot?: ChatSlot;
      start: { kind: 'chat'; slot: ChatSlot; seq: number } | { kind: 'terminal'; seq: number; resourceId: string } | null;
    }
  >();
  private readonly sourceCleanup = new Set<string>();
  private unknownCleanup = false;
  private initializationPending = true;
  private failure: string | null = null;
  private stopped = false;
  private shutdownResult: Promise<void> | null = null;
  private readonly exit: Promise<void>;
  private readonly conversations = new Map<ChatSlot, ChatConversation>();
  private sequence = 0;
  private readonly terminals = new Map<string, TerminalSnapshot>();
  private readonly resourceBindings = new Map<string, ResourceInstanceIdentity>();
  private observationReader:
    | ((
        scope: ObservationTurnScope,
        tool: string,
        args: Record<string, unknown>,
        signal: AbortSignal,
      ) => Promise<WorkspaceObservationResult>)
    | null = null;
  private readonly observationCalls = new Map<string, AbortController>();
  setObservationReader(reader: NonNullable<ChatService['observationReader']>) {
    this.observationReader = reader;
  }
  private appControlReader:
    ((scope: ObservationTurnScope, tool: string, args: Record<string, unknown>, signal: AbortSignal) => Promise<AppControlResult>) | null =
    null;
  private readonly appCalls = new Map<string, AbortController>();
  setAppControlReader(reader: NonNullable<ChatService['appControlReader']>) {
    this.appControlReader = reader;
  }
  private lastStatus: ChatStatus | null = null;
  /** W4/W6a/W8 workflow：workflow-event/workflow-done/workflow-candidate/workflow-lanebase 消息的接收方（ServiceWorkflowEnginePort 注册）。 */
  private workflowListener:
    | ((
        message: Extract<
          ChatServiceMessage,
          { type: 'workflow-event' | 'workflow-done' | 'workflow-cleanup-unconfirmed' | 'workflow-candidate' | 'workflow-lanebase' }
        >,
      ) => void)
    | null = null;
  setWorkflowListener(listener: NonNullable<ChatService['workflowListener']>) {
    this.workflowListener = listener;
  }
  /** 服务退出/通信失败监听；workflow port 据此结清未收到 workflow-done 的 run。 */
  private readonly exitListeners = new Set<() => void>();
  onExit(listener: () => void) {
    this.exitListeners.add(listener);
  }
  /** W4：workflow 引擎端口复用的具名请求通道；只暴露给 workflow port，不扩散通用 RPC。 */
  workflowRequest(
    request:
      | Omit<Extract<ChatServiceRequest, { method: 'workflow-run' }>, 'id'>
      | Omit<Extract<ChatServiceRequest, { method: 'workflow-stop' }>, 'id'>
      | Omit<Extract<ChatServiceRequest, { method: 'workflow-shutdown' }>, 'id'>
      | Omit<Extract<ChatServiceRequest, { method: 'workflow-event-ack' }>, 'id'>
      | Omit<Extract<ChatServiceRequest, { method: 'workflow-candidate.reply' }>, 'id'>
      | Omit<Extract<ChatServiceRequest, { method: 'workflow-lanebase.reply' }>, 'id'>,
  ): Promise<unknown> {
    return this.request(request);
  }
  constructor(
    private readonly onConversation: (conversation: ChatConversation) => void,
    private readonly onStatus: (status: ChatStatus) => void,
    private readonly onTerminal: (snapshot: TerminalSnapshot, resourceId: string, binding: ResourceInstanceIdentity) => void = () =>
      undefined,
    private readonly onFileHint: (hint: FileInvalidationHint) => void = () => undefined,
    runtime?: ServiceRuntimeConfig,
  ) {
    const entry = app.isPackaged
      ? path.join(process.resourcesPath, 'service/index.cjs')
      : path.resolve(app.getAppPath(), '../service/out/index.cjs');
    if (app.isPackaged && !runtime) throw new Error('正式包缺少运行配置');
    const args = [path.join(app.getPath('userData'), 'chat')];
    if (runtime) args.push(JSON.stringify(ServiceRuntimeConfigSchema.parse(runtime)));
    this.child = utilityProcess.fork(entry, args, { serviceName: 'Codex 对话', stdio: 'pipe' });
    this.exit = new Promise((resolve) =>
      this.child.once('exit', (code) => {
        this.fail(`对话服务已退出（${code}）`);
        resolve();
      }),
    );
    this.child.on('message', (raw: unknown) => {
      try {
        const message = ChatServiceMessageSchema.parse(raw);
        if (message.type === 'app-event') {
          this.managedApps.set(message.snapshot.projectId, message.snapshot);
          this.appListener?.(message.snapshot);
          return;
        }
        if (message.type === 'initialized') {
          this.initializationPending = message.cleanupPending;
          this.lastStatus = message.status;
          this.onStatus(message.status);
          return;
        }
        if (message.type === 'app-abort') {
          this.appCalls.get(message.id)?.abort();
          return;
        }
        if (message.type === 'app-call') {
          if (this.appCalls.has(message.id)) throw new Error('控制面调用身份重复');
          const controller = new AbortController();
          this.appCalls.set(message.id, controller);
          const call: Promise<AppControlResult> = this.appControlReader
            ? this.appControlReader(message.scope, message.tool, message.args, controller.signal)
            : Promise.resolve({ ok: false, tool: message.tool, error: { code: 'unsupported', message: 'Main控制面未接入' } });
          void call
            .then(
              (result) => this.request({ method: 'app.reply', payload: { callId: message.id, result } }),
              (error) =>
                this.request({
                  method: 'app.reply',
                  payload: {
                    callId: message.id,
                    result: { ok: false, tool: message.tool, error: { code: 'unavailable', message: (error as Error).message } },
                  },
                }),
            )
            .then(
              () => {
                this.appCalls.delete(message.id);
              },
              (error) => {
                this.appCalls.delete(message.id);
                this.fail('控制面返回通道失败：' + (error as Error).message);
              },
            );
          return;
        }
        if (message.type === 'observation-abort') {
          this.observationCalls.get(message.id)?.abort();
          return;
        }
        if (message.type === 'observation-call') {
          if (this.observationCalls.has(message.id)) throw new Error('观察调用身份重复');
          const controller = new AbortController();
          this.observationCalls.set(message.id, controller);
          const read = this.observationReader
            ? this.observationReader(message.scope, message.tool, message.args, controller.signal)
            : Promise.resolve({ error: 'unavailable' as const, message: 'Main观察通道未接入' });
          void read
            .then(
              (result) => this.request({ method: 'observation.reply', payload: { callId: message.id, result } }),
              (error) =>
                this.request({
                  method: 'observation.reply',
                  payload: { callId: message.id, result: { error: 'unavailable', message: (error as Error).message } },
                }),
            )
            .then(
              () => {
                this.observationCalls.delete(message.id);
              },
              (error) => {
                this.observationCalls.delete(message.id);
                this.fail('观察返回通道失败：' + (error as Error).message);
              },
            );
          return;
        }
        if (message.type === 'event') {
          this.remember(message.conversation);
          this.onConversation(message.conversation);
          return;
        }
        if (message.type === 'terminal-event') {
          const binding = this.resourceBindings.get(message.resourceId);
          if (!binding || (Object.keys(binding) as (keyof ResourceInstanceIdentity)[]).some((key) => binding[key] !== message.binding[key]))
            return;
          this.terminals.set(message.resourceId, message.terminal);
          this.onTerminal(message.terminal, message.resourceId, message.binding);
          return;
        }
        if (message.type === 'file-hint') {
          this.onFileHint(message.hint);
          return;
        }
        if (
          message.type === 'workflow-event' ||
          message.type === 'workflow-done' ||
          message.type === 'workflow-cleanup-unconfirmed' ||
          message.type === 'workflow-candidate' ||
          message.type === 'workflow-lanebase'
        ) {
          this.workflowListener?.(message);
          return;
        }
        const request = this.pending.get(message.id);
        if (!request) throw new Error('对话服务返回未知请求身份');
        this.pending.delete(message.id);
        if (message.type === 'error') {
          const start = request.start;
          if (start?.kind === 'chat') {
            const current = this.conversations.get(start.slot);
            // Service publishes a new conversation before starting its executor.
            // An ordered error reply without that publication is a rejected admission.
            const admitted = Boolean(current && current.seq > start.seq);
            request.reject(new RunDispatchFailure(message.error, admitted && Boolean(current?.cleanupPending), !admitted));
          } else request.reject(new Error(message.error));
        } else {
          if (request.conversationSlot || (message.result && 'conversationId' in message.result)) {
            const conversation = ChatConversationSchema.safeParse(message.result);
            if (!request.conversationSlot || !conversation.success || conversation.data.conversationId !== request.conversationSlot) {
              // Validate both method and slot before publishing shared cleanup facts.
              // Source RPCs and foreign get/cancel/reset replies cannot affect a send.
              if (request.start?.kind === 'chat') {
                this.unknownCleanup = true;
                request.reject(new RunDispatchFailure('对话启动回执形状或归属不匹配', true));
              } else request.reject(new Error('对话回执方法、形状或归属不匹配'));
              return;
            }
            this.remember(conversation.data);
          }
          if (message.result && 'sessionId' in message.result) {
            if (request.resourceId) {
              const before = this.terminals.get(request.resourceId);
              if (!before || before.seq < message.result.seq) this.terminals.set(request.resourceId, message.result);
            }
          }
          request.resolve(message.result);
        }
      } catch (error) {
        this.fail(`对话服务通信失败：${(error as Error).message}`);
        this.child.kill();
      }
    });
  }
  private remember(conversation: ChatConversation) {
    this.sequence = Math.max(this.sequence, conversation.seq);
    if ((this.conversations.get(conversation.conversationId)?.seq ?? -1) < conversation.seq) {
      this.conversations.set(conversation.conversationId, conversation);
      this.writeLease.observe(conversation);
    }
  }
  private fail(reason: string) {
    for (const controller of this.observationCalls.values()) controller.abort();
    for (const controller of this.appCalls.values()) controller.abort();
    this.failure ??= reason;
    for (const listener of this.exitListeners) listener();
    for (const current of this.managedApps.values()) {
      if (current.state === 'running' || current.state === 'starting' || current.state === 'stopping') {
        const failed: ManagedApp = {
          ...current,
          state: 'failed',
          url: null,
          error: reason + '；应用进程清理未确认',
          cleanupConfirmed: false,
        };
        this.managedApps.set(current.projectId, failed);
        this.appListener?.(failed);
      }
    }
    for (const request of this.pending.values()) {
      const start = request.start;
      if (!start) continue;
      const current = start.kind === 'chat' ? this.conversations.get(start.slot) : this.terminals.get(start.resourceId);
      // 新快照的清理确认可解除尚未收到 ACK 的启动请求占用。
      if (!current || current.seq <= start.seq || current.cleanupPending) this.unknownCleanup = true;
    }
    for (const request of this.pending.values()) {
      const start = request.start;
      if (start?.kind === 'chat') {
        const current = this.conversations.get(start.slot);
        request.reject(new RunDispatchFailure(this.failure, !current || current.seq <= start.seq || current.cleanupPending));
      } else request.reject(new Error(this.failure));
    }

    this.pending.clear();
    if (this.stopped) return;
    this.onStatus({
      available: false,
      reason:
        this.initializationPending ||
        this.unknownCleanup ||
        this.sourceCleanup.size > 0 ||
        [...this.conversations.values()].some((conversation) => conversation.cleanupPending) ||
        [...this.terminals.values()].some((t) => t.cleanupPending)
          ? this.failure + '；guest 清理未确认'
          : this.failure,
      version: null,
      sandbox: this.lastStatus?.sandbox ?? null,
      cwd: this.lastStatus?.cwd ?? null,
      harnesses: this.unavailableHarnesses(this.failure),
    });
    for (const [resourceId, terminal] of this.terminals) {
      const binding = this.resourceBindings.get(resourceId);
      if (terminal.cleanupPending && binding)
        this.onTerminal(
          { ...terminal, seq: terminal.seq + 1, state: 'failed', error: this.failure + '；guest 清理未确认' },
          resourceId,
          binding,
        );
    }
    for (const conversation of this.conversations.values()) {
      if (conversation.cleanupPending) {
        this.onConversation({ ...conversation, seq: ++this.sequence, state: 'failed', error: this.failure + '；guest 清理未确认' });
      }
    }
  }

  private request(
    request: ChatServiceRequest extends infer R ? (R extends { id: string } ? Omit<R, 'id'> : never) : never,
  ): Promise<unknown> {
    if (this.stopped && request.method !== 'shutdown') return Promise.reject(new Error('对话服务正在关闭'));
    if (this.failure) return Promise.reject(new Error(this.failure));
    const data = ChatServiceRequestSchema.parse({ ...request, id: randomUUID() });
    return new Promise((resolve, reject) => {
      const start =
        data.method === 'send'
          ? {
              kind: 'chat' as const,
              slot: data.payload.conversationId,
              seq: this.conversations.get(data.payload.conversationId)?.seq ?? -1,
            }
          : data.method === 'terminal.open'
            ? {
                kind: 'terminal' as const,
                resourceId: data.payload.resourceId,
                seq: this.terminals.get(data.payload.resourceId)?.seq ?? -1,
              }
            : null;
      const resourceId =
        data.method === 'terminal.get'
          ? data.resourceId
          : 'payload' in data && 'resourceId' in data.payload
            ? data.payload.resourceId
            : undefined;
      const conversationSlot =
        data.method === 'get' ||
        data.method === 'send' ||
        data.method === 'cancel' ||
        data.method === 'reset' ||
        data.method === 'permission.reply'
          ? data.payload.conversationId
          : undefined;
      this.pending.set(data.id, { resolve, reject, start, resourceId, conversationSlot });
      try {
        this.child.postMessage(data);
      } catch (error) {
        // A throwing transport cannot prove that the message did not reach the service.
        this.pending.delete(data.id);
        if (start) this.unknownCleanup = true;
        const reason = error instanceof Error ? error.message : '对话服务传输失败';
        reject(start?.kind === 'chat' ? new RunDispatchFailure(reason, true) : new Error(reason));
      }
    });
  }
  async environmentsList() {
    return EnvironmentListSchema.parse(await this.request({ method: 'environments.list' }));
  }
  async registerResource(binding: ResourceInstanceIdentity) {
    await this.request({ method: 'resource.register', payload: binding });
    const previous = this.resourceBindings.get(binding.resourceId);
    if (previous && (previous.instanceId !== binding.instanceId || previous.instanceGeneration !== binding.instanceGeneration))
      this.terminals.delete(binding.resourceId);
    this.resourceBindings.set(binding.resourceId, binding);
  }
  async releaseResource(binding: ResourceInstanceIdentity) {
    await this.request({ method: 'resource.release', payload: binding });
    this.resourceBindings.delete(binding.resourceId);
  }
  async appSourceSnapshot(target: AppTarget, signal: AbortSignal): Promise<AppSourceSnapshotResult> {
    if (signal.aborted || this.stopped || this.failure)
      return { ok: false, target, cleanupConfirmed: true, error: '源码采集已取消或服务不可用；未发送采集请求' };
    const callId = randomUUID();
    this.sourceCleanup.add(callId);
    const cancel = () => {
      void this.request({ method: 'app.source.cancel', payload: { callId } }).catch(() => undefined);
    };
    signal.addEventListener('abort', cancel, { once: true });
    try {
      const result = AppSourceSnapshotResultSchema.parse(
        await this.request({ method: 'app.source.snapshot', payload: { callId, target } }),
      );
      const identity = result.ok ? result.snapshot : result.target;
      if (identity.workspaceId !== target.workspaceId || identity.projectId !== target.projectId) throw new Error('源码回执归属不匹配');
      if (result.cleanupConfirmed) this.sourceCleanup.delete(callId);
      return result;
    } catch {
      return { ok: false, target, cleanupConfirmed: false, error: '源码 helper 回执无效或传输中断；清理未确认' };
    } finally {
      signal.removeEventListener('abort', cancel);
      // The owned snapshot receipt decides cleanup. A delayed cancellation ACK
      // remains registered in pending, but cannot hold an already-clean helper.
    }
  }
  /** W6b：候选应用——与 appSourceSnapshot 同一取消/清理确认模型；回执身份必须等于请求目标。 */
  async appSourceApply(target: AppTarget, files: AppSource['files'], signal: AbortSignal): Promise<AppSourceApplyResult> {
    if (signal.aborted || this.stopped || this.failure)
      return { ok: false, target, cleanupConfirmed: true, error: '源码应用已取消或服务不可用；未发送应用请求' };
    const callId = randomUUID();
    this.sourceCleanup.add(callId);
    const cancel = () => {
      void this.request({ method: 'app.source.cancel', payload: { callId } }).catch(() => undefined);
    };
    signal.addEventListener('abort', cancel, { once: true });
    try {
      const result = AppSourceApplyResultSchema.parse(
        await this.request({ method: 'app.source.apply', payload: { callId, target, files } }),
      );
      if (result.target.workspaceId !== target.workspaceId || result.target.projectId !== target.projectId)
        throw new Error('源码回执归属不匹配');
      if (result.cleanupConfirmed) this.sourceCleanup.delete(callId);
      return result;
    } catch {
      return { ok: false, target, cleanupConfirmed: false, error: '源码 helper 回执无效或传输中断；清理未确认' };
    } finally {
      signal.removeEventListener('abort', cancel);
    }
  }
  async appGet(target: AppTarget) {
    const snapshot = ManagedAppSchema.parse(await this.request({ method: 'app.get', payload: target }));
    this.managedApps.set(target.projectId, snapshot);
    return snapshot;
  }
  async appImportSource(request: AppImportRequest) {
    const result = AppImportOutcomeSchema.parse(await this.request({ method: 'app.importSource', payload: request }));
    if (result.app) this.managedApps.set(request.projectId, result.app);
    return result;
  }
  async appCancelImport(target: AppImportTarget) {
    const result = AppImportOutcomeSchema.parse(await this.request({ method: 'app.cancelImport', payload: target }));
    if (result.app) this.managedApps.set(target.projectId, result.app);
    else if (result.outcome === 'cancelled') this.managedApps.delete(target.projectId);
    return result;
  }
  async appCreate(target: AppTarget, files: AppSource['files']) {
    const snapshot = ManagedAppSchema.parse(await this.request({ method: 'app.create', payload: { ...target, files } }));
    this.managedApps.set(target.projectId, snapshot);
    return snapshot;
  }
  async appStart(target: AppTarget) {
    const previous = this.managedApps.get(target.projectId);
    if (previous) this.managedApps.set(target.projectId, { ...previous, state: 'starting', cleanupConfirmed: false });
    const snapshot = ManagedAppSchema.parse(await this.request({ method: 'app.start', payload: target }));
    this.managedApps.set(target.projectId, snapshot);
    return snapshot;
  }
  async appStop(target: AppTarget) {
    const snapshot = ManagedAppSchema.parse(await this.request({ method: 'app.stop', payload: target }));
    this.managedApps.set(target.projectId, snapshot);
    return snapshot;
  }
  async appExport(target: AppTarget) {
    return AppSourceSchema.parse(await this.request({ method: 'app.export', payload: target }));
  }
  /** 控制面后端操作；取消时通知 service 关闭所属 guest 进程并等待其回执。 */
  async appAgent(target: AppTarget, appInstanceId: string | null, operation: AppAgentOperation, signal: AbortSignal) {
    if (signal.aborted)
      return {
        mode: 'http' as const,
        cleanupConfirmed: true,
        ...(operation.op !== 'reconcile' && operation.op !== 'reconcile-cli' ? { operationDispatched: false as const } : {}),
        envelope: { ok: false as const, error: { code: 'cancelled', message: '控制面请求已取消' } },
      };
    const callId = randomUUID();
    const cancel = () => void this.request({ method: 'app.agent.cancel', payload: { callId } }).catch(() => undefined);
    signal.addEventListener('abort', cancel, { once: true });
    try {
      return AppAgentResultSchema.parse(await this.request({ method: 'app.agent', payload: { callId, target, appInstanceId, operation } }));
    } finally {
      signal.removeEventListener('abort', cancel);
    }
  }
  async appLogs(target: AppTarget, maxBytes: number) {
    return AppLogsSchema.parse(await this.request({ method: 'app.logs', payload: { target, maxBytes } }));
  }
  async observe(request: ObservationRequest) {
    return ObservationResultSchema.parse(await this.request({ method: 'observation.read', payload: request }));
  }
  async cancelObservation(requestId: string) {
    await this.request({ method: 'observation.cancel', payload: { requestId } });
  }
  async status() {
    if (this.failure)
      return {
        available: false,
        reason: this.failure,
        version: null,
        sandbox: this.lastStatus?.sandbox ?? null,
        cwd: this.lastStatus?.cwd ?? null,
        harnesses: this.unavailableHarnesses(this.failure),
      };
    this.lastStatus = ChatStatusSchema.parse(await this.request({ method: 'status' }));
    return this.lastStatus;
  }
  async register(id: ChatSlot, workspaceId: string) {
    await this.request({ method: 'register', payload: { conversationId: id, workspaceId } });
  }
  async get(id: ChatSlot) {
    return ChatConversationSchema.parse(await this.request({ method: 'get', payload: { conversationId: id } }));
  }
  /** 对话服务最近一次报告的全部 Harness 及可用性；服务未初始化时为空（W4a）。 */
  harnesses(): HarnessAvailability[] {
    if (this.failure) return this.unavailableHarnesses(this.failure);
    return this.lastStatus?.harnesses ?? [];
  }
  /** 服务失败时，已知的 Harness 都不可用，原因与服务失败相同。 */
  private unavailableHarnesses(reason: string): HarnessAvailability[] {
    return (this.lastStatus?.harnesses ?? []).map((item) => ({ ...item, available: false, reason }));
  }
  /** 无模型自检一个 Profile（W4a）；结果只含版本与登录状态。 */
  async checkProfile(harnessId: string, profileDir: ProfileDir | null): Promise<ProfileCheckResult> {
    return ProfileCheckResultSchema.parse(await this.request({ method: 'profile.check', payload: { harnessId, profileDir } }));
  }
  /** 当前持有 guest 工作区写入许可的会话槽；无人持有时为 null。 */
  writeHolder(): ChatSlot | null {
    return this.writeLease.current();
  }
  async send(
    id: ChatSlot,
    text: string,
    observationScope: ObservationTurnScope | undefined,
    references: CatalogReferenceSnapshot,
    harness: TurnHarness,
  ) {
    // 服务已失败或正在关闭时不取得许可，让请求按原有原因拒绝，避免用写入冲突掩盖真实故障。
    if (this.stopped || this.failure) throw new RunDispatchFailure(this.failure ?? '对话服务正在关闭', false, true);
    this.writeLease.acquire(id, this.conversations.get(id)?.seq ?? -1);
    try {
      const result = ChatConversationSchema.parse(
        await this.request({ method: 'send', payload: { conversationId: id, text, observationScope, references, harness } }),
      );
      if (result.conversationId !== id) throw new Error('对话启动回执归属不匹配');
      return result;
    } catch (error) {
      if (error instanceof RunDispatchFailure) {
        // 只有判定为从未启动的拒绝才按最新快照尝试释放；已接纳但清理未知或通信失败时保留许可，
        // 已接纳且已确认清理的轮次由 remember() 采信的新快照经 observe 释放。
        if (error.knownNotSent) this.writeLease.sendRejected(id, this.conversations.get(id));
        throw error;
      }
      this.unknownCleanup = true;
      throw new RunDispatchFailure(error instanceof Error ? error.message : '对话启动回执无效', true);
    }
  }
  /** 回复权限请求（W4b）；service 核对请求仍待决后答复 Agent，返回的新快照已移除该请求。 */
  async answerPermission(id: ChatSlot, requestId: string, optionId: string | null) {
    return ChatConversationSchema.parse(
      await this.request({ method: 'permission.reply', payload: { conversationId: id, requestId, optionId } }),
    );
  }
  async cancel(id: ChatSlot) {
    return ChatConversationSchema.parse(await this.request({ method: 'cancel', payload: { conversationId: id } }));
  }
  async reset(id: ChatSlot) {
    return ChatConversationSchema.parse(await this.request({ method: 'reset', payload: { conversationId: id } }));
  }
  async terminalGet(resourceId: string) {
    return TerminalSnapshotSchema.parse(await this.request({ method: 'terminal.get', resourceId }));
  }
  async terminalOpen(cols: number, rows: number, resourceId: string) {
    return TerminalSnapshotSchema.parse(await this.request({ method: 'terminal.open', payload: { cols, rows, resourceId } }));
  }
  async terminalWrite(sessionId: string, data: string, resourceId: string) {
    await this.request({ method: 'terminal.write', payload: { sessionId, data, resourceId } });
  }
  async terminalResize(sessionId: string, cols: number, rows: number, resourceId: string) {
    await this.request({ method: 'terminal.resize', payload: { sessionId, cols, rows, resourceId } });
  }
  async terminalClose(sessionId: string, resourceId: string) {
    return TerminalSnapshotSchema.parse(await this.request({ method: 'terminal.close', payload: { sessionId, resourceId } }));
  }
  shutdown(): Promise<void> {
    if (this.shutdownResult) return this.shutdownResult;
    this.stopped = true;
    this.shutdownResult = (async () => {
      if (
        this.failure &&
        (this.initializationPending ||
          this.unknownCleanup ||
          this.sourceCleanup.size > 0 ||
          [...this.conversations.values()].some((conversation) => conversation.cleanupPending) ||
          [...this.terminals.values()].some((t) => t.cleanupPending))
      )
        throw new Error(this.failure + '；guest 清理未确认');
      if (!this.failure) {
        try {
          await this.request({ method: 'shutdown' });
          // 只在远端清理已确认的ACK到达后结束已无guest进程的本地服务。
          this.child.kill();
        } catch (error) {
          this.onStatus({
            available: false,
            reason: `guest 清理失败：${(error as Error).message}`,
            version: null,
            harnesses: this.unavailableHarnesses(`guest 清理失败：${(error as Error).message}`),
            sandbox: this.lastStatus?.sandbox ?? null,
            cwd: this.lastStatus?.cwd ?? null,
          });
          throw error;
        }
      }
      await this.exit;
    })().catch((error: unknown) => {
      this.shutdownResult = null;
      throw error;
    });
    return this.shutdownResult;
  }
}
