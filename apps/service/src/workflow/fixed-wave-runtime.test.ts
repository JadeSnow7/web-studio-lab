import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { createRun, resumeRun, type CreateRunOptions } from './kernel';
import type { CallEvent, WorkflowCall, WorkflowCallAdapter } from './call-adapter';
import { readRunJournal } from './test-helpers';
import type { JournalEvent } from './contract';

const script = (body: string) => `export const meta = {name:'fixed-wave',description:'runtime boundary'};
export default async function main() { ${body} }`;
const TARGET = { workspaceId: 'runtime-boundary', projectId: '11111111-1111-4111-8111-111111111111' };
const publication = { baseTree: 'a'.repeat(40), afterTree: 'b'.repeat(40), patchSha256: 'c'.repeat(64), files: [] };
class Adapter implements WorkflowCallAdapter {
  readonly harnessId = 'mock';
  readonly calls: WorkflowCall[] = [];
  async *run(call: WorkflowCall): AsyncIterable<CallEvent> {
    this.calls.push(call);
    yield { type: 'result', text: call.label ?? 'readonly', ...(call.isolation === 'lane' ? { candidate: { files: [] } } : {}) };
  }
}
function deferred() {
  let resolve!: () => void;
  const promise = new Promise<void>((r) => {
    resolve = r;
  });
  return { promise, resolve };
}
async function run(body: string, warm = false) {
  const adapter = new Adapter();
  const journalDir = mkdtempSync(path.join(tmpdir(), 'wsl-wave-runtime-'));
  const opts: CreateRunOptions = {
    script: script(body),
    adapter,
    journalDir,
    appTarget: TARGET,
    baseTree: publication.baseTree,
    laneWorkspace: async () => ({ baseTree: publication.baseTree, files: [] }),
    publishCandidate: async () => ({ publication }),
  };
  const first = await createRun(opts);
  await first.done;
  if (!warm) return { outcome: await first.done, events: await readRunJournal(journalDir, first.runId), adapter };
  adapter.calls.length = 0;
  const child = await resumeRun({ ...opts, parentRunId: first.runId });
  return { outcome: await child.done, events: await readRunJournal(journalDir, child.runId), adapter };
}
const starts = (events: JournalEvent[], label = 'B') => events.filter((e) => e.t === 'call_start' && e.label === label);

describe('fixed-wave runtime authority', () => {
  it.each([
    "const o={isolation:'lane',label:'B'}; return pipeline([1],()=>agent('B',o));",
    "const o={isolation:'lane',label:'B'}; const p=pipeline; return p([1],()=>agent('B',o));",
    "const o={isolation:'lane',label:'B'}; const p=parallel; return p([()=>p([()=>agent('B',o)])]);",
    "const o={isolation:'lane',label:'B'}; return parallel([async()=>{ await Promise.resolve(); return agent('B',o); }]);",
    "const o={isolation:'lane',label:'B'}; const a=parallel([()=>agent('R',{label:'R'})]); const b=parallel([()=>agent('B',o)]); return Promise.all([a,b]);",
  ])(
    'rejects design-excluded topology before a host call: %s',
    async (body) => {
      const observed = await run(body);
      expect(observed.outcome.status).toBe('completed');
      expect(JSON.stringify(observed.outcome.result)).toContain('lane_not_serializable');
      expect(starts(observed.events)).toEqual([]);
      expect(observed.adapter.calls.filter((call) => call.isolation === 'lane')).toEqual([]);
    },
    60_000,
  );

  it.each([false, true])(
    'late lane after readonly rejects before cache lookup, warm=%s',
    async (warm) => {
      const body =
        "const o={isolation:'lane',label:'B'}; return parallel([async()=>{ await agent('R',{label:'R'}); return agent('B',o); }]);";
      const observed = await run(body, warm);
      expect(JSON.stringify(observed.outcome.result)).toContain('lane_not_serializable');
      expect(starts(observed.events)).toEqual([]);
    },
    60_000,
  );

  it.each(['__hostCall', "globalThis['__host'+'Call']"])(
    'hides internal host entry %s from scripts',
    async (entry) => {
      const observed = await run(`const o={isolation:'lane',label:'B'}; return parallel([()=>${entry}('B',o,null)]);`);
      expect(observed.adapter.calls).toEqual([]);
      expect(starts(observed.events)).toEqual([]);
    },
    60_000,
  );

  it('snapshots a getter once so the guard and host dispatch consume the same isolation', async () => {
    const observed = await run(
      "let reads=0; const o={label:'B',get isolation(){ return ++reads===1?'readonly':'lane'; }}; const result=await pipeline([1],()=>agent('B',o)); return {reads,result};",
    );
    expect(observed.outcome.status).toBe('completed');
    expect(observed.outcome.result).toMatchObject({ reads: 1 });
    expect(observed.adapter.calls.map((call) => call.isolation)).toEqual(['readonly']);
  }, 60_000);

  it('uses the serialized option snapshot when toJSON changes isolation', async () => {
    const observed = await run(
      "const o={isolation:'readonly',toJSON(){ return {isolation:'lane',label:'B'}; }}; return pipeline([1],()=>agent('B',o));",
    );
    expect(JSON.stringify(observed.outcome.result)).toContain('lane_not_serializable');
    expect(starts(observed.events)).toEqual([]);
  }, 60_000);

  it('retains readonly async helpers and a later top-level lane', async () => {
    const observed = await run(
      "const o={isolation:'readonly',label:'R'}; await parallel([()=>pipeline([1],()=>agent('R',o)),async()=>{await agent('S');return agent('T');}]); return agent('B',{isolation:'lane',label:'B'});",
    );
    expect(observed.outcome.status).toBe('completed');
    expect(starts(observed.events)).toHaveLength(1);
    expect(observed.adapter.calls.filter((call) => call.isolation === 'lane')).toHaveLength(1);
  }, 60_000);

  it('rejects a later outbox lane while a prior wave publication is held, with attempts=0', async () => {
    const adapter = new Adapter();
    const entered = deferred(),
      release = deferred(),
      registered = deferred();
    const events: JournalEvent[] = [];
    const live = await createRun({
      script: script(
        "const r=agent('R',{label:'R'}); const a=agent('A',{label:'A',isolation:'lane'}); await r; const b=await agent('B',{label:'B',isolation:'lane'}); return [await a,b];",
      ),
      adapter,
      appTarget: TARGET,
      baseTree: publication.baseTree,
      journal: {
        append: async (event) => {
          events.push(event);
          if (event.t === 'call_start' && event.label === 'B') registered.resolve();
        },
      },
      laneWorkspace: async () => ({ baseTree: publication.baseTree, files: [] }),
      publishCandidate: async () => {
        entered.resolve();
        await release.promise;
        return { publication };
      },
    });
    await Promise.all([entered.promise, registered.promise]);
    try {
      await new Promise<void>((resolve) => setImmediate(resolve));
      expect(events.find((e) => e.t === 'call_end' && e.callSeq === 3)).toMatchObject({
        status: 'failed',
        code: 'unsupported_option',
        attempts: 0,
      });
      expect(adapter.calls.some((call) => call.label === 'B')).toBe(false);
    } finally {
      release.resolve();
      await live.done;
    }
  }, 60_000);
});
