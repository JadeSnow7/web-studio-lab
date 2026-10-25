import { describe, expect, it } from 'vitest';
import type { ChatServiceMessage, ChatServiceRequest, WorkflowJournalEvent, WorkflowRunOutcome } from '@wsl/protocol';
import { ServiceWorkflowHost, type WorkflowEngineLike } from './workflow-host';
import type { WorkflowEngineRunSpec } from './workflow/engine';
import type { NativeHarnessAdapter } from './harness/types';

/** 记录 spec、由测试驱动 done/stop 的假引擎。 */
class FakeEngine implements WorkflowEngineLike {
  readonly specs = new Map<string, WorkflowEngineRunSpec>();
  private readonly controls = new Map<string, { resolve: (o: WorkflowRunOutcome) => void; stopped: boolean }>();
  rejectNext: unknown = null;

  async run(spec: WorkflowEngineRunSpec) {
    if (this.rejectNext !== null) {
      const error = this.rejectNext;
      this.rejectNext = null;
      throw error;
    }
    this.specs.set(spec.runId, spec);
    let resolveDone!: (o: WorkflowRunOutcome) => void;
    const done = new Promise<WorkflowRunOutcome>((resolve) => {
      resolveDone = resolve;
    });
    this.controls.set(spec.runId, { resolve: resolveDone, stopped: false });
    return {
      done,
      stop: async () => {
        this.controls.get(spec.runId)!.stopped = true;
      },
    };
  }

  emit(runId: string, event: WorkflowJournalEvent): Promise<void> {
    return this.specs.get(runId)!.journal(event);
  }

  finish(runId: string, outcome: WorkflowRunOutcome): void {
    this.controls.get(runId)!.resolve(outcome);
  }

  wasStopped(runId: string): boolean {
    return this.controls.get(runId)?.stopped ?? false;
  }
}

const stubHarness = { harnessId: 'codex', label: 'Codex' } as unknown as NativeHarnessAdapter;

function makeHost() {
  const posted: ChatServiceMessage[] = [];
  const engine = new FakeEngine();
  const host = new ServiceWorkflowHost({
    post: (msg) => posted.push(msg),
    ready: Promise.resolve(),
    start: () => {
      throw new Error('not used by FakeEngine');
    },
    harnesses: [stubHarness],
    engine,
  });
  return { host, engine, posted };
}

const runRequest = (runId: string): Extract<ChatServiceRequest, { method: 'workflow-run' }> => ({
  id: 'req-1',
  method: 'workflow-run',
  runId,
  script: 's',
  args: { a: 1 },
  cache: [],
});

const event = (runId: string): WorkflowJournalEvent => ({
  t: 'log',
  runId,
  seq: 1,
  message: 'm',
});

const ackRequest = (
  runId: string,
  seq: number,
  ok: boolean,
  error?: string,
): Extract<ChatServiceRequest, { method: 'workflow-event-ack' }> => ({
  id: `ack-${seq}`,
  method: 'workflow-event-ack',
  runId,
  seq,
  ok,
  error,
});

describe('ServiceWorkflowHost', () => {
  it('owns only workflow-* methods', () => {
    const { host } = makeHost();
    expect(host.owns('workflow-run')).toBe(true);
    expect(host.owns('workflow-event-ack')).toBe(true);
    expect(host.owns('send')).toBe(false);
    expect(host.owns('status')).toBe(false);
  });

  it('relays journal events in order, waiting for each ack', async () => {
    const { host, engine, posted } = makeHost();
    await host.execute(runRequest('r1'));
    const spec = engine.specs.get('r1')!;
    expect(spec.journal).toBeTypeOf('function');

    const first = spec.journal(event('r1'));
    await new Promise((resolve) => setImmediate(resolve));
    expect(posted).toEqual([{ type: 'workflow-event', runId: 'r1', seq: 1, event: event('r1') }]);
    // 未回 ack 前 append 未决（内核串行 await，下一条不会发出）。
    await host.execute(ackRequest('r1', 1, true));
    await first;
    const second = spec.journal({ t: 'log', runId: 'r1', seq: 2, message: 'm2' });
    await new Promise((resolve) => setImmediate(resolve));
    expect(posted[1]).toMatchObject({ type: 'workflow-event', seq: 2 });
    await host.execute(ackRequest('r1', 2, true));
    await second;
  });

  it('rejected ack fails the journal append (kernel records internal_error)', async () => {
    const { host, engine } = makeHost();
    await host.execute(runRequest('r1'));
    const spec = engine.specs.get('r1')!;
    const pending = spec.journal(event('r1'));
    await new Promise((resolve) => setImmediate(resolve));
    await host.execute(ackRequest('r1', 1, false, 'sqlite 落盘失败'));
    await expect(pending).rejects.toThrow('sqlite 落盘失败');
  });

  it('posts workflow-done when the run settles and stop drives handle.stop', async () => {
    const { host, engine, posted } = makeHost();
    await host.execute(runRequest('r1'));
    const stopping = host.execute({ id: 'stop-1', method: 'workflow-stop', runId: 'r1' });
    expect(engine.wasStopped('r1')).toBe(true);
    engine.finish('r1', { status: 'stopped' });
    await stopping;
    await new Promise((resolve) => setImmediate(resolve));
    expect(posted.at(-1)).toEqual({ type: 'workflow-done', runId: 'r1', outcome: { status: 'stopped' } });
  });

  it('engine rejection propagates and clears pending acks', async () => {
    const { host, engine } = makeHost();
    engine.rejectNext = new Error('worker spawn failed');
    await expect(host.execute(runRequest('r1'))).rejects.toThrow('worker spawn failed');
    await expect(host.execute({ id: 's', method: 'workflow-stop', runId: 'r1' })).resolves.toBeNull();
  });
});
