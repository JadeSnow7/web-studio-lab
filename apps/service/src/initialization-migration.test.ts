import { afterEach, describe, expect, it, vi } from 'vitest';
const fixture = vi.hoisted(() => ({
  postMessage: vi.fn(),
  listener: null as null | ((event: { data: unknown }) => void),
  initialize: vi.fn(() => new Promise(() => {})),
}));
vi.mock('./codex-chat', () => ({
  CodexChat: class {
    connection = { getCleanupPending: () => false };
    initialize = fixture.initialize;
    register = vi.fn();
    getStatus = () => ({ available: false, reason: 'initializing', version: null, sandbox: null, cwd: null });
    get = (conversationId: string) => ({
      conversationId,
      generation: 'g',
      seq: 0,
      state: 'idle',
      messages: [],
      toolExecutions: [],
      warnings: [],
      cleanupPending: false,
      error: null,
      threadId: null,
      turnId: null,
    });
  },
}));
vi.mock('./resource-store', () => ({
  ResourceStore: class {
    list = async (spaceId: string) => ({ spaceId, revision: 1, resources: [] });
  },
}));
vi.mock('./terminal', () => ({
  Terminal: class {
    get = () => ({ sessionId: null, seq: 0, state: 'idle', output: '', cleanupPending: false, sandbox: null, cwd: null, error: null });
  },
}));
const processWithParent = process as NodeJS.Process & { parentPort?: unknown };
const originalParent = Object.getOwnPropertyDescriptor(process, 'parentPort');
const originalArgs = [...process.argv];
afterEach(() => {
  if (originalParent) Object.defineProperty(process, 'parentPort', originalParent);
  else delete processWithParent.parentPort;
  process.argv = originalArgs;
  vi.restoreAllMocks();
});
describe('R6 service boundary initialization', () => {
  it('answers local read/status/register requests while sbx initialization remains pending', async () => {
    fixture.postMessage.mockClear();
    vi.resetModules();
    Object.defineProperty(process, 'parentPort', {
      configurable: true,
      value: {
        on: (_event: string, listener: typeof fixture.listener) => {
          fixture.listener = listener;
        },
        postMessage: fixture.postMessage,
      },
    });
    process.argv = [process.argv[0]!, '/fixture/index.js', '/fixture/data'];
    vi.spyOn(process, 'on').mockReturnValue(process);
    await import('./index');
    const requests = [
      { id: 'register', method: 'register', payload: { conversationId: 'session-fixture', workspaceId: 'taskflow-demo' } },
      { id: 'status', method: 'status' },
      { id: 'get', method: 'get', payload: { conversationId: 'session-fixture' } },
      { id: 'resources', method: 'resources.list', payload: { spaceId: 'taskflow-demo' } },
      { id: 'terminal', method: 'terminal.get', resourceId: 'terminal-resource' },
    ];
    for (const request of requests) fixture.listener!({ data: request });
    await vi.waitFor(
      () =>
        expect(
          fixture.postMessage.mock.calls
            .filter(([message]) => message.type === 'response')
            .map(([message]) => message.id)
            .sort(),
        ).toEqual(['get', 'register', 'resources', 'status', 'terminal']),
      { timeout: 100 },
    );
  });
});
