import { WORKFLOW_EXECUTION_VERSION } from '@wsl/protocol';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import type { AppSource, WorkflowJournalEvent, WorkflowRunOutcome } from '@wsl/protocol';
import type { WorkflowEnginePort, WorkflowEngineRunSpec } from './engine-port';
import { WorkflowApplication, WorkflowApplicationError } from './application';
import { SqliteWorkflowJournal } from './journal-sqlite';

const DSL = 'lab-workflow/1';

/** 记录 spec、由测试驱动 done/stop 的假引擎端口。 */
class FakeEngine implements WorkflowEnginePort {
  async shutdown(): Promise<void> {}
  readonly specs = new Map<string, WorkflowEngineRunSpec>();
  private readonly controls = new Map<string, { resolve: (o: WorkflowRunOutcome) => void; stopped: boolean }>();
  rejectNext: unknown = null;

  run(spec: WorkflowEngineRunSpec) {
    if (this.rejectNext !== null) {
      const error = this.rejectNext;
      this.rejectNext = null;
      return Promise.reject(error);
    }
    this.specs.set(spec.runId, spec);
    let resolveDone!: (o: WorkflowRunOutcome) => void;
    const done = new Promise<WorkflowRunOutcome>((resolve) => {
      resolveDone = resolve;
    });
    const control = { resolve: resolveDone, stopped: false };
    this.controls.set(spec.runId, control);
    return {
      done,
      stop: async () => {
        control.stopped = true;
      },
    };
  }

  /** 模拟内核经沉点写 journal；appendEvent 同步提交。 */
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

function freshJournal(): SqliteWorkflowJournal {
  return new SqliteWorkflowJournal(path.join(mkdtempSync(path.join(tmpdir(), 'wsl-wf-app-')), 'journal.db'));
}

function runEvent(
  runId: string,
  status: string,
  hashes: { scriptHash: string; argsHash: string },
  extra: Partial<WorkflowJournalEvent & { t: 'run' }> = {},
): WorkflowJournalEvent {
  return {
    t: 'run',
    runId,
    parentRunId: null,
    dslVersion: DSL,
    executionVersion: WORKFLOW_EXECUTION_VERSION,
    ...hashes,
    status,
    ...extra,
  } as WorkflowJournalEvent;
}

async function emitOkCall(engine: FakeEngine, runId: string, seq: number, contentKey: string, result: unknown, label = `l${seq}`) {
  await engine.emit(runId, {
    t: 'call_start',
    runId,
    callSeq: seq,
    callId: `${runId}:c${seq}`,
    phase: null,
    label,
    contentKey,
    effective: { harness: 'mock' },
    promptHash: `p${seq}`,
    isolation: 'readonly',
  });
  await engine.emit(runId, { t: 'attempt_start', runId, callSeq: seq, attempt: 1, isolation: 'readonly' });
  await engine.emit(runId, { t: 'attempt_end', runId, callSeq: seq, attempt: 1, status: 'ok' });
  await engine.emit(runId, { t: 'call_end', runId, callSeq: seq, status: 'ok', result, attempts: 1 });
}

async function completeRun(
  engine: FakeEngine,
  accepted: { workflowRunId: string; scriptHash: string; argsHash: string },
  result: unknown,
  parentRunId: string | null = null,
) {
  await engine.emit(accepted.workflowRunId, runEvent(accepted.workflowRunId, 'completed', accepted, { parentRunId, result }));
  engine.finish(accepted.workflowRunId, { status: 'completed', result });
}

function makeApp() {
  const journal = freshJournal();
  const engine = new FakeEngine();
  const app = new WorkflowApplication({ journal, engine, now: () => 1_000 });
  return { app, engine, journal };
}

async function expectAppError(promise: Promise<unknown>, code: string): Promise<void> {
  try {
    await promise;
    expect.unreachable(`expected ${code}`);
  } catch (error) {
    expect(error).toBeInstanceOf(WorkflowApplicationError);
    expect((error as WorkflowApplicationError).code).toBe(code);
  }
}

describe('WorkflowApplication', () => {
  it('run is idempotent on requestId and rejects conflicting content', async () => {
    const { app, engine } = makeApp();
    const first = await app.run({ requestId: 'req-1', script: 's', args: { a: 1 } });
    await completeRun(engine, first, 'done');

    const again = await app.run({ requestId: 'req-1', script: 's', args: { a: 1 } });
    expect(again.workflowRunId).toBe(first.workflowRunId);
    expect(engine.specs.size).toBe(1);

    await expectAppError(app.run({ requestId: 'req-1', script: 's-changed', args: { a: 1 } }), 'request_conflict');
  });

  it('run_busy while any run is non-terminal', async () => {
    const { app, engine } = makeApp();
    const first = await app.run({ requestId: 'req-1', script: 's', args: null });
    await expectAppError(app.run({ requestId: 'req-2', script: 's2', args: null }), 'run_busy');
    await completeRun(engine, first, 'done');
    const second = await app.run({ requestId: 'req-2', script: 's2', args: null });
    expect(second.workflowRunId).not.toBe(first.workflowRunId);
  });

  it('resume passes ancestor cache in order and sets parentRunId', async () => {
    const { app, engine } = makeApp();
    // 祖父 run：k1 ok。
    const grand = await app.run({ requestId: 'g', script: 's', args: { a: 1 } });
    await emitOkCall(engine, grand.workflowRunId, 1, 'k1', 'v1');
    await completeRun(engine, grand, 'g-done');
    // 父 run 续祖父：k1 cached（出处仍是祖父），k2 新执行 ok。
    const parent = await app.resume({ requestId: 'p', parentWorkflowRunId: grand.workflowRunId, script: 's', args: { a: 1 } });
    const parentSpec = engine.specs.get(parent.workflowRunId)!;
    expect(parentSpec.parentRunId).toBe(grand.workflowRunId);
    await engine.emit(parent.workflowRunId, {
      t: 'call_start',
      runId: parent.workflowRunId,
      callSeq: 1,
      callId: `${parent.workflowRunId}:c1`,
      phase: null,
      label: 'l1',
      contentKey: 'k1',
      effective: { harness: 'mock' },
      promptHash: 'p1',
      isolation: 'readonly',
    });
    await engine.emit(parent.workflowRunId, {
      t: 'call_end',
      runId: parent.workflowRunId,
      callSeq: 1,
      status: 'cached',
      result: 'v1',
      cachedFromRunId: grand.workflowRunId,
      attempts: 0,
    });
    await emitOkCall(engine, parent.workflowRunId, 2, 'k2', 'v2');
    await completeRun(engine, parent, 'p-done', grand.workflowRunId);
    // 孙 run：近祖先优先——k1 出处回溯到祖父，k2 来自父。
    const child = await app.resume({ requestId: 'c', parentWorkflowRunId: parent.workflowRunId, script: 's', args: { a: 1 } });
    const childSpec = engine.specs.get(child.workflowRunId)!;
    expect(childSpec.parentRunId).toBe(parent.workflowRunId);
    expect(childSpec.cache).toEqual([
      { contentKey: 'k1', result: 'v1', fromRunId: grand.workflowRunId },
      { contentKey: 'k2', result: 'v2', fromRunId: parent.workflowRunId },
    ]);
  });

  it('resume rejects on identity/state mismatches', async () => {
    const { app, engine, journal } = makeApp();
    const parent = await app.run({ requestId: 'p', script: 's', args: { a: 1 } });
    await completeRun(engine, parent, 'done');

    await expectAppError(
      app.resume({ requestId: 'r1', parentWorkflowRunId: parent.workflowRunId, script: 's-changed', args: { a: 1 } }),
      'resume_mismatch',
    );
    await expectAppError(
      app.resume({ requestId: 'r1', parentWorkflowRunId: parent.workflowRunId, script: 's', args: { a: 2 } }),
      'resume_mismatch',
    );
    await expectAppError(app.resume({ requestId: 'r1', parentWorkflowRunId: 'no-such-run', script: 's', args: { a: 1 } }), 'run_not_found');

    // running 父 → run_not_resumable
    const running = await app.run({ requestId: 'running', script: 's', args: { a: 1 } });
    await expectAppError(
      app.resume({ requestId: 'r2', parentWorkflowRunId: running.workflowRunId, script: 's', args: { a: 1 } }),
      'run_not_resumable',
    );
    // needs_reconciliation 父 → process_unconfirmed
    journal.updateRunStatus(running.workflowRunId, { status: 'needs_reconciliation' });
    await expectAppError(
      app.resume({ requestId: 'r2', parentWorkflowRunId: running.workflowRunId, script: 's', args: { a: 1 } }),
      'process_unconfirmed',
    );
  });

  it('stop drives engine stop and the journal-carried terminal state is the authority', async () => {
    const { app, engine } = makeApp();
    const run = await app.run({ requestId: 's', script: 's', args: null });
    const stopPromise = app.stop(run.workflowRunId);
    expect(engine.wasStopped(run.workflowRunId)).toBe(true);
    await engine.emit(run.workflowRunId, runEvent(run.workflowRunId, 'stopped', run));
    engine.finish(run.workflowRunId, { status: 'stopped' });
    await stopPromise;
    expect(app.status(run.workflowRunId).status).toBe('stopped');
    // 已终态 run 的 stop 为 no-op。
    await app.stop(run.workflowRunId);
  });

  it('recoverOpenRuns marks non-terminal runs; reconcileAsStopped unlocks resume', async () => {
    const journal = freshJournal();
    const engine = new FakeEngine();
    const app = new WorkflowApplication({ journal, engine });
    const run = await app.run({ requestId: 'open', script: 's', args: { a: 1 } });
    await engine.emit(run.workflowRunId, runEvent(run.workflowRunId, 'running', run));

    // 模拟重启：新应用实例不持有句柄，恢复扫描标记待核对。
    const recovered = new WorkflowApplication({ journal, engine: new FakeEngine() });
    const marked = recovered.recoverOpenRuns();
    expect(marked.map((r) => r.runId)).toEqual([run.workflowRunId]);
    expect(recovered.status(run.workflowRunId).status).toBe('needs_reconciliation');
    await expectAppError(
      recovered.resume({ requestId: 'r', parentWorkflowRunId: run.workflowRunId, script: 's', args: { a: 1 } }),
      'process_unconfirmed',
    );

    recovered.reconcileAsStopped(run.workflowRunId);
    expect(recovered.status(run.workflowRunId).status).toBe('stopped');
    const child = await recovered.resume({ requestId: 'r', parentWorkflowRunId: run.workflowRunId, script: 's', args: { a: 1 } });
    expect(child.workflowRunId).not.toBe(run.workflowRunId);
  });

  it('status projects run and calls from tables', async () => {
    const { app, engine } = makeApp();
    const run = await app.run({ requestId: 'q', script: 's', args: null });
    await emitOkCall(engine, run.workflowRunId, 1, 'k1', { v: 1 });
    await completeRun(engine, run, { summary: 'ok' });

    expect(app.status(run.workflowRunId)).toEqual({
      runId: run.workflowRunId,
      status: 'completed',
      failureCode: null,
      result: { summary: 'ok' },
      calls: [{ seq: 1, label: 'l1', status: 'ok', code: null, attempts: 1, phase: null, cachedFromRunId: null, usage: null }],
      logTail: [],
      requiresApp: false,
      writes: false,
      appTarget: null,
    });
    expect(() => app.status('missing')).toThrowError(WorkflowApplicationError);
  });

  it('engine rejection fails the registered run instead of leaking a slot', async () => {
    const { app, engine, journal } = makeApp();
    engine.rejectNext = new Error('engine offline');
    await expectAppError(app.run({ requestId: 'bad', script: 's', args: null }), 'engine_rejected');
    expect(journal.listNonTerminalRuns()).toHaveLength(0);
    expect(journal.findRunByRequestId('bad')).toMatchObject({ status: 'failed', failureCode: 'engine_rejected' });
    // run 行已结清 failed，不阻塞后续受理。
    const ok = await app.run({ requestId: 'ok', script: 's', args: null });
    expect(ok.workflowRunId).toBeDefined();
  });

  // —— W7：routeScopeProvider 注入与缺省兼容 ——

  it('W7: routeScopeProvider members are injected into the engine spec at acceptance', async () => {
    const journal = freshJournal();
    const engine = new FakeEngine();
    const members = [
      { harnessId: 'codex', profileId: 'codex:default', profileDir: null },
      {
        harnessId: 'codex',
        profileId: '11111111-1111-4111-8111-111111111111',
        profileDir: {
          env: 'CODEX_HOME' as const,
          path: '/home/agent/.wsl-profiles/codex/11111111-1111-4111-8111-111111111111',
        },
      },
    ];
    const app = new WorkflowApplication({ journal, engine, now: () => 1_000, routeScopeProvider: () => members });
    const accepted = await app.run({ requestId: 'w7', script: 's', args: null });
    const spec = engine.specs.get(accepted.workflowRunId)!;
    // 受理时冻结：defaultHarness 为当前真实矩阵的 codex，成员按 provider 快照原样下发。
    expect(spec.routeScope).toEqual({ defaultHarness: 'codex', members });
    await completeRun(engine, accepted, 'done');

    // 续跑同样按受理时快照注入（每次受理取一次快照，run 内冻结）。
    const resumed = await app.resume({ requestId: 'w7-r', parentWorkflowRunId: accepted.workflowRunId, script: 's', args: null });
    expect(engine.specs.get(resumed.workflowRunId)!.routeScope).toEqual({ defaultHarness: 'codex', members });
    await completeRun(engine, resumed, 'done', accepted.workflowRunId);
  });

  it('W7: without routeScopeProvider the spec carries no routeScope (single-adapter semantics)', async () => {
    const { app, engine } = makeApp();
    const accepted = await app.run({ requestId: 'w7-none', script: 's', args: null });
    expect(engine.specs.get(accepted.workflowRunId)!.routeScope).toBeUndefined();
    await completeRun(engine, accepted, 'done');
  });
});

// —— W6b：lane 绑定与候选应用 ——

const BASE_TREE = 'a'.repeat(40);
const CANDIDATE_TREE = 'b'.repeat(40);
const CANDIDATE_SHA = 'c'.repeat(64);
const APP_TARGET = { workspaceId: 'w-test', projectId: 'p-test' };
const LANE_SCRIPT = "export default async function main() { return agent('x', { isolation: 'lane' }); }";

interface FakePortOptions {
  currentTree?: string;
  snapshotOk?: boolean;
  applyOk?: boolean;
  blocker?: string | null;
  leaseHeld?: boolean;
}

/** W6b 端口假实现：记录调用顺序以核对租约临界区与发布/应用事务序。 */
function makeW6b(opts: FakePortOptions = {}) {
  const journal = freshJournal();
  const engine = new FakeEngine();
  const calls: string[] = [];
  const snapshot = {
    ...APP_TARGET,
    files: [{ path: 'a.txt', mode: '100644' as const, base64: 'eA==' }],
    totalBytes: 1,
  };
  const store = {
    createBaseline: async () => {
      calls.push('baseline');
      return { baseTree: BASE_TREE };
    },
    captureCandidate: async () => {
      throw new Error('not used');
    },
    computeTree: async () => {
      calls.push('computeTree');
      return opts.currentTree ?? BASE_TREE;
    },
    materialize: async (_runId: string, _tree: string, _signal?: AbortSignal) => {
      calls.push('materialize');
      return [{ path: 'a.txt', base64: 'eA==' }];
    },
    readCandidatePatch: async () => {
      calls.push('readPatch');
      return 'diff --git a/a.txt b/a.txt';
    },
  };
  const appSource = {
    snapshot: async (target: { workspaceId: string; projectId: string }, _signal: AbortSignal) => {
      calls.push('snapshot');
      if (opts.snapshotOk === false) return { ok: false as const, target, cleanupConfirmed: true, error: 'busy:helper 在途' };
      return { ok: true as const, target, cleanupConfirmed: true as const, snapshot: { ...snapshot, ...target } };
    },
    apply: async (target: { workspaceId: string; projectId: string }, _files: AppSource['files'], _signal: AbortSignal) => {
      calls.push('apply');
      if (opts.applyOk === false) return { ok: false as const, target, cleanupConfirmed: true, error: '写入失败' };
      return { ok: true as const, target, cleanupConfirmed: true as const };
    },
  };
  const app = new WorkflowApplication({
    journal,
    engine,
    candidateStore: store,
    appResolver: () => APP_TARGET,
    appSource,
    acquireWriter: (projectId, ownerId) => {
      if (opts.leaseHeld) return null;
      calls.push(`acquire:${projectId}:${ownerId}`);
      return {
        release: () => {
          calls.push('release');
        },
      };
    },
    appBusy: () => opts.blocker ?? null,
    now: () => 7_000,
  });
  return { app, engine, journal, calls, appSource, store };
}

/** 受理绑定 lane run → 登记调用与候选 → 终态；返回可应用的状态。 */
async function boundTerminalRun(ctx: ReturnType<typeof makeW6b>): Promise<string> {
  const accepted = await ctx.app.run({ requestId: 'r1', script: LANE_SCRIPT, args: null });
  const runId = accepted.workflowRunId;
  ctx.journal.appendEvent({
    t: 'call_start',
    runId,
    callSeq: 1,
    callId: `${runId}:c1`,
    phase: null,
    label: 'lane',
    contentKey: 'lane',
    effective: { harness: 'mock' },
    promptHash: 'lane',
    isolation: 'lane',
  });
  ctx.journal.appendEvent({ t: 'attempt_start', runId, callSeq: 1, attempt: 1, isolation: 'lane' });
  await ctx.journal.publishCandidate({
    runId: accepted.workflowRunId,
    callSeq: 1,
    publication: { baseTree: BASE_TREE, afterTree: CANDIDATE_TREE, patchSha256: CANDIDATE_SHA, files: [] },
  });
  ctx.journal.appendEvent({ t: 'call_end', runId, callSeq: 1, status: 'ok', result: 'done', attempts: 1 });
  await completeRun(ctx.engine, accepted, { ok: true });
  return accepted.workflowRunId;
}

describe('WorkflowApplication W6b（lane 绑定与候选应用）', () => {
  it('lane run binds the managed App at acceptance and snapshots its source as frozen input', async () => {
    const ctx = makeW6b();
    const accepted = await ctx.app.run({ requestId: 'r1', script: LANE_SCRIPT, args: null });
    const spec = ctx.engine.specs.get(accepted.workflowRunId)!;
    // 绑定目标=受管 App；冻结输入=其实时源码快照（lane 在真实应用副本上工作）。
    expect(spec.appTarget).toEqual(APP_TARGET);
    expect(spec.input?.files).toEqual([{ path: 'a.txt', base64: 'eA==' }]);
    const row = ctx.journal.getRun(accepted.workflowRunId)!;
    expect(JSON.parse(row.appTargetJson!)).toEqual(APP_TARGET);
    expect(row.requiresApp).toBe(true);
    expect(row.writes).toBe(true);
  });

  it('lane run without a managed App is accepted unbound (kernel fails its lane calls)', async () => {
    const ctx = makeW6b();
    const app = new WorkflowApplication({
      journal: freshJournal(),
      engine: ctx.engine,
      candidateStore: {
        createBaseline: async () => ({ baseTree: BASE_TREE }),
        captureCandidate: async () => {
          throw new Error('x');
        },
      },
      now: () => 1,
    });
    const accepted = await app.run({ requestId: 'r1', script: LANE_SCRIPT, args: null });
    const spec = ctx.engine.specs.get(accepted.workflowRunId)!;
    expect(spec.appTarget).toBeUndefined();
    const row = (app as unknown as { journal: { getRun: (id: string) => { appTargetJson: string | null } } }).journal;
    expect(row.getRun(accepted.workflowRunId).appTargetJson).toBeNull();
  });

  it('applyCandidate journals the apply event and is idempotent for the same candidate tree', async () => {
    const ctx = makeW6b();
    const runId = await boundTerminalRun(ctx);
    const row = await ctx.app.applyCandidate(runId);
    expect(row.candidate?.appliedAt).toBe(7_000);
    // 事务序：受理快照 → 基线 →（apply）租约 → 快照 → 基线核对 → 物化 → 应用 → 释放。
    expect(ctx.calls).toEqual([
      'snapshot',
      'baseline',
      'acquire:p-test:workflow-apply-' + runId,
      'snapshot',
      'computeTree',
      'materialize',
      'apply',
      'release',
    ]);
    const applied = ctx.calls.indexOf('apply');
    ctx.calls.length = 0;
    // 幂等：同一候选树再次应用是 no-op——不再快照也不再调用 helper。
    const again = await ctx.app.applyCandidate(runId);
    expect(again.candidate?.appliedAt).toBe(7_000);
    expect(ctx.calls).toEqual([]);
    expect(applied).toBeGreaterThan(-1);
  });

  it('applyCandidate rejects source drift with apply_conflict and releases the lease', async () => {
    const ctx = makeW6b({ currentTree: 'd'.repeat(40) });
    const runId = await boundTerminalRun(ctx);
    await expectAppError(ctx.app.applyCandidate(runId), 'apply_conflict');
    // 冲突在 helper 调用之前——候选一字节都没写；租约仍被释放。
    expect(ctx.calls.filter((c) => c === 'apply')).toHaveLength(0);
    expect(ctx.calls.at(-1)).toBe('release');
    expect(ctx.journal.getRun(runId)!.appliedAt).toBeNull();
  });

  it('applyCandidate maps writer contention and app blockers to project_busy/app_unavailable', async () => {
    const busy = makeW6b({ leaseHeld: true });
    const runId = await boundTerminalRun(busy);
    await expectAppError(busy.app.applyCandidate(runId), 'project_busy');

    const blocked = makeW6b({ blocker: 'busy: App 正在启动' });
    const runId2 = await boundTerminalRun(blocked);
    await expectAppError(blocked.app.applyCandidate(runId2), 'project_busy');
    expect(blocked.calls.filter((c) => c.startsWith('acquire'))).toHaveLength(0);

    const gone = makeW6b({ blocker: 'unavailable: 受管 App 不存在' });
    const runId3 = await boundTerminalRun(gone);
    await expectAppError(gone.app.applyCandidate(runId3), 'app_unavailable');
  });

  it('applyCandidate surfaces helper failure as apply_failed without applied_at and releases the lease', async () => {
    const ctx = makeW6b({ applyOk: false });
    const runId = await boundTerminalRun(ctx);
    await expectAppError(ctx.app.applyCandidate(runId), 'apply_failed');
    expect(ctx.calls.at(-1)).toBe('release');
    expect(ctx.journal.getRun(runId)!.appliedAt).toBeNull();
  });

  it('applyCandidate refuses unbound runs, missing candidates and non-terminal runs', async () => {
    const ctx = makeW6b();
    // 无 lane 的 readonly run：有候选能力但无 App 绑定 → app_unavailable。
    const plain = await ctx.app.run({ requestId: 'r2', script: 's', args: null });
    await completeRun(ctx.engine, plain, { ok: 1 });
    await expectAppError(ctx.app.applyCandidate(plain.workflowRunId), 'candidate_unavailable');

    // 绑定但仍在运行的 run → run_busy。
    const ctx2 = makeW6b();
    const active = await ctx2.app.run({ requestId: 'r3', script: LANE_SCRIPT, args: null });
    await expectAppError(ctx2.app.applyCandidate(active.workflowRunId), 'run_busy');
  });

  it('workflowPatch returns the stored diff of the latest publication', async () => {
    const ctx = makeW6b();
    const runId = await boundTerminalRun(ctx);
    const result = await ctx.app.workflowPatch(runId);
    expect(result).toEqual({ runId, patchSha256: CANDIDATE_SHA, patch: 'diff --git a/a.txt b/a.txt' });
    await expectAppError(ctx.app.workflowPatch('missing'), 'run_not_found');
  });
});

it.each(['snapshot', 'apply'] as const)('shutdown aborts owned candidate %s and releases its writer before resolving', async (stage) => {
  const ctx = makeW6b();
  const runId = await boundTerminalRun(ctx);
  let entered!: () => void;
  const started = new Promise<void>((resolve) => {
    entered = resolve;
  });
  let signal!: AbortSignal;
  const held = async (target: { workspaceId: string; projectId: string }, nextSignal: AbortSignal) => {
    signal = nextSignal;
    entered();
    return new Promise<never>((_resolve, reject) =>
      nextSignal.addEventListener('abort', () => reject(new Error('source operation aborted')), { once: true }),
    );
  };
  if (stage === 'snapshot') ctx.appSource.snapshot = held;
  else ctx.appSource.apply = (target, _files, nextSignal) => held(target, nextSignal);
  const applying = ctx.app.applyCandidate(runId);
  const outcome = applying.catch((error: unknown) => error);
  await started;
  await ctx.app.shutdown();
  expect(signal.aborted).toBe(true);
  expect(await outcome).toBeInstanceOf(Error);
  expect(ctx.calls.at(-1)).toBe('release');
  expect(ctx.journal.getRun(runId)!.appliedAt).toBeNull();
});

it('shutdown during resume ancestor-object copy aborts it and never admits a child kernel', async () => {
  const ctx = makeW6b();
  const parent = await boundTerminalRun(ctx);
  let entered!: () => void;
  const copying = new Promise<void>((resolve) => {
    entered = resolve;
  });
  let signal!: AbortSignal;
  ctx.store.materialize = async (runId, _tree, nextSignal) => {
    expect(runId).toBe(parent);
    signal = nextSignal!;
    entered();
    return new Promise<never>((_resolve, reject) =>
      signal.addEventListener('abort', () => reject(new Error('copy aborted')), { once: true }),
    );
  };
  const pending = ctx.app.resume({ requestId: 'copy-child', parentWorkflowRunId: parent, script: LANE_SCRIPT, args: null });
  const result = pending.catch((error: unknown) => error);
  await copying;
  await ctx.app.shutdown();
  expect(signal.aborted).toBe(true);
  expect(await result).toBeInstanceOf(Error);
  expect(ctx.engine.specs.size).toBe(1);
  expect(ctx.journal.listRuns()).toHaveLength(1);
});

it('shutdown preserves a successful source write fact when cancellation races its receipt', async () => {
  const ctx = makeW6b();
  const runId = await boundTerminalRun(ctx);
  let entered!: () => void;
  const written = new Promise<void>((resolve) => {
    entered = resolve;
  });
  ctx.appSource.apply = async (target, _files, signal) => {
    entered();
    await new Promise<void>((resolve) => signal.addEventListener('abort', () => resolve(), { once: true }));
    return { ok: true as const, target, cleanupConfirmed: true as const };
  };
  const applying = ctx.app.applyCandidate(runId);
  await written;
  await ctx.app.shutdown();
  expect((await applying).candidate?.appliedAt).toBe(7000);
  expect(ctx.calls.at(-1)).toBe('release');
  expect(ctx.journal.listEvents(runId).filter((event) => event.t === 'apply')).toHaveLength(1);
});

it('rejects a legacy execution journal without admitting or replaying a child', async () => {
  const { app, engine, journal } = makeApp();
  try {
    const parent = await app.run({ requestId: 'legacy-parent', script: 's', args: null });
    await engine.emit(parent.workflowRunId, runEvent(parent.workflowRunId, 'completed', parent, { executionVersion: undefined }));
    engine.finish(parent.workflowRunId, { status: 'completed', result: 'old' });
    await expectAppError(
      app.resume({ requestId: 'legacy-child', parentWorkflowRunId: parent.workflowRunId, script: 's', args: null }),
      'resume_mismatch',
    );
    expect(engine.specs.size).toBe(1);
    expect(journal.listRuns()).toHaveLength(1);
    expect(journal.getRun(parent.workflowRunId)?.status).toBe('completed');
  } finally {
    for (const runId of engine.specs.keys()) engine.finish(runId, { status: 'completed', result: null });
    await app.shutdown();
    journal.close();
  }
});

it('rejects a reconciled run whose execution identity never became durable', async () => {
  const { app, engine, journal } = makeApp();
  const recovered = new WorkflowApplication({ journal, engine: new FakeEngine() });
  try {
    const parent = await app.run({ requestId: 'pre-event', script: 's', args: null });
    recovered.recoverOpenRuns();
    recovered.reconcileAsStopped(parent.workflowRunId);
    await expectAppError(
      recovered.resume({ requestId: 'pre-event-child', parentWorkflowRunId: parent.workflowRunId, script: 's', args: null }),
      'resume_mismatch',
    );
    expect(journal.listRuns()).toHaveLength(1);
  } finally {
    for (const runId of engine.specs.keys()) engine.finish(runId, { status: 'completed', result: null });
    await app.shutdown();
    await recovered.shutdown();
    journal.close();
  }
});

it('rejects an incompatible older ancestor even when the direct parent has current execution identity', async () => {
  const { app, engine, journal } = makeApp();
  try {
    const grand = await app.run({ requestId: 'legacy-grand', script: 's', args: null });
    await engine.emit(grand.workflowRunId, runEvent(grand.workflowRunId, 'completed', grand, { executionVersion: undefined }));
    engine.finish(grand.workflowRunId, { status: 'completed', result: null });
    const parent = await app.run({ requestId: 'current-parent', script: 's', args: null });
    await completeRun(engine, parent, null, grand.workflowRunId);
    await expectAppError(
      app.resume({ requestId: 'mixed-child', parentWorkflowRunId: parent.workflowRunId, script: 's', args: null }),
      'resume_mismatch',
    );
    expect(engine.specs.size).toBe(2);
    expect(journal.listRuns()).toHaveLength(2);
  } finally {
    for (const runId of engine.specs.keys()) engine.finish(runId, { status: 'completed', result: null });
    await app.shutdown();
    journal.close();
  }
});
