import { mkdtemp, readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import { FileWorkbenchRepository } from './repository';
import { describe, expect, it, vi } from 'vitest';
import type { ChatConversation, TerminalSnapshot, WorkbenchCommand, WorkbenchSnapshot } from '@wsl/protocol';
import { WorkbenchApplication, validateSnapshot } from './application';
import type { WorkbenchRuntime } from './ports';
import type { WorkbenchRepository } from './repository';
const make = async () => {
  let saved: WorkbenchSnapshot | null = null;
  const repository: WorkbenchRepository = {
    appendObservation: vi.fn(async () => crypto.randomUUID()),
    load: async () => saved,
    save: vi.fn(async (s) => {
      saved = structuredClone(s);
    }),
  };
  const runtime: WorkbenchRuntime = {
    registerSession: vi.fn(),
    environmentsList: vi.fn().mockResolvedValue([
      {
        environmentId: 'local',
        kind: 'local',
        state: 'configured',
        label: '本机',
        capabilities: { browser: true, files: true, terminal: true },
        reason: null,
      },
      {
        environmentId: 'sandbox',
        kind: 'sandbox',
        state: 'configured',
        label: 'Sandbox',
        capabilities: { browser: false, files: false, terminal: true },
        reason: null,
      },
      {
        environmentId: 'ssh',
        kind: 'ssh',
        state: 'unavailable',
        label: 'SSH',
        capabilities: { browser: false, files: false, terminal: false },
        reason: '未配置',
      },
    ]),
    registerResource: vi.fn(),
    observe: vi.fn(),
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
  const app = new WorkbenchApplication(repository, runtime, vi.fn());
  await app.getSnapshot();
  const command = (payload: Omit<WorkbenchCommand, 'commandId' | 'workspaceId'>) =>
    app.command({ ...payload, commandId: crypto.randomUUID(), workspaceId: 'taskflow-demo' } as WorkbenchCommand);
  return { app, repository, runtime, command };
};
const conversation = (id: string, generation: string, seq: number, state: ChatConversation['state'] = 'running'): ChatConversation => ({
  conversationId: id,
  generation,
  seq,
  state,
  threadId: 'thread',
  turnId: 'turn-' + generation,
  messages: [],
  toolExecutions: [],
  warnings: [],
  cleanupPending: state === 'running',
  error: null,
});
describe('workbench authoritative commands', () => {
  it('restores business records from old snapshots while discarding per-space sidebar preferences', async () => {
    const { app, runtime } = await make();
    const initial = await app.getSnapshot();
    const session = initial.workspaces[0]?.sessions[0];
    if (!session) throw new Error('fixture session missing');
    await app.command({
      type: 'saveDraft',
      commandId: 'restore-draft',
      workspaceId: 'taskflow-demo',
      sessionId: session.sessionId,
      draft: '保留中文草稿',
    });
    await app.command({ type: 'setPreferences', commandId: 'restore-theme', workspaceId: 'taskflow-demo', theme: 'warm' });
    const expected = await app.getSnapshot();
    const file = path.join(await mkdtemp(path.join(os.tmpdir(), 'wsl-old-sidebar-')), 'state.json');
    const repository = new FileWorkbenchRepository(file);
    await writeFile(
      file,
      JSON.stringify({
        schemaVersion: 1,
        snapshot: {
          ...expected,
          workspaces: expected.workspaces.map((workspace) => ({ ...workspace, sidebarMode: 'hidden' })),
        },
      }),
    );
    const loaded = await repository.load();
    expect(loaded).toEqual(expected);
    expect(loaded?.workspaces[0]).not.toHaveProperty('sidebarMode');
    const restored = new WorkbenchApplication(repository, runtime, vi.fn());
    const workspace = (await restored.getSnapshot()).workspaces[0];
    expect(workspace?.tabs).toEqual(expected.workspaces[0]?.tabs);
    expect(workspace?.layout).toEqual(expected.workspaces[0]?.layout);
    expect(workspace?.resources.map((resource) => resource.resourceId)).toEqual(
      expected.workspaces[0]?.resources.map((resource) => resource.resourceId),
    );
    expect(workspace?.sessions[0]?.draft).toBe('保留中文草稿');
    expect(workspace?.theme).toBe('warm');
    await repository.save(await restored.getSnapshot());
    expect(await readFile(file, 'utf8')).not.toContain('sidebarMode');
  });
  it('rejects stale draft revision and does not overwrite newer text', async () => {
    const { app } = await make();
    const w = (await app.getSnapshot()).workspaces[0];
    if (!w) throw new Error('fixture');
    const s = w.sessions[0];
    if (!s) throw new Error('fixture');
    await app.command({
      type: 'saveDraft',
      workspaceId: w.workspaceId,
      commandId: 'new',
      expectedRevision: 0,
      sessionId: s.sessionId,
      draft: 'new draft',
    });
    const result = await app.command({
      type: 'saveDraft',
      workspaceId: w.workspaceId,
      commandId: 'old',
      expectedRevision: 0,
      sessionId: s.sessionId,
      draft: 'old draft',
    });
    expect(result.ok).toBe(false);
    expect(result.snapshot.workspaces[0]?.sessions[0]?.draft).toBe('new draft');
  });
  it('does not expose or later persist a failed metadata mutation', async () => {
    const { app, repository } = await make();
    vi.mocked(repository.save).mockRejectedValueOnce(new Error('disk full'));
    const result = await app.command({ type: 'renameWorkspace', commandId: 'fail', workspaceId: 'taskflow-demo', name: 'lost' });
    expect(result.ok).toBe(false);
    expect(result.snapshot.workspaces[0]?.name).toBe('TaskFlow');
    await app.command({ type: 'renameWorkspace', commandId: 'next', workspaceId: 'taskflow-demo', name: 'kept' });
    expect((await app.getSnapshot()).workspaces[0]?.name).toBe('kept');
  });
  it('deduplicates runtime side effects and rejects changed payloads', async () => {
    const { app, runtime } = await make();
    const r = (await app.getSnapshot()).workspaces[0]?.resources.find((r) => r.kind === 'web');
    if (!r) throw new Error('fixture');
    const c: WorkbenchCommand = {
      type: 'browserAction',
      commandId: 'nav',
      workspaceId: 'taskflow-demo',
      resourceId: r.resourceId,
      action: 'reload',
    };
    await app.command(c);
    await app.command(c);
    expect(runtime.browserAction).toHaveBeenCalledTimes(1);
    expect((await app.command({ ...c, action: 'back' })).ok).toBe(false);
  });
  it('isolates resources from a different workspace', async () => {
    const { app } = await make();
    const r = (await app.getSnapshot()).workspaces[0]?.resources[0];
    if (!r) throw new Error('fixture');
    await app.command({ type: 'createWorkspace', commandId: 'create', workspaceId: 'other', name: 'Other' });
    const result = await app.command({
      type: 'browserAction',
      commandId: 'bad',
      workspaceId: 'other',
      resourceId: r.resourceId,
      action: 'reload',
    });
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error.code).toBe('denied');
  });
  it('keeps execution ownership after space switch and tab closure; rejects old generation', async () => {
    const { app, runtime } = await make();
    const w = (await app.getSnapshot()).workspaces.find((workspace) => workspace.workspaceId === 'taskflow-demo');
    const s = w?.sessions[0];
    if (!w || !s) throw new Error('fixture');
    vi.mocked(runtime.send).mockResolvedValue(conversation(s.sessionId, 'new', 5));
    await app.command({
      type: 'confirmTask',
      commandId: 'confirm',
      workspaceId: w.workspaceId,
      sessionId: s.sessionId,
      goal: 'goal',
      targetRef: null,
    });
    const version = (await app.getSnapshot()).workspaces.find((workspace) => workspace.workspaceId === 'taskflow-demo')?.sessions[0]
      ?.taskVersions[0];
    if (!version) throw new Error('fixture');
    await app.command({
      type: 'startRun',
      commandId: 'run',
      workspaceId: w.workspaceId,
      sessionId: s.sessionId,
      taskVersionId: version.taskVersionId,
    });
    const tab = w.tabs.find((t) => t.targetRef.resourceId === s.resourceId);
    if (!tab) throw new Error('fixture');
    await app.command({ type: 'closeTab', commandId: 'close', workspaceId: w.workspaceId, tabId: tab.tabId });
    await app.command({ type: 'createWorkspace', commandId: 'other', workspaceId: 'other', name: 'Other' });
    app.onConversation(conversation(s.sessionId, 'old', 100, 'idle'));
    await app.getSnapshot();
    expect((await app.getSnapshot()).workspaces.find((workspace) => workspace.workspaceId === 'taskflow-demo')?.runs[0]?.state).toBe(
      'running',
    );
    app.onConversation(conversation(s.sessionId, 'new', 6, 'idle'));
    await app.getSnapshot();
    expect((await app.getSnapshot()).workspaces.find((workspace) => workspace.workspaceId === 'taskflow-demo')?.runs[0]?.state).toBe(
      'completed',
    );
    expect((await app.getSnapshot()).activeWorkspaceId).toBe('other');
  });
  it('keeps verifier unavailable and rejects review of a failed run', async () => {
    const { app, runtime } = await make();
    const s = (await app.getSnapshot()).workspaces[0]?.sessions[0];
    if (!s) throw new Error('fixture');
    vi.mocked(runtime.send).mockRejectedValue(new Error('offline'));
    await app.command({
      type: 'confirmTask',
      workspaceId: 'taskflow-demo',
      commandId: 'confirm',
      sessionId: s.sessionId,
      goal: 'goal',
      targetRef: null,
    });
    const v = (await app.getSnapshot()).workspaces[0]?.sessions[0]?.taskVersions[0];
    if (!v) throw new Error('fixture');
    await app.command({
      type: 'startRun',
      workspaceId: 'taskflow-demo',
      commandId: 'start',
      sessionId: s.sessionId,
      taskVersionId: v.taskVersionId,
    });
    const run = (await app.getSnapshot()).workspaces[0]?.runs[0];
    if (!run) throw new Error('fixture');
    await app.command({ type: 'runValidation', workspaceId: 'taskflow-demo', commandId: 'check', runId: run.runId });
    expect((await app.getSnapshot()).workspaces[0]?.runs[0]?.validation.state).toBe('blocked');
    expect(
      (
        await app.command({
          type: 'recordReview',
          workspaceId: 'taskflow-demo',
          commandId: 'review',
          runId: run.runId,
          candidateId: run.candidateId,
          decision: 'accepted',
        })
      ).ok,
    ).toBe(false);
  });
  it('validates deep persisted layout invariants', async () => {
    const { app } = await make();
    const s = await app.getSnapshot();
    const w = s.workspaces[0];
    if (!w) throw new Error('fixture');
    w.activePaneId = 'missing';
    expect(() => validateSnapshot(s)).toThrow('conflict');
  });
  it('restores drafts/history but never replays a runner or terminal', async () => {
    const { app, runtime } = await make();
    const before = await app.getSnapshot();
    const w = before.workspaces[0];
    const session = w?.sessions[0];
    if (!w || !session) throw new Error('fixture');
    await app.command({
      type: 'saveDraft',
      commandId: 'draft',
      workspaceId: w.workspaceId,
      sessionId: session.sessionId,
      draft: 'saved draft',
    });
    vi.mocked(runtime.send).mockResolvedValue({
      ...conversation(session.sessionId, 'active', 1),
      messages: [{ id: 'historical', role: 'assistant', text: 'preserved reply' }],
    });
    await app.command({
      type: 'confirmTask',
      commandId: 'version',
      workspaceId: w.workspaceId,
      sessionId: session.sessionId,
      goal: 'goal',
      targetRef: null,
    });
    const version = (await app.getSnapshot()).workspaces[0]?.sessions[0]?.taskVersions[0];
    if (!version) throw new Error('fixture');
    await app.command({
      type: 'startRun',
      commandId: 'start',
      workspaceId: w.workspaceId,
      sessionId: session.sessionId,
      taskVersionId: version.taskVersionId,
    });
    const fileRepository = new FileWorkbenchRepository(path.join(await mkdtemp(path.join(os.tmpdir(), 'wsl-restore-')), 'workbench.json'));
    await fileRepository.save(await app.getSnapshot());
    const restored = new WorkbenchApplication(fileRepository, runtime, vi.fn());
    const after = await restored.getSnapshot();
    expect(after.appInstanceId).not.toBe(before.appInstanceId);
    expect(after.workspaces[0]?.sessions[0]?.draft).toBe('saved draft');
    expect(after.workspaces[0]?.sessions[0]?.historyRestored).toBe(true);
    expect(after.workspaces[0]?.layout).toEqual((await app.getSnapshot()).workspaces[0]?.layout);
    expect(after.workspaces[0]?.sessions[0]?.taskVersions).toEqual((await app.getSnapshot()).workspaces[0]?.sessions[0]?.taskVersions);
    expect(after.workspaces[0]?.runs[0]?.state).toBe('interrupted');
    expect(runtime.send).toHaveBeenCalledTimes(1);
    expect(runtime.terminalOpen).not.toHaveBeenCalled();
    vi.mocked(runtime.send).mockResolvedValue({
      ...conversation(session.sessionId, 'new-instance', 1),
      messages: [{ id: 'new-message', role: 'user', text: 'new intent' }],
    });
    await restored.command({
      type: 'startRun',
      commandId: 'new-start',
      workspaceId: w.workspaceId,
      sessionId: session.sessionId,
      taskVersionId: version.taskVersionId,
    });
    expect((await restored.getSnapshot()).workspaces[0]?.sessions[0]?.conversation?.messages.map((m) => m.text)).toEqual([
      'preserved reply',
      'new intent',
    ]);
  });
  it('rejects a previous browser instance even when its document generation matches', async () => {
    const { app, runtime } = await make();
    const w = (await app.getSnapshot()).workspaces[0];
    const s = w?.sessions[0];
    const r = w?.resources.find((r) => r.kind === 'web');
    if (!w || !s || !r) throw new Error('fixture');
    const page = {
      webContentsId: 1,
      documentGeneration: 1,
      url: 'wsl-demo://taskflow/index.html',
      title: 'TaskFlow',
      partition: 'preview',
    };
    const state = {
      page,
      loading: false,
      canGoBack: false,
      canGoForward: false,
      picking: false,
      cdp: { state: 'attached' as const },
      consoleIssueCount: 0,
      loadError: null,
      blockedNavigation: null,
      pickError: null,
    };
    vi.mocked(runtime.browserState).mockReturnValue(state);
    await app.command({
      type: 'captureContext',
      requestId: 'capture-request',
      commandId: 'capture',
      workspaceId: w.workspaceId,
      sessionId: s.sessionId,
      resourceId: r.resourceId,
    });
    app.onCapture(
      r.resourceId,
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
      (await app.getSnapshot()).workspaces[0]!.resources.find((item) => item.resourceId === r.resourceId)!.instanceId,
      (await app.getSnapshot()).workspaces[0]!.resources.find((item) => item.resourceId === r.resourceId)!.generation,
      'capture-request',
    );
    await app.getSnapshot();
    vi.mocked(runtime.browserState).mockReturnValue({ ...state, page: { ...page, webContentsId: 2 } });
    const rejected = await app.command({
      type: 'confirmTask',
      commandId: 'confirm',
      workspaceId: w.workspaceId,
      sessionId: s.sessionId,
      goal: 'goal',
      targetRef: { kind: 'web', resourceId: r.resourceId },
    });
    expect(rejected.ok).toBe(false);
    const confirmed = await app.command({
      type: 'confirmTask',
      commandId: 'none',
      workspaceId: w.workspaceId,
      sessionId: s.sessionId,
      goal: 'goal',
      targetRef: null,
    });
    expect(confirmed.snapshot.workspaces[0]?.sessions[0]?.taskVersions[0]?.capture).toBeNull();
  });
  it('validates a new browser URL before adding a tab or creating a native view', async () => {
    const { app, runtime } = await make();
    vi.mocked(runtime.validateBrowserUrl).mockImplementation(() => {
      throw new Error('invalid_input: 禁止私有或危险地址');
    });
    for (const url of ['file:///etc/passwd', 'javascript:alert(1)', 'https://user:password@example.com/', 'https://127.0.0.1/']) {
      const before = await app.getSnapshot();
      const result = await app.command({
        type: 'createTab',
        commandId: crypto.randomUUID(),
        workspaceId: 'taskflow-demo',
        kind: 'web',
        title: 'bad',
        url,
      });
      expect(result.ok).toBe(false);
      expect(result.snapshot.workspaces[0]?.tabs).toEqual(before.workspaces[0]?.tabs);
    }
    expect(runtime.ensureBrowser).not.toHaveBeenCalled();
  });
  it('persists cancellation before cleanup while navigation, drafts and runtime events keep flowing', async () => {
    const { app, runtime } = await make();
    const w = (await app.getSnapshot()).workspaces.find((workspace) => workspace.workspaceId === 'taskflow-demo');
    const session = w?.sessions[0];
    if (!w || !session) throw new Error('fixture');
    vi.mocked(runtime.send).mockResolvedValue(conversation(session.sessionId, 'cancel-test', 1));
    await app.command({
      type: 'confirmTask',
      commandId: 'confirm-cancel',
      workspaceId: w.workspaceId,
      sessionId: session.sessionId,
      goal: 'goal',
      targetRef: null,
    });
    const version = (await app.getSnapshot()).workspaces.find((workspace) => workspace.workspaceId === 'taskflow-demo')?.sessions[0]
      ?.taskVersions[0];
    if (!version) throw new Error('fixture');
    await app.command({
      type: 'startRun',
      commandId: 'start-cancel',
      workspaceId: w.workspaceId,
      sessionId: session.sessionId,
      taskVersionId: version.taskVersionId,
    });
    const run = (await app.getSnapshot()).workspaces.find((workspace) => workspace.workspaceId === 'taskflow-demo')?.runs[0];
    if (!run) throw new Error('fixture');
    let finish!: (value: ChatConversation) => void;
    vi.mocked(runtime.cancel).mockImplementation(
      () =>
        new Promise((resolve) => {
          finish = resolve;
        }),
    );
    const accepted = await Promise.race([
      app.command({ type: 'cancelRun', commandId: 'cancel', workspaceId: w.workspaceId, runId: run.runId }),
      new Promise<null>((resolve) => setTimeout(() => resolve(null), 100)),
    ]);
    if (!accepted) {
      finish(conversation(session.sessionId, 'cancel-test', 2, 'cancelled'));
      throw new Error('cancellation blocked metadata queue');
    }
    expect(accepted.snapshot.workspaces.find((workspace) => workspace.workspaceId === 'taskflow-demo')?.runs[0]?.state).toBe('cancelling');
    await app.command({
      type: 'saveDraft',
      commandId: 'during-cancel',
      workspaceId: w.workspaceId,
      sessionId: session.sessionId,
      draft: 'new draft',
    });
    await app.command({ type: 'createWorkspace', commandId: 'switch-during-cancel', workspaceId: 'other', name: 'Other' });
    app.onConversation(conversation(session.sessionId, 'cancel-test', 2, 'cancelling'));
    const pending = await app.getSnapshot();
    expect(pending.activeWorkspaceId).toBe('other');
    expect(pending.workspaces.find((workspace) => workspace.workspaceId === 'taskflow-demo')?.sessions[0]?.draft).toBe('new draft');
    finish(conversation(session.sessionId, 'cancel-test', 3, 'cancelled'));
    await vi.waitFor(async () =>
      expect((await app.getSnapshot()).workspaces.find((workspace) => workspace.workspaceId === 'taskflow-demo')?.runs[0]?.state).toBe(
        'cancelled',
      ),
    );
  });
  it('does not start cancellation when persisting its request fails', async () => {
    const { app, runtime, repository } = await make();
    const w = (await app.getSnapshot()).workspaces[0];
    const session = w?.sessions[0];
    if (!w || !session) throw new Error('fixture');
    vi.mocked(runtime.send).mockResolvedValue(conversation(session.sessionId, 'cancel-save', 1));
    await app.command({
      type: 'confirmTask',
      commandId: 'v',
      workspaceId: w.workspaceId,
      sessionId: session.sessionId,
      goal: 'goal',
      targetRef: null,
    });
    const v = (await app.getSnapshot()).workspaces[0]?.sessions[0]?.taskVersions[0];
    if (!v) throw new Error('fixture');
    await app.command({
      type: 'startRun',
      commandId: 'r',
      workspaceId: w.workspaceId,
      sessionId: session.sessionId,
      taskVersionId: v.taskVersionId,
    });
    const run = (await app.getSnapshot()).workspaces[0]?.runs[0];
    if (!run) throw new Error('fixture');
    vi.mocked(repository.save).mockRejectedValueOnce(new Error('disk full'));
    const result = await app.command({ type: 'cancelRun', commandId: 'cancel-fail', workspaceId: w.workspaceId, runId: run.runId });
    expect(result.ok).toBe(false);
    expect(result.snapshot.workspaces[0]?.runs[0]?.state).toBe('running');
    expect(runtime.cancel).not.toHaveBeenCalled();
  });
  it('rejects nested cross-workspace restore references without modifying the file', async () => {
    const { app, runtime } = await make();
    const w = (await app.getSnapshot()).workspaces[0];
    const session = w?.sessions[0];
    if (!w || !session) throw new Error('fixture');
    vi.mocked(runtime.send).mockResolvedValue(conversation(session.sessionId, 'persisted', 1));
    await app.command({
      type: 'confirmTask',
      commandId: 'version',
      workspaceId: w.workspaceId,
      sessionId: session.sessionId,
      goal: 'goal',
      targetRef: null,
    });
    const version = (await app.getSnapshot()).workspaces[0]?.sessions[0]?.taskVersions[0];
    if (!version) throw new Error('fixture');
    await app.command({
      type: 'startRun',
      commandId: 'run',
      workspaceId: w.workspaceId,
      sessionId: session.sessionId,
      taskVersionId: version.taskVersionId,
    });
    const original = await app.getSnapshot();
    const corruptions: Array<(snapshot: WorkbenchSnapshot) => void> = [
      (snapshot) => {
        const run = snapshot.workspaces[0]?.runs[0];
        if (run) run.sessionId = 'session-other-space';
      },
      (snapshot) => {
        const version = snapshot.workspaces[0]?.sessions[0]?.taskVersions[0];
        if (version) version.workspaceId = 'other-space';
      },
      (snapshot) => {
        const c = snapshot.workspaces[0]?.sessions[0]?.conversation;
        if (c) c.conversationId = 'session-other-space';
      },
      (snapshot) => {
        const s = snapshot.workspaces[0]?.sessions[0];
        if (s) s.taskTargetRef = { kind: 'web', resourceId: 'foreign-resource' };
      },
      (snapshot) => {
        const run = snapshot.workspaces[0]?.runs[0];
        if (run) run.taskVersionId = 'missing-version';
      },
      (snapshot) => {
        const s = snapshot.workspaces[0]?.sessions[0];
        const v = s?.taskVersions[0];
        if (s && v) s.taskVersions.push({ ...v });
      },
    ];
    const file = path.join(await mkdtemp(path.join(os.tmpdir(), 'wsl-invalid-restore-')), 'workbench.json');
    const repository = new FileWorkbenchRepository(file);
    for (const corrupt of corruptions) {
      const saved = structuredClone(original);
      corrupt(saved);
      await repository.save(saved);
      const before = await readFile(file, 'utf8');
      const restored = new WorkbenchApplication(repository, runtime, vi.fn());
      await expect(restored.getSnapshot()).rejects.toThrow(/denied|conflict/);
      expect(await readFile(file, 'utf8')).toBe(before);
    }
  });
  it('rejects stale restored context without creating a browser and accepts the next registered instance event', async () => {
    const { app, runtime } = await make();
    const saved = await app.getSnapshot();
    const w = saved.workspaces[0];
    const session = w?.sessions[0];
    const r = w?.resources.find((r) => r.kind === 'web');
    if (!w || !session || !r) throw new Error('fixture');
    const page = {
      webContentsId: 1,
      documentGeneration: 1,
      url: 'wsl-demo://taskflow/index.html',
      title: 'TaskFlow',
      partition: 'preview',
    };
    session.context = {
      captureId: 'old',
      capturedAt: 'before restart',
      page,
      element: {
        tagName: 'button',
        id: null,
        classes: [],
        role: null,
        ariaLabel: null,
        testId: null,
        text: 'old',
        selector: 'button',
        rect: null,
      },
      screenshot: { viewport: 'data:image/png;base64,AA', element: null },
      consoleIssues: [],
    };
    session.contextTarget = { kind: 'web', resourceId: r.resourceId };
    session.contextApplicability = 'current';
    const repository: WorkbenchRepository = {
      appendObservation: vi.fn(async () => crypto.randomUUID()),
      load: async () => saved,
      save: vi.fn(),
    };
    const restored = new WorkbenchApplication(repository, runtime, vi.fn());
    await restored.getSnapshot();
    const rejected = await restored.command({
      type: 'confirmTask',
      commandId: 'stale',
      workspaceId: w.workspaceId,
      sessionId: session.sessionId,
      goal: 'goal',
      targetRef: { kind: 'web', resourceId: r.resourceId },
    });
    expect(rejected.ok).toBe(false);
    expect(runtime.ensureBrowser).not.toHaveBeenCalled();
    const state = {
      page: { ...page, webContentsId: 2 },
      loading: false,
      canGoBack: false,
      canGoForward: false,
      picking: false,
      cdp: { state: 'attached' as const },
      consoleIssueCount: 0,
      loadError: null,
      blockedNavigation: null,
      pickError: null,
    };
    vi.mocked(runtime.browserState).mockReturnValue(state);
    const opened = await restored.command({
      type: 'browserLayout',
      commandId: 'show',
      workspaceId: w.workspaceId,
      resourceId: r.resourceId,
      layout: { visible: true, bounds: { x: 0, y: 0, width: 400, height: 300 } },
    });
    expect(opened.ok).toBe(true);
    const current = opened.snapshot.workspaces[0]?.resources.find((resource) => resource.resourceId === r.resourceId);
    if (!current) throw new Error('fixture');
    restored.onPreview(
      r.resourceId,
      { ...state, page: { ...state.page, title: 'current instance' } },
      current.instanceId,
      current.generation,
    );
    expect(
      (await restored.getSnapshot()).workspaces[0]?.resources.find((resource) => resource.resourceId === r.resourceId)?.preview?.page.title,
    ).toBe('current instance');
  });
  it('restores unconfirmed criteria drafts and freezes them into independent task versions', async () => {
    const { app, runtime } = await make();
    const w = (await app.getSnapshot()).workspaces[0];
    const session = w?.sessions[0];
    if (!w || !session) throw new Error('fixture');
    await app.command({
      type: 'saveTaskCriteria',
      commandId: 'criteria',
      workspaceId: w.workspaceId,
      sessionId: session.sessionId,
      acceptance: ['刷新后保留优先级'],
      allowedScopes: ['ui', 'api'],
    });
    const file = path.join(await mkdtemp(path.join(os.tmpdir(), 'wsl-criteria-')), 'workbench.json');
    const repository = new FileWorkbenchRepository(file);
    await repository.save(await app.getSnapshot());
    const restored = new WorkbenchApplication(repository, runtime, vi.fn());
    const loaded = await restored.getSnapshot();
    expect(loaded.workspaces[0]?.sessions[0]?.taskAcceptance).toEqual(['刷新后保留优先级']);
    expect(loaded.workspaces[0]?.sessions[0]?.taskAllowedScopes).toEqual(['ui', 'api']);
    await restored.command({
      type: 'confirmTask',
      commandId: 'freeze',
      workspaceId: w.workspaceId,
      sessionId: session.sessionId,
      goal: '增加优先级',
      targetRef: null,
    });
    await restored.command({
      type: 'saveTaskCriteria',
      commandId: 'next-draft',
      workspaceId: w.workspaceId,
      sessionId: session.sessionId,
      acceptance: ['新的条件'],
      allowedScopes: ['db-migration'],
    });
    const after = await restored.getSnapshot();
    expect(after.workspaces[0]?.sessions[0]?.taskVersions[0]).toMatchObject({
      acceptance: ['刷新后保留优先级'],
      allowedScopes: ['ui', 'api'],
    });
    expect(after.workspaces[0]?.sessions[0]?.taskAcceptance).toEqual(['新的条件']);
    const again = new WorkbenchApplication(repository, runtime, vi.fn());
    expect((await again.getSnapshot()).workspaces[0]?.sessions[0]?.taskVersions[0]?.acceptance).toEqual(['刷新后保留优先级']);
  });
  it("reads this upgrade's earlier session records with empty criteria drafts", async () => {
    const { app, runtime } = await make();
    const saved = await app.getSnapshot();
    const legacy = {
      ...saved,
      workspaces: saved.workspaces.map((w) => ({
        ...w,
        sessions: w.sessions.map(({ taskAcceptance: _acceptance, taskAllowedScopes: _scopes, ...session }) => session),
      })),
    };
    const file = path.join(await mkdtemp(path.join(os.tmpdir(), 'wsl-criteria-default-')), 'workbench.json');
    await writeFile(file, JSON.stringify({ schemaVersion: 1, snapshot: legacy }));
    const restored = new WorkbenchApplication(new FileWorkbenchRepository(file), runtime, vi.fn());
    const session = (await restored.getSnapshot()).workspaces[0]?.sessions[0];
    expect(session?.taskAcceptance).toEqual([]);
    expect(session?.taskAllowedScopes).toEqual([]);
  });
  it('publishes closing while terminal cleanup is deferred and rejects its stale instance reply', async () => {
    const { app, runtime } = await make();
    const w = (await app.getSnapshot()).workspaces.find((workspace) => workspace.workspaceId === 'taskflow-demo');
    const r = w?.resources.find((r) => r.kind === 'terminal');
    const session = w?.sessions[0];
    if (!w || !r || !session) throw new Error('fixture');
    const terminal = (id: string, seq: number, state: TerminalSnapshot['state'], cleanupPending: boolean): TerminalSnapshot => ({
      sessionId: id,
      seq,
      state,
      cleanupPending,
      error: null,
      output: 'output',
      sandbox: 'fixture',
      cwd: '/workspace',
    });
    vi.mocked(runtime.terminalOpen).mockResolvedValue(terminal('old-instance', 1, 'running', true));
    await app.command({
      type: 'terminalOpen',
      commandId: 'open-old',
      workspaceId: w.workspaceId,
      resourceId: r.resourceId,
      cols: 80,
      rows: 24,
    });
    await vi.waitFor(async () =>
      expect(
        (await app.getSnapshot()).workspaces
          .find((x) => x.workspaceId === w.workspaceId)
          ?.resources.find((x) => x.resourceId === r.resourceId)?.terminal?.state,
      ).not.toBe('starting'),
    );
    let finish!: (value: TerminalSnapshot) => void;
    vi.mocked(runtime.terminalStop).mockImplementation(
      () =>
        new Promise((resolve) => {
          finish = resolve;
        }),
    );
    const accepted = await Promise.race([
      app.command({
        type: 'stopInstance',
        commandId: 'stop',
        workspaceId: w.workspaceId,
        resourceId: r.resourceId,
        instanceId: (await app.getSnapshot()).workspaces
          .find((x) => x.workspaceId === w.workspaceId)!
          .resources.find((x) => x.resourceId === r.resourceId)!.instanceId!,
      }),
      new Promise<null>((resolve) => setTimeout(() => resolve(null), 100)),
    ]);
    if (!accepted) {
      finish(terminal('old-instance', 2, 'closed', false));
      throw new Error('terminal stop blocked metadata queue');
    }
    expect(
      accepted.snapshot.workspaces
        .find((workspace) => workspace.workspaceId === 'taskflow-demo')
        ?.resources.find((resource) => resource.resourceId === r.resourceId)?.terminal?.state,
    ).toBe('closing');
    await app.command({
      type: 'terminalOpen',
      commandId: 'no-reopen',
      workspaceId: w.workspaceId,
      resourceId: r.resourceId,
      cols: 80,
      rows: 24,
    });
    await vi.waitFor(async () =>
      expect(
        (await app.getSnapshot()).workspaces
          .find((x) => x.workspaceId === w.workspaceId)
          ?.resources.find((x) => x.resourceId === r.resourceId)?.terminal?.state,
      ).not.toBe('starting'),
    );
    expect(runtime.terminalOpen).toHaveBeenCalledTimes(1);
    await app.command({
      type: 'saveDraft',
      commandId: 'stop-draft',
      workspaceId: w.workspaceId,
      sessionId: session.sessionId,
      draft: 'during cleanup',
    });
    await app.command({ type: 'createWorkspace', commandId: 'navigate-stop', workspaceId: 'other', name: 'Other' });
    expect((await app.getSnapshot()).activeWorkspaceId).toBe('other');
    const oldBinding = vi.mocked(runtime.registerResource).mock.calls[0]![0];
    app.onTerminal(r.resourceId, terminal('old-instance', 2, 'closed', false), oldBinding);
    await app.getSnapshot();
    vi.mocked(runtime.terminalOpen).mockResolvedValue(terminal('new-instance', 1, 'running', true));
    await app.command({
      type: 'terminalOpen',
      commandId: 'reopen-confirmed',
      workspaceId: w.workspaceId,
      resourceId: r.resourceId,
      cols: 80,
      rows: 24,
    });
    await vi.waitFor(async () =>
      expect(
        (await app.getSnapshot()).workspaces
          .find((x) => x.workspaceId === w.workspaceId)
          ?.resources.find((x) => x.resourceId === r.resourceId)?.terminal?.state,
      ).not.toBe('starting'),
    );
    finish(terminal('old-instance', 999, 'closed', false));
    await new Promise((resolve) => setTimeout(resolve, 0));
    const current = (await app.getSnapshot()).workspaces
      .find((workspace) => workspace.workspaceId === 'taskflow-demo')
      ?.resources.find((resource) => resource.resourceId === r.resourceId);
    expect(current?.instanceId).not.toBe(oldBinding.instanceId);
    expect(current?.terminal?.sessionId).toBe('new-instance');
    expect(current?.terminal?.state).toBe('running');
  });
  it('does not stop a terminal when persisting closing fails', async () => {
    const { app, runtime, repository } = await make();
    const w = (await app.getSnapshot()).workspaces[0];
    const r = w?.resources.find((r) => r.kind === 'terminal');
    if (!w || !r) throw new Error('fixture');
    vi.mocked(runtime.terminalOpen).mockResolvedValue({
      sessionId: 'instance',
      seq: 1,
      state: 'running',
      cleanupPending: true,
      error: null,
      output: '',
      sandbox: 'fixture',
      cwd: '/workspace',
    });
    await app.command({
      type: 'terminalOpen',
      commandId: 'open',
      workspaceId: w.workspaceId,
      resourceId: r.resourceId,
      cols: 80,
      rows: 24,
    });
    await vi.waitFor(async () =>
      expect(
        (await app.getSnapshot()).workspaces
          .find((x) => x.workspaceId === w.workspaceId)
          ?.resources.find((x) => x.resourceId === r.resourceId)?.terminal?.state,
      ).not.toBe('starting'),
    );
    vi.mocked(repository.save).mockRejectedValueOnce(new Error('disk full'));
    const stopped = await app.command({
      type: 'stopInstance',
      commandId: 'stop-fail',
      workspaceId: w.workspaceId,
      resourceId: r.resourceId,
      instanceId: (await app.getSnapshot()).workspaces[0]!.resources.find((x) => x.resourceId === r.resourceId)!.instanceId!,
    });
    expect(stopped.ok).toBe(false);
    expect(stopped.snapshot.workspaces[0]?.resources.find((resource) => resource.resourceId === r.resourceId)?.terminal?.state).toBe(
      'running',
    );
    expect(runtime.terminalStop).not.toHaveBeenCalled();
  });
  it('shows unconfirmed cleanup failure and refuses to create a replacement process', async () => {
    const { app, runtime } = await make();
    const w = (await app.getSnapshot()).workspaces[0];
    const r = w?.resources.find((r) => r.kind === 'terminal');
    if (!w || !r) throw new Error('fixture');
    vi.mocked(runtime.terminalOpen).mockResolvedValue({
      sessionId: 'instance',
      seq: 1,
      state: 'running',
      cleanupPending: true,
      error: null,
      output: '',
      sandbox: 'fixture',
      cwd: '/workspace',
    });
    await app.command({
      type: 'terminalOpen',
      commandId: 'open',
      workspaceId: w.workspaceId,
      resourceId: r.resourceId,
      cols: 80,
      rows: 24,
    });
    await vi.waitFor(async () =>
      expect(
        (await app.getSnapshot()).workspaces
          .find((x) => x.workspaceId === w.workspaceId)
          ?.resources.find((x) => x.resourceId === r.resourceId)?.terminal?.state,
      ).not.toBe('starting'),
    );
    vi.mocked(runtime.terminalStop).mockRejectedValue(new Error('guest cleanup timeout'));
    await app.command({
      type: 'stopInstance',
      commandId: 'stop-unknown',
      workspaceId: w.workspaceId,
      resourceId: r.resourceId,
      instanceId: (await app.getSnapshot()).workspaces[0]!.resources.find((x) => x.resourceId === r.resourceId)!.instanceId!,
    });
    await vi.waitFor(async () =>
      expect(
        (await app.getSnapshot()).workspaces[0]?.resources.find((resource) => resource.resourceId === r.resourceId)?.terminal?.error,
      ).toContain('清理未确认'),
    );
    await app.command({
      type: 'terminalOpen',
      commandId: 'blocked-open',
      workspaceId: w.workspaceId,
      resourceId: r.resourceId,
      cols: 80,
      rows: 24,
    });
    await vi.waitFor(async () =>
      expect(
        (await app.getSnapshot()).workspaces
          .find((x) => x.workspaceId === w.workspaceId)
          ?.resources.find((x) => x.resourceId === r.resourceId)?.terminal?.state,
      ).not.toBe('starting'),
    );
    expect(runtime.terminalOpen).toHaveBeenCalledTimes(1);
  });
  it('does not hide native views if workspace navigation cannot be saved', async () => {
    const { app, runtime, repository } = await make();
    await app.command({ type: 'createWorkspace', commandId: 'other', workspaceId: 'other', name: 'Other' });
    vi.mocked(runtime.hideBrowsers).mockClear();
    vi.mocked(repository.save).mockRejectedValueOnce(new Error('disk full'));
    const switched = await app.command({ type: 'switchWorkspace', commandId: 'failed-switch', workspaceId: 'taskflow-demo' });
    expect(switched.ok).toBe(false);
    expect(switched.snapshot.activeWorkspaceId).toBe('other');
    expect(runtime.hideBrowsers).not.toHaveBeenCalled();
    await app.command({ type: 'switchWorkspace', commandId: 'saved-switch', workspaceId: 'taskflow-demo' });
    expect(runtime.hideBrowsers).toHaveBeenCalledOnce();
  });
  it('persists most recently used space order without changing tab order', async () => {
    const { app, runtime } = await make();
    const initialTabs = (await app.getSnapshot()).workspaces.find((w) => w.workspaceId === 'taskflow-demo')?.tabs;
    await app.command({ type: 'createWorkspace', commandId: 'create-b', workspaceId: 'b', name: 'B' });
    await app.command({ type: 'createWorkspace', commandId: 'create-c', workspaceId: 'c', name: 'C' });
    expect((await app.getSnapshot()).workspaces.map((w) => w.workspaceId)).toEqual(['c', 'b', 'taskflow-demo']);
    await app.command({ type: 'switchWorkspace', commandId: 'switch-b', workspaceId: 'b' });
    await app.command({ type: 'switchWorkspace', commandId: 'switch-a', workspaceId: 'taskflow-demo' });
    const saved = await app.getSnapshot();
    expect(saved.workspaces.map((w) => w.workspaceId)).toEqual(['taskflow-demo', 'b', 'c']);
    expect(saved.workspaces.find((w) => w.workspaceId === 'taskflow-demo')?.tabs).toEqual(initialTabs);
    const file = path.join(await mkdtemp(path.join(os.tmpdir(), 'wsl-mru-')), 'workbench.json');
    const repository = new FileWorkbenchRepository(file);
    await repository.save(saved);
    const restored = new WorkbenchApplication(repository, runtime, vi.fn());
    const loaded = await restored.getSnapshot();
    expect(loaded.workspaces.map((w) => w.workspaceId)).toEqual(['taskflow-demo', 'b', 'c']);
    expect(loaded.activeWorkspaceId).toBe('taskflow-demo');
    expect(loaded.workspaces.find((w) => w.workspaceId === 'taskflow-demo')?.tabs).toEqual(initialTabs);
  });
  it('same-space session location retains native visibility; cross-space location hides old native views', async () => {
    const { app, runtime } = await make();
    const original = (await app.getSnapshot()).workspaces[0]!;
    await app.command({
      type: 'locateSession',
      workspaceId: original.workspaceId,
      commandId: crypto.randomUUID(),
      sessionId: original.sessions[0]!.sessionId,
    });
    expect(runtime.hideBrowsers).not.toHaveBeenCalled();
    const created = await app.command({ type: 'createWorkspace', workspaceId: 'other', commandId: 'other-location-test', name: 'Other' });
    if (!created.ok) throw new Error(created.error.message);
    vi.mocked(runtime.hideBrowsers).mockClear();
    await app.command({
      type: 'locateSession',
      workspaceId: original.workspaceId,
      commandId: crypto.randomUUID(),
      sessionId: original.sessions[0]!.sessionId,
    });
    expect(runtime.hideBrowsers).toHaveBeenCalledOnce();
  });
});
