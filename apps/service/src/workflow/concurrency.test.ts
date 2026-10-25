import { describe, expect, it } from 'vitest';
import { createRun, resumeRun } from './kernel';
import { MockHarness } from './mock-harness';
import { contentKey, LIMITS, type JournalEvent } from './contract';
import type { CallEvent, WorkflowCall, WorkflowCallAdapter } from './call-adapter';
import { callsView, freshJournalDir, readRunJournal } from './test-helpers';

// W5：有界并发派发只改变物理执行次序；deliver 严格按 callSeq、call_end 先于 deliver、
// 同一内容续跑命中的语义与顺序执行完全一致（E1 只读子集形状）。

const PARALLEL_TWO = `export const meta = { name: 'p2', description: '两个并行调用' };
export default async function main() {
  const [a, b] = await parallel([
    () => agent('任务 A', { label: 'p-a', isolation: 'readonly' }),
    () => agent('任务 B', { label: 'p-b', isolation: 'readonly' }),
  ]);
  return [a.status === 'ok' ? a.value : a.code, b.status === 'ok' ? b.value : b.code];
}`;

const PARALLEL_FOUR = `export const meta = { name: 'p4', description: '四个并行调用' };
export default async function main() {
  const rs = await parallel([0, 1, 2, 3].map((i) => () => agent('任务 ' + i, { label: 'c-' + i, isolation: 'readonly' })));
  return rs.map((r) => (r.status === 'ok' ? r.value : r.code));
}`;

function deliverSeqs(events: JournalEvent[]): number[] {
  return events.filter((e): e is Extract<JournalEvent, { t: 'deliver' }> => e.t === 'deliver').map((e) => e.callSeq);
}

function attemptEndSeqs(events: JournalEvent[]): number[] {
  return events
    .filter((e): e is Extract<JournalEvent, { t: 'attempt_end' }> => e.t === 'attempt_end' && e.status === 'ok')
    .map((e) => e.callSeq);
}

/** 确定性洗牌：同一 seed 产生同一 delay 排列，用于 50-seed 完成排列扫描。 */
function mulberry32(seed: number): () => number {
  let s = seed;
  return () => {
    s |= 0;
    s = (s + 0x6d2b79f5) | 0;
    let t = Math.imul(s ^ (s >>> 15), 1 | s);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

function delaysForSeed(seed: number): number[] {
  const base = [240, 160, 100, 40];
  const rng = mulberry32(seed);
  const order = [0, 1, 2, 3].sort(() => rng() - 0.5);
  return order.map((i) => base[i]!);
}

/** 仪表化适配器：统计同时在途 run() 的峰值，验证并发上界。 */
class CountingAdapter implements WorkflowCallAdapter {
  readonly harnessId = 'mock';
  active = 0;
  peak = 0;
  readonly labels: (string | null)[] = [];

  constructor(private readonly delayMs: number) {}

  async *run(call: WorkflowCall, signal: AbortSignal): AsyncIterable<CallEvent> {
    this.active += 1;
    this.peak = Math.max(this.peak, this.active);
    this.labels.push(call.label);
    const deadline = Date.now() + this.delayMs;
    while (Date.now() < deadline && !signal.aborted) {
      await new Promise((r) => setTimeout(r, Math.min(10, deadline - Date.now())));
    }
    // 内核消费终态事件后即遗弃迭代器（不调 return）：物理结束点在 yield 前释放计数。
    this.active -= 1;
    if (!signal.aborted) yield { type: 'result', text: `ok:${call.label ?? ''}` };
  }
}

describe('concurrent dispatch (W5)', () => {
  it('out-of-order completion keeps logical deliver order [seq1, seq2]', async () => {
    const journalDir = freshJournalDir();
    // B 物理先完成（delayMs 小），A 后到；journal deliver 仍须按 callSeq。
    const mock = new MockHarness({
      'p-a': [{ text: 'A', delayMs: 300 }],
      'p-b': [{ text: 'B', delayMs: 10 }],
    });
    const run = await createRun({ script: PARALLEL_TWO, args: null, journalDir, adapter: mock });
    const outcome = await run.done;

    expect(outcome.status).toBe('completed');
    expect(outcome.result).toEqual(['A', 'B']);
    const events = await readRunJournal(journalDir, run.runId);
    // 物理完成次序确实反转（attempt_end B 先），交付次序仍为 [1, 2]。
    expect(attemptEndSeqs(events)).toEqual([2, 1]);
    expect(deliverSeqs(events)).toEqual([1, 2]);
    const calls = callsView(events);
    expect(calls.map((c) => ({ seq: c.seq, status: c.status }))).toEqual([
      { seq: 1, status: 'ok' },
      { seq: 2, status: 'ok' },
    ]);
    // call_end 必须先于对应 deliver（每个 seq）。
    for (const seq of [1, 2]) {
      const endIdx = events.findIndex((e) => e.t === 'call_end' && e.callSeq === seq);
      const deliverIdx = events.findIndex((e) => e.t === 'deliver' && e.callSeq === seq);
      expect(endIdx).toBeGreaterThanOrEqual(0);
      expect(deliverIdx).toBeGreaterThan(endIdx);
    }
  }, 30_000);

  it('50 seeds of completion permutations produce identical logical journals', async () => {
    const runOnce = async (seed: number) => {
      const journalDir = freshJournalDir();
      const delays = delaysForSeed(seed);
      const mock = new MockHarness({
        'c-0': [{ text: 'v0', delayMs: delays[0] }],
        'c-1': [{ text: 'v1', delayMs: delays[1] }],
        'c-2': [{ text: 'v2', delayMs: delays[2] }],
        'c-3': [{ text: 'v3', delayMs: delays[3] }],
      });
      const run = await createRun({ script: PARALLEL_FOUR, args: null, journalDir, adapter: mock });
      const outcome = await run.done;
      const events = await readRunJournal(journalDir, run.runId);
      return {
        status: outcome.status,
        result: outcome.result,
        deliverSeqs: deliverSeqs(events),
        calls: callsView(events).map((c) => ({ seq: c.seq, label: c.label, status: c.status, result: c.result })),
      };
    };

    const seeds = Array.from({ length: 50 }, (_, i) => i + 1);
    const baseline = await runOnce(seeds[0]!);
    expect(baseline.status).toBe('completed');
    expect(baseline.deliverSeqs).toEqual([1, 2, 3, 4]);
    // 分批并发跑多个独立 run（互不相同 runId/journalDir，内核间无共享状态）。
    for (let offset = 1; offset < seeds.length; offset += 5) {
      const batch = await Promise.all(seeds.slice(offset, offset + 5).map((seed) => runOnce(seed)));
      for (const current of batch) expect(current).toEqual(baseline);
    }
  }, 120_000);

  it('bounded fan-out: maxConcurrentCalls=2 keeps in-flight peak at 2', async () => {
    const journalDir = freshJournalDir();
    const adapter = new CountingAdapter(60);
    const run = await createRun({ script: PARALLEL_FOUR, args: null, journalDir, adapter, maxConcurrentCalls: 2 });
    const outcome = await run.done;

    expect(outcome.status).toBe('completed');
    expect(outcome.result).toEqual(['ok:c-0', 'ok:c-1', 'ok:c-2', 'ok:c-3']);
    expect(adapter.peak).toBe(2);
    expect(deliverSeqs(await readRunJournal(journalDir, run.runId))).toEqual([1, 2, 3, 4]);
  }, 30_000);

  it('over-limit maxConcurrentCalls is clamped to LIMITS.MAX_CONCURRENT_CALLS', async () => {
    const journalDir = freshJournalDir();
    const adapter = new CountingAdapter(60);
    const script = `export const meta = { name: 'p6', description: '六个并行调用' };
export default async function main() {
  const rs = await parallel([0, 1, 2, 3, 4, 5].map((i) => () => agent('任务 ' + i, { label: 'c-' + i, isolation: 'readonly' })));
  return rs.map((r) => r.status);
}`;
    const run = await createRun({ script, args: null, journalDir, adapter, maxConcurrentCalls: 99 });
    const outcome = await run.done;
    expect(outcome.status).toBe('completed');
    expect(adapter.peak).toBeLessThanOrEqual(LIMITS.MAX_CONCURRENT_CALLS);
    expect(adapter.peak).toBeGreaterThan(1);
  }, 30_000);

  it('maxConcurrentCalls=1 keeps sequential dispatch', async () => {
    const journalDir = freshJournalDir();
    const adapter = new CountingAdapter(20);
    const run = await createRun({ script: PARALLEL_FOUR, args: null, journalDir, adapter, maxConcurrentCalls: 1 });
    const outcome = await run.done;
    expect(outcome.status).toBe('completed');
    expect(adapter.peak).toBe(1);
    expect(adapter.labels).toEqual(['c-0', 'c-1', 'c-2', 'c-3']);
  }, 30_000);

  it('cache hit inside a parallel block still delivers in seq order with cached provenance', async () => {
    const journalDir = freshJournalDir();
    // call2 命中续跑缓存（不入队派发），call1 真实在途；交付序仍 [1, 2]。
    const call2Key = contentKey({
      prompt: '任务 B',
      effective: { harness: 'mock' },
      schema: undefined,
      label: 'p-b',
      tools: [],
    });
    const mock = new MockHarness({ 'p-a': [{ text: 'A', delayMs: 80 }] });
    const run = await resumeRun({
      script: PARALLEL_TWO,
      args: null,
      journalDir,
      adapter: mock,
      parentRunId: 'ancestor-run',
      resumeCache: new Map([[call2Key, { result: 'vB', fromRunId: 'ancestor-run' }]]),
    });
    const outcome = await run.done;

    expect(outcome.status).toBe('completed');
    expect(outcome.result).toEqual(['A', 'vB']);
    expect(mock.dispatchedLabels).toEqual(['p-a']);
    const events = await readRunJournal(journalDir, run.runId);
    expect(deliverSeqs(events)).toEqual([1, 2]);
    const calls = callsView(events);
    expect(calls[0]?.status).toBe('ok');
    expect(calls[1]?.status).toBe('cached');
    const cachedEnd = events.find((e): e is Extract<JournalEvent, { t: 'call_end' }> => e.t === 'call_end' && e.callSeq === 2);
    expect(cachedEnd?.cachedFromRunId).toBe('ancestor-run');
  }, 30_000);

  it('stop aborts all in-flight attempts and records stopped on every call', async () => {
    const journalDir = freshJournalDir();
    let markThree!: () => void;
    const threeDispatched = new Promise<void>((r) => (markThree = r));
    const mock = new MockHarness(
      { 'c-0': [{ text: 'v0' }], 'c-1': [{ text: 'v1' }], 'c-2': [{ text: 'v2' }], 'c-3': [{ text: 'v3' }] },
      {
        delayMs: 30_000,
        onDispatch: () => {
          if (mock.dispatchedLabels.length === 3) markThree();
        },
      },
    );
    const run = await createRun({ script: PARALLEL_FOUR, args: null, journalDir, adapter: mock, maxConcurrentCalls: 3 });
    await threeDispatched; // seq1-3 在途，seq4 尚未派发
    const outcome = await run.stop();

    expect(outcome.status).toBe('stopped');
    const events = await readRunJournal(journalDir, run.runId);
    const calls = callsView(events);
    expect(calls.length).toBe(4);
    expect(calls.every((c) => c.status === 'stopped')).toBe(true);
    expect(mock.dispatchedLabels).toEqual(['c-0', 'c-1', 'c-2']);
    // 三个在途 attempt 都被 abort 并记 stopped；seq4 未派发只有 call_end{stopped}。
    const stoppedAttempts = events.filter(
      (e): e is Extract<JournalEvent, { t: 'attempt_end' }> => e.t === 'attempt_end' && e.status === 'stopped',
    );
    expect(stoppedAttempts.map((e) => e.callSeq).sort()).toEqual([1, 2, 3]);
  }, 30_000);

  it('a failed branch does not block other in-flight calls or reorder delivery', async () => {
    const journalDir = freshJournalDir();
    const mock = new MockHarness({
      'p-a': [{ fail: 'crash' as const }],
      'p-b': [{ text: 'B', delayMs: 80 }],
    });
    const run = await createRun({ script: PARALLEL_TWO, args: null, journalDir, adapter: mock });
    const outcome = await run.done;

    expect(outcome.status).toBe('completed');
    expect(outcome.result).toEqual(['crash', 'B']);
    const events = await readRunJournal(journalDir, run.runId);
    expect(deliverSeqs(events)).toEqual([1, 2]);
    const calls = callsView(events);
    expect(calls[0]?.status).toBe('failed');
    expect(calls[0]?.code).toBe('crash');
    expect(calls[1]?.status).toBe('ok');
  }, 30_000);
});
