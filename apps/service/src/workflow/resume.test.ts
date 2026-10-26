import { describe, expect, it } from 'vitest';
import { createRun, resumeRun } from './kernel';
import { MockHarness } from './mock-harness';
import { RoutedAdapterPool } from './routed-pool';
import { callsView, freshJournalDir, loadFixture, readRunJournal } from './test-helpers';
import { readdirSync, writeFileSync } from 'node:fs';
import { canonical, contentKey, DSL_VERSION, sha256Hex } from './contract';
import { JsonlJournal } from './journal-jsonl';

// E3 只读子集：pipeline-ok 在 seq3 的 call_end 落盘后、seq4 派发前停止；
// 续跑须命中 seq1–3 缓存（不重派），seq4–6 正常执行，result 与无中断运行深度相等。
describe('resume (E3 readonly subset)', () => {
  it('stop after seq3 then resume hits cache for 1-3 and dispatches 4-6', async () => {
    const { script, expected } = await loadFixture('pipeline-ok');
    const journalDir = freshJournalDir();

    const parentMock = new MockHarness(expected.mock);
    const parent = await createRun({ script, args: null, journalDir, adapter: parentMock, stopAfterCalls: 3 });
    const stopped = await parent.done;
    expect(stopped.status).toBe('stopped');
    expect(parentMock.dispatchCount).toBe(3);

    const parentEvents = await readRunJournal(journalDir, parent.runId);
    const parentCalls = callsView(parentEvents);
    expect(parentCalls.map((c) => c.status).slice(0, 3)).toEqual(['ok', 'ok', 'ok']);
    for (const c of parentCalls.slice(3)) expect(['stopped']).toContain(c.status);

    const childMock = new MockHarness(expected.mock);
    const child = await resumeRun({ script, args: null, journalDir, adapter: childMock, parentRunId: parent.runId });
    const outcome = await child.done;
    expect(outcome.status).toBe('completed');
    expect(childMock.dispatchCount).toBe(3);
    expect(childMock.dispatchedLabels).toEqual(['s2-a', 's2-b', 's2-c']);

    const childEvents = await readRunJournal(journalDir, child.runId);
    const childCalls = callsView(childEvents);
    expect(childCalls.length).toBe(6);
    for (const c of childCalls.slice(0, 3)) {
      expect(c.status).toBe('cached');
    }
    const cachedEnds = childEvents.filter((e): e is Extract<typeof e, { t: 'call_end' }> => e.t === 'call_end' && e.status === 'cached');
    expect(cachedEnds.length).toBe(3);
    for (const e of cachedEnds) expect(e.cachedFromRunId).toBe(parent.runId);
    for (const c of childCalls.slice(3)) expect(c.status).toBe('ok');

    // 与无中断运行的 result 深度相等
    const cleanDir = freshJournalDir();
    const clean = await createRun({ script, args: null, journalDir: cleanDir, adapter: new MockHarness(expected.mock) });
    const cleanOutcome = await clean.done;
    expect(outcome.result).toEqual(cleanOutcome.result);
    expect(outcome.result).toEqual(expected.expect.result);
  }, 60_000);

  it('resume_mismatch on changed script', async () => {
    const { script, expected } = await loadFixture('seq-two-calls');
    const journalDir = freshJournalDir();
    const parent = await createRun({ script, args: null, journalDir, adapter: new MockHarness(expected.mock) });
    await parent.done;

    const changed = script.replace('诊断', '诊断X');
    await expect(
      resumeRun({ script: changed, args: null, journalDir, adapter: new MockHarness(expected.mock), parentRunId: parent.runId }),
    ).rejects.toMatchObject({ name: 'WorkflowContractError', code: 'resume_mismatch' });
    // 不产生新 journal 文件
    expect(readdirSync(journalDir).length).toBe(1);
  }, 30_000);

  // W7/E4：路由解析冻结进 contentKey——同范围续跑照常命中缓存（解析结果一致 → 同键），
  // 证明多 Profile 身份不改变既有缓存收益语义。
  it('W7: resume with identical routeScope hits the ancestor cache (resolved profile preserved)', async () => {
    const script = `export const meta = { name: 'w7r', description: 'd' };
export default async function main() {
  const a = await agent('缓存提示词', { label: 'rc', harness: 'ha' });
  return a.status;
}`;
    const journalDir = freshJournalDir();
    const profileId = 'ha:default';
    const scope = { defaultHarness: 'ha', members: [{ harnessId: 'ha', profileId }] };
    const makePool = (mock: MockHarness) =>
      new RoutedAdapterPool({
        defaultHarness: 'ha',
        members: [{ harnessId: 'ha', profileId, profileDir: null, adapter: mock }],
      });
    const parentMock = new MockHarness({ fallback: [{ text: 'ok' }] }, { harnessId: 'ha' });
    const parent = await createRun({ script, args: null, journalDir, adapter: makePool(parentMock), routeScope: scope });
    expect((await parent.done).status).toBe('completed');
    expect(parentMock.dispatchCount).toBe(1);

    const childMock = new MockHarness({ fallback: [{ text: 'ok' }] }, { harnessId: 'ha' });
    const child = await resumeRun({
      script,
      args: null,
      journalDir,
      adapter: makePool(childMock),
      routeScope: scope,
      parentRunId: parent.runId,
    });
    expect((await child.done).status).toBe('completed');
    // 解析结果一致 → 同一 contentKey → 命中，不重复派发。
    expect(childMock.dispatchCount).toBe(0);
    const childCalls = callsView(await readRunJournal(journalDir, child.runId));
    expect(childCalls[0]!.status).toBe('cached');
    expect(childCalls[0]!.contentKey).toBe(callsView(await readRunJournal(journalDir, parent.runId))[0]!.contentKey);
  }, 30_000);

  it('resume_mismatch on changed args', async () => {
    const { script, expected } = await loadFixture('args-echo');
    const journalDir = freshJournalDir();
    const parent = await createRun({ script, args: expected.args, journalDir, adapter: new MockHarness(expected.mock) });
    await parent.done;
    await expect(
      resumeRun({
        script,
        args: { topic: '不同' },
        journalDir,
        adapter: new MockHarness(expected.mock),
        parentRunId: parent.runId,
      }),
    ).rejects.toMatchObject({ name: 'WorkflowContractError', code: 'resume_mismatch' });
    expect(readdirSync(journalDir).length).toBe(1);
  }, 30_000);
});

describe('W9 execution semantics compatibility', () => {
  it('separates tier/model execution from the legacy metadata-only cache key', () => {
    const input = { prompt: 'p', effective: { harness: 'mock', model: 'm', tier: 'big' }, schema: undefined, label: 'l', tools: [] };
    const legacy = sha256Hex(canonical({ ...input, isolation: 'readonly', dslVersion: DSL_VERSION }));
    expect(contentKey(input)).not.toBe(legacy);
  });

  for (const version of [undefined, 'unknown-execution/9']) {
    it(`rejects ${version ?? 'legacy'} execution semantics before creating a child or dispatching`, async () => {
      const script = `export const meta = { name: 'compat', description: 'd' };
export default async function main() { return await agent('p', { label: 'l', tier: 'big' }); }`;
      const journalDir = freshJournalDir();
      const parentAdapter = new MockHarness({ l: [{ text: 'old-result' }] });
      const parent = await createRun({ script, args: null, journalDir, adapter: parentAdapter });
      expect(await parent.done).toMatchObject({ status: 'completed', result: { status: 'ok', value: 'old-result' } });
      expect(parentAdapter.dispatchCount).toBe(1);
      const parentEvents = await readRunJournal(journalDir, parent.runId);
      expect(callsView(parentEvents)).toMatchObject([{ seq: 1, label: 'l', status: 'ok', attempts: 1 }]);
      const file = JsonlJournal.filePath(journalDir, parent.runId);
      const events = parentEvents.map((e) => (e.t === 'run' ? { ...e, executionVersion: version } : e));
      writeFileSync(file, events.map((e) => JSON.stringify(e)).join('\n') + '\n');
      const before = readdirSync(journalDir);
      const adapter = new MockHarness({ l: [{ text: 'new-result' }] });
      const receipt = await resumeRun({ script, args: null, journalDir, parentRunId: parent.runId, adapter }).then(
        async (child) => {
          await child.done;
          return { accepted: true };
        },
        (error: unknown) => ({ error }),
      );
      expect(receipt).toMatchObject({ error: { code: 'resume_mismatch' } });
      expect(adapter.dispatchCount).toBe(0);
      expect(readdirSync(journalDir)).toEqual(before);
    });
  }
});
