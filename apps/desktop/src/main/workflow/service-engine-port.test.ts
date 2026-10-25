import { describe, expect, it } from 'vitest';
import type { ChatServiceMessage, WorkflowJournalEvent } from '@wsl/protocol';
import { ServiceWorkflowEnginePort, type WorkflowServiceChannel } from './service-engine-port';
import type { WorkflowEngineRunSpec } from './engine-port';

type WorkflowEvent = Extract<
  ChatServiceMessage,
  { type: 'workflow-event' | 'workflow-done' | 'workflow-cleanup-unconfirmed' | 'workflow-candidate' | 'workflow-lanebase' }
>;

/** 假 Main↔service 通道：记录请求、手动投递事件、手动触发退出。 */
class FakeChannel implements WorkflowServiceChannel {
  readonly requests: { method: string; [k: string]: unknown }[] = [];
  private listener: ((message: WorkflowEvent) => void) | null = null;
  private exit: (() => void) | null = null;
  failNext = false;

  async workflowRequest(request: { method: string }): Promise<unknown> {
    if (this.failNext) {
      this.failNext = false;
      throw new Error('service offline');
    }
    this.requests.push(request);
    return null;
  }

  setWorkflowListener(listener: (message: WorkflowEvent) => void): void {
    this.listener = listener;
  }

  onExit(listener: () => void): void {
    this.exit = listener;
  }

  deliver(message: WorkflowEvent): void {
    this.listener?.(message);
  }

  kill(): void {
    this.exit?.();
  }

  acks() {
    return this.requests.filter((r) => r.method === 'workflow-event-ack');
  }
}

const spec = (journal: (event: WorkflowJournalEvent) => Promise<void>): WorkflowEngineRunSpec => ({
  runId: 'r1',
  script: 's',
  args: null,
  cache: [],
  journal,
});

const logEvent = (runId = 'r1'): WorkflowJournalEvent => ({ t: 'log', runId, seq: 1, message: 'm' });

const flush = () => new Promise((resolve) => setImmediate(resolve));

describe('ServiceWorkflowEnginePort', () => {
  it('run posts workflow-run spec (journal stripped) and done resolves on workflow-done', async () => {
    const channel = new FakeChannel();
    const port = new ServiceWorkflowEnginePort(channel);
    const appended: WorkflowJournalEvent[] = [];
    const handle = await port.run(spec(async (e) => void appended.push(e)));

    expect(channel.requests).toEqual([
      {
        method: 'workflow-run',
        runId: 'r1',
        script: 's',
        args: null,
        cache: [],
        deadlineMs: undefined,
        input: undefined,
        parentRunId: undefined,
      },
    ]);

    channel.deliver({ type: 'workflow-event', runId: 'r1', seq: 1, event: logEvent() });
    await flush();
    await flush();
    expect(appended).toEqual([logEvent()]);
    expect(channel.acks()).toEqual([{ method: 'workflow-event-ack', runId: 'r1', seq: 1, ok: true }]);

    channel.deliver({ type: 'workflow-done', runId: 'r1', outcome: { status: 'completed' } });
    await expect(handle.done).resolves.toEqual({ status: 'completed' });
  });

  it('journal append failure acks ok:false so the kernel records internal_error', async () => {
    const channel = new FakeChannel();
    const port = new ServiceWorkflowEnginePort(channel);
    await port.run(spec(async () => Promise.reject(new Error('sqlite full'))));
    channel.deliver({ type: 'workflow-event', runId: 'r1', seq: 1, event: logEvent() });
    await flush();
    await flush();
    expect(channel.acks()).toEqual([{ method: 'workflow-event-ack', runId: 'r1', seq: 1, ok: false, error: 'sqlite full' }]);
  });

  it('stop posts workflow-stop; service exit rejects unconfirmed done without forged journal', async () => {
    const channel = new FakeChannel();
    const port = new ServiceWorkflowEnginePort(channel);
    const handle = await port.run(spec(async () => {}));
    void handle.stop();
    expect(channel.requests.at(-1)).toEqual({ method: 'workflow-stop', runId: 'r1' });
    channel.kill();
    await expect(handle.done).rejects.toThrow('workflow service exited before cleanup confirmation');
    await expect(handle.stop()).rejects.toThrow('workflow service exited before cleanup confirmation');
  });

  it('unknown run admission propagates and keeps its receipt slot', async () => {
    const channel = new FakeChannel();
    channel.failNext = true;
    const port = new ServiceWorkflowEnginePort(channel);
    await expect(port.run(spec(async () => {}))).rejects.toThrow('service offline');
    // A late receipt still has its owner; do not discard evidence after an unknown admission.
    channel.deliver({ type: 'workflow-event', runId: 'r1', seq: 1, event: logEvent() });
    await flush();
    expect(channel.acks()).toEqual([{ method: 'workflow-event-ack', runId: 'r1', seq: 1, ok: true }]);
  });

  it('W6a workflow-candidate → publisher 委托 → workflow-candidate.reply ok:true', async () => {
    const channel = new FakeChannel();
    const port = new ServiceWorkflowEnginePort(channel);
    const publication = {
      baseTree: 'a'.repeat(40),
      afterTree: 'b'.repeat(40),
      patchSha256: 'c'.repeat(64),
      files: [{ path: 'src/x.ts', change: 'modified' as const, additions: 3, deletions: 1, binary: false }],
    };
    const calls: { runId: string; callSeq: number; files: unknown }[] = [];
    port.setCandidatePublisher({
      publishCandidate: async (runId, callSeq, files) => {
        calls.push({ runId, callSeq, files });
        return { publication };
      },
    });
    const id = '33333333-3333-4333-8333-333333333333';
    const files = [{ path: 'src/x.ts', base64: 'WA==' }];
    channel.deliver({ type: 'workflow-candidate', id, runId: 'r1', callSeq: 2, files });
    await flush();
    await flush();
    expect(calls).toEqual([{ runId: 'r1', callSeq: 2, files }]);
    expect(channel.requests.at(-1)).toEqual({
      method: 'workflow-candidate.reply',
      payload: { callId: id, result: { ok: true, publication } },
    });
  });

  it('W6a 委托拒绝与未绑定都回 ok:false，不伪造登记', async () => {
    const channel = new FakeChannel();
    const port = new ServiceWorkflowEnginePort(channel);
    const id = '44444444-4444-4444-8444-444444444444';
    // 未绑定 publisher。
    channel.deliver({ type: 'workflow-candidate', id, runId: 'r1', callSeq: 1, files: [] });
    await flush();
    await flush();
    expect(channel.requests.at(-1)).toEqual({
      method: 'workflow-candidate.reply',
      payload: { callId: id, result: { ok: false, error: 'candidate publisher is not bound' } },
    });
    // 委托抛错 → ok:false 回执。
    port.setCandidatePublisher({
      publishCandidate: async () => {
        throw new Error('candidate CAS failed');
      },
    });
    channel.deliver({ type: 'workflow-candidate', id, runId: 'r1', callSeq: 1, files: [] });
    await flush();
    await flush();
    expect(channel.requests.at(-1)).toEqual({
      method: 'workflow-candidate.reply',
      payload: { callId: id, result: { ok: false, error: 'candidate CAS failed' } },
    });
  });

  it('W8 workflow-candidate → 合并冲突回执 ok:true+conflict', async () => {
    const channel = new FakeChannel();
    const port = new ServiceWorkflowEnginePort(channel);
    const conflict = { files: ['shared.txt'], candidateRef: 'f'.repeat(40) };
    port.setCandidatePublisher({ publishCandidate: async () => ({ conflict }) });
    const id = '55555555-5555-4555-8555-555555555555';
    channel.deliver({ type: 'workflow-candidate', id, runId: 'r1', callSeq: 3, files: [] });
    await flush();
    await flush();
    expect(channel.requests.at(-1)).toEqual({
      method: 'workflow-candidate.reply',
      payload: { callId: id, result: { ok: true, conflict } },
    });
  });

  it('W8 workflow-lanebase → provider 委托 → workflow-lanebase.reply；未绑定/拒绝回 ok:false', async () => {
    const channel = new FakeChannel();
    const port = new ServiceWorkflowEnginePort(channel);
    const id = '66666666-6666-4666-8666-666666666666';
    // 未绑定 provider → ok:false。
    channel.deliver({ type: 'workflow-lanebase', id, runId: 'r1', callSeq: 1 });
    await flush();
    await flush();
    expect(channel.requests.at(-1)).toEqual({
      method: 'workflow-lanebase.reply',
      payload: { callId: id, result: { ok: false, error: 'lane workspace provider is not bound' } },
    });
    // 委托返回基线 + 文件集 → ok:true。
    const baseTree = 'd'.repeat(40);
    port.setLaneWorkspaceProvider({
      laneWorkspace: async (runId, callSeq) => ({ baseTree, files: [{ path: `b${callSeq}.txt`, base64: 'WA==' }] }),
    });
    channel.deliver({ type: 'workflow-lanebase', id, runId: 'r1', callSeq: 2 });
    await flush();
    await flush();
    expect(channel.requests.at(-1)).toEqual({
      method: 'workflow-lanebase.reply',
      payload: { callId: id, result: { ok: true, baseTree, files: [{ path: 'b2.txt', base64: 'WA==' }] } },
    });
  });

  it('events for the same run are appended serially before each ack', async () => {
    const channel = new FakeChannel();
    const port = new ServiceWorkflowEnginePort(channel);
    const order: string[] = [];
    await port.run(
      spec(async (e) => {
        order.push(`append:${e.t === 'log' ? e.seq : 'x'}`);
        await flush();
      }),
    );
    channel.deliver({ type: 'workflow-event', runId: 'r1', seq: 1, event: logEvent() });
    channel.deliver({ type: 'workflow-event', runId: 'r1', seq: 2, event: { t: 'log', runId: 'r1', seq: 2, message: 'm2' } });
    await flush();
    await flush();
    await flush();
    expect(order).toEqual(['append:1', 'append:2']);
    expect(channel.acks().map((a) => a['seq'])).toEqual([1, 2]);
  });
});

it('automatic cleanup-unconfirmed rejects done and cannot be overwritten by a late ordinary terminal receipt', async () => {
  const channel = new FakeChannel();
  const port = new ServiceWorkflowEnginePort(channel);
  const handle = await port.run(spec(async () => {}));
  channel.deliver({ type: 'workflow-cleanup-unconfirmed', runId: 'r1', error: 'guest cleanup unconfirmed' });
  await expect(handle.done).rejects.toThrow('guest cleanup unconfirmed');
  channel.deliver({ type: 'workflow-done', runId: 'r1', outcome: { status: 'stopped' } });
  await expect(handle.stop()).rejects.toThrow('guest cleanup unconfirmed');
  expect(channel.requests.filter((request) => request.method === 'workflow-stop')).toHaveLength(0);
});
