import { randomUUID } from 'node:crypto';
import type { ChatServiceMessage, ChatServiceRequest, ProfileDir, WorkflowJournalEvent, WorkflowRunOutcome } from '@wsl/protocol';
import type { GuestFrame, GuestStart } from './sbx';
import type { NativeHarnessAdapter } from './harness/types';
import type { WorkflowCallAdapter, WorkflowCandidate, WorkflowLaneWorkspace, WorkflowPublishOutcome } from './workflow/call-adapter';
import { WorkflowEngine, type WorkflowEngineRunSpec } from './workflow/engine';
import { IsolatedGuestAdapter, type GuestProcessLike } from './workflow/isolated-guest-adapter';
import { RoutedAdapterPool, type PoolMember } from './workflow/routed-pool';

/**
 * W4 service 侧 workflow 宿主（最小入口）：把 Main 受理的固定任务 spec 交给共享 WorkflowEngine，
 * 内核逐条 await 的 journal 事件经 workflow-event 发给 Main 落 SQLite，等待 workflow-event-ack；
 * ack 拒绝（ok:false）让 append 抛错，内核记 internal_error。run 终态经 workflow-done 单独发布。
 * W6a：lane 调用的候选文件集在 call_end 之前经 workflow-candidate 消息发给 Main，
 * 等 workflow-candidate.reply 回执——发布结果是业务事实，Main 登记后才允许 call_end 落盘。
 * 并发约束由 Main 应用层的 run_busy 保证，这里只按 runId 保存句柄；引擎为单例。
 */

/** 本宿主对引擎的最小依赖面；WorkflowEngine 直接满足，测试可注入假实现。 */
export interface WorkflowEngineLike {
  run(spec: WorkflowEngineRunSpec): Promise<{ done: Promise<WorkflowRunOutcome>; stop(): Promise<void> }>;
}

export interface ServiceWorkflowHostDeps {
  /** 经 ChatServiceMessageSchema 校验后发给 Main 的消息通道。 */
  post: (message: ChatServiceMessage) => void;
  /** service 初始化完成（sbx 探测已结束）；workflow-run 受理前等待。 */
  ready: Promise<unknown>;
  /** guest 启动面：SbxConnection.start.bind(connection) 或测试伪实现。 */
  start: (start: GuestStart, onFrame: (frame: GuestFrame) => void) => GuestProcessLike;
  /**
   * 隔离执行可用的 native Harness 适配器表（首个为缺省/单适配器路径）。
   * W7 路由成员按 harnessId 在此表解析；ACP spec-harness 不实现 NativeHarnessAdapter，入不了表。
   */
  harnesses: readonly NativeHarnessAdapter[];
  /** 内置 Profile 的配置目录；codex:default 为 undefined（沿用 guest 预设 CODEX_HOME）。 */
  profileDir?: ProfileDir;
  /** 测试注入：替换真实引擎；缺省按 start/harness 构造共享 WorkflowEngine。 */
  engine?: WorkflowEngineLike;
  /** W6a：workflow-candidate 回执等待上限（测试可注入更小值）；超时使对应调用失败而非悬挂。 */
  candidateTimeoutMs?: number;
}

type WorkflowRunRequest = Extract<ChatServiceRequest, { method: 'workflow-run' }>;
type WorkflowStopRequest = Extract<ChatServiceRequest, { method: 'workflow-stop' }>;
type WorkflowAckRequest = Extract<ChatServiceRequest, { method: 'workflow-event-ack' }>;
type WorkflowCandidateReplyRequest = Extract<ChatServiceRequest, { method: 'workflow-candidate.reply' }>;
type WorkflowLanebaseReplyRequest = Extract<ChatServiceRequest, { method: 'workflow-lanebase.reply' }>;

const CANDIDATE_TIMEOUT_MS = 30_000;

export class ServiceWorkflowHost {
  private readonly deps: ServiceWorkflowHostDeps;
  private readonly engine: WorkflowEngineLike;
  private readonly handles = new Map<string, { done: Promise<unknown>; stop(): Promise<void> }>();
  /** runId → 下一条 journal 事件的 seq（每 run 从 1 单调递增）。 */
  private readonly nextSeq = new Map<string, number>();
  private readonly pendingAcks = new Map<string, { resolve: () => void; reject: (error: Error) => void }>();
  /** W6a：callId（=workflow-candidate 消息 id）→ 发布等待者；reply 按 callId 精确匹配。 */
  private readonly pendingCandidates = new Map<
    string,
    {
      runId: string;
      resolve: (outcome: WorkflowPublishOutcome) => void;
      reject: (error: Error) => void;
      timer: ReturnType<typeof setTimeout>;
    }
  >();
  /** W8：callId（=workflow-lanebase 消息 id）→ lane 工作区等待者；reply 按 callId 精确匹配。 */
  private readonly pendingLanebases = new Map<
    string,
    {
      runId: string;
      resolve: (workspace: WorkflowLaneWorkspace) => void;
      reject: (error: Error) => void;
      timer: ReturnType<typeof setTimeout>;
    }
  >();

  private closing = false;
  private readonly launches = new Map<Promise<null>, AbortController>();
  private shutdownAttempt: Promise<void> | undefined;

  beginShutdown(): void {
    this.closing = true;
    for (const controller of this.launches.values()) controller.abort();
  }

  shutdown(): Promise<void> {
    this.beginShutdown();
    if (this.shutdownAttempt) return this.shutdownAttempt;
    const attempt = (async () => {
      await Promise.allSettled([...this.launches.keys()]);
      const results = await Promise.allSettled(
        [...this.handles.values()].map(async (handle) => {
          await handle.stop();
          await handle.done;
        }),
      );
      const errors = results.flatMap((result) => (result.status === 'rejected' ? [result.reason] : []));
      if (errors.length)
        throw new AggregateError(
          errors,
          errors.map((error: unknown) => (error instanceof Error ? error.message : String(error))).join('\n'),
        );
    })();
    this.shutdownAttempt = attempt;
    void attempt.catch(() => {
      this.shutdownAttempt = undefined;
    });
    return attempt;
  }

  constructor(deps: ServiceWorkflowHostDeps) {
    this.deps = deps;
    this.engine =
      deps.engine ??
      new WorkflowEngine({
        // createAdapter 总是提供，deps.adapter 仅满足类型要求、不会被派发。
        adapter: {
          harnessId: deps.harnesses[0]?.harnessId ?? 'workflow',
          run: () => {
            throw new Error('workflow adapter must come from createAdapter');
          },
        } as WorkflowCallAdapter,
        createAdapter: (spec) => this.createAdapter(spec),
      });
  }

  /**
   * 每 run 构造调用适配器：routeScope 存在时构建 RoutedAdapterPool——成员必须解析到
   * harnesses 表内有 readonly 隔离 argv 的 native 适配器，不满足的成员剔除
   * （剔除后空池仍受理：调用以 failed{unsupported_option} 诚实结束，不静默改派）。
   * 不存在时维持原单适配器路径（首个 harness + deps.profileDir）。
   */
  private createAdapter(spec: WorkflowEngineRunSpec): WorkflowCallAdapter {
    if (spec.routeScope === undefined) {
      return new IsolatedGuestAdapter({
        start: this.deps.start,
        harness: this.deps.harnesses[0]!,
        runId: spec.runId,
        input: spec.input,
        ...(this.deps.profileDir ? { profileDir: this.deps.profileDir } : {}),
      });
    }
    const members: PoolMember[] = [];
    for (const member of spec.routeScope.members) {
      const native = this.deps.harnesses.find((candidate) => candidate.harnessId === member.harnessId);
      // 无 native 适配器（如 ACP 的 claude-code）或不提供 readonly 隔离 argv 的成员不进池。
      if (native === undefined || native.argvForIsolation?.('readonly') == null) continue;
      members.push({
        harnessId: member.harnessId,
        profileId: member.profileId,
        profileDir: member.profileDir,
        adapter: new IsolatedGuestAdapter({
          start: this.deps.start,
          harness: native,
          runId: spec.runId,
          input: spec.input,
          ...(member.profileDir ? { profileDir: member.profileDir } : {}),
        }),
      });
    }
    return new RoutedAdapterPool({ defaultHarness: spec.routeScope.defaultHarness, members });
  }

  owns(method: string): boolean {
    return (
      method === 'workflow-run' ||
      method === 'workflow-stop' ||
      method === 'workflow-shutdown' ||
      method === 'workflow-event-ack' ||
      method === 'workflow-candidate.reply' ||
      method === 'workflow-lanebase.reply'
    );
  }

  /** 返回该请求在统一 {type:'response'} 回执中的 result（均为 null）。 */
  async execute(request: ChatServiceRequest): Promise<null> {
    switch (request.method) {
      case 'workflow-run':
        return this.handleRun(request);
      case 'workflow-stop':
        return this.handleStop(request);
      case 'workflow-shutdown':
        await this.shutdown();
        return null;
      case 'workflow-event-ack':
        return this.handleAck(request);
      case 'workflow-candidate.reply':
        return this.handleCandidateReply(request);
      case 'workflow-lanebase.reply':
        return this.handleLanebaseReply(request);
      default:
        throw new Error(`workflow 宿主不处理 method=${String(request.method)}`);
    }
  }

  private handleRun(request: WorkflowRunRequest): Promise<null> {
    if (this.closing) return Promise.reject(new Error('workflow is closing'));
    const controller = new AbortController();
    const pending = this.launch(request, controller.signal);
    this.launches.set(pending, controller);
    void pending.then(
      () => this.launches.delete(pending),
      () => this.launches.delete(pending),
    );
    return pending;
  }

  private async launch(request: WorkflowRunRequest, signal: AbortSignal): Promise<null> {
    await this.deps.ready;
    if (this.closing) throw new Error('workflow is closing');
    if (this.handles.has(request.runId)) throw new Error(`workflow runId 重复受理：${request.runId}`);
    const runId = request.runId;
    const journal = async (event: WorkflowJournalEvent): Promise<void> => {
      const seq = (this.nextSeq.get(runId) ?? 0) + 1;
      this.nextSeq.set(runId, seq);
      await new Promise<void>((resolve, reject) => {
        this.pendingAcks.set(`${runId}:${seq}`, { resolve, reject });
        // post 抛错说明传输已死：让 append 失败，内核记 internal_error。
        this.deps.post({ type: 'workflow-event', runId, seq, event });
      });
    };
    // W6a/W8：lane 候选发布走独立消息（不进 journal ack 链）；Main 合并登记后回执，
    // 回 publication|conflict 联合；超时/拒绝/失联都失败。
    const publishCandidate = (callSeq: number, candidate: WorkflowCandidate): Promise<WorkflowPublishOutcome> =>
      new Promise<WorkflowPublishOutcome>((resolve, reject) => {
        const callId = randomUUID();
        const timeout = this.deps.candidateTimeoutMs ?? CANDIDATE_TIMEOUT_MS;
        const timer = setTimeout(() => {
          this.pendingCandidates.delete(callId);
          reject(new Error('workflow-candidate 回执超时'));
        }, timeout);
        timer.unref?.();
        this.pendingCandidates.set(callId, { runId, resolve, reject, timer });
        try {
          this.deps.post({ type: 'workflow-candidate', id: callId, runId, callSeq, files: candidate.files });
        } catch (error) {
          clearTimeout(timer);
          this.pendingCandidates.delete(callId);
          reject(error instanceof Error ? error : new Error(String(error)));
        }
      });
    // W8：lane 工作区同样走独立消息对（workflow-lanebase → .reply）；回执失败按端口错误上抛，
    // code=unavailable 使内核记 failed{unavailable}（区别于 internal）。
    const laneWorkspace = (callSeq: number): Promise<WorkflowLaneWorkspace> =>
      new Promise<WorkflowLaneWorkspace>((resolve, reject) => {
        const callId = randomUUID();
        const timeout = this.deps.candidateTimeoutMs ?? CANDIDATE_TIMEOUT_MS;
        const timer = setTimeout(() => {
          this.pendingLanebases.delete(callId);
          reject(new Error('workflow-lanebase 回执超时'));
        }, timeout);
        timer.unref?.();
        this.pendingLanebases.set(callId, { runId, resolve, reject, timer });
        try {
          this.deps.post({ type: 'workflow-lanebase', id: callId, runId, callSeq });
        } catch (error) {
          clearTimeout(timer);
          this.pendingLanebases.delete(callId);
          reject(error instanceof Error ? error : new Error(String(error)));
        }
      });
    const spec: WorkflowEngineRunSpec = {
      signal,
      runId,
      script: request.script,
      args: request.args,
      deadlineMs: request.deadlineMs,
      cache: request.cache ?? [],
      journal,
      parentRunId: request.parentRunId,
      input: request.input,
      baseTree: request.baseTree,
      appTarget: request.appTarget,
      publishCandidate,
      laneWorkspace,
      routeScope: request.routeScope,
    };
    let handle: Awaited<ReturnType<WorkflowEngineLike['run']>>;
    try {
      handle = await this.engine.run(spec);
    } catch (error) {
      // 受理失败时残留的同 run 等待者一并结清，避免悬挂 promise。
      const failure = error instanceof Error ? error : new Error(String(error));
      this.rejectAcks(runId, failure);
      this.rejectCandidates(runId, failure);
      this.rejectLanebases(runId, failure);
      this.nextSeq.delete(runId);
      throw error;
    }
    this.handles.set(runId, handle);
    void handle.done.then(
      (outcome) => {
        this.handles.delete(runId);
        this.nextSeq.delete(runId);
        // done 之后不再有合法候选/工作区请求：迟到等待者以终态结清而不是悬挂。
        this.rejectCandidates(runId, new Error(`workflow run 已终态（${outcome.status}），候选发布通道关闭`));
        this.rejectLanebases(runId, new Error(`workflow run 已终态（${outcome.status}），lane 工作区通道关闭`));
        this.deps.post({ type: 'workflow-done', runId, outcome });
      },
      (error: unknown) => {
        // Retain the owner and its receipts; this is not a confirmed terminal outcome.
        this.deps.post({ type: 'workflow-cleanup-unconfirmed', runId, error: error instanceof Error ? error.message : String(error) });
      },
    );
    return null;
  }

  private async handleStop(request: WorkflowStopRequest): Promise<null> {
    // stop 返回即内核清理已确认（worker dispose、终态 journal 已提交并经 Main ack）。
    const handle = this.handles.get(request.runId);
    if (handle) {
      await handle.stop();
      await handle.done;
    }
    return null;
  }

  private handleAck(request: WorkflowAckRequest): null {
    const key = `${request.runId}:${request.seq}`;
    const waiter = this.pendingAcks.get(key);
    if (waiter) {
      this.pendingAcks.delete(key);
      if (request.ok) waiter.resolve();
      else waiter.reject(new Error(request.error ?? 'journal 落盘回执拒绝'));
    }
    return null;
  }

  /** W6a/W8：Main 的候选回执按 callId 精确匹配；未知 callId（迟到/错配）直接丢弃，等待者由超时结清。 */
  private handleCandidateReply(request: WorkflowCandidateReplyRequest): null {
    const pending = this.pendingCandidates.get(request.payload.callId);
    if (!pending) return null;
    this.pendingCandidates.delete(request.payload.callId);
    clearTimeout(pending.timer);
    const result = request.payload.result;
    if (result.ok && 'conflict' in result) pending.resolve({ conflict: result.conflict });
    else if (result.ok) pending.resolve({ publication: result.publication });
    else pending.reject(new Error(result.error));
    return null;
  }

  /** W8：lane 工作区回执按 callId 精确匹配；同 pendingCandidates 的匹配/丢弃口径。 */
  private handleLanebaseReply(request: WorkflowLanebaseReplyRequest): null {
    const pending = this.pendingLanebases.get(request.payload.callId);
    if (!pending) return null;
    this.pendingLanebases.delete(request.payload.callId);
    clearTimeout(pending.timer);
    const result = request.payload.result;
    if (result.ok) pending.resolve({ baseTree: result.baseTree, files: result.files });
    else {
      const error = new Error(result.error);
      (error as { code?: string }).code = 'unavailable';
      pending.reject(error);
    }
    return null;
  }

  private rejectAcks(runId: string, error: Error): void {
    const prefix = `${runId}:`;
    for (const [key, waiter] of this.pendingAcks) {
      if (key.startsWith(prefix)) {
        this.pendingAcks.delete(key);
        waiter.reject(error);
      }
    }
  }

  private rejectCandidates(runId: string, error: Error): void {
    for (const [callId, pending] of this.pendingCandidates) {
      if (pending.runId === runId) {
        this.pendingCandidates.delete(callId);
        clearTimeout(pending.timer);
        pending.reject(error);
      }
    }
  }

  private rejectLanebases(runId: string, error: Error): void {
    for (const [callId, pending] of this.pendingLanebases) {
      if (pending.runId === runId) {
        this.pendingLanebases.delete(callId);
        clearTimeout(pending.timer);
        pending.reject(error);
      }
    }
  }
}
