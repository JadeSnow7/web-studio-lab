import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { GuestProcess, SbxConnection } from './sbx';
import { Terminal } from './terminal';
import { CodexChat } from './codex-chat';
const binary = path.resolve('apps/service/src/fixtures/sbx.mjs');
let connection: SbxConnection;
beforeEach(() => {
  vi.stubEnv('WSL_SBX_NAME', 'fixture-sandbox');
  vi.stubEnv('WSL_SBX_BIN', binary);
  connection = new SbxConnection();
});
afterEach(() => vi.unstubAllEnvs());
describe('guest helper 宿主边界', () => {
  it('拒绝挂载host的目标而不调用Codex', async () => {
    vi.stubEnv('WSL_SBX_FIXTURE_CASE', 'mounted');
    expect((await connection.initialize()).available).toBe(false);
  });
  it('仅接受与目标sandbox匹配的启动说明', async () => {
    vi.stubEnv('WSL_SBX_FIXTURE_CASE', 'startup-message');
    expect((await connection.initialize()).available).toBe(true);
    vi.stubEnv('WSL_SBX_FIXTURE_CASE', 'wrong-startup');
    expect((await new SbxConnection().initialize()).reason).toContain('未封装');
  });
  it.each(['missing-cleanup', 'cleanup-fail'])('%s 不等于guest成功退出', async (kind) => {
    vi.stubEnv('WSL_SBX_FIXTURE_CASE', kind);
    const child = new GuestProcess(
      binary,
      'fixture-sandbox',
      { type: 'start', mode: 'codex', argv: ['codex', '--version'] },
      () => undefined,
    );
    const result = await child.done;
    expect(result.confirmed).toBe(false);
    expect(result.error).toBeTruthy();
  });
  it('initialize probe未确认清理时保持登记并拒绝shutdown', async () => {
    vi.stubEnv('WSL_SBX_FIXTURE_CASE', 'missing-cleanup');
    expect((await connection.initialize()).available).toBe(false);
    await expect(connection.shutdown()).rejects.toThrow('清理未确认');
  });
  it('失败版本probe已有清理确认时允许正常shutdown', async () => {
    vi.stubEnv('WSL_SBX_FIXTURE_CASE', 'version-fail');
    expect((await connection.initialize()).available).toBe(false);
    await expect(connection.shutdown()).resolves.toBeUndefined();
  });
  it('正常PTY输入与resize转发且关闭须确认，旧session不得操作新终端', async () => {
    await connection.initialize();
    const terminal = new Terminal(connection, () => undefined);
    const starting = await terminal.open(80, 24);
    await expect.poll(() => terminal.get().state).toBe('running');
    terminal.write(starting.sessionId!, '中文\u0003');
    terminal.resize(starting.sessionId!, 100, 40);
    await expect.poll(() => terminal.get().output).toContain('40 100');
    expect(terminal.get().output).toContain('中文\u0003');
    await terminal.close(starting.sessionId!);
    expect(terminal.get().state).toBe('closed');
    expect(terminal.get().cleanupPending).toBe(false);
    const reopened = await terminal.open(80, 24);
    expect(reopened.sessionId).not.toBe(starting.sessionId);
    expect(() => terminal.write(starting.sessionId!, 'late')).toThrow('已过期');
    await terminal.shutdown();
  });
  it('清理失败阻止terminal重新open并保留失败状态', async () => {
    await connection.initialize();
    vi.stubEnv('WSL_SBX_FIXTURE_CASE', 'cleanup-fail');
    const terminal = new Terminal(connection, () => undefined);
    const opened = await terminal.open(80, 24);
    await expect.poll(() => terminal.get().state).toBe('running');
    await expect(terminal.close(opened.sessionId!)).rejects.toThrow('清理失败');
    expect(terminal.get().state).toBe('failed');
    expect(terminal.get().cleanupPending).toBe(true);
    await expect(terminal.open(80, 24)).rejects.toThrow('清理失败');
    await expect(terminal.shutdown()).rejects.toThrow('清理失败');
  });
  it.each(['missing-cleanup', 'cleanup-fail'])('%s聊天失败保持明确cleanupPending占用', async (kind) => {
    const chat = new CodexChat('', () => undefined, connection);
    await chat.initialize();
    vi.stubEnv('WSL_SBX_FIXTURE_CASE', kind);
    const sent = await chat.send('conv-personal-default', 'fixture');
    expect(sent.cleanupPending).toBe(true);
    await expect(chat.cancel('conv-personal-default')).rejects.toThrow();
    expect(chat.get('conv-personal-default').cleanupPending).toBe(true);
    expect(chat.get('conv-personal-default').state).toBe('failed');
    await expect(chat.reset('conv-personal-default')).rejects.toThrow();
    await expect(chat.shutdown()).rejects.toThrow();
  });
  it('terminal 清理未知阻止同 sandbox 的新资源对话', async () => {
    await connection.initialize();
    const terminal = new Terminal(connection, () => undefined);
    vi.stubEnv('WSL_SBX_FIXTURE_CASE', 'cleanup-fail');
    const opened = await terminal.open(80, 24);
    await expect.poll(() => terminal.get().state).toBe('running');
    await expect(terminal.close(opened.sessionId!)).rejects.toThrow();
    expect(connection.getCleanupPending()).toBe(true);
    const chat = new CodexChat('', () => undefined, connection);
    await expect(chat.send('conv-space-taskflow-demo-impl', 'read')).rejects.toThrow('清理状态未知');
  });
  it('非致命MCP警告可见、去重，工具输出有界且显式标截断', async () => {
    const chat = new CodexChat('', () => undefined, connection);
    await chat.initialize();
    vi.stubEnv('WSL_SBX_FIXTURE_CASE', 'warnings-tools');
    await chat.send('conv-personal-default', 'fixture');
    await expect.poll(() => chat.get('conv-personal-default').state).toBe('idle');
    const state = chat.get('conv-personal-default');
    expect(state.cleanupPending).toBe(false);
    expect(state.warnings).toEqual(['MCP fixture warning']);
    expect(state.toolExecutions).toHaveLength(20);
    expect(state.toolExecutions.every((tool) => tool.truncated && tool.output.length <= 16000)).toBe(true);
    expect(state.toolExecutions.reduce((sum, tool) => sum + tool.output.length, 0)).toBeLessThanOrEqual(131072);
    await chat.shutdown();
  });
});
