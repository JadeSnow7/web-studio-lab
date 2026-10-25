import type { ProfileDir } from '@wsl/protocol';
import {
  WorkflowCleanupUnconfirmedError,
  type CallEvent,
  type RouteRejection,
  type RouteResolution,
  type WorkflowCall,
  type WorkflowCallAdapter,
} from './call-adapter';

/**
 * W7 路由池：routeScope 授权的 Harness × Profile 成员表。
 * adapter 由宿主按成员构造（当前为带 profileDir 的 IsolatedGuestAdapter；测试可注入 MockHarness）。
 */
export interface PoolMember {
  harnessId: string;
  profileId: string;
  profileDir: ProfileDir | null;
  adapter: WorkflowCallAdapter;
}

export interface RoutedAdapterPoolDeps {
  /** 未显式声明 harness 的调用解析到该 Harness 的成员；同时是本适配器对内核报告的 harnessId。 */
  defaultHarness: string;
  members: readonly PoolMember[];
}

interface MemberState {
  readonly member: PoolMember;
  /** 该 Profile 当前是否有在飞 attempt（设计 §117：同一 Profile 任意时刻至多一个活动执行）。 */
  active: boolean;
  /** 等待槽位的 FIFO 队列（登记序）；grant 回调只在槽位移交时触发。 */
  queue: (() => void)[];
}

/**
 * W7：路由池适配器（设计 §83/§117/§119）。
 *
 * - resolveRoute 在登记期解析一次：显式 profile 必须在成员表（否则 unsupported_option）；
 *   未声明 profile 时在该 Harness 成员中选 占用+等待 最少者（并列按成员表序），provenance=auto。
 *   解析结果由内核冻结进 call_start.effective——重试不更换、续跑按内容键自行判定。
 * - run 按 call.effective.profile 找成员：同一 profileId 任意时刻在飞 ≤1；
 *   忙时在首个 next() 内 FIFO 等待（内核 timeoutMs 定界→failed{timeout} 可重试；
 *   abort/iterator.return → 静默返回，内核按 stopped 记）。等待者绑定冻结的 profile，
 *   禁止超时插队式的静默换 profile。
 */
export class RoutedAdapterPool implements WorkflowCallAdapter {
  readonly harnessId: string;
  readonly members: readonly PoolMember[];
  /** profileId → 占用状态；成员表构造后不变。 */
  private readonly states = new Map<string, MemberState>();

  constructor(deps: RoutedAdapterPoolDeps) {
    this.harnessId = deps.defaultHarness;
    this.members = [...deps.members];
    for (const member of this.members) this.states.set(member.profileId, { member, active: false, queue: [] });
  }

  supportsHarness(harnessId: string): boolean {
    return this.members.some((member) => member.harnessId === harnessId);
  }

  membersOf(harnessId: string): readonly PoolMember[] {
    return this.members.filter((member) => member.harnessId === harnessId);
  }

  resolveRoute(requested: { harness: string; profile?: string }): RouteResolution | RouteRejection {
    if (requested.profile !== undefined) {
      const member = this.members.find((item) => item.harnessId === requested.harness && item.profileId === requested.profile);
      if (member === undefined) {
        return {
          code: 'unsupported_option',
          message: `profile ${requested.profile} 不在 harness ${requested.harness} 的路由成员表内`,
        };
      }
      return { harnessId: member.harnessId, profileId: member.profileId, provenance: 'explicit' };
    }
    const candidates = this.membersOf(requested.harness);
    if (candidates.length === 0) {
      return { code: 'unsupported_option', message: `harness ${requested.harness} 在路由范围内没有可用成员` };
    }
    // 自动选择：占用（在飞+等待）最少的成员，并列按成员表登记序——确定性路由，不读额度、不挑“余额最多”。
    let best = candidates[0]!;
    let bestLoad = Number.POSITIVE_INFINITY;
    for (const member of candidates) {
      const state = this.states.get(member.profileId)!;
      const load = (state.active ? 1 : 0) + state.queue.length;
      if (load < bestLoad) {
        bestLoad = load;
        best = member;
      }
    }
    return { harnessId: best.harnessId, profileId: best.profileId, provenance: 'auto' };
  }

  run(call: WorkflowCall, signal: AbortSignal): AsyncIterable<CallEvent> {
    // 自管迭代器（同 IsolatedGuestAdapter）：内核在 abort/timeout 时调用 return()；
    // 异步生成器在等待中的 await 未 settle 前不会处理 return，故先唤醒内部 race 再走统一清理。
    let release!: () => void;
    const released = new Promise<'released'>((resolve) => {
      release = () => resolve('released');
    });
    const iterator = this.execute(call, signal, released);
    let pendingNext: Promise<IteratorResult<CallEvent, void>> | undefined;
    const self: AsyncIterableIterator<CallEvent> = {
      [Symbol.asyncIterator]() {
        return self;
      },
      next() {
        pendingNext = iterator.next();
        return pendingNext;
      },
      async return() {
        release();
        const closing = iterator.return(undefined);
        const results = await Promise.allSettled(pendingNext === undefined ? [closing] : [pendingNext, closing]);
        const failed =
          results.find((result) => result.status === 'rejected' && result.reason instanceof WorkflowCleanupUnconfirmedError) ??
          results.find((result) => result.status === 'rejected');
        if (failed?.status === 'rejected') throw failed.reason;
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
    const profile = call.effective.profile;
    const state = profile === undefined ? undefined : this.states.get(profile);
    if (state === undefined) {
      // 解析与执行不一致（成员表被篡改或绕过 resolveRoute）：内部错误而非路由拒绝。
      yield {
        type: 'failed',
        code: 'internal',
        message: `effective.profile ${String(profile)} 不在路由成员表内`,
      };
      return;
    }
    // 槽位等待在首个 next() 内完成：内核的 timeoutMs 直接定界这段等待。
    if (!(await this.acquire(state, signal, released))) return;
    const iterator = state.member.adapter.run(call, signal)[Symbol.asyncIterator]();
    // 槽位释放幂等：拿到终态即还（内核消费后可能遗弃迭代器不再走 finally）；
    // finally 兜底覆盖抛出路径与 kernel return() 唤醒路径。
    let slotHeld = true;
    let cleanupUnconfirmed = false;
    const free = () => {
      if (!slotHeld) return;
      slotHeld = false;
      this.releaseSlot(state);
    };
    try {
      // 终态事件的等待同样可被 abort/return 打断。
      const next = iterator.next();
      const first = await Promise.race([next, released.then(() => 'released' as const), abortedOf(signal)]);
      if (first === 'released' || first === 'aborted') {
        const closing = iterator.return?.();
        const results = await Promise.allSettled(closing === undefined ? [next] : [next, closing]);
        const failed =
          results.find((result) => result.status === 'rejected' && result.reason instanceof WorkflowCleanupUnconfirmedError) ??
          results.find((result) => result.status === 'rejected');
        if (failed?.status === 'rejected') throw failed.reason;
        return;
      }
      free();
      if (first.done) return;
      yield first.value;
      // 合同：每 attempt 恰一个终态事件；内核只消费首事件，无需继续排空。
    } catch (error) {
      if (error instanceof WorkflowCleanupUnconfirmedError) {
        cleanupUnconfirmed = true;
        throw error;
      }
      yield {
        type: 'failed',
        code: 'crash',
        message: `路由成员执行异常：${error instanceof Error ? error.message : String(error)}`,
      };
    } finally {
      // Unknown process ownership keeps the Profile occupied; queued calls leave through run abort.
      if (!cleanupUnconfirmed) free();
    }
  }

  /** FIFO 取槽：空闲即占；忙则登记等待者，由 abort/return 或槽位移交唤醒。 */
  private async acquire(state: MemberState, signal: AbortSignal, released: Promise<unknown>): Promise<boolean> {
    if (signal.aborted) return false;
    if (!state.active && state.queue.length === 0) {
      state.active = true;
      return true;
    }
    return new Promise<boolean>((resolve) => {
      let settled = false;
      const cleanup = () => {
        signal.removeEventListener('abort', onAbort);
        // 未获槽的等待者仍在队列中，退出必须摘除，防止给死信移交槽位。
        const index = state.queue.indexOf(grant);
        if (index >= 0) state.queue.splice(index, 1);
      };
      const finish = (ok: boolean) => {
        if (settled) return;
        settled = true;
        cleanup();
        resolve(ok);
      };
      const grant = () => finish(true);
      const onAbort = () => finish(false);
      state.queue.push(grant);
      signal.addEventListener('abort', onAbort, { once: true });
      void released.then(() => finish(false));
    });
  }

  /** 槽位移交：队首等待者直接继承 active（在飞 ≤1 不变式不断链）；无等待者才转空闲。 */
  private releaseSlot(state: MemberState): void {
    const next = state.queue.shift();
    if (next !== undefined) {
      state.active = true;
      next();
    } else {
      state.active = false;
    }
  }
}

function abortedOf(signal: AbortSignal): Promise<'aborted'> {
  return new Promise<'aborted'>((resolve) => {
    if (signal.aborted) resolve('aborted');
    else signal.addEventListener('abort', () => resolve('aborted'), { once: true });
  });
}
