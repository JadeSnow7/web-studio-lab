import { test } from 'node:test';
import assert from 'node:assert/strict';
import { z } from 'zod';

// 模拟 agent 构建：vite 在构建期把该常量替换为字面量。
(globalThis as { __WSL_AGENT_BUILD__?: boolean }).__WSL_AGENT_BUILD__ = true;
const { defineCommand, exposeState } = await import('../src/agent/registry.js');
const { handleAgentRequest, mountAgentBridge } = await import('../src/agent/bridge.js');
const { agentCommands } = await import('../src/agent/commands.js');

const call = async (request: unknown) => JSON.parse(await handleAgentRequest(JSON.stringify(request))) as Record<string, unknown>;

test('bridge 只调用已登记命令，输入经目录 schema 校验并返回可读错误', async () => {
  let calls = 0;
  const release = defineCommand('health.refresh', {
    input: agentCommands['health.refresh'].input,
    run: () => {
      calls++;
      return { refreshed: true };
    },
  });
  try {
    assert.deepEqual(await call({ op: 'invoke', name: 'health.refresh', input: {} }), { ok: true, data: { refreshed: true } });
    const invalid = await call({ op: 'invoke', name: 'health.refresh', input: { extra: 1 } });
    assert.equal((invalid.error as { code: string }).code, 'command_invalid_input');
    assert.ok(((invalid.error as { issues: unknown[] }).issues ?? []).length > 0);
    assert.equal(((await call({ op: 'invoke', name: 'unknown.command', input: {} })).error as { code: string }).code, 'command_not_found');
    assert.equal(((await call({ op: 'eval', code: '1' })).error as { code: string }).code, 'invalid_request');
    assert.equal(((await handleAgentRequest('not json')) as string).includes('invalid_request'), true);
    assert.equal(calls, 1, '非法输入与未知命令不执行');
    assert.throws(() => defineCommand('health.refresh', { input: agentCommands['health.refresh'].input, run: () => null }), /重复注册/);
    assert.throws(() => defineCommand('health.refresh', { input: z.object({}).strict() as never, run: () => null }), /不一致/);
    assert.throws(() => defineCommand('not.listed' as never, { input: z.object({}) as never, run: () => null }), /未在/);
  } finally {
    release();
  }
  assert.equal(((await call({ op: 'invoke', name: 'health.refresh', input: {} })).error as { code: string }).code, 'command_not_found');
});

test('状态只读快照、描述与不可替换的挂载点', async () => {
  let value = { status: 'ok' };
  const release = exposeState('app.health', () => value);
  try {
    assert.throws(() => exposeState('app.health', () => null), /重复注册/);
    assert.throws(() => exposeState('Bad Name', () => null), /无效/);
    assert.deepEqual(await call({ op: 'describe' }), { ok: true, data: { version: 1, commands: [], states: ['app.health'] } });
    value = { status: 'error' };
    assert.deepEqual(await call({ op: 'state' }), { ok: true, data: { 'app.health': { status: 'error' } } });
    assert.equal(((await call({ op: 'state', names: ['missing'] })).error as { code: string }).code, 'state_not_found');
    const target: Record<string, unknown> = {};
    mountAgentBridge(target);
    const bridge = target.__WSL_AGENT__ as { id: string; call: unknown };
    assert.equal(bridge.id, 'wsl-agent-bridge/v1');
    assert.throws(() => {
      (target as { __WSL_AGENT__: unknown }).__WSL_AGENT__ = null;
    });
    mountAgentBridge(target);
    assert.equal(target.__WSL_AGENT__, bridge);
  } finally {
    release();
  }
});

test('结果超过预算或不可序列化时返回 command_failed', async () => {
  const release = exposeState('big.value', () => 'x'.repeat(70000));
  try {
    assert.equal(((await call({ op: 'state', names: ['big.value'] })).error as { code: string }).code, 'command_failed');
  } finally {
    release();
  }
});
