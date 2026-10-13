import { setTimeout, clearTimeout } from 'node:timers';
import { URL } from 'node:url';
import process from 'node:process';
import console from 'node:console';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
const dataDir = await mkdtemp(join(tmpdir(), 'wsl-template-http-'));
const identity = { workspaceId: 'http-space', environmentId: 'http-env', projectId: 'http-project', appInstanceId: 'http-instance' };
const env = {
  ...process.env,
  HOST: '127.0.0.1',
  PORT: '0',
  WSL_DATA_DIR: dataDir,
  WSL_DEV_SESSIONS: '1',
  WSL_WORKSPACE_ID: identity.workspaceId,
  WSL_ENVIRONMENT_ID: identity.environmentId,
  WSL_PROJECT_ID: identity.projectId,
  WSL_APP_INSTANCE_ID: identity.appInstanceId,
};
const processes = [];
async function launch() {
  const child = spawn(process.execPath, ['dist/server/index.js'], { env, stdio: ['ignore', 'pipe', 'pipe'] });
  processes.push(child);
  const exit = new Promise((resolve) => child.once('exit', (code, signal) => resolve({ code, signal })));
  let output = '';
  let errors = '';
  child.stderr.on('data', (data) => {
    errors += data;
  });
  const ready = new Promise((resolve, reject) => {
    const timeout = setTimeout(() => reject(new Error(`App readiness timeout: ${errors}`)), 20000);
    child.on('error', (error) => {
      clearTimeout(timeout);
      reject(error);
    });
    child.once('exit', () => {
      clearTimeout(timeout);
      reject(new Error(`App exited before ready: ${errors}`));
    });
    child.stdout.on('data', (data) => {
      output += data;
      for (const line of output.split('\n').slice(0, -1)) {
        try {
          const message = JSON.parse(line);
          if (message.event === 'app-ready') {
            clearTimeout(timeout);
            resolve(message);
            return;
          }
        } catch {
          /* Node diagnostics are not app-ready records. */
        }
      }
    });
  });
  const message = await ready;
  assert.deepEqual(message.identity, identity);
  return { child, exit, url: `http://127.0.0.1:${message.port}` };
}
async function stop(instance) {
  instance.child.kill('SIGTERM');
  let timeout;
  const outcome = await Promise.race([
    instance.exit,
    new Promise((_, reject) => {
      timeout = setTimeout(() => reject(new Error('Shutdown timeout')), 10000);
    }),
  ]).finally(() => clearTimeout(timeout));
  assert.equal(outcome.code, 0);
  await assert.rejects(globalThis.fetch(`${instance.url}/api/health`));
}
try {
  const first = await launch();
  const page = await globalThis.fetch(first.url);
  assert.equal(page.status, 200);
  const html = await page.text();
  assert.match(html, /标准应用/);
  const asset = html.match(/src="([^"]+\.js)"/)?.[1];
  assert.ok(asset);
  assert.equal((await globalThis.fetch(new URL(asset, first.url))).status, 200);
  assert.deepEqual((await (await globalThis.fetch(`${first.url}/api/health`)).json()).identity, identity);
  const response = await globalThis.fetch(`${first.url}/api/dev/session`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: '{"userId":"A"}',
  });
  const cookie = response.headers.get('set-cookie')?.split(';')[0];
  assert.ok(cookie);
  assert.equal(
    (
      await globalThis.fetch(`${first.url}/api/kv/probe`, {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json', Cookie: cookie },
        body: '{"value":"persisted over SIGTERM"}',
      })
    ).status,
    200,
  );
  await stop(first);
  const second = await launch();
  assert.equal(
    (await (await globalThis.fetch(`${second.url}/api/kv/probe`, { headers: { Cookie: cookie } })).json()).value,
    'persisted over SIGTERM',
  );
  await stop(second);
  console.log(
    JSON.stringify({
      ok: true,
      checks: [
        'production-static-html-and-js',
        'identity-health',
        'A-session-write',
        'SIGTERM-and-port-release',
        'disk-persistence-after-restart',
      ],
      identity,
    }),
  );
} finally {
  for (const child of processes) if (child.exitCode === null && child.signalCode === null) child.kill('SIGKILL');
  await rm(dataDir, { recursive: true, force: true });
}
