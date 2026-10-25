import { describe, expect, it } from 'vitest';
import { WorkflowEngine, type WorkflowEngineRunSpec } from './engine';
import { MockHarness } from './mock-harness';
import { loadFixture } from './test-helpers';
import type { JournalEvent } from './contract';

// W2 引擎端口：真实内核 + MockHarness + 记录型沉点，验证 commit-before-deliver、
// 注入缓存命中、停止确认与沉点拒绝 → internal_error 的边界语义。
describe('WorkflowEngine', () => {
  it('delivers every journal event to the sink and resolves done after the last append', async () => {
    const { script, expected } = await loadFixture('seq-two-calls');
    const events: JournalEvent[] = [];
    const resolved: JournalEvent[] = [];
    const engine = new WorkflowEngine({ adapter: new MockHarness(expected.mock) });

    const handle = await engine.run({
      runId: 'engine-run-1',
      script,
      args: expected.args,
      cache: [],
      journal: async (event) => {
        events.push(event);
        await new Promise((r) => setImmediate(r));
        resolved.push(event);
      },
    });
    const outcome = await handle.done;

    expect(outcome.status).toBe('completed');
    expect(outcome.result).toEqual(expected.expect.result);
    // done resolve 时所有 append 都已提交：commit-before-deliver 在引擎边界成立。
    expect(resolved.length).toBe(events.length);
    expect(events.length).toBeGreaterThan(0);
    expect(events[0]).toMatchObject({ t: 'run', runId: 'engine-run-1', status: 'running' });
    expect(events[events.length - 1]).toMatchObject({ t: 'run', runId: 'engine-run-1', status: 'completed' });
    expect(events.filter((e) => e.t === 'call_start').length).toBe(2);
    expect(events.filter((e) => e.t === 'deliver').length).toBe(2);
  }, 60_000);

  it('replays injected cache entries as call_end{cached} without dispatching', async () => {
    const { script, expected } = await loadFixture('seq-two-calls');
    const engine = new WorkflowEngine({ adapter: new MockHarness(expected.mock) });
    const parentEvents: JournalEvent[] = [];
    const parent = await engine.run({
      runId: 'engine-parent',
      script,
      args: expected.args,
      cache: [],
      journal: async (event) => {
        parentEvents.push(event);
      },
    });
    expect((await parent.done).status).toBe('completed');

    const cache = parentEvents
      .filter((e): e is Extract<JournalEvent, { t: 'call_end' }> => e.t === 'call_end' && e.status === 'ok')
      .map((end) => {
        const start = parentEvents.find(
          (e): e is Extract<JournalEvent, { t: 'call_start' }> => e.t === 'call_start' && e.callSeq === end.callSeq,
        )!;
        return { contentKey: start.contentKey, result: end.result, fromRunId: 'engine-parent' };
      });
    expect(cache.length).toBe(2);

    const childMock = new MockHarness(expected.mock);
    const childEngine = new WorkflowEngine({ adapter: childMock });
    const childEvents: JournalEvent[] = [];
    const child = await childEngine.run({
      runId: 'engine-child',
      script,
      args: expected.args,
      cache,
      parentRunId: 'engine-parent',
      journal: async (event) => {
        childEvents.push(event);
      },
    });
    const outcome = await child.done;

    expect(outcome.status).toBe('completed');
    expect(outcome.result).toEqual(expected.expect.result);
    expect(childMock.dispatchCount).toBe(0);
    const ends = childEvents.filter((e): e is Extract<JournalEvent, { t: 'call_end' }> => e.t === 'call_end');
    expect(ends.map((e) => e.status)).toEqual(['cached', 'cached']);
    for (const e of ends) expect(e.cachedFromRunId).toBe('engine-parent');
    expect(childEvents[0]).toMatchObject({ t: 'run', parentRunId: 'engine-parent' });
  }, 60_000);

  it('stop resolves after cleanup is confirmed', async () => {
    const { script, expected } = await loadFixture('seq-two-calls');
    const engine = new WorkflowEngine({ adapter: new MockHarness(expected.mock, { delayMs: 30_000 }) });
    const handle = await engine.run({
      runId: 'engine-stop',
      script,
      args: expected.args,
      cache: [],
      journal: async () => {},
    });
    await handle.stop();
    const outcome = await handle.done;
    expect(outcome.status).toBe('stopped');
  }, 60_000);

  it('fails the run with internal_error when the journal sink rejects', async () => {
    const { script, expected } = await loadFixture('seq-two-calls');
    const engine = new WorkflowEngine({ adapter: new MockHarness(expected.mock) });
    let appended = 0;
    const handle = await engine.run({
      runId: 'engine-sink-fail',
      script,
      args: expected.args,
      cache: [],
      journal: async () => {
        appended += 1;
        if (appended >= 3) throw new Error('sink exploded');
      },
    });
    const outcome = await handle.done;
    expect(outcome.status).toBe('failed');
    expect(outcome.failureCode).toBe('internal_error');
  }, 60_000);

  it('passes spec.input and the whole spec verbatim to createAdapter', async () => {
    const { script, expected } = await loadFixture('seq-two-calls');
    const received: WorkflowEngineRunSpec[] = [];
    const fallback = new MockHarness({});
    const engine = new WorkflowEngine({
      adapter: fallback,
      createAdapter: (spec) => {
        received.push(spec);
        return new MockHarness(expected.mock);
      },
    });
    const input = { files: [{ path: 'notes/a.txt', base64: 'QQ==' }] };
    const spec: WorkflowEngineRunSpec = { runId: 'engine-input', script, args: expected.args, input, cache: [], journal: async () => {} };

    const handle = await engine.run(spec);
    const outcome = await handle.done;

    expect(outcome.status).toBe('completed');
    expect(received).toEqual([spec]);
    expect(received[0]).toBe(spec);
    expect(received[0]?.input).toBe(input);
    expect(fallback.dispatchCount).toBe(0);
  }, 60_000);

  it('rejects cache entries without a parentRunId', async () => {
    const { script, expected } = await loadFixture('seq-two-calls');
    const engine = new WorkflowEngine({ adapter: new MockHarness(expected.mock) });
    await expect(
      engine.run({
        runId: 'engine-bad-cache',
        script,
        args: expected.args,
        cache: [{ contentKey: 'k', result: 'v', fromRunId: 'someone' }],
        journal: async () => {},
      }),
    ).rejects.toMatchObject({ name: 'WorkflowContractError', code: 'invalid_args' });
  });
});
