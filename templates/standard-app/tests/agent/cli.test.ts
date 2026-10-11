import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { promisify } from 'node:util';

const execute = promisify(execFile);
type Envelope = { ok: boolean; data?: Record<string, unknown>; error?: { code: string; message: string } };

async function cli(dataDir: string, ...args: string[]): Promise<{ exit: number; envelope: Envelope }> {
  const env = { ...process.env, WSL_DATA_DIR: dataDir, WSL_AGENT_URL: '', WSL_AGENT_TOKEN: '' };
  try {
    const { stdout } = await execute(process.execPath, ['--import', 'tsx', 'server/agent-cli.ts', ...args, '--json'], {
      env,
      timeout: 60000,
    });
    return { exit: 0, envelope: JSON.parse(stdout.trim().split('\n').at(-1)!) as Envelope };
  } catch (error) {
    const failure = error as { code: number; stdout: string };
    return { exit: failure.code, envelope: JSON.parse(failure.stdout.trim().split('\n').at(-1)!) as Envelope };
  }
}

const welcome = (rows: unknown) => (rows as { key: string; value: string }[]).find((row) => row.key === 'welcome')?.value;

test('agent-cli 直连模式：只读查询拒绝写入，seed/reset/snapshot 只作用于本实例数据目录', async () => {
  const one = await mkdtemp(join(tmpdir(), 'wsl-agent-a-'));
  const two = await mkdtemp(join(tmpdir(), 'wsl-agent-b-'));
  try {
    for (const dir of [one, two]) assert.equal((await cli(dir, 'db', 'seed')).exit, 0);
    const select = await cli(one, 'db', 'query', "SELECT key, value FROM records WHERE user_id = 'A'");
    assert.equal(select.exit, 0);
    assert.equal(welcome(select.envelope.data?.rows), 'Ready');
    for (const sql of [
      "INSERT INTO records VALUES ('A', 'x', 'y')",
      'SELECT 1; DELETE FROM records',
      'WITH gone AS (DELETE FROM records RETURNING *) SELECT * FROM gone',
      'DROP TABLE records',
      "UPDATE records SET value = 'z'",
    ]) {
      const rejected = await cli(one, 'db', 'query', sql);
      assert.equal(rejected.exit, 1, sql);
      assert.equal(rejected.envelope.ok, false);
      assert.equal(rejected.envelope.error?.code, 'write_rejected', sql);
    }
    const count = await cli(one, 'db', 'query', 'SELECT count(*)::int AS n FROM records');
    assert.deepEqual(count.envelope.data?.rows, [{ n: 2 }]);

    const put = await cli(one, 'api', 'call', 'PUT', '/api/kv/welcome', '--body', '{"value":"changed"}', '--as', 'A');
    assert.equal(put.exit, 0);
    assert.equal(put.envelope.data?.status, 200);
    await cli(two, 'api', 'call', 'PUT', '/api/kv/welcome', '--body', '{"value":"other instance"}', '--as', 'A');
    const before = await cli(one, 'db', 'snapshot');
    assert.equal((before.envelope.data?.tables as Record<string, { rowCount: number }>).sessions?.rowCount, 1);

    const reset = await cli(one, 'db', 'reset');
    assert.equal(reset.exit, 0);
    assert.deepEqual(reset.envelope.data?.truncated, ['records', 'sessions']);
    const after = await cli(one, 'db', 'query', "SELECT key, value FROM records WHERE user_id = 'A'");
    assert.equal(welcome(after.envelope.data?.rows), 'Ready');
    const other = await cli(two, 'db', 'query', "SELECT key, value FROM records WHERE user_id = 'A'");
    assert.equal(welcome(other.envelope.data?.rows), 'other instance', '另一实例数据目录不受影响');
    const snapshot = await cli(one, 'db', 'snapshot');
    assert.equal((snapshot.envelope.data?.tables as Record<string, { rowCount: number }>).sessions?.rowCount, 0);
  } finally {
    await rm(one, { recursive: true, force: true });
    await rm(two, { recursive: true, force: true });
  }
});

test('agent-cli 拒绝打开运行中实例占用的数据目录、越界路由和未知命令', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'wsl-agent-lock-'));
  try {
    await writeFile(`${dir}.runtime.json`, JSON.stringify({ pid: process.pid, port: 1, appInstanceId: 'x' }));
    const locked = await cli(dir, 'db', 'query', 'SELECT 1');
    assert.equal(locked.exit, 3);
    assert.equal(locked.envelope.error?.code, 'app_running');
    await writeFile(`${dir}.runtime.json`, JSON.stringify({ pid: 2147483646, port: 1, appInstanceId: 'x' }));
    assert.equal((await cli(dir, 'db', 'query', 'SELECT 1 AS one')).exit, 0, '残留运行文件的进程已不存在时允许');
    const agentRoute = await cli(dir, 'api', 'call', 'GET', '/api/__agent/describe');
    assert.equal(agentRoute.exit, 2);
    assert.equal((await cli(dir, 'api', 'call', 'GET', '/outside')).exit, 2);
    assert.equal((await cli(dir, 'shell', 'rm')).exit, 2);
    assert.equal((await cli(dir, 'db', 'query')).exit, 2);
  } finally {
    await rm(`${dir}.runtime.json`, { force: true });
    await rm(dir, { recursive: true, force: true });
  }
});
