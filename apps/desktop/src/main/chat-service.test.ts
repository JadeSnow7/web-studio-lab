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

describe('发音验证服务边界', () => {
  const status = () => ({
    lease: {
      schemaVersion: 1 as const,
      sessionId: '00000000-0000-4000-8000-000000000001',
      identity: {
        workspaceId: 'edu',
        projectId: '00000000-0000-4000-8000-000000000002',
        environmentId: 'sandbox' as const,
        appInstanceId: '00000000-0000-4000-8000-000000000003',
      },
      sourceSha256: 'a'.repeat(64),
      expiresAtMs: Date.now() + 300000,
    },
    phase: 'active' as const,
    callsUsed: 0,
    maintenanceLocked: true,
    error: null,
  });
  const target = () => {
    const { workspaceId, projectId, appInstanceId } = status().lease.identity;
    return { workspaceId, projectId, appInstanceId, sessionId: status().lease.sessionId };
  };
  it('replays startup journal state to late listeners and fails closed on service exit', async () => {
    const service = new ChatService(
      () => undefined,
      () => undefined,
    );
    const value = status();
    mock.callbacks.get('message')?.({ type: 'edu-verification-event', status: value });
    const listener = vi.fn();
    service.setVerificationListener(listener);
    expect(listener).toHaveBeenLastCalledWith(value);
    await expect(service.send('conv-personal-default', 'blocked', undefined, emptyReferences('conv-personal-default'))).rejects.toThrow();
    await expect(service.terminalOpen(80, 24, terminalBinding.resourceId)).rejects.toThrow();
    mock.callbacks.get('exit')?.(1);
    expect(listener).toHaveBeenLastCalledWith(
      expect.objectContaining({ phase: 'failed', maintenanceLocked: true, error: 'verification_service_disconnected' }),
    );
  });
  it('ended receipts retire the session so late active events cannot pause a healthy default instance', async () => {
    const service = new ChatService(
      () => undefined,
      () => undefined,
    );
    const listener = vi.fn();
    service.setVerificationListener(listener);
    mock.callbacks.get('message')?.({ type: 'edu-verification-event', status: status() });
    mock.callbacks.get('message')?.({
      type: 'edu-verification-event',
      status: {
        ...status(),
        lease: { ...status().lease, identity: { ...status().lease.identity, projectId: '00000000-0000-4000-8000-000000000009' } },
      },
    });
    mock.callbacks.get('message')?.({ type: 'edu-verification-event', status: { ...status(), phase: 'ended', maintenanceLocked: false } });
    mock.callbacks.get('message')?.({ type: 'edu-verification-event', status: status() });
    expect(listener).toHaveBeenCalledTimes(2);
    expect(listener).toHaveBeenLastCalledWith(expect.objectContaining({ phase: 'ended', maintenanceLocked: false }));
  });
  it('Main recovery guard blocks legacy sends even before journal events arrive', async () => {
    const service = new ChatService(
      () => undefined,
      () => undefined,
    );
    service.setVerificationGuard(() => true);
    await expect(service.send('conv-personal-default', 'blocked', undefined, emptyReferences('conv-personal-default'))).rejects.toThrow();
    expect(mock.postMessage).not.toHaveBeenCalled();
  });
  it('uses typed reconcile RPC and rejects mismatched session responses', async () => {
    const service = new ChatService(
      () => undefined,
      () => undefined,
    );
    const pending = service.verificationReconcile(target());
    const request = mock.postMessage.mock.calls.at(-1)![0];
    expect(request).toMatchObject({ method: 'app.verification.reconcile', payload: target() });
    mock.callbacks.get('message')?.({ type: 'response', id: request.id, result: status() });
    await expect(pending).resolves.toMatchObject({ phase: 'active' });
    const mismatch = service.verificationStatus(target());
    const query = mock.postMessage.mock.calls.at(-1)![0];
    mock.callbacks.get('message')?.({
      type: 'response',
      id: query.id,
      result: { ...status(), lease: { ...status().lease, sessionId: '00000000-0000-4000-8000-000000000004' } },
    });
    await expect(mismatch).rejects.toThrow('会话或实例不匹配');
  });
});

describe('未接管验证恢复服务边界', () => {
  const original = {
    workspaceId: 'w',
    projectId: '00000000-0000-4000-8000-000000000011',
    appInstanceId: '00000000-0000-4000-8000-000000000012',
    sourceSha256: 'c'.repeat(64),
  };
  const recovery = {
    schemaVersion: 1 as const,
    kind: 'admission-recovery' as const,
    recoveryId: '00000000-0000-4000-8000-000000000013',
    originalIdentity: {
      workspaceId: original.workspaceId,
      projectId: original.projectId,
      environmentId: 'sandbox' as const,
      appInstanceId: original.appInstanceId,
    },
    sourceSha256: original.sourceSha256,
    phase: 'restoring' as const,
    restoredIdentity: {
      workspaceId: original.workspaceId,
      projectId: original.projectId,
      environmentId: 'sandbox' as const,
      appInstanceId: '00000000-0000-4000-8000-000000000014',
    },
    maintenanceLocked: true,
    error: null,
  };
  it('retains startup recovery for late listeners and fails closed after service exit', async () => {
    const service = new ChatService(
      () => undefined,
      () => undefined,
    );
    mock.callbacks.get('message')?.({ type: 'edu-admission-recovery-event', status: recovery });
    const listener = vi.fn();
    service.setAdmissionRecoveryListener(listener);
    expect(listener).toHaveBeenLastCalledWith(recovery);
    await expect(service.send('conv-personal-default', 'blocked', undefined, emptyReferences('conv-personal-default'))).rejects.toThrow();
    mock.callbacks.get('exit')?.(1);
    expect(listener).toHaveBeenLastCalledWith(expect.objectContaining({ phase: 'failed', maintenanceLocked: true }));
  });
  it('sends only frozen begin fields and rejects mismatched original response identities', async () => {
    const service = new ChatService(
      () => undefined,
      () => undefined,
    );
    const pending = service.verificationRecoverAdmission(original);
    const request = mock.postMessage.mock.calls.at(-1)![0];
    expect(request).toMatchObject({ method: 'app.verification.recoverAdmission', payload: original });
    mock.callbacks.get('message')?.({ type: 'response', id: request.id, result: recovery });
    await expect(pending).resolves.toEqual(recovery);
    const mismatch = service.verificationRecoverAdmission(original);
    const next = mock.postMessage.mock.calls.at(-1)![0];
    mock.callbacks.get('message')?.({ type: 'response', id: next.id, result: { ...recovery, sourceSha256: 'd'.repeat(64) } });
    await expect(mismatch).rejects.toThrow('原始身份或源码不匹配');
  });
});
