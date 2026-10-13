import { createHash } from 'node:crypto';
import type { Database } from '../db.js';
import { seedDatabase } from '../db.js';

/** 控制面数据操作；同一实现供 agent-cli（应用停止）与 /api/__agent（应用运行）共用。 */
export class AgentDataError extends Error {
  constructor(
    readonly code: 'write_rejected' | 'invalid_request' | 'unavailable',
    message: string,
  ) {
    super(message);
  }
}

const READ_ONLY_START = /^\s*(select|with|values|explain|table|show)\b/i;
const FORBIDDEN =
  /\b(insert|update|delete|merge|truncate|drop|alter|create|grant|revoke|copy|vacuum|call|lock|refresh|reindex|cluster|begin|commit|rollback|savepoint|prepare|execute|listen|notify|discard)\b/i;

function stripLiterals(sql: string): string {
  return sql
    .replace(/'(?:[^']|'')*'/g, "''")
    .replace(/"(?:[^"]|"")*"/g, '""')
    .replace(/--[^\n]*/g, ' ')
    .replace(/\/\*[\s\S]*?\*\//g, ' ');
}

/**
 * 只读查询：静态拒绝写关键字与多语句，再在 READ ONLY 事务中执行并回滚。
 * 两层任一拒绝即失败；EXPLAIN ANALYZE 也会被 READ ONLY 事务阻止实际写入。
 */
export async function readOnlyQuery(database: Database, sql: string, limit: number) {
  if (!sql.trim() || sql.length > 4000) throw new AgentDataError('invalid_request', 'SQL 为空或超过 4000 字符');
  const stripped = stripLiterals(sql).trim().replace(/;\s*$/, '');
  if (stripped.includes(';')) throw new AgentDataError('write_rejected', '只允许单条语句');
  if (!READ_ONLY_START.test(stripped)) throw new AgentDataError('write_rejected', '只允许 SELECT/WITH/VALUES/EXPLAIN/TABLE/SHOW 查询');
  if (FORBIDDEN.test(stripped)) throw new AgentDataError('write_rejected', '查询包含写入或会话控制关键字');
  const statement = sql.trim().replace(/;\s*$/, '');
  let result: { rows: unknown[]; fields: { name: string }[] };
  try {
    result = await database.client.transaction(async (tx) => {
      await tx.query('SET TRANSACTION READ ONLY');
      await tx.query("SET LOCAL statement_timeout = '5s'");
      const rows = (await tx.query(statement)) as { rows: unknown[]; fields: { name: string }[] };
      await tx.rollback();
      return rows;
    });
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    throw new AgentDataError(/read-only transaction/i.test(message) ? 'write_rejected' : 'invalid_request', message.slice(0, 2000));
  }
  const rows = result.rows.slice(0, limit);
  return { columns: result.fields.map((field) => field.name), rows, rowCount: result.rows.length, truncated: result.rows.length > limit };
}

async function userTables(database: Database): Promise<string[]> {
  const result = await database.client.query<{ tablename: string }>(
    "SELECT tablename FROM pg_tables WHERE schemaname = 'public' ORDER BY tablename",
  );
  return result.rows.map((row) => row.tablename);
}

function quoteIdent(name: string): string {
  return `"${name.replace(/"/g, '""')}"`;
}

/** 只截断本实例 PGlite 的 public 表（不含 drizzle 迁移记录），再执行幂等 seed。 */
export async function resetDatabase(database: Database) {
  const tables = await userTables(database);
  await database.client.transaction(async (tx) => {
    if (tables.length) await tx.query(`TRUNCATE ${tables.map(quoteIdent).join(', ')}`);
  });
  await seedDatabase(database);
  return { truncated: tables, seeded: true };
}

export async function seed(database: Database) {
  await seedDatabase(database);
  return { seeded: true };
}

function stableJson(value: unknown): string {
  // JSON serialization preserves scalars and arrays; only object key ordering changes.
  return JSON.stringify(value, (_key, item: unknown) => {
    if (item !== null && typeof item === 'object' && !Array.isArray(item))
      return Object.fromEntries(Object.entries(item).sort(([left], [right]) => (left < right ? -1 : left > right ? 1 : 0)));
    return item;
  });
}

/** 状态 diff 用的有界快照：每表行数、内容散列和最多 20 行排序样本。 */
export async function snapshotDatabase(database: Database) {
  const tables: Record<string, { rowCount: number; sha256: string; sample: unknown[]; truncated: boolean }> = {};
  for (const table of await userTables(database)) {
    const result = await database.client.query<Record<string, unknown>>(`SELECT * FROM ${quoteIdent(table)}`);
    const rows = result.rows.map((row) => stableJson(row)).sort();
    tables[table] = {
      rowCount: rows.length,
      sha256: createHash('sha256').update(JSON.stringify(rows)).digest('hex'),
      sample: rows.slice(0, 20).map((row) => JSON.parse(row) as unknown),
      truncated: rows.length > 20,
    };
  }
  return { tables };
}
