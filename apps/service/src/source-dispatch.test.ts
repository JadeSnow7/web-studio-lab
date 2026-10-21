import { randomUUID } from 'node:crypto';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { AppSourceSnapshotResult, AppTarget, ChatServiceMessage, ChatServiceRequest, ChatStatus } from '@wsl/protocol';

const fixture = vi.hoisted(() => ({
  snapshot: vi.fn<(target: AppTarget, signal: AbortSignal) => Promise<AppSourceSnapshotResult>>(),
  initialize: vi.fn<() => Promise<ChatStatus>>(),
  shutdown: vi.fn<() => Promise<void>>(async () => undefined),
}));
vi.mock('./sbx', () => ({
  SbxConnection: class {
    getCleanupPending = () => false;
  },
}));
vi.mock('./codex-chat', () => ({
  CodexChat: class {
    constructor(
      _root: string,
      _publish: unknown,
      readonly connection: { getCleanupPending: () => boolean },
    ) {}
    initialize = fixture.initialize;
    setObservationReader() {}
    setAppControlReader() {}
    beginShutdown() {}
    shutdown = async () => undefined;
  },
}));
vi.mock('./app-service', () => ({
  AppService: class {
    sourceSnapshot = fixture.snapshot;
    shutdown = fixture.shutdown;
  },
}));
vi.mock('./environment-resources', () => ({
  EnvironmentResources: class {
    shutdown = async () => undefined;
  },
}));

const initialArgv = process.argv;
const initialPort = Object.getOwnPropertyDescriptor(process, 'parentPort');
const status: ChatStatus = { available: true, reason: null, sandbox: 'fixture', version: 'fixture', cwd: '/fixture' };
const target = { workspaceId: 'space-source', projectId: 'a33d7ef0-ea73-4fd6-b4a0-e41bd68f1090' };
let signalListeners: NodeJS.SignalsListener[] = [];
function deferred<T>() {
  let complete: ((value: T) => void) | undefined;
  const promise = new Promise<T>((resolve) => {
    complete = resolve;
  });
  return {
    promise,
    resolve(value: T) {
      if (!complete) throw new Error('uninitialized fixture');
      complete(value);
    },
  };
}
beforeEach(() => {
  fixture.snapshot.mockReset();
  fixture.initialize.mockReset().mockResolvedValue(status);
  fixture.shutdown.mockReset().mockResolvedValue(undefined);
});
afterEach(() => {
  process.argv = initialArgv;
  for (const listener of process.listeners('SIGTERM')) if (!signalListeners.includes(listener)) process.removeListener('SIGTERM', listener);
  if (initialPort) Object.defineProperty(process, 'parentPort', initialPort);
  else Reflect.deleteProperty(process, 'parentPort');
});
async function host() {
  vi.resetModules();
  signalListeners = process.listeners('SIGTERM');
  const messages: ChatServiceMessage[] = [];
  let receive: ((event: { data: unknown }) => void) | undefined;
  Object.defineProperty(process, 'parentPort', {
    configurable: true,
    value: {
      on: (_event: string, listener: (event: { data: unknown }) => void) => {
        receive = listener;
      },
      postMessage: (message: ChatServiceMessage) => {
        messages.push(message);
      },
    },
  });
  process.argv = [initialArgv[0] ?? 'node', 'service', '/synthetic/source-dispatch'];
  await import('./index');
  return {
    messages,
    request: (data: ChatServiceRequest) => {
      if (!receive) throw new Error('missing service listener');
      receive({ data });
    },
    response: (id: string) => messages.find((message) => message.type === 'response' && message.id === id),
  };
}
const cancelled = (): AppSourceSnapshotResult => ({ ok: false, target, cleanupConfirmed: true, error: 'controlled cancellation settled' });

describe('source snapshot service message ownership', () => {
  it('acknowledges cancellation while retaining the original pending cleanup response', async () => {
    const gate = deferred<AppSourceSnapshotResult>();
    fixture.snapshot.mockReturnValue(gate.promise);
    const test = await host();
    const callId = randomUUID();
    test.request({ id: 'source', method: 'app.source.snapshot', payload: { callId, target } });
    try {
      await vi.waitFor(() => expect(fixture.snapshot).toHaveBeenCalledOnce());
      test.request({ id: 'foreign-cancel', method: 'app.source.cancel', payload: { callId: randomUUID() } });
      expect(fixture.snapshot.mock.calls[0]?.[1].aborted).toBe(false);
      test.request({ id: 'cancel', method: 'app.source.cancel', payload: { callId } });
      await vi.waitFor(() => expect(test.response('cancel')).toMatchObject({ result: null }));
      expect(fixture.snapshot.mock.calls[0]?.[1].aborted).toBe(true);
      expect(test.response('source')).toBeUndefined();
    } finally {
      gate.resolve(cancelled());
      await vi.waitFor(() => expect(test.response('source')).toMatchObject({ result: cancelled() }));
    }
  });
  it('rejects a duplicate callId without replacing its existing cancellation owner', async () => {
    const gate = deferred<AppSourceSnapshotResult>();
    fixture.snapshot.mockReturnValue(gate.promise);
    const test = await host();
    const callId = randomUUID();
    test.request({ id: 'source', method: 'app.source.snapshot', payload: { callId, target } });
    try {
      await vi.waitFor(() => expect(fixture.snapshot).toHaveBeenCalledOnce());
      test.request({ id: 'duplicate', method: 'app.source.snapshot', payload: { callId, target: { ...target, workspaceId: 'other' } } });
      await vi.waitFor(() => expect(test.response('duplicate')).toMatchObject({ result: { ok: false, cleanupConfirmed: false } }));
      expect(fixture.snapshot).toHaveBeenCalledOnce();
      test.request({ id: 'cancel', method: 'app.source.cancel', payload: { callId } });
      expect(fixture.snapshot.mock.calls[0]?.[1].aborted).toBe(true);
    } finally {
      gate.resolve(cancelled());
      await vi.waitFor(() => expect(test.response('source')).toBeDefined());
    }
  });
  it('retains cancellation received while initialization is pending', async () => {
    const ready = deferred<ChatStatus>();
    fixture.initialize.mockReturnValue(ready.promise);
    fixture.snapshot.mockImplementation(async (_target, signal) => {
      expect(signal.aborted).toBe(true);
      return cancelled();
    });
    const test = await host();
    const callId = randomUUID();
    test.request({ id: 'source', method: 'app.source.snapshot', payload: { callId, target } });
    test.request({ id: 'cancel', method: 'app.source.cancel', payload: { callId } });
    try {
      await vi.waitFor(() => expect(test.response('cancel')).toMatchObject({ result: null }));
      expect(fixture.snapshot).not.toHaveBeenCalled();
    } finally {
      ready.resolve(status);
      await vi.waitFor(() => expect(test.response('source')).toMatchObject({ result: cancelled() }));
    }
  });
  it('returns typed cleanup uncertainty for an exceptional service result', async () => {
    fixture.snapshot.mockRejectedValue(new Error('synthetic transport error'));
    const test = await host();
    test.request({ id: 'source', method: 'app.source.snapshot', payload: { callId: randomUUID(), target } });
    await vi.waitFor(() => expect(test.response('source')).toMatchObject({ result: { ok: false, target, cleanupConfirmed: false } }));
    expect(test.messages.some((message) => message.type === 'error' && message.id === 'source')).toBe(false);
  });
  it('aborts each owned source request as shutdown arrives', async () => {
    const source = deferred<AppSourceSnapshotResult>();
    const shutdown = deferred<void>();
    fixture.snapshot.mockReturnValue(source.promise);
    fixture.shutdown.mockReturnValue(shutdown.promise);
    const test = await host();
    test.request({ id: 'source', method: 'app.source.snapshot', payload: { callId: randomUUID(), target } });
    try {
      await vi.waitFor(() => expect(fixture.snapshot).toHaveBeenCalledOnce());
      test.request({ id: 'shutdown', method: 'shutdown' });
      expect(fixture.snapshot.mock.calls[0]?.[1].aborted).toBe(true);
      expect(test.response('source')).toBeUndefined();
    } finally {
      source.resolve(cancelled());
      shutdown.resolve();
      await vi.waitFor(() => expect(test.response('source')).toBeDefined());
      await vi.waitFor(() => expect(test.response('shutdown')).toBeDefined());
    }
  });
});
