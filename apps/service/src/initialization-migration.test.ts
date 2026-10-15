import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { mkdtemp, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { emptyReferences } from './reference-test-fixture';
import type { ChatStatus } from '@wsl/protocol';
const fixture = vi.hoisted(() => ({
  postMessage: vi.fn(),
  listener: null as null | ((event: { data: unknown }) => void),
  initialize: vi.fn<() => Promise<ChatStatus>>(() => new Promise(() => {})),
  send: vi.fn(),
  terminalOpen: vi.fn(),
}));
vi.mock('./codex-chat', () => ({
  CodexChat: class {
    setObservationReader = vi.fn();
    setAppControlReader = vi.fn();
    connection = {
      getCleanupPending: () => false,
      getStatus: () => ({ available: false, reason: 'initializing', sandbox: null, version: null, cwd: null }),
    };
    initialize = fixture.initialize;
    register = vi.fn();
    send = fixture.send;
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
vi.mock('./terminal', () => ({
  Terminal: class {
    open = fixture.terminalOpen;
    get = () => ({ sessionId: null, seq: 0, state: 'idle', output: '', cleanupPending: false, sandbox: null, cwd: null, error: null });
  },
}));
const processWithParent = process as NodeJS.Process & { parentPort?: unknown };
const originalParent = Object.getOwnPropertyDescriptor(process, 'parentPort');
const originalArgs = [...process.argv];
const directories: string[] = [];
beforeEach(() => {
  fixture.initialize.mockReset().mockImplementation(() => new Promise(() => {}));
});
afterEach(async () => {
  if (originalParent) Object.defineProperty(process, 'parentPort', originalParent);
  else delete processWithParent.parentPort;
  process.argv = originalArgs;
  vi.restoreAllMocks();
  for (const root of directories.splice(0)) await rm(root, { recursive: true, force: true });
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
      {
        id: 'lease',
        method: 'resource.register',
        payload: {
          workspaceId: 'taskflow-demo',
          environmentId: 'sandbox',
          resourceId: 'terminal-resource',
          kind: 'terminal',
          instanceId: 'main-allocated',
          instanceGeneration: 1,
        },
      },
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
        ).toEqual(['get', 'lease', 'register', 'status', 'terminal']),
      { timeout: 100 },
    );
  });
  async function openWithJournal(body: unknown, initialize: () => Promise<ChatStatus>) {
    const root = await mkdtemp(path.join(tmpdir(), 'wsl-initialization-journal-'));
    directories.push(root);
    await writeFile(path.join(root, 'edu-verification-recovery.json'), typeof body === 'string' ? body : JSON.stringify(body), {
      mode: 0o600,
    });
    fixture.postMessage.mockClear();
    fixture.send.mockClear();
    fixture.terminalOpen.mockClear();
    fixture.initialize.mockImplementation(initialize);
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
    process.argv = [process.argv[0]!, '/fixture/index.js', root];
    vi.spyOn(process, 'on').mockReturnValue(process);
    await import('./index');
  }
  const binding = {
    workspaceId: 'taskflow-demo',
    environmentId: 'sandbox',
    resourceId: 'terminal-resource',
    kind: 'terminal',
    instanceId: 'main-allocated',
    instanceGeneration: 1,
  };
  async function observeLocalRequests() {
    for (const request of [
      { id: 'register', method: 'register', payload: { conversationId: 'session-fixture', workspaceId: 'taskflow-demo' } },
      { id: 'status', method: 'status' },
      { id: 'get', method: 'get', payload: { conversationId: 'session-fixture' } },
      { id: 'lease', method: 'resource.register', payload: binding },
      { id: 'terminal', method: 'terminal.get', resourceId: binding.resourceId },
    ])
      fixture.listener!({ data: request });
    await vi.waitFor(
      () =>
        expect(
          fixture.postMessage.mock.calls
            .filter(([m]) => m.type === 'response')
            .map(([m]) => m.id)
            .sort(),
        ).toEqual(['get', 'lease', 'register', 'status', 'terminal']),
      { timeout: 100 },
    );
  }
  async function assertMutationsDenied() {
    const requests = [
      {
        id: 'send-blocked',
        method: 'send',
        payload: {
          conversationId: 'session-fixture',
          text: 'must not execute',
          references: emptyReferences('session-fixture', 'taskflow-demo'),
        },
      },
      { id: 'app-blocked', method: 'app.start', payload: { workspaceId: 'taskflow-demo', projectId: randomUUID() } },
      { id: 'terminal-blocked', method: 'terminal.open', payload: { resourceId: binding.resourceId, cols: 80, rows: 24 } },
      {
        id: 'write-blocked',
        method: 'terminal.write',
        payload: { resourceId: binding.resourceId, sessionId: 'must-not-exist', data: 'must not execute' },
      },
    ];
    for (const request of requests) fixture.listener!({ data: request });
    await vi.waitFor(
      () =>
        expect(fixture.postMessage.mock.calls.filter(([m]) => m.type === 'error' && m.id.endsWith('-blocked'))).toHaveLength(
          requests.length,
        ),
      { timeout: 100 },
    );
    for (const [message] of fixture.postMessage.mock.calls.filter(([m]) => m.type === 'error' && m.id.endsWith('-blocked')))
      expect(message.error).toMatch(/verification_(maintenance_locked|journal_invalid)/);
    expect(fixture.send).not.toHaveBeenCalled();
    expect(fixture.terminalOpen).not.toHaveBeenCalled();
  }
  it('keeps local state observable and rejects mutations before unfinished journal initialization can settle', async () => {
    const projectId = randomUUID();
    const identity = { workspaceId: 'taskflow-demo', projectId, environmentId: 'sandbox', appInstanceId: randomUUID() };
    await openWithJournal(
      {
        schemaVersion: 1,
        status: {
          lease: { schemaVersion: 1, sessionId: randomUUID(), identity, sourceSha256: 'a'.repeat(64), expiresAtMs: Date.now() + 300000 },
          phase: 'active',
          callsUsed: 0,
          maintenanceLocked: true,
          error: null,
        },
        originalIdentity: { ...identity, appInstanceId: randomUUID() },
        restoreInstanceIds: [],
        urls: [],
        ownershipTaken: false,
      },
      () => new Promise(() => {}),
    );
    await observeLocalRequests();
    await assertMutationsDenied();
    expect(fixture.postMessage.mock.calls.some(([m]) => m.type === 'initialized')).toBe(false);
  });
  it('reports an invalid journal while preserving local reads/registration and the mutation lock', async () => {
    await openWithJournal('{invalid', async () => ({
      available: true,
      reason: null,
      version: 'fixture',
      sandbox: 'wsl-edu-fixture',
      cwd: '/home/agent/workspace',
    }));
    await vi.waitFor(() =>
      expect(fixture.postMessage.mock.calls.find(([m]) => m.type === 'initialized')?.[0]).toMatchObject({
        status: { available: false, reason: 'verification_journal_invalid' },
        cleanupPending: true,
      }),
    );
    await observeLocalRequests();
    await assertMutationsDenied();
    expect(fixture.postMessage.mock.calls.find(([m]) => m.type === 'response' && m.id === 'status')?.[0].result).toMatchObject({
      available: false,
      reason: 'verification_journal_invalid',
    });
  });
});
