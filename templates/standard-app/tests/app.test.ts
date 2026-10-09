import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createApp } from '../server/app.js';
import { openDatabase, migrateDatabase, seedDatabase } from '../server/db.js';

const identity = { workspaceId: 'test-space', environmentId: 'test-env', projectId: 'test-project', appInstanceId: 'test-instance' };

test('disk persistence, idempotent migration/seed, A/B isolation and input/session boundaries', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'wsl-template-'));
  let database = await openDatabase(directory);
  try {
    await migrateDatabase(database);
    await migrateDatabase(database);
    await seedDatabase(database);
    const app = createApp(database, identity, true);
    const health = await app.request('/api/health');
    assert.deepEqual((await health.json()).identity, identity);
    assert.equal((await app.request('/api/kv/welcome')).status, 401);
    assert.equal(
      (await app.request('/api/dev/session', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: '{' })).status,
      400,
    );
    assert.equal(
      (await app.request('/api/dev/session', { method: 'POST', headers: { 'Content-Type': 'text/plain' }, body: '{}' })).status,
      415,
    );
    assert.equal(
      (
        await app.request('/api/dev/session', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json', Origin: 'https://untrusted.example' },
          body: '{"userId":"A"}',
        })
      ).status,
      403,
    );
    const session = await app.request('/api/dev/session', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: '{"userId":"A"}',
    });
    const cookie = session.headers.get('set-cookie')?.split(';')[0];
    assert.ok(cookie);
    assert.match(session.headers.get('set-cookie') ?? '', /HttpOnly/);
    const put = await app.request('/api/kv/welcome', {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json', Cookie: cookie },
      body: '{"value":"kept across restart"}',
    });
    assert.equal(put.status, 200);
    await seedDatabase(database);
    const bSession = await app.request('/api/dev/session', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: '{"userId":"B"}',
    });
    const bCookie = bSession.headers.get('set-cookie')?.split(';')[0];
    assert.ok(bCookie);
    assert.equal((await (await app.request('/api/kv/welcome', { headers: { Cookie: bCookie } })).json()).value, 'Ready');
    assert.equal(
      (
        await app.request('/api/kv/welcome', {
          method: 'PUT',
          headers: { 'Content-Type': 'application/json', Cookie: cookie },
          body: '{"value":123}',
        })
      ).status,
      400,
    );
    assert.equal(
      (
        await createApp(database, identity, false).request('/api/dev/session', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: '{"userId":"A"}',
        })
      ).status,
      404,
    );
    await database.client.close();
    database = await openDatabase(directory);
    await migrateDatabase(database);
    await seedDatabase(database);
    const restarted = createApp(database, identity, true);
    assert.equal((await (await restarted.request('/api/kv/welcome', { headers: { Cookie: cookie } })).json()).value, 'kept across restart');
    assert.equal(
      (
        await createApp(database, { ...identity, appInstanceId: 'another-instance' }, true).request('/api/kv/welcome', {
          headers: { Cookie: cookie },
        })
      ).status,
      401,
    );
  } finally {
    await database.client.close();
    await rm(directory, { recursive: true, force: true });
  }
});
