import type { ProfileDir, WorkflowInputFile, WorkflowRunInput } from '@wsl/protocol';
import type { GuestFrame, GuestOutcome, GuestProcess, GuestStart } from '../sbx';
import type { HarnessEvent, NativeHarnessAdapter } from '../harness/types';
import { WorkflowCleanupUnconfirmedError } from './call-adapter';
import type { CallEvent, CallUsage, ExecutionCapabilityRequest, RouteRejection, WorkflowCall, WorkflowCallAdapter } from './call-adapter';

/** SbxConnection.start 返回进程的最小面：完成回执、清理关闭与写帧。 */
export type GuestProcessLike = Pick<GuestProcess, 'done' | 'close' | 'write'>;

export interface IsolatedGuestAdapterDeps {
  /** SbxConnection.start.bind(connection) 或测试注入的伪实现。 */
  start: (start: GuestStart, onFrame: (frame: GuestFrame) => void) => GuestProcessLike;
  harness: NativeHarnessAdapter;
  /** 所属 workflow runId（uuid）：guest workspace 物化与 collect 帧回传的身份要求。 */
  runId: string;
  /** run 级冻结输入文件；每次 attempt 由 helper 全新物化到独立目录，重试不继承半成品。 */
  input?: WorkflowRunInput;
  profileDir?: ProfileDir;
  /** W6a：collect 帧的等待上限（测试可注入更小值）；超时按候选采集未确认处理。 */
  collectTimeoutMs?: number;
}

const TRAJECTORY_CAP = 64;
const STDERR_CAP = 4000;
const COLLECT_TIMEOUT_MS = 30_000;

/**
 * W3/W6a 隔离 Harness 能力：一次 attempt 在 guest 内以独立执行身份运行隔离 argv，
 * 冻结输入物化到独立目录；不挂载 wsl_space MCP / 资源包 / 观察 / stdin relay，
 * 因此没有递归 workflow 能力，也无法写主项目或共享 Git 元数据。
 * readonly 走只读 argv；lane 用写能力 argv 但 cwd 仍是每次 attempt 重建的 Lab 目录，
 * 退出码 0 且未失败时经 collect 帧采集目录文件集作为候选，helper 确认清理后候选才可信。
 * 仅覆盖 NativeHarnessAdapter（逐行协议）；ACP spec-harness 不实现该接口，无法传入。
 * 停止与失败复用 codex-chat 的 proc.close() 清理路径：清理未确认抛出独立 owner 错误，不能按普通 crash/stopped 释放。
 */
export class IsolatedGuestAdapter implements WorkflowCallAdapter {
  readonly harnessId: string;
  /** Unconfirmed processes remain owned even when the attempt cannot continue. */
  private readonly unconfirmedGuests = new Map<GuestProcessLike, WorkflowCleanupUnconfirmedError>();

  private unconfirmed(proc: GuestProcessLike, reason: unknown): WorkflowCleanupUnconfirmedError {
    const error =
      reason instanceof WorkflowCleanupUnconfirmedError
        ? reason
        : new WorkflowCleanupUnconfirmedError(`cleanup unconfirmed: ${messageOf(reason)}`);
    this.unconfirmedGuests.set(proc, error);
    return error;
  }

  constructor(private readonly deps: IsolatedGuestAdapterDeps) {
    this.harnessId = deps.harness.harnessId;
  }

  /**
   * W9：登记期表达力核对——isolation+model/tier 组不出 argv 时按 unsupported_option
   * 在 attempt_start 之前拒绝（内核同路径处理，不消耗注定丢弃的执行）。
   */
  checkExecution(request: ExecutionCapabilityRequest): RouteRejection | null {
    const argv = this.argvFor(request.isolation, request);
    if (argv !== null && argv.length > 0) return null;
    return {
      code: 'unsupported_option',
      message:
        request.model !== undefined || request.tier !== undefined
          ? `${this.deps.harness.label} 无法表达 ${request.isolation} 隔离与指定 model/tier 组合`
          : `${this.deps.harness.label} 不提供 ${request.isolation} 隔离能力`,
    };
  }

  /** 调用级 execution 参数（effective.model/tier）→ 隔离 argv；两字段缺省时按无 execution 调用。 */
  private argvFor(isolation: WorkflowCall['isolation'], execution: { model?: string; tier?: 'small' | 'medium' | 'big' }) {
    const options =
      execution.model !== undefined || execution.tier !== undefined
        ? {
            ...(execution.model !== undefined ? { model: execution.model } : {}),
            ...(execution.tier !== undefined ? { tier: execution.tier } : {}),
          }
        : undefined;
    return this.deps.harness.argvForIsolation?.(isolation, options) ?? null;
  }

  run(call: WorkflowCall, signal: AbortSignal): AsyncIterable<CallEvent> {
    // 自管迭代器：内核在 abort/timeout 时调用 return()；异步生成器在等待中的 await
    // 未 settle 前不会处理 return 完成，故先唤醒内部 race，再让生成器经 finally 走同一清理路径。
    let release!: () => void;
    const released = new Promise<'released'>((resolve) => {
      release = () => resolve('released');
    });
    const iterator = this.execute(call, signal, released);
    let pendingNext: ReturnType<typeof iterator.next> | undefined;
    let cleanupError: WorkflowCleanupUnconfirmedError | undefined;
    const self: AsyncIterableIterator<CallEvent> = {
      [Symbol.asyncIterator]() {
        return self;
      },
      next() {
        pendingNext = iterator.next().catch((error: unknown) => {
          if (error instanceof WorkflowCleanupUnconfirmedError) cleanupError = error;
          throw error;
        });
        return pendingNext;
      },
      async return() {
        release();
        // A rejected pending next may finish the generator before return is serviced.
        // Its cleanup failure remains authoritative even if queued return resolves.
        const results = await Promise.allSettled([...(pendingNext ? [pendingNext] : []), iterator.return(undefined)]);
        if (cleanupError) throw cleanupError;
        const unconfirmed = results.find(
          (result) => result.status === 'rejected' && result.reason instanceof WorkflowCleanupUnconfirmedError,
        );
        if (unconfirmed?.status === 'rejected') throw unconfirmed.reason;
        for (const result of results) if (result.status === 'rejected') throw result.reason;
        return { done: true, value: undefined };
      },
      async throw(error?: unknown) {
        release();
        return iterator.throw(error);
      },
    };
    return self;
  }

  private async *execute(call: WorkflowCall, signal: AbortSignal, released: Promise<unknown>): AsyncGenerator<CallEvent, void> {
    const { harness } = this.deps;
    const lane = call.isolation === 'lane';
    if (call.isolation !== 'readonly' && !lane) {
      yield { type: 'failed', code: 'unsupported_option', message: `isolation ${String(call.isolation)} 不受支持` };
      return;
    }
    // W9：run() 入口兜底判定——登记期 checkExecution 已早拒绝的情形不会到这里；
    // 适配器绕过登记或表达力在执行期变化时，argv 组不出仍在 spawn 前失败。
    const argv = this.argvFor(call.isolation, call.effective);
    if (argv === null || argv.length === 0) {
      const reason =
        call.effective.model !== undefined || call.effective.tier !== undefined
          ? `${harness.label} 无法表达 ${call.isolation} 隔离与指定 model/tier 组合`
          : `${harness.label} 不提供 ${call.isolation} 隔离能力`;
      yield { type: 'failed', code: 'unsupported_option', message: reason };
      return;
    }

    // 帧先同步入队再按序消费；onFrame 不允许做异步工作。start 只带 argv/prompt/workspace/profileDir，
    // 不携带 mcp/resourceBundle/observation/stdin：子运行没有 wsl_space 工具面与递归能力。
    const frames: GuestFrame[] = [];
    let wake: (() => void) | null = null;
    const startSpec: GuestStart = {
      type: 'start',
      mode: 'codex',
      argv,
      prompt: call.prompt,
      // W5：无冻结输入的调用也物化独立目录（files:[] → 空目录）——隔离目录是逐 attempt 的身份事实。
      // W8：lane 优先用内核经 laneWorkspace 端口取回的登记基线物化（波次基线），缺省回退 run 级冻结输入。
      workspace: {
        runId: this.deps.runId,
        files: lane ? (call.laneInput ?? this.deps.input?.files ?? []) : (this.deps.input?.files ?? []),
      },
      // W6a：lane 声明 collect——helper 在 child 退出 0 后打开采集窗口等待 collect/close。
      ...(lane ? { collect: true } : {}),
      ...(this.deps.profileDir ? { profileDir: this.deps.profileDir } : {}),
    };
    let proc: GuestProcessLike;
    try {
      proc = this.deps.start(startSpec, (frame) => {
        frames.push(frame);
        const notify = wake;
        wake = null;
        notify?.();
      });
    } catch (error) {
      yield { type: 'failed', code: 'crash', message: `guest 启动失败：${messageOf(error)}` };
      return;
    }

    let settled = false;
    let outcome: GuestOutcome | null = null;
    let outcomeError: string | null = null;
    // close 只发起一次：失败收尾、abort 与 finally 共用同一回执。
    const closeReceipt: { promise: Promise<GuestOutcome> | null } = { promise: null };
    const requestClose = () => {
      if (closeReceipt.promise !== null) return;
      try {
        closeReceipt.promise = proc.close().then(
          (result) => {
            if (!result.confirmed) throw this.unconfirmed(proc, result.error ?? 'negative guest cleanup receipt');
            return result;
          },
          (error: unknown) => {
            throw this.unconfirmed(proc, error);
          },
        );
      } catch (error) {
        closeReceipt.promise = Promise.reject(this.unconfirmed(proc, error));
      }
      // close can fail before done settles; the same receipt participates in the loop.
      void closeReceipt.promise.catch(() => undefined);
    };
    try {
      let buffer = '';
      let stderr = '';
      let lastText = '';
      let turnCompleted = false;
      let turnUsage: CallUsage | null = null;
      let failure: string | null = null;
      // workspace 帧只计数不消费（只读运行不接收写回）；计数备将来诊断使用。
      let _workspaceFrames = 0;
      // W6a lane 采集状态机：exit0 → 请求 collect → collect 帧（身份复核后收下）→ helper 自清。
      // 状态放对象里：跨闭包赋值不依赖局部变量收窄。
      let exitZero = false;
      const collect = {
        state: 'idle' as 'idle' | 'requested' | 'done' | 'failed',
        files: null as WorkflowInputFile[] | null,
        timer: null as ReturnType<typeof setTimeout> | null,
        timedOut: false,
      };
      // 轨迹只保留有界内存形态：CallEvent 尚无轨迹通道，不外发。
      const trajectory: HarnessEvent[] = [];
      // 失败即发起清理（同 codex-chat fail→closeTurn）；首个失败原因保留为消息。
      const setFailure = (reason: string) => {
        failure ??= reason;
        requestClose();
      };
      const consumeLine = (line: string) => {
        if (!line.trim()) return;
        // 归一化 HarnessEvent 不带 token 用量：本适配器额外看原始 turn.completed，
        // 用量未提供保持 unknown，不折算、不记 0。
        try {
          const raw: unknown = JSON.parse(line);
          if (typeof raw === 'object' && raw !== null && (raw as { type?: unknown }).type === 'turn.completed') {
            const usage = (raw as { usage?: unknown }).usage;
            if (typeof usage === 'object' && usage !== null) {
              const u = usage as Record<string, unknown>;
              if (typeof u['input_tokens'] === 'number' && typeof u['output_tokens'] === 'number') {
                turnUsage = { inputTokens: u['input_tokens'], outputTokens: u['output_tokens'] };
              }
            }
          }
        } catch {
          // 非 JSON 行由 parseLine 判定协议错误，这里不重复诊断。
        }
        let events: HarnessEvent[] | null;
        try {
          events = harness.parseLine(line);
        } catch (error) {
          setFailure(`${harness.label} 协议错误：${(error as Error).message}`);
          return;
        }
        if (!events) return;
        for (const event of events) {
          if (event.type === 'message') lastText = event.text;
          else if (event.type === 'turn_completed') turnCompleted = true;
          else if (event.type === 'turn_failed') setFailure(event.message);
          else {
            trajectory.push(event);
            if (trajectory.length > TRAJECTORY_CAP) trajectory.shift();
          }
        }
      };
      const consumeStdout = (data: string) => {
        buffer += data;
        if (buffer.length > harness.maxLineChars) {
          setFailure(`${harness.label} 协议行超过限制`);
          buffer = '';
          return;
        }
        while (buffer.includes('\n')) {
          const index = buffer.indexOf('\n');
          consumeLine(buffer.slice(0, index));
          buffer = buffer.slice(index + 1);
        }
      };
      const onFrame = (frame: GuestFrame) => {
        switch (frame.type) {
          case 'output':
            if (frame.stream === 'stderr') stderr = (stderr + frame.data).slice(-STDERR_CAP);
            else consumeStdout(frame.data);
            return;
          case 'exit':
            if (frame.exitCode !== 0) setFailure(`guest 进程退出失败（${frame.exitCode}）`);
            else exitZero = true;
            return;
          case 'collect':
            // lane 候选帧：runId 不匹配即协议违约；重复/迟到帧不改变已收下的候选。
            if (frame.runId !== this.deps.runId) {
              setFailure('lane 候选帧身份不匹配');
              return;
            }
            if (collect.state === 'requested') {
              collect.state = 'done';
              collect.files = frame.files;
              if (collect.timer !== null) {
                clearTimeout(collect.timer);
                collect.timer = null;
              }
            }
            return;
          case 'error':
            setFailure(frame.error);
            return;
          case 'cleanup':
            if (!frame.ok) setFailure(`cleanup unconfirmed${frame.error ? `：${frame.error}` : ''}`);
            return;
          case 'workspace':
            _workspaceFrames += 1;
            return;
          default:
            // ready/mcp-server/observation-*：本模式未声明这些能力，按已知帧忽略。
            return;
        }
      };
      const crash = (reason: string): CallEvent => {
        const tail = stderr.trim();
        return { type: 'failed', code: 'crash', message: tail ? `${reason}：${tail.slice(-2000)}` : reason };
      };
      // lane：exit0 且无失败时向 helper 请求一次候选采集；helper 窗口收到 collect 后自走清理。
      const maybeRequestCollect = () => {
        if (!lane || !exitZero || failure !== null || collect.state !== 'idle') return;
        collect.state = 'requested';
        collect.timedOut = false;
        collect.timer = setTimeout(() => {
          collect.timedOut = true;
          const notify = wake;
          wake = null;
          notify?.();
        }, this.deps.collectTimeoutMs ?? COLLECT_TIMEOUT_MS);
        collect.timer.unref?.();
        try {
          proc.write({ type: 'collect' });
        } catch {
          collect.state = 'failed';
          setFailure('lane 候选采集请求失败');
        }
      };

      const aborted = new Promise<'aborted'>((resolve) => {
        if (signal.aborted) resolve('aborted');
        else signal.addEventListener('abort', () => resolve('aborted'), { once: true });
      });

      // 在终态 yield 前必须等到 done：否则生成器被内核遗弃时 guest 进程状态与清理确认都无从核对。
      while (!settled && !signal.aborted) {
        while (frames.length > 0) onFrame(frames.shift()!);
        maybeRequestCollect();
        if (collect.timedOut && collect.state === 'requested') {
          collect.state = 'failed';
          setFailure('lane 候选采集未确认');
        }
        if (signal.aborted) break;
        const reason = await Promise.race([
          proc.done.then(
            (done) => ({ done }),
            (error: unknown) => ({ doneError: error }),
          ),
          new Promise<'frame'>((resolve) => {
            wake = () => resolve('frame');
          }),
          aborted,
          released.then(() => 'released' as const),
          ...(closeReceipt.promise === null ? [] : [closeReceipt.promise.then((done) => ({ done }))]),
        ]);
        if (reason === 'aborted' || reason === 'released') break;
        if (typeof reason === 'object') {
          settled = true;
          if ('done' in reason) outcome = reason.done;
          else outcomeError = messageOf(reason.doneError);
        }
      }
      if (collect.timer !== null) {
        clearTimeout(collect.timer);
        collect.timer = null;
      }

      // 停止语义：abort/return 都走同一 proc.close() 清理，不产出终态（内核按 stopped 记录）。
      if (!settled) {
        requestClose();
        await closeReceipt.promise;
        return;
      }
      // 排空尾部帧；末行可无换行（同 codex-chat 收尾）。
      while (frames.length > 0) onFrame(frames.shift()!);
      if (buffer.trim()) consumeLine(buffer);

      if (outcomeError !== null) throw this.unconfirmed(proc, outcomeError);
      if (!outcome!.confirmed) throw this.unconfirmed(proc, outcome!.error ?? 'negative guest cleanup receipt');
      if (failure !== null) yield crash(failure);
      else if (outcome!.error !== null) yield crash(outcome!.error);
      else if (lane && collect.state !== 'done') yield crash('lane 候选采集未确认');
      else if (turnCompleted) {
        yield lastText.trim()
          ? {
              type: 'result',
              text: lastText,
              ...(turnUsage ? { usage: turnUsage } : {}),
              // W6a：候选文件集随 result 事件回内核，由 publishCandidate 端口在 call_end 前登记。
              ...(lane && collect.files !== null ? { candidate: { files: collect.files } } : {}),
            }
          : { type: 'failed', code: 'empty_output', message: 'turn completed without assistant text' };
      } else {
        yield crash('guest 进程结束但未产生终态事件');
      }
      return;
    } finally {
      // abort/timeout 经 iterator.return() 到达；未 settle 时必须确认清理。
      if (!settled) {
        requestClose();
        await closeReceipt.promise;
      }
    }
  }
}

function messageOf(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
