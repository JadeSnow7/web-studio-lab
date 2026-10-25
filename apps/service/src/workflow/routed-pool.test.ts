import { describe, expect, it } from 'vitest';
import type { CallEvent, WorkflowCall, WorkflowCallAdapter } from './call-adapter';
import { RoutedAdapterPool, type PoolMember } from './routed-pool';

/**
 * W7 路由池单测：resolveRoute 显式/auto/越界；同一 Profile 单活动执行；
 * FIFO 等待（登记序）；等待可中止（abort→无终态）；等待者绑定冻结 profile，无静默替换。
 * 内核协作的 timeout/deadline 定界在 scheduler-e5.test.ts 覆盖。
 */

const call = (profile: string, label = 'c'): WorkflowCall => ({
  callId: `r:${label}`,
  prompt: 'p',
  label,
  phase: null,
  effective: { harness: 'ha', profile },
  schema: null,
  isolation: 'readonly',
  tools: [],
  timeoutMs: 60_000,
});

/** 可控成员适配器：handler 决定终态事件；跟踪在飞峰值（终态到手即出飞，与内核遗弃语义一致）。 */
function scriptedMember(
  harnessId: string,
  profileId: string,
  handler: (call: WorkflowCall, signal: AbortSignal) => Promise<CallEvent>,
): PoolMember & { active: number; peak: number; started: (string | null)[] } {
  const member = {
    harnessId,
    profileId,
    profileDir: null,
    active: 0,
    peak: 0,
    started: [] as (string | null)[],
    adapter: {
      harnessId,
      run(call: WorkflowCall, signal: AbortSignal): AsyncIterable<CallEvent> {
        const self = member;
        return (async function* (): AsyncGenerator<CallEvent, void> {
          self.active += 1;
          self.peak = Math.max(self.peak, self.active);
          self.started.push(call.label);
          let inFlight = true;
          const dec = () => {
            if (!inFlight) return;
            inFlight = false;
            self.active -= 1;
          };
          try {
            const event = await handler(call, signal);
            // 终态事件到手即出飞（内核消费后可能遗弃迭代器，不再走 finally）。
            dec();
            yield event;
          } finally {
            // handler 抛出/生成器在 yield 前被遗弃时同样出飞计数。
            dec();
          }
        })();
      },
    } satisfies WorkflowCallAdapter,
  };
  return member as PoolMember & { active: number; peak: number; started: (string | null)[] };
}

function deferred<T>(): { promise: Promise<T>; resolve: (value: T) => void } {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((r) => {
    resolve = r;
  });
  return { promise, resolve };
}

const okEvent = (): CallEvent => ({ type: 'result', text: 'ok' });

async function* collect(iterable: AsyncIterable<CallEvent>): AsyncGenerator<CallEvent, void> {
  for await (const event of iterable) yield event;
}

describe('RoutedAdapterPool.resolveRoute', () => {
  const member = (harnessId: string, profileId: string) => scriptedMember(harnessId, profileId, async () => okEvent()) as PoolMember;

  it('explicit profile resolves to the matching member (provenance=explicit)', () => {
    const pool = new RoutedAdapterPool({
      defaultHarness: 'ha',
      members: [member('ha', 'ha:default'), member('ha', 'ha:alt'), member('hb', 'hb:default')],
    });
    expect(pool.resolveRoute({ harness: 'ha', profile: 'ha:alt' })).toEqual({
      harnessId: 'ha',
      profileId: 'ha:alt',
      provenance: 'explicit',
    });
  });

  it('explicit profile outside the member table → unsupported_option', () => {
    const pool = new RoutedAdapterPool({ defaultHarness: 'ha', members: [member('ha', 'ha:default')] });
    const rejected = pool.resolveRoute({ harness: 'ha', profile: 'ha:missing' });
    expect(rejected).toMatchObject({ code: 'unsupported_option' });
    // 同名 profile 属于别的 harness 也不算数。
    const pool2 = new RoutedAdapterPool({ defaultHarness: 'ha', members: [member('hb', 'hb:default')] });
    expect(pool2.resolveRoute({ harness: 'ha', profile: 'hb:default' })).toMatchObject({ code: 'unsupported_option' });
  });

  it('auto picks the least loaded member; ties keep member-table order', async () => {
    const gate = deferred<CallEvent>();
    const busy = scriptedMember('ha', 'ha:default', () => gate.promise);
    const idle = scriptedMember('ha', 'ha:alt', async () => okEvent());
    const pool = new RoutedAdapterPool({ defaultHarness: 'ha', members: [busy, idle] });
    // 空池并列 → 成员表序（ha:default 在前）。
    expect(pool.resolveRoute({ harness: 'ha' })).toMatchObject({ profileId: 'ha:default', provenance: 'auto' });
    // 占住 ha:default 后再解析 → 选 ha:alt。
    const first = pool.run(call('ha:default'), new AbortController().signal)[Symbol.asyncIterator]();
    void first.next();
    await new Promise((r) => setTimeout(r, 10));
    expect(pool.resolveRoute({ harness: 'ha' })).toMatchObject({ profileId: 'ha:alt', provenance: 'auto' });
    gate.resolve(okEvent());
    await first.next();
  });

  it('harness without members → unsupported_option', () => {
    const pool = new RoutedAdapterPool({ defaultHarness: 'ha', members: [] });
    expect(pool.resolveRoute({ harness: 'ha' })).toMatchObject({ code: 'unsupported_option' });
    expect(pool.resolveRoute({ harness: 'hz' })).toMatchObject({ code: 'unsupported_option' });
  });
});

describe('RoutedAdapterPool.run', () => {
  it('same profile never has two in-flight calls (second waits for slot)', async () => {
    const gate = deferred<CallEvent>();
    const member = scriptedMember('ha', 'ha:default', () => gate.promise);
    const pool = new RoutedAdapterPool({ defaultHarness: 'ha', members: [member] });
    const first = pool.run(call('ha:default', 'c1'), new AbortController().signal)[Symbol.asyncIterator]();
    const second = pool.run(call('ha:default', 'c2'), new AbortController().signal)[Symbol.asyncIterator]();
    const e1 = first.next();
    const e2 = second.next();
    await new Promise((r) => setTimeout(r, 20));
    expect(member.started).toEqual(['c1']);
    gate.resolve(okEvent());
    expect((await e1).value).toMatchObject({ type: 'result' });
    expect((await e2).value).toMatchObject({ type: 'result' });
    expect(member.started).toEqual(['c1', 'c2']);
    expect(member.peak).toBe(1);
  });

  it('waiters are granted the slot in FIFO (registration) order', async () => {
    const gate = deferred<CallEvent>();
    const member = scriptedMember('ha', 'ha:default', () => gate.promise);
    const pool = new RoutedAdapterPool({ defaultHarness: 'ha', members: [member] });
    const signal = new AbortController().signal;
    const running = [call('ha:default', 'c1'), call('ha:default', 'c2'), call('ha:default', 'c3'), call('ha:default', 'c4')].map((c) =>
      pool.run(c, signal)[Symbol.asyncIterator](),
    );
    const pending = running.map((it) => it.next());
    await new Promise((r) => setTimeout(r, 20));
    // c1 占用后，c2/c3/c4 依登记序排队；逐个放行验证 FIFO 移交。
    for (let i = 0; i < running.length; i++) {
      gate.resolve(okEvent());
      const result = await pending[i]!;
      expect(result.value).toMatchObject({ type: 'result' });
      // 移交后队列头部已换成下一个等待者。
      await new Promise((r) => setTimeout(r, 5));
    }
    expect(member.started).toEqual(['c1', 'c2', 'c3', 'c4']);
    expect(member.peak).toBe(1);
  });

  it('abort while waiting produces no terminal event and frees the queue slot', async () => {
    const gate = deferred<CallEvent>();
    const member = scriptedMember('ha', 'ha:default', () => gate.promise);
    const pool = new RoutedAdapterPool({ defaultHarness: 'ha', members: [member] });
    const first = pool.run(call('ha:default', 'c1'), new AbortController().signal)[Symbol.asyncIterator]();
    void first.next();
    const abort = new AbortController();
    const waiting = pool.run(call('ha:default', 'c2'), abort.signal)[Symbol.asyncIterator]();
    const abortedNext = waiting.next();
    abort.abort();
    const result = await abortedNext;
    // 静默结束：迭代器 done、无终态事件产出。
    expect(result.done).toBe(true);
    // 等待者摘除后，后续调用能直接拿到槽位。
    gate.resolve(okEvent());
    await first.next();
    const third = pool.run(call('ha:default', 'c3'), new AbortController().signal)[Symbol.asyncIterator]();
    expect((await third.next()).value).toMatchObject({ type: 'result' });
    expect(member.started).toEqual(['c1', 'c3']);
  });

  it('kernel-style return() while waiting unblocks the waiter without an event', async () => {
    const gate = deferred<CallEvent>();
    const member = scriptedMember('ha', 'ha:default', () => gate.promise);
    const pool = new RoutedAdapterPool({ defaultHarness: 'ha', members: [member] });
    const first = pool.run(call('ha:default', 'c1'), new AbortController().signal)[Symbol.asyncIterator]();
    void first.next();
    const waiting = pool.run(call('ha:default', 'c2'), new AbortController().signal)[Symbol.asyncIterator]();
    void waiting.next();
    // 内核 timeout 路径调 iterator.return()：等待者被唤醒并安静结束（内核已记 failed{timeout}）。
    const returned = await waiting.return?.(undefined);
    expect(returned?.done).toBe(true);
    gate.resolve(okEvent());
    await first.next();
    expect(member.started).toEqual(['c1']);
  });

  it('waiter stays bound to the frozen profile — never silently switched', async () => {
    const gateA = deferred<CallEvent>();
    const a = scriptedMember('ha', 'ha:default', () => gateA.promise);
    const b = scriptedMember('ha', 'ha:alt', async () => okEvent());
    const pool = new RoutedAdapterPool({ defaultHarness: 'ha', members: [a, b] });
    const signal = new AbortController().signal;
    const first = pool.run(call('ha:default', 'c1'), signal)[Symbol.asyncIterator]();
    void first.next();
    await new Promise((r) => setTimeout(r, 10));
    const waiting = pool.run(call('ha:default', 'c2'), signal)[Symbol.asyncIterator]();
    const waitingNext = waiting.next();
    await new Promise((r) => setTimeout(r, 20));
    // ha:alt 空闲，但 c2 的 effective.profile 已冻结为 ha:default——必须继续等 a 的槽位。
    expect(b.started).toEqual([]);
    gateA.resolve(okEvent());
    await first.next();
    expect((await waitingNext).value).toMatchObject({ type: 'result' });
    expect(a.started).toEqual(['c1', 'c2']);
    expect(b.started).toEqual([]);
  });

  it('call whose effective.profile is not a member → failed{internal}', async () => {
    const pool = new RoutedAdapterPool({
      defaultHarness: 'ha',
      members: [scriptedMember('ha', 'ha:default', async () => okEvent())],
    });
    const events: CallEvent[] = [];
    for await (const event of collect(pool.run(call('ha:missing'), new AbortController().signal))) events.push(event);
    expect(events).toEqual([{ type: 'failed', code: 'internal', message: expect.stringContaining('ha:missing') }]);
  });
});
