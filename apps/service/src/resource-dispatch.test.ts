import { createHash } from 'node:crypto';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { ChatConversation, ChatServiceRequest, PageResourceSnapshot, ResourceCollection } from '@wsl/protocol';

const mocks = vi.hoisted(() => ({
  listener: null as ((event: { data: unknown }) => void) | null,
  postMessage: vi.fn(),
  list: vi.fn(),
  save: vi.fn(),
  remove: vi.fn(),
  assertMutation: vi.fn(),
  invalidate: vi.fn(),
  send: vi.fn(),
  cancel: vi.fn(),
}));
vi.mock('./resource-store', () => ({
  ResourceStore: class {
    list = mocks.list;
    save = mocks.save;
    remove = mocks.remove;
  },
}));
vi.mock('./codex-chat', () => ({
  CodexChat: class {
    setObservationReader = vi.fn();
    connection = { getCleanupPending: () => false };
    initialize = async () => ({ available: true, reason: null, version: 'fixture', sandbox: 'fixture', cwd: '/home/agent/workspace' });
    assertResourceMutationAllowed = mocks.assertMutation;
    invalidateResources = mocks.invalidate;
    send = mocks.send;
    cancel = mocks.cancel;
  },
}));
vi.mock('./terminal', () => ({ Terminal: class {} }));
const empty: ResourceCollection = { spaceId: 'taskflow-demo', revision: 0, resources: [] };
const snapshot: PageResourceSnapshot = {
  page: { webContentsId: 1, documentGeneration: 2, url: 'https://example.com/', title: 'Example', partition: 'preview' },
  requestedUrl: 'https://example.com/',
  url: 'https://example.com/',
  title: 'Example',
  text: 'body',
  capturedAt: '2026-10-06T12:00:00.000Z',
  sourceSha256: '0'.repeat(64),
  contentSha256: createHash('sha256').update('body').digest('hex'),
  extractionVersion: 'html-text-v1',
  truncated: false,
};
const conversation: ChatConversation = {
  conversationId: 'conv-space-taskflow-demo-impl',
  generation: 'g',
  seq: 1,
  threadId: null,
  turnId: 't',
  state: 'running',
  messages: [],
  toolExecutions: [],
  warnings: [],
  cleanupPending: false,
  error: null,
};
const originalArgv = [...process.argv];
const originalPort = Object.getOwnPropertyDescriptor(process, 'parentPort');
let previousListeners: ((signal: NodeJS.Signals) => void)[];
beforeEach(async () => {
  vi.resetModules();
  vi.clearAllMocks();
  mocks.list.mockResolvedValue(empty);
  mocks.save.mockResolvedValue({ ...empty, revision: 1 });
  mocks.send.mockResolvedValue(conversation);
  mocks.cancel.mockResolvedValue({ ...conversation, state: 'cancelled' });
  mocks.assertMutation.mockReset();
  process.argv[2] = '/tmp/wsl-resource-dispatch-fixture';
  previousListeners = process.listeners('SIGTERM');
  Object.defineProperty(process, 'parentPort', {
    configurable: true,
    value: {
      on: (_event: string, listener: (event: { data: unknown }) => void) => {
        mocks.listener = listener;
      },
      postMessage: mocks.postMessage,
    },
  });
  await import('./index');
});
afterEach(() => {
  process.argv = [...originalArgv];
  if (originalPort) Object.defineProperty(process, 'parentPort', originalPort);
  else Reflect.deleteProperty(process, 'parentPort');
  for (const listener of process.listeners('SIGTERM'))
    if (!previousListeners.includes(listener)) process.removeListener('SIGTERM', listener);
});
const dispatch = (data: ChatServiceRequest) => mocks.listener!({ data });
const capture = (id: string) => dispatch({ id, method: 'resources.save', payload: { spaceId: 'taskflow-demo', snapshot } });
const start = () => dispatch({ id: 'start', method: 'send', payload: { conversationId: 'conv-space-taskflow-demo-impl', text: 'read' } });

describe('资源提交与聊天入口的顺序', () => {
  it('持久化完成及失效旧上下文后才允许启动下一轮，随后 cancel 仍按请求顺序到达', async () => {
    let commit: (value: ResourceCollection) => void = () => {
      throw new Error('save not started');
    };
    mocks.save.mockImplementationOnce(
      () =>
        new Promise<ResourceCollection>((resolve) => {
          commit = resolve;
        }),
    );
    capture('save');
    await vi.waitFor(() => expect(mocks.save).toHaveBeenCalledOnce());
    start();
    dispatch({ id: 'cancel', method: 'cancel', payload: { conversationId: 'conv-space-taskflow-demo-impl' } });
    await Promise.resolve();
    expect(mocks.send).not.toHaveBeenCalled();
    expect(mocks.cancel).not.toHaveBeenCalled();
    commit({ ...empty, revision: 1 });
    await vi.waitFor(() => expect(mocks.cancel).toHaveBeenCalledOnce());
    expect(mocks.invalidate.mock.invocationCallOrder[0]).toBeLessThan(mocks.send.mock.invocationCallOrder[0]!);
    expect(mocks.send.mock.invocationCallOrder[0]).toBeLessThan(mocks.cancel.mock.invocationCallOrder[0]!);
  });
  it('保存失败回传错误，不失效旧上下文，后续合法请求仍能执行', async () => {
    mocks.save.mockRejectedValueOnce(new Error('fixture atomic write failed'));
    capture('save');
    start();
    await vi.waitFor(() => expect(mocks.send).toHaveBeenCalledOnce());
    expect(mocks.postMessage).toHaveBeenCalledWith({ type: 'error', id: 'save', error: 'fixture atomic write failed' });
    expect(mocks.invalidate).not.toHaveBeenCalled();
  });
  it('活动轮次拒绝变更，幂等保存不切断上下文', async () => {
    mocks.assertMutation.mockImplementationOnce(() => {
      throw new Error('请先停止回复');
    });
    capture('busy');
    await vi.waitFor(() => expect(mocks.postMessage).toHaveBeenCalledWith({ type: 'error', id: 'busy', error: '请先停止回复' }));
    expect(mocks.save).not.toHaveBeenCalled();
    mocks.save.mockResolvedValueOnce(empty);
    capture('same');
    await vi.waitFor(() => expect(mocks.postMessage).toHaveBeenCalledWith({ type: 'response', id: 'same', result: empty }));
    expect(mocks.invalidate).not.toHaveBeenCalled();
  });
});
