import { emptyReferences } from '../../../../service/src/reference-test-fixture';
import '../../../../service/src/raw.d.ts';
import { mkdtemp } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { describe, expect, it, vi } from 'vitest';
import type { ChatConversation, TerminalSnapshot, WorkbenchCommand } from '@wsl/protocol';
import { CodexChat } from '../../../../service/src/codex-chat';
import { SbxConnection } from '../../../../service/src/sbx';
import { WorkbenchApplication } from './application';
import { FileWorkbenchRepository } from './repository';
import type { WorkbenchRuntime } from './ports';

function gate<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((done) => {
    resolve = done;
  });
  return { promise, resolve };
}
async function setup() {
  const repository = new FileWorkbenchRepository(path.join(await mkdtemp(path.join(os.tmpdir(), 'wsl-review-lifecycle-')), 'state.json'));
  const runtime = {
    validateBrowserUrl: vi.fn(),
    environmentsList: vi.fn().mockResolvedValue([
      {
        environmentId: 'local',
        kind: 'local',
        state: 'configured',
        label: 'local',
        capabilities: { browser: true, files: true, terminal: true },
        reason: null,
      },
      {
        environmentId: 'sandbox',
        kind: 'sandbox',
        state: 'configured',
        label: 'sandbox',
        capabilities: { browser: false, files: true, terminal: true },
        reason: null,
      },
    ]),
    registerResource: vi.fn(),
    releaseResource: vi.fn(),
    registerSession: vi.fn(),
    terminalOpen: vi.fn(),
    terminalStop: vi.fn(),
    send: vi.fn(),
    cancel: vi.fn(),
  } as unknown as WorkbenchRuntime;
  const app = new WorkbenchApplication(repository, runtime, vi.fn());
  const workspace = (await app.getSnapshot()).workspaces[0]!;
  const command = (payload: Record<string, unknown>) =>
    app.command({ commandId: crypto.randomUUID(), workspaceId: workspace.workspaceId, ...payload } as WorkbenchCommand);
  return { repository, runtime, app, workspace, command };
}
const terminal: TerminalSnapshot = {
  sessionId: 'pty',
  seq: 1,
  state: 'running',
  output: '',
  cleanupPending: true,
  error: null,
  sandbox: 'review',
  cwd: '/workspace',
};
function conversation(sessionId: string, state: ChatConversation['state'], seq = 1): ChatConversation {
  return {
    conversationId: sessionId,
    generation: 'review',
    seq,
    state,
    turnId: 'review-turn',
    threadId: null,
    messages: [],
    toolExecutions: [],
    warnings: [],
    cleanupPending: state === 'running',
    error: null,
  };
}

describe('review: durable terminal cleanup', () => {
  it.each(['stop', 'natural exit', 'no-process launch failure'])('persists %s before an immediate repository restart', async (scenario) => {
    const { repository, runtime, app, workspace, command } = await setup();
    const resource = workspace.resources.find((r) => r.kind === 'terminal')!;
    const ended: TerminalSnapshot = {
      ...terminal,
      seq: 2,
      state: scenario === 'no-process launch failure' ? 'failed' : 'closed',
      cleanupPending: false,
      error: scenario === 'no-process launch failure' ? 'spawn failed' : null,
    };
    if (scenario === 'no-process launch failure') {
      vi.mocked(runtime.terminalOpen).mockImplementation(async () => {
        app.onTerminal(resource.resourceId, ended, vi.mocked(runtime.registerResource).mock.calls[0]![0]);
        throw new Error('spawn failed');
      });
    } else vi.mocked(runtime.terminalOpen).mockResolvedValue(terminal);
    await command({ type: 'terminalOpen', resourceId: resource.resourceId, cols: 80, rows: 24 });
    if (scenario !== 'no-process launch failure') {
      await vi.waitFor(async () =>
        expect((await app.getSnapshot()).workspaces[0]!.resources.find((r) => r.resourceId === resource.resourceId)!.terminal?.state).toBe(
          'running',
        ),
      );
      const binding = vi.mocked(runtime.registerResource).mock.calls[0]![0];
      if (scenario === 'stop') {
        vi.mocked(runtime.terminalStop).mockResolvedValue(ended);
        await command({ type: 'stopInstance', resourceId: resource.resourceId, instanceId: binding.instanceId });
      } else app.onTerminal(resource.resourceId, ended, binding);
    }
    await vi.waitFor(async () =>
      expect(
        (await app.getSnapshot()).workspaces[0]!.resources.find((r) => r.resourceId === resource.resourceId)!.terminal?.cleanupPending,
      ).toBe(false),
    );
    const restarted = new WorkbenchApplication(repository, runtime, vi.fn());
    expect(
      (await restarted.getSnapshot()).workspaces[0]!.resources.find((r) => r.resourceId === resource.resourceId)!.terminal,
    ).toMatchObject({ state: 'closed', cleanupPending: false });
  });
  it('reports lifecycle save failures instead of silently acknowledging durable cleanup', async () => {
    const { repository, runtime, app, workspace, command } = await setup();
    const resource = workspace.resources.find((r) => r.kind === 'terminal')!;
    vi.mocked(runtime.terminalOpen).mockResolvedValue(terminal);
    await command({ type: 'terminalOpen', resourceId: resource.resourceId, cols: 80, rows: 24 });
    await vi.waitFor(async () =>
      expect((await app.getSnapshot()).workspaces[0]!.resources.find((r) => r.resourceId === resource.resourceId)!.terminal?.state).toBe(
        'running',
      ),
    );
    vi.spyOn(repository, 'save').mockRejectedValue(new Error('lifecycle disk full'));
    app.onTerminal(
      resource.resourceId,
      { ...terminal, seq: 2, state: 'closed', cleanupPending: false },
      vi.mocked(runtime.registerResource).mock.calls[0]![0],
    );
    expect((await app.getSnapshot()).storageError).toContain('lifecycle disk full');
  });
});

describe('review: cancellable Main launch I/O', () => {
  it('keeps registration cancelled in memory when cancellation persistence fails, without dispatching send', async () => {
    const { repository, runtime, app, workspace, command } = await setup();
    const sessionId = workspace.sessions[0]!.sessionId;
    await command({ type: 'confirmTask', sessionId, goal: 'review', targetRef: null });
    const taskVersionId = (await app.getSnapshot()).workspaces[0]!.sessions[0]!.taskVersions[0]!.taskVersionId;
    const entered = gate<void>();
    const release = gate<void>();
    vi.mocked(runtime.registerSession).mockImplementation(async () => {
      entered.resolve();
      await release.promise;
    });
    const starting = command({ type: 'startRun', sessionId, taskVersionId });
    await entered.promise;
    const runId = (await repository.load())!.workspaces[0]!.runs[0]!.runId;
    vi.spyOn(repository, 'save').mockRejectedValue(new Error('cancel disk full'));
    const cancelled = await command({ type: 'cancelRun', runId });
    expect(cancelled.ok).toBe(false);
    expect(cancelled.snapshot.storageError).toContain('cancel disk full');
    release.resolve();
    await starting;
    expect(runtime.send).not.toHaveBeenCalled();
    expect((await app.getSnapshot()).workspaces[0]!.runs[0]!.state).toBe('cancelled');
  });
  it('does not dispatch send after a cancellation racing with registration completion', async () => {
    const { repository, runtime, app, workspace, command } = await setup();
    const sessionId = workspace.sessions[0]!.sessionId;
    await command({ type: 'confirmTask', sessionId, goal: 'review', targetRef: null });
    const taskVersionId = (await app.getSnapshot()).workspaces[0]!.sessions[0]!.taskVersions[0]!.taskVersionId;
    const entered = gate<void>();
    const release = gate<void>();
    const actions: string[] = [];
    vi.mocked(runtime.registerSession).mockImplementation(async () => {
      entered.resolve();
      await release.promise;
    });
    vi.mocked(runtime.send).mockImplementation(async () => {
      actions.push('send');
      return conversation(sessionId, 'running');
    });
    vi.mocked(runtime.cancel).mockImplementation(async () => {
      actions.push('cancel');
      return conversation(sessionId, 'cancelled', 2);
    });
    const starting = command({ type: 'startRun', sessionId, taskVersionId });
    await entered.promise;
    const runId = (await repository.load())!.workspaces[0]!.runs[0]!.runId;
    release.resolve();
    const cancelling = command({ type: 'cancelRun', runId });
    await Promise.all([starting, cancelling]);
    await app.getSnapshot();
    expect(actions).not.toEqual(['cancel', 'send']);
    expect((await app.getSnapshot()).workspaces[0]!.runs[0]!.state).toBe('cancelled');
  });
  it.each(['registration', 'send preflight'])('cancels while %s is suspended and ignores its late receipt', async (phase) => {
    const { repository, runtime, app, workspace, command } = await setup();
    const sessionId = workspace.sessions[0]!.sessionId;
    await command({ type: 'confirmTask', sessionId, goal: 'review', targetRef: null });
    const taskVersionId = (await app.getSnapshot()).workspaces[0]!.sessions[0]!.taskVersions[0]!.taskVersionId;
    const entered = gate<void>();
    const release = gate<void>();
    if (phase === 'registration')
      vi.mocked(runtime.registerSession).mockImplementation(async () => {
        entered.resolve();
        await release.promise;
      });
    vi.mocked(runtime.send).mockImplementation(async () => {
      if (phase === 'send preflight') {
        entered.resolve();
        await release.promise;
      }
      return conversation(sessionId, 'running');
    });
    vi.mocked(runtime.cancel).mockResolvedValue(conversation(sessionId, 'cancelled', 2));
    const starting = command({ type: 'startRun', sessionId, taskVersionId });
    await entered.promise;
    // Read the durable reservation directly: getSnapshot intentionally waits for the metadata queue.
    const runId = (await repository.load())!.workspaces[0]!.runs[0]!.runId;
    let cancelled = false;
    const cancelling = command({ type: 'cancelRun', runId }).then((result) => {
      expect(result.ok).toBe(true);
      cancelled = true;
    });
    try {
      await vi.waitFor(() => expect(cancelled).toBe(true), { timeout: 250 });
    } finally {
      release.resolve();
      await starting;
      await cancelling;
    }
    await vi.waitFor(async () => expect((await app.getSnapshot()).workspaces[0]!.runs[0]!.state).toBe('cancelled'));
    if (phase === 'registration') expect(runtime.send).not.toHaveBeenCalled();
    if (phase === 'send preflight') app.onConversation(conversation(sessionId, 'running', 3));
    expect((await app.getSnapshot()).workspaces[0]!.runs[0]!.conversation?.state).not.toBe('running');
    expect((await app.getSnapshot()).workspaces[0]!.sessions[0]!.conversation?.state).not.toBe('running');
  });
  it.each([false, true])('settles a cancellation whose in-flight send is rejected (prior conversation=%s)', async (history) => {
    const { runtime, app, workspace, command } = await setup();
    const sessionId = workspace.sessions[0]!.sessionId;
    // Without history the unchanged cancel receipt used to complete the run; with history it left the run cancelling.
    const unchanged = { ...conversation(sessionId, 'idle', 1), turnId: history ? 'earlier-turn' : null };
    if (history) app.onConversation(unchanged);
    await command({ type: 'confirmTask', sessionId, goal: 'review', targetRef: null });
    const taskVersionId = (await app.getSnapshot()).workspaces[0]!.sessions[0]!.taskVersions[0]!.taskVersionId;
    const dispatched = gate<void>();
    const rejection = gate<void>();
    vi.mocked(runtime.send).mockImplementation(async () => {
      dispatched.resolve();
      await rejection.promise;
      throw new Error('sbx unavailable');
    });
    // The service answers in message order: the failed send reply reaches Main before the cancel receipt.
    vi.mocked(runtime.cancel).mockImplementation(async () => {
      await rejection.promise;
      await new Promise((resolve) => setTimeout(resolve, 0));
      return unchanged;
    });
    const starting = command({ type: 'startRun', sessionId, taskVersionId });
    await dispatched.promise;
    const runId = (await app.getSnapshot()).workspaces[0]!.runs[0]!.runId;
    expect((await command({ type: 'cancelRun', runId })).ok).toBe(true);
    expect((await app.getSnapshot()).workspaces[0]!.runs[0]!.state).toBe('cancelling');
    rejection.resolve();
    await starting;
    await vi.waitFor(() => expect(runtime.cancel).toHaveBeenCalledOnce());
    // Let the late, unchanged cancel receipt reach the metadata queue before reading the settled facts.
    await vi.mocked(runtime.cancel).mock.results[0]!.value;
    await new Promise((resolve) => setTimeout(resolve, 0));
    const run = (await app.getSnapshot()).workspaces[0]!.runs[0]!;
    expect(run).toMatchObject({ state: 'cancelled', executionBinding: null });
    expect(run.error).toContain('sbx unavailable');
    expect(run.endedAt).not.toBeNull();
  });
});

describe('review: real service frozen capability cancellation receipt', () => {
  it.each([false, true])('settles Main cancellation with prior history=%s after explicit frozen input', async (history) => {
    const { runtime, app, workspace, command } = await setup();
    const sessionId = workspace.sessions[0]!.sessionId;
    const connection = new SbxConnection({ sbxBinary: path.resolve('e2e/fixtures/sbx.mjs'), sandbox: 'review-receipt-fixture' });
    const chat = new CodexChat('', (snapshot) => app.onConversation(snapshot), connection);
    await chat.initialize();
    vi.mocked(runtime.registerSession).mockImplementation(async (id, workspaceId) => {
      chat.register(id, workspaceId);
    });
    vi.mocked(runtime.send).mockImplementation((id, text, scope, references) => chat.send(id, text, scope, references));
    vi.mocked(runtime.cancel).mockImplementation((id) => chat.cancel(id));
    chat.register(sessionId, workspace.workspaceId);
    if (history) {
      await chat.send(sessionId, 'history', undefined, emptyReferences(sessionId));
      await vi.waitFor(() => expect(chat.get(sessionId).state).toBe('idle'));
    }
    const before = chat.get(sessionId);
    const starts = vi.spyOn(connection, 'start');
    await command({ type: 'confirmTask', sessionId, goal: '[slow] frozen input cancellation', targetRef: null });
    const taskVersionId = (await app.getSnapshot()).workspaces[0]!.sessions[0]!.taskVersions[0]!.taskVersionId;
    await command({ type: 'startRun', sessionId, taskVersionId });
    await vi.waitFor(() => expect(starts).toHaveBeenCalledOnce());
    const runId = (await app.getSnapshot()).workspaces[0]!.runs[0]!.runId;
    expect(starts.mock.calls[0]?.[0]).toMatchObject({ resourceBundle: { sessionId, workspaceId: workspace.workspaceId, resources: [] } });
    try {
      expect((await command({ type: 'cancelRun', runId })).ok).toBe(true);
      await vi.waitFor(async () => expect((await app.getSnapshot()).workspaces[0]!.runs[0]!.state).toBe('cancelled'));
      const run = (await app.getSnapshot()).workspaces[0]!.runs[0]!;
      expect(run.conversation).toMatchObject({ state: 'cancelled', cleanupPending: false });
      expect(run.conversation!.seq).toBeGreaterThan(before.seq);
      expect(run.executionBinding?.turnId).not.toBe(before.turnId);
      expect((await app.runReferences(workspace.workspaceId, runId))?.resources).toEqual([]);
    } finally {
      await chat.shutdown();
    }
  });
});
