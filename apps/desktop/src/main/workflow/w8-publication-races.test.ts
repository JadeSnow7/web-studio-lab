import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { WorkflowInputFile, WorkflowJournalEvent } from '@wsl/protocol';
import type { WorkflowEnginePort, WorkflowEngineRunHandle, WorkflowEngineRunSpec } from './engine-port';
import { WorkflowApplication } from './application';
import { SqliteWorkflowJournal } from './journal-sqlite';
import { RunSourceRepository } from '../workbench/run-source-repository';
import { WorkflowEngine } from '../../../../service/src/workflow/engine';
import type { CallEvent, WorkflowCall, WorkflowCallAdapter } from '../../../../service/src/workflow/call-adapter';

const TARGET = { workspaceId: 'wave-races', projectId: '11111111-1111-4111-8111-111111111111' };
const TWO = `export const meta = { name: 'wave', description: 'registered together' };
export default async function main() {
  return parallel([
    () => agent('A', { label: 'A', isolation: 'lane' }),
    () => agent('B', { label: 'B', isolation: 'lane' }),
  ]);
}`;
const ONE = `export const meta = { name: 'one', description: 'publication gate' };
export default async function main() { return agent('A', { label: 'A', isolation: 'lane' }); }`;
const files = (entries: Record<string, string>): WorkflowInputFile[] =>
  Object.entries(entries).map(([name, text]) => ({ path: name, base64: Buffer.from(text).toString('base64') }));
const BASE = files({ 'base.txt': 'base\n' });
function deferred() {
  let resolve!: () => void;
  const promise = new Promise<void>((r) => {
    resolve = r;
  });
  return { promise, resolve };
}
class Writer implements WorkflowCallAdapter {
  readonly harnessId = 'mock';
  readonly calls: WorkflowCall[] = [];
  constructor(private readonly overlap: boolean) {}
  async *run(call: WorkflowCall): AsyncIterable<CallEvent> {
    this.calls.push(call);
    const entries = new Map((call.laneInput ?? []).map((f) => [f.path, f.base64]));
    entries.set(this.overlap ? 'shared.txt' : `${call.label}.txt`, Buffer.from(`${call.label}\n`).toString('base64'));
    yield { type: 'result', text: call.label ?? '', candidate: { files: [...entries].map(([name, base64]) => ({ path: name, base64 })) } };
  }
}
const journals: SqliteWorkflowJournal[] = [];
afterEach(() => {
  vi.useRealTimers();
  for (const j of journals.splice(0)) j.close();
});
function context(
  overlap = false,
  publicationGate?: { entered: ReturnType<typeof deferred>; release: ReturnType<typeof deferred>; reject: boolean },
  options?: {
    writer?: Writer;
    startGate?: { entered: ReturnType<typeof deferred>; release: ReturnType<typeof deferred>; seq: number };
    failAttemptEnd?: { entered: ReturnType<typeof deferred>; seq: number };
  },
) {
  const dir = mkdtempSync(path.join(tmpdir(), 'wsl-w8-real-race-'));
  const journal = new SqliteWorkflowJournal(path.join(dir, 'journal.db'));
  journals.push(journal);
  const repository = new RunSourceRepository(path.join(dir, 'runs'));
  const writer = options?.writer ?? new Writer(overlap);
  const real = new WorkflowEngine({ adapter: writer });
  const handles = new Map<string, WorkflowEngineRunHandle>();
  const engine: WorkflowEnginePort = {
    shutdown: async () => {},
    async run(spec) {
      const handle = await real.run({
        ...spec,
        journal: async (event) => {
          if (options?.startGate && spec.parentRunId !== undefined && event.t === 'call_start' && event.callSeq === options.startGate.seq) {
            options.startGate.entered.resolve();
            await options.startGate.release.promise;
          }
          if (options?.failAttemptEnd && event.t === 'attempt_end' && event.callSeq === options.failAttemptEnd.seq) {
            options.failAttemptEnd.entered.resolve();
            throw new Error('controlled journal failure while lane publication is active');
          }
          await spec.journal(event);
        },
        publishCandidate: async (seq, candidate) => {
          if (publicationGate) {
            publicationGate.entered.resolve();
            await publicationGate.release.promise;
            if (publicationGate.reject) throw new Error('publication rejected at deterministic gate');
          }
          return app.publishCandidate(spec.runId, seq, candidate.files);
        },
        laneWorkspace: (seq) => app.laneWorkspace(spec.runId, seq),
      });
      handles.set(spec.runId, handle);
      return handle;
    },
  };
  const app = new WorkflowApplication({
    journal,
    engine,
    candidateStore: repository,
    appResolver: () => TARGET,
    appSource: {
      snapshot: async (target) => ({
        ok: true,
        cleanupConfirmed: true,
        snapshot: { ...target, files: BASE.map((f) => ({ ...f, mode: '100644' as const })), totalBytes: 5 },
      }),
      apply: async (target) => ({ ok: true, target, cleanupConfirmed: true }),
    },
  });
  return { journal, repository, writer, handles, app };
}
async function settled(ctx: ReturnType<typeof context>, id: string) {
  return ctx.handles.get(id)!.done;
}
function events(ctx: ReturnType<typeof context>, id: string) {
  return ctx.journal.listEvents(id);
}
function starts(ctx: ReturnType<typeof context>, id: string) {
  return events(ctx, id).filter((e): e is Extract<WorkflowJournalEvent, { t: 'call_start' }> => e.t === 'call_start');
}

describe('W8 actual Kernel → Main SQLite → Git publication races', () => {
  it.each([false, true])(
    'cold and cached wave freeze identical bases, overlap=%s',
    async (overlap) => {
      const ctx = context(overlap);
      const parent = await ctx.app.run({ requestId: 'cold', script: TWO });
      expect((await settled(ctx, parent.workflowRunId)).status).toBe('completed');
      const parentRow = ctx.journal.getRun(parent.workflowRunId)!;
      const child = await ctx.app.resume({ requestId: 'warm', parentWorkflowRunId: parent.workflowRunId, script: TWO });
      expect((await settled(ctx, child.workflowRunId)).status).toBe('completed');
      const id = child.workflowRunId;
      expect(starts(ctx, id).map((e) => ctx.journal.callBaseTree(id, e.callSeq))).toEqual([parentRow.baseTree, parentRow.baseTree]);
      expect(ctx.journal.getRun(id)!.candidateTree).toBe(parentRow.candidateTree);
      const calls = ctx.journal.listCalls(id);
      expect(calls.map((c) => c.status)).toEqual(overlap ? ['cached', 'conflict'] : ['cached', 'cached']);
      if (overlap) expect(ctx.writer.calls.at(-1)?.laneInput).toEqual(BASE);
      const ledger = events(ctx, id);
      const lastStart = Math.max(...ledger.map((e, i) => (e.t === 'call_start' ? i : -1)));
      const firstEnd = ledger.findIndex((e) => e.t === 'call_end');
      expect(lastStart).toBeLessThan(firstEnd);
    },
    60_000,
  );

  it.each([false, true])(
    'stop awaits an active publisher before terminal run, reject=%s',
    async (reject) => {
      const gate = { entered: deferred(), release: deferred(), reject };
      const ctx = context(false, gate);
      const accepted = await ctx.app.run({ requestId: 'gated', script: ONE });
      const id = accepted.workflowRunId;
      await gate.entered.promise;
      let stopped = false;
      const stop = ctx.app.stop(id).then(() => {
        stopped = true;
      });
      try {
        // An event-loop checkpoint lets the dispatch promise's finally finish; no timer advances the publication gate.
        await new Promise<void>((resolve) => setImmediate(resolve));
        expect(events(ctx, id).filter((e) => e.t === 'call_end')).toEqual([]);
        expect(stopped).toBe(false);
      } finally {
        gate.release.resolve();
        await stop;
      }
      const ledger = events(ctx, id);
      expect(ledger.at(-1)).toMatchObject({ t: 'run', status: 'stopped' });
      expect(ledger.filter((e) => e.t === 'call_end')).toHaveLength(1);
      expect(ledger.find((e) => e.t === 'call_end')).toMatchObject({ status: reject ? 'failed' : 'ok' });
      const row = ctx.journal.getRun(id)!;
      expect(row.candidateTree === row.baseTree).toBe(reject);
      const pointer = row.candidateTree;
      await new Promise<void>((resolve) => setImmediate(resolve));
      expect(ctx.journal.getRun(id)!.candidateTree).toBe(pointer);
    },
    60_000,
  );

  it.each(['capture', 'merge'] as const)(
    'Main rejects publication after terminal state while %s is held',
    async (phase) => {
      const dir = mkdtempSync(path.join(tmpdir(), 'wsl-w8-main-terminal-'));
      const journal = new SqliteWorkflowJournal(path.join(dir, 'journal.db'));
      journals.push(journal);
      const real = new RunSourceRepository(path.join(dir, 'runs'));
      const entered = deferred(),
        release = deferred();
      const capture = real.captureCandidate.bind(real),
        merge = real.mergeCandidate.bind(real);
      const store = Object.assign(Object.create(real), {
        captureCandidate: async (...args: Parameters<typeof capture>) => {
          if (phase === 'capture') {
            entered.resolve();
            await release.promise;
          }
          return capture(...args);
        },
        mergeCandidate: async (...args: Parameters<typeof merge>) => {
          if (phase === 'merge') {
            entered.resolve();
            await release.promise;
          }
          return merge(...args);
        },
      });
      let spec!: WorkflowEngineRunSpec;
      const app = new WorkflowApplication({
        journal,
        candidateStore: store,
        engine: {
          shutdown: async () => {},
          run: (s) => {
            spec = s;
            return { done: new Promise(() => {}), stop: async () => {} };
          },
        },
        appResolver: () => TARGET,
        appSource: {
          snapshot: async (target) => ({
            ok: true,
            cleanupConfirmed: true,
            snapshot: { ...target, files: BASE.map((f) => ({ ...f, mode: '100644' as const })), totalBytes: 5 },
          }),
          apply: async (target) => ({ ok: true, target, cleanupConfirmed: true }),
        },
      });
      const accepted = await app.run({ requestId: `late-${phase}`, script: ONE });
      const id = accepted.workflowRunId;
      await spec.journal({
        t: 'call_start',
        runId: id,
        callSeq: 1,
        callId: `${id}:c1`,
        phase: null,
        label: 'A',
        contentKey: 'key',
        effective: { harness: 'mock' },
        promptHash: 'prompt',
        isolation: 'lane',
      });
      await spec.journal({ t: 'attempt_start', runId: id, callSeq: 1, attempt: 1, isolation: 'lane' });
      const pointer = journal.getRun(id)!.candidateTree;
      const pending = app.publishCandidate(id, 1, files({ 'A.txt': 'A\n' }));
      await entered.promise;
      journal.updateRunStatus(id, { status: 'stopped' });
      release.resolve();
      await expect(pending).rejects.toMatchObject({ code: 'internal_error' });
      expect(journal.getRun(id)!.candidateTree).toBe(pointer);
    },
    60_000,
  );
  it('cached readonly results cannot deliver or publish across a held final registration ack', async () => {
    const script = `export const meta = {name:'mixed',description:'cached readonly gate'};
export default async function main() { return parallel([
  () => agent('R', {label:'R'}),
  () => agent('A', {label:'A',isolation:'lane'}),
  () => agent('S', {label:'S'}),
  () => agent('B', {label:'B',isolation:'lane'}),
]); }`;
    const gate = { entered: deferred(), release: deferred(), seq: 4 };
    const ctx = context(false, undefined, { startGate: gate });
    const cold = await ctx.app.run({ requestId: 'mixed-cold', script });
    await settled(ctx, cold.workflowRunId);
    const warm = await ctx.app.resume({ requestId: 'mixed-warm', parentWorkflowRunId: cold.workflowRunId, script });
    await gate.entered.promise;
    try {
      const ledger = events(ctx, warm.workflowRunId);
      expect(
        ledger.filter((e) => e.t === 'deliver' || e.t === 'attempt_start' || (e.t === 'call_end' && e.publication !== undefined)),
      ).toEqual([]);
      expect(ctx.journal.getRun(warm.workflowRunId)!.candidateTree).toBe(ctx.journal.getRun(warm.workflowRunId)!.baseTree);
    } finally {
      gate.release.resolve();
      await settled(ctx, warm.workflowRunId);
    }
    expect(ctx.journal.listCalls(warm.workflowRunId).map((c) => c.status)).toEqual(['cached', 'cached', 'cached', 'cached']);
  }, 60_000);

  it('sequential waves freeze the previously published tree under cold and cached execution', async () => {
    const script = `export const meta = {name:'two-waves',description:'later baseline'};
export default async function main() {
 await parallel([() => agent('A',{label:'A',isolation:'lane'}), () => agent('B',{label:'B',isolation:'lane'})]);
 return parallel([() => agent('C',{label:'C',isolation:'lane'}), () => agent('D',{label:'D',isolation:'lane'})]);
}`;
    const ctx = context();
    const cold = await ctx.app.run({ requestId: 'two-cold', script });
    await settled(ctx, cold.workflowRunId);
    const warm = await ctx.app.resume({ requestId: 'two-warm', parentWorkflowRunId: cold.workflowRunId, script });
    await settled(ctx, warm.workflowRunId);
    for (const id of [cold.workflowRunId, warm.workflowRunId]) {
      const row = ctx.journal.getRun(id)!;
      const second = events(ctx, id).find(
        (e): e is Extract<WorkflowJournalEvent, { t: 'call_end' }> => e.t === 'call_end' && e.callSeq === 2,
      )!;
      expect([1, 2, 3, 4].map((n) => ctx.journal.callBaseTree(id, n))).toEqual([
        row.baseTree,
        row.baseTree,
        second.publication!.afterTree,
        second.publication!.afterTree,
      ]);
    }
    expect(ctx.journal.getRun(warm.workflowRunId)!.candidateTree).toBe(ctx.journal.getRun(cold.workflowRunId)!.candidateTree);
  }, 60_000);

  it('a second-generation partial resume imports trees from their original successful owners', async () => {
    class RoutedWriter extends Writer {
      profileB = '22222222-2222-4222-8222-222222222222';
      private routeSeq = 0;
      resolveRoute() {
        const profileId = ++this.routeSeq % 2 ? '11111111-1111-4111-8111-111111111111' : this.profileB;
        return { harnessId: 'mock', profileId, provenance: 'auto' as const };
      }
    }
    const writer = new RoutedWriter(false);
    const ctx = context(false, undefined, { writer });
    const original = await ctx.app.run({ requestId: 'owner-original', script: TWO });
    await settled(ctx, original.workflowRunId);
    const middle = await ctx.app.resume({ requestId: 'owner-middle', parentWorkflowRunId: original.workflowRunId, script: TWO });
    await settled(ctx, middle.workflowRunId);
    expect(ctx.journal.listCalls(middle.workflowRunId).map((c) => c.status)).toEqual(['cached', 'cached']);
    writer.profileB = '33333333-3333-4333-8333-333333333333';
    const reads = vi.spyOn(ctx.repository, 'materialize');
    const last = await ctx.app.resume({ requestId: 'owner-last', parentWorkflowRunId: middle.workflowRunId, script: TWO });
    await settled(ctx, last.workflowRunId);
    expect(ctx.journal.listCalls(last.workflowRunId).map((c) => c.status)).toEqual(['cached', 'ok']);
    expect(reads.mock.calls.some(([owner]) => owner === original.workflowRunId)).toBe(true);
    expect(reads.mock.calls.some(([owner]) => owner === middle.workflowRunId)).toBe(false);
    expect(ctx.journal.getRun(last.workflowRunId)!.candidateTree).toBe(ctx.journal.getRun(original.workflowRunId)!.candidateTree);
  }, 60_000);

  it('missing ancestor candidate objects reject resume without guessing another owner or starting a kernel', async () => {
    const ctx = context();
    const original = await ctx.app.run({ requestId: 'missing-original', script: TWO });
    await settled(ctx, original.workflowRunId);
    const read = ctx.repository.materialize.bind(ctx.repository);
    const reads = vi.spyOn(ctx.repository, 'materialize').mockImplementation(async (owner, ...args) => {
      if (owner === original.workflowRunId) throw new Error('ancestor candidate object missing');
      return read(owner, ...args);
    });
    await expect(ctx.app.resume({ requestId: 'missing-child', parentWorkflowRunId: original.workflowRunId, script: TWO })).rejects.toThrow(
      'ancestor candidate object missing',
    );
    expect(reads.mock.calls).toHaveLength(1);
    expect(ctx.handles.size).toBe(1);
  }, 60_000);
  it.each(['failure', 'deadline'] as const)(
    '%s waits for held publication before the final event',
    async (kind) => {
      const publicationGate = { entered: deferred(), release: deferred(), reject: false };
      const readonlyRelease = deferred(),
        failureEntered = deferred();
      class HeldReadonly extends Writer {
        override async *run(call: WorkflowCall): AsyncIterable<CallEvent> {
          if (call.label !== 'R') {
            yield* super.run(call);
            return;
          }
          this.calls.push(call);
          await readonlyRelease.promise;
          yield { type: 'result', text: 'R' };
        }
      }
      if (kind === 'deadline') vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });
      const ctx = context(
        false,
        publicationGate,
        kind === 'failure' ? { writer: new HeldReadonly(false), failAttemptEnd: { entered: failureEntered, seq: 1 } } : undefined,
      );
      const body =
        kind === 'failure'
          ? `export const meta={name:'failure-gate',description:'two active owners'};
export default async function main(){ const r=agent('R',{label:'R'}); const a=agent('A',{label:'A',isolation:'lane'}); return [await r,await a]; }`
          : ONE;
      const accepted = await ctx.app.run({ requestId: kind, script: body, ...(kind === 'deadline' ? { deadlineMs: 10 } : {}) });
      const id = accepted.workflowRunId;
      const laneSeq = kind === 'failure' ? 2 : 1;
      await publicationGate.entered.promise;
      if (kind === 'failure') {
        readonlyRelease.resolve();
        await failureEntered.promise;
      } else await vi.advanceTimersByTimeAsync(10);
      let done = false;
      const completion = settled(ctx, id).then((outcome) => {
        done = true;
        return outcome;
      });
      try {
        await new Promise<void>((resolve) => setImmediate(resolve));
        expect(events(ctx, id).filter((e) => e.t === 'call_end' && e.callSeq === laneSeq)).toEqual([]);
        expect(done).toBe(false);
      } finally {
        publicationGate.release.resolve();
        await completion;
      }
      expect(await completion).toMatchObject({
        status: 'failed',
        failureCode: kind === 'failure' ? 'internal_error' : 'run_deadline_exceeded',
      });
      const ledger = events(ctx, id);
      expect(ledger.at(-1)).toMatchObject({ t: 'run', status: 'failed' });
      expect(ledger.filter((e) => e.t === 'call_end' && e.callSeq === laneSeq)).toHaveLength(1);
      const pointer = ctx.journal.getRun(id)!.candidateTree;
      await new Promise<void>((resolve) => setImmediate(resolve));
      expect(ctx.journal.getRun(id)!.candidateTree).toBe(pointer);
    },
    60_000,
  );
});
