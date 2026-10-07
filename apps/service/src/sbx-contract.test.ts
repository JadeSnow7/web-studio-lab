import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import * as protocol from '@wsl/protocol';
import { CodexChat } from './codex-chat';

// 本阶段只建立新路由的失败基准；宿主 Codex 始终指向无模型 fixture。
afterEach(() => vi.unstubAllEnvs());
describe('sbx 唯一路由的配置边界', () => {
  it.each([
    { name: '', binary: '' },
    { name: 'fixture-sandbox', binary: '/missing/wsl-sbx' },
  ])('配置 $name / $binary 不可用时不得回退宿主 Codex', async ({ name, binary }) => {
    vi.stubEnv('WSL_CODEX_BIN', path.resolve('e2e/fixtures/codex.mjs'));
    vi.stubEnv('WSL_SBX_NAME', name);
    vi.stubEnv('WSL_SBX_BIN', binary);
    const root = await mkdtemp(path.join(tmpdir(), 'wsl-sbx-contract-'));
    const chat = new CodexChat(root, () => undefined);
    try {
      const status = await chat.initialize();
      expect(status.available).toBe(false);
      expect(status.reason).toMatch(/sbx|sandbox|沙箱/i);
      await expect(chat.send('conv-personal-default', '不得在 host 执行')).rejects.toThrow();
    } finally {
      await chat.shutdown();
      await rm(root, { recursive: true, force: true });
    }
  });
});

describe('UI 所需 sbx 与终端跨进程契约', () => {
  it('聊天状态保留选定 sandbox 与 guest cwd', () => {
    const status = protocol.ChatStatusSchema.parse({
      available: true,
      reason: null,
      version: 'codex-cli fixture',
      sandbox: 'fixture-sandbox',
      cwd: '/home/agent/workspace',
    });
    expect(status).toMatchObject({ sandbox: 'fixture-sandbox', cwd: '/home/agent/workspace' });
  });
  it('终端 open / 输入 / resize / close 和状态事件均有 schema', () => {
    const channels = protocol.invokeChannels as Record<string, unknown>;
    for (const name of ['terminal:get', 'terminal:open', 'terminal:write', 'terminal:resize', 'terminal:close']) {
      expect(channels[name], name).toBeDefined();
    }
    expect((protocol.eventChannels as Record<string, unknown>)['terminal:state']).toBeDefined();
  });
});
