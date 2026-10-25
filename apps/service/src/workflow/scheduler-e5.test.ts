import { readFileSync } from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import type { CallEvent, WorkflowCall, WorkflowCallAdapter } from './call-adapter';
import type { JournalEvent } from './contract';
import { createRun, resumeRun } from './kernel';
import { MockHarness, type MockPlan } from './mock-harness';
import { RoutedAdapterPool } from './routed-pool';
import { FIXTURES, freshJournalDir, readRunJournal } from './test-helpers';

/**
 * W7/E5 调度：fixtures/workflow/e5/scenarios.json 场景表的内核级实现。
 * RoutedAdapterPool + MockHarness 成员 + 真实内核（VM 派发、journal、timeout/deadline）。
 * 断言口径：同一 profileId 任意时刻在飞 ≤1；deadline 不被排队/重试/换 Profile 重置；
 * 有限终态；attempt_start.route 记录实际成员；显式 Harness/Profile 不静默替换。
 */

const SCENARIOS = JSON.parse(readFileSync(path.join(FIXTURES, 'e5', 'scenarios.json'), 'utf8')) as {
  version: string;
  scenarios: { id: string; name: string }[];
};

const HARNESSES = ['ha', 'hb', 'hc'] as const;
const UUID = {
  ha: '11111111-1111-4111-8111-111111111111',
  hb: '22222222-2222-4222-8222-222222222222',
  hc: '33333333-3333-4333-8333-333333333333',
} as const;
const PROFILES: Record<(typeof HARNESSES)[number], [string, string]> = {
  ha: ['ha:default', UUID.ha],
  hb: ['hb:default', UUID.hb],
  hc: ['hc:default', UUID.hc],
};

/** 在飞计数包装：终态到手即出飞（内核消费后可能遗弃迭代器）。 */
class TrackedMock extends MockHarness {
  active = 0;
  peak = 0;

  override run(call: WorkflowCall, signal: AbortSignal): AsyncIterable<CallEvent> {
    this.active += 1;
    this.peak = Math.max(this.peak, this.active);
    let inFlight = true;
    const dec = () => {
      if (inFlight) {
        inFlight = false;
        this.active -= 1;
      }
    };
    const inner = super.run(call, signal)[Symbol.asyncIterator]();
    return (async function* (): AsyncGenerator<CallEvent, void> {
      try {
        const first = await inner.next();
        dec();
        if (!first.done) yield first.value;
      } finally {
        dec();
      }
    })();
  }
}

/** 永不产终态的成员适配器；abort/return 经 released 唤醒（内核 timeout 路径必须能被解开）。 */
function hangAdapter(harnessId: string): WorkflowCallAdapter & { dispatches: number } {
  const tracker = { dispatches: 0 };
  return {
    harnessId,
    get dispatches() {
      return tracker.dispatches;
    },
    run(_call: WorkflowCall, signal: AbortSignal) {
      tracker.dispatches += 1;
      let release!: () => void;
      const released = new Promise<'released'>((r) => {
        release = () => r('released');
      });
      const wait = new Promise<void>((resolve) => {
        if (signal.aborted) resolve();
        else signal.addEventListener('abort', () => resolve(), { once: true });
        void released.then(() => resolve());
      });
      let consumed = false;
      const self: AsyncIterableIterator<CallEvent> = {
        [Symbol.asyncIterator]() {
          return self;
        },
        // 不产终态：资源不可用且永不放行的成员；首个 next() 挂到 abort/return 为止。
        async next() {
          if (!consumed) {
            consumed = true;
            await wait;
          }
          return { done: true, value: undefined };
        },
        async return() {
          release();
          await wait;
          return { done: true, value: undefined };
        },
        async throw(error?: unknown) {
          release();
          throw error;
        },
      };
      return self;
    },
  };
}

interface MemberEntry {
  harnessId: string;
  profileId: string;
  adapter: WorkflowCallAdapter;
}

type MemberFactory = (harnessId: string, profileId: string) => WorkflowCallAdapter;

/** 按矩阵构建路由池 + 内核 routeScope（两者同表，测试可自行裁剪）。 */
function buildScope(factory: MemberFactory, harnesses: readonly string[] = HARNESSES) {
  const entries: MemberEntry[] = [];
  for (const harnessId of harnesses) {
    for (const profileId of PROFILES[harnessId as keyof typeof PROFILES]) {
      entries.push({ harnessId, profileId, adapter: factory(harnessId, profileId) });
    }
  }
  const pool = new RoutedAdapterPool({
    defaultHarness: 'ha',
    members: entries.map((e) => ({ ...e, profileDir: null })),
  });
  const routeScope = { defaultHarness: 'ha', members: entries.map((e) => ({ harnessId: e.harnessId, profileId: e.profileId })) };
  return { pool, entries, routeScope };
}

interface CallSpec {
  label: string;
  opts?: Record<string, unknown>;
}

function scriptFor(calls: CallSpec[]): string {
  const thunks = calls.map(
    (c) => `() => agent(${JSON.stringify(`任务-${c.label}`)}, ${JSON.stringify({ label: c.label, ...(c.opts ?? {}) })})`,
  );
  return `export const meta = { name: 'e5', description: 'W7 调度' };
export default async function main() {
  const rs = await parallel([${thunks.join(',\n  ')}]);
  return rs.map((r) => r.status + ':' + (r.status === 'failed' ? r.code : 'ok'));
}`;
}

function callsOf(events: JournalEvent[]) {
  const starts = new Map<number, Extract<JournalEvent, { t: 'call_start' }>>();
  const ends = new Map<number, Extract<JournalEvent, { t: 'call_end' }>>();
  const attemptStarts = new Map<number, Extract<JournalEvent, { t: 'attempt_start' }>[]>();
  for (const e of events) {
    if (e.t === 'call_start') starts.set(e.callSeq, e);
    if (e.t === 'call_end') ends.set(e.callSeq, e);
    if (e.t === 'attempt_start') {
      const list = attemptStarts.get(e.callSeq) ?? [];
      list.push(e);
      attemptStarts.set(e.callSeq, list);
    }
  }
  return [...starts.keys()]
    .sort((a, b) => a - b)
    .map((seq) => ({
      seq,
      start: starts.get(seq)!,
      end: ends.get(seq),
      attempts: attemptStarts.get(seq) ?? [],
    }));
}

const okPlan: MockPlan = { fallback: [{ text: 'ok', delayMs: 2 }] };

async function runWith(
  script: string,
  factory: MemberFactory,
  extra?: { routeScope?: ReturnType<typeof buildScope>['routeScope']; deadlineMs?: number; maxConcurrentCalls?: number },
) {
  const { pool, routeScope } = buildScope(factory);
  const journalDir = freshJournalDir();
  const run = await createRun({
    script,
    args: null,
    journalDir,
    adapter: pool,
    routeScope: extra?.routeScope ?? routeScope,
    ...(extra?.deadlineMs !== undefined ? { deadlineMs: extra.deadlineMs } : {}),
    ...(extra?.maxConcurrentCalls !== undefined ? { maxConcurrentCalls: extra.maxConcurrentCalls } : {}),
  });
  const outcome = await run.done;
  const events = await readRunJournal(journalDir, run.runId);
  return { outcome, events, journalDir, runId: run.runId };
}

describe('E5 调度场景表（W7 多 Harness）', () => {
  it('fixture version and scenario ids', () => {
    expect(SCENARIOS.version).toBe('w7-e5/1');
    expect(SCENARIOS.scenarios.map((s) => s.id)).toEqual(['E5-01', 'E5-02', 'E5-03', 'E5-04', 'E5-05', 'E5-06', 'E5-07', 'E5-08', 'E5-09']);
  });

  it('E5-01: 200 mixed calls complete; per-profile in-flight <=1; route recorded', async () => {
    // 1/2 显式 harness 轮转、1/4 显式 harness+profile、1/4 缺省 auto。
    const calls: CallSpec[] = Array.from({ length: 200 }, (_, i) => {
      const harness = HARNESSES[i % 3]!;
      if (i % 4 === 3) return { label: `m${i}`, opts: {} };
      if (i % 4 === 2) return { label: `m${i}`, opts: { harness, profile: PROFILES[harness][i % 2] } };
      return { label: `m${i}`, opts: { harness } };
    });
    const script = scriptFor(calls);
    const members = new Map<string, TrackedMock>();
    const { outcome, events } = await runWith(script, (harnessId, profileId) => {
      const mock = new TrackedMock(okPlan, { harnessId });
      members.set(profileId, mock);
      return mock;
    });
    expect(outcome.status).toBe('completed');
    const result = outcome.result as string[];
    expect(result).toHaveLength(200);
    expect(result.every((s) => s === 'ok:ok')).toBe(true);
    for (const mock of members.values()) expect(mock.peak).toBeLessThanOrEqual(1);

    const view = callsOf(events);
    expect(view).toHaveLength(200);
    for (const call of view) {
      expect(call.end?.status).toBe('ok');
      // 每个 attempt_start 记录路由成员，且与 call_start 冻结的 effective 一致。
      expect(call.attempts.length).toBe(1);
      const route = call.attempts[0]!.route;
      expect(route).toBeDefined();
      const effective = call.start.effective as { harness: string; profile?: string; profileAuto?: boolean };
      expect(route!.profileId).toBe(effective.profile);
      const spec = calls[call.seq - 1]!;
      const opts = spec.opts as Record<string, unknown> | undefined;
      // 显式 harness 不被静默替换；auto 解析落在 defaultHarness 上。
      const wantHarness = (opts?.harness as string | undefined) ?? 'ha';
      expect(route!.harnessId).toBe(wantHarness);
      expect(effective.harness).toBe(wantHarness);
      if (opts?.profile !== undefined) expect(effective.profile).toBe(opts.profile);
      else expect(effective.profileAuto).toBe(true);
    }
  }, 60_000);

  it('E5-02: permanent rate_limit fails finitely, not retried, not re-routed', async () => {
    const calls: CallSpec[] = [
      { label: 'rl', opts: { harness: 'ha', profile: 'ha:default' } },
      { label: 'fine', opts: { harness: 'hb' } },
    ];
    const script = scriptFor(calls);
    let limited: TrackedMock | null = null;
    const { outcome, events } = await runWith(script, (harnessId, profileId) => {
      const plan: MockPlan = harnessId === 'ha' && profileId === 'ha:default' ? { fallback: [{ fail: 'rate_limit' }] } : okPlan;
      const mock = new TrackedMock(plan, { harnessId });
      if (harnessId === 'ha' && profileId === 'ha:default') limited = mock;
      return mock;
    });
    expect(outcome.status).toBe('completed');
    const view = callsOf(events);
    expect(view[0]!.end).toMatchObject({ status: 'failed', code: 'rate_limit' });
    expect(view[0]!.attempts).toHaveLength(1); // rate_limit 不重试
    expect(view[0]!.attempts[0]!.route).toMatchObject({ harnessId: 'ha', profileId: 'ha:default' });
    expect(view[1]!.end?.status).toBe('ok');
    expect(limited!.dispatchCount).toBe(1); // 不静默改派：429 后没有别的成员接手
  }, 30_000);

  it('E5-03: exhausted pool → bounded wait → failed{timeout}, finite terminal', async () => {
    const calls: CallSpec[] = Array.from({ length: 6 }, (_, i) => ({ label: `x${i}`, opts: { timeoutMs: 1_000 } }));
    const script = scriptFor(calls);
    const { outcome, events } = await runWith(script, (harnessId) => hangAdapter(harnessId));
    expect(outcome.status).toBe('completed');
    const view = callsOf(events);
    for (const call of view) {
      expect(call.end).toMatchObject({ status: 'failed', code: 'timeout' });
      expect(call.attempts).toHaveLength(1);
    }
  }, 30_000);

  it('E5-04: exhausted pool → run deadline not reset by queueing/retries', async () => {
    const calls: CallSpec[] = Array.from({ length: 4 }, (_, i) => ({
      label: `d${i}`,
      opts: { timeoutMs: 3_000, retries: 3 },
    }));
    const script = scriptFor(calls);
    const { outcome } = await runWith(script, (harnessId) => hangAdapter(harnessId), { deadlineMs: 2_500 });
    // 绝对 deadline 先于「排队×重试」的更长路径生效：有限终态 run_deadline_exceeded。
    expect(outcome).toMatchObject({ status: 'failed', failureCode: 'run_deadline_exceeded' });
  }, 30_000);

  it('E5-05: permission_denied is not retried', async () => {
    const calls: CallSpec[] = [{ label: 'pd', opts: { harness: 'hb', profile: 'hb:default' } }];
    const script = scriptFor(calls);
    const { outcome, events } = await runWith(script, (harnessId, profileId) => {
      const plan: MockPlan = harnessId === 'hb' && profileId === 'hb:default' ? { fallback: [{ fail: 'permission_denied' }] } : okPlan;
      return new TrackedMock(plan, { harnessId });
    });
    expect(outcome.status).toBe('completed');
    const view = callsOf(events);
    expect(view[0]!.end).toMatchObject({ status: 'failed', code: 'permission_denied' });
    expect(view[0]!.attempts).toHaveLength(1);
  }, 30_000);

  it('E5-06: harness outside route scope or empty member table → unsupported_option', async () => {
    const calls: CallSpec[] = [
      { label: 'outside', opts: { harness: 'hz' } }, // 不在 routeScope
      { label: 'empty', opts: { harness: 'hx' } }, // 在 routeScope 但成员表为空（宿主剔除）
      { label: 'fine', opts: { harness: 'ha' } },
    ];
    const script = scriptFor(calls);
    const { outcome, events } = await runWith(script, (harnessId) => new TrackedMock(okPlan, { harnessId }), {
      // routeScope 声明 hx 成员，但池里按宿主剔除口径不给 hx 适配器成员。
      routeScope: {
        defaultHarness: 'ha',
        members: [
          ...HARNESSES.flatMap((h) => PROFILES[h].map((profileId) => ({ harnessId: h, profileId }))),
          { harnessId: 'hx', profileId: 'hx:default' },
        ],
      },
    });
    expect(outcome.status).toBe('completed');
    const view = callsOf(events);
    expect(view[0]!.end).toMatchObject({ status: 'failed', code: 'unsupported_option' });
    expect(view[0]!.attempts).toHaveLength(0);
    expect(view[1]!.end).toMatchObject({ status: 'failed', code: 'unsupported_option' });
    expect(view[1]!.attempts).toHaveLength(0);
    expect(view[2]!.end?.status).toBe('ok');
  }, 30_000);

  it('E5-07: same-profile concurrent calls run FIFO (peak 1, registration order)', async () => {
    const calls: CallSpec[] = [0, 1, 2].map((i) => ({
      label: `f${i}`,
      opts: { harness: 'ha', profile: 'ha:default' },
    }));
    const script = scriptFor(calls);
    let busy: TrackedMock | null = null;
    const { outcome, events } = await runWith(script, (harnessId, profileId) => {
      const mock = new TrackedMock({ fallback: [{ text: 'ok', delayMs: 120 }] }, { harnessId });
      if (harnessId === 'ha' && profileId === 'ha:default') busy = mock;
      return mock;
    });
    expect(outcome.status).toBe('completed');
    expect(busy!.peak).toBe(1);
    expect(busy!.dispatchedLabels).toEqual(['f0', 'f1', 'f2']); // 登记序 FIFO
    for (const call of callsOf(events)) expect(call.end?.status).toBe('ok');
  }, 30_000);

  it('E5-08: stopping a waiter ends it without dispatching the member', async () => {
    const calls: CallSpec[] = [0, 1].map((i) => ({
      label: `s${i}`,
      opts: { harness: 'ha', profile: 'ha:default' },
    }));
    const script = scriptFor(calls);
    let busy: TrackedMock | null = null;
    const journalDir = freshJournalDir();
    const { pool, routeScope } = buildScope((harnessId, profileId) => {
      const mock = new TrackedMock({ fallback: [{ text: 'ok', delayMs: 5_000 }] }, { harnessId });
      if (harnessId === 'ha' && profileId === 'ha:default') busy = mock;
      return mock;
    });
    const run = await createRun({ script, args: null, journalDir, adapter: pool, routeScope });
    // 等 s0 在飞、s1 在等待后停止。
    await new Promise((r) => setTimeout(r, 400));
    const outcome = await run.stop();
    expect(outcome.status).toBe('stopped');
    const events = await readRunJournal(journalDir, run.runId);
    const view = callsOf(events);
    for (const call of view) expect(['stopped']).toContain(call.end?.status);
    // 等待者从未占用成员：成员只见到 s0。
    expect(busy!.dispatchedLabels).toEqual(['s0']);
  }, 30_000);

  it('E5-09: frozen semantics — effective.profile == route == actual member, no silent switch', async () => {
    // hb:default 忙（hang 短门闩不可行——用长延迟让 default 占用）；
    // 显式 UUID profile 的调用必须等自己的成员，不改派 hb:default。
    const calls: CallSpec[] = [
      { label: 'occupy', opts: { harness: 'hb', profile: 'hb:default' } },
      { label: 'bound', opts: { harness: 'hb', profile: UUID.hb } },
    ];
    const script = scriptFor(calls);
    let defaultMember: TrackedMock | null = null;
    let uuidMember: TrackedMock | null = null;
    const { outcome, events } = await runWith(script, (harnessId, profileId) => {
      const delay = harnessId === 'hb' && profileId === 'hb:default' ? 400 : 30;
      const mock = new TrackedMock({ fallback: [{ text: 'ok', delayMs: delay }] }, { harnessId });
      if (harnessId === 'hb' && profileId === 'hb:default') defaultMember = mock;
      if (harnessId === 'hb' && profileId === UUID.hb) uuidMember = mock;
      return mock;
    });
    expect(outcome.status).toBe('completed');
    const view = callsOf(events);
    const bound = view[1]!;
    expect(bound.end?.status).toBe('ok');
    const effective = bound.start.effective as { profile?: string };
    expect(effective.profile).toBe(UUID.hb);
    expect(bound.attempts[0]!.route).toMatchObject({ harnessId: 'hb', profileId: UUID.hb });
    // 实际派发在 uuid 成员上，hb:default 只见到 occupy。
    expect(uuidMember!.dispatchedLabels).toEqual(['bound']);
    expect(defaultMember!.dispatchedLabels).toEqual(['occupy']);
  }, 30_000);
});

describe('内核级路由（validateOpts + resolveRoute + contentKey 分区）', () => {
  it('auto-resolved profile is frozen into effective (profileAuto) and attempt route', async () => {
    const script = `export const meta = { name: 'r', description: 'd' };
export default async function main() { const r = await agent('hi', { label: 'a' }); return r.status; }`;
    const { outcome, events } = await runWith(script, (harnessId) => new TrackedMock(okPlan, { harnessId }));
    expect(outcome.status).toBe('completed');
    const view = callsOf(events);
    const effective = view[0]!.start.effective as { harness: string; profile?: string; profileAuto?: boolean };
    expect(effective.harness).toBe('ha');
    expect(effective.profile).toBe('ha:default'); // auto → 并列按成员表序取首
    expect(effective.profileAuto).toBe(true);
    expect(view[0]!.attempts[0]!.route).toEqual({ harnessId: 'ha', profileId: 'ha:default' });
  }, 30_000);

  it('explicit harness/profile outside scope → failed{unsupported_option}, no attempt', async () => {
    const script = scriptFor([
      { label: 'h', opts: { harness: 'hz' } },
      { label: 'p', opts: { harness: 'ha', profile: 'hz:default' } },
    ]);
    const { outcome, events } = await runWith(script, (harnessId) => new TrackedMock(okPlan, { harnessId }));
    expect(outcome.status).toBe('completed');
    const view = callsOf(events);
    expect(view[0]!.end).toMatchObject({ status: 'failed', code: 'unsupported_option' });
    expect(view[1]!.end).toMatchObject({ status: 'failed', code: 'unsupported_option' });
    for (const call of view) expect(call.attempts).toHaveLength(0);
  }, 30_000);

  it('same prompt resolved to different profiles yields different contentKeys', async () => {
    const script = `export const meta = { name: 'k', description: 'd' };
export default async function main() {
  const a = await agent('同一提示词', { label: 'pa', harness: 'ha', profile: 'ha:default' });
  const b = await agent('同一提示词', { label: 'pb', harness: 'ha', profile: '${UUID.ha}' });
  return [a.status, b.status];
}`;
    const { outcome, events } = await runWith(script, (harnessId) => new TrackedMock(okPlan, { harnessId }));
    expect(outcome.status).toBe('completed');
    const view = callsOf(events);
    expect(view).toHaveLength(2);
    // 显式 Profile 总进键：同 prompt 不同 profile → 不同 contentKey（缓存分区）。
    expect(view[0]!.start.contentKey).not.toBe(view[1]!.start.contentKey);
  }, 30_000);

  it('resume with a different route resolution does not hit the ancestor cache', async () => {
    const script = `export const meta = { name: 'rr', description: 'd' };
export default async function main() { const r = await agent('续跑提示词', { label: 'rc' }); return r.status; }`;
    const journalDir = freshJournalDir();
    // 父 run：路由范围只有 ha:default → auto 解析到 ha:default。
    const parentScope = { defaultHarness: 'ha', members: [{ harnessId: 'ha', profileId: 'ha:default' }] };
    const parentPool = new RoutedAdapterPool({
      defaultHarness: 'ha',
      members: [{ harnessId: 'ha', profileId: 'ha:default', profileDir: null, adapter: new TrackedMock(okPlan, { harnessId: 'ha' }) }],
    });
    const parent = await createRun({ script, args: null, journalDir, adapter: parentPool, routeScope: parentScope });
    expect((await parent.done).status).toBe('completed');

    // 子 run：范围换成 ha 的另一个 profile → 解析不同 → contentKey 不同 → 不命中缓存（安全方向）。
    const childMock = new TrackedMock(okPlan, { harnessId: 'ha' });
    const childScope = { defaultHarness: 'ha', members: [{ harnessId: 'ha', profileId: UUID.ha }] };
    const childPool = new RoutedAdapterPool({
      defaultHarness: 'ha',
      members: [{ harnessId: 'ha', profileId: UUID.ha, profileDir: null, adapter: childMock }],
    });
    const child = await resumeRun({
      script,
      args: null,
      journalDir,
      adapter: childPool,
      routeScope: childScope,
      parentRunId: parent.runId,
    });
    expect((await child.done).status).toBe('completed');
    expect(childMock.dispatchCount).toBe(1); // 未命中缓存，真实派发

    const childEvents = await readRunJournal(journalDir, child.runId);
    const view = callsOf(childEvents);
    expect(view[0]!.end?.status).toBe('ok');
    expect(view[0]!.attempts[0]!.route).toEqual({ harnessId: 'ha', profileId: UUID.ha });
    const parentKey = (await readRunJournal(journalDir, parent.runId)).find((e) => e.t === 'call_start') as Extract<
      JournalEvent,
      { t: 'call_start' }
    >;
    expect(view[0]!.start.contentKey).not.toBe(parentKey.contentKey);
  }, 30_000);

  it('without routeScope the adapter keeps single-harness semantics (opts.profile recorded only)', async () => {
    const script = `export const meta = { name: 's', description: 'd' };
export default async function main() {
  const r = await agent('hi', { label: 'a', profile: 'any-string' });
  return r.status;
}`;
    const journalDir = freshJournalDir();
    const mock = new MockHarness(okPlan);
    const run = await createRun({ script, args: null, journalDir, adapter: mock });
    expect((await run.done).status).toBe('completed');
    const view = callsOf(await readRunJournal(journalDir, run.runId));
    const effective = view[0]!.start.effective as { harness: string; profile?: string; profileAuto?: boolean };
    // 既有行为零回归：profile 原样记录、无 profileAuto、attempt_start 无 route。
    expect(effective).toEqual({ harness: 'mock', profile: 'any-string' });
    expect(view[0]!.attempts[0]!.route).toBeUndefined();
  }, 30_000);
});
