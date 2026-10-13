import { randomUUID } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { z } from 'zod';
import { createApp } from './app.js';
import { migrateDatabase, openDatabase, type Database } from './db.js';
import { AgentDataError, readOnlyQuery, resetDatabase, seed, snapshotDatabase } from './agent/data.js';
import { describeRevision } from './agent/describe.js';
import { checkManifest, generateManifest, writeManifest } from './agent/manifest.js';

/**
 * 控制面后端 CLI。输出恒为单行 JSON：{ok:true,data} 或 {ok:false,error:{code,message}}。
 * 退出码：0 成功；1 被拒绝或失败；2 用法/输入无效；3 不可用（例如应用正在运行而未提供实例地址）。
 * 应用停止时直接打开本实例 PGlite；应用运行时只能经 WSL_AGENT_URL + WSL_AGENT_TOKEN 调用实例端点。
 */
type Outcome = { code: 0 | 1 | 2 | 3; data?: Record<string, unknown>; error?: { code: string; message: string } };
const USAGE = `用法：agent-cli <命令> [--json]
  describe                              manifest 与源码修订、stale 判定
  manifest [--write] [--check] [--build-stamp]
  db migrate | db seed | db reset | db snapshot
  db query "<只读 SQL>" [--limit N]
  api call <GET|POST|PUT|PATCH|DELETE> </api/...> [--body JSON] [--as A|B]`;

class CliError extends Error {
  constructor(
    readonly exit: 1 | 2 | 3,
    readonly code: string,
    message: string,
  ) {
    super(message);
  }
}

const root = process.cwd();
const dataDir = process.env.WSL_DATA_DIR ?? '.data/pglite';
const identity = {
  workspaceId: process.env.WSL_WORKSPACE_ID ?? 'local-workspace',
  environmentId: process.env.WSL_ENVIRONMENT_ID ?? 'local-environment',
  projectId: process.env.WSL_PROJECT_ID ?? 'local-project',
  appInstanceId: process.env.WSL_APP_INSTANCE_ID ?? 'local-app',
};
const instance =
  process.env.WSL_AGENT_URL && process.env.WSL_AGENT_TOKEN ? { url: process.env.WSL_AGENT_URL, token: process.env.WSL_AGENT_TOKEN } : null;

function option(args: string[], name: string): string | undefined {
  const index = args.indexOf(name);
  if (index < 0) return undefined;
  const value = args[index + 1];
  if (value === undefined || value.startsWith('--')) throw new CliError(2, 'invalid_request', `${name} 缺少值`);
  args.splice(index, 2);
  return value;
}

function flag(args: string[], name: string): boolean {
  const index = args.indexOf(name);
  if (index >= 0) args.splice(index, 1);
  return index >= 0;
}

/** 应用运行时数据目录被服务进程占用；PGlite 不能被第二个进程打开。 */
async function assertDataDirFree() {
  let runtime: unknown;
  try {
    runtime = JSON.parse(await readFile(`${dataDir}.runtime.json`, 'utf8'));
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return;
    throw error;
  }
  const pid = z.object({ pid: z.number().int().positive() }).safeParse(runtime);
  if (!pid.success) throw new CliError(3, 'app_running', '运行文件无法解析，拒绝打开可能被占用的数据目录');
  try {
    process.kill(pid.data.pid, 0);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ESRCH') return;
  }
  throw new CliError(3, 'app_running', '应用正在运行（数据目录被占用）；请经工作台控制面或停止应用后再执行');
}

async function withDatabase<T>(work: (database: Database) => Promise<T>): Promise<T> {
  await assertDataDirFree();
  const database = await openDatabase(dataDir);
  try {
    await migrateDatabase(database);
    return await work(database);
  } finally {
    await database.client.close();
  }
}

async function instanceCall(method: 'GET' | 'POST', path: string, body?: unknown): Promise<Record<string, unknown>> {
  if (!instance) throw new CliError(3, 'unavailable', '缺少实例地址');
  const response = await fetch(new URL(path, instance.url), {
    method,
    headers: {
      'x-wsl-agent-token': instance.token,
      ...(/^\/api\/__agent\/db\/(seed|reset)$/.test(path) ? { 'x-wsl-agent-operation-id': randomUUID() } : {}),
      ...(body === undefined ? {} : { 'content-type': 'application/json' }),
    },
    body: body === undefined ? undefined : JSON.stringify(body),
    redirect: 'error',
    signal: AbortSignal.timeout(20000),
  });
  const envelope = z
    .union([
      z.object({ ok: z.literal(true), data: z.record(z.string(), z.unknown()) }),
      z.object({ ok: z.literal(false), error: z.object({ code: z.string(), message: z.string() }) }),
    ])
    .parse(await response.json());
  if (!envelope.ok) throw new CliError(envelope.error.code === 'unavailable' ? 3 : 1, envelope.error.code, envelope.error.message);
  return envelope.data;
}

async function database(args: string[]): Promise<Record<string, unknown>> {
  const command = args.shift();
  if (command === 'query') {
    const limit = Number(option(args, '--limit') ?? '50');
    const sql = args.shift();
    if (!sql || args.length || !Number.isInteger(limit) || limit < 1 || limit > 200)
      throw new CliError(2, 'invalid_request', 'db query 需要一条 SQL 和 1–200 的 --limit');
    return instance ? instanceCall('POST', '/api/__agent/db/query', { sql, limit }) : withDatabase((db) => readOnlyQuery(db, sql, limit));
  }
  if (args.length) throw new CliError(2, 'invalid_request', `db ${command ?? ''} 不接受额外参数`);
  switch (command) {
    case 'migrate':
      if (instance) throw new CliError(3, 'app_running', '运行中的实例启动时已迁移');
      return withDatabase(async () => ({ command: 'migrate' }));
    case 'seed':
      return instance
        ? instanceCall('POST', '/api/__agent/db/seed', {})
        : withDatabase(async (db) => ({ command: 'seed', ...(await seed(db)) }));
    case 'reset':
      return instance ? instanceCall('POST', '/api/__agent/db/reset', {}) : withDatabase((db) => resetDatabase(db));
    case 'snapshot':
      return instance ? instanceCall('GET', '/api/__agent/db/snapshot') : withDatabase((db) => snapshotDatabase(db));
    default:
      throw new CliError(2, 'invalid_request', USAGE);
  }
}

async function api(args: string[]): Promise<Record<string, unknown>> {
  if (args.shift() !== 'call') throw new CliError(2, 'invalid_request', USAGE);
  const body = option(args, '--body');
  const as = option(args, '--as');
  const [method, route, ...rest] = args;
  if (rest.length || !method || !route) throw new CliError(2, 'invalid_request', USAGE);
  const verb = z.enum(['GET', 'POST', 'PUT', 'PATCH', 'DELETE']).safeParse(method.toUpperCase());
  if (!verb.success) throw new CliError(2, 'invalid_request', '方法只能是 GET/POST/PUT/PATCH/DELETE');
  if (!/^\/api\/(?!__agent(?:\/|$))[^\s\\]*$/.test(route) || route.includes('..'))
    throw new CliError(2, 'invalid_request', '路由必须以 /api/ 开头且不能是 /api/__agent');
  if (as !== undefined && as !== 'A' && as !== 'B') throw new CliError(2, 'invalid_request', '--as 只能是 A 或 B');
  if (body !== undefined) {
    try {
      JSON.parse(body);
    } catch {
      throw new CliError(2, 'invalid_request', '--body 必须是 JSON');
    }
  }
  const run = async (request: (path: string, init: RequestInit) => Promise<Response>) => {
    let cookie: string | undefined;
    if (as) {
      const session = await request('/api/dev/session', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ userId: as }),
      });
      if (!session.ok) throw new CliError(1, 'session_failed', `开发会话 ${as} 创建失败（${session.status}）`);
      cookie = session.headers.get('set-cookie')?.split(';')[0];
    }
    const response = await request(route, {
      method: verb.data,
      headers: { ...(body !== undefined ? { 'content-type': 'application/json' } : {}), ...(cookie ? { cookie } : {}) },
      body,
    });
    const text = (await response.text()).slice(0, 65536);
    const json = parseJson(text);
    return { status: response.status, json, text: json === null ? text : null };
  };
  if (instance)
    return run((path, init) => fetch(new URL(path, instance.url), { ...init, redirect: 'error', signal: AbortSignal.timeout(20000) }));
  return withDatabase((db) => {
    const app = createApp(db, identity, true);
    return run(async (path, init) => app.request(path, init));
  });
}

function parseJson(text: string): unknown {
  try {
    return JSON.parse(text) as unknown;
  } catch {
    return null;
  }
}

async function main(argv: string[]): Promise<Outcome> {
  const args = argv.filter((arg) => arg !== '--json');
  const command = args.shift();
  try {
    switch (command) {
      case 'describe':
        if (args.length) throw new CliError(2, 'invalid_request', 'describe 不接受参数');
        return { code: 0, data: { ...(await describeRevision(root)), mode: instance ? 'instance' : 'direct' } };
      case 'manifest': {
        const write = flag(args, '--write');
        const check = flag(args, '--check');
        const buildStamp = flag(args, '--build-stamp');
        if (args.length || (check && (write || buildStamp))) throw new CliError(2, 'invalid_request', USAGE);
        if (check) {
          const result = await checkManifest(root);
          return result.ok
            ? { code: 0, data: result }
            : {
                code: 1,
                data: result,
                error: {
                  code: 'manifest_check_failed',
                  message: result.failures.map((failure) => `${failure.code} ${failure.source}: ${failure.message}`).join('\n'),
                },
              };
        }
        const manifest = write ? await writeManifest(root, { buildStamp }) : (await generateManifest(root)).manifest;
        return {
          code: 0,
          data: { written: write, sourceRevision: manifest.sourceRevision, checks: manifest.checks, ...(write ? {} : { manifest }) },
        };
      }
      case 'db':
        return { code: 0, data: await database(args) };
      case 'api':
        return { code: 0, data: await api(args) };
      case 'help':
      case undefined:
        return { code: command ? 0 : 2, data: { usage: USAGE } };
      default:
        throw new CliError(2, 'invalid_request', USAGE);
    }
  } catch (error) {
    if (error instanceof CliError) return { code: error.exit, error: { code: error.code, message: error.message } };
    if (error instanceof AgentDataError)
      return { code: error.code === 'unavailable' ? 3 : 1, error: { code: error.code, message: error.message } };
    return { code: 3, error: { code: 'unavailable', message: error instanceof Error ? error.message : String(error) } };
  }
}

const outcome = await main(process.argv.slice(2));
process.stdout.write(
  JSON.stringify(
    outcome.error
      ? { ok: false, error: outcome.error, ...(outcome.data ? { data: outcome.data } : {}) }
      : { ok: true, data: outcome.data ?? {} },
  ) + '\n',
);
process.exitCode = outcome.code;
