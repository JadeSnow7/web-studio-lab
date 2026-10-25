import type { ChatServiceMessage, ChatServiceRequest, WorkflowJournalEvent, WorkflowRunOutcome } from '@wsl/protocol';
import { WorkflowProcessUnconfirmedError } from './engine-port';
import type {
  WorkflowCandidatePublisher,
  WorkflowEnginePort,
  WorkflowEngineRunHandle,
  WorkflowEngineRunSpec,
  WorkflowLaneWorkspaceProvider,
  WorkflowPublishResult,
} from './engine-port';

/**
 * W4：WorkflowEnginePort 的 service 远端实现。Main↔service 只走具名 workflow-* 消息：
 * journal 不跨进程——service 把内核每条事件经 workflow-event 发回，本端口先落 SQLite
 * （spec.journal）再回 workflow-event-ack；ack 失败会让 run 记 internal_error。
 * workflow-done 到达即内核清理已确认；cleanup-unconfirmed 拒绝 done 并保留 owner。
 * W6a：lane 候选经 workflow-candidate 到达，委托应用用例登记后经
 * workflow-candidate.reply 回执；回执失败让 service 侧候选超时使调用失败，不伪造状态。
 * W8：lane 工作区经 workflow-lanebase 到达，同手法委托后经 workflow-lanebase.reply 回执。
 */

type WorkflowServiceRequest =
  | Omit<Extract<ChatServiceRequest, { method: 'workflow-run' }>, 'id'>
  | Omit<Extract<ChatServiceRequest, { method: 'workflow-stop' }>, 'id'>
  | Omit<Extract<ChatServiceRequest, { method: 'workflow-shutdown' }>, 'id'>
  | Omit<Extract<ChatServiceRequest, { method: 'workflow-event-ack' }>, 'id'>
  | Omit<Extract<ChatServiceRequest, { method: 'workflow-candidate.reply' }>, 'id'>
  | Omit<Extract<ChatServiceRequest, { method: 'workflow-lanebase.reply' }>, 'id'>;

type WorkflowServiceEvent = Extract<
  ChatServiceMessage,
  { type: 'workflow-event' | 'workflow-done' | 'workflow-cleanup-unconfirmed' | 'workflow-candidate' | 'workflow-lanebase' }
>;

/** port 对 ChatService 的最小依赖面；测试注入假通道即可，不 fork 子进程。 */
export interface WorkflowServiceChannel {
  workflowRequest(request: WorkflowServiceRequest): Promise<unknown>;
  /** workflow-event / workflow-done / workflow-candidate / workflow-lanebase 的接收方；同一时间只有一个 port 注册。 */
  setWorkflowListener(listener: (message: WorkflowServiceEvent) => void): void;
  /** service 进程退出或通信失败时回调；未收到 workflow-done 的 run 保留 owner 并拒绝 done。 */
  onExit(listener: () => void): void;
}

interface RunSlot {
  journal: (event: WorkflowJournalEvent) => Promise<void>;
  resolveDone: (outcome: WorkflowRunOutcome) => void;
  rejectDone: (error: Error) => void;
  cleanupError?: Error;
  /** 每 run 串行化处理事件：append 按序提交后才回 ack。 */
  chain: Promise<void>;
}

export class ServiceWorkflowEnginePort implements WorkflowEnginePort {
  private readonly runs = new Map<string, RunSlot>();
  private closing = false;
  private shutdownAttempt: Promise<void> | undefined;

  shutdown(): Promise<void> {
    this.closing = true;
    if (this.shutdownAttempt) return this.shutdownAttempt;
    const attempt = this.channel.workflowRequest({ method: 'workflow-shutdown' }).then(() => undefined);
    this.shutdownAttempt = attempt;
    void attempt.catch(() => {
      this.shutdownAttempt = undefined;
    });
    return attempt;
  }
  /** W6a：lane 候选登记委托（WorkflowApplication.publishCandidate）；装配后经 setter 注入。 */
  private candidatePublisher: WorkflowCandidatePublisher | undefined;
  /** W8：lane 工作区委托（WorkflowApplication.laneWorkspace）；同 publisher 手法注入。 */
  private laneWorkspaceProvider: WorkflowLaneWorkspaceProvider | undefined;

  constructor(private readonly channel: WorkflowServiceChannel) {
    channel.setWorkflowListener((message) => this.onMessage(message));
    channel.onExit(() => this.failAll());
  }

  /** 装配顺序：port → application → 回填委托；首次受理前必定完成。 */
  setCandidatePublisher(publisher: WorkflowCandidatePublisher): void {
    this.candidatePublisher = publisher;
  }

  setLaneWorkspaceProvider(provider: WorkflowLaneWorkspaceProvider): void {
    this.laneWorkspaceProvider = provider;
  }

  async run(spec: WorkflowEngineRunSpec): Promise<WorkflowEngineRunHandle> {
    if (this.closing) throw new Error('workflow is closing');
    const { journal, ...rest } = spec;
    let resolveDone!: (outcome: WorkflowRunOutcome) => void;
    let rejectDone!: (error: Error) => void;
    const done = new Promise<WorkflowRunOutcome>((resolve, reject) => {
      resolveDone = resolve;
      rejectDone = reject;
    });
    // A receipt can arrive before workflow-run ACK; ownership is installed first.
    void done.catch(() => undefined);
    this.runs.set(spec.runId, { journal, resolveDone, rejectDone, chain: Promise.resolve() });
    try {
      await this.channel.workflowRequest({ method: 'workflow-run', ...rest });
    } catch (error) {
      if (this.shutdownAttempt !== undefined) {
        const shutdown = await Promise.allSettled([this.shutdownAttempt]);
        if (shutdown[0]!.status === 'fulfilled') {
          // The remote owner confirmed shutdown, including this in-flight launch.
          this.runs.delete(spec.runId);
          throw error;
        }
      }
      const failure = new WorkflowProcessUnconfirmedError(
        `workflow admission unconfirmed: ${error instanceof Error ? error.message : String(error)}`,
      );
      const slot = this.runs.get(spec.runId)!;
      slot.cleanupError = failure;
      slot.rejectDone(failure);
      throw failure;
    }
    return {
      done,
      stop: async () => {
        const failure = this.runs.get(spec.runId)?.cleanupError;
        if (failure) throw failure;
        await this.channel.workflowRequest({ method: 'workflow-stop', runId: spec.runId });
      },
    };
  }

  private onMessage(message: WorkflowServiceEvent): void {
    if (message.type === 'workflow-cleanup-unconfirmed') {
      const slot = this.runs.get(message.runId);
      if (slot) {
        const error = new WorkflowProcessUnconfirmedError(message.error);
        slot.cleanupError = error;
        slot.rejectDone(error);
      }
      return;
    }
    if (message.type === 'workflow-done') {
      const slot = this.runs.get(message.runId);
      if (slot && slot.cleanupError === undefined) {
        this.runs.delete(message.runId);
        slot.resolveDone(message.outcome);
      }
      return;
    }
    if (message.type === 'workflow-candidate') {
      void this.handleCandidate(message);
      return;
    }
    if (message.type === 'workflow-lanebase') {
      void this.handleLanebase(message);
      return;
    }
    const slot = this.runs.get(message.runId);
    if (!slot) {
      // 未知 run 的事件仍要回执，让 service 侧 append 失败而不是悬挂。
      void this.ack(message.runId, message.seq, false, `unknown workflow run ${message.runId}`);
      return;
    }
    slot.chain = slot.chain.then(async () => {
      let error: string | undefined;
      try {
        await slot.journal(message.event);
      } catch (e) {
        error = e instanceof Error ? e.message : String(e);
      }
      await this.ack(message.runId, message.seq, error === undefined, error);
    });
  }

  /**
   * W6a：候选登记不排进 journal 链——service 已按序等待 attempt_end 的 ack 后才发来，
   * 执行事实必然已提交；登记结果经 reply 回执，超时/拒绝/缺委托一律 ok:false。
   */
  private async handleCandidate(message: Extract<WorkflowServiceEvent, { type: 'workflow-candidate' }>): Promise<void> {
    const publisher = this.candidatePublisher;
    let result: ({ ok: true } & WorkflowPublishResult) | { ok: false; error: string };
    if (publisher === undefined) {
      result = { ok: false, error: 'candidate publisher is not bound' };
    } else {
      try {
        const outcome = await publisher.publishCandidate(message.runId, message.callSeq, message.files);
        result = 'conflict' in outcome ? { ok: true, conflict: outcome.conflict } : { ok: true, publication: outcome.publication };
      } catch (error) {
        result = { ok: false, error: error instanceof Error ? error.message : String(error) };
      }
    }
    try {
      await this.channel.workflowRequest({
        method: 'workflow-candidate.reply',
        payload: { callId: message.id, result },
      });
    } catch {
      // 回执通道失败：service 侧候选等待超时让调用失败；本地不补写任何状态。
    }
  }

  /**
   * W8：lane 工作区请求不排进 journal 链——service 在 lane 首次派发前发来，
   * 登记事实（call_start）已先于它提交；结果经 workflow-lanebase.reply 回执。
   */
  private async handleLanebase(message: Extract<WorkflowServiceEvent, { type: 'workflow-lanebase' }>): Promise<void> {
    const provider = this.laneWorkspaceProvider;
    let result: { ok: true; baseTree: string; files: { path: string; base64: string }[] } | { ok: false; error: string };
    if (provider === undefined) {
      result = { ok: false, error: 'lane workspace provider is not bound' };
    } else {
      try {
        const workspace = await provider.laneWorkspace(message.runId, message.callSeq);
        result = { ok: true, baseTree: workspace.baseTree, files: workspace.files };
      } catch (error) {
        result = { ok: false, error: error instanceof Error ? error.message : String(error) };
      }
    }
    try {
      await this.channel.workflowRequest({
        method: 'workflow-lanebase.reply',
        payload: { callId: message.id, result },
      });
    } catch {
      // 回执通道失败：service 侧工作区等待超时让调用失败；本地不补写任何状态。
    }
  }

  private async ack(runId: string, seq: number, ok: boolean, error?: string): Promise<void> {
    try {
      await this.channel.workflowRequest({ method: 'workflow-event-ack', runId, seq, ok, ...(error !== undefined ? { error } : {}) });
    } catch {
      // 回执通道失败：service 侧 append 等不到 ack 会让 run 收 internal_error；本地不伪造状态。
    }
  }

  /** 子进程退出：未结清的 run 不伪造 journal，done 拒绝且 owner 保留；run 行等待核对。 */
  private failAll(): void {
    for (const slot of this.runs.values()) {
      slot.cleanupError ??= new WorkflowProcessUnconfirmedError('workflow service exited before cleanup confirmation');
      slot.rejectDone(slot.cleanupError);
    }
  }
}
