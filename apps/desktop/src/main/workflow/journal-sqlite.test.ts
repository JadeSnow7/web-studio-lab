import { WORKFLOW_EXECUTION_VERSION } from '@wsl/protocol';
import { DatabaseSync } from 'node:sqlite';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { describe, expect, it, vi } from 'vitest';
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
  it('creates schema version 5 on a fresh file', () => {
    const file = freshDbPath();
    const journal = new SqliteWorkflowJournal(file);
    journal.close();
    const db = new DatabaseSync(file);
    expect(Number(db.prepare('PRAGMA user_version').get()?.['user_version'])).toBe(5);
    for (const table of ['runs', 'calls', 'attempts', 'events', 'publications']) {
      expect(db.prepare("SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = ?").get(table)).toBeDefined();
    }
    // W6b：runs 的绑定元数据列在 v3 出现；W9：ultra 在 v5 出现。
    const columns = db
      .prepare('PRAGMA table_info(runs)')
      .all()
      .map((row) => String(row['name']));
    for (const column of ['requires_app', 'writes', 'app_target_json', 'applied_at', 'base_tree', 'candidate_tree', 'ultra']) {
      expect(columns).toContain(column);
    }
    db.close();
  });

  it('rejects files with a newer schema version and preserves them', () => {
    const file = freshDbPath();
    const db = new DatabaseSync(file);
    db.exec('PRAGMA user_version = 6');
    db.close();
    try {
      new SqliteWorkflowJournal(file);
      expect.unreachable('newer schema must be rejected');
    } catch (error) {
      expect(error).toMatchObject({ name: 'WorkflowJournalError', code: 'journal_schema_unsupported' });
    }
    // 不向下迁移、不破坏文件：user_version 仍为 6。
    const again = new DatabaseSync(file);
    expect(Number(again.prepare('PRAGMA user_version').get()?.['user_version'])).toBe(6);
    again.close();
  });

  it('migrates a v4 file to v5：runs.ultra 补列，既有行保持 0', () => {
    const file = freshDbPath();
    // 手工构造 v4 形状（ultra 列不存在）。
    const db = new DatabaseSync(file);
    db.exec(`
      CREATE TABLE runs (
        run_id TEXT PRIMARY KEY, request_id TEXT UNIQUE, parent_run_id TEXT,
        script_hash TEXT NOT NULL, args_hash TEXT NOT NULL, dsl_version TEXT NOT NULL,
        status TEXT NOT NULL, failure_code TEXT, result_json TEXT, engine TEXT,
        created_ms INTEGER NOT NULL, created_seq INTEGER NOT NULL,
        base_tree TEXT, candidate_tree TEXT, app_target_json TEXT, applied_at INTEGER,
        requires_app INTEGER NOT NULL DEFAULT 0, writes INTEGER NOT NULL DEFAULT 0
      );
      CREATE TABLE calls (
        run_id TEXT NOT NULL, call_seq INTEGER NOT NULL, call_id TEXT NOT NULL,
        phase TEXT, label TEXT, content_key TEXT NOT NULL, effective_json TEXT NOT NULL,
        prompt_hash TEXT NOT NULL, status TEXT NOT NULL, code TEXT, result_json TEXT,
        cached_from_run_id TEXT, attempts INTEGER NOT NULL DEFAULT 0,
        published_tree TEXT, base_tree TEXT, conflict_json TEXT,
        PRIMARY KEY (run_id, call_seq)
      );
      CREATE TABLE attempts (
        run_id TEXT NOT NULL, call_seq INTEGER NOT NULL, attempt INTEGER NOT NULL,
        status TEXT NOT NULL, code TEXT, PRIMARY KEY (run_id, call_seq, attempt)
      );
      CREATE TABLE events (seq INTEGER PRIMARY KEY AUTOINCREMENT, run_id TEXT NOT NULL, kind TEXT NOT NULL, json TEXT NOT NULL);
      CREATE TABLE publications (
        run_id TEXT NOT NULL, call_seq INTEGER NOT NULL, prev_tree TEXT NOT NULL, next_tree TEXT NOT NULL,
        patch_sha256 TEXT NOT NULL, files_json TEXT NOT NULL, created_ms INTEGER NOT NULL,
        PRIMARY KEY (run_id, call_seq)
      );
      INSERT INTO runs (run_id, script_hash, args_hash, dsl_version, status, created_ms, created_seq)
        VALUES ('old-run', 'sh', 'ah', 'lab-workflow/1', 'completed', 1, 1);
      PRAGMA user_version = 4;
    `);
    db.close();

    const journal = new SqliteWorkflowJournal(file);
    // 迁移行读出 ultra=false（非 Ultra，与缺省语义一致）。
    expect(journal.getRun('old-run')).toMatchObject({ runId: 'old-run', status: 'completed', ultra: false });
    journal.close();
    const check = new DatabaseSync(file);
    expect(Number(check.prepare('PRAGMA user_version').get()?.['user_version'])).toBe(5);
    check.close();
  });

  it('W9：run 事件携带 ultra:true 时投影进 runs 行，未携带保持现值', () => {
    const journal = new SqliteWorkflowJournal(freshDbPath());
    insertRun(journal, 'r1');
    expect(journal.getRun('r1')!.ultra).toBe(false);
    journal.appendEvent({ t: 'run', runId: 'r1', parentRunId: null, ...RUN_EVENT_BASE, status: 'running', ultra: true });
    expect(journal.getRun('r1')!.ultra).toBe(true);
    // 后续 run 事件不带 ultra 字段：现值保持（不被冲回 false）。
    journal.appendEvent({ t: 'run', runId: 'r1', parentRunId: null, ...RUN_EVENT_BASE, status: 'completed', result: 'x' });
    expect(journal.getRun('r1')!).toMatchObject({ status: 'completed', ultra: true });
    journal.close();
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

describe('W9 migration crash boundaries', () => {
  function v4File(halfMigrated = false): string {
    const file = freshDbPath();
    const journal = new SqliteWorkflowJournal(file);
    insertRun(journal, 'preserved');
    journal.close();
    const db = new DatabaseSync(file);
    try {
      if (!halfMigrated) db.exec('ALTER TABLE runs DROP COLUMN ultra');
      db.exec('PRAGMA user_version = 4');
    } finally {
      db.close();
    }
    return file;
  }

  it('recovers the exact v4 plus committed-ultra shape left by the old migration', () => {
    const file = v4File(true);
    const journal = new SqliteWorkflowJournal(file);
    try {
      expect(journal.getRun('preserved')).toMatchObject({ runId: 'preserved', ultra: false });
    } finally {
      journal.close();
    }
    const db = new DatabaseSync(file);
    try {
      expect(db.prepare('PRAGMA user_version').get()?.['user_version']).toBe(5);
    } finally {
      db.close();
    }
  });

  it.each(['ALTER TABLE runs ADD COLUMN ultra', 'PRAGMA user_version = 5'])(
    'rolls back DDL and version together when interrupted after %s executes',
    (marker) => {
      const file = v4File();
      const exec = DatabaseSync.prototype.exec;
      const spy = vi.spyOn(DatabaseSync.prototype, 'exec').mockImplementation(function (this: DatabaseSync, sql: string) {
        exec.call(this, sql);
        if (sql.includes(marker)) throw new Error('injected migration interruption');
      });
      try {
        expect(() => new SqliteWorkflowJournal(file)).toThrow('injected migration interruption');
      } finally {
        spy.mockRestore();
      }
      const db = new DatabaseSync(file);
      try {
        expect(db.prepare('PRAGMA user_version').get()?.['user_version']).toBe(4);
        expect(
          db
            .prepare('PRAGMA table_info(runs)')
            .all()
            .map((c) => c['name']),
        ).not.toContain('ultra');
        expect(db.prepare('SELECT run_id FROM runs').all()).toEqual([{ run_id: 'preserved' }]);
      } finally {
        db.close();
      }
      const reopened = new SqliteWorkflowJournal(file);
      try {
        expect(reopened.getRun('preserved')?.ultra).toBe(false);
      } finally {
        reopened.close();
      }
    },
  );

  it('does not normalize an unknown pre-existing ultra column', () => {
    const file = v4File();
    const db = new DatabaseSync(file);
    try {
      db.exec("ALTER TABLE runs ADD COLUMN ultra TEXT DEFAULT 'yes'");
    } finally {
      db.close();
    }
    expect(() => new SqliteWorkflowJournal(file)).toThrow(/schema|ultra/);
    const check = new DatabaseSync(file);
    try {
      expect(check.prepare('PRAGMA user_version').get()?.['user_version']).toBe(4);
      expect(
        check
          .prepare('PRAGMA table_info(runs)')
          .all()
          .find((c) => c['name'] === 'ultra')?.['type'],
      ).toBe('TEXT');
    } finally {
      check.close();
    }
  });
});

it('retains the first durable execution identity on reopen without upgrading legacy history', () => {
  const file = freshDbPath();
  const journal = new SqliteWorkflowJournal(file);
  insertRun(journal, 'legacy');
  insertRun(journal, 'current');
  journal.appendEvent({ t: 'run', runId: 'legacy', parentRunId: null, ...RUN_EVENT_BASE, status: 'running' });
  // A later terminal receipt cannot retroactively certify the first execution.
  journal.appendEvent({
    t: 'run',
    runId: 'legacy',
    parentRunId: null,
    ...RUN_EVENT_BASE,
    status: 'completed',
    executionVersion: WORKFLOW_EXECUTION_VERSION,
  });
  journal.appendEvent({
    t: 'run',
    runId: 'current',
    parentRunId: null,
    ...RUN_EVENT_BASE,
    status: 'running',
    executionVersion: WORKFLOW_EXECUTION_VERSION,
  });
  journal.close();
  const reopened = new SqliteWorkflowJournal(file);
  try {
    expect(reopened.executionVersionForRun('legacy')).toBeNull();
    expect(reopened.executionVersionForRun('current')).toBe(WORKFLOW_EXECUTION_VERSION);
  } finally {
    reopened.close();
  }
});
