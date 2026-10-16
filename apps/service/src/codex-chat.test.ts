import { emptyReferences } from './reference-test-fixture';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { CodexChat, parseCodexLine } from './codex-chat';
import { resolveSbxBinary } from './sbx';
import type { EduTaskBinding, MotaTaskBinding, ChatConversation, ChatSlot } from '@wsl/protocol';

const personal = 'conv-personal-default';
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
  it('ordinary chat does not enable strict edu candidate snapshots', async () => {
    const start = vi.spyOn(chat.connection, 'start');
    await chat.send(personal, 'ordinary', undefined, emptyReferences(personal));
    await finish();
    expect(start.mock.calls[0]?.[0]).not.toHaveProperty('strictWorkspace');
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

describe('edu candidate round trip (offline transport fixture)', () => {
  it.each(['complete', 'cancel', 'retain-failure'])('retains candidate before terminal publication: %s', async (mode) => {
    const binding: EduTaskBinding = {
      runId: crypto.randomUUID(),
      workspaceId: 'taskflow-demo',
      projectId: crypto.randomUUID(),
      appInstanceId: crypto.randomUUID(),
      resourceId: 'r',
      instanceId: 'i',
      generation: 1,
      webContentsId: 1,
      documentGeneration: 1,
      sourceSha256: 'a'.repeat(64),
      protectedFiles: [],
    };
    const workspace = { runId: binding.runId, files: [{ path: 'admin/src/App.tsx', base64: 'YQ==' }] };
    const retain = vi.fn(async () => {
      if (mode === 'retain-failure') throw new Error('candidate disk unavailable');
    });
    const start = vi.spyOn(chat.connection, 'start');
    await chat.send(
      space,
      mode === 'cancel' ? '[slow]' : 'candidate',
      { workspaceId: binding.workspaceId, sessionId: space, runId: binding.runId, sources: [] },
      emptyReferences(space),
      { binding, workspace, retain },
    );
    if (mode === 'cancel') await chat.cancel(space);
    await vi.waitFor(() => expect(retain).toHaveBeenCalledWith(workspace));
    await vi.waitFor(() =>
      expect(chat.get(space).state).toBe(mode === 'cancel' ? 'cancelled' : mode === 'retain-failure' ? 'failed' : 'idle'),
    );
    expect(start.mock.calls[0]?.[0]).toMatchObject({ workspace, strictWorkspace: true });
    if (mode !== 'retain-failure') expect(chat.get(space).eduCandidateRunId).toBe(binding.runId);
    else expect(chat.get(space).error).toContain('candidate disk unavailable');
  });
});

describe('Mota read-only model admission', () => {
  it('starts a new read-only thread with only fixed scratch and native restricted MCP', async () => {
    await chat.send(space, 'ordinary prior thread', undefined, emptyReferences(space));
    await finish(space);
    const previous = chat.get(space).threadId;
    const binding: MotaTaskBinding = {
      workspaceId: 'taskflow-demo',
      environmentId: 'sandbox',
      projectId: crypto.randomUUID(),
      appInstanceId: crypto.randomUUID(),
      runId: crypto.randomUUID(),
      sessionId: space,
      resourceId: 'game',
      browserInstanceId: 'browser',
      browserGeneration: 0,
      webContentsId: 1,
      documentGeneration: 0,
    };
    chat.setAppControlReader(async () => ({ ok: false, tool: null, error: { code: 'unsupported', message: 'fixture' } }));
    const start = vi.spyOn(chat.connection, 'start');
    await chat.send(
      space,
      'restricted turn',
      { workspaceId: binding.workspaceId, sessionId: space, runId: binding.runId, sources: [] },
      emptyReferences(space),
      undefined,
      binding,
    );
    expect((await finish(space)).state).toBe('idle');
    const input = start.mock.calls[0]![0];
    expect(input).toMatchObject({
      mode: 'codex',
      motaControl: true,
      strictWorkspace: true,
      observation: true,
      argv: ['codex', 'exec', '--sandbox', 'read-only', '-c', 'web_search="disabled"', '--json', '--skip-git-repo-check', '-'],
      workspace: { runId: binding.runId },
    });
    if (input.mode !== 'codex') throw new Error('unexpected mode');
    expect(input.workspace?.files.map((file) => file.path)).toEqual(['README.md']);
    expect(input.argv).not.toContain(previous);
    expect(input.argv).not.toContain('resume');
    expect(chat.get(space)).not.toHaveProperty('eduCandidateRunId');
  });
});
