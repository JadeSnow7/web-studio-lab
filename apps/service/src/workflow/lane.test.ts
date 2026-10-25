import { describe, expect, it } from 'vitest';
import type { WorkflowInputFile, WorkflowPublication } from '@wsl/protocol';
import { createRun, resumeRun } from './kernel';
import type { CallEvent, WorkflowCall, WorkflowCallAdapter, WorkflowLaneWorkspace } from './call-adapter';
import type { JournalEvent } from './contract';
import { freshJournalDir, readRunJournal } from './test-helpers';

// W6a lane：候选随 result 事件回内核 → publishCandidate 先于 call_end → 发布事实进 journal；
// 发布缺位/拒绝/候选缺失一律 internal 失败且不缓存；续跑命中时祖先已提交 publication 原样回放。
// W8：lane 不再物理串行——与 readonly 同享并发上界（固定波次）；发布/合并经 pendingLaneEnds
// 按 callSeq 排干；laneWorkspace 端口取回登记基线注入 attempt 工作区（attempt_start.laneBase）。

const LANE_THEN_RO = `export const meta = { name: 'lane', description: 'lane + readonly' };
export default async function main() {
  const a = agent('写文件', { label: 'lane-a', isolation: 'lane' });
  const b = agent('只读', { label: 'ro-b', isolation: 'readonly' });
  const [ra, rb] = await Promise.all([a, b]);
  return [ra.status === 'ok' ? ra.value : ra.code, rb.status === 'ok' ? rb.value : rb.code];
}`;

const LANE_ONLY = `export const meta = { name: 'lane1', description: 'single lane' };
export default async function main() {
  return agent('写文件', { label: 'lane-a', isolation: 'lane' });
}`;

const WAVE_TWO = `export const meta = { name: 'wave', description: 'two lanes in parallel' };
export default async function main() {
  const [a, b] = await parallel([
    () => agent('写A', { label: 'lane-a', isolation: 'lane' }),
    () => agent('写B', { label: 'lane-b', isolation: 'lane' }),
  ]);
  return [a.status, b.status];
}`;

const publication = (afterTree: string): WorkflowPublication => ({
  baseTree: 'a'.repeat(40),
  afterTree,
  patchSha256: 'c'.repeat(64),
  files: [{ path: 'out.txt', change: 'added', additions: 1, deletions: 0, binary: false }],
});

/** W6b：lane 调用要求受理期绑定的受管 App；测试显式注入目标身份（未绑定的拒绝见 E7-114）。 */
const APP_TARGET = { workspaceId: 'w-lane', projectId: 'p-lane' };
const LANE_BASE = 'd'.repeat(40);
const laneWorkspace =
  (files: WorkflowInputFile[] = [{ path: 'in.txt', base64: 'aW4=' }]) =>
  async (): Promise<WorkflowLaneWorkspace> => ({ baseTree: LANE_BASE, files });

/** lane 适配器缝：lane 调用回候选文件集，readonly 回纯文本；记录在途峰值与收到的 laneInput。 */
class LaneAdapter implements WorkflowCallAdapter {
  readonly harnessId = 'mock';
  active = 0;
  peak = 0;
  readonly dispatched: WorkflowCall[] = [];

  constructor(
    private readonly candidate: { files: WorkflowInputFile[] } | null = { files: [{ path: 'out.txt', base64: 'WA==' }] },
    private readonly delayMs = 10,
  ) {}

  async *run(call: WorkflowCall, signal: AbortSignal): AsyncIterable<CallEvent> {
    this.active += 1;
    this.peak = Math.max(this.peak, this.active);
    this.dispatched.push(call);
    const deadline = Date.now() + this.delayMs;
    while (Date.now() < deadline && !signal.aborted) {
      await new Promise((r) => setTimeout(r, Math.min(5, deadline - Date.now())));
    }
    // 内核消费终态后即遗弃迭代器：计数在 yield 前释放（同 CountingAdapter）。
    this.active -= 1;
    if (signal.aborted) return;
    if (call.isolation === 'lane') {
      yield { type: 'result', text: `lane:${call.label ?? ''}`, ...(this.candidate ? { candidate: this.candidate } : {}) };
    } else {
      yield { type: 'result', text: `ro:${call.label ?? ''}` };
    }
  }
}

const callEnd = (events: JournalEvent[], seq: number) =>
  events.find((e): e is Extract<JournalEvent, { t: 'call_end' }> => e.t === 'call_end' && e.callSeq === seq);

describe('lane isolation (W6a/W8)', () => {
  it('lane 候选经 publishCandidate 登记后随 call_end{publication} 落盘；laneBase 进 attempt_start', async () => {
    const journalDir = freshJournalDir();
    const published: { callSeq: number; files: WorkflowInputFile[] }[] = [];
    const adapter = new LaneAdapter();
    const run = await createRun({
      script: LANE_THEN_RO,
      args: null,
      journalDir,
      adapter,
      runId: 'lane-ok',
      appTarget: APP_TARGET,
      laneWorkspace: laneWorkspace(),
      publishCandidate: async (callSeq, candidate) => {
        published.push({ callSeq, files: candidate.files });
        return { publication: publication('b'.repeat(40)) };
      },
    });
    const outcome = await run.done;

    expect(outcome.status).toBe('completed');
    expect(published).toEqual([{ callSeq: 1, files: [{ path: 'out.txt', base64: 'WA==' }] }]);
    const events = await readRunJournal(journalDir, run.runId);
    const end = callEnd(events, 1);
    expect(end).toMatchObject({ status: 'ok', publication: publication('b'.repeat(40)) });
    expect(events.find((e) => e.t === 'call_start' && e.callSeq === 1)).toMatchObject({ isolation: 'lane' });
    // W8：attempt_start 携带 lane 基线树；工作区文件集注入适配器（laneInput）。
    const attemptStart = events.find((e): e is Extract<JournalEvent, { t: 'attempt_start' }> => e.t === 'attempt_start' && e.callSeq === 1);
    expect(attemptStart?.laneBase).toBe(LANE_BASE);
    expect(adapter.dispatched.find((c) => c.isolation === 'lane')?.laneInput).toEqual([{ path: 'in.txt', base64: 'aW4=' }]);
  }, 60_000);

  it('W8 波次：两 lane 物理并行（peak≥2），call_end/publication 仍按 callSeq 提交', async () => {
    const journalDir = freshJournalDir();
    // lane-b 先物理完成（delayMs 小），lane-a 后到；发布次序仍须 [1, 2]。
    class WaveAdapter extends LaneAdapter {
      override async *run(call: WorkflowCall, signal: AbortSignal): AsyncIterable<CallEvent> {
        this.dispatched.push(call);
        this.active += 1;
        this.peak = Math.max(this.peak, this.active);
        const wait = call.label === 'lane-a' ? 120 : 10;
        const deadline = Date.now() + wait;
        while (Date.now() < deadline && !signal.aborted) await new Promise((r) => setTimeout(r, 5));
        this.active -= 1;
        if (signal.aborted) return;
        yield { type: 'result', text: call.label ?? '', candidate: { files: [{ path: `${call.label}.txt`, base64: 'WA==' }] } };
      }
    }
    const adapter = new WaveAdapter();
    const publishOrder: number[] = [];
    const run = await createRun({
      script: WAVE_TWO,
      args: null,
      journalDir,
      adapter,
      runId: 'lane-wave',
      appTarget: APP_TARGET,
      laneWorkspace: laneWorkspace(),
      publishCandidate: async (callSeq) => {
        publishOrder.push(callSeq);
        return { publication: publication(`${'e'.repeat(39)}${callSeq}`) };
      },
    });
    const outcome = await run.done;

    expect(outcome.status).toBe('completed');
    // 物理并行发生（两 lane 同时在途）。
    expect(adapter.peak).toBe(2);
    // 乱序完成仍按逻辑序号发布。
    expect(publishOrder).toEqual([1, 2]);
    const events = await readRunJournal(journalDir, run.runId);
    const endIdx = [1, 2].map((seq) => events.findIndex((e) => e.t === 'call_end' && e.callSeq === seq));
    expect(endIdx[0]).toBeGreaterThanOrEqual(0);
    expect(endIdx[1]).toBeGreaterThan(endIdx[0]!);
    expect(outcome.result).toEqual(['ok', 'ok']);
  }, 60_000);

  it('W8 冲突：publishCandidate 回 conflict → call_end{conflict} + VM conflict 槽位', async () => {
    const journalDir = freshJournalDir();
    const run = await createRun({
      script: LANE_ONLY,
      args: null,
      journalDir,
      adapter: new LaneAdapter(),
      runId: 'lane-merge-conflict',
      appTarget: APP_TARGET,
      laneWorkspace: laneWorkspace(),
      publishCandidate: async () => ({ conflict: { files: ['shared.txt'], candidateRef: 'f'.repeat(40) } }),
    });
    const outcome = await run.done;

    expect(outcome.status).toBe('completed');
    const events = await readRunJournal(journalDir, run.runId);
    expect(callEnd(events, 1)).toMatchObject({
      status: 'conflict',
      conflictFiles: ['shared.txt'],
      candidateRef: 'f'.repeat(40),
    });
    expect(outcome.result).toMatchObject({ status: 'conflict', files: ['shared.txt'], candidateRef: 'f'.repeat(40) });
  }, 60_000);

  it('publishCandidate 拒绝 → call_end{failed,internal}，不产生 deliver', async () => {
    const journalDir = freshJournalDir();
    const adapter = new LaneAdapter();
    const run = await createRun({
      script: LANE_ONLY,
      args: null,
      journalDir,
      adapter,
      runId: 'lane-conflict',
      appTarget: APP_TARGET,
      laneWorkspace: laneWorkspace(),
      publishCandidate: async () => {
        throw new Error('candidate CAS failed');
      },
    });
    const outcome = await run.done;

    // 调用失败经 deliver 回脚本，由脚本决定 run 终态——本脚本把它当结果返回。
    expect(outcome.status).toBe('completed');
    const events = await readRunJournal(journalDir, run.runId);
    expect(callEnd(events, 1)).toMatchObject({ status: 'failed', code: 'internal' });
    expect(outcome.result).toMatchObject({ status: 'failed', code: 'internal' });
  }, 60_000);

  it('lane result 缺候选 → call_end{failed,internal}；publishCandidate 未被调用', async () => {
    const journalDir = freshJournalDir();
    let published = 0;
    const run = await createRun({
      script: LANE_ONLY,
      args: null,
      journalDir,
      adapter: new LaneAdapter(null),
      runId: 'lane-nocandidate',
      appTarget: APP_TARGET,
      laneWorkspace: laneWorkspace(),
      publishCandidate: async () => {
        published += 1;
        return { publication: publication('b'.repeat(40)) };
      },
    });
    await run.done;
    expect(published).toBe(0);
    const events = await readRunJournal(journalDir, run.runId);
    expect(callEnd(events, 1)).toMatchObject({ status: 'failed', code: 'internal' });
  }, 60_000);

  it('无 publishCandidate/laneWorkspace 端口 → 不派发 attempt，call_end{failed,internal}', async () => {
    const journalDir = freshJournalDir();
    const adapter = new LaneAdapter();
    const run = await createRun({ script: LANE_ONLY, args: null, journalDir, adapter, runId: 'lane-nopub', appTarget: APP_TARGET });
    await run.done;
    expect(adapter.dispatched).toHaveLength(0);
    const events = await readRunJournal(journalDir, run.runId);
    expect(callEnd(events, 1)).toMatchObject({ status: 'failed', code: 'internal' });
    expect(events.some((e) => e.t === 'attempt_start')).toBe(false);
  }, 60_000);

  it('laneWorkspace 拒绝 → failed{unavailable}，不派发 attempt', async () => {
    const journalDir = freshJournalDir();
    const adapter = new LaneAdapter();
    const error = new Error('lane base tree gone');
    (error as { code?: string }).code = 'unavailable';
    const run = await createRun({
      script: LANE_ONLY,
      args: null,
      journalDir,
      adapter,
      runId: 'lane-noworkspace',
      appTarget: APP_TARGET,
      laneWorkspace: async () => {
        throw error;
      },
      publishCandidate: async () => ({ publication: publication('b'.repeat(40)) }),
    });
    await run.done;
    expect(adapter.dispatched).toHaveLength(0);
    const events = await readRunJournal(journalDir, run.runId);
    expect(callEnd(events, 1)).toMatchObject({ status: 'failed', code: 'unavailable' });
  }, 60_000);

  it('续跑命中祖先 lane 缓存：call_end{cached} 回放原 publication，不重新派发', async () => {
    const journalDir = freshJournalDir();
    const adapter = new LaneAdapter();
    const parent = await createRun({
      script: LANE_ONLY,
      args: null,
      journalDir,
      adapter,
      runId: 'lane-parent',
      appTarget: APP_TARGET,
      laneWorkspace: laneWorkspace(),
      publishCandidate: async () => ({ publication: publication('b'.repeat(40)) }),
    });
    expect((await parent.done).status).toBe('completed');

    const childAdapter = new LaneAdapter();
    const child = await resumeRun({
      script: LANE_ONLY,
      args: null,
      journalDir,
      adapter: childAdapter,
      runId: 'lane-child',
      appTarget: APP_TARGET,
      parentRunId: 'lane-parent',
      laneWorkspace: laneWorkspace(),
      publishCandidate: async () => {
        throw new Error('cached hit must not publish');
      },
    });
    const outcome = await child.done;

    expect(outcome.status).toBe('completed');
    expect(childAdapter.dispatched).toHaveLength(0);
    const events = await readRunJournal(journalDir, child.runId);
    expect(callEnd(events, 1)).toMatchObject({
      status: 'cached',
      cachedFromRunId: 'lane-parent',
      publication: publication('b'.repeat(40)),
    });
  }, 60_000);
});
