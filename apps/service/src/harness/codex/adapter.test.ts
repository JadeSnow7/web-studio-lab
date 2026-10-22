import { describe, expect, it } from 'vitest';
import { HarnessDescriptorSchema } from '@wsl/protocol';
import { codexAdapter } from './adapter';

const line = (value: unknown) => JSON.stringify(value);

describe('Codex native 适配器（W2）', () => {
  it('描述符符合协议且版本来自探测', () => {
    expect(HarnessDescriptorSchema.parse(codexAdapter.descriptor('0.160.0'))).toMatchObject({
      harnessId: 'codex',
      displayName: 'Codex CLI',
      adapter: 'native',
      version: '0.160.0',
      capabilitySource: 'declared',
      capabilities: { mcp: true, resume: true, clientFs: false },
    });
    expect(codexAdapter.descriptor(null).version).toBeNull();
  });

  it('首轮与续轮参数与迁移前逐项一致', () => {
    expect(codexAdapter.argv(null)).toEqual(['codex', 'exec', '--sandbox', 'workspace-write', '--json', '--skip-git-repo-check', '-']);
    expect(codexAdapter.argv('thread-1')).toEqual([
      'codex',
      'exec',
      '--sandbox',
      'workspace-write',
      'resume',
      '--json',
      '--skip-git-repo-check',
      'thread-1',
      '-',
    ]);
    expect(codexAdapter.mcpInjection).toBe('codex-config');
  });

  it('把 Codex 事件映射为归一化事件，未知事件返回 null，已知无效果事件返回空数组', () => {
    expect(codexAdapter.parseLine(line({ type: 'future.event' }))).toBeNull();
    expect(codexAdapter.parseLine(line({ type: 'turn.started' }))).toEqual([]);
    expect(codexAdapter.parseLine(line({ type: 'item.completed', item: { id: 'r', type: 'reasoning' } }))).toEqual([]);
    expect(codexAdapter.parseLine(line({ type: 'thread.started', thread_id: 't' }))).toEqual([{ type: 'session', ref: 't' }]);
    expect(codexAdapter.parseLine(line({ type: 'turn.completed', usage: {} }))).toEqual([{ type: 'turn_completed' }]);
    expect(codexAdapter.parseLine(line({ type: 'turn.failed', error: { message: 'x' } }))).toEqual([{ type: 'turn_failed', message: 'x' }]);
    expect(codexAdapter.parseLine(line({ type: 'error', message: 'y' }))).toEqual([{ type: 'turn_failed', message: 'y' }]);
    expect(codexAdapter.parseLine(line({ type: 'item.completed', item: { id: 'm', type: 'agent_message', text: '好' } }))).toEqual([
      { type: 'message', id: 'm', text: '好' },
    ]);
    expect(
      codexAdapter.parseLine(line({ type: 'item.completed', item: { id: 'w', type: 'error', message: 'w'.repeat(3000) } }))?.[0],
    ).toEqual({ type: 'warning', text: 'w'.repeat(2000) });
  });

  it('命令与 MCP 记录保持原有裁剪与退出码规则', () => {
    const long = 'o'.repeat(17000);
    expect(
      codexAdapter.parseLine(
        line({
          type: 'item.completed',
          item: { id: 'c', type: 'command_execution', command: 'ls', aggregated_output: long, exit_code: null },
        }),
      ),
    ).toEqual([{ type: 'tool', id: 'c', command: 'ls', output: long.slice(-16000), exitCode: null, truncated: true }]);
    const [mcp] = codexAdapter.parseLine(
      line({
        type: 'item.completed',
        item: {
          id: 'p',
          type: 'mcp_tool_call',
          server: 'wsl_space',
          tool: 'list',
          arguments: { a: 1 },
          status: 'completed',
          result: { ok: 1 },
        },
      }),
    )!;
    expect(mcp).toMatchObject({ type: 'tool', command: 'mcp:wsl_space.list {"a":1}', exitCode: 0, truncated: false });
    const [failed] = codexAdapter.parseLine(
      line({ type: 'item.completed', item: { id: 'q', type: 'mcp_tool_call', server: 's', tool: 't', status: 'failed', error: 'e' } }),
    )!;
    expect(failed).toMatchObject({ exitCode: 1 });
  });

  it('字段缺失时抛出协议错误，由执行核心记为失败', () => {
    expect(() => codexAdapter.parseLine(line({ type: 'item.completed', item: { id: 'm', type: 'agent_message', text: ' ' } }))).toThrow(
      'Codex 回复缺少文本',
    );
    expect(() => codexAdapter.parseLine(line({ type: 'item.completed', item: { id: 'w', type: 'error' } }))).toThrow('Codex 警告缺少文本');
    expect(() =>
      codexAdapter.parseLine(line({ type: 'item.completed', item: { id: 'c', type: 'command_execution', command: 'ls' } })),
    ).toThrow('Codex 工具执行记录缺少字段');
    expect(() =>
      codexAdapter.parseLine(
        line({ type: 'item.completed', item: { id: 'p', type: 'mcp_tool_call', server: 's', tool: 't', status: 'completed' } }),
      ),
    ).toThrow('Codex MCP 执行记录缺少字段');
    expect(() => codexAdapter.parseLine('{broken')).toThrow();
  });
});

describe('Codex 自检的登录状态解析（W4a 修正）', () => {
  const parse = codexAdapter.selfCheck.parseStatus;
  it('真实 CLI 把结果写在 stderr：已登录与未登录都能判断', () => {
    expect(parse(0, '', 'Logged in using an API key - ***\n')).toBe('logged_in');
    expect(parse(1, '', 'Not logged in\n')).toBe('logged_out');
  });
  it('写在 stdout 时同样判断', () => {
    expect(parse(0, 'Logged in using ChatGPT\n', '')).toBe('logged_in');
  });
  it('两种结论同时出现、退出码不符或没有可识别输出时无法判断', () => {
    expect(parse(0, 'Logged in using ChatGPT\n', 'Not logged in\n')).toBe('undetermined');
    expect(parse(1, '', 'Logged in using ChatGPT\n')).toBe('undetermined');
    expect(parse(0, '', '')).toBe('undetermined');
  });
});
