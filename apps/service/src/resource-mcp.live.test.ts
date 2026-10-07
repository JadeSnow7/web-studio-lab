import { spawnSync } from 'node:child_process';
import { describe, expect, it } from 'vitest';
import { SbxConnection } from './sbx';
import helper from './guest-helper.py?raw';
const live = process.env['WSL_LIVE_SBX'] === '1';
describe.skipIf(!live)('真实 sandbox 的资源 helper（不调模型）', () => {
  it('固定资源配置注入后 Codex 帮助命令与 helper 正常收尾', async () => {
    const connection = new SbxConnection();
    expect((await connection.initialize()).available).toBe(true);
    let output = '';
    const child = connection.start(
      {
        type: 'start',
        mode: 'codex',
        argv: ['codex', 'exec', '--help'],
        resourceBundle: {
          conversationId: 'conv-personal-default',
          generation: 'probe',
          turnId: 'probe',
          spaceId: null,
          collectionRevision: 0,
          resources: [],
        },
      },
      (frame) => {
        if (frame.type === 'output') output += frame.data;
      },
    );
    const outcome = await child.done;
    expect(outcome.error).toBeNull();
    expect(outcome.confirmed).toBe(true);
    expect(outcome.exitCode).toBe(0);
    expect(output).toContain('Usage:');
    await connection.shutdown();
  }, 60000);
  it('非法 start frame 在启动子进程前返回明确 error 与 cleanup', () => {
    const result = spawnSync(
      process.env['WSL_SBX_BIN']!,
      ['exec', '-i', '-w', '/home/agent/workspace', process.env['WSL_SBX_NAME']!, 'python3', '-I', '-u', '-c', helper],
      {
        input: JSON.stringify({ type: 'start', mode: 'codex', argv: ['codex', '--version'], forbidden: true }) + '\n',
        encoding: 'utf8',
        timeout: 30000,
      },
    );
    expect(result.status, result.stderr).toBe(0);
    const frames = result.stdout
      .split('\n')
      .filter((line) => line.startsWith('WSL_GUEST_FRAME:'))
      .map((line) => JSON.parse(line.slice('WSL_GUEST_FRAME:'.length)));
    expect(frames).toEqual([
      { type: 'error', error: 'unknown start fields' },
      { type: 'cleanup', ok: true },
    ]);
  }, 35000);
});
