import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { promisify } from 'node:util';
import { build } from 'vite';

const execute = promisify(execFile);

async function scan(directory: string, expectPresent: boolean) {
  try {
    const { stdout } = await execute(process.execPath, [
      'scripts/agent-exclusion-check.mjs',
      directory,
      ...(expectPresent ? ['--expect-present'] : []),
    ]);
    return { exit: 0, report: JSON.parse(stdout) as { found: { marker: string }[] } };
  } catch (error) {
    const failure = error as { code: number; stdout: string };
    return { exit: failure.code, report: JSON.parse(failure.stdout) as { found: { marker: string }[] } };
  }
}

test('生产构建不含 Agent 桥接与注册表入口；agent 构建包含，检查脚本能区分', async () => {
  const root = await mkdtemp(join(tmpdir(), 'wsl-agent-build-'));
  try {
    for (const mode of ['production', 'agent'] as const)
      await build({ mode, logLevel: 'silent', build: { outDir: join(root, mode), emptyOutDir: true } });
    const production = await scan(join(root, 'production'), false);
    assert.equal(production.exit, 0, JSON.stringify(production.report));
    assert.deepEqual(production.report.found, []);
    const agent = await scan(join(root, 'agent'), true);
    assert.equal(agent.exit, 0);
    assert.ok(agent.report.found.some((item) => item.marker === '__WSL_AGENT__'));
    // 反例：把 agent 产物当生产产物检查必须失败。
    assert.equal((await scan(join(root, 'agent'), false)).exit, 1);
    assert.equal((await scan(join(root, 'production'), true)).exit, 1);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
