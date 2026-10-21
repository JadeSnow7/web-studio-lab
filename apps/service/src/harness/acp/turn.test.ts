import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { createInterface } from 'node:readline';
import { describe, expect, it } from 'vitest';
import { HarnessDescriptorSchema } from '@wsl/protocol';
import type { HarnessEvent } from '../types';
import { codexAdapter } from '../codex/adapter';
import { AcpTurn, type PermissionDecider } from './turn';
import { acpDescriptor, claudeCodeAcp } from './agents';

const fixture = fileURLToPath(new URL('../../fixtures/fake-acp-agent.mjs', import.meta.url));

async function drive(
  scenario: string,
  options: {
    sessionRef?: string | null;
    decide?: (controller: AbortController) => PermissionDecider;
    abortWhen?: (events: HarnessEvent[]) => boolean;
  } = {},
) {
  const child = spawn(process.execPath, [fixture, scenario], { stdio: ['pipe', 'pipe', 'inherit'] });
  const exited = new Promise<number | null>((resolve) => child.once('close', resolve));
  const controller = new AbortController();
  const events: HarnessEvent[] = [];
  const written: unknown[] = [];
  let protocolError: Error | null = null;
  const turn = new AcpTurn(
    (line) => {
      written.push(JSON.parse(line));
      child.stdin.write(line);
    },
    (event) => {
      events.push(event);
      if (options.abortWhen?.(events)) controller.abort();
    },
    {
      cwd: '/home/agent/workspace',
      mcpServers: [],
      sessionRef: options.sessionRef ?? null,
      prompt: '你好',
      signal: controller.signal,
      decidePermission: options.decide?.(controller),
    },
  );
  createInterface({ input: child.stdout }).on('line', (line) => {
    try {
      turn.receive(line);
    } catch (error) {
      protocolError ??= error as Error;
      turn.close((error as Error).message);
    }
  });
  const outcome = await turn.run().then(
    (result) => ({ ok: true as const, result }),
    (error: Error) => ({ ok: false as const, error }),
  );
  child.stdin.end();
  const code = await exited;
  return { events, outcome, protocolError: protocolError as Error | null, code, written, turn };
}

/** 两种适配器共用的最小契约：先报会话身份，至少一条助手消息，以完成事件结束，没有失败事件。 */
function expectReplyContract(events: HarnessEvent[]) {
  expect(events[0]).toMatchObject({ type: 'session' });
  expect(events.some((event) => event.type === 'message' && event.text.trim())).toBe(true);
  expect(events.at(-1)).toEqual({ type: 'turn_completed' });
  expect(events.some((event) => event.type === 'turn_failed')).toBe(false);
}

describe('Harness 契约：Codex native 与 ACP 共用断言（W3a）', () => {
  it('Codex 的 JSONL 回复满足契约', () => {
    const lines = [
      { type: 'thread.started', thread_id: 't' },
      { type: 'turn.started' },
      { type: 'item.completed', item: { id: 'm', type: 'agent_message', text: '你好' } },
      { type: 'turn.completed', usage: {} },
    ];
    expectReplyContract(lines.flatMap((line) => codexAdapter.parseLine(JSON.stringify(line)) ?? []));
  });
  it('ACP 回复满足契约，消息按 messageId 合并，工具完成后记录一次', async () => {
    const { events, outcome, code } = await drive('reply');
    expect(outcome).toMatchObject({ ok: true, result: { stopReason: 'end_turn', sessionId: 'sess-reply' } });
    expect(code).toBe(0);
    expectReplyContract(events);
    expect(events.filter((event) => event.type === 'message')).toEqual([
      { type: 'message', id: 'm1', text: '你好，世界' },
      { type: 'message', id: 'anon-1', text: '完成' },
    ]);
    expect(events.filter((event) => event.type === 'tool')).toEqual([
      { type: 'tool', id: 't1', command: 'acp:read 读取 README', output: 'README 内容', exitCode: 0, truncated: false },
    ]);
    // 已知但不消费的更新静默忽略；未知类型只警告一次。
    expect(events.filter((event) => event.type === 'warning')).toEqual([{ type: 'warning', text: 'ACP 未识别的更新类型：future_update' }]);
  });
});

describe('ACP 轮次驱动（W3a）', () => {
  it('initialize 声明不提供客户端 fs / terminal，能力描述来自实际回复', async () => {
    const { outcome, written } = await drive('reply');
    expect(written[0]).toMatchObject({
      method: 'initialize',
      params: { protocolVersion: 1, clientCapabilities: { fs: { readTextFile: false, writeTextFile: false }, terminal: false } },
    });
    if (!outcome.ok) throw outcome.error;
    const descriptor = HarnessDescriptorSchema.parse(acpDescriptor(claudeCodeAcp, outcome.result.initialize));
    expect(descriptor).toMatchObject({
      harnessId: 'claude-code',
      adapter: 'acp',
      version: '1.2.3',
      capabilitySource: 'probed',
      capabilities: { resume: true, permissionRequests: true, clientFs: false, images: false },
    });
  });

  it('默认策略拒绝权限请求，选择 reject_once', async () => {
    const { events, outcome } = await drive('permission');
    expect(outcome).toMatchObject({ ok: true, result: { stopReason: 'end_turn' } });
    expect(events).toContainEqual({ type: 'message', id: 'anon-0', text: '决定：no' });
    expect(events).toContainEqual(expect.objectContaining({ type: 'tool', id: 't2', exitCode: 1 }));
  });

  it('注入的策略可以批准；策略抛错时按 cancelled 回复', async () => {
    const allowed = await drive('permission', {
      decide: () => (params) => ({ outcome: { outcome: 'selected', optionId: params.options[0]!.optionId } }),
    });
    expect(allowed.events).toContainEqual({ type: 'message', id: 'anon-0', text: '决定：yes' });
    const thrown = await drive('permission', {
      decide: () => () => {
        throw new Error('审批不可用');
      },
    });
    expect(thrown.events).toContainEqual({ type: 'message', id: 'anon-0', text: '决定：cancelled' });
  });

  it('取消：待决的权限请求回复 cancelled，发 session/cancel，Agent 以 cancelled 结束且不记失败', async () => {
    const { events, outcome, written, code } = await drive('cancel', {
      decide: (controller) => () => {
        setTimeout(() => controller.abort(), 10);
        return new Promise(() => undefined);
      },
    });
    expect(outcome).toMatchObject({ ok: true, result: { stopReason: 'cancelled', cancelRequested: true } });
    expect(code).toBe(0);
    const permissionReply = written.find((message) => (message as { result?: unknown }).result !== undefined);
    expect(permissionReply).toMatchObject({ result: { outcome: { outcome: 'cancelled' } } });
    expect(written).toContainEqual({ jsonrpc: '2.0', method: 'session/cancel', params: { sessionId: 'sess-cancel' } });
    expect(events).toContainEqual({ type: 'message', id: 'anon-1', text: '权限：cancelled' });
    expect(events).toContainEqual(expect.objectContaining({ type: 'tool', id: 't3', exitCode: null }));
    expect(events.some((event) => event.type === 'turn_failed' || event.type === 'turn_completed')).toBe(false);
  });

  it('取消发生在权限请求之前：随后到达的权限请求直接回复 cancelled', async () => {
    const { outcome, written } = await drive('cancel', { abortWhen: (events) => events.some((event) => event.type === 'message') });
    expect(outcome).toMatchObject({ ok: true, result: { stopReason: 'cancelled' } });
    expect(written.find((message) => (message as { result?: unknown }).result !== undefined)).toMatchObject({
      result: { outcome: { outcome: 'cancelled' } },
    });
  });

  it('声明 loadSession 时用 session/load 恢复，回放的历史不进入本轮', async () => {
    const { events, written } = await drive('load', { sessionRef: 'sess-prev' });
    expect(written.map((message) => (message as { method?: string }).method).filter(Boolean)).toEqual([
      'initialize',
      'session/load',
      'session/prompt',
    ]);
    expect(events.filter((event) => event.type === 'message')).toEqual([{ type: 'message', id: 'anon-0', text: '已恢复 sess-prev' }]);
    expect(events[0]).toEqual({ type: 'session', ref: 'sess-prev' });
  });

  it('未声明 loadSession 时开始新会话并警告', async () => {
    const { events, written } = await drive('noload', { sessionRef: 'sess-prev' });
    expect(written.some((message) => (message as { method?: string }).method === 'session/load')).toBe(false);
    expect(events).toContainEqual({ type: 'warning', text: 'Agent 未声明 loadSession，已开始新会话；之前的上下文不会带入' });
    expect(events).toContainEqual({ type: 'session', ref: 'sess-noload' });
  });

  it.each([
    ['refusal', 'Agent 停止：refusal'],
    ['spurious-cancel', 'Agent 在未请求取消时返回 cancelled'],
  ])('%s 记为失败轮次', async (scenario, message) => {
    const { events } = await drive(scenario);
    expect(events.at(-1)).toEqual({ type: 'turn_failed', message });
  });

  it.each([
    ['version', 'ACP 协议版本不兼容：2'],
    ['malformed', 'ACP 输出不是 JSON'],
    ['unknown-id', 'ACP 返回了未知请求身份 999'],
    ['other-session', 'ACP 返回了其他会话的更新'],
  ])('%s 是协议违约，轮次失败', async (scenario, message) => {
    const { outcome, protocolError } = await drive(scenario);
    expect(outcome.ok).toBe(false);
    expect(protocolError?.message ?? (outcome.ok ? '' : outcome.error.message)).toBe(message);
  });

  it('未提供的客户端能力回复 -32601 并警告', async () => {
    const { events } = await drive('fs');
    expect(events).toContainEqual({ type: 'message', id: 'anon-0', text: 'fs：-32601' });
    expect(events).toContainEqual({ type: 'warning', text: 'ACP Agent 调用了未提供的客户端能力：fs/read_text_file' });
  });

  it('prompt 返回后到达的消息被隔离，不进入本轮也不报错', async () => {
    const { events, outcome, turn, protocolError } = await drive('late');
    expect(outcome.ok).toBe(true);
    expect(protocolError).toBeNull();
    expect(events.filter((event) => event.type === 'message')).toEqual([{ type: 'message', id: 'anon-0', text: '正常' }]);
    expect(() => turn.receive(JSON.stringify({ jsonrpc: '2.0', id: 4242, result: {} }))).not.toThrow();
  });
});

describe('ACP 轮次驱动的同步边界', () => {
  it('prompt 响应与迟到更新在同一批输入中到达时，迟到更新不进入本轮', async () => {
    const written: { id?: number; method?: string }[] = [];
    const events: HarnessEvent[] = [];
    const turn = new AcpTurn(
      (line) => written.push(JSON.parse(line)),
      (event) => events.push(event),
      {
        cwd: '/w',
        mcpServers: [],
        sessionRef: null,
        prompt: 'x',
        signal: new AbortController().signal,
      },
    );
    const running = turn.run();
    const reply = async (method: string, result: unknown) => {
      await expect.poll(() => written.find((message) => message.method === method)).toBeDefined();
      const id = written.find((message) => message.method === method)!.id!;
      return JSON.stringify({ jsonrpc: '2.0', id, result });
    };
    turn.receive(await reply('initialize', { protocolVersion: 1, agentCapabilities: {} }));
    turn.receive(await reply('session/new', { sessionId: 's' }));
    const update = (text: string) =>
      JSON.stringify({
        jsonrpc: '2.0',
        method: 'session/update',
        params: { sessionId: 's', update: { sessionUpdate: 'agent_message_chunk', content: { type: 'text', text } } },
      });
    const promptReply = await reply('session/prompt', { stopReason: 'end_turn' });
    turn.receive(update('正常'));
    turn.receive(promptReply);
    turn.receive(update('迟到'));
    await running;
    expect(events.filter((event) => event.type === 'message')).toEqual([{ type: 'message', id: 'anon-0', text: '正常' }]);
  });
});
