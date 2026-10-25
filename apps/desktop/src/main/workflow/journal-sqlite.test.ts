import { DatabaseSync } from 'node:sqlite';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import type { WorkflowJournalEvent } from '@wsl/protocol';
import { SqliteWorkflowJournal } from './journal-sqlite';

function freshDbPath(): string {
  return path.join(mkdtempSync(path.join(tmpdir(), 'wsl-wf-sqlite-')), 'journal.db');
}

const RUN_EVENT_BASE = {
  scriptHash: 'sh',
  argsHash: 'ah',
  dslVersion: 'lab-workflow/1',
};

function insertRun(journal: SqliteWorkflowJournal, runId: string, requestId: string | null = null, parentRunId: string | null = null) {
  journal.insertRun({
    runId,
    requestId,
    parentRunId,
    scriptHash: 'sh',
    argsHash: 'ah',
    dslVersion: 'lab-workflow/1',
    status: 'running',
    engine: 'kernel',
  });
}

describe('SqliteWorkflowJournal', () => {
  it('creates schema version 4 on a fresh file', () => {
    const file = freshDbPath();
    const journal = new SqliteWorkflowJournal(file);
    journal.close();
    const db = new DatabaseSync(file);
    expect(Number(db.prepare('PRAGMA user_version').get()?.['user_version'])).toBe(4);
    for (const table of ['runs', 'calls', 'attempts', 'events', 'publications']) {
      expect(db.prepare("SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = ?").get(table)).toBeDefined();
    }
    // W6b：runs 的绑定元数据列在 v3 出现。
    const columns = db
      .prepare('PRAGMA table_info(runs)')
      .all()
      .map((row) => String(row['name']));
    for (const column of ['requires_app', 'writes', 'app_target_json', 'applied_at', 'base_tree', 'candidate_tree']) {
      expect(columns).toContain(column);
    }
    db.close();
  });

  it('rejects files with a newer schema version and preserves them', () => {
    const file = freshDbPath();
    const db = new DatabaseSync(file);
    db.exec('PRAGMA user_version = 4');
    db.close();
    try {
      new SqliteWorkflowJournal(file);
      expect.unreachable('newer schema must be rejected');
    } catch (error) {
      expect(error).toMatchObject({ name: 'WorkflowJournalError', code: 'journal_schema_unsupported' });
    }
    // 不向下迁移、不破坏文件：user_version 仍为 4。
    const again = new DatabaseSync(file);
    expect(Number(again.prepare('PRAGMA user_version').get()?.['user_version'])).toBe(4);
    again.close();
  });

  it('applies typed projections inside one transaction per event', () => {
    const journal = new SqliteWorkflowJournal(freshDbPath());
    insertRun(journal, 'r1');
    const events: WorkflowJournalEvent[] = [
      { t: 'run', runId: 'r1', parentRunId: null, ...RUN_EVENT_BASE, status: 'running' },
      {
        t: 'call_start',
        runId: 'r1',
        callSeq: 1,
        callId: 'r1:c1',
        phase: 'p',
        label: 'l1',
        contentKey: 'k1',
        effective: { harness: 'mock' },
        promptHash: 'ph',
        isolation: 'readonly',
      },
      { t: 'attempt_start', runId: 'r1', callSeq: 1, attempt: 1, isolation: 'readonly' },
      { t: 'attempt_end', runId: 'r1', callSeq: 1, attempt: 1, status: 'ok' },
      { t: 'call_end', runId: 'r1', callSeq: 1, status: 'ok', result: { v: 1 }, attempts: 1 },
      { t: 'deliver', runId: 'r1', callSeq: 1 },
      { t: 'run', runId: 'r1', parentRunId: null, ...RUN_EVENT_BASE, status: 'completed', result: { done: true } },
    ];
    for (const e of events) journal.appendEvent(e);

    const run = journal.getRun('r1')!;
    expect(run.status).toBe('completed');
    expect(run.resultJson).toBe('{"done":true}');
    const calls = journal.listCalls('r1');
    expect(calls).toHaveLength(1);
    expect(calls[0]).toMatchObject({ status: 'ok', attempts: 1, contentKey: 'k1', label: 'l1', phase: 'p' });
    expect(JSON.parse(calls[0]!.resultJson!)).toEqual({ v: 1 });
    journal.close();
  });

  it('callsForResume returns committed results with original-run provenance', () => {
    const journal = new SqliteWorkflowJournal(freshDbPath());
    insertRun(journal, 'parent');
    journal.appendEvent({
      t: 'call_start',
      runId: 'parent',
      callSeq: 1,
      callId: 'parent:c1',
      phase: null,
      label: 'a',
      contentKey: 'ka',
      effective: {},
      promptHash: 'p1',
      isolation: 'readonly',
    });
    journal.appendEvent({ t: 'call_end', runId: 'parent', callSeq: 1, status: 'ok', result: 'ra', attempts: 1 });
    // 失败调用不进缓存。
    journal.appendEvent({
      t: 'call_start',
      runId: 'parent',
      callSeq: 2,
      callId: 'parent:c2',
      phase: null,
      label: 'b',
      contentKey: 'kb',
      effective: {},
      promptHash: 'p2',
      isolation: 'readonly',
    });
    journal.appendEvent({ t: 'call_end', runId: 'parent', callSeq: 2, status: 'failed', code: 'timeout', attempts: 1 });

    insertRun(journal, 'child', null, 'parent');
    journal.appendEvent({
      t: 'call_start',
      runId: 'child',
      callSeq: 1,
      callId: 'child:c1',
      phase: null,
      label: 'a',
      contentKey: 'ka',
      effective: {},
      promptHash: 'p1',
      isolation: 'readonly',
    });
    journal.appendEvent({
      t: 'call_end',
      runId: 'child',
      callSeq: 1,
      status: 'cached',
      result: 'ra',
      cachedFromRunId: 'parent',
      attempts: 0,
    });

    expect(journal.callsForResume('parent')).toEqual([{ contentKey: 'ka', result: 'ra', fromRunId: 'parent' }]);
    // cached 行的出处回溯到原成功 run，不是中间 cached run。
    expect(journal.callsForResume('child')).toEqual([{ contentKey: 'ka', result: 'ra', fromRunId: 'parent' }]);
    journal.close();
  });

  it('findRunByRequestId deduplicates受理', () => {
    const journal = new SqliteWorkflowJournal(freshDbPath());
    insertRun(journal, 'r1', 'req-1');
    expect(journal.findRunByRequestId('req-1')?.runId).toBe('r1');
    expect(journal.findRunByRequestId('nope')).toBeNull();
    journal.close();
  });

  it('sees committed data after reopening the file', () => {
    const file = freshDbPath();
    const journal = new SqliteWorkflowJournal(file);
    insertRun(journal, 'r1', 'req-1');
    journal.appendEvent({ t: 'run', runId: 'r1', parentRunId: null, ...RUN_EVENT_BASE, status: 'completed', result: 'x' });
    journal.close();

    const reopened = new SqliteWorkflowJournal(file);
    expect(reopened.getRun('r1')).toMatchObject({ status: 'completed', resultJson: '"x"', requestId: 'req-1' });
    expect(reopened.listNonTerminalRuns()).toHaveLength(0);
    reopened.close();
  });
});
