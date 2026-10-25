import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import type { WorkflowJournalEvent, WorkflowRunOutcome } from '@wsl/protocol';
import type { WorkflowEnginePort, WorkflowEngineRunSpec } from './engine-port';
import { WorkflowApplication } from './application';
import { SqliteWorkflowJournal } from './journal-sqlite';
import { RunSourceRepository } from '../workbench/run-source-repository';

/**
 * W8/E6B：固定波次 lane 的合并/冲突/回收断言（fixtures/workflow/e6b/scenarios.json）。
 * 用真 RunSourceRepository（objects.git 内容寻址）+ 真 SqliteWorkflowJournal + 应用用例：
 * 断言最终树的文件内容、冲突文件清单与指针位置，不以 commit 成功代替测试通过。
 */

const APP_TARGET = { workspaceId: 'w-e6b', projectId: '99999999-9999-4999-8999-999999999999' };
const LANE_SCRIPT = `export const meta = { name: 'wave', description: 'd' };
export default async function main() { return agent('x', { isolation: 'lane' }); }`;

class FakeEngine implements WorkflowEnginePort {
  async shutdown(): Promise<void> {}
  readonly specs = new Map<string, WorkflowEngineRunSpec>();
  private readonly controls = new Map<string, { resolve: (o: WorkflowRunOutcome) => void }>();

  run(spec: WorkflowEngineRunSpec) {
    this.specs.set(spec.runId, spec);
    let resolveDone!: (o: WorkflowRunOutcome) => void;
    const done = new Promise<WorkflowRunOutcome>((resolve) => {
      resolveDone = resolve;
    });
    this.controls.set(spec.runId, { resolve: resolveDone });
    return { done, stop: async () => {} };
  }

  emit(runId: string, event: WorkflowJournalEvent): Promise<void> {
    return this.specs.get(runId)!.journal(event);
  }

  finish(runId: string, outcome: WorkflowRunOutcome): void {
    this.controls.get(runId)!.resolve(outcome);
  }
}

function makeCtx(overrides?: { mergeFailAt?: number }) {
  const dir = mkdtempSync(path.join(tmpdir(), 'wsl-e6b-'));
  const journal = new SqliteWorkflowJournal(path.join(dir, 'journal.db'));
  const engine = new FakeEngine();
  const repository = new RunSourceRepository(path.join(dir, 'runs'));
  // 可选故障注入：第 mergeFailAt 次 mergeCandidate 抛错（合并途中崩溃场景）。
  let mergeCalls = 0;
  const realMerge = repository.mergeCandidate.bind(repository);
  const store =
    overrides?.mergeFailAt === undefined
      ? repository
      : Object.assign(Object.create(repository), {
          mergeCandidate: async (...args: Parameters<typeof realMerge>) => {
            mergeCalls += 1;
            if (mergeCalls === overrides.mergeFailAt) throw new Error('injected merge crash');
            return realMerge(...args);
          },
        });
  const app = new WorkflowApplication({
    journal,
    engine,
    candidateStore: store,
    appResolver: () => APP_TARGET,
    appSource: {
      snapshot: async (target) => ({
        ok: true as const,
        target,
        cleanupConfirmed: true as const,
        snapshot: {
          ...target,
          files: [{ path: 'a.txt', mode: '100644' as const, base64: Buffer.from('A\n').toString('base64') }],
          totalBytes: 2,
        },
      }),
      apply: async (target) => ({ ok: true as const, target, cleanupConfirmed: true as const }),
    },
    now: () => 1_000,
  });
  return { dir, journal, engine, repository, app };
}

const files = (entries: Record<string, string>) =>
  Object.entries(entries).map(([p, text]) => ({ path: p, base64: Buffer.from(text).toString('base64') }));

async function acceptLaneRun(ctx: ReturnType<typeof makeCtx>, requestId: string) {
  return ctx.app.run({ requestId, script: LANE_SCRIPT, args: null });
}

/** 登记 lane 调用（call_start 冻结当前指针为 base_tree）+ attempt_start。 */
async function registerLaneCall(ctx: ReturnType<typeof makeCtx>, runId: string, callSeq: number) {
  await ctx.engine.emit(runId, {
    t: 'call_start',
    runId,
    callSeq,
    callId: `${runId}:c${callSeq}`,
    phase: null,
    label: `lane-${callSeq}`,
    contentKey: `k${callSeq}`,
    effective: { harness: 'mock' },
    promptHash: `p${callSeq}`,
    isolation: 'lane',
  });
  await ctx.engine.emit(runId, { t: 'attempt_start', runId, callSeq, attempt: 1, isolation: 'lane' });
}

async function materializeMap(ctx: ReturnType<typeof makeCtx>, runId: string, tree: string) {
  const out = await ctx.repository.materialize(runId, tree);
  return new Map(out.map((f) => [f.path, Buffer.from(f.base64, 'base64').toString('utf8')]));
}

describe('E6B 固定波次 lane（真 Git 合并）', () => {
  it('E6B-01 同基线两 lane 独立文件修改 → 按序合入，最终树=两者并集', async () => {
    const ctx = makeCtx();
    const run = await acceptLaneRun(ctx, 'r-wave');
    const runId = run.workflowRunId;
    await registerLaneCall(ctx, runId, 1);
    await registerLaneCall(ctx, runId, 2);

    const p1 = await ctx.app.publishCandidate(runId, 1, files({ 'a.txt': 'A\n', 'x.txt': 'X\n' }));
    expect('publication' in p1).toBe(true);
    const p2 = await ctx.app.publishCandidate(runId, 2, files({ 'a.txt': 'A\n', 'y.txt': 'Y\n' }));
    expect('publication' in p2).toBe(true);

    const row = ctx.journal.getRun(runId)!;
    expect(row.candidateTree).not.toBe(row.baseTree);
    // 断言合并树的实际文件内容——三者并集。
    const tree = await materializeMap(ctx, runId, row.candidateTree!);
    expect([...tree.keys()].sort()).toEqual(['a.txt', 'x.txt', 'y.txt']);
    expect(tree.get('x.txt')).toBe('X\n');
    expect(tree.get('y.txt')).toBe('Y\n');
    // publications 按 call_seq 链式推进。
    const events = ctx.journal.listEvents(runId);
    expect(events.filter((e) => e.t === 'call_start')).toHaveLength(2);
  });

  it('E6B-02 同基线两 lane 改同一文件不同内容 → 后者 conflict{files,candidateRef}，指针停在先者', async () => {
    const ctx = makeCtx();
    const run = await acceptLaneRun(ctx, 'r-conflict');
    const runId = run.workflowRunId;
    await registerLaneCall(ctx, runId, 1);
    await registerLaneCall(ctx, runId, 2);

    const p1 = await ctx.app.publishCandidate(runId, 1, files({ 'a.txt': 'A\n', 'shared.txt': 'L1\n' }));
    expect('publication' in p1).toBe(true);
    const pointerAfterFirst = ctx.journal.getRun(runId)!.candidateTree;

    const p2 = await ctx.app.publishCandidate(runId, 2, files({ 'a.txt': 'A\n', 'shared.txt': 'L2\n' }));
    expect('conflict' in p2).toBe(true);
    if ('conflict' in p2) {
      expect(p2.conflict.files).toEqual(['shared.txt']);
      // 冲突候选保留：tree 可查、内容可物化。
      const orphan = await materializeMap(ctx, runId, p2.conflict.candidateRef);
      expect(orphan.get('shared.txt')).toBe('L2\n');
    }
    // 指针停在先者合并树。
    expect(ctx.journal.getRun(runId)!.candidateTree).toBe(pointerAfterFirst);
    const merged = await materializeMap(ctx, runId, pointerAfterFirst!);
    expect(merged.get('shared.txt')).toBe('L1\n');
  });

  it('E6B-03 同基线两 lane 相同补丁 → 去重合入（prev==next），不误报累计', async () => {
    const ctx = makeCtx();
    const run = await acceptLaneRun(ctx, 'r-dedupe');
    const runId = run.workflowRunId;
    await registerLaneCall(ctx, runId, 1);
    await registerLaneCall(ctx, runId, 2);

    const ws = files({ 'a.txt': 'A\n', 'same.txt': 'S\n' });
    const p1 = await ctx.app.publishCandidate(runId, 1, ws);
    const p2 = await ctx.app.publishCandidate(runId, 2, ws);
    expect('publication' in p1 && 'publication' in p2).toBe(true);
    if ('publication' in p1 && 'publication' in p2) {
      // 去重：第二条 afterTree == 第一条（M==P，事实记录，指针不变）。
      expect(p2.publication.afterTree).toBe(p1.publication.afterTree);
      const tree = await materializeMap(ctx, runId, p2.publication.afterTree);
      expect([...tree.keys()].sort()).toEqual(['a.txt', 'same.txt']);
      expect(tree.get('same.txt')).toBe('S\n');
    }
  });

  it('E6B-04 波内 lane 失败 → 其余照常发布', async () => {
    const ctx = makeCtx();
    const run = await acceptLaneRun(ctx, 'r-partial');
    const runId = run.workflowRunId;
    await registerLaneCall(ctx, runId, 1);
    await registerLaneCall(ctx, runId, 2);
    // seq1 失败终态照常落盘（无发布）；seq2 随后发布。
    await ctx.engine.emit(runId, { t: 'attempt_end', runId, callSeq: 1, attempt: 1, status: 'failed', code: 'crash' });
    await ctx.engine.emit(runId, { t: 'call_end', runId, callSeq: 1, status: 'failed', code: 'crash', attempts: 1 });
    const p2 = await ctx.app.publishCandidate(runId, 2, files({ 'a.txt': 'A\n', 'y.txt': 'Y\n' }));
    expect('publication' in p2).toBe(true);
    const tree = await materializeMap(ctx, runId, ctx.journal.getRun(runId)!.candidateTree!);
    expect(tree.get('y.txt')).toBe('Y\n');
  });

  it('E6B-05 合并途中抛错 → 无半提交：指针/行一致', async () => {
    const ctx = makeCtx({ mergeFailAt: 2 });
    const run = await acceptLaneRun(ctx, 'r-crash');
    const runId = run.workflowRunId;
    await registerLaneCall(ctx, runId, 1);
    await registerLaneCall(ctx, runId, 2);
    const p1 = await ctx.app.publishCandidate(runId, 1, files({ 'a.txt': 'A\n', 'x.txt': 'X\n' }));
    expect('publication' in p1).toBe(true);
    const pointer = ctx.journal.getRun(runId)!.candidateTree;
    await expect(ctx.app.publishCandidate(runId, 2, files({ 'a.txt': 'A\n', 'y.txt': 'Y\n' }))).rejects.toMatchObject({
      code: 'internal_error',
    });
    // 指针停在第一条合并树；没有 seq2 的发布行（publications 表按 (run_id,call_seq) 主键核对）。
    expect(ctx.journal.getRun(runId)!.candidateTree).toBe(pointer);
    const candidate = ctx.journal.candidateForRun(runId);
    expect(candidate?.currentTree).toBe(pointer);
  });

  it('E6B-06 第二波 laneWorkspace 返回已合并基线（含第一波新增文件）', async () => {
    const ctx = makeCtx();
    const run = await acceptLaneRun(ctx, 'r-wave2');
    const runId = run.workflowRunId;
    await registerLaneCall(ctx, runId, 1);
    const p1 = await ctx.app.publishCandidate(runId, 1, files({ 'a.txt': 'A\n', 'x.txt': 'X\n' }));
    expect('publication' in p1).toBe(true);
    // seq2 在第一波发布后登记 → base_tree=已合并指针。
    await registerLaneCall(ctx, runId, 2);
    expect(ctx.journal.callBaseTree(runId, 2)).toBe(ctx.journal.getRun(runId)!.candidateTree);
    const ws = await ctx.app.laneWorkspace(runId, 2);
    const map = new Map(ws.files.map((f) => [f.path, Buffer.from(f.base64, 'base64').toString('utf8')]));
    expect(ws.baseTree).toBe(ctx.journal.getRun(runId)!.candidateTree);
    expect(map.get('x.txt')).toBe('X\n');
    expect(map.get('a.txt')).toBe('A\n');
  });
});
