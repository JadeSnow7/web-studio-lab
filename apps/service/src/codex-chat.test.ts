import { emptyReferences } from './reference-test-fixture';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { CodexChat, parseCodexLine, type ChatHarness } from './codex-chat';
import { claudeCodeAcp } from './harness/acp/agents';
import { REGISTERED_HARNESSES } from './harness/registry';
import { resolveSbxBinary } from './sbx';
import { profileDirOf, type ChatConversation, type ChatSlot, type TurnHarness } from '@wsl/protocol';

const personal = 'conv-personal-default';
const CLAUDE_TURN: TurnHarness = { harnessId: 'claude-code', profileId: 'claude-code:default', profileDir: null };
const space = 'conv-space-taskflow-demo-impl';
let root: string;
let chat: CodexChat;
let events: ChatConversation[];
let expectedCleanupFailure = false;
beforeEach(async () => {
  root = await mkdtemp(path.join(tmpdir(), 'wsl-chat-'));
  vi.stubEnv('WSL_SBX_NAME', 'fixture-sandbox');
  vi.stubEnv('WSL_SBX_BIN', path.resolve('e2e/fixtures/sbx.mjs'));
  events = [];
  expectedCleanupFailure = false;
  chat = new CodexChat(root, (event) => events.push(event));
  chat.register(space, 'taskflow-demo');
  await chat.initialize();
});
afterEach(async () => {
  if (expectedCleanupFailure) await expect(chat.shutdown()).rejects.toThrow('fixture 清理失败');
  else await chat.shutdown();
  vi.restoreAllMocks();
  vi.unstubAllEnvs();
  await rm(root, { recursive: true, force: true });
});
async function finish(id: ChatSlot = personal) {
  await expect.poll(() => chat.get(id).state, { timeout: 5000 }).not.toBe('running');
  return chat.get(id);
}
describe('外部 CLI 协议', () => {
  it('校验已知事件，不把未知事件当成完成', () => {
    expect(parseCodexLine('{"type":"future.event"}')).toBeNull();
    expect(() => parseCodexLine('{broken')).toThrow();
    expect(() => parseCodexLine('{"type":"thread.started"}')).toThrow();
    expect(parseCodexLine('{"type":"turn.completed","usage":{}}')?.type).toBe('turn.completed');
  });
  it('显式无效路径不回退到已安装 CLI', async () => {
    await expect(resolveSbxBinary('/missing/wsl-sbx')).rejects.toThrow('不可执行');
  });
});
describe('真实子进程生命周期（fixture）', () => {
  it('同会话恢复身份，个人与空间隔离，reset 清除上下文', async () => {
    await chat.send(personal, '记住晴川742', undefined, emptyReferences(personal));
    expect((await finish()).state).toBe('idle');
    const first = chat.get(personal);
    await chat.send(personal, '回忆', undefined, emptyReferences(personal));
    expect((await finish()).messages.at(-1)?.text).toBe('记住晴川742');
    await chat.send(space, '回忆', undefined, emptyReferences(space));
    expect((await finish(space)).messages.at(-1)?.text).toBe('没有之前内容');
    expect(chat.get(personal).threadId).toBe(first.threadId);
    await chat.reset(personal);
    await chat.send(personal, '回忆', undefined, emptyReferences(personal));
    expect((await finish()).messages.at(-1)?.text).toBe('没有之前内容');
    expect(chat.get(personal).generation).not.toBe(first.generation);
  });
  it.each(['[bad-json]', '[exit]', '[no-completion]', '[empty-reply]'])('%s 必须失败且保留用户消息', async (text) => {
    await chat.send(personal, text, undefined, emptyReferences(personal));
    const result = await finish();
    expect(result.state).toBe('failed');
    expect(result.error).toBeTruthy();
    expect(result.messages[0]?.text).toBe(text);
  });
  it.each(['取消', '协议失败'])('%s 的进程组清理失败必须阻止重置、关闭与新发送', async (mode) => {
    // 真实 fixture 子进程会被正常终止；只注入退出确认失败，避免制造遗留进程。
    const start = chat.connection.start.bind(chat.connection);
    vi.spyOn(chat.connection, 'start').mockImplementation((...args) => {
      const remote = start(...args);
      Object.defineProperty(remote, 'done', {
        value: remote.done.then((outcome) => ({ ...outcome, confirmed: false, error: 'fixture 清理失败' })),
      });
      return remote;
    });
    expectedCleanupFailure = true;
    await chat.send(personal, mode === '取消' ? '[slow]' : '[no-completion]', undefined, emptyReferences(personal));
    const generation = chat.get(personal).generation;
    if (mode === '取消') await expect(chat.cancel(personal)).rejects.toThrow('fixture 清理失败');
    else await finish();
    expect(chat.get(personal).state).toBe('failed');
    expect(chat.get(personal).error).toBe('fixture 清理失败');
    await expect(chat.reset(personal)).rejects.toThrow('fixture 清理失败');
    expect(chat.get(personal).generation).toBe(generation);
    expect(chat.get(personal).messages).toHaveLength(1 + (mode === '协议失败' ? 1 : 0));
    await expect(chat.send(personal, '不能开始新轮', undefined, emptyReferences(personal))).rejects.toThrow('fixture 清理失败');
    await expect(chat.shutdown()).rejects.toThrow('fixture 清理失败');
    expect(chat.get(personal).state).toBe('failed');
  });
  it('shutdown 同步关闭接收入口，清理立即发送的请求', async () => {
    const sending = chat.send(personal, '[slow]', undefined, emptyReferences(personal));
    const stopping = chat.shutdown();
    await expect(chat.send(space, 'late', undefined, emptyReferences(space))).rejects.toThrow('关闭');
    await sending;
    await stopping;
    expect(chat.get(personal).state).toBe('cancelled');
    expect(chat.get(space).messages).toHaveLength(0);
  });
  it('发送后立即 reset 不会启动旧轮次或污染新会话', async () => {
    const sending = chat.send(personal, '[slow]', undefined, emptyReferences(personal));
    const resetting = chat.reset(personal);
    await sending;
    await resetting;
    expect(chat.get(personal).state).toBe('idle');
    expect(chat.get(personal).messages).toHaveLength(0);
  });
  it('拒绝重复发送，取消等待进程 close，迟到消息不污染 reset', async () => {
    await chat.send(personal, '[slow]', undefined, emptyReferences(personal));
    await expect(chat.send(personal, 'duplicate', undefined, emptyReferences(personal))).rejects.toThrow('等待回复');
    await expect.poll(() => events.length).toBeGreaterThan(1);
    await chat.cancel(personal);
    expect(chat.get(personal).state).toBe('cancelled');
    const cancelled = events.findIndex((event) => event.state === 'cancelling');
    expect(events.slice(cancelled).some((event) => event.messages.some((message) => message.text === '迟到回复'))).toBe(false);
    await chat.reset(personal);
    await chat.send(personal, 'fresh', undefined, emptyReferences(personal));
    expect((await finish()).messages.map((message) => message.text)).toEqual(['fresh', 'fixture 回复：fresh']);
  });
});

describe('Harness 端口（W2）', () => {
  it('状态报告 Codex 描述符，版本与连接检查一致', () => {
    const status = chat.getStatus();
    expect(status.available).toBe(true);
    expect(status.harnesses).toEqual([
      expect.objectContaining({
        available: true,
        descriptor: expect.objectContaining({ harnessId: 'codex', displayName: 'Codex CLI', adapter: 'native', version: status.version }),
      }),
    ]);
  });
  it('start 帧显式声明 MCP 挂载方式，参数由适配器构造', async () => {
    const start = vi.spyOn(chat.connection, 'start');
    await chat.send(personal, '记住晴川742', undefined, emptyReferences(personal));
    expect((await finish()).state).toBe('idle');
    const frame = start.mock.calls[0]![0];
    expect(frame).toMatchObject({ type: 'start', mode: 'codex', mcp: 'codex-config' });
    expect(frame.type === 'start' && frame.mode === 'codex' ? frame.argv.slice(0, 4) : null).toEqual([
      'codex',
      'exec',
      '--sandbox',
      'workspace-write',
    ]);
  });
});

describe('ACP Harness 经执行核心（W3b，fixture sbx + 假 ACP Agent）', () => {
  const fakeAgent = path.resolve('apps/service/src/fixtures/fake-acp-agent.mjs');
  const acp = (scenario: string): Extract<ChatHarness, { kind: 'acp' }> => ({
    kind: 'acp',
    spec: {
      harnessId: 'claude-code',
      displayName: 'Claude Code',
      label: 'Claude Code',
      command: [process.execPath, fakeAgent, scenario],
      install: { npm: 'fixture', version: '0' },
      configDirEnv: 'CLAUDE_CONFIG_DIR',
      selfCheck: claudeCodeAcp.selfCheck,
    },
  });
  async function acpChat(scenario: string) {
    const acpEvents: ChatConversation[] = [];
    const instance = new CodexChat(root, (event) => acpEvents.push(event), undefined, [acp(scenario)]);
    await instance.initialize();
    return { instance, acpEvents };
  }
  async function settle(instance: CodexChat, id: ChatSlot = personal) {
    await expect.poll(() => instance.get(id).state, { timeout: 8000 }).not.toBe('running');
    return instance.get(id);
  }

  it('探测只发 initialize，状态报告实测的 ACP 能力与版本', async () => {
    const { instance } = await acpChat('reply');
    try {
      const status = instance.getStatus();
      expect(status.available).toBe(true);
      expect(status.harnesses).toEqual([
        {
          available: true,
          reason: null,
          descriptor: expect.objectContaining({
            harnessId: 'claude-code',
            adapter: 'acp',
            version: '1.2.3',
            capabilitySource: 'probed',
            capabilities: expect.objectContaining({ resume: true }),
          }),
        },
      ]);
    } finally {
      await instance.shutdown();
    }
  });

  it('一轮对话：relay 启动、MCP 经 session/new 传入、消息与工具进入会话、正常完成并确认清理', async () => {
    const { instance } = await acpChat('reply');
    const start = vi.spyOn(instance.connection, 'start');
    try {
      await instance.send(personal, '你好', undefined, emptyReferences(personal), CLAUDE_TURN);
      const done = await settle(instance);
      expect(done).toMatchObject({ state: 'idle', error: null, cleanupPending: false, threadId: 'sess-reply' });
      expect(done.messages.map((message) => message.text)).toEqual(['你好', '你好，世界', '完成']);
      expect(done.toolExecutions).toEqual([
        expect.objectContaining({ command: 'acp:read 读取 README', output: 'README 内容', exitCode: 0 }),
      ]);
      expect(done.warnings).toContain('ACP 未识别的更新类型：future_update');
      expect(start.mock.calls.at(-1)![0]).toMatchObject({
        mode: 'codex',
        mcp: 'acp-stdio',
        stdin: 'relay',
        argv: [process.execPath, fakeAgent, 'reply'],
      });
      expect(start.mock.calls.at(-1)![0]).not.toHaveProperty('prompt');
    } finally {
      await instance.shutdown();
    }
  });

  it('工作区写入策略：编辑类权限自动放行一次', async () => {
    const { instance } = await acpChat('permission');
    try {
      await instance.send(personal, '改文件', undefined, emptyReferences(personal), CLAUDE_TURN);
      const done = await settle(instance);
      expect(done.messages.at(-1)?.text).toBe('决定：yes');
      expect(done.state).toBe('idle');
    } finally {
      await instance.shutdown();
    }
  });

  it('不支持 loadSession 时第二轮换用新会话，不判为会话冲突', async () => {
    const { instance } = await acpChat('noload');
    try {
      await instance.send(personal, '一', undefined, emptyReferences(personal), CLAUDE_TURN);
      expect((await settle(instance)).state).toBe('idle');
      await instance.send(personal, '二', undefined, emptyReferences(personal), CLAUDE_TURN);
      const second = await settle(instance);
      expect(second.state).toBe('idle');
      expect(second.warnings).toContain('Agent 未声明 loadSession，已开始新会话；之前的上下文不会带入');
    } finally {
      await instance.shutdown();
    }
  });

  it('取消：发出 session/cancel 后关闭进程，记为已取消且清理确认', async () => {
    const { instance } = await acpChat('cancel');
    try {
      await instance.send(personal, '慢任务', undefined, emptyReferences(personal), CLAUDE_TURN);
      await expect.poll(() => instance.get(personal).messages.some((message) => message.text === '开始'), { timeout: 8000 }).toBe(true);
      const cancelled = await instance.cancel(personal);
      expect(cancelled).toMatchObject({ state: 'cancelled', cleanupPending: false });
    } finally {
      await instance.shutdown();
    }
  });

  it.each([
    ['refusal', 'Agent 停止：refusal'],
    ['malformed', 'Claude Code 协议错误：ACP 输出不是 JSON'],
  ])('%s 记为失败并带原因', async (scenario, message) => {
    const { instance } = await acpChat(scenario);
    try {
      await instance.send(personal, 'x', undefined, emptyReferences(personal), CLAUDE_TURN);
      const done = await settle(instance);
      expect(done.state).toBe('failed');
      expect(done.error).toContain(message);
    } finally {
      await instance.shutdown();
    }
  });

  it('Agent 不可启动时状态不可用并说明原因', async () => {
    const instance = new CodexChat(root, () => undefined, undefined, [
      { kind: 'acp', spec: { ...acp('reply').spec, command: ['/definitely/missing-acp-agent'] } },
    ]);
    try {
      await instance.initialize();
      const status = instance.getStatus();
      // 运行环境本身可用；不可用的是这个 Harness（W4 起按 Harness 分别报告）。
      expect(status.available).toBe(true);
      expect(status.harnesses[0]).toMatchObject({ available: false, reason: expect.stringMatching(/^Claude Code 不可用：/) });
      await expect(instance.send(personal, 'x', undefined, emptyReferences(personal), CLAUDE_TURN)).rejects.toThrow('Claude Code 不可用');
    } finally {
      await instance.shutdown();
    }
  });
});

describe('Harness 选择与 Profile（W4a）', () => {
  const fakeAgent = path.resolve('apps/service/src/fixtures/fake-acp-agent.mjs');
  const claude: Extract<ChatHarness, { kind: 'acp' }> = {
    kind: 'acp',
    spec: { ...claudeCodeAcp, command: [process.execPath, fakeAgent, 'reply'] },
  };
  const profileA = 'a1b2c3d4-0000-4000-8000-00000000000a';
  const loggedOut = '00000000-0000-4000-8000-00000000000b';
  async function both() {
    const instance = new CodexChat(root, () => undefined, undefined, [REGISTERED_HARNESSES[0]!, claude]);
    await instance.initialize();
    return instance;
  }

  it('状态按 Harness 分别报告可用性；不可启动的 Harness 留在列表中并说明原因', async () => {
    const missing: ChatHarness = { kind: 'acp', spec: { ...claudeCodeAcp, command: ['/definitely/missing-acp-agent'] } };
    const instance = new CodexChat(root, () => undefined, undefined, [REGISTERED_HARNESSES[0]!, missing]);
    try {
      await instance.initialize();
      const status = instance.getStatus();
      expect(status.harnesses.map((item) => [item.descriptor.harnessId, item.available])).toEqual([
        ['codex', true],
        ['claude-code', false],
      ]);
      expect(status.harnesses[1]!.reason).toMatch(/^Claude Code 不可用：/);
    } finally {
      await instance.shutdown();
    }
  });

  it('自检只返回版本与登录状态，不保留原始输出中的账号信息', async () => {
    const instance = await both();
    const start = vi.spyOn(instance.connection, 'start');
    try {
      await expect(instance.checkProfile('codex', null)).resolves.toEqual({
        cliVersion: 'codex-cli fixture',
        login: 'logged_in',
        reason: null,
      });
      const inResult = await instance.checkProfile('claude-code', profileDirOf('claude-code', profileA));
      const outResult = await instance.checkProfile('claude-code', profileDirOf('claude-code', loggedOut));
      expect(inResult).toMatchObject({ login: 'logged_in', reason: null });
      expect(outResult).toMatchObject({ login: 'logged_out', reason: null });
      expect(JSON.stringify([inResult, outResult])).not.toContain('fixture@example.invalid');
      expect(start.mock.calls.slice(2).map(([frame]) => frame)).toEqual([
        expect.objectContaining({ argv: ['claude-agent-acp', '--version'], profileDir: profileDirOf('claude-code', profileA) }),
        expect.objectContaining({ argv: claudeCodeAcp.selfCheck.statusArgv, profileDir: profileDirOf('claude-code', profileA) }),
        expect.objectContaining({ profileDir: profileDirOf('claude-code', loggedOut) }),
        expect.objectContaining({ profileDir: profileDirOf('claude-code', loggedOut) }),
      ]);
    } finally {
      await instance.shutdown();
    }
  });

  it.each([
    ['未声明配置目录变量的组合', 'claude-code', { env: 'CODEX_HOME' as const, path: profileDirOf('claude-code', profileA)!.path }],
    ['其他 Harness 的目录', 'claude-code', profileDirOf('codex', profileA)],
    ['未注册的 Harness', 'gemini', null],
  ])('拒绝%s，且不启动 guest 进程', async (_label, harnessId, profileDir) => {
    const instance = await both();
    const start = vi.spyOn(instance.connection, 'start');
    try {
      await expect(instance.checkProfile(harnessId, profileDir)).rejects.toThrow();
      expect(start).not.toHaveBeenCalled();
    } finally {
      await instance.shutdown();
    }
  });

  it('非内置 Profile 缺少配置目录时拒绝发送，不改变会话', async () => {
    const instance = await both();
    try {
      await expect(
        instance.send(personal, 'x', undefined, emptyReferences(personal), {
          harnessId: 'claude-code',
          profileId: profileA,
          profileDir: null,
        }),
      ).rejects.toThrow('非内置 Profile 缺少配置目录');
      expect(instance.get(personal)).toMatchObject({ state: 'idle', messages: [] });
    } finally {
      await instance.shutdown();
    }
  });

  it('同一会话换用其他 Harness 或 Profile 时不复用旧会话身份，并记一条警告', async () => {
    const instance = await both();
    const start = vi.spyOn(instance.connection, 'start');
    const settled = async () => {
      await expect.poll(() => instance.get(personal).state, { timeout: 8000 }).not.toBe('running');
      return instance.get(personal);
    };
    try {
      await instance.send(personal, '一', undefined, emptyReferences(personal));
      const first = await settled();
      expect(first.threadId).toMatch(/^fixture-/);
      const turn: TurnHarness = { harnessId: 'claude-code', profileId: profileA, profileDir: profileDirOf('claude-code', profileA) };
      await instance.send(personal, '二', undefined, emptyReferences(personal), turn);
      const second = await settled();
      expect(second).toMatchObject({ state: 'idle', threadId: 'sess-reply' });
      expect(second.warnings).toContain(`本轮改用 Claude Code（${profileA}），已开始新的 Agent 会话；之前的上下文不会带入`);
      expect(start.mock.calls.at(-1)![0]).toMatchObject({ stdin: 'relay', profileDir: profileDirOf('claude-code', profileA) });
    } finally {
      await instance.shutdown();
    }
  });
});
