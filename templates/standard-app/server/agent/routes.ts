import { timingSafeEqual } from 'node:crypto';
import type { Context, Env, Hono } from 'hono';
import { z } from 'zod';
import type { Database } from '../db.js';
import { AgentDataError, readOnlyQuery, resetDatabase, seed, snapshotDatabase } from './data.js';
import { AgentOperations, OperationError } from './operations.js';
import { describeRevision, readBuildRevision } from './describe.js';

/**
 * 仅受管开发实例挂载的控制面端点：AppService 每次启动生成随机令牌，经环境变量传入，
 * 不落盘、不写日志。请求须带同值 x-wsl-agent-token；生产与本地默认启动不挂载。
 */
export interface AgentRouteOptions {
  token: string;
  root: string;
  appInstanceId: string;
}

function failure(c: Context, status: 400 | 403 | 404 | 409 | 500, code: string, message: string) {
  return c.json({ ok: false, error: { code, message } }, status);
}

export function mountAgentRoutes<E extends Env>(app: Hono<E>, database: Database, options: AgentRouteOptions) {
  if (options.token.length < 32) throw new Error('Agent token too short');
  const expected = Buffer.from(options.token);
  const operations = new AgentOperations(options.appInstanceId);
  // 构建修订在挂载（服务启动）时固定，代表本进程实际运行的构建。
  const buildRevision = readBuildRevision(options.root).catch(() => null);
  app.use('/api/__agent/*', async (c, next) => {
    const presented = Buffer.from(c.req.header('x-wsl-agent-token') ?? '');
    if (presented.length !== expected.length || !timingSafeEqual(presented, expected))
      return failure(c, 403, 'unauthorized', 'Agent token required');
    await next();
  });
  const run = async (c: Context, work: () => Promise<Record<string, unknown>>) => {
    try {
      return c.json({ ok: true, data: await work() });
    } catch (error) {
      if (error instanceof AgentDataError) return failure(c, error.code === 'unavailable' ? 500 : 400, error.code, error.message);
      return failure(c, 500, 'unavailable', error instanceof Error ? error.message : String(error));
    }
  };
  app.get('/api/__agent/describe', (c) =>
    run(c, async () => ({
      ...(await describeRevision(options.root, { buildRevision: await buildRevision })),
      appInstanceId: options.appInstanceId,
    })),
  );
  app.post('/api/__agent/db/query', async (c) => {
    const input = z
      .object({ sql: z.string().min(1).max(4000), limit: z.number().int().min(1).max(200).default(50) })
      .strict()
      .safeParse(await c.req.json().catch(() => null));
    if (!input.success) return failure(c, 400, 'invalid_request', 'Expected {sql, limit}');
    return run(c, () => readOnlyQuery(database, input.data.sql, input.data.limit));
  });
  const operationId = z.uuid();
  const write = async (c: Context, operation: 'seed' | 'reset') => {
    const id = operationId.safeParse(c.req.header('x-wsl-agent-operation-id'));
    const input = z
      .object({})
      .strict()
      .safeParse(await c.req.json().catch(() => null));
    if (!id.success || !input.success) return failure(c, 400, 'invalid_request', 'Expected operation UUID and empty JSON object');
    try {
      const envelope = await operations.execute(id.data, operation, () =>
        operation === 'seed' ? seed(database) : resetDatabase(database),
      );
      return c.json(envelope, envelope.ok ? 200 : envelope.error.code === 'unavailable' ? 500 : 400);
    } catch (error) {
      if (error instanceof OperationError) return failure(c, 409, error.code, error.message);
      throw error;
    }
  };
  app.post('/api/__agent/db/seed', (c) => write(c, 'seed'));
  app.post('/api/__agent/db/reset', (c) => write(c, 'reset'));
  app.get('/api/__agent/operations/:id', (c) => {
    const id = operationId.safeParse(c.req.param('id'));
    if (!id.success) return failure(c, 400, 'invalid_request', 'Expected operation UUID');
    const receipt = operations.get(id.data);
    return receipt ? c.json({ ok: true, data: receipt }) : failure(c, 404, 'not_found', 'Operation not found');
  });
  app.post('/api/__agent/operations/:id/cancel', async (c) => {
    const id = operationId.safeParse(c.req.param('id'));
    const input = z
      .object({ operation: z.enum(['seed', 'reset']) })
      .strict()
      .safeParse(await c.req.json().catch(() => null));
    if (!id.success || !input.success) return failure(c, 400, 'invalid_request', 'Expected operation UUID and {operation}');
    try {
      return c.json({ ok: true, data: operations.cancel(id.data, input.data.operation) });
    } catch (error) {
      if (error instanceof OperationError) return failure(c, 409, error.code, error.message);
      throw error;
    }
  });
  app.get('/api/__agent/db/snapshot', (c) => run(c, () => snapshotDatabase(database)));
}
