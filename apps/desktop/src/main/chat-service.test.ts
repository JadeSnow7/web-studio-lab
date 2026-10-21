import { emptyReferences } from '../../../service/src/reference-test-fixture';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { ChatConversation, ChatStatus, ResourceInstanceIdentity, TerminalSnapshot } from '@wsl/protocol';
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
import { AppControl } from './workbench/app-control';
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
const terminalBinding: ResourceInstanceIdentity = {
  workspaceId: 'w',
  environmentId: 'sandbox',
  resourceId: 'terminal-resource',
  kind: 'terminal',
  instanceId: 'main-instance',
  instanceGeneration: 1,
};
async function bindTerminal(service: ChatService, binding = terminalBinding) {
  const registering = service.registerResource(binding);
  const request = mock.postMessage.mock.calls.at(-1)![0];
  mock.callbacks.get('message')?.({ type: 'response', id: request.id, result: null });
  await registering;
}
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
    const sending = service.send('conv-personal-default', 'hello', undefined, emptyReferences('conv-personal-default'));
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
    await bindTerminal(service);
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
    if (kind === 'terminal') await bindTerminal(service);
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
    const request =
      method === 'send'
        ? service.send('conv-personal-default', 'hello', undefined, emptyReferences('conv-personal-default'))
        : service.terminalOpen(80, 24, 'terminal-resource');
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
    const sending = service.send('conv-personal-default', 'hello', undefined, emptyReferences('conv-personal-default'));
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
  it('shutdown failure can be retried after repair and only kills utility after success', async () => {
    const service = new ChatService(
      () => undefined,
      () => undefined,
    );
    const stopping = service.shutdown();
    const first = mock.postMessage.mock.calls.at(-1)![0];
    mock.callbacks.get('message')?.({ type: 'error', id: first.id, error: 'fixture 清理失败' });
    await expect(stopping).rejects.toThrow('fixture 清理失败');
    expect(mock.kill).not.toHaveBeenCalled();
    const retry = service.shutdown();
    const second = mock.postMessage.mock.calls.at(-1)![0];
    expect(second.id).not.toBe(first.id);
    expect(service.shutdown()).toBe(retry);
    mock.callbacks.get('message')?.({ type: 'response', id: second.id, result: null });
    await Promise.resolve();
    expect(mock.kill).toHaveBeenCalledOnce();
    mock.callbacks.get('exit')?.(0);
    await expect(retry).resolves.toBeUndefined();
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
  it('retains the registered Main binding and accepts a new PTY sequence after replacement', async () => {
    const states: TerminalSnapshot[] = [];
    const service = new ChatService(
      () => {},
      () => {},
      (terminal) => states.push(terminal),
    );
    const terminal = {
      seq: 100,
      sessionId: 'old-pty',
      sandbox: 'fixture',
      cwd: null,
      state: 'closed',
      output: 'old',
      cleanupPending: false,
      error: null,
    };
    await bindTerminal(service);
    mock.callbacks.get('message')?.({ type: 'terminal-event', binding: terminalBinding, resourceId: terminalBinding.resourceId, terminal });
    const replacement = { ...terminalBinding, instanceId: 'new-main', instanceGeneration: 2 };
    await bindTerminal(service, replacement);
    mock.callbacks.get('message')?.({
      type: 'terminal-event',
      binding: replacement,
      resourceId: terminalBinding.resourceId,
      terminal: { ...terminal, seq: 1, sessionId: 'new-pty', state: 'running', cleanupPending: true, output: 'new' },
    });
    mock.callbacks.get('message')?.({
      type: 'terminal-event',
      binding: terminalBinding,
      resourceId: terminalBinding.resourceId,
      terminal: { ...terminal, seq: 101 },
    });
    expect(states.at(-1)).toMatchObject({ sessionId: 'new-pty', output: 'new', state: 'running' });
    mock.callbacks.get('exit')?.(1);
    expect(states.at(-1)).toMatchObject({ sessionId: 'new-pty', state: 'failed', cleanupPending: true });
    await expect(service.shutdown()).rejects.toThrow('清理未确认');
  });
});

describe('control-plane relay', () => {
  const scope = { workspaceId: 'w', sessionId: 's', runId: 'r', sources: [] };
  it('routes app-call frames to the Main dispatcher, replies with app.reply and propagates app-abort', async () => {
    const service = new ChatService(vi.fn(), vi.fn());
    let seen: AbortSignal | undefined;
    let finish!: () => void;
    service.setAppControlReader(async (_scope, tool, _args, signal) => {
      seen = signal;
      await new Promise<void>((resolve) => (finish = resolve));
      return { ok: true, tool: tool as 'app.status', data: { state: 'running' } };
    });
    const id = '00000000-0000-4000-8000-000000000001';
    mock.callbacks.get('message')?.({ type: 'app-call', id, scope, tool: 'app.status', args: {} });
    await vi.waitFor(() => expect(seen).toBeDefined());
    mock.callbacks.get('message')?.({ type: 'app-abort', id });
    expect(seen!.aborted).toBe(true);
    finish();
    await vi.waitFor(() => expect(mock.postMessage.mock.calls.some(([data]) => data.method === 'app.reply')).toBe(true));
    const reply = mock.postMessage.mock.calls.find(([data]) => data.method === 'app.reply')![0];
    expect(reply.payload).toEqual({ callId: id, result: { ok: true, tool: 'app.status', data: { state: 'running' } } });
  });
  it('pre-cancelled appAgent sends no service request', async () => {
    const service = new ChatService(vi.fn(), vi.fn());
    const controller = new AbortController();
    controller.abort();
    const pending = service.appAgent({ workspaceId: 'w', projectId: 'p' }, null, { op: 'snapshot' }, controller.signal);
    expect(mock.postMessage.mock.calls.filter(([request]) => request.method.startsWith('app.agent'))).toEqual([]);
    expect(await pending).toMatchObject({
      cleanupConfirmed: true,
      operationDispatched: false,
      envelope: { ok: false, error: { code: 'cancelled' } },
    });
  });
  it('appAgent cancels its service call by callId when the dispatcher aborts', async () => {
    const service = new ChatService(vi.fn(), vi.fn());
    const controller = new AbortController();
    const target = { workspaceId: 'w', projectId: '00000000-0000-4000-8000-000000000002' };
    const pending = service.appAgent(target, 'app-1', { op: 'snapshot' }, controller.signal);
    const request = mock.postMessage.mock.calls.at(-1)![0];
    expect(request).toMatchObject({ method: 'app.agent', payload: { target, appInstanceId: 'app-1', operation: { op: 'snapshot' } } });
    controller.abort();
    const cancel = mock.postMessage.mock.calls.at(-1)![0];
    expect(cancel).toMatchObject({ method: 'app.agent.cancel', payload: { callId: request.payload.callId } });
    mock.callbacks.get('message')?.({ type: 'response', id: cancel.id, result: null });
    mock.callbacks.get('message')?.({
      type: 'response',
      id: request.id,
      result: { mode: 'cli', cleanupConfirmed: true, envelope: { ok: false, error: { code: 'cancelled', message: 'x' } } },
    });
    expect(await pending).toEqual({
      mode: 'cli',
      cleanupConfirmed: true,
      envelope: { ok: false, error: { code: 'cancelled', message: 'x' } },
    });
  });
});

describe('CLI read cancellation before adapter dispatch', () => {
  it('clears the reserved Main occupancy when real ChatService sees cancellation after pending metadata was saved', async () => {
    const service = new ChatService(vi.fn(), vi.fn());
    const controller = new AbortController();
    const control = new AppControl({
      context: async () => ({
        workspaceId: 'w',
        sessionId: 's',
        runId: 'run',
        allowsReset: false,
        app: { projectId: 'p', appInstanceId: null, state: 'stopped', url: null, cleanupConfirmed: true, error: null },
        browser: null,
      }),
      ui: () => {
        throw new Error('no browser');
      },
      agent: (target, instance, operation, signal) => service.appAgent(target, instance, operation, signal),
      logs: async () => ({ text: '', truncated: false, totalBytes: 0 }),
      leaseValid: () => false,
      restart: () => {
        throw new Error('no restart');
      },
      store: {
        savePending: async (operations) => {
          if (operations.length) controller.abort();
        },
        appendAudit: async () => undefined,
        writeEvidence: async () => '',
      },
    });
    const result = await control.call(
      { workspaceId: 'w', sessionId: 's', runId: 'run', sources: [] },
      'app.describe',
      {},
      controller.signal,
    );
    expect(result).toMatchObject({ ok: false, error: { code: 'cancelled' } });
    expect(mock.postMessage.mock.calls.filter(([request]) => request.method.startsWith('app.agent'))).toEqual([]);
    expect(control.hasPending('w', 'run')).toBe(false);
  });
});

it('pre-cancelled cleanup reconciliation cannot claim the original operation was never dispatched', async () => {
  const service = new ChatService(vi.fn(), vi.fn());
  const controller = new AbortController();
  controller.abort();
  const result = await service.appAgent({ workspaceId: 'w', projectId: 'p' }, null, { op: 'reconcile-cli' }, controller.signal);
  expect(result.operationDispatched).toBeUndefined();
  expect(mock.postMessage.mock.calls.filter(([request]) => request.method.startsWith('app.agent'))).toEqual([]);
});

describe('source snapshot cleanup transport', () => {
  const target = { workspaceId: 'w', projectId: '00000000-0000-4000-8000-000000000003' };
  it.each([true, false])('preserves typed cleanupConfirmed=%s from an owned source failure receipt', async (cleanupConfirmed) => {
    const service = new ChatService(vi.fn(), vi.fn());
    const pending = service.appSourceSnapshot(target, new AbortController().signal).catch((error: unknown) => error);
    const request = mock.postMessage.mock.calls.at(-1)?.[0];
    const result = { ok: false, target, cleanupConfirmed, error: 'synthetic collector failure' };
    mock.callbacks.get('message')?.({ type: 'response', id: request.id, result });
    expect(await pending).toEqual(result);
    mock.callbacks.get('exit')?.(1);
    if (cleanupConfirmed) await expect(service.shutdown()).resolves.toBeUndefined();
    else await expect(service.shutdown()).rejects.toThrow('清理未确认');
  });
  it('does not treat a cancel ACK as source cleanup, and keeps transport loss unresolved', async () => {
    const service = new ChatService(vi.fn(), vi.fn());
    const controller = new AbortController();
    let settled = false;
    const pending = service
      .appSourceSnapshot(target, controller.signal)
      .catch((error: unknown) => error)
      .then((result) => {
        settled = true;
        return result;
      });
    const request = mock.postMessage.mock.calls.at(-1)?.[0];
    controller.abort();
    const cancel = mock.postMessage.mock.calls.at(-1)?.[0];
    expect(cancel).toMatchObject({ method: 'app.source.cancel', payload: { callId: request.payload.callId } });
    mock.callbacks.get('message')?.({ type: 'response', id: cancel.id, result: null });
    await Promise.resolve();
    expect(settled).toBe(false);
    mock.callbacks.get('exit')?.(1);
    expect(await pending).toMatchObject({ ok: false, target, cleanupConfirmed: false });
    await expect(service.shutdown()).rejects.toThrow('清理未确认');
  });
  it('does not dispatch a pre-cancelled source request or invent an unresolved helper', async () => {
    const service = new ChatService(vi.fn(), vi.fn());
    const controller = new AbortController();
    controller.abort();
    expect(await service.appSourceSnapshot(target, controller.signal)).toMatchObject({ ok: false, target, cleanupConfirmed: true });
    expect(mock.postMessage).not.toHaveBeenCalled();
    mock.callbacks.get('exit')?.(0);
    await expect(service.shutdown()).resolves.toBeUndefined();
  });
  it('does not use foreign or stale source receipts to release another helper', async () => {
    const service = new ChatService(vi.fn(), vi.fn());
    const first = service.appSourceSnapshot(target, new AbortController().signal);
    const oldRequest = mock.postMessage.mock.calls.at(-1)?.[0];
    mock.callbacks.get('message')?.({
      type: 'response',
      id: oldRequest.id,
      result: { ok: false, target, cleanupConfirmed: true, error: 'synthetic clean failure' },
    });
    expect(await first).toMatchObject({ cleanupConfirmed: true });
    const second = service.appSourceSnapshot(target, new AbortController().signal);
    const newRequest = mock.postMessage.mock.calls.at(-1)?.[0];
    expect(newRequest.payload.callId).not.toBe(oldRequest.payload.callId);
    mock.callbacks.get('message')?.({
      type: 'response',
      id: oldRequest.id,
      result: { ok: false, target, cleanupConfirmed: false, error: 'stale' },
    });
    mock.callbacks.get('message')?.({
      type: 'response',
      id: newRequest.id,
      result: { ok: false, target: { ...target, workspaceId: 'foreign' }, cleanupConfirmed: true, error: 'foreign' },
    });
    expect(await second).toMatchObject({ ok: false, target, cleanupConfirmed: false });
    mock.callbacks.get('exit')?.(1);
    await expect(service.shutdown()).rejects.toThrow('清理未确认');
  });
  it('accepts only the matching successful source receipt, including its cleanup fact', async () => {
    const service = new ChatService(vi.fn(), vi.fn());
    const pending = service.appSourceSnapshot(target, new AbortController().signal).catch((error: unknown) => error);
    const request = mock.postMessage.mock.calls.at(-1)?.[0];
    const result = { ok: true, cleanupConfirmed: true, snapshot: { ...target, files: [], totalBytes: 0 } };
    mock.callbacks.get('message')?.({ type: 'response', id: request.id, result });
    expect(await pending).toEqual(result);
    mock.callbacks.get('exit')?.(0);
    await expect(service.shutdown()).resolves.toBeUndefined();
  });
});

describe('source task dispatch uncertainty', () => {
  it('retains cleanup uncertainty when postMessage throws after attempting dispatch', async () => {
    const service = new ChatService(vi.fn(), vi.fn());
    mock.postMessage.mockImplementationOnce(() => {
      throw new Error('synthetic post dispatch error');
    });
    await expect(service.send('conv-personal-default', 'hello', undefined, emptyReferences('conv-personal-default'))).rejects.toMatchObject(
      { cleanupPending: true, knownNotSent: false },
    );
    mock.callbacks.get('exit')?.(1);
    await expect(service.shutdown()).rejects.toThrow('清理未确认');
  });
  it.each([null, { ...snapshot, conversationId: 'session-foreign' }])(
    'does not treat malformed or foreign send receipts as proof of cleanup',
    async (result) => {
      const service = new ChatService(vi.fn(), vi.fn());
      const sending = service.send('conv-personal-default', 'hello', undefined, emptyReferences('conv-personal-default'));
      const rejection = expect(sending).rejects.toMatchObject({ cleanupPending: true, knownNotSent: false });
      const request = mock.postMessage.mock.calls.at(-1)?.[0];
      mock.callbacks.get('message')?.({ type: 'response', id: request.id, result });
      await rejection;
      mock.callbacks.get('exit')?.(1);
      await expect(service.shutdown()).rejects.toThrow('清理未确认');
    },
  );
});

describe('source task explicit admission rejection', () => {
  it('distinguishes an ordered service rejection before executor publication', async () => {
    const service = new ChatService(vi.fn(), vi.fn());
    const sending = service.send('conv-personal-default', 'hello', undefined, emptyReferences('conv-personal-default'));
    const rejection = expect(sending).rejects.toMatchObject({ cleanupPending: false, knownNotSent: true });
    const request = mock.postMessage.mock.calls.at(-1)?.[0];
    mock.callbacks.get('message')?.({ type: 'error', id: request.id, error: 'synthetic admission denied' });
    await rejection;
    mock.callbacks.get('exit')?.(0);
    await expect(service.shutdown()).resolves.toBeUndefined();
  });
  it('preserves a published executor cleanup obligation even when send subsequently returns an error', async () => {
    const service = new ChatService(vi.fn(), vi.fn());
    const sending = service.send('conv-personal-default', 'hello', undefined, emptyReferences('conv-personal-default'));
    const rejection = expect(sending).rejects.toMatchObject({ cleanupPending: true, knownNotSent: false });
    const request = mock.postMessage.mock.calls.at(-1)?.[0];
    mock.callbacks.get('message')?.({ type: 'event', conversation: snapshot });
    mock.callbacks.get('message')?.({ type: 'error', id: request.id, error: 'synthetic admitted failure' });
    await rejection;
    mock.callbacks.get('exit')?.(1);
    await expect(service.shutdown()).rejects.toThrow('清理未确认');
  });
});

describe('source dispatch receipt ownership', () => {
  it.each(['error', 'exit'] as const)('never lets an A response publish a fake cleanup fact into a concurrent B %s', async (kind) => {
    const service = new ChatService(vi.fn(), vi.fn());
    const a = 'conv-personal-default';
    const b = 'session-00000000-0000-4000-8000-000000000004';
    const sendingB = service.send(b, 'B', undefined, emptyReferences(b));
    const rejectedB = expect(sendingB).rejects.toMatchObject({ cleanupPending: true, knownNotSent: false });
    const requestB = mock.postMessage.mock.calls.at(-1)?.[0];
    mock.callbacks.get('message')?.({ type: 'event', conversation: { ...snapshot, conversationId: b, seq: 2 } });
    // W0 write lease: a concurrent send from another slot is refused before leaving Main,
    // so the forged B receipt arrives on A's slot-bound cancel reply instead.
    const postedBeforeA = mock.postMessage.mock.calls.length;
    await expect(service.send(a, 'A', undefined, emptyReferences(a))).rejects.toThrow(/^conflict: /);
    expect(mock.postMessage.mock.calls).toHaveLength(postedBeforeA);
    const rejectedA = expect(service.cancel(a)).rejects.toThrow('归属不匹配');
    const requestA = mock.postMessage.mock.calls.at(-1)?.[0];
    mock.callbacks.get('message')?.({
      type: 'response',
      id: requestA.id,
      result: { ...snapshot, conversationId: b, seq: 100, state: 'idle', cleanupPending: false },
    });
    await rejectedA;
    if (kind === 'error') mock.callbacks.get('message')?.({ type: 'error', id: requestB.id, error: 'B dispatch failed after admission' });
    else mock.callbacks.get('exit')?.(1);
    await rejectedB;
  });
  it('settles an owned source cleanup receipt before a delayed cancellation ACK without rejecting that late ACK', async () => {
    const target = { workspaceId: 'w', projectId: '00000000-0000-4000-8000-000000000003' };
    const service = new ChatService(vi.fn(), vi.fn());
    const controller = new AbortController();
    let settled = false;
    const pending = service.appSourceSnapshot(target, controller.signal).then((value) => {
      settled = true;
      return value;
    });
    const snapshotRequest = mock.postMessage.mock.calls.at(-1)?.[0];
    controller.abort();
    const cancellation = mock.postMessage.mock.calls.at(-1)?.[0];
    mock.callbacks.get('message')?.({
      type: 'response',
      id: snapshotRequest.id,
      result: { ok: false, target, cleanupConfirmed: true, error: 'cancelled' },
    });
    try {
      await new Promise<void>((resolve) => setImmediate(resolve));
      expect(settled).toBe(true);
    } finally {
      mock.callbacks.get('message')?.({ type: 'response', id: cancellation.id, result: null });
      await expect(pending).resolves.toMatchObject({ cleanupConfirmed: true });
    }
    expect(mock.kill).not.toHaveBeenCalled();
    mock.callbacks.get('exit')?.(0);
    await expect(service.shutdown()).resolves.toBeUndefined();
  });
});

describe('source cleanup cache boundary', () => {
  it.each(['source', 'get'] as const)('does not let a %s reply publish another pending send cleanup', async (method) => {
    const service = new ChatService(vi.fn(), vi.fn());
    const target = { workspaceId: 'w', projectId: '00000000-0000-4000-8000-000000000003' };
    const b = 'session-concurrent-source-owner';
    const sendingB = service.send(b, 'B', undefined, emptyReferences(b)).catch((error: unknown) => error);
    const requestB = mock.postMessage.mock.calls.at(-1)?.[0];
    mock.callbacks.get('message')?.({ type: 'event', conversation: { ...snapshot, conversationId: b, seq: 2 } });
    const other =
      method === 'source'
        ? service.appSourceSnapshot(target, new AbortController().signal)
        : service.get('conv-personal-default').catch((error: unknown) => error);
    const requestA = mock.postMessage.mock.calls.at(-1)?.[0];
    mock.callbacks.get('message')?.({
      type: 'response',
      id: requestA.id,
      result: { ...snapshot, conversationId: b, seq: 100, state: 'idle', cleanupPending: false },
    });
    const otherResult = await other;
    mock.callbacks.get('message')?.({ type: 'error', id: requestB.id, error: 'B failed after executor admission' });
    const outcome = await sendingB;
    expect(outcome).toMatchObject({ cleanupPending: true, knownNotSent: false });
    if (method === 'source') expect(otherResult).toMatchObject({ ok: false, target, cleanupConfirmed: false });
    else expect(otherResult).toBeInstanceOf(Error);
  });
});

describe('sandbox 工作区写入许可（W0）', () => {
  const sends = () => mock.postMessage.mock.calls.filter(([request]) => request.method === 'send');
  const reply = (result: unknown) => {
    const request = mock.postMessage.mock.calls.at(-1)![0];
    mock.callbacks.get('message')?.({ type: 'response', id: request.id, result });
  };
  const event = (conversation: ChatConversation) => mock.callbacks.get('message')?.({ type: 'event', conversation });
  const running: ChatConversation = {
    ...snapshot,
    conversationId: 'conv-personal-default',
    seq: 1,
    state: 'running',
    cleanupPending: true,
  };

  it('L1/L2：另一会话运行中时拒绝且不发请求，完成并确认清理后放行', async () => {
    const service = new ChatService(vi.fn(), vi.fn());
    const first = service.send('conv-personal-default', 'a', undefined, emptyReferences('conv-personal-default'));
    reply(running);
    await first;
    await expect(service.send('session-b', 'b', undefined, emptyReferences('session-b'))).rejects.toThrow(
      /^conflict: .*conv-personal-default/,
    );
    expect(sends()).toHaveLength(1);
    expect(service.writeHolder()).toBe('conv-personal-default');
    event({ ...running, seq: 2, state: 'idle', cleanupPending: false });
    expect(service.writeHolder()).toBeNull();
    const second = service.send('session-b', 'b', undefined, emptyReferences('session-b'));
    expect(sends()).toHaveLength(2);
    reply({ ...running, conversationId: 'session-b', seq: 3 });
    await second;
    expect(service.writeHolder()).toBe('session-b');
  });

  it('L3：取消或失败但清理未确认时继续占用', async () => {
    const service = new ChatService(vi.fn(), vi.fn());
    const first = service.send('conv-personal-default', 'a', undefined, emptyReferences('conv-personal-default'));
    reply(running);
    await first;
    event({ ...running, seq: 2, state: 'cancelled', cleanupPending: true });
    await expect(service.send('session-b', 'b', undefined, emptyReferences('session-b'))).rejects.toThrow(/^conflict:/);
    event({ ...running, seq: 3, state: 'failed', cleanupPending: true, error: 'x' });
    await expect(service.send('session-b', 'b', undefined, emptyReferences('session-b'))).rejects.toThrow(/^conflict:/);
    event({ ...running, seq: 4, state: 'cancelled', cleanupPending: false });
    expect(service.writeHolder()).toBeNull();
  });

  it('L4/L6：service 明确拒绝未启动的发送时立即释放；同一会话重复发送不额外拒绝', async () => {
    const service = new ChatService(vi.fn(), vi.fn());
    const rejected = service.send('conv-personal-default', 'a', undefined, emptyReferences('conv-personal-default'));
    const request = mock.postMessage.mock.calls.at(-1)![0];
    mock.callbacks.get('message')?.({ type: 'error', id: request.id, error: 'sbx 不可用' });
    await expect(rejected).rejects.toThrow('sbx 不可用');
    expect(service.writeHolder()).toBeNull();

    const first = service.send('conv-personal-default', 'a', undefined, emptyReferences('conv-personal-default'));
    reply(running);
    await first;
    const again = service.send('conv-personal-default', 'again', undefined, emptyReferences('conv-personal-default'));
    expect(sends()).toHaveLength(3);
    const last = mock.postMessage.mock.calls.at(-1)![0];
    mock.callbacks.get('message')?.({ type: 'error', id: last.id, error: '当前会话正在等待回复' });
    await expect(again).rejects.toThrow('当前会话正在等待回复');
    expect(service.writeHolder()).toBe('conv-personal-default');
  });

  it('L5：早于取得许可时的旧快照不释放', async () => {
    const service = new ChatService(vi.fn(), vi.fn());
    event({ ...running, seq: 5, state: 'idle', cleanupPending: false });
    const first = service.send('conv-personal-default', 'a', undefined, emptyReferences('conv-personal-default'));
    event({ ...running, seq: 4, state: 'idle', cleanupPending: false });
    expect(service.writeHolder()).toBe('conv-personal-default');
    reply({ ...running, seq: 6 });
    await first;
    expect(service.writeHolder()).toBe('conv-personal-default');
  });

  it('服务通信失败后保留许可，并以原始故障拒绝后续发送', async () => {
    const service = new ChatService(vi.fn(), vi.fn());
    const first = service.send('conv-personal-default', 'a', undefined, emptyReferences('conv-personal-default'));
    mock.callbacks.get('exit')?.(1);
    await expect(first).rejects.toThrow('退出');
    expect(service.writeHolder()).toBe('conv-personal-default');
    await expect(service.send('session-b', 'b', undefined, emptyReferences('session-b'))).rejects.toThrow('退出');
  });

  // 以下对应 PR #17 的 RunDispatchFailure 判定：只有“从未启动”的拒绝释放许可。
  it('L4：判定为从未启动的拒绝（knownNotSent）释放许可', async () => {
    const service = new ChatService(vi.fn(), vi.fn());
    const rejected = service.send('conv-personal-default', 'a', undefined, emptyReferences('conv-personal-default'));
    const request = mock.postMessage.mock.calls.at(-1)![0];
    mock.callbacks.get('message')?.({ type: 'error', id: request.id, error: 'admission denied' });
    await expect(rejected).rejects.toMatchObject({ cleanupPending: false, knownNotSent: true });
    expect(service.writeHolder()).toBeNull();
  });

  it('已接纳但清理未确认的拒绝保留许可', async () => {
    const service = new ChatService(vi.fn(), vi.fn());
    const rejected = service.send('conv-personal-default', 'a', undefined, emptyReferences('conv-personal-default'));
    const request = mock.postMessage.mock.calls.at(-1)![0];
    event(running);
    mock.callbacks.get('message')?.({ type: 'error', id: request.id, error: 'failed after admission' });
    await expect(rejected).rejects.toMatchObject({ cleanupPending: true, knownNotSent: false });
    expect(service.writeHolder()).toBe('conv-personal-default');
    await expect(service.send('session-b', 'b', undefined, emptyReferences('session-b'))).rejects.toThrow(/^conflict:/);
  });

  it('已接纳且新快照确认停止与清理后，按 observe 释放', async () => {
    const service = new ChatService(vi.fn(), vi.fn());
    const rejected = service.send('conv-personal-default', 'a', undefined, emptyReferences('conv-personal-default'));
    const request = mock.postMessage.mock.calls.at(-1)![0];
    event({ ...running, state: 'failed', cleanupPending: false, error: 'x' });
    mock.callbacks.get('message')?.({ type: 'error', id: request.id, error: 'failed after admission' });
    await expect(rejected).rejects.toMatchObject({ cleanupPending: false, knownNotSent: false });
    expect(service.writeHolder()).toBeNull();
  });

  it.each([
    ['形状不符', { unexpected: true }],
    ['归属不符', { ...running, conversationId: 'session-b' }],
  ])('启动回执%s时视为清理未知并保留许可', async (_label, result) => {
    const service = new ChatService(vi.fn(), vi.fn());
    const sending = service.send('conv-personal-default', 'a', undefined, emptyReferences('conv-personal-default'));
    reply(result);
    await expect(sending).rejects.toMatchObject({ cleanupPending: true, knownNotSent: false });
    expect(service.writeHolder()).toBe('conv-personal-default');
  });
});
