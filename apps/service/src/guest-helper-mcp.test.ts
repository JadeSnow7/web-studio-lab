import { spawn } from 'node:child_process';
import { createInterface } from 'node:readline';
import { describe, expect, it } from 'vitest';
import helper from './guest-helper.py?raw';
import type { GuestFrame } from './sbx';

// W2：helper 不再按 argv 识别 Harness，只认 service 显式声明的 MCP 挂载方式。
// 两个用例都在启动任何子进程之前被拒绝，因此不需要真实 sandbox；但 helper 的 read_start 先要求 Linux
// 并调用 prctl，与 guest-workspace.test.ts 一样只在 Linux 上运行。
const armed = helper.replace('RESOURCE_MCP_BASE64 = ""', `RESOURCE_MCP_BASE64 = "${Buffer.from('# fixture').toString('base64')}"`);
const bundle = {
  conversationId: 'conv-personal-default',
  generation: 'g',
  turnId: 't',
  accountId: 'a',
  workspaceId: null,
  sessionId: 'conv-personal-default',
  catalogRevision: 0,
  resources: [],
};
async function run(start: Record<string, unknown>) {
  const child = spawn('python3', ['-u', '-c', armed], { stdio: ['pipe', 'pipe', 'pipe'] });
  const frames: GuestFrame[] = [];
  createInterface({ input: child.stdout }).on('line', (line) => {
    if (line.startsWith('WSL_GUEST_FRAME:')) frames.push(JSON.parse(line.slice('WSL_GUEST_FRAME:'.length)) as GuestFrame);
  });
  const done = new Promise<number | null>((resolve, reject) => {
    child.once('error', reject);
    child.once('close', resolve);
  });
  child.stdin.end(JSON.stringify(start) + '\n');
  await done;
  return frames;
}

describe.skipIf(process.platform !== 'linux')('guest helper 的 MCP 声明（W2）', () => {
  it('携带资料包但未声明 MCP 时拒绝，且不启动子进程', async () => {
    const frames = await run({ type: 'start', mode: 'codex', argv: ['codex', 'exec', '-'], resourceBundle: bundle });
    expect(frames.some((frame) => frame.type === 'ready')).toBe(false);
    expect(frames).toContainEqual(
      expect.objectContaining({ type: 'error', error: 'resource capability requires a declared MCP injection' }),
    );
  });
  it('未知的 MCP 声明在预检阶段拒绝', async () => {
    const frames = await run({ type: 'start', mode: 'codex', argv: ['codex', 'exec', '-'], mcp: 'other' });
    expect(frames.some((frame) => frame.type === 'ready')).toBe(false);
    expect(frames).toContainEqual(expect.objectContaining({ type: 'error', error: 'invalid MCP injection' }));
    expect(frames.at(-1)).toEqual({ type: 'cleanup', ok: true });
  });
  it.each([
    ['未声明的环境变量', { env: 'HOME', path: '/home/agent/.wsl-profiles/claude-code/a1b2c3d4-0000-4000-8000-00000000000a' }],
    ['根目录之外的路径', { env: 'CLAUDE_CONFIG_DIR', path: '/home/agent/.claude' }],
    ['路径穿越', { env: 'CLAUDE_CONFIG_DIR', path: '/home/agent/.wsl-profiles/claude-code/../../.ssh' }],
    ['多余字段', { env: 'CLAUDE_CONFIG_DIR', path: '/home/agent/.wsl-profiles/claude-code/a1b2c3d4-0000-4000-8000-00000000000a', mode: 1 }],
  ])('Profile 配置目录（W4a）：%s 在预检阶段拒绝', async (_label, profileDir) => {
    const frames = await run({ type: 'start', mode: 'codex', argv: ['codex', '--version'], profileDir });
    expect(frames.some((frame) => frame.type === 'ready')).toBe(false);
    expect(frames).toContainEqual(expect.objectContaining({ type: 'error', error: 'invalid profile directory' }));
  });
});
