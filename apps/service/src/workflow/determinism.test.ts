import { describe, expect, it } from 'vitest';
import { createRun } from './kernel';
import { MockHarness } from './mock-harness';
import { callsView, freshJournalDir, loadFixture, readRunJournal, type ExpectedFile } from './test-helpers';

// E1 子集：同一脚本+args+计划的多次运行，callSeq→contentKey→status→result 序列必须逐字节一致。
const CASES = ['seq-two-calls', 'parallel-collect', 'pipeline-ok'] as const;
const ROUNDS = 10;

async function runOnce(expected: ExpectedFile, script: string) {
  const journalDir = freshJournalDir();
  const mock = new MockHarness(expected.mock);
  const run = await createRun({ script, args: expected.args ?? null, journalDir, adapter: mock });
  const outcome = await run.done;
  const events = await readRunJournal(journalDir, run.runId);
  const calls = callsView(events).map((c) => ({
    seq: c.seq,
    label: c.label,
    contentKey: c.contentKey,
    status: c.status,
    code: c.code ?? null,
    result: c.result ?? null,
  }));
  return { outcome, calls };
}

describe('determinism (E1 subset)', () => {
  for (const name of CASES) {
    it(`${name} x${ROUNDS}`, async () => {
      const { script, expected } = await loadFixture(name);
      const baseline = await runOnce(expected, script);
      for (let i = 0; i < ROUNDS - 1; i++) {
        const current = await runOnce(expected, script);
        expect(current.outcome.status).toBe(baseline.outcome.status);
        expect(current.outcome.result).toEqual(baseline.outcome.result);
        expect(current.calls).toEqual(baseline.calls);
      }
      expect(baseline.outcome.status).toBe(expected.expect.status);
    }, 60_000);
  }
});
