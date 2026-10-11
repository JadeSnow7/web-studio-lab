import { test } from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Hono } from 'hono';
import { mountAgentRoutes } from '../server/agent/routes.js';
import { openDatabase, migrateDatabase } from '../server/db.js';
const token = 'a'.repeat(64);
const headers = { 'x-wsl-agent-token': token, 'content-type': 'application/json' };
async function fixture() {
  const dir = await mkdtemp(join(tmpdir(), 'wsl-operations-'));
  const database = await openDatabase(dir);
  await migrateDatabase(database);
  const app = new Hono();
  mountAgentRoutes(app, database, { token, root: process.cwd(), appInstanceId: 'instance-one' });
  const cancel = (id: string, operation = 'seed') =>
    app.request(`/api/__agent/operations/${id}/cancel`, { method: 'POST', headers, body: JSON.stringify({ operation }) });
  const write = (id: string, operation = 'seed') =>
    app.request(`/api/__agent/db/${operation}`, { method: 'POST', headers: { ...headers, 'x-wsl-agent-operation-id': id }, body: '{}' });
  const receipt = async (id: string) =>
    (await (await app.request(`/api/__agent/operations/${id}`, { headers })).json()) as {
      data: { state: string; appInstanceId: string; operationId: string; envelope: unknown };
    };
  return {
    database,
    app,
    cancel,
    write,
    receipt,
    close: async () => {
      await database.client.close();
      await rm(dir, { recursive: true, force: true });
    },
  };
}
for (const operation of ['seed', 'reset'] as const)
  test(`${operation}: registered work remains running after cancel and executes once on replay`, async () => {
    const f = await fixture();
    const query = f.database.client.query.bind(f.database.client);
    let release!: () => void;
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    let entered!: () => void;
    const started = new Promise<void>((resolve) => {
      entered = resolve;
    });
    let inserts = 0;
    f.database.client.query = (async (...args: Parameters<typeof query>) => {
      if ((operation === 'seed' ? /insert into/i : /SELECT tablename/i).test(args[0])) {
        inserts++;
        entered();
        await gate;
      }
      return query(...args);
    }) as typeof f.database.client.query;
    try {
      const id = randomUUID();
      const original = f.write(id, operation);
      await started;
      assert.equal((await f.receipt(id)).data.state, 'running');
      assert.equal(((await (await f.cancel(id, operation)).json()) as { data: { state: string } }).data.state, 'running');
      const replay = f.write(id, operation);
      assert.equal((await f.write(id, operation === 'seed' ? 'reset' : 'seed')).status, 409);
      release();
      const expected = await (await original).json();
      assert.deepEqual(await (await replay).json(), expected);
      assert.deepEqual(await (await f.write(id, operation)).json(), expected);
      assert.equal(inserts, 1);
      const terminal = (await f.receipt(id)).data;
      assert.equal(terminal.appInstanceId, 'instance-one');
      assert.equal(terminal.operationId, id);
      assert.equal(terminal.state, 'succeeded');
      assert.deepEqual(terminal.envelope, expected);
    } finally {
      release();
      await f.close();
    }
  });
test('cancel before admission blocks late POST, validates auth/input, retains capacity identities', async () => {
  const f = await fixture();
  try {
    const id = randomUUID();
    assert.equal((await f.app.request(`/api/__agent/operations/${id}`, { headers })).status, 404);
    assert.equal(
      (await f.app.request(`/api/__agent/operations/${id}`, { headers: { ...headers, 'x-wsl-agent-token': 'b'.repeat(64) } })).status,
      403,
    );
    assert.equal((await f.cancel('bad')).status, 400);
    assert.equal((await f.cancel(id, 'invalid')).status, 400);
    assert.equal((await f.write('bad')).status, 400);
    assert.equal((await f.app.request('/api/__agent/db/seed', { method: 'POST', headers, body: '{}' })).status, 400);
    assert.equal(
      (
        await f.app.request('/api/__agent/db/seed', {
          method: 'POST',
          headers: { ...headers, 'x-wsl-agent-operation-id': id },
          body: '{"extra":true}',
        })
      ).status,
      400,
    );
    assert.equal(
      (
        await f.app.request(`/api/__agent/operations/${id}/cancel`, {
          method: 'POST',
          headers: { ...headers, 'x-wsl-agent-token': 'b'.repeat(64) },
          body: '{"operation":"seed"}',
        })
      ).status,
      403,
    );
    assert.equal(((await (await f.cancel(id)).json()) as { data: { state: string } }).data.state, 'cancelled_before_start');
    assert.equal((await f.cancel(id, 'reset')).status, 409);
    assert.equal(((await (await f.write(id)).json()) as { error: { code: string } }).error.code, 'cancelled');
    assert.equal((await f.database.client.query<{ n: number }>('SELECT count(*)::int AS n FROM records')).rows[0]?.n, 0);
    for (let i = 1; i < 1024; i++) assert.equal((await f.cancel(randomUUID())).status, 200);
    assert.equal((await f.write(randomUUID())).status, 409);
    assert.equal((await f.cancel(randomUUID())).status, 409);
    assert.equal((await f.receipt(id)).data.state, 'cancelled_before_start');
    assert.equal(
      ((await (await f.app.request('/api/__agent/describe', { headers })).json()) as { data: { operationTrackingVersion: number } }).data
        .operationTrackingVersion,
      1,
    );
  } finally {
    await f.close();
  }
});
test('database failure is a retained terminal result, no replay of side effects', async () => {
  const f = await fixture();
  try {
    await f.database.client.query('DROP TABLE records');
    const id = randomUUID();
    const response = await f.write(id);
    assert.equal(response.status, 500);
    const envelope = await response.json();
    assert.deepEqual(await (await f.write(id)).json(), envelope);
    assert.equal((await f.receipt(id)).data.state, 'failed');
    assert.deepEqual((await f.receipt(id)).data.envelope, envelope);
  } finally {
    await f.close();
  }
});
