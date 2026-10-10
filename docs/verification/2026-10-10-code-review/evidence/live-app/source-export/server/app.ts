import { createHash, randomBytes } from 'node:crypto';
import { Hono } from 'hono';
import { getCookie, setCookie } from 'hono/cookie';
import { bodyLimit } from 'hono/body-limit';
import { and, eq } from 'drizzle-orm';
import { z } from 'zod';
import type { Database } from './db.js';
import { records, sessions } from './schema.js';

export const identitySchema = z.object({
  workspaceId: z.string().min(1),
  environmentId: z.string().min(1),
  projectId: z.string().min(1),
  appInstanceId: z.string().min(1),
});
export type Identity = z.infer<typeof identitySchema>;
const userSchema = z.enum(['A', 'B']);
const keySchema = z.string().regex(/^[a-zA-Z0-9_-]{1,64}$/);

export function createApp(database: Database, identity: Identity, devSessions: boolean) {
  const app = new Hono<{ Variables: { userId: 'A' | 'B' } }>();
  // Cookies share a host across ports; bind the cookie name to this application instance.
  const cookieName = `wsl_${createHash('sha256').update(identity.appInstanceId).digest('hex').slice(0, 16)}`;
  app.use('/api/*', bodyLimit({ maxSize: 16 * 1024 }));
  app.use('/api/*', async (c, next) => {
    c.header('Cache-Control', 'no-store');
    if (['POST', 'PUT', 'PATCH', 'DELETE'].includes(c.req.method)) {
      if (!c.req.header('content-type')?.startsWith('application/json')) return c.json({ error: 'JSON content type required' }, 415);
      const origin = c.req.header('origin');
      if (origin && origin !== new URL(c.req.url).origin) return c.json({ error: 'Origin mismatch' }, 403);
    }
    await next();
  });
  app.get('/api/health', async (c) => {
    await database.client.query('SELECT 1');
    return c.json({ ok: true, templateId: 'wsl-standard-app', templateVersion: '1.0.0', identity });
  });
  app.post('/api/dev/session', async (c) => {
    if (!devSessions) return c.json({ error: 'Development sessions disabled' }, 404);
    const input = z
      .object({ userId: userSchema })
      .strict()
      .safeParse(await c.req.json().catch(() => null));
    if (!input.success) return c.json({ error: 'Expected userId A or B' }, 400);
    const token = randomBytes(32).toString('hex');
    await database.db.insert(sessions).values({ token, userId: input.data.userId, expiresAt: Date.now() + 8 * 60 * 60 * 1000 });
    setCookie(c, cookieName, token, { httpOnly: true, sameSite: 'Strict', path: '/api', maxAge: 8 * 60 * 60 });
    return c.json({ userId: input.data.userId });
  });
  app.use('/api/kv/*', async (c, next) => {
    const token = getCookie(c, cookieName);
    if (!token) return c.json({ error: 'Development session required' }, 401);
    const [session] = await database.db.select().from(sessions).where(eq(sessions.token, token));
    const userId = userSchema.safeParse(session?.userId);
    if (!session || session.expiresAt <= Date.now() || !userId.success) return c.json({ error: 'Invalid session' }, 401);
    c.set('userId', userId.data);
    await next();
  });
  app.get('/api/kv/:key', async (c) => {
    const key = keySchema.safeParse(c.req.param('key'));
    if (!key.success) return c.json({ error: 'Invalid key' }, 400);
    const [record] = await database.db
      .select()
      .from(records)
      .where(and(eq(records.userId, c.get('userId')), eq(records.key, key.data)));
    if (!record) return c.json({ error: 'Key not found' }, 404);
    return c.json(record);
  });
  app.put('/api/kv/:key', async (c) => {
    const key = keySchema.safeParse(c.req.param('key'));
    const input = z
      .object({ value: z.string().max(4096) })
      .strict()
      .safeParse(await c.req.json().catch(() => null));
    if (!key.success || !input.success) return c.json({ error: 'Invalid key or value' }, 400);
    const record = { userId: c.get('userId'), key: key.data, value: input.data.value };
    await database.db
      .insert(records)
      .values(record)
      .onConflictDoUpdate({ target: [records.userId, records.key], set: { value: record.value } });
    return c.json(record);
  });
  app.all('/api/*', (c) => c.json({ error: 'API route not found' }, 404));
  return app;
}
