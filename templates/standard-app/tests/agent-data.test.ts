import { randomUUID } from 'node:crypto';
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createApp } from '../server/app.js';
import { openDatabase, migrateDatabase, seedDatabase } from '../server/db.js';
import { AgentDataError, readOnlyQuery } from '../server/agent/data.js';

type Envelope = { ok: boolean; data?: Record<string, unknown>; error?: { code: string; message: string } };

test('只读事务是第二道防线：绕过静态检查的写函数仍被拒绝', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'wsl-agent-tx-'));
  const database = await openDatabase(dir);
  try {
    await database.client.query('CREATE SEQUENCE probe_seq');
    await assert.rejects(readOnlyQuery(database, "SELECT setval('probe_seq', 42)", 10), (error: unknown) => {
      assert.ok(error instanceof AgentDataError);
      assert.equal(error.code, 'write_rejected');
      return true;
    });
    assert.deepEqual((await database.client.query('SELECT last_value::int AS v FROM probe_seq')).rows, [{ v: 1 }]);
  } finally {
    await database.client.close();
    await rm(dir, { recursive: true, force: true });
  }
});

test('/api/__agent 端点只在提供令牌时挂载，并要求同值令牌', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'wsl-agent-routes-'));
  const database = await openDatabase(dir);
  const identity = { workspaceId: 'w', environmentId: 'sandbox', projectId: 'p', appInstanceId: 'instance-1' };
  const token = 'a'.repeat(64);
  try {
    await migrateDatabase(database);
    await seedDatabase(database);
    const plain = createApp(database, identity, true);
    assert.equal((await plain.request('/api/__agent/describe', { headers: { 'x-wsl-agent-token': token } })).status, 404);
    const app = createApp(database, identity, true, { token, root: process.cwd() });
    assert.equal((await app.request('/api/__agent/describe')).status, 403);
    assert.equal((await app.request('/api/__agent/describe', { headers: { 'x-wsl-agent-token': 'b'.repeat(64) } })).status, 403);
    const headers = { 'x-wsl-agent-token': token, 'content-type': 'application/json' };
    const describe = (await (await app.request('/api/__agent/describe', { headers })).json()) as Envelope;
    assert.equal(describe.ok, true);
    assert.equal(describe.data?.appInstanceId, 'instance-1');
    assert.match(String(describe.data?.currentRevision), /^[a-f0-9]{64}$/);
    const write = await app.request('/api/__agent/db/query', {
      method: 'POST',
      headers,
      body: JSON.stringify({ sql: 'DELETE FROM records' }),
    });
    assert.equal(write.status, 400);
    assert.equal(((await write.json()) as Envelope).error?.code, 'write_rejected');
    const query = await app.request('/api/__agent/db/query', {
      method: 'POST',
      headers,
      body: JSON.stringify({ sql: "SELECT value FROM records WHERE user_id = 'B'", limit: 5 }),
    });
    assert.deepEqual(((await query.json()) as Envelope).data?.rows, [{ value: 'Ready' }]);
    const reset = (await (
      await app.request('/api/__agent/db/reset', {
        method: 'POST',
        headers: { ...headers, 'x-wsl-agent-operation-id': randomUUID() },
        body: '{}',
      })
    ).json()) as Envelope;
    assert.equal(reset.ok, true);
    const snapshot = (await (await app.request('/api/__agent/db/snapshot', { headers })).json()) as Envelope;
    assert.ok(((snapshot.data?.tables as Record<string, { rowCount: number }>).records?.rowCount ?? 0) >= 2);
    assert.equal((await app.request('/api/health')).status, 200);
    const health = (await (await app.request('/api/health')).json()) as { templateVersion: string };
    assert.equal(health.templateVersion, '1.1.0');
  } finally {
    await database.client.close();
    await rm(dir, { recursive: true, force: true });
  }
});

test('real JSONB snapshot retains nested content, stabilizes keys/rows, hashes beyond sample', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'wsl-agent-jsonb-'));
  const database = await openDatabase(dir);
  try {
    const { snapshotDatabase } = await import('../server/agent/data.js');
    await database.client.query('CREATE TABLE nested (id int PRIMARY KEY, payload jsonb)');
    const payload = { outer: { second: 2, first: 1 }, array: [{ nested: true }, 'text', 3, null] };
    await database.client.query('INSERT INTO nested VALUES (1, $1)', [JSON.stringify(payload)]);
    const first = (await snapshotDatabase(database)).tables.nested!;
    assert.deepEqual(first.sample, [{ id: 1, payload }]);
    await database.client.query('UPDATE nested SET payload = $1', [
      JSON.stringify({ array: payload.array, outer: { first: 1, second: 2 } }),
    ]);
    assert.equal((await snapshotDatabase(database)).tables.nested!.sha256, first.sha256);
    await database.client.query("UPDATE nested SET payload = jsonb_set(payload, '{outer,first}', '9')");
    assert.notEqual((await snapshotDatabase(database)).tables.nested!.sha256, first.sha256);
    await database.client.query('UPDATE nested SET payload = $1', [JSON.stringify({ ...payload, array: [...payload.array].reverse() })]);
    assert.notEqual((await snapshotDatabase(database)).tables.nested!.sha256, first.sha256);
    await database.client.query('TRUNCATE nested');
    await database.client.query(
      "INSERT INTO nested SELECT i, jsonb_build_object('nested',jsonb_build_object('value', i)) FROM generate_series(1,25) i",
    );
    const many = (await snapshotDatabase(database)).tables.nested!;
    assert.equal(many.sample.length, 20);
    assert.equal(many.rowCount, 25);
    const excluded = Array.from({ length: 25 }, (_, i) => i + 1).find(
      (id) => !many.sample.some((row) => (row as { id: number }).id === id),
    )!;
    await database.client.query("UPDATE nested SET payload = jsonb_set(payload, '{nested,value}', '999') WHERE id = $1", [excluded]);
    const changed = (await snapshotDatabase(database)).tables.nested!;
    assert.notEqual(changed.sha256, many.sha256);
    await database.client.query('CREATE TABLE reordered AS SELECT * FROM nested ORDER BY id DESC');
    assert.equal((await snapshotDatabase(database)).tables.reordered!.sha256, changed.sha256);
  } finally {
    await database.client.close();
    await rm(dir, { recursive: true, force: true });
  }
});
