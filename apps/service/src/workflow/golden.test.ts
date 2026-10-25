import { describe, expect, it } from 'vitest';
import { createRun } from './kernel';
import { MockHarness } from './mock-harness';
import { callsView, freshJournalDir, loadFixture, readRunJournal } from './test-helpers';
import { readdir } from 'node:fs/promises';
import path from 'node:path';
import { FIXTURES } from './test-helpers';

const names = (await readdir(path.join(FIXTURES, 'expected')))
  .filter((f) => f.endsWith('.json'))
  .map((f) => f.replace(/\.json$/, ''))
  .sort();

describe('workflow golden fixtures', () => {
  for (const name of names) {
    it(
      name,
      async () => {
        const { script, expected } = await loadFixture(name);
        const journalDir = freshJournalDir();
        const mock = new MockHarness(expected.mock);
        const run = await createRun({ script, args: expected.args ?? null, journalDir, adapter: mock });
        const outcome = await run.done;

        expect(outcome.status).toBe(expected.expect.status);
        if (expected.expect.failureCode !== undefined) expect(outcome.failureCode).toBe(expected.expect.failureCode);
        expect(outcome.result ?? null).toEqual(expected.expect.result ?? null);

        const events = await readRunJournal(journalDir, run.runId);
        const calls = callsView(events);
        if (expected.expect.calls) {
          expect(calls.map((c) => ({ seq: c.seq, label: c.label, status: c.status }))).toEqual(
            expected.expect.calls.map((c) => ({ seq: c.seq, label: c.label, status: c.status })),
          );
          for (const want of expected.expect.calls) {
            const got = calls.find((c) => c.seq === want.seq)!;
            if (want.code !== undefined) expect(got.code).toBe(want.code);
            if (want.attempts !== undefined) expect(got.attempts).toBe(want.attempts);
            if (want.phase !== undefined) expect(got.phase).toBe(want.phase);
          }
        }
        if (expected.expect.callsSummary) {
          const summary = expected.expect.callsSummary;
          expect(calls.length).toBe(summary.total);
          expect(calls.filter((c) => c.status === 'ok').length).toBe(summary.ok);
          const last = calls[calls.length - 1]!;
          expect(last.seq).toBe(summary.last.seq);
          expect(last.label).toBe(summary.last.label);
          expect(last.status).toBe(summary.last.status);
          if (summary.last.code !== undefined) expect(last.code).toBe(summary.last.code);
        }
        if (expected.expect.phases) {
          expect(events.filter((e) => e.t === 'phase').map((e) => (e as { title: string }).title)).toEqual(expected.expect.phases);
        }
      },
      name === 'call-budget' ? 120_000 : 30_000,
    );
  }
});
