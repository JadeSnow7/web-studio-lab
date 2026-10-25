import { readFile } from 'node:fs/promises';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import type { JournalEvent } from './contract';
import { JsonlJournal, readJournal } from './journal-jsonl';
import type { MockPlan } from './mock-harness';

export const FIXTURES = path.resolve(fileURLToPath(new URL('.', import.meta.url)), '../../../../fixtures/workflow');

export interface ExpectedFile {
  script: string;
  args: unknown;
  mock: MockPlan;
  expect: {
    status: 'completed' | 'failed' | 'stopped';
    failureCode?: string;
    phases?: string[];
    calls?: { seq: number; label: string; status: string; code?: string; attempts?: number; phase?: string }[];
    callsSummary?: { total: number; ok: number; last: { seq: number; label: string; status: string; code?: string } };
    result: unknown;
  };
}

export async function loadFixture(name: string): Promise<{ script: string; expected: ExpectedFile }> {
  const expected = JSON.parse(await readFile(path.join(FIXTURES, 'expected', `${name}.json`), 'utf8')) as ExpectedFile;
  const script = await readFile(path.join(FIXTURES, 'scripts', expected.script), 'utf8');
  return { script, expected };
}

export function freshJournalDir(): string {
  return mkdtempSync(path.join(tmpdir(), 'wsl-wf-journal-'));
}

export async function readRunJournal(dir: string, runId: string): Promise<JournalEvent[]> {
  return readJournal(JsonlJournal.filePath(dir, runId));
}

/** 从 journal 提取 callSeq → label/status/code/attempts/phase 的断言视图。 */
export function callsView(events: JournalEvent[]) {
  const starts = new Map<number, Extract<JournalEvent, { t: 'call_start' }>>();
  const ends = new Map<number, Extract<JournalEvent, { t: 'call_end' }>>();
  const attemptCount = new Map<number, number>();
  for (const e of events) {
    if (e.t === 'call_start') starts.set(e.callSeq, e);
    if (e.t === 'call_end') ends.set(e.callSeq, e);
    if (e.t === 'attempt_start') attemptCount.set(e.callSeq, (attemptCount.get(e.callSeq) ?? 0) + 1);
  }
  return [...starts.keys()]
    .sort((a, b) => a - b)
    .map((seq) => {
      const start = starts.get(seq)!;
      const end = ends.get(seq)!;
      return {
        seq,
        label: start.label,
        phase: start.phase,
        status: end?.status,
        code: end?.code,
        attempts: attemptCount.get(seq) ?? 0,
        contentKey: start.contentKey,
        result: end?.result,
      };
    });
}
