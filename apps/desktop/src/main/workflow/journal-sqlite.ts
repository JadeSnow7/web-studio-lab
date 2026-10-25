import { createHash } from 'node:crypto';
import { DatabaseSync, type SQLOutputValue } from 'node:sqlite';
import type { WorkflowCandidateProjection, WorkflowJournalEvent, WorkflowPublication, WorkflowRunInput } from '@wsl/protocol';

/**
 * W2 的 SQLite journal 适配器（合同 §7 / 设计 §6）：runs/calls/attempts 的类型化投影 +
 * events 原始追加镜像。由 WorkflowApplication 单写持有；schema 版本经 PRAGMA user_version，
 * 未知新版本保留文件并拒绝（journal_schema_unsupported），不向下迁移。
 * W6a（v2）：runs 增加候选基线/指针/应用目标/应用时间，calls 增加 published_tree，
 * 新增 publications 表登记每次 lane 候选发布；发布事实与 call_end 投影在同一事务落盘。
 * W8（v4）：calls 增加 base_tree（call_start 时冻结的候选指针，即 lane attempt 基线）
 * 与 conflict_json（conflict 终态的 files/candidateRef 事实）。
 */

export const WORKFLOW_JOURNAL_SCHEMA_VERSION = 4;

/** canonical：递归排序键的 JSON.stringify；undefined 键丢弃，数组保序（与 service 内核一致）。 */
export function canonical(value: unknown): string {
  return JSON.stringify(normalize(value));
}

function normalize(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(normalize);
  if (value !== null && typeof value === 'object') {
    const out: Record<string, unknown> = {};
    for (const key of Object.keys(value).sort()) {
      const item = (value as Record<string, unknown>)[key];
      if (item !== undefined) out[key] = normalize(item);
    }
    return out;
  }
  return value;
}

/** 命令内容绑定的通用 hash 原语（W5 contentHash 组合与各受理 hash 共用）。 */
export function sha256Hex(input: string): string {
  return createHash('sha256').update(input, 'utf8').digest('hex');
}

/** 受理身份 hash：scriptHash=sha256(script 原文)；任务卡展示与受理校验共用同一实现。 */
export function workflowScriptHash(script: string): string {
  return sha256Hex(script);
}

/** 受理身份 hash：argsHash=sha256(canonical(args??null))；undefined 与 null 归一为 null。 */
export function workflowArgsHash(args: unknown): string {
  return sha256Hex(canonical(args === undefined ? null : args));
}

/** 受理身份 hash：inputHash=sha256(canonical(input??null))；无冻结输入归一为 null。 */
export function workflowInputHash(input: WorkflowRunInput | undefined): string {
  return sha256Hex(canonical(input === undefined ? null : input));
}

/** 终态确认集合；needs_reconciliation 是恢复标记，非终态。 */
export const WORKFLOW_TERMINAL_RUN_STATUSES = ['completed', 'failed', 'stopped'] as const;
export const WORKFLOW_RECOVERY_STATUS = 'needs_reconciliation';

export class WorkflowJournalError extends Error {
  readonly code: string;

  constructor(code: string, message?: string) {
    super(message ?? code);
    this.name = 'WorkflowJournalError';
    this.code = code;
  }
}

export interface WorkflowRunRow {
  runId: string;
  requestId: string | null;
  parentRunId: string | null;
  scriptHash: string;
  argsHash: string;
  dslVersion: string;
  status: string;
  failureCode: string | null;
  resultJson: string | null;
  engine: string | null;
  createdMs: number;
  createdSeq: number;
  /** W6a：受理时建立的候选基线树；无候选能力（v1 迁移行）时为 null。 */
  baseTree: string | null;
  /** W6a：候选指针——已登记 publications 的最新 afterTree；尚未发布时等于 baseTree 或 null。 */
  candidateTree: string | null;
  /** W6a：候选发布面向的应用目标（JSON）；v1 迁移行或无目标时为 null。 */
  appTargetJson: string | null;
  /** W6a：候选快照经授权应用到目标的时间（apply 事件投影）。 */
  appliedAt: number | null;
  /** W6b：命令卡元数据副本——脚本 declara lane（ejecución requiere App enlazada）。 */
  requiresApp: boolean;
  /** W6b：脚本 declara aislamiento de escritura (lane). */
  writes: boolean;
}

export interface WorkflowCallRow {
  runId: string;
  callSeq: number;
  callId: string;
  phase: string | null;
  label: string | null;
  contentKey: string;
  status: string;
  code: string | null;
  resultJson: string | null;
  cachedFromRunId: string | null;
  attempts: number;
  /** W8：call_start 时冻结的候选指针（lane attempt 基线）；无候选能力或迁移行为 null。 */
  baseTree: string | null;
  /** W8：conflict 终态事实（files + candidateRef）；非 conflict 为 null。 */
  conflict: { files: string[]; candidateRef: string } | null;
}

export interface WorkflowResumeEntry {
  contentKey: string;
  result: unknown;
  fromRunId: string;
  /** W6a：lane 调用对应的已提交发布事实；续跑命中时随缓存项回放。 */
  publication?: WorkflowPublication;
}

/** W6a：publishCandidate 入口参数——service 回传的候选经 Main capture 出的发布事实。 */
export interface WorkflowCandidatePublish {
  runId: string;
  callSeq: number;
  /** 发布事实；files 差异摘要即 publications.files_json 的内容。 */
  publication: WorkflowPublication;
}

/** W6a：run 的候选状态——基线、当前指针、最新发布摘要与应用时间（candidateForRun 的返回形状）。 */
export type WorkflowCandidateState = WorkflowCandidateProjection;

export interface SqliteWorkflowJournalOptions {
  now?: () => number;
}

export class SqliteWorkflowJournal {
  private readonly db: DatabaseSync;
  private readonly now: () => number;

  constructor(path: string, options: SqliteWorkflowJournalOptions = {}) {
    this.now = options.now ?? Date.now;
    this.db = new DatabaseSync(path);
    const version = this.readUserVersion();
    if (version > WORKFLOW_JOURNAL_SCHEMA_VERSION) {
      const unsupported = version;
      this.db.close();
      throw new WorkflowJournalError(
        'journal_schema_unsupported',
        `workflow journal schema ${unsupported} is newer than supported ${WORKFLOW_JOURNAL_SCHEMA_VERSION}`,
      );
    }
    try {
      if (version === 0) this.createSchema();
      else if (version < WORKFLOW_JOURNAL_SCHEMA_VERSION) this.migrate(version);
    } catch (error) {
      this.db.close();
      throw error;
    }
    if (!this.hasTable('runs') || !this.hasTable('publications')) {
      this.db.close();
      throw new WorkflowJournalError('journal_schema_unsupported', 'workflow journal schema is incomplete');
    }
  }

  private readUserVersion(): number {
    const row = this.db.prepare('PRAGMA user_version').get();
    return Number(row?.['user_version'] ?? 0);
  }

  private hasTable(name: string): boolean {
    return this.db.prepare("SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = ?").get(name) !== undefined;
  }

  private createSchema(): void {
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS runs (
        run_id TEXT PRIMARY KEY,
        request_id TEXT UNIQUE,
        parent_run_id TEXT,
        script_hash TEXT NOT NULL,
        args_hash TEXT NOT NULL,
        dsl_version TEXT NOT NULL,
        status TEXT NOT NULL,
        failure_code TEXT,
        result_json TEXT,
        engine TEXT,
        created_ms INTEGER NOT NULL,
        created_seq INTEGER NOT NULL,
        base_tree TEXT,
        candidate_tree TEXT,
        app_target_json TEXT,
        applied_at INTEGER,
        requires_app INTEGER NOT NULL DEFAULT 0,
        writes INTEGER NOT NULL DEFAULT 0
      );
      CREATE TABLE IF NOT EXISTS calls (
        run_id TEXT NOT NULL,
        call_seq INTEGER NOT NULL,
        call_id TEXT NOT NULL,
        phase TEXT,
        label TEXT,
        content_key TEXT NOT NULL,
        effective_json TEXT NOT NULL,
        prompt_hash TEXT NOT NULL,
        status TEXT NOT NULL,
        code TEXT,
        result_json TEXT,
        cached_from_run_id TEXT,
        attempts INTEGER NOT NULL DEFAULT 0,
        published_tree TEXT,
        base_tree TEXT,
        conflict_json TEXT,
        PRIMARY KEY (run_id, call_seq)
      );
      CREATE TABLE IF NOT EXISTS attempts (
        run_id TEXT NOT NULL,
        call_seq INTEGER NOT NULL,
        attempt INTEGER NOT NULL,
        status TEXT NOT NULL,
        code TEXT,
        PRIMARY KEY (run_id, call_seq, attempt)
      );
      CREATE TABLE IF NOT EXISTS events (
        seq INTEGER PRIMARY KEY AUTOINCREMENT,
        run_id TEXT NOT NULL,
        kind TEXT NOT NULL,
        json TEXT NOT NULL
      );
      CREATE TABLE IF NOT EXISTS publications (
        run_id TEXT NOT NULL,
        call_seq INTEGER NOT NULL,
        prev_tree TEXT NOT NULL,
        next_tree TEXT NOT NULL,
        patch_sha256 TEXT NOT NULL,
        files_json TEXT NOT NULL,
        created_ms INTEGER NOT NULL,
        PRIMARY KEY (run_id, call_seq)
      );
      PRAGMA user_version = ${WORKFLOW_JOURNAL_SCHEMA_VERSION};
    `);
  }

  /**
   * v1→v2：给既有文件追加候选列与 publications 表；已有行候选列保持 NULL（无候选能力）。
   * v2→v3：requires_app/writes 列（W6b 命令卡元数据——lane 声明的卡片级投影）。
   * DDL 单事务，user_version 在提交后落位——中途失败文件仍是可读 v1/v2。
   */
  private migrate(from: number): void {
    let version = from;
    if (version === 1) {
      this.db.exec(`
        BEGIN IMMEDIATE;
        ALTER TABLE runs ADD COLUMN base_tree TEXT;
        ALTER TABLE runs ADD COLUMN candidate_tree TEXT;
        ALTER TABLE runs ADD COLUMN app_target_json TEXT;
        ALTER TABLE runs ADD COLUMN applied_at INTEGER;
        ALTER TABLE calls ADD COLUMN published_tree TEXT;
        CREATE TABLE IF NOT EXISTS publications (
          run_id TEXT NOT NULL,
          call_seq INTEGER NOT NULL,
          prev_tree TEXT NOT NULL,
          next_tree TEXT NOT NULL,
          patch_sha256 TEXT NOT NULL,
          files_json TEXT NOT NULL,
          created_ms INTEGER NOT NULL,
          PRIMARY KEY (run_id, call_seq)
        );
        COMMIT;
      `);
      version = 2;
    }
    if (version === 2) {
      this.db.exec(`
        BEGIN IMMEDIATE;
        ALTER TABLE runs ADD COLUMN requires_app INTEGER NOT NULL DEFAULT 0;
        ALTER TABLE runs ADD COLUMN writes INTEGER NOT NULL DEFAULT 0;
        COMMIT;
      `);
      version = 3;
    }
    if (version === 3) {
      // W8：lane 波次的调用基线与冲突事实列；已有行保持 NULL（无 W8 语义）。
      this.db.exec(`
        BEGIN IMMEDIATE;
        ALTER TABLE calls ADD COLUMN base_tree TEXT;
        ALTER TABLE calls ADD COLUMN conflict_json TEXT;
        COMMIT;
      `);
      version = 4;
    }
    if (version !== WORKFLOW_JOURNAL_SCHEMA_VERSION)
      throw new WorkflowJournalError('journal_schema_unsupported', `workflow journal schema ${from} cannot be migrated`);
    this.db.exec(`PRAGMA user_version = ${WORKFLOW_JOURNAL_SCHEMA_VERSION}`);
  }

  /** 受理时登记 run 行；created_seq 是单写者内的受理序号。W6a：baseTree/appTargetJson 一并登记。 */
  insertRun(row: {
    runId: string;
    requestId: string | null;
    parentRunId: string | null;
    scriptHash: string;
    argsHash: string;
    dslVersion: string;
    status: string;
    engine: string | null;
    createdMs?: number;
    /** W6a：受理时建立的候选基线树；无候选能力可省略。 */
    baseTree?: string | null;
    /** W6a：候选发布面向的应用目标（canonical JSON）；省略为 null。 */
    appTargetJson?: string | null;
    /** W6b：命令卡元数据副本（lane → requiere App / escritura）。 */
    requiresApp?: boolean;
    writes?: boolean;
  }): void {
    const next = this.db.prepare('SELECT COALESCE(MAX(created_seq), 0) + 1 AS next FROM runs').get();
    this.db
      .prepare(
        `INSERT INTO runs (run_id, request_id, parent_run_id, script_hash, args_hash, dsl_version, status, engine, created_ms, created_seq,
           base_tree, candidate_tree, app_target_json, requires_app, writes)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(
        row.runId,
        row.requestId,
        row.parentRunId,
        row.scriptHash,
        row.argsHash,
        row.dslVersion,
        row.status,
        row.engine,
        row.createdMs ?? this.now(),
        Number(next?.['next'] ?? 1),
        row.baseTree ?? null,
        // 候选指针初始等于基线：CAS 的第一环以 baseTree 为期望值。
        row.baseTree ?? null,
        row.appTargetJson ?? null,
        row.requiresApp ? 1 : 0,
        row.writes ? 1 : 0,
      );
  }

  findRunByRequestId(requestId: string): WorkflowRunRow | null {
    const row = this.db.prepare('SELECT * FROM runs WHERE request_id = ?').get(requestId);
    return row === undefined ? null : this.toRunRow(row);
  }

  getRun(runId: string): WorkflowRunRow | null {
    const row = this.db.prepare('SELECT * FROM runs WHERE run_id = ?').get(runId);
    return row === undefined ? null : this.toRunRow(row);
  }

  /** 应用级状态写入（恢复标记、engine_rejected）；journal 事件的状态经 appendEvent 投影。 */
  updateRunStatus(runId: string, update: { status: string; failureCode?: string | null; resultJson?: string | null }): void {
    const result = this.db
      .prepare(
        `UPDATE runs SET status = ?,
           failure_code = CASE WHEN ? THEN ? ELSE failure_code END,
           result_json = CASE WHEN ? THEN ? ELSE result_json END
         WHERE run_id = ?`,
      )
      .run(
        update.status,
        update.failureCode !== undefined ? 1 : 0,
        update.failureCode ?? null,
        update.resultJson !== undefined ? 1 : 0,
        update.resultJson ?? null,
        runId,
      );
    if (result.changes === 0) throw new WorkflowJournalError('run_not_found', `unknown run ${runId}`);
  }

  /** 最近 run 列表（created_seq 降序）；运行记录面板使用，默认 50 条。 */
  listRuns(limit = 50): WorkflowRunRow[] {
    return this.db
      .prepare('SELECT * FROM runs ORDER BY created_seq DESC LIMIT ?')
      .all(limit)
      .map((row) => this.toRunRow(row));
  }

  /** 某 run 的原始事件镜像（seq 升序）；usage/log 尾部等无类型化投影的字段从这里读取。 */
  listEvents(runId: string): WorkflowJournalEvent[] {
    return this.db
      .prepare('SELECT json FROM events WHERE run_id = ? ORDER BY seq')
      .all(runId)
      .map((row) => JSON.parse(String(row['json'])) as WorkflowJournalEvent);
  }

  /** 非终态（含 needs_reconciliation）：恢复扫描与 P0 并发 1 的 busy 判定共用。 */
  listNonTerminalRuns(): WorkflowRunRow[] {
    const placeholders = WORKFLOW_TERMINAL_RUN_STATUSES.map(() => '?').join(', ');
    return this.db
      .prepare(`SELECT * FROM runs WHERE status NOT IN (${placeholders}) ORDER BY created_seq`)
      .all(...WORKFLOW_TERMINAL_RUN_STATUSES)
      .map((row) => this.toRunRow(row));
  }

  listCalls(runId: string): WorkflowCallRow[] {
    return this.db
      .prepare('SELECT * FROM calls WHERE run_id = ? ORDER BY call_seq')
      .all(runId)
      .map((row) => this.toCallRow(row));
  }

  /**
   * 每条 journal 事件一个事务：先追加 events 原始镜像，再做类型化投影。
   * 任一投影失败整事务回滚，raw 与投影不生歧义。
   */
  appendEvent(event: WorkflowJournalEvent): void {
    this.db.exec('BEGIN IMMEDIATE');
    try {
      this.db.prepare('INSERT INTO events (run_id, kind, json) VALUES (?, ?, ?)').run(event.runId, event.t, JSON.stringify(event));
      switch (event.t) {
        case 'run':
          this.db
            .prepare(
              `UPDATE runs SET status = ?, failure_code = ?, result_json = ?,
                 parent_run_id = ?, script_hash = ?, args_hash = ?, dsl_version = ?
               WHERE run_id = ?`,
            )
            .run(
              event.status,
              event.failureCode ?? null,
              event.result === undefined ? null : JSON.stringify(event.result),
              event.parentRunId,
              event.scriptHash,
              event.argsHash,
              event.dslVersion,
              event.runId,
            );
          break;
        case 'call_start': {
          // W8：同事务内把 runs.candidate_tree 现值冻结为该调用的基线（lane attempt 的
          // 工作区身份；readonly 同样记录，统一口径更简）。无候选能力的 run 记 null。
          const pointer = this.db.prepare('SELECT candidate_tree FROM runs WHERE run_id = ?').get(event.runId);
          const baseTree = pointer === undefined || pointer['candidate_tree'] === null ? null : String(pointer['candidate_tree']);
          this.db
            .prepare(
              `INSERT INTO calls (run_id, call_seq, call_id, phase, label, content_key, effective_json, prompt_hash, status, attempts, base_tree)
               VALUES (?, ?, ?, ?, ?, ?, ?, ?, 'pending', 0, ?)`,
            )
            .run(
              event.runId,
              event.callSeq,
              event.callId,
              event.phase,
              event.label,
              event.contentKey,
              JSON.stringify(event.effective),
              event.promptHash,
              baseTree,
            );
          break;
        }
        case 'attempt_start':
          this.db
            .prepare('INSERT INTO attempts (run_id, call_seq, attempt, status) VALUES (?, ?, ?, ?)')
            .run(event.runId, event.callSeq, event.attempt, 'running');
          break;
        case 'attempt_end':
          this.db
            .prepare('UPDATE attempts SET status = ?, code = ? WHERE run_id = ? AND call_seq = ? AND attempt = ?')
            .run(event.status, event.code ?? null, event.runId, event.callSeq, event.attempt);
          this.db.prepare('UPDATE calls SET attempts = attempts + 1 WHERE run_id = ? AND call_seq = ?').run(event.runId, event.callSeq);
          break;
        case 'call_end': {
          this.db
            .prepare(
              `UPDATE calls SET status = ?, code = ?, result_json = ?, cached_from_run_id = ?,
                 attempts = COALESCE(?, attempts),
                 published_tree = CASE WHEN ? THEN ? ELSE published_tree END,
                 conflict_json = CASE WHEN ? THEN ? ELSE conflict_json END
               WHERE run_id = ? AND call_seq = ?`,
            )
            .run(
              event.status,
              event.code ?? null,
              event.result === undefined ? null : JSON.stringify(event.result),
              event.cachedFromRunId ?? null,
              event.attempts ?? null,
              event.publication !== undefined ? 1 : 0,
              event.publication?.afterTree ?? null,
              event.status === 'conflict' ? 1 : 0,
              event.status === 'conflict'
                ? JSON.stringify({ files: event.conflictFiles ?? [], candidateRef: event.candidateRef ?? null })
                : null,
              event.runId,
              event.callSeq,
            );
          // W6a：带发布事实的 call_end 在同一事务登记 publications 行并 CAS 推进候选指针。
          // 本 run 的实时 lane call_end{ok} 对应行已由 publishCandidate 预登记——此处只复核；
          // cached 回放（祖先或同轮去重）在此处补齐本 run 的发布行。
          if (event.publication !== undefined) this.applyPublication(event.runId, event.callSeq, event.publication);
          break;
        }
        case 'apply':
          // W6a：候选应用时间投影；目标/树身份留在 events 原始镜像，不另建表。
          this.db.prepare('UPDATE runs SET applied_at = ? WHERE run_id = ?').run(event.at, event.runId);
          break;
        // phase/log/deliver/warn 只入 events 原始镜像，无类型化投影。
        default:
          break;
      }
      this.db.exec('COMMIT');
    } catch (error) {
      this.db.exec('ROLLBACK');
      throw error;
    }
  }

  /** 续跑缓存：ok|cached 且结果非空的已提交调用；cached 行的出处回溯到原成功 run；lane 行携带发布事实。 */
  callsForResume(runId: string): WorkflowResumeEntry[] {
    const run = this.db.prepare('SELECT base_tree FROM runs WHERE run_id = ?').get(runId);
    const baseTree = run === undefined || run['base_tree'] === null ? null : String(run['base_tree']);
    return this.db
      .prepare(
        `SELECT c.content_key, c.result_json, c.cached_from_run_id,
                p.next_tree, p.patch_sha256, p.files_json
         FROM calls c
         LEFT JOIN publications p ON p.run_id = c.run_id AND p.call_seq = c.call_seq
         WHERE c.run_id = ? AND c.status IN ('ok', 'cached') AND c.result_json IS NOT NULL
         ORDER BY c.call_seq`,
      )
      .all(runId)
      .map((row) => ({
        contentKey: String(row['content_key']),
        result: JSON.parse(String(row['result_json'])) as unknown,
        fromRunId: row['cached_from_run_id'] === null ? runId : String(row['cached_from_run_id']),
        publication:
          row['next_tree'] === null || baseTree === null
            ? undefined
            : {
                baseTree,
                afterTree: String(row['next_tree']),
                patchSha256: String(row['patch_sha256']),
                files: JSON.parse(String(row['files_json'])) as WorkflowPublication['files'],
              },
      }));
  }

  /**
   * W6a：lane 候选发布的业务事务（service 回执前由应用用例调用）。
   * 单事务：校验基线 → 推导链上前驱 → 插入 publications 行 → CAS 推进 runs.candidate_tree。
   * 同一 call_seq 重发是幂等冲突（唯一键拒绝），CAS 期望失败整事务回滚——半提交不存在。
   */
  publishCandidate(input: WorkflowCandidatePublish): void {
    this.db.exec('BEGIN IMMEDIATE');
    try {
      const open = this.db
        .prepare(
          'SELECT runs.status AS run_status, calls.status AS call_status FROM runs JOIN calls ON calls.run_id = runs.run_id WHERE runs.run_id = ? AND calls.call_seq = ?',
        )
        .get(input.runId, input.callSeq);
      if (open?.['run_status'] !== 'running' || open['call_status'] !== 'pending') {
        throw new WorkflowJournalError('journal_event_invalid', `candidate publication closed for ${input.runId}:c${input.callSeq}`);
      }
      this.insertPublication(input.runId, input.callSeq, input.publication);
      this.db.exec('COMMIT');
    } catch (error) {
      this.db.exec('ROLLBACK');
      throw error;
    }
  }

  /**
   * publications 行的唯一写入点：基线核对 + 链上前驱推导 + 行插入 + 候选指针 CAS。
   * publishCandidate（回执路径）与 appendEvent-call_end（回放补登路径）共用；
   * 已存在的 (run_id, call_seq) 行只核对一致，不重复插入。
   */
  private insertPublication(runId: string, callSeq: number, publication: WorkflowPublication): void {
    const run = this.db.prepare('SELECT base_tree, candidate_tree FROM runs WHERE run_id = ?').get(runId);
    if (run === undefined) throw new WorkflowJournalError('journal_event_invalid', `publication for unknown run ${runId}`);
    const baseTree = run['base_tree'] === null ? null : String(run['base_tree']);
    if (baseTree === null || baseTree !== publication.baseTree) {
      throw new WorkflowJournalError(
        'journal_event_invalid',
        `publication baseTree ${publication.baseTree} does not match run baseline ${String(baseTree)}`,
      );
    }
    const existing = this.db.prepare('SELECT next_tree FROM publications WHERE run_id = ? AND call_seq = ?').get(runId, callSeq);
    if (existing !== undefined) {
      if (String(existing['next_tree']) !== publication.afterTree) {
        throw new WorkflowJournalError('journal_event_invalid', `publication for ${runId}:c${callSeq} conflicts with recorded afterTree`);
      }
      return;
    }
    // 链上前驱：最近一条 publications 的 afterTree；无发布记录时回到基线。
    const latest = this.db.prepare('SELECT next_tree FROM publications WHERE run_id = ? ORDER BY call_seq DESC LIMIT 1').get(runId);
    const prevTree = latest === undefined ? baseTree : String(latest['next_tree']);
    this.db
      .prepare(
        `INSERT INTO publications (run_id, call_seq, prev_tree, next_tree, patch_sha256, files_json, created_ms)
         VALUES (?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(runId, callSeq, prevTree, publication.afterTree, publication.patchSha256, JSON.stringify(publication.files), this.now());
    // CAS：只有当前指针等于链上前驱才推进——任何外部/越序写入都让整事务回滚。
    const cas = this.db
      .prepare('UPDATE runs SET candidate_tree = ? WHERE run_id = ? AND candidate_tree = ?')
      .run(publication.afterTree, runId, prevTree);
    if (cas.changes !== 1) {
      throw new WorkflowJournalError(
        'journal_event_invalid',
        `candidate CAS failed for ${runId}: expected pointer ${prevTree}, publication ${publication.afterTree}`,
      );
    }
  }

  /** appendEvent 的 call_end 路径：发布行已存在时核对一致，缺失时按回放语义补登。 */
  private applyPublication(runId: string, callSeq: number, publication: WorkflowPublication): void {
    this.insertPublication(runId, callSeq, publication);
  }

  /** W6a：lane 发布受理前的执行事实核对——对应 attempt 必须已登记（attempt_start 已提交）。 */
  hasAttemptStarted(runId: string, callSeq: number): boolean {
    return this.db.prepare('SELECT 1 FROM attempts WHERE run_id = ? AND call_seq = ? LIMIT 1').get(runId, callSeq) !== undefined;
  }

  /** W8：调用登记时冻结的候选指针（lane attempt 基线）；未知调用返回 null。 */
  callBaseTree(runId: string, callSeq: number): string | null {
    const row = this.db.prepare('SELECT base_tree FROM calls WHERE run_id = ? AND call_seq = ?').get(runId, callSeq);
    if (row === undefined) return null;
    return row['base_tree'] === null ? null : String(row['base_tree']);
  }

  /** W8：run 当前候选指针（合并发布的 P 侧）；无候选能力或未知 run 为 null。 */
  candidatePointer(runId: string): string | null {
    const row = this.db.prepare('SELECT candidate_tree FROM runs WHERE run_id = ?').get(runId);
    if (row === undefined || row['candidate_tree'] === null) return null;
    return String(row['candidate_tree']);
  }

  /**
   * W6a：run 的候选投影——基线、当前指针、产生当前指针的发布摘要与应用时间。
   * 指针为空（无候选能力）或指针没有对应发布行（不一致）时返回 null。
   */
  candidateForRun(runId: string): WorkflowCandidateState | null {
    const run = this.db.prepare('SELECT base_tree, candidate_tree, applied_at FROM runs WHERE run_id = ?').get(runId);
    if (run === undefined || run['candidate_tree'] === null || run['base_tree'] === null) return null;
    const publication = this.db
      .prepare(
        `SELECT next_tree, patch_sha256, files_json FROM publications
         WHERE run_id = ? AND next_tree = ? ORDER BY call_seq DESC LIMIT 1`,
      )
      .get(runId, String(run['candidate_tree']));
    if (publication === undefined) return null;
    return {
      baseTree: String(run['base_tree']),
      currentTree: String(run['candidate_tree']),
      patchSha256: String(publication['patch_sha256']),
      files: JSON.parse(String(publication['files_json'])) as WorkflowCandidateState['files'],
      appliedAt: run['applied_at'] === null ? null : Number(run['applied_at']),
    };
  }

  /**
   * W6b：产生某棵树（通常是当前候选指针）的发布的 call_seq——用于在
   * RunSourceRepository 中定位对应的 `source-N.patch`。
   */
  publicationCallSeqForTree(runId: string, nextTree: string): number | null {
    const row = this.db
      .prepare('SELECT call_seq FROM publications WHERE run_id = ? AND next_tree = ? ORDER BY call_seq DESC LIMIT 1')
      .get(runId, nextTree);
    return row === undefined ? null : Number(row['call_seq']);
  }

  close(): void {
    this.db.close();
  }

  private toRunRow(row: Record<string, SQLOutputValue>): WorkflowRunRow {
    return {
      runId: String(row['run_id']),
      requestId: row['request_id'] === null ? null : String(row['request_id']),
      parentRunId: row['parent_run_id'] === null ? null : String(row['parent_run_id']),
      scriptHash: String(row['script_hash']),
      argsHash: String(row['args_hash']),
      dslVersion: String(row['dsl_version']),
      status: String(row['status']),
      failureCode: row['failure_code'] === null ? null : String(row['failure_code']),
      resultJson: row['result_json'] === null ? null : String(row['result_json']),
      engine: row['engine'] === null ? null : String(row['engine']),
      createdMs: Number(row['created_ms']),
      createdSeq: Number(row['created_seq']),
      baseTree: row['base_tree'] === null ? null : String(row['base_tree']),
      candidateTree: row['candidate_tree'] === null ? null : String(row['candidate_tree']),
      appTargetJson: row['app_target_json'] === null ? null : String(row['app_target_json']),
      appliedAt: row['applied_at'] === null ? null : Number(row['applied_at']),
      requiresApp: Number(row['requires_app'] ?? 0) === 1,
      writes: Number(row['writes'] ?? 0) === 1,
    };
  }

  private toCallRow(row: Record<string, SQLOutputValue>): WorkflowCallRow {
    return {
      runId: String(row['run_id']),
      callSeq: Number(row['call_seq']),
      callId: String(row['call_id']),
      phase: row['phase'] === null ? null : String(row['phase']),
      label: row['label'] === null ? null : String(row['label']),
      contentKey: String(row['content_key']),
      status: String(row['status']),
      code: row['code'] === null ? null : String(row['code']),
      resultJson: row['result_json'] === null ? null : String(row['result_json']),
      cachedFromRunId: row['cached_from_run_id'] === null ? null : String(row['cached_from_run_id']),
      attempts: Number(row['attempts']),
      baseTree: row['base_tree'] === null || row['base_tree'] === undefined ? null : String(row['base_tree']),
      conflict:
        row['conflict_json'] === null || row['conflict_json'] === undefined
          ? null
          : (JSON.parse(String(row['conflict_json'])) as { files: string[]; candidateRef: string }),
    };
  }
}
