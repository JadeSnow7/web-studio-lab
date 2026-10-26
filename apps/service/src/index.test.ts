import { CODEX_DEFAULT_TURN } from './codex-chat';
import { emptyReferences } from './reference-test-fixture';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { GuestFrame, GuestStart } from './sbx';
import { ChatConversationSchema, type ChatServiceMessage, type ChatServiceRequest } from '@wsl/protocol';

const fixture = vi.hoisted(() => ({
  start: vi.fn(),
  appShutdown: vi.fn<() => Promise<void>>(async () => undefined),
  taskAdmission: vi.fn<(workspaceId: string | null) => Promise<void>>(async () => undefined),
}));
vi.mock('./sbx', () => ({
  SbxConnection: class {
    initialize = async () => this.getStatus();
    getStatus = () => ({ available: true, reason: null, sandbox: 'fixture', version: 'fixture', cwd: '/home/agent/workspace' });
    getCleanupPending = () => false;
    start = fixture.start;
    shutdown = async () => undefined;
  },
}));
vi.mock('./app-service', () => ({
  AppService: class {
    shutdown = fixture.appShutdown;
    assertTaskAdmission = fixture.taskAdmission;
  },
}));
vi.mock('./environment-resources', () => ({
  EnvironmentResources: class {
    shutdown = async () => undefined;
  },
}));

const initialArgv = process.argv;
const initialPort = Object.getOwnPropertyDescriptor(process, 'parentPort');
let signalListeners: NodeJS.SignalsListener[] = [];
afterEach(() => {
  process.argv = initialArgv;
  for (const listener of process.listeners('SIGTERM')) if (!signalListeners.includes(listener)) process.removeListener('SIGTERM', listener);
  if (initialPort) Object.defineProperty(process, 'parentPort', initialPort);
  else Reflect.deleteProperty(process, 'parentPort');
  vi.clearAllMocks();
});
async function host() {
  vi.resetModules();
  signalListeners = process.listeners('SIGTERM');
  fixture.start.mockImplementation((_request: GuestStart, emit: (frame: GuestFrame) => void) => {
    queueMicrotask(() =>
      emit({
        type: 'output',
        stream: 'stdout',
        data:
          [
            { type: 'thread.started', thread_id: 'history-thread' },
            { type: 'item.completed', item: { id: 'reply', type: 'agent_message', text: 'history' } },
            { type: 'turn.completed' },
          ]
            .map((event) => JSON.stringify(event))
            .join('\n') + '\n',
      }),
    );
    return {
      done: Promise.resolve({ confirmed: true, error: null, exitCode: 0 }),
      close: async () => ({ confirmed: true, error: null, exitCode: 0 }),
    };
  });
  const messages: ChatServiceMessage[] = [];
  let receive!: (event: { data: unknown }) => void;
  Object.defineProperty(process, 'parentPort', {
    configurable: true,
    value: {
      on: (_: string, listener: typeof receive) => {
        receive = listener;
      },
      postMessage: (message: ChatServiceMessage) => {
        messages.push(message);
      },
    },
  });
  process.argv = [initialArgv[0] ?? 'node', 'service', '/private/tmp/wsl-service-test'];
  await import('./index');
  await vi.waitFor(() => expect(messages.some((message) => message.type === 'initialized')).toBe(true));
  // 启动时会探测每个已注册的 ACP Harness（W4a）；以下断言只关心初始化之后由请求启动的 guest 进程。
  fixture.start.mockClear();
  return { messages, request: (data: ChatServiceRequest) => receive({ data }) };
}
const conversationId = 'conv-space-taskflow-demo-impl';
describe('service request cancellation admission', () => {
  it.each(['no-start', 'unknown'] as const)('sends a typed Profile cleanup receipt for %s self-check', async (kind) => {
    const test = await host();
    if (kind === 'unknown')
      fixture.start.mockImplementationOnce(() => ({
        done: Promise.resolve({ confirmed: false, exitCode: null, error: 'fixture cleanup unknown' }),
        close: async () => ({ confirmed: false, exitCode: null, error: 'fixture cleanup unknown' }),
      }));
    test.request({
      id: 'profile-receipt',
      method: 'profile.check',
      payload: { harnessId: kind === 'no-start' ? 'unregistered' : 'codex', profileDir: null },
    });
    await vi.waitFor(() =>
      expect(test.messages.find((message) => message.type === 'response' && message.id === 'profile-receipt')).toBeDefined(),
    );
    expect(test.messages.find((message) => message.type === 'response' && message.id === 'profile-receipt')).toMatchObject({
      type: 'response',
      id: 'profile-receipt',
      result: { type: 'profile-check', ok: kind === 'unknown', cleanupConfirmed: kind === 'no-start' },
    });
    if (kind === 'no-start') expect(fixture.start).not.toHaveBeenCalled();
  });
  it.each(['denied: edu tasks are not enabled', 'denied: source import ownership is pending'])(
    'rejects RPC send before model startup for %s',
    async (reason) => {
      const test = await host();
      const response = (id: string) => test.messages.find((message) => message.type === 'response' && message.id === id);
      test.request({ id: 'register', method: 'register', payload: { conversationId, workspaceId: 'taskflow-demo' } });
      test.request({ id: 'before', method: 'get', payload: { conversationId } });
      await vi.waitFor(() => expect(response('before')).toBeDefined());
      const prior = response('before');
      if (prior?.type !== 'response') throw new Error('missing before receipt');
      const before = ChatConversationSchema.parse(prior.result);
      fixture.taskAdmission.mockRejectedValueOnce(new Error(reason));
      test.request({
        id: 'denied',
        method: 'send',
        payload: { conversationId, text: 'must not start', references: emptyReferences(conversationId), harness: CODEX_DEFAULT_TURN },
      });
      await vi.waitFor(() =>
        expect(test.messages.find((message) => message.type === 'error' && message.id === 'denied')).toEqual({
          type: 'error',
          id: 'denied',
          error: reason,
        }),
      );
      expect(fixture.taskAdmission).toHaveBeenCalledExactlyOnceWith('taskflow-demo');
      expect(fixture.start).not.toHaveBeenCalled();
      test.request({ id: 'after', method: 'get', payload: { conversationId } });
      await vi.waitFor(() => expect(response('after')).toBeDefined());
      const received = response('after');
      if (received?.type !== 'response') throw new Error('missing after receipt');
      expect(ChatConversationSchema.parse(received.result)).toEqual(before);
    },
  );
  it.each(['cancel', 'shutdown'] as const)('%s bypasses queued sends before guest launch', async (method) => {
    const test = await host();
    test.request({ id: 'register', method: 'register', payload: { conversationId, workspaceId: 'taskflow-demo' } });
    test.request({
      id: 'send',
      method: 'send',
      payload: { conversationId, text: 'pending', references: emptyReferences(conversationId), harness: CODEX_DEFAULT_TURN },
    });
    test.request(method === 'cancel' ? { id: 'stop', method, payload: { conversationId } } : { id: 'stop', method });
    await vi.waitFor(() => expect(test.messages.some((message) => message.type === 'response' && message.id === 'stop')).toBe(true));
    await vi.waitFor(() =>
      expect(test.messages.some((message) => (message.type === 'response' || message.type === 'error') && message.id === 'send')).toBe(
        true,
      ),
    );
    expect(fixture.start).not.toHaveBeenCalled();
  });
  it('revokes chat admission as soon as shutdown arrives while app cleanup is held', async () => {
    let release: () => void = () => {
      throw new Error('cleanup not entered');
    };
    fixture.appShutdown.mockImplementationOnce(
      () =>
        new Promise<void>((resolve) => {
          release = resolve;
        }),
    );
    const test = await host();
    test.request({
      id: 'send',
      method: 'send',
      payload: {
        conversationId: 'conv-personal-default',
        text: 'pending',
        references: emptyReferences('conv-personal-default'),
        harness: CODEX_DEFAULT_TURN,
      },
    });
    test.request({ id: 'shutdown', method: 'shutdown' });
    await vi.waitFor(() => expect(fixture.appShutdown).toHaveBeenCalledOnce());
    try {
      expect(fixture.start).not.toHaveBeenCalled();
    } finally {
      release();
    }
    await vi.waitFor(() => expect(test.messages.some((message) => message.type === 'response' && message.id === 'shutdown')).toBe(true));
  });
  it.each([false, true])('publishes a new cancelled receipt for queued sends with prior history=%s', async (history) => {
    const test = await host();
    test.request({ id: 'register', method: 'register', payload: { conversationId, workspaceId: 'taskflow-demo' } });
    const response = (id: string) => test.messages.find((message) => message.type === 'response' && message.id === id);
    if (history) {
      test.request({
        id: 'history',
        method: 'send',
        payload: { conversationId, text: 'history', references: emptyReferences(conversationId), harness: CODEX_DEFAULT_TURN },
      });
      await vi.waitFor(() =>
        expect(test.messages.some((message) => message.type === 'event' && message.conversation.state === 'idle')).toBe(true),
      );
    }
    test.request({ id: 'before', method: 'get', payload: { conversationId } });
    await vi.waitFor(() => expect(response('before')).toBeDefined());
    const prior = response('before');
    if (prior?.type !== 'response') throw new Error('missing before receipt');
    const before = ChatConversationSchema.parse(prior.result);
    test.request({
      id: 'queued',
      method: 'send',
      payload: { conversationId, text: 'must not start', references: emptyReferences(conversationId), harness: CODEX_DEFAULT_TURN },
    });
    test.request({ id: 'cancel', method: 'cancel', payload: { conversationId } });
    await vi.waitFor(() => expect(response('cancel')).toBeDefined());
    await vi.waitFor(() => expect(response('queued')).toBeDefined());
    const received = response('queued');
    if (received?.type !== 'response') throw new Error('missing queued receipt');
    const cancelled = ChatConversationSchema.parse(received.result);
    expect(cancelled).toMatchObject({ state: 'cancelled', cleanupPending: false });
    expect(cancelled.seq).toBeGreaterThan(before.seq);
    expect(cancelled.turnId).not.toBe(before.turnId);
    expect(fixture.start).toHaveBeenCalledTimes(history ? 1 : 0);
  });
});
