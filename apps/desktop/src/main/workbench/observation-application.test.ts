import { mkdtemp, rm } from 'node:fs/promises';
import path from 'node:path';
import { tmpdir } from 'node:os';
import { FileWorkbenchRepository } from './repository';
import { randomUUID } from 'node:crypto';
import { describe, it, expect, vi } from 'vitest';
import type { WorkbenchRuntime } from './ports';
import type { WorkbenchRepository } from './repository';
import { WorkbenchApplication } from './application';
import type { TerminalSnapshot, ObservationRequest, ObservationResult, WorkbenchCommand } from '@wsl/protocol';
async function setup() {
  const archived: unknown[] = [];
  const repository: WorkbenchRepository = {
    load: async () => null,
    save: vi.fn(),
    appendObservation: vi.fn(async (record) => {
      archived.push(structuredClone(record));
      return randomUUID();
    }),
  };
  const runtime: WorkbenchRuntime = {
    environmentsList: vi.fn().mockResolvedValue([
      {
        environmentId: 'local',
        kind: 'local',
        label: 'Local',
        state: 'configured',
        reason: null,
        capabilities: { browser: true, files: true, terminal: true },
      },
      {
        environmentId: 'sandbox',
        kind: 'sandbox',
        label: 'Sandbox',
        state: 'configured',
        reason: null,
        capabilities: { browser: false, files: false, terminal: true },
      },
      {
        environmentId: 'ssh',
        kind: 'ssh',
        label: 'SSH',
        state: 'configured',
        reason: null,
        capabilities: { browser: false, files: true, terminal: true },
      },
    ]),
    registerResource: vi.fn(),
    observe: vi.fn(async (request) => result(request)),
    registerSession: vi.fn(),
    publicResourcesList: vi.fn().mockResolvedValue({ spaceId: 'taskflow-demo', revision: 0, resources: [] }),
    publicResourcesCapture: vi.fn(),
    publicResourcesRemove: vi.fn(),
    validateBrowserUrl: vi.fn(),
    ensureBrowser: vi.fn(),
    browserState: vi.fn(),
    browserLayout: vi.fn(),
    browserAction: vi.fn(),
    hideBrowsers: vi.fn(),
    terminalOpen: vi.fn(),
    terminalWrite: vi.fn(),
    terminalResize: vi.fn(),
    terminalStop: vi.fn(),
    send: vi.fn(),
    cancel: vi.fn(),
  };
  const emit = vi.fn();
  const app = new WorkbenchApplication(repository, runtime, emit);
  await app.getSnapshot();
  await app.environments();
  const command = (workspaceId: string, payload: Record<string, unknown>) =>
    app.command({ workspaceId, commandId: randomUUID(), ...payload } as WorkbenchCommand);
  const file = async (workspaceId = 'taskflow-demo', environmentId = 'local') => {
    expect((await command(workspaceId, { type: 'createTab', kind: 'file', environmentId })).ok).toBe(true);
    return (await app.getSnapshot()).workspaces
      .find((w) => w.workspaceId === workspaceId)!
      .resources.filter((r) => r.kind === 'file')
      .at(-1)!;
  };
  return { app, runtime, repository, archived, command, file, emit };
}
function result(request: ObservationRequest): ObservationResult {
  return {
    resource: request.target!,
    generation: 'content',
    revision: { value: 'hash', strength: 'content-hash' },
    snapshotId: randomUUID(),
    capturedAt: new Date().toISOString(),
    source: request.target!.environmentId === 'ssh' ? 'sftp' : 'disk',
    representation: 'text',
    coverage: { status: 'complete' },
    data: { text: '内容', encoding: 'utf-8', contentSha256: 'hash', hashScope: 'whole_file' },
  };
}
function input(resourceId: string, workspaceId = 'taskflow-demo', sessionId: string | null = null) {
  return {
    requestId: randomUUID(),
    workspaceId,
    sessionId,
    runId: null,
    resourceId,
    tool: 'files.read' as const,
    args: { path: 'note.txt' },
  };
}
describe('Main observation ownership and lifecycle', () => {
  it('refreshes the Main environment projection when chat transitions from checking to ready', async () => {
    const { app, runtime, emit } = await setup();
    const checking = [
      {
        environmentId: 'sandbox',
        kind: 'sandbox',
        label: 'Sandbox',
        state: 'unavailable',
        reason: '正在检查 sbx…',
        capabilities: { browser: false, files: false, terminal: false },
      },
    ];
    vi.mocked(runtime.environmentsList).mockResolvedValueOnce(checking as Awaited<ReturnType<WorkbenchRuntime['environmentsList']>>);
    await app.environments();
    const seq = (await app.getSnapshot()).seq;
    emit.mockClear();
    await app.onChatStatus();
    expect(emit).toHaveBeenCalled();
    expect((await app.getSnapshot()).environments.find((e) => e.environmentId === 'sandbox')?.capabilities.terminal).toBe(true);
    expect((await app.getSnapshot()).seq).toBeGreaterThan(seq);
  });
  it('keeps a newer ready projection when an earlier status refresh fails late', async () => {
    const { app, runtime } = await setup();
    let reject!: (error: Error) => void;
    vi.mocked(runtime.environmentsList).mockImplementationOnce(
      () =>
        new Promise((_resolve, fail) => {
          reject = fail;
        }),
    );
    const previous = app.onChatStatus();
    await app.onChatStatus();
    reject(new Error('old transport closed'));
    await previous;
    expect((await app.getSnapshot()).environments.find((e) => e.environmentId === 'sandbox')?.capabilities.terminal).toBe(true);
  });
  it('projects environment query failure visibly without granting service capabilities', async () => {
    const { app, runtime } = await setup();
    vi.mocked(runtime.environmentsList).mockRejectedValueOnce(new Error('transport closed'));
    await app.onChatStatus();
    expect((await app.getSnapshot()).environments.find((e) => e.environmentId === 'sandbox')).toMatchObject({
      state: 'unavailable',
      reason: '执行环境查询失败：transport closed',
      capabilities: { terminal: false, files: false },
    });
  });
  it('allows explicit sessionless file browsing without writing Agent context; sources remain independent', async () => {
    const { app, file } = await setup();
    const resource = await file();
    const observed = await app.observe(input(resource.resourceId));
    expect(observed).toMatchObject({ source: 'disk', resource: { resourceId: resource.resourceId, environmentId: 'local' } });
    const w = (await app.getSnapshot()).workspaces[0]!;
    expect(w.observations).toHaveLength(1);
    expect(w.sessions[0]!.observations).toEqual([]);
    const sources = await app.observe({
      ...input(resource.resourceId),
      resourceId: null,
      sessionId: w.sessions[0]!.sessionId,
      tool: 'workspace.list_sources',
      args: {},
    });
    expect(sources).toMatchObject({ kind: 'sources', workspaceId: w.workspaceId });
    expect(sources).not.toHaveProperty('resource');
    expect(await app.observe({ ...input(resource.resourceId), resourceId: null, tool: 'workspace.list_sources', args: {} })).toMatchObject({
      error: 'unauthorized',
    });
    expect(
      await app.observeForTurn(
        { workspaceId: w.workspaceId, sessionId: null, runId: null, sources: [] } as never,
        'files.read',
        {},
        new AbortController().signal,
      ),
    ).toMatchObject({ error: 'unauthorized' });
  });
  it('freezes workspace/environment while a read is pending and survives a different command rollback', async () => {
    const { app, runtime, command, file } = await setup();
    const resource = await file('taskflow-demo', 'ssh');
    let finish!: (value: ObservationResult) => void;
    let frozen!: ObservationRequest;
    vi.mocked(runtime.observe).mockImplementation((request) => {
      frozen = request;
      return new Promise((resolve) => {
        finish = resolve;
      });
    });
    const pending = app.observe(input(resource.resourceId));
    await vi.waitFor(() => expect(runtime.observe).toHaveBeenCalledOnce());
    expect((await command('taskflow-demo', { type: 'updateTab', tabId: 'missing', title: 'bad' })).ok).toBe(false);
    expect((await command('b', { type: 'createWorkspace', name: 'B' })).ok).toBe(true);
    finish(result(frozen));
    expect(await pending).toMatchObject({ source: 'sftp', resource: { workspaceId: 'taskflow-demo', environmentId: 'ssh' } });
    const snapshot = await app.getSnapshot();
    expect(snapshot.activeWorkspaceId).toBe('b');
    expect(snapshot.workspaces.find((w) => w.workspaceId === 'taskflow-demo')!.observations[0]).toMatchObject({
      state: 'completed',
      evidenceRef: expect.any(String),
    });
    expect(snapshot.workspaces.find((w) => w.workspaceId === 'b')!.observations).toEqual([]);
    expect(await app.observe(input(resource.resourceId, 'b'))).toMatchObject({ error: 'unauthorized' });
  });
  it('rejects a schema-valid Provider result for another workspace or generation', async () => {
    const { app, runtime, file } = await setup();
    const resource = await file();
    vi.mocked(runtime.observe).mockImplementation(async (request) => {
      const observed = result(request);
      if ('error' in observed) throw new Error('fixture');
      observed.resource = { ...observed.resource, workspaceId: 'other' };
      return observed;
    });
    expect(await app.observe(input(resource.resourceId))).toMatchObject({ error: 'unauthorized' });
    vi.mocked(runtime.observe).mockImplementation(async (request) => {
      const observed = result(request);
      if ('error' in observed) throw new Error('fixture');
      observed.resource = { ...observed.resource, instanceGeneration: 999 };
      return observed;
    });
    expect(await app.observe(input(resource.resourceId))).toMatchObject({ error: 'unauthorized' });
  });
  it('cancels outside the metadata queue and rejects a late result without losing original evidence ownership', async () => {
    const { app, runtime, command, file, archived } = await setup();
    const resource = await file();
    let finish!: (value: ObservationResult) => void;
    let frozen!: ObservationRequest;
    let signal!: AbortSignal;
    vi.mocked(runtime.observe).mockImplementation((request, abort) => {
      frozen = request;
      signal = abort;
      return new Promise((resolve) => {
        finish = resolve;
      });
    });
    const request = input(resource.resourceId);
    const pending = app.observe(request);
    await vi.waitFor(() => expect(runtime.observe).toHaveBeenCalledOnce());
    expect((await command('taskflow-demo', { type: 'cancelObservation', sessionId: null, requestId: request.requestId })).ok).toBe(true);
    expect(await pending).toMatchObject({ error: 'cancelled' });
    expect(signal.aborted).toBe(true);
    finish(result(frozen));
    const w = (await app.getSnapshot()).workspaces[0]!;
    expect(w.observations[0]).toMatchObject({ state: 'cancelled', result: { error: 'cancelled' } });
    expect(archived[0]).toMatchObject({ request: { workspaceId: 'taskflow-demo', sessionId: null }, state: 'cancelled' });
  });
  it('keeps the 200 record window while archiving more than 200 independent reads', async () => {
    const { app, file, archived } = await setup();
    const resource = await file();
    for (let i = 0; i < 202; i++) expect(await app.observe(input(resource.resourceId))).not.toHaveProperty('error');
    expect((await app.getSnapshot()).workspaces[0]!.observations).toHaveLength(200);
    expect(archived).toHaveLength(202);
    expect(new Set(archived.map((record) => (record as { request: { requestId: string } }).request.requestId)).size).toBe(202);
  });
  it('does not leave a pending read when initial persistence fails and exposes archive failures', async () => {
    const { app, repository, runtime, file } = await setup();
    const resource = await file();
    vi.mocked(repository.save).mockRejectedValueOnce(new Error('disk full'));
    expect(await app.observe(input(resource.resourceId))).toMatchObject({ error: 'unavailable' });
    expect(runtime.observe).not.toHaveBeenCalled();
    expect((await app.getSnapshot()).workspaces[0]!.observations).toEqual([]);
    vi.mocked(repository.appendObservation).mockRejectedValueOnce(new Error('archive full'));
    expect(await app.observe(input(resource.resourceId))).toMatchObject({ error: 'unavailable' });
    expect((await app.getSnapshot()).storageError).toContain('archive full');
    expect((await app.getSnapshot()).workspaces[0]!.observations[0]!.state).toBe('failed');
  });
  it('linearizes completion before deferred archival, so later cancellation cannot contradict evidence', async () => {
    const { app, repository, command, file } = await setup();
    const resource = await file();
    let finish!: (value: string) => void;
    let archived: unknown;
    vi.mocked(repository.appendObservation).mockImplementationOnce((record) => {
      archived = structuredClone(record);
      return new Promise((resolve) => {
        finish = resolve;
      });
    });
    const request = input(resource.resourceId);
    const pending = app.observe(request);
    await vi.waitFor(() => expect(repository.appendObservation).toHaveBeenCalledOnce());
    await command('taskflow-demo', { type: 'cancelObservation', sessionId: null, requestId: request.requestId });
    finish('archive');
    const observed = await pending;
    expect(archived).toMatchObject({ state: 'completed' });
    expect(observed).not.toHaveProperty('error');
    expect((await app.getSnapshot()).workspaces[0]!.observations[0]).toMatchObject({ state: 'completed' });
  });
  it('retains completed but still archiving records while the history window rolls', async () => {
    const { app, repository, file } = await setup();
    const resource = await file();
    let finish!: (value: string) => void;
    vi.mocked(repository.appendObservation).mockImplementationOnce(
      () =>
        new Promise((resolve) => {
          finish = resolve;
        }),
    );
    const request = input(resource.resourceId);
    const pending = app.observe(request);
    const settled = pending.catch((error) => error);
    await vi.waitFor(() => expect(repository.appendObservation).toHaveBeenCalledOnce());
    let found: boolean;
    try {
      for (let i = 0; i < 201; i++) await app.observe(input(resource.resourceId));
      found = (await app.getSnapshot()).workspaces[0]!.observations.some((record) => record.request.requestId === request.requestId);
    } finally {
      finish('original-archive');
      await settled;
    }
    expect(found!).toBe(true);
    expect(await settled).not.toHaveProperty('error');
  });
  it('keeps the 64-request run budget independent of the rolling session history', async () => {
    const { app, runtime, command } = await setup();
    const w = (await app.getSnapshot()).workspaces[0]!;
    const sessionId = w.sessions[0]!.sessionId;
    vi.mocked(runtime.send).mockImplementation(async (id) => ({
      conversationId: id,
      generation: 'generation',
      seq: 1,
      turnId: 'turn',
      threadId: 'thread',
      state: 'running',
      messages: [],
      toolExecutions: [],
      warnings: [],
      cleanupPending: true,
      error: null,
    }));
    expect((await command(w.workspaceId, { type: 'confirmTask', sessionId, goal: 'review', targetRef: null })).ok).toBe(true);
    const version = (await app.getSnapshot()).workspaces[0]!.sessions[0]!.taskVersions[0]!;
    expect((await command(w.workspaceId, { type: 'startRun', sessionId, taskVersionId: version.taskVersionId })).ok).toBe(true);
    const runId = (await app.getSnapshot()).workspaces[0]!.runs[0]!.runId;
    const read = (runId: string | null) =>
      app.observe({
        requestId: randomUUID(),
        workspaceId: w.workspaceId,
        sessionId,
        runId,
        resourceId: null,
        tool: 'workspace.list_sources',
        args: {},
      });
    for (let i = 0; i < 64; i++) expect(await read(runId)).toHaveProperty('kind', 'sources');
    for (let i = 0; i < 200; i++) await read(null);
    expect(await read(runId)).toMatchObject({ error: 'budget_exceeded' });
    const frozen = vi.mocked(runtime.send).mock.calls[0]![2]!;
    app.onConversation({
      conversationId: sessionId,
      generation: 'generation',
      seq: 2,
      turnId: 'turn',
      threadId: 'thread',
      state: 'idle',
      messages: [],
      toolExecutions: [],
      warnings: [],
      cleanupPending: false,
      error: null,
    });
    await app.getSnapshot();
    expect(await app.observeForTurn(frozen, 'workspace.list_sources', {}, new AbortController().signal)).toMatchObject({
      error: 'unauthorized',
    });
    expect((await app.getSnapshot()).workspaces[0]!.sessions[0]!.observations).toHaveLength(200);
  });

  it('keeps pending PTY launch outside the queue, stops its actual session and ignores stale binding events', async () => {
    const { app, runtime, command } = await setup();
    const w = (await app.getSnapshot()).workspaces[0]!;
    const resource = w.resources.find((resource) => resource.kind === 'terminal')!;
    let finish!: (value: TerminalSnapshot) => void;
    vi.mocked(runtime.terminalOpen).mockImplementation(
      () =>
        new Promise((resolve) => {
          finish = resolve;
        }),
    );
    expect((await command(w.workspaceId, { type: 'terminalOpen', resourceId: resource.resourceId, cols: 80, rows: 24 })).ok).toBe(true);
    await vi.waitFor(() => expect(runtime.terminalOpen).toHaveBeenCalledOnce());
    const binding = vi.mocked(runtime.registerResource).mock.calls[0]![0];
    expect((await app.getSnapshot()).workspaces[0]!.resources.find((r) => r.resourceId === resource.resourceId)).toMatchObject({
      instanceId: binding.instanceId,
      terminal: { state: 'starting', sessionId: null },
    });
    expect(
      (await command(w.workspaceId, { type: 'stopInstance', resourceId: resource.resourceId, instanceId: binding.instanceId })).ok,
    ).toBe(true);
    expect((await command('other', { type: 'createWorkspace', name: 'Other' })).ok).toBe(true);
    expect(runtime.terminalStop).not.toHaveBeenCalled();
    const terminal = {
      seq: 1,
      sessionId: 'actual-pty',
      state: 'running' as const,
      cleanupPending: true,
      error: null,
      output: 'same output',
      sandbox: null,
      cwd: null,
    };
    vi.mocked(runtime.terminalStop).mockResolvedValue({ ...terminal, seq: 2, state: 'closed', cleanupPending: false });
    finish(terminal);
    await vi.waitFor(() => expect(runtime.terminalStop).toHaveBeenCalledWith(resource.resourceId, 'actual-pty'));
    await vi.waitFor(async () =>
      expect(
        (await app.getSnapshot()).workspaces
          .find((w) => w.workspaceId === binding.workspaceId)!
          .resources.find((r) => r.resourceId === resource.resourceId)!.terminal?.state,
      ).toBe('closed'),
    );
    app.onTerminal(
      resource.resourceId,
      { ...terminal, seq: 999, output: 'wrong generation' },
      { ...binding, instanceGeneration: binding.instanceGeneration + 1 },
    );
    app.onTerminal(resource.resourceId, { ...terminal, seq: 1000, output: 'wrong workspace' }, { ...binding, workspaceId: 'other' });
    expect(
      (await app.getSnapshot()).workspaces
        .find((w) => w.workspaceId === binding.workspaceId)!
        .resources.find((r) => r.resourceId === resource.resourceId),
    ).toMatchObject({ instanceId: binding.instanceId, terminal: { state: 'closed', output: 'same output' } });
  });

  it('rejects a captured task after restart even when native numeric identities are reused', async () => {
    const { app, runtime, command } = await setup();
    const w = (await app.getSnapshot()).workspaces[0]!;
    const session = w.sessions[0]!;
    const web = w.resources.find((resource) => resource.kind === 'web')!;
    const page = {
      webContentsId: 42,
      documentGeneration: 1,
      url: 'wsl-demo://taskflow/index.html',
      title: 'TaskFlow',
      partition: 'fixture',
    };
    vi.mocked(runtime.browserState).mockReturnValue({
      page,
      loading: false,
      canGoBack: false,
      canGoForward: false,
      picking: false,
      cdp: { state: 'attached' },
      consoleIssueCount: 0,
      loadError: null,
      blockedNavigation: null,
      pickError: null,
    });
    expect(
      (
        await command(w.workspaceId, {
          type: 'captureContext',
          sessionId: session.sessionId,
          resourceId: web.resourceId,
          requestId: 'capture',
        })
      ).ok,
    ).toBe(true);
    const current = (await app.getSnapshot()).workspaces[0]!.resources.find((resource) => resource.resourceId === web.resourceId)!;
    app.onCapture(
      web.resourceId,
      {
        captureId: 'capture',
        capturedAt: 'now',
        page,
        element: {
          tagName: 'button',
          id: null,
          classes: [],
          role: null,
          ariaLabel: null,
          testId: null,
          text: 'target',
          selector: 'button',
          rect: null,
        },
        screenshot: { viewport: 'data:image/png;base64,AA', element: null },
        consoleIssues: [],
      },
      current.instanceId,
      current.generation,
      'capture',
    );
    await app.getSnapshot();
    expect(
      (
        await command(w.workspaceId, {
          type: 'confirmTask',
          sessionId: session.sessionId,
          goal: 'change target',
          targetRef: { kind: 'web', resourceId: web.resourceId },
        })
      ).ok,
    ).toBe(true);
    const saved = await app.getSnapshot();
    const version = saved.workspaces[0]!.sessions[0]!.taskVersions[0]!;
    const root = await mkdtemp(path.join(tmpdir(), 'wsl-observe-restore-'));
    try {
      const repository = new FileWorkbenchRepository(path.join(root, 'workbench.json'));
      await repository.save(saved);
      vi.mocked(runtime.send).mockResolvedValue({
        conversationId: session.sessionId,
        generation: 'gen',
        seq: 1,
        threadId: 'thread',
        turnId: 'turn',
        state: 'running',
        messages: [],
        toolExecutions: [],
        warnings: [],
        cleanupPending: true,
        error: null,
      });
      const restored = new WorkbenchApplication(repository, runtime, vi.fn());
      await restored.getSnapshot();
      const result = await restored.command({
        type: 'startRun',
        workspaceId: w.workspaceId,
        commandId: 'reuse-numbers',
        sessionId: session.sessionId,
        taskVersionId: version.taskVersionId,
      });
      expect(result.ok).toBe(false);
      if (!result.ok) expect(result.error.code).toBe('conflict');
      expect(runtime.send).not.toHaveBeenCalled();
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });
  it('lists unbound legacy placeholders without granting an environment and reports source-list overflow', async () => {
    const { app, runtime, file } = await setup();
    const resource = await file();
    const snapshot = await app.getSnapshot();
    const w = snapshot.workspaces[0]!;
    const placeholder = w.resources.find((r) => r.resourceId === resource.resourceId)!;
    placeholder.environmentId = null;
    placeholder.instanceId = null;
    placeholder.unavailableReason = '旧占位资源未绑定授权环境';
    const repository: WorkbenchRepository = {
      load: async () => structuredClone(snapshot),
      save: vi.fn(),
      appendObservation: vi.fn(async () => randomUUID()),
    };
    const restored = new WorkbenchApplication(repository, runtime, vi.fn());
    await restored.getSnapshot();
    const list = await restored.observe({
      requestId: randomUUID(),
      workspaceId: w.workspaceId,
      sessionId: w.sessions[0]!.sessionId,
      runId: null,
      resourceId: null,
      tool: 'workspace.list_sources',
      args: {},
    });
    expect(list).toMatchObject({
      kind: 'sources',
      sources: expect.arrayContaining([
        expect.objectContaining({
          resource: expect.objectContaining({ resourceId: resource.resourceId, environmentId: null }),
          instance: null,
          state: 'unavailable',
          capabilities: [],
        }),
      ]),
    });
    expect(await restored.observe(input(resource.resourceId))).toMatchObject({ error: 'unavailable' });
    expect(runtime.observe).not.toHaveBeenCalled();
    while (w.resources.filter((r) => r.kind !== 'session').length <= 500) w.resources.push({ ...placeholder, resourceId: randomUUID() });
    const crowded = new WorkbenchApplication(repository, runtime, vi.fn());
    await crowded.getSnapshot();
    expect(
      await crowded.observe({
        requestId: randomUUID(),
        workspaceId: w.workspaceId,
        sessionId: w.sessions[0]!.sessionId,
        runId: null,
        resourceId: null,
        tool: 'workspace.list_sources',
        args: {},
      }),
    ).toMatchObject({ error: 'budget_exceeded' });
  });
  it('rejects multibyte observation input before registering or reading a resource', async () => {
    const { app, runtime, file } = await setup();
    const resource = await file();
    expect(await app.observe({ ...input(resource.resourceId), args: { path: '中'.repeat(6000) } })).toMatchObject({
      error: 'invalid_request',
    });
    expect(runtime.observe).not.toHaveBeenCalled();
    expect(runtime.registerResource).not.toHaveBeenCalled();
  });
});

it('cancels a request while environment discovery is delayed without starting its provider', async () => {
  const { app, runtime, command, file } = await setup();
  const resource = await file();
  const sessionId = (await app.getSnapshot()).workspaces[0]!.sessions[0]!.sessionId;
  const environments = await runtime.environmentsList();
  let release!: () => void;
  vi.mocked(runtime.environmentsList).mockImplementationOnce(
    () =>
      new Promise((resolve) => {
        release = () => resolve(environments);
      }),
  );
  const requestId = randomUUID();
  const reading = app.observe({
    requestId,
    workspaceId: 'taskflow-demo',
    sessionId,
    runId: null,
    resourceId: resource.resourceId,
    tool: 'files.read',
    args: { path: 'a.txt' },
  });
  await vi.waitFor(() => expect(release).toBeTypeOf('function'));
  const cancelled = await command('taskflow-demo', { type: 'cancelObservation', sessionId, requestId });
  release();
  const result = await reading;
  expect(cancelled.ok).toBe(true);
  expect(result).toMatchObject({ error: 'cancelled' });
  expect(runtime.observe).not.toHaveBeenCalled();
  const record = (await app.getSnapshot()).workspaces[0]!.sessions.find((session) => session.sessionId === sessionId)!.observations.find(
    (record) => record.request.requestId === requestId,
  )!;
  expect(record.state).toBe('cancelled');
  expect(record.request.workspaceId).toBe('taskflow-demo');
  expect(record.request.sessionId).toBe(sessionId);
});

it('environment discovery failure terminates the frozen record and releases its active slot', async () => {
  const { app, runtime, file, archived } = await setup();
  const resource = await file();
  vi.mocked(runtime.environmentsList).mockRejectedValueOnce(new Error('ENV_DISCOVERY_FAILED'));
  const request = input(resource.resourceId);
  expect(await app.observe(request)).toMatchObject({ error: 'unavailable', message: 'ENV_DISCOVERY_FAILED' });
  const record = (await app.getSnapshot()).workspaces[0]!.observations.at(-1)!;
  expect(record.state).toBe('failed');
  expect(record.evidenceRef).toBeTypeOf('string');
  expect(archived).toHaveLength(1);
  expect(await app.observe(input(resource.resourceId))).toHaveProperty('source', 'disk');
});

it('environment preflight keeps the source set frozen across new resources and a space switch', async () => {
  const { app, runtime, file, command } = await setup();
  await file();
  const workspace = (await app.getSnapshot()).workspaces[0]!;
  const environments = await runtime.environmentsList();
  let release!: () => void;
  vi.mocked(runtime.environmentsList).mockImplementationOnce(
    () =>
      new Promise((resolve) => {
        release = () => resolve(environments);
      }),
  );
  const reading = app.observe({
    requestId: randomUUID(),
    workspaceId: workspace.workspaceId,
    sessionId: workspace.sessions[0]!.sessionId,
    runId: null,
    resourceId: null,
    tool: 'workspace.list_sources',
    args: {},
  });
  await vi.waitFor(() => expect(release).toBeTypeOf('function'));
  const later = await file();
  await command('later-space', { type: 'createWorkspace', name: 'Later' });
  release();
  const result = await reading;
  expect(result).toHaveProperty('kind', 'sources');
  if (!('kind' in result)) throw new Error('Expected frozen source list');
  expect(result.workspaceId).toBe(workspace.workspaceId);
  expect(result.sources.some((source) => source.resource.resourceId === later.resourceId)).toBe(false);
  expect(result.sources.find((source) => source.resource.kind === 'file')!.capabilities).toContain('files.read');
});

it('replacement during environment preflight rejects the frozen instance before provider I/O', async () => {
  const { app, runtime, command } = await setup();
  const workspace = (await app.getSnapshot()).workspaces[0]!;
  const terminal = workspace.resources.find((resource) => resource.kind === 'terminal')!;
  const sessionId = workspace.sessions[0]!.sessionId;
  const snapshot = {
    seq: 1,
    sessionId: 'pty',
    sandbox: 'fixture',
    cwd: '/tmp',
    state: 'running',
    output: '',
    outputOffset: 0,
    cleanupPending: true,
    error: null,
  } as TerminalSnapshot;
  vi.mocked(runtime.terminalOpen).mockResolvedValue(snapshot);
  vi.mocked(runtime.terminalStop).mockResolvedValue({ ...snapshot, seq: 2, state: 'closed', cleanupPending: false });
  await command(workspace.workspaceId, { type: 'terminalOpen', resourceId: terminal.resourceId, cols: 80, rows: 24 });
  await vi.waitFor(async () =>
    expect(
      (await app.getSnapshot()).workspaces[0]!.resources.find((resource) => resource.resourceId === terminal.resourceId)!.terminal!.state,
    ).toBe('running'),
  );
  const initial = (await app.getSnapshot()).workspaces[0]!.resources.find((resource) => resource.resourceId === terminal.resourceId)!;
  const environments = await runtime.environmentsList();
  let release!: () => void;
  vi.mocked(runtime.environmentsList).mockImplementationOnce(
    () =>
      new Promise((resolve) => {
        release = () => resolve(environments);
      }),
  );
  const reading = app.observe({
    requestId: randomUUID(),
    workspaceId: workspace.workspaceId,
    sessionId,
    runId: null,
    resourceId: terminal.resourceId,
    tool: 'terminal.read_screen',
    args: {},
  });
  await vi.waitFor(() => expect(release).toBeTypeOf('function'));
  await command(workspace.workspaceId, { type: 'stopInstance', resourceId: terminal.resourceId, instanceId: initial.instanceId });
  await vi.waitFor(async () =>
    expect(
      (await app.getSnapshot()).workspaces[0]!.resources.find((resource) => resource.resourceId === terminal.resourceId)!.terminal!.state,
    ).toBe('closed'),
  );
  await command(workspace.workspaceId, { type: 'terminalOpen', resourceId: terminal.resourceId, cols: 80, rows: 24 });
  release();
  expect(await reading).toMatchObject({ error: 'unavailable' });
  expect(runtime.observe).not.toHaveBeenCalled();
});
