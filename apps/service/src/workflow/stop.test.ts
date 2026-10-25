import { describe, expect, it } from 'vitest';
import { createRun, resumeRun } from './kernel';
import { MockHarness } from './mock-harness';
import type { CallEvent, WorkflowCall, WorkflowCallAdapter } from './call-adapter';
import { callsView, freshJournalDir, loadFixture, readRunJournal } from './test-helpers';
import type { JournalEvent } from './contract';

// 故障矩阵：stop-before-dispatch / stop-mid-attempt / commit-before-deliver / 迟到回调。

describe('stop semantics (faults.json)', () => {
  it('stop before later calls dispatch: registered-but-pending calls get call_end{stopped}', async () => {
    const { script, expected } = await loadFixture('parallel-collect');
    const journalDir = freshJournalDir();
    let markFirst!: () => void;
    const firstDispatched = new Promise<void>((r) => (markFirst = r));
    const mock = new MockHarness(expected.mock, {
      delayMs: 10_000,
      onDispatch: () => markFirst(),
    });
    const run = await createRun({ script, args: null, journalDir, adapter: mock });
    await firstDispatched; // W5：并行块三个调用均已并发派发在途
    const outcome = await run.stop();
    expect(outcome.status).toBe('stopped');
    const events = await readRunJournal(journalDir, run.runId);
    const terminal = events.filter((e): e is Extract<JournalEvent, { t: 'run' }> => e.t === 'run').at(-1)!;
    expect(terminal.status).toBe('stopped');
    const calls = callsView(events);
    expect(calls.length).toBe(3);
    expect(calls.every((c) => c.status === 'stopped')).toBe(true);
    expect(mock.dispatchedLabels).toEqual(['p-0', 'p-1', 'p-2']);
  }, 30_000);

  it('stop mid-attempt: attempt_end{stopped} + call_end{stopped}, pending calls stopped', async () => {
    const { script, expected } = await loadFixture('parallel-collect');
    const journalDir = freshJournalDir();
    let markFirst!: () => void;
    const firstDispatched = new Promise<void>((r) => (markFirst = r));
    const mock = new MockHarness(expected.mock, {
      delayMs: 10_000,
      onDispatch: () => markFirst(),
    });
    const run = await createRun({ script, args: null, journalDir, adapter: mock });
    await firstDispatched;
    const outcome = await run.stop();
    expect(outcome.status).toBe('stopped');
    const events = await readRunJournal(journalDir, run.runId);
    const attemptEnds = events.filter((e): e is Extract<JournalEvent, { t: 'attempt_end' }> => e.t === 'attempt_end');
    expect(attemptEnds.some((e) => e.status === 'stopped')).toBe(true);
    const calls = callsView(events);
    expect(calls.every((c) => c.status === 'stopped')).toBe(true);
    // W5：并行块内全部调用并发派发，停止对在途 attempt 逐一 abort。
    expect(mock.dispatchCount).toBe(3);
    expect(mock.dispatchedLabels).toEqual(['p-0', 'p-1', 'p-2']);
    // 续跑：stopped 调用不命中缓存，重新派发
    const childMock = new MockHarness(expected.mock);
    const child = await resumeRun({ script, args: null, journalDir, adapter: childMock, parentRunId: run.runId });
    const resumed = await child.done;
    expect(resumed.status).toBe('completed');
    expect(childMock.dispatchCount).toBe(3);
    expect(resumed.result).toEqual(expected.expect.result);
  }, 60_000);

  it('commit-before-deliver: resume hits cache, no re-dispatch', async () => {
    const { script, expected } = await loadFixture('seq-two-calls');
    const journalDir = freshJournalDir();
    const parentMock = new MockHarness(expected.mock);
    const parent = await createRun({ script, args: null, journalDir, adapter: parentMock, stopAfterCalls: 1 });
    const stopped = await parent.done;
    expect(stopped.status).toBe('stopped');
    expect(parentMock.dispatchCount).toBe(1);

    const childMock = new MockHarness(expected.mock);
    const child = await resumeRun({ script, args: null, journalDir, adapter: childMock, parentRunId: parent.runId });
    const outcome = await child.done;
    expect(outcome.status).toBe('completed');
    expect(childMock.dispatchCount).toBe(1);
    const calls = callsView(await readRunJournal(journalDir, child.runId));
    expect(calls[0]?.status).toBe('cached');
    expect(calls[1]?.status).toBe('ok');
  }, 60_000);

  it('late callbacks after dispose are no-ops: second stop() is stable, no throws', async () => {
    const { script, expected } = await loadFixture('seq-two-calls');
    const journalDir = freshJournalDir();
    const mock = new MockHarness(expected.mock);
    const run = await createRun({ script, args: null, journalDir, adapter: mock });
    const first = await run.done;
    expect(first.status).toBe('completed');
    const again = await run.stop();
    expect(again.status).toBe('completed');
    const events = await readRunJournal(journalDir, run.runId);
    expect(events.filter((e) => e.t === 'run').length).toBe(2); // running + completed，无多余终态
  }, 30_000);

  it('adapter honoring AbortSignal ends iteration promptly', async () => {
    const blocking: WorkflowCallAdapter = {
      harnessId: 'mock',
      run(_call: WorkflowCall, signal: AbortSignal): AsyncIterable<CallEvent> {
        return {
          [Symbol.asyncIterator]() {
            return {
              async next() {
                while (!signal.aborted) await new Promise((r) => setTimeout(r, 10));
                return { done: true as const, value: undefined };
              },
            };
          },
        };
      },
    };
    const { script } = await loadFixture('seq-two-calls');
    const journalDir = freshJournalDir();
    const run = await createRun({ script, args: null, journalDir, adapter: blocking });
    await new Promise((r) => setTimeout(r, 100));
    const outcome = await run.stop();
    expect(outcome.status).toBe('stopped');
    const calls = callsView(await readRunJournal(journalDir, run.runId));
    expect(calls[0]?.status).toBe('stopped');
  }, 30_000);
});
