import { randomUUID, createHash } from 'node:crypto';
import {
  ObservationTurnScopeSchema,
  WorkspaceObservationResultSchema,
  AppControlResultSchema,
  AppToolNameSchema,
  type AppControlResult,
  ResourceBundleSchema,
  type ObservationTurnScope,
  type WorkspaceObservationResult,
  type ChatConversation,
  type ChatSlot,
  type ChatStatus,
  type SandboxStatus,
  type CatalogReferenceSnapshot,
  type HarnessAvailability,
  type ProfileCheckResult,
  type ProfileCheckReceipt,
  type ProfileDir,
  type TurnHarness,
  type PermissionRequest,
  profileDirOf,
} from '@wsl/protocol';
import { SbxConnection, GUEST_CWD, type GuestProcess, type GuestOutcome } from './sbx';
import { codexAdapter } from './harness/codex/adapter';
import type { HarnessEvent, NativeHarnessAdapter } from './harness/types';
import { acpDescriptor, type AcpAgentSpec } from './harness/acp/agents';
import { AcpClient, AcpMethodNotFound, AcpProtocolError } from './harness/acp/client';
import { ACP_PROTOCOL_VERSION, InitializeResultSchema, type AcpStdioMcpServer, type InitializeResult } from './harness/acp/protocol';
import { AcpTurn, acpInitializeParams } from './harness/acp/turn';
import { approvalPolicy } from './harness/acp/policy';
import type { PermissionOption, PermissionOutcome, RequestPermissionParams } from './harness/acp/protocol';
import { harnessIdOf } from './harness/registry';

export { parseCodexLine } from './harness/codex/adapter';

/** 执行核心使用的 Harness：native 逐行解析一次性进程的输出；acp 经 stdin relay 与长连接 Agent 往返。 */
export type ChatHarness = { kind: 'native'; adapter: NativeHarnessAdapter } | { kind: 'acp'; spec: AcpAgentSpec };
export const CODEX_HARNESS: ChatHarness = { kind: 'native', adapter: codexAdapter };
/** Codex 内置 Profile 的本轮选择。service 入口总是显式传入 Main 解析的选择；缺省值只供直接驱动执行核心的测试使用。 */
export const CODEX_DEFAULT_TURN: TurnHarness = { harnessId: 'codex', profileId: 'codex:default', profileDir: null };

interface Turn {
  process: GuestProcess;
  cancel: boolean;
  failure: string | null;
  completed: boolean;
  replied: boolean;
  cleanupError: string | null;
  cleanupConfirmed: boolean;
  finishing: boolean;
  closePromise: Promise<GuestOutcome | null> | null;
  completion: Promise<void> | null;
  observation: AbortController;
  calls: Map<string, AbortController>;
  /** 本轮待用户决定的权限请求（W4b）；settle 答复 Agent、移除快照中的请求并按需发布。 */
  approvals: Map<
    string,
    { request: PermissionRequest; settle: (outcome: PermissionOutcome, note: string | null, publish?: boolean) => void }
  >;
}
interface ProfileCheckOperation {
  probes: Set<ProfileProbe>;
  startUnconfirmed: boolean;
}
interface ProfileProbe {
  cleanupConfirmed: boolean;
  process: GuestProcess;
  closePromise: Promise<GuestOutcome> | null;
  cleanupError: string | null;
}
interface AcpProbe {
  entry: RegisteredHarness;
  process: GuestProcess;
  client: AcpClient;
  closePromise: Promise<GuestOutcome> | null;
}
interface Slot {
  conversation: ChatConversation;
  active: Turn | null;
  /** 当前 threadId 由哪个 Harness 与 Profile 建立；换用其他组合时不复用该会话身份。 */
  threadOwner: { harnessId: string; profileId: string } | null;
}
interface RegisteredHarness {
  harness: ChatHarness;
  acpInit: InitializeResult | null;
  acpFailure: string | null;
}
export class CodexChat {
  private observationReader:
    | ((
        scope: ObservationTurnScope,
        tool: string,
        args: Record<string, unknown>,
        signal: AbortSignal,
      ) => Promise<WorkspaceObservationResult>)
    | null = null;
  setObservationReader(reader: NonNullable<CodexChat['observationReader']>) {
    this.observationReader = reader;
  }
  /** 控制面调用与观察共用同一 guest socket、轮次 scope 和调用预算，由 Main dispatcher 授权执行。 */
  private appControlReader:
    ((scope: ObservationTurnScope, tool: string, args: Record<string, unknown>, signal: AbortSignal) => Promise<AppControlResult>) | null =
    null;
  setAppControlReader(reader: NonNullable<CodexChat['appControlReader']>) {
    this.appControlReader = reader;
  }
  private readonly slots = new Map<ChatSlot, Slot>();
  private readonly workspaceBySession = new Map<ChatSlot, string>();
  register(id: ChatSlot, workspaceId: string) {
    if (id === 'conv-personal-default') throw new Error('个人会话不能注册为空间会话');
    const previous = this.workspaceBySession.get(id);
    if (previous && previous !== workspaceId) throw new Error('会话归属已冻结');
    this.workspaceBySession.set(id, workspaceId);
  }
  private sequence = 0;
  private closing = false;
  readonly connection: SbxConnection;
  constructor(
    _root: string,
    private readonly emit: (conversation: ChatConversation) => void,
    connection = new SbxConnection(),
    /** 本执行核心可用的全部 Harness；每轮由调用方按 harnessId 选择其一（W4）。 */
    harnesses: readonly ChatHarness[] = [CODEX_HARNESS],
    /** 权限请求无人回复时按拒绝处理的时限（W4-10 A：10 分钟）；测试可缩短。 */
    private readonly approvalTimeoutMs = 600000,
  ) {
    this.connection = connection;
    for (const harness of harnesses) {
      const id = harnessIdOf(harness);
      if (this.harnesses.has(id)) throw new Error(`Harness 重复注册：${id}`);
      this.harnesses.set(id, { harness, acpInit: null, acpFailure: null });
    }
  }
  private readonly harnesses = new Map<string, RegisteredHarness>();
  private initialization: Promise<ChatStatus> | null = null;
  private shutdownPromise: Promise<void> | null = null;
  private acpProbe: AcpProbe | null = null;
  private readonly profileProbes = new Set<ProfileProbe>();
  private profileStartUnknown = false;
  private readonly profileChecks = new Set<Promise<ProfileCheckResult>>();
  async initialize(): Promise<ChatStatus> {
    if (this.closing) return this.getStatus();
    if (this.initialization) return this.initialization;
    // Unknown probe cleanup retains ownership; another initialization must not replace it.
    if (this.acpProbe) return this.getStatus();
    this.initialization = this.initializeHarness();
    try {
      return await this.initialization;
    } finally {
      this.initialization = null;
    }
  }
  private async initializeHarness(): Promise<ChatStatus> {
    const status = await this.connection.initialize();
    if (status.available) {
      for (const entry of this.harnesses.values()) {
        if (this.closing || this.acpProbe) break;
        if (entry.harness.kind === 'acp') await this.probeAcp(entry);
      }
    }
    return this.withHarnesses(status);
  }
  getStatus(): ChatStatus {
    return this.withHarnesses(this.connection.getStatus());
  }
  private withHarnesses(status: SandboxStatus): ChatStatus {
    if (this.closing) status = { ...status, available: false, reason: '对话服务正在关闭', version: null };
    return { ...status, harnesses: [...this.harnesses.values()].map((entry) => this.availability(entry, status)) };
  }
  private availability(entry: RegisteredHarness, status: SandboxStatus): HarnessAvailability {
    const { harness } = entry;
    if (harness.kind === 'native') {
      const descriptor = harness.adapter.descriptor(status.available ? status.version : null);
      return { descriptor, available: status.available, reason: status.available ? null : status.reason };
    }
    const descriptor = acpDescriptor(harness.spec, entry.acpInit);
    if (!status.available) return { descriptor, available: false, reason: status.reason };
    if (!entry.acpInit)
      return { descriptor, available: false, reason: `${harness.spec.label} 不可用：${entry.acpFailure ?? '尚未完成检查'}` };
    return { descriptor, available: true, reason: null };
  }
  /**
   * 可用性探测：在 guest 内启动 ACP Agent，只发 initialize（不调用模型），据回复声明能力，然后关闭 stdin 并确认清理。
   * 清理未确认时判为不可用，避免留下未知进程。探测使用默认配置目录，不代表任何 Profile 已登录。
   */
  private async probeAcp(entry: RegisteredHarness) {
    const spec = (entry.harness as Extract<ChatHarness, { kind: 'acp' }>).spec;
    entry.acpInit = null;
    entry.acpFailure = null;
    let buffer = '';
    const probe = this.connection.start({ type: 'start', mode: 'codex', argv: spec.command, stdin: 'relay' }, (frame) => {
      if (frame.type !== 'output' || frame.stream !== 'stdout') return;
      buffer += frame.data;
      while (buffer.includes('\n')) {
        const index = buffer.indexOf('\n');
        const line = buffer.slice(0, index);
        buffer = buffer.slice(index + 1);
        try {
          client.receive(line);
        } catch (error) {
          client.close((error as Error).message);
        }
      }
    });
    const client = new AcpClient((line) => probe.writeInput(line), {
      onNotification: () => undefined,
      onRequest: async (method) => {
        throw new AcpMethodNotFound(method);
      },
    });
    const owned: AcpProbe = { entry, process: probe, client, closePromise: null };
    this.acpProbe = owned;
    const exited = probe.done.then(
      () => client.close('Agent 进程在初始化前退出'),
      (error: unknown) => client.close(error instanceof Error ? error.message : String(error)),
    );
    let initialized: InitializeResult | null = null;
    const timer = setTimeout(() => client.close('Agent 初始化超时'), 30000);
    try {
      const init = InitializeResultSchema.parse(await client.request('initialize', acpInitializeParams()));
      if (init.protocolVersion !== ACP_PROTOCOL_VERSION) throw new AcpProtocolError(`ACP 协议版本不兼容：${init.protocolVersion}`);
      initialized = init;
    } catch (error) {
      entry.acpFailure = (error as Error).message;
    } finally {
      clearTimeout(timer);
      client.close('探测结束');
      try {
        probe.endInput();
      } catch {
        // 传输已关闭：退出结果由 done 报告。
      }
    }
    let cleanupTimer: ReturnType<typeof setTimeout> | undefined;
    try {
      const outcome = await Promise.race([
        probe.done,
        new Promise<null>((resolve) => {
          cleanupTimer = setTimeout(() => resolve(null), 10000);
        }),
      ]);
      const settled = outcome ?? (await this.closeAcpProbe(owned));
      await exited;
      if (!settled.confirmed) throw new Error(settled.error ?? '探测进程清理未确认');
      if (this.acpProbe === owned) this.acpProbe = null;
      if (settled.error || settled.exitCode !== 0) throw new Error(settled.error ?? '探测进程异常退出');
      // A shutdown or failed cleanup cannot publish late availability.
      if (!this.closing) entry.acpInit = initialized;
    } catch (error) {
      entry.acpInit = null;
      entry.acpFailure = error instanceof Error ? error.message : String(error);
    } finally {
      clearTimeout(cleanupTimer);
    }
  }
  private closeAcpProbe(probe: AcpProbe): Promise<GuestOutcome> {
    probe.client.close('ACP 探测正在停止');
    probe.closePromise ??= Promise.resolve().then(() => probe.process.close());
    return probe.closePromise;
  }
  /**
   * 无模型自检一个 Profile（W4）：在 guest 内以其配置目录依次运行版本命令与登录状态命令。
   * 只保留解析出的版本与登录状态；原始输出可能含账号信息，读完即丢弃。清理未确认时结果为 undetermined。
   */
  async checkProfile(harnessId: string, profileDir: ProfileDir | null): Promise<ProfileCheckResult> {
    const receipt = await this.checkProfileReceipt(harnessId, profileDir);
    if (!receipt.ok) throw new Error(receipt.error);
    return receipt.result;
  }
  async checkProfileReceipt(harnessId: string, profileDir: ProfileDir | null): Promise<ProfileCheckReceipt> {
    const operation: ProfileCheckOperation = { probes: new Set(), startUnconfirmed: false };
    const cleanupConfirmed = () => !operation.startUnconfirmed && [...operation.probes].every((probe) => probe.cleanupConfirmed);
    try {
      const result = await this.checkProfileResult(harnessId, profileDir, operation);
      return { type: 'profile-check', ok: true, result, cleanupConfirmed: cleanupConfirmed() };
    } catch (error) {
      return {
        type: 'profile-check',
        ok: false,
        error: error instanceof Error ? error.message : String(error),
        cleanupConfirmed: cleanupConfirmed(),
      };
    }
  }
  private async checkProfileResult(
    harnessId: string,
    profileDir: ProfileDir | null,
    operation: ProfileCheckOperation,
  ): Promise<ProfileCheckResult> {
    if (this.closing) throw new Error('对话服务正在关闭');
    const entry = this.harnesses.get(harnessId);
    if (!entry) throw new Error(`未注册的 Harness：${harnessId}`);
    this.assertProfileDir(entry.harness, harnessId, profileDir);
    if (!this.connection.getStatus().available)
      return { cliVersion: null, login: 'undetermined', reason: this.connection.getStatus().reason };
    this.assertCleanupKnown();
    // Register the operation before it can start a process; shutdown owns queued checks too.
    const checking = Promise.resolve().then(() => this.runProfileCheck(entry, profileDir, operation));
    this.profileChecks.add(checking);
    try {
      return await checking;
    } finally {
      this.profileChecks.delete(checking);
    }
  }
  private async runProfileCheck(
    entry: RegisteredHarness,
    profileDir: ProfileDir | null,
    operation: ProfileCheckOperation,
  ): Promise<ProfileCheckResult> {
    const check = entry.harness.kind === 'native' ? entry.harness.adapter.selfCheck : entry.harness.spec.selfCheck;
    const run = async (argv: string[]) => {
      if (this.closing) throw new Error('对话服务正在关闭');
      this.assertCleanupKnown();
      let stdout = '';
      let stderr = '';
      operation.startUnconfirmed = true;
      let process: GuestProcess;
      try {
        process = this.connection.start({ type: 'start', mode: 'codex', argv, ...(profileDir ? { profileDir } : {}) }, (frame) => {
          if (frame.type !== 'output') return;
          if (frame.stream === 'stdout' && stdout.length < 65536) stdout += frame.data;
          if (frame.stream === 'stderr' && stderr.length < 65536) stderr += frame.data;
        });
      } catch (error) {
        // A throwing start cannot prove that no process was created before returning ownership.
        this.profileStartUnknown = true;
        throw error;
      }
      const owned: ProfileProbe = { process, closePromise: null, cleanupError: null, cleanupConfirmed: false };
      this.profileProbes.add(owned);
      operation.probes.add(owned);
      operation.startUnconfirmed = false;
      let timer: ReturnType<typeof setTimeout> | undefined;
      try {
        // start is synchronous, but its callbacks may already have closed admission.
        const outcome = this.closing
          ? await this.closeProfileProbe(owned)
          : await Promise.race([
              process.done,
              new Promise<null>((resolve) => {
                timer = setTimeout(() => resolve(null), 30000);
              }),
            ]);
        const settled = outcome ?? (await this.closeProfileProbe(owned));
        if (!settled.confirmed) {
          owned.cleanupError = settled.error ?? '自检进程清理未确认';
          return { stdout, stderr, settled };
        }
        // A close response cannot substitute for the owned process's actual completion.
        const completed = await process.done;
        if (completed.confirmed) {
          owned.cleanupConfirmed = true;
          this.profileProbes.delete(owned);
        } else owned.cleanupError = completed.error ?? '自检进程清理未确认';
        return { stdout, stderr, settled: { ...completed, error: settled.error ?? completed.error } };
      } catch (error) {
        owned.cleanupError = error instanceof Error ? error.message : String(error);
        throw error;
      } finally {
        clearTimeout(timer);
      }
    };
    const version = await run(check.versionArgv);
    if (this.closing) throw new Error('对话服务正在关闭');
    if (!version.settled.confirmed || version.settled.error)
      return { cliVersion: null, login: 'undetermined', reason: version.settled.error ?? '自检进程清理未确认' };
    const cliVersion = version.settled.exitCode === 0 ? version.stdout.trim().split('\n')[0]?.slice(0, 200) || null : null;
    const status = await run(check.statusArgv);
    if (this.closing) throw new Error('对话服务正在关闭');
    if (!status.settled.confirmed || status.settled.error)
      return { cliVersion, login: 'undetermined', reason: status.settled.error ?? '自检进程清理未确认' };
    const login = check.parseStatus(status.settled.exitCode, status.stdout, status.stderr);
    return {
      cliVersion,
      login,
      reason: login === 'undetermined' ? `无法从登录状态命令判断（退出码 ${String(status.settled.exitCode)}）` : null,
    };
  }
  private closeProfileProbe(probe: ProfileProbe): Promise<GuestOutcome> {
    probe.closePromise ??= Promise.resolve()
      .then(() => probe.process.close())
      .catch((error: unknown) => {
        probe.cleanupError = error instanceof Error ? error.message : String(error);
        throw error;
      });
    return probe.closePromise;
  }
  /** 配置目录必须正好是该 Profile 的约定目录，并映射到该 Harness 声明的环境变量；内置 Profile 不带目录。 */
  private assertProfileDir(harness: ChatHarness, harnessId: string, profileDir: ProfileDir | null, profileId?: string) {
    if (!profileDir) {
      if (profileId !== undefined && !profileId.endsWith(':default')) throw new Error('非内置 Profile 缺少配置目录');
      return;
    }
    const env = harness.kind === 'native' ? harness.adapter.configDirEnv : harness.spec.configDirEnv;
    const id = profileDir.path.split('/').at(-1) ?? '';
    const expected = profileDirOf(harnessId, profileId ?? id);
    if (!env || env !== profileDir.env || !expected || expected.path !== profileDir.path || expected.env !== profileDir.env)
      throw new Error('Profile 配置目录与 Harness 声明不符');
  }
  private warn(slot: Slot, text: string) {
    const warning = text.slice(0, 2000);
    if (!slot.conversation.warnings.includes(warning)) slot.conversation.warnings.push(warning);
    slot.conversation.warnings = slot.conversation.warnings.slice(-20);
  }
  /**
   * 把一个权限请求交给用户（W4b）：写入会话快照并等待回复；截止时间到后按拒绝处理。
   * 轮次结束、取消或失败时由 settleApprovals 以 cancelled 收尾。
   */
  private ask(slot: Slot, turn: Turn, params: RequestPermissionParams, options: PermissionOption[]): Promise<PermissionOutcome> {
    const cancelled: PermissionOutcome = { outcome: { outcome: 'cancelled' } };
    const title = (params.toolCall.title ?? params.toolCall.toolCallId).slice(0, 200);
    const once = options
      .filter((option) => option.optionId.length <= 200)
      .slice(0, 4)
      .map((option) => ({ optionId: option.optionId, name: option.name.slice(0, 200), kind: option.kind as 'allow_once' | 'reject_once' }));
    const rejection = (): PermissionOutcome => {
      const reject = once.find((option) => option.kind === 'reject_once');
      return reject ? { outcome: { outcome: 'selected', optionId: reject.optionId } } : cancelled;
    };
    if (slot.active !== turn || turn.cancel || turn.failure || !slot.conversation.turnId) return Promise.resolve(cancelled);
    if (!once.some((option) => option.kind === 'allow_once')) {
      this.warn(slot, `已拒绝 ${title} 的权限请求：没有可用的一次性允许选项`);
      return Promise.resolve(rejection());
    }
    if (turn.approvals.size >= 4) {
      this.warn(slot, `已拒绝 ${title} 的权限请求：待决请求过多`);
      return Promise.resolve(rejection());
    }
    const now = Date.now();
    const request: PermissionRequest = {
      requestId: randomUUID(),
      turnId: slot.conversation.turnId,
      toolCallId: params.toolCall.toolCallId.slice(0, 200),
      title,
      kind: (params.toolCall.kind ?? 'unknown').slice(0, 40),
      options: once,
      requestedAt: new Date(now).toISOString(),
      expiresAt: new Date(now + this.approvalTimeoutMs).toISOString(),
    };
    return new Promise<PermissionOutcome>((resolve) => {
      const settle = (outcome: PermissionOutcome, note: string | null, publish = true) => {
        if (!turn.approvals.delete(request.requestId)) return;
        clearTimeout(timer);
        slot.conversation.permissionRequests = (slot.conversation.permissionRequests ?? []).filter(
          (item) => item.requestId !== request.requestId,
        );
        if (note) this.warn(slot, note);
        if (publish && slot.active === turn) {
          try {
            this.publish(slot);
          } catch (error) {
            this.completionFailed(slot, turn, error);
          }
        }
        resolve(outcome);
      };
      const timer = setTimeout(() => settle(rejection(), `${title} 的权限请求在截止时间前未回复，已按拒绝处理`), this.approvalTimeoutMs);
      turn.approvals.set(request.requestId, { request, settle });
      slot.conversation.permissionRequests = [...(slot.conversation.permissionRequests ?? []), request];
      this.publish(slot);
    });
  }
  /** 轮次结束、取消或失败：待决请求一律以 cancelled 答复并移除，不单独发布（调用方随后发布终态）。 */
  private settleApprovals(turn: Turn) {
    for (const { settle } of [...turn.approvals.values()]) settle({ outcome: { outcome: 'cancelled' } }, null, false);
  }
  /**
   * 用户对权限请求的回复（W4b）。只接受当前轮次仍待决的请求与其一次性选项；optionId 为 null 表示拒绝。
   * 已结束、已超时或重复的回复报错，不产生决定。
   */
  answerPermission(id: ChatSlot, requestId: string, optionId: string | null): ChatConversation {
    const turn = this.slots.get(id)?.active;
    const entry = turn?.approvals.get(requestId);
    if (!turn || !entry || turn.cancel || turn.failure || turn.finishing) throw new Error('权限请求已结束或不存在');
    const { request } = entry;
    const option =
      optionId === null
        ? request.options.find((item) => item.kind === 'reject_once')
        : request.options.find((item) => item.optionId === optionId);
    if (optionId !== null && !option) throw new Error('选项不属于该权限请求');
    const allowed = option?.kind === 'allow_once';
    entry.settle(
      option ? { outcome: { outcome: 'selected', optionId: option.optionId } } : { outcome: { outcome: 'cancelled' } },
      allowed ? `已允许 ${request.title}（用户，一次）` : `已拒绝 ${request.title} 的权限请求（用户）`,
    );
    return this.get(id);
  }
  private slot(id: ChatSlot): Slot {
    let slot = this.slots.get(id);
    if (!slot) {
      slot = {
        conversation: {
          conversationId: id,
          generation: randomUUID(),
          seq: ++this.sequence,
          threadId: null,
          turnId: null,
          state: 'idle',
          messages: [],
          toolExecutions: [],
          warnings: [],
          permissionRequests: [],
          cleanupPending: false,
          error: null,
        },
        active: null,
        threadOwner: null,
      };
      this.slots.set(id, slot);
    }
    return slot;
  }
  get(id: ChatSlot): ChatConversation {
    return structuredClone(this.slot(id).conversation);
  }
  private publish(slot: Slot): ChatConversation {
    slot.conversation.seq = ++this.sequence;
    const snapshot = structuredClone(slot.conversation);
    this.emit(snapshot);
    return snapshot;
  }
  private assertCleanupKnown(): void {
    if (this.profileStartUnknown) throw new Error('自检进程启动归属未确认');
    for (const probe of this.profileProbes) if (probe.cleanupError) throw new Error(probe.cleanupError);
    if (this.connection.getCleanupPending()) throw new Error('共享 sandbox 清理状态未知');
    for (const slot of this.slots.values()) {
      if (slot.active?.cleanupError) throw new Error(slot.active.cleanupError);
      if (slot.active?.failure && slot.conversation.cleanupPending) throw new Error('失败轮次的 guest 清理尚未确认');
    }
  }
  private completionFailed(slot: Slot, turn: Turn, error: unknown): void {
    if (slot.active !== turn) return;
    const reason = error instanceof Error ? error.message : String(error);
    turn.failure ??= reason;
    this.settleApprovals(turn);
    turn.observation.abort();
    if (!turn.cleanupConfirmed) turn.cleanupError ??= reason;
    slot.conversation.state = 'failed';
    slot.conversation.cleanupPending = !turn.cleanupConfirmed;
    slot.conversation.error = [...new Set([turn.failure, slot.conversation.error, reason].filter(Boolean))].join('; ');
    try {
      this.publish(slot);
    } catch (publishError) {
      slot.conversation.error += `; ${publishError instanceof Error ? publishError.message : String(publishError)}`;
    }
    if (turn.cleanupConfirmed && slot.active === turn) slot.active = null;
  }
  private closeTurn(slot: Slot, turn: Turn): Promise<GuestOutcome | null> {
    turn.closePromise ??= Promise.resolve()
      .then(() => turn.process.close())
      .catch((error: unknown) => {
        this.completionFailed(slot, turn, error);
        return null;
      });
    return turn.closePromise;
  }
  async send(
    id: ChatSlot,
    text: string,
    observationScope: ObservationTurnScope | undefined,
    references: CatalogReferenceSnapshot,
    turnHarness: TurnHarness = CODEX_DEFAULT_TURN,
  ): Promise<ChatConversation> {
    if (this.closing) throw new Error('对话服务正在关闭');
    if (id !== 'conv-personal-default' && !this.workspaceBySession.has(id)) throw new Error('会话尚未由宿主注册');
    if (observationScope) {
      observationScope = ObservationTurnScopeSchema.parse(observationScope);
      if (observationScope.sessionId !== id || this.workspaceBySession.get(id) !== observationScope.workspaceId)
        throw new Error('观察会话不属于已注册空间');
    }
    const status = this.connection.getStatus();
    if (!status.available) throw new Error(status.reason ?? 'sbx 不可用');
    const entry = this.harnesses.get(turnHarness.harnessId);
    if (!entry) throw new Error(`未注册的 Harness：${turnHarness.harnessId}`);
    const availability = this.availability(entry, status);
    if (!availability.available) throw new Error(availability.reason ?? `${availability.descriptor.displayName} 不可用`);
    this.assertProfileDir(entry.harness, turnHarness.harnessId, turnHarness.profileDir, turnHarness.profileId);
    const slot = this.slot(id);
    if (slot.active) throw new Error(slot.active?.cleanupError ?? '当前会话正在等待回复');
    const spaceId = this.workspaceBySession.get(id) ?? null;
    this.assertCleanupKnown();
    const turnId = randomUUID();
    if (references.sessionId !== id || references.workspaceId !== spaceId) throw new Error('参考资料不属于已注册会话');
    const resourceBundle = ResourceBundleSchema.parse({
      ...references,
      conversationId: id,
      generation: slot.conversation.generation,
      turnId,
    });
    for (const resource of resourceBundle.resources)
      if (createHash('sha256').update(resource.text, 'utf8').digest('hex') !== resource.contentSha256)
        throw new Error('参考资料正文摘要不匹配');
    Object.assign(slot.conversation, { turnId, state: 'running', error: null, cleanupPending: true });
    slot.conversation.messages.push({ id: turnId, role: 'user', text });
    const owner = { harnessId: turnHarness.harnessId, profileId: turnHarness.profileId };
    if (slot.conversation.threadId && (slot.threadOwner?.harnessId !== owner.harnessId || slot.threadOwner.profileId !== owner.profileId)) {
      // 另一个 Harness 或账号建立的会话身份不能在这里恢复：开始新的 Agent 会话，并保留可见说明。
      slot.conversation.threadId = null;
      const warning = `本轮改用 ${availability.descriptor.displayName}（${owner.profileId}），已开始新的 Agent 会话；之前的上下文不会带入`;
      if (!slot.conversation.warnings.includes(warning)) slot.conversation.warnings.push(warning);
      slot.conversation.warnings = slot.conversation.warnings.slice(-20);
    }
    slot.threadOwner = owner;
    this.publish(slot);
    const harness = entry.harness;
    const label = harness.kind === 'native' ? harness.adapter.label : harness.spec.label;
    const profileDir = turnHarness.profileDir;
    const native = harness.kind === 'native' ? harness.adapter : null;
    const argv = native ? native.argv(slot.conversation.threadId) : (harness as Extract<ChatHarness, { kind: 'acp' }>).spec.command;
    const maxLineChars = native ? native.maxLineChars : 1048576;
    const mcpServers: AcpStdioMcpServer[] = [];
    let acpTurn: AcpTurn | null = null;
    let buffer = '';
    let stderr = '';
    const fail = (reason: string) => {
      if (slot.active !== turn || turn.failure) return;
      turn.failure = reason;
      this.settleApprovals(turn);
      turn.observation.abort();
      slot.conversation.state = 'failed';
      slot.conversation.error = reason;
      slot.conversation.cleanupPending = !turn.cleanupConfirmed;
      void this.closeTurn(slot, turn);
      try {
        this.publish(slot);
      } catch (error) {
        this.completionFailed(slot, turn, error);
      }
    };
    const apply = (events: HarnessEvent[]) => {
      for (const event of events) {
        if (event.type === 'session') {
          if (!event.fresh && slot.conversation.threadId && slot.conversation.threadId !== event.ref)
            throw new Error(`${label} 返回了不同的会话身份`);
          slot.conversation.threadId = event.ref;
        }
        if (event.type === 'message') {
          turn.replied = true;
          const messageId = `${turnId}:${event.id}`;
          if (!slot.conversation.messages.some((message) => message.id === messageId))
            slot.conversation.messages.push({ id: messageId, role: 'assistant', text: event.text });
        }
        if (event.type === 'warning') {
          if (!slot.conversation.warnings.includes(event.text)) slot.conversation.warnings.push(event.text);
          slot.conversation.warnings = slot.conversation.warnings.slice(-20);
        }
        if (event.type === 'tool') {
          const command = event.command;
          const tools = slot.conversation.toolExecutions;
          const record = {
            id: event.id,
            turnId,
            command: command.slice(-4000),
            output: event.output,
            exitCode: event.exitCode,
            truncated: event.truncated || command.length > 4000,
          };
          const index = tools.findIndex((tool) => tool.id === event.id && tool.turnId === turnId);
          if (index < 0) tools.push(record);
          else tools[index] = record;
          while (tools.length > 100) tools.shift();
          let excess = tools.reduce((sum, tool) => sum + tool.output.length, 0) - 131072;
          for (const tool of tools) {
            if (excess <= 0) break;
            if (tool.command.startsWith('mcp:')) {
              const priorLength = tool.output.length;
              tool.output = JSON.stringify({
                truncated: true,
                receiptOmitted: 'Conversation output limit reached; tool arguments remain in command',
              });
              tool.truncated = true;
              excess -= priorLength - tool.output.length;
            } else {
              const removed = Math.min(tool.output.length, excess);
              tool.output = tool.output.slice(removed);
              tool.truncated = true;
              excess -= removed;
            }
          }
        }
        if (event.type === 'turn_completed') turn.completed = true;
        if (event.type === 'turn_failed') fail(event.message);
      }
    };
    const consume = (line: string) => {
      if (turn.cancel || turn.failure || slot.active !== turn || !line.trim()) return;
      try {
        if (native) {
          const events = native.parseLine(line);
          if (!events) return;
          apply(events);
          this.publish(slot);
        } else acpTurn?.receive(line);
      } catch (error) {
        fail(`${label} 协议错误：${(error as Error).message}`);
      }
    };
    const startAcp = () => {
      const turnRef = turn;
      acpTurn = new AcpTurn(
        (line) => {
          try {
            process.writeInput(line);
          } catch {
            // 传输已关闭：结果由进程完成回执决定。
          }
        },
        (event) => {
          if (turnRef.cancel || turnRef.failure || slot.active !== turnRef) return;
          try {
            apply([event]);
            this.publish(slot);
          } catch (error) {
            fail(`${label} 协议错误：${(error as Error).message}`);
          }
        },
        {
          cwd: GUEST_CWD,
          mcpServers,
          sessionRef: slot.conversation.threadId,
          prompt: text,
          signal: turnRef.observation.signal,
          decidePermission: approvalPolicy({
            onDeny: (params, reason) =>
              this.warn(slot, `已拒绝 ${params.toolCall.title ?? params.toolCall.toolCallId} 的权限请求：${reason}`),
            ask: (params, options) => this.ask(slot, turnRef, params, options),
          }),
        },
      );
      void acpTurn.run().then(
        () => {
          try {
            process.endInput();
          } catch {
            // 传输已关闭。
          }
        },
        (error: Error) => fail(`${label} 协议错误：${error.message}`),
      );
    };
    let callCount = 0;
    const process = this.connection.start(
      {
        type: 'start',
        mode: 'codex',
        argv,
        ...(native ? { mcp: native.mcpInjection, prompt: text } : { mcp: 'acp-stdio' as const, stdin: 'relay' as const }),
        ...(profileDir ? { profileDir } : {}),
        resourceBundle,
        observation: Boolean(observationScope && this.observationReader),
        observationImages: false,
      },
      (frame) => {
        if (slot.active !== turn || turn.finishing) return;
        if (frame.type === 'observation-cancel') {
          turn.calls.get(frame.id)?.abort();
          return;
        }
        if (frame.type === 'observation-call') {
          if (turn.failure || turn.cancel || turn.observation.signal.aborted) return;
          const appTool = frame.tool.startsWith('app.');
          const reply = (result: WorkspaceObservationResult | AppControlResult) => {
            if (slot.active !== turn || turn.failure || turn.cancel || turn.observation.signal.aborted) return;
            const bounded = boundedObservationReply(frame.id, result);
            process.write(bounded);
          };
          if (!observationScope || !(appTool ? this.appControlReader : this.observationReader) || turn.cancel) {
            reply(
              appTool
                ? { ok: false, tool: null, error: { code: 'no_active_run', message: '无运行归属，控制面不可用' } }
                : { error: 'unauthorized', message: '无运行观察归属' },
            );
            return;
          }
          if (turn.calls.has(frame.id)) {
            fail('观察调用身份重复');
            return;
          }
          if (turn.calls.size >= 4 || ++callCount > 64) {
            reply(
              appTool
                ? { ok: false, tool: null, error: { code: 'budget_exceeded', message: '观察与控制面并发或单轮预算已用完' } }
                : { error: 'budget_exceeded', message: '观察并发或单轮预算已用完' },
            );
            return;
          }
          const controller = new AbortController();
          turn.calls.set(frame.id, controller);
          const abort = () => controller.abort();
          turn.observation.signal.addEventListener('abort', abort, { once: true });
          const call = appTool
            ? AppToolNameSchema.safeParse(frame.tool).success
              ? this.appControlReader!(structuredClone(observationScope), frame.tool, frame.args, controller.signal).then(
                  (result) => reply(AppControlResultSchema.parse(result)),
                  (error) => reply({ ok: false, tool: null, error: { code: 'unavailable', message: (error as Error).message } }),
                )
              : Promise.resolve(reply({ ok: false, tool: null, error: { code: 'unsupported', message: '未知控制面工具' } }))
            : this.observationReader!(structuredClone(observationScope), frame.tool, frame.args, controller.signal).then(
                (result) => reply(WorkspaceObservationResultSchema.parse(result)),
                (error) => reply({ error: 'unavailable', message: (error as Error).message }),
              );
          void call.then(
            () => {
              turn.calls.delete(frame.id);
              turn.observation.signal.removeEventListener('abort', abort);
            },
            (error) => {
              turn.calls.delete(frame.id);
              turn.observation.signal.removeEventListener('abort', abort);
              if (slot.active === turn) fail('观察返回失败：' + (error as Error).message);
            },
          );
          return;
        }
        if (frame.type === 'mcp-server') {
          if (!native) mcpServers.push({ name: frame.name, command: frame.command, args: frame.args, env: [] });
          return;
        }
        if (frame.type === 'ready') {
          if (!native && !acpTurn) startAcp();
          return;
        }
        if (frame.type === 'cleanup') {
          // A frame is not the transport's settled cleanup receipt.
          if (!frame.ok) turn.cleanupError ??= frame.error ?? 'guest 清理未确认';
        }
        if (frame.type !== 'output') return;
        if (frame.stream === 'stderr') {
          stderr = (stderr + frame.data).slice(-4000);
          return;
        }
        buffer += frame.data;
        if (buffer.length > maxLineChars) {
          fail(`${label} 协议行超过限制`);
          return;
        }
        while (buffer.includes('\n')) {
          const index = buffer.indexOf('\n');
          const line = buffer.slice(0, index);
          buffer = buffer.slice(index + 1);
          consume(line);
        }
      },
    );
    const turn: Turn = {
      process,
      cancel: false,
      failure: null,
      completed: false,
      replied: false,
      cleanupError: null,
      cleanupConfirmed: false,
      finishing: false,
      closePromise: null,
      completion: null,
      observation: new AbortController(),
      calls: new Map(),
      approvals: new Map(),
    };
    slot.active = turn;
    turn.completion = process.done
      .then((outcome) => {
        if (slot.active !== turn) return;
        turn.finishing = true;
        this.settleApprovals(turn);
        turn.observation.abort();
        // The final JSON event need not end with a newline. Only new frames are
        // blocked while finishing; this already-received tail is still consumed.
        if (buffer.trim()) consume(buffer);
        // 进程已退出：未完成的 ACP 请求不再等待，之后到达的内容被隔离。
        (acpTurn as AcpTurn | null)?.close('Agent 进程已退出');
        turn.cleanupConfirmed = outcome.confirmed;
        turn.cleanupError = !outcome.confirmed ? (outcome.error ?? 'guest 清理未确认') : null;
        slot.conversation.cleanupPending = !outcome.confirmed;
        const failure =
          [...new Set([turn.failure, turn.cleanupError, outcome.error].filter(Boolean))].join('; ') ||
          (!turn.cancel
            ? outcome.exitCode !== 0
              ? `${label} 退出失败（${outcome.exitCode}）${stderr ? `：${stderr}` : ''}`
              : !turn.completed
                ? `${label} 未返回对话完成事件`
                : (native ? native.requiresSessionRef : true) && !slot.conversation.threadId
                  ? `${label} 未返回会话身份`
                  : !turn.replied
                    ? `${label} 未返回助手回复`
                    : null
            : null);
        slot.conversation.state = failure ? 'failed' : turn.cancel ? 'cancelled' : 'idle';
        slot.conversation.error = failure;
        this.publish(slot);
        if (turn.cleanupConfirmed) slot.active = null;
      })
      .catch((error: unknown) => this.completionFailed(slot, turn, error));
    return this.get(id);
  }
  private cancelUnstarted(slot: Slot, turnId: string): ChatConversation {
    if (slot.conversation.turnId === turnId && slot.conversation.state === 'cancelled') return structuredClone(slot.conversation);
    Object.assign(slot.conversation, { turnId, state: 'cancelled', error: null, cleanupPending: false });
    return this.publish(slot);
  }
  async cancel(id: ChatSlot, queuedSend = false): Promise<ChatConversation> {
    const slot = this.slot(id);
    const turn = slot.active;
    if (!turn) return queuedSend ? this.cancelUnstarted(slot, randomUUID()) : this.get(id);
    // A synchronous subscriber may cancel while the settled outcome is being
    // published. It must await that publication without changing the terminal state.
    if (turn.finishing) {
      await turn.completion;
      if (!turn.cleanupConfirmed) throw new Error(turn.cleanupError ?? 'guest 清理未确认');
      return this.get(id);
    }
    if (turn.cleanupError) throw new Error(turn.cleanupError);
    if (!turn.failure) {
      turn.cancel = true;
      this.settleApprovals(turn);
      turn.observation.abort();
      slot.conversation.state = 'cancelling';
      try {
        this.publish(slot);
      } catch (error) {
        // Publication failure must not prevent the owned process from closing.
        this.completionFailed(slot, turn, error);
      }
    }
    const outcome = await this.closeTurn(slot, turn);
    if (!outcome || !outcome.confirmed || outcome.error) throw new Error(turn.cleanupError ?? outcome?.error ?? 'guest 清理未确认');
    await turn.completion;
    if (!turn.cleanupConfirmed) throw new Error(turn.cleanupError ?? 'guest 清理未确认');
    return this.get(id);
  }
  async reset(id: ChatSlot): Promise<ChatConversation> {
    if (this.closing) throw new Error('对话服务正在关闭');
    await this.cancel(id);
    this.assertCleanupKnown();
    this.slots.delete(id);
    return this.publish(this.slot(id));
  }
  beginShutdown(): void {
    // Apps still need the shared connection while their mappings are removed.
    // Admission can close independently of that connection's cleanup.
    this.closing = true;
  }
  shutdown(): Promise<void> {
    this.beginShutdown();
    this.shutdownPromise ??= Promise.resolve().then(() => this.finishShutdown());
    return this.shutdownPromise;
  }
  private async finishShutdown(): Promise<void> {
    const probe = this.acpProbe;
    const probeCleanup = probe
      ? this.closeAcpProbe(probe).then((outcome) => {
          if (!outcome.confirmed) throw new Error(outcome.error ?? '探测进程清理未确认');
        })
      : Promise.resolve();
    const profileCleanup = [...this.profileProbes].map((profile) =>
      this.closeProfileProbe(profile).then((outcome) => {
        if (!outcome.confirmed) throw new Error(outcome.error ?? '自检进程清理未确认');
      }),
    );
    const outcomes = await Promise.allSettled([
      this.connection.shutdown(),
      probeCleanup,
      ...profileCleanup,
      // Closing a check deliberately rejects its result; process cleanup remains a separate fact.
      Promise.allSettled([...this.profileChecks]),
      // If a probe exists, await its done handling too; close alone is not a cleanup receipt.
      ...(probe && this.initialization ? [this.initialization] : []),
      ...[...this.slots.keys()].map((id) => this.cancel(id)),
    ]);
    const failure = outcomes.find((outcome) => outcome.status === 'rejected');
    if (failure?.status === 'rejected') throw failure.reason;
    if (this.acpProbe) throw new Error(this.acpProbe.entry.acpFailure ?? '探测进程清理未确认');
    if (this.profileStartUnknown) throw new Error('自检进程启动归属未确认');
    if (this.profileProbes.size)
      throw new Error([...this.profileProbes].find((profile) => profile.cleanupError)?.cleanupError ?? '自检进程清理未确认');
  }
}

export function boundedObservationReply(id: string, result: WorkspaceObservationResult | AppControlResult) {
  const frame = { type: 'observation-result' as const, id, result };
  if (Buffer.byteLength(JSON.stringify(frame) + '\n', 'utf8') > 1048576)
    return {
      type: 'observation-result' as const,
      id,
      result:
        'ok' in result
          ? { ok: false as const, tool: null, error: { code: 'budget_exceeded' as const, message: '控制面结果超过控制帧UTF-8预算' } }
          : { error: 'budget_exceeded' as const, message: '观察结果超过控制帧UTF-8预算' },
    };
  return frame;
}
