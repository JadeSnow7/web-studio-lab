import type { EduTaskBinding } from '@wsl/protocol';
import path from 'node:path';
import { isDeepStrictEqual } from 'node:util';
import { randomUUID } from 'node:crypto';
import { app, utilityProcess, type UtilityProcess } from 'electron';
import { RunDispatchFailure } from './workbench/ports';
import {
  ResearchCallSchema,
  ResearchReplySchema,
  ResearchGrantSchema,
  type ResearchCall,
  type ResearchReply,
  type ResearchGrant,
  MotaTaskBindingSchema,
  MotaTaskDispatchRejectionSchema,
  MotaControlRequestSchema,
  MotaControlResponseSchema,
  type MotaTaskBinding,
  type MotaControlRequest,
  type MotaControlResponse,
  EduTaskBindingSchema,
  EduTaskDispatchRejectionSchema,
  EduTaskOperationResultSchema,
  type EduTaskOperation,
  type EduTaskOperationResult,
  EduVerificationStatusSchema,
  EduAdmissionRecoveryStatusSchema,
  type EduAdmissionRecoveryStatus,
  type EduVerificationBegin,
  type EduVerificationTarget,
  type EduVerificationStatus,
  ManagedAppSchema,
  AppImportOutcomeSchema,
  type AppImportRequest,
  type AppImportTarget,
  AppSourceSchema,
  AppSourceSnapshotResultSchema,
  type AppSourceSnapshotResult,
  type AppTarget,
  type AppSource,
  type EduImport,
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
} from '@wsl/protocol';

export class ChatService {
  private child: UtilityProcess;
  private readonly managedApps = new Map<string, ManagedApp>();
  private verificationListener: ((status: EduVerificationStatus) => void) | null = null;
  private verification: EduVerificationStatus | null = null;
  private admissionRecovery: EduAdmissionRecoveryStatus | null = null;
  private admissionListener: ((status: EduAdmissionRecoveryStatus) => void) | null = null;
  setAdmissionRecoveryListener(listener: (status: EduAdmissionRecoveryStatus) => void) {
    this.admissionListener = listener;
    if (this.admissionRecovery) listener(this.admissionRecovery);
  }
  private readonly completedVerificationSessions = new Set<string>();
  private verificationGuard: (() => boolean) | null = null;
  setVerificationGuard(guard: () => boolean) {
    this.verificationGuard = guard;
  }
  private assertMaintenance(): void {
    if (this.verificationGuard?.() || this.verification?.maintenanceLocked || this.admissionRecovery?.maintenanceLocked)
      throw new Error('发音验证期间维护已暂停；请先退出验证并确认恢复');
  }
  setVerificationListener(listener: (status: EduVerificationStatus) => void) {
    this.verificationListener = listener;
    if (this.verification) listener(this.verification);
  }
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
      start: { kind: 'chat'; slot: ChatSlot; seq: number } | { kind: 'terminal'; seq: number; resourceId: string } | null;
    }
  >();
  private readonly sourceCleanup = new Set<string>();
  private readonly eduTaskCleanup = new Map<string, string>();
  private readonly motaCleanup = new Set<string>();
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
  private researchReader: ((call: ResearchCall, signal: AbortSignal) => Promise<ResearchReply>) | null = null;
  private readonly researchCalls = new Map<string, AbortController>();
  setResearchReader(reader: NonNullable<ChatService['researchReader']>) {
    this.researchReader = reader;
  }
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
        if (message.type === 'edu-admission-recovery-event') {
          const next = message.status;
          const previous = this.admissionRecovery;
          if (
            previous?.recoveryId === next.recoveryId &&
            (previous.phase === 'ended' ||
              previous.sourceSha256 !== next.sourceSha256 ||
              JSON.stringify(previous.originalIdentity) !== JSON.stringify(next.originalIdentity) ||
              (previous.phase === 'restoring' && next.phase === 'revoking'))
          )
            return;
          if (previous && previous.recoveryId !== next.recoveryId && previous.maintenanceLocked) return;
          this.admissionRecovery = next;
          this.admissionListener?.(next);
          return;
        }
        if (message.type === 'edu-verification-event') {
          const next = message.status;
          const previous = this.verification;
          if (this.completedVerificationSessions.has(next.lease.sessionId)) return;
          if (previous && previous.lease.sessionId !== next.lease.sessionId && previous.maintenanceLocked) return;
          if (
            previous?.lease.sessionId === next.lease.sessionId &&
            (previous.lease.identity.workspaceId !== next.lease.identity.workspaceId ||
              previous.lease.identity.projectId !== next.lease.identity.projectId ||
              previous.lease.identity.appInstanceId !== next.lease.identity.appInstanceId ||
              previous.lease.sourceSha256 !== next.lease.sourceSha256 ||
              previous.callsUsed > next.callsUsed ||
              (next.phase === 'active' && !['preparing', 'active'].includes(previous.phase)) ||
              (next.phase === 'preparing' && previous.phase !== 'preparing'))
          )
            return;
          this.verification = next;
          if (next.phase === 'ended') this.completedVerificationSessions.add(next.lease.sessionId);
          this.verificationListener?.(next);
          return;
        }
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
        if (message.type === 'research-abort') {
          this.researchCalls.get(message.callId)?.abort();
          return;
        }
        if (message.type === 'research-call') {
          const { type: _type, ...input } = message;
          const call = ResearchCallSchema.parse(input);
          if (this.researchCalls.has(call.callId)) throw new Error('研究调用身份重复');
          const controller = new AbortController();
          this.researchCalls.set(call.callId, controller);
          const failed = (error: unknown): ResearchReply => ({
            callId: call.callId,
            context: call.context,
            result: {
              ok: false,
              tool: call.tool,
              error: {
                code: controller.signal.aborted ? 'cancelled' : 'unavailable',
                message: (error instanceof Error ? error.message : 'Main研究通道未接入').slice(0, 1000) || '研究调用失败',
              },
            },
          });
          void Promise.resolve()
            .then(() => {
              if (!this.researchReader) throw new Error('Main研究通道未接入');
              return this.researchReader(call, controller.signal);
            })
            .then((value) => {
              const reply = ResearchReplySchema.parse(value);
              if (reply.callId !== call.callId || reply.result.tool !== call.tool || !isDeepStrictEqual(reply.context, call.context))
                throw new Error('研究回执归属不匹配');
              return controller.signal.aborted ? failed(new Error('研究已取消')) : reply;
            })
            .catch(failed)
            .then((reply) => this.request({ method: 'research.reply', payload: reply }))
            .then(
              () => {
                this.researchCalls.delete(call.callId);
              },
              (error: unknown) => {
                this.researchCalls.delete(call.callId);
                this.fail('研究返回通道失败：' + (error as Error).message);
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
        const request = this.pending.get(message.id);
        if (!request) throw new Error('对话服务返回未知请求身份');
        this.pending.delete(message.id);
        if (message.type === 'error') request.reject(new Error(message.error));
        else {
          if (message.result && 'conversationId' in message.result) {
            const conversation = ChatConversationSchema.safeParse(message.result);
            if (conversation.success) this.remember(conversation.data);
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
    if ((this.conversations.get(conversation.conversationId)?.seq ?? -1) < conversation.seq)
      this.conversations.set(conversation.conversationId, conversation);
  }
  private fail(reason: string) {
    if (this.admissionRecovery?.maintenanceLocked) {
      this.admissionRecovery = {
        ...this.admissionRecovery,
        phase: 'failed',
        maintenanceLocked: true,
        error: 'verification_service_disconnected',
      };
      this.admissionListener?.(this.admissionRecovery);
    }
    if (this.verification?.maintenanceLocked) {
      this.verification = { ...this.verification, phase: 'failed', maintenanceLocked: true, error: 'verification_service_disconnected' };
      this.verificationListener?.(this.verification);
    }
    for (const controller of this.observationCalls.values()) controller.abort();
    for (const controller of this.researchCalls.values()) controller.abort();
    for (const controller of this.appCalls.values()) controller.abort();
    this.failure ??= reason;
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
        this.eduTaskCleanup.size > 0 ||
        this.motaCleanup.size > 0 ||
        [...this.conversations.values()].some((conversation) => conversation.cleanupPending) ||
        [...this.terminals.values()].some((t) => t.cleanupPending)
          ? this.failure + '；guest 清理未确认'
          : this.failure,
      version: null,
      sandbox: this.lastStatus?.sandbox ?? null,
      cwd: this.lastStatus?.cwd ?? null,
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
      this.pending.set(data.id, { resolve, reject, start, resourceId });
      this.child.postMessage(data);
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
    let cancellation: Promise<unknown> | undefined;
    const cancel = () => {
      cancellation = this.request({ method: 'app.source.cancel', payload: { callId } }).catch(() => undefined);
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
      await cancellation;
    }
  }
  async verificationBegin(input: EduVerificationBegin): Promise<EduVerificationStatus> {
    const result = EduVerificationStatusSchema.parse(await this.request({ method: 'app.verification.begin', payload: input }));
    if (
      result.lease.identity.workspaceId !== input.workspaceId ||
      result.lease.identity.projectId !== input.projectId ||
      result.lease.sourceSha256 !== input.sourceSha256 ||
      result.lease.identity.appInstanceId === input.appInstanceId
    )
      throw new Error('发音验证返回身份或源码不匹配');
    return result;
  }
  private verificationResult(raw: unknown, target: EduVerificationTarget): EduVerificationStatus {
    const result = EduVerificationStatusSchema.parse(raw);
    const lease = result.lease;
    if (
      lease.sessionId !== target.sessionId ||
      lease.identity.workspaceId !== target.workspaceId ||
      lease.identity.projectId !== target.projectId ||
      lease.identity.appInstanceId !== target.appInstanceId
    )
      throw new Error('发音验证返回会话或实例不匹配');
    return result;
  }
  async verificationEnd(target: EduVerificationTarget): Promise<EduVerificationStatus> {
    return this.verificationResult(await this.request({ method: 'app.verification.end', payload: target }), target);
  }
  async verificationRecoverAdmission(original: EduVerificationBegin): Promise<EduAdmissionRecoveryStatus> {
    const result = EduAdmissionRecoveryStatusSchema.parse(
      await this.request({ method: 'app.verification.recoverAdmission', payload: original }),
    );
    if (
      result.originalIdentity.workspaceId !== original.workspaceId ||
      result.originalIdentity.projectId !== original.projectId ||
      result.originalIdentity.appInstanceId !== original.appInstanceId ||
      result.sourceSha256 !== original.sourceSha256
    )
      throw new Error('未接管验证恢复返回的原始身份或源码不匹配');
    return result;
  }
  async verificationReconcile(target: EduVerificationTarget): Promise<EduVerificationStatus> {
    // An explicit recovery may emit a new restoring sequence for an already
    // ended journal; ordinary late active receipts remain rejected.
    this.completedVerificationSessions.delete(target.sessionId);
    return this.verificationResult(await this.request({ method: 'app.verification.reconcile', payload: target }), target);
  }
  async verificationStatus(target: EduVerificationTarget): Promise<EduVerificationStatus> {
    return this.verificationResult(await this.request({ method: 'app.verification.status', payload: target }), target);
  }
  async appGet(target: AppTarget) {
    const snapshot = ManagedAppSchema.parse(await this.request({ method: 'app.get', payload: target }));
    this.managedApps.set(target.projectId, snapshot);
    return snapshot;
  }
  async appCreate(target: AppTarget, files: AppSource['files']) {
    const snapshot = ManagedAppSchema.parse(await this.request({ method: 'app.create', payload: { ...target, files } }));
    this.managedApps.set(target.projectId, snapshot);
    return snapshot;
  }
  async appImportEdu(payload: EduImport) {
    const snapshot = ManagedAppSchema.parse(await this.request({ method: 'app.importEdu', payload }));
    this.managedApps.set(payload.projectId, snapshot);
    return snapshot;
  }
  async appImportSource(payload: AppImportRequest) {
    const result = AppImportOutcomeSchema.parse(await this.request({ method: 'app.importSource', payload }));
    if (result.app) this.managedApps.set(payload.projectId, result.app);
    return result;
  }
  async appCancelImport(payload: AppImportTarget) {
    const result = AppImportOutcomeSchema.parse(await this.request({ method: 'app.cancelImport', payload }));
    if (result.app) this.managedApps.set(payload.projectId, result.app);
    return result;
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
  async appEduTaskSource(target: AppTarget) {
    return AppSourceSchema.parse(await this.request({ method: 'app.taskSource', payload: target }));
  }
  private async eduTaskOperation(input: EduTaskBinding, operation: EduTaskOperation): Promise<EduTaskOperationResult> {
    const binding = EduTaskBindingSchema.parse(input);
    const owner = JSON.stringify(binding);
    const callId = randomUUID();
    this.eduTaskCleanup.set(owner, callId);
    const method = { prepare: 'app.prepareEduTask', apply: 'app.applyEduTask', cancel: 'app.cancelEduTask' } as const;
    try {
      const result = EduTaskOperationResultSchema.parse(await this.request({ method: method[operation], payload: binding }));
      if (result.operation !== operation || JSON.stringify(result.binding) !== owner) throw new Error('edu 任务回执归属不匹配');
      if (
        result.ok &&
        result.operation === 'apply' &&
        (result.app.workspaceId !== binding.workspaceId ||
          result.app.projectId !== binding.projectId ||
          result.app.appInstanceId !== binding.appInstanceId)
      )
        throw new Error('edu 任务写回应用身份不匹配');
      if (result.cleanupConfirmed && this.eduTaskCleanup.get(owner) === callId) this.eduTaskCleanup.delete(owner);
      return result;
    } catch {
      return { binding, operation, ok: false, cleanupConfirmed: false, error: 'edu 任务 helper 回执无效或传输中断；清理未确认' };
    }
  }
  appPrepareEduTask(binding: EduTaskBinding): Promise<EduTaskOperationResult> {
    return this.eduTaskOperation(binding, 'prepare');
  }
  appApplyEduTask(binding: EduTaskBinding): Promise<EduTaskOperationResult> {
    return this.eduTaskOperation(binding, 'apply');
  }
  appCancelEduTask(binding: EduTaskBinding): Promise<EduTaskOperationResult> {
    return this.eduTaskOperation(binding, 'cancel');
  }
  async motaControl(input: MotaControlRequest): Promise<MotaControlResponse> {
    const request = MotaControlRequestSchema.parse(input);
    const owner = JSON.stringify(request.binding);
    if (request.method === 'acquire' || request.method === 'map.set' || request.method === 'release') this.motaCleanup.add(owner);
    const response = MotaControlResponseSchema.parse(await this.request({ method: 'app.motaControl', payload: request }));
    if (response.requestId !== request.requestId || response.method !== request.method || JSON.stringify(response.binding) !== owner)
      throw new Error('魔塔控制回执归属不匹配；占用保留');
    if (request.method === 'release' && response.ok) this.motaCleanup.delete(owner);
    return response;
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
  async send(
    id: ChatSlot,
    text: string,
    observationScope: ObservationTurnScope | undefined,
    references: CatalogReferenceSnapshot,
    eduTask?: EduTaskBinding,
    motaTask?: MotaTaskBinding,
    researchGrant?: ResearchGrant,
  ) {
    try {
      this.assertMaintenance();
    } catch (error) {
      throw new RunDispatchFailure(error instanceof Error ? error.message : '维护期间不能派发任务', false, true);
    }
    const binding = eduTask && EduTaskBindingSchema.parse(eduTask);
    const motaBinding = motaTask && MotaTaskBindingSchema.parse(motaTask);
    if (motaBinding) this.motaCleanup.add(JSON.stringify(motaBinding));
    const result = await this.request({
      method: 'send',
      payload: {
        conversationId: id,
        text,
        observationScope,
        references,
        eduTask: binding,
        motaTask: motaBinding,
        researchGrant: researchGrant && ResearchGrantSchema.parse(researchGrant),
      },
    });
    const motaRejection = MotaTaskDispatchRejectionSchema.safeParse(result);
    if (motaRejection.success) {
      if (
        !motaBinding ||
        motaRejection.data.conversationId !== id ||
        JSON.stringify(motaRejection.data.binding) !== JSON.stringify(motaBinding)
      )
        throw new RunDispatchFailure('魔塔任务派发拒绝回执归属不匹配', true);
      throw new RunDispatchFailure(motaRejection.data.error, false);
    }
    const rejection = EduTaskDispatchRejectionSchema.safeParse(result);
    if (rejection.success) {
      if (!binding || rejection.data.conversationId !== id || JSON.stringify(rejection.data.binding) !== JSON.stringify(binding))
        throw new RunDispatchFailure('edu 任务派发拒绝回执归属不匹配', true);
      // The RPC ran, so its finite helper must still be reconciled by exact binding.
      throw new RunDispatchFailure(rejection.data.error, false);
    }
    return ChatConversationSchema.parse(result);
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
    this.assertMaintenance();
    return TerminalSnapshotSchema.parse(await this.request({ method: 'terminal.open', payload: { cols, rows, resourceId } }));
  }
  async terminalWrite(sessionId: string, data: string, resourceId: string) {
    this.assertMaintenance();
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
          this.eduTaskCleanup.size > 0 ||
          this.motaCleanup.size > 0 ||
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
