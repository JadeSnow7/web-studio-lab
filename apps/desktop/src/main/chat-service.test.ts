import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { ChatConversation, ChatStatus, TerminalSnapshot } from '@wsl/protocol';
const mock = vi.hoisted(() => ({
  callbacks: new Map<string, (value: unknown) => void>(),
  postMessage: vi.fn(),
  kill: vi.fn(),
  initialized: true,
}));
vi.mock('electron', () => ({
  app: { isPackaged: false, getAppPath: () => '/desktop', getPath: () => '/user-data' },
  utilityProcess: {
    fork: () => ({
      once: (name: string, callback: (value: unknown) => void) => mock.callbacks.set(name, callback),
      on: (name: string, callback: (value: unknown) => void) => {
        mock.callbacks.set(name, callback);
        if (name === 'message' && mock.initialized)
          callback({
            type: 'initialized',
            status: { available: true, reason: null, version: 'fixture', sandbox: 'fixture', cwd: '/home/agent/workspace' },
            cleanupPending: false,
          });
      },
      postMessage: mock.postMessage,
      kill: mock.kill,
    }),
  },
}));
import { ChatService } from './chat-service';
const snapshot: ChatConversation = {
  conversationId: 'conv-personal-default',
  generation: 'g',
  seq: 1,
  threadId: 't',
  turnId: 'turn',
  state: 'running',
  messages: [{ id: 'u', role: 'user', text: 'hello' }],
  toolExecutions: [],
  warnings: [],
  cleanupPending: true,
  error: null,
};
beforeEach(() => {
  mock.initialized = true;
  mock.callbacks.clear();
  mock.postMessage.mockClear();
  mock.kill.mockClear();
});
describe('对话服务宿主故障', () => {
  it('send ACK 后服务退出仍推送不可用与会话失败', async () => {
    const states: ChatConversation[] = [];
    const statuses: ChatStatus[] = [];
    const service = new ChatService(
      (state) => states.push(state),
      (status) => statuses.push(status),
    );
    const sending = service.send('conv-personal-default', 'hello');
    const request = mock.postMessage.mock.calls[0]?.[0];
    mock.callbacks.get('message')?.({ type: 'response', id: request.id, result: snapshot });
    await sending;
    mock.callbacks.get('exit')?.(1);
    expect(statuses.at(-1)?.available).toBe(false);
    expect(states.at(-1)?.state).toBe('failed');
    expect(states.at(-1)?.seq).toBeGreaterThan(snapshot.seq);
    await expect(service.cancel('conv-personal-default')).rejects.toThrow('退出');
    await expect(service.shutdown()).rejects.toThrow('guest 清理未确认');
  });
  it('终端活动期间服务退出必须发布未知清理失败并拒绝伪成功关闭', async () => {
    const states: TerminalSnapshot[] = [];
    const service = new ChatService(
      () => undefined,
      () => undefined,
      (state) => states.push(state),
    );
    mock.callbacks.get('message')?.({
      type: 'terminal-event',
      binding: {
        workspaceId: 'w',
        environmentId: 'sandbox',
        resourceId: 'terminal-resource',
        kind: 'terminal',
        instanceId: 'main-instance',
        instanceGeneration: 1,
      },
      resourceId: 'terminal-resource',
      terminal: {
        seq: 1,
        sessionId: 'pty',
        sandbox: 'fixture',
        cwd: '/home/agent/workspace',
        state: 'running',
        output: '',
        cleanupPending: true,
        error: null,
      },
    });
    mock.callbacks.get('exit')?.(1);
    expect(states.at(-1)?.state).toBe('failed');
    expect(states.at(-1)?.error).toContain('guest 清理未确认');
    await expect(service.shutdown()).rejects.toThrow('guest 清理未确认');
  });
  it.each(['chat', 'terminal'])('%s 已发布failed但cleanup未确认，服务退出后不能成功关闭', async (kind) => {
    const service = new ChatService(
      () => undefined,
      () => undefined,
    );
    const failed = { ...snapshot, state: 'failed', error: 'fixture transport lost', cleanupPending: true };
    mock.callbacks.get('message')?.(
      kind === 'chat'
        ? { type: 'event', conversation: failed }
        : {
            type: 'terminal-event',
            binding: {
              workspaceId: 'w',
              environmentId: 'sandbox',
              resourceId: 'terminal-resource',
              kind: 'terminal',
              instanceId: 'main-instance',
              instanceGeneration: 1,
            },
            resourceId: 'terminal-resource',
            terminal: {
              seq: 1,
              sessionId: 'pty',
              sandbox: 'fixture',
              cwd: '/home/agent/workspace',
              state: 'failed',
              output: '',
              error: 'fixture transport lost',
              cleanupPending: true,
            },
          },
    );
    mock.callbacks.get('exit')?.(1);
    await expect(service.shutdown()).rejects.toThrow('guest 清理未确认');
  });
  it('模型失败但cleanup已有确认时服务退出不阻止关闭', async () => {
    const service = new ChatService(
      () => undefined,
      () => undefined,
    );
    mock.callbacks.get('message')?.({
      type: 'event',
      conversation: { ...snapshot, state: 'failed', error: 'model rejected', cleanupPending: false },
    });
    mock.callbacks.get('exit')?.(1);
    await expect(service.shutdown()).resolves.toBeUndefined();
  });
  it.each(['send', 'open'])('%s 已请求但未收到快照时服务退出必须保留未知清理状态', async (method) => {
    const service = new ChatService(
      () => undefined,
      () => undefined,
    );
    const request = method === 'send' ? service.send('conv-personal-default', 'hello') : service.terminalOpen(80, 24, 'terminal-resource');
    const rejection = expect(request).rejects.toThrow('退出');
    mock.callbacks.get('exit')?.(1);
    await rejection;
    await expect(service.shutdown()).rejects.toThrow('guest 清理未确认');
  });
  it('terminal open ACK本身是权威快照，服务退出不得遗漏未清理会话', async () => {
    const service = new ChatService(
      () => undefined,
      () => undefined,
    );
    const opening = service.terminalOpen(80, 24, 'terminal-resource');
    const request = mock.postMessage.mock.calls[0]?.[0];
    mock.callbacks.get('message')?.({
      type: 'response',
      id: request.id,
      result: {
        seq: 1,
        sessionId: 'pty',
        sandbox: 'fixture',
        cwd: '/home/agent/workspace',
        state: 'starting',
        output: '',
        cleanupPending: true,
        error: null,
      },
    });
    await opening;
    mock.callbacks.get('exit')?.(1);
    await expect(service.shutdown()).rejects.toThrow('guest 清理未确认');
  });
  it('未ACK的send已有新快照确认清理，不保留错误的启动未知占用', async () => {
    const service = new ChatService(
      () => undefined,
      () => undefined,
    );
    const sending = service.send('conv-personal-default', 'hello');
    const rejection = expect(sending).rejects.toThrow('退出');
    mock.callbacks.get('message')?.({
      type: 'event',
      conversation: { ...snapshot, seq: 2, state: 'failed', cleanupPending: false, error: 'model rejected' },
    });
    mock.callbacks.get('exit')?.(1);
    await rejection;
    await expect(service.shutdown()).resolves.toBeUndefined();
  });
  it('初始化回执尚未到达时service退出不能推断guest probe已清理', async () => {
    mock.initialized = false;
    const service = new ChatService(
      () => undefined,
      () => undefined,
    );
    const reading = service.get('conv-personal-default');
    const rejection = expect(reading).rejects.toThrow('退出');
    mock.callbacks.get('exit')?.(1);
    await rejection;
    await expect(service.shutdown()).rejects.toThrow('guest 清理未确认');
  });
  it('无sbx配置已初始化且无远端probe，服务退出后允许关闭', async () => {
    mock.initialized = false;
    const service = new ChatService(
      () => undefined,
      () => undefined,
    );
    mock.callbacks.get('message')?.({
      type: 'initialized',
      status: { available: false, reason: 'missing configuration', version: null, sandbox: null, cwd: null },
      cleanupPending: false,
    });
    mock.callbacks.get('exit')?.(1);
    await expect(service.shutdown()).resolves.toBeUndefined();
  });
  it('成功shutdown ACK后才终止local utility，并等待exit完成关闭', async () => {
    const service = new ChatService(
      () => undefined,
      () => undefined,
    );
    const stopping = service.shutdown();
    expect(mock.kill).not.toHaveBeenCalled();
    const request = mock.postMessage.mock.calls[0]?.[0];
    mock.callbacks.get('message')?.({ type: 'response', id: request.id, result: null });
    await vi.waitFor(() => expect(mock.kill).toHaveBeenCalledOnce(), { timeout: 200 });
    let completed = false;
    void stopping.then(() => {
      completed = true;
    });
    await Promise.resolve();
    expect(completed).toBe(false);
    mock.callbacks.get('exit')?.(0);
    await expect(stopping).resolves.toBeUndefined();
    expect(service.shutdown()).toBe(stopping);
  });
  it('ACK前utility退出即便code0也不降级未确认清理或自动kill', async () => {
    const service = new ChatService(
      () => undefined,
      () => undefined,
    );
    mock.callbacks.get('message')?.({
      type: 'event',
      conversation: { ...snapshot, state: 'failed', cleanupPending: true, error: 'cleanup failed' },
    });
    const stopping = service.shutdown();
    const rejection = expect(stopping).rejects.toThrow('退出');
    mock.callbacks.get('exit')?.(0);
    await rejection;
    expect(mock.kill).not.toHaveBeenCalled();
    await expect(service.shutdown()).rejects.toThrow('退出');
  });
  it('shutdown 清理失败在重复关闭时仍显式拒绝，不等待未发生的 exit', async () => {
    const service = new ChatService(
      () => {},
      () => {},
    );
    const stopping = service.shutdown();
    const request = mock.postMessage.mock.calls[0]?.[0];
    mock.callbacks.get('message')?.({ type: 'error', id: request.id, error: 'fixture 清理失败' });
    await expect(stopping).rejects.toThrow('fixture 清理失败');
    expect(service.shutdown()).toBe(stopping);
    await expect(service.shutdown()).rejects.toThrow('fixture 清理失败');
    await expect(service.send('conv-personal-default', 'late')).rejects.toThrow('关闭');
    expect(mock.postMessage).toHaveBeenCalledOnce();
    expect(mock.kill).not.toHaveBeenCalled();
  });
  it('坏消息拒绝等待请求并通知界面，不抛出未捕获的主进程错误', async () => {
    const statuses: ChatStatus[] = [];
    const service = new ChatService(
      () => {},
      (status) => statuses.push(status),
    );
    const reading = service.get('conv-personal-default');
    mock.callbacks.get('message')?.({ type: 'response', id: 'wrong', result: 42 });
    await expect(reading).rejects.toThrow('通信失败');
    expect(statuses.at(-1)?.available).toBe(false);
    expect(mock.kill).toHaveBeenCalledOnce();
  });
});
