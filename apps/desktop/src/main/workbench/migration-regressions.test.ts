import { describe, expect, it, vi } from 'vitest';
import {
  WorkbenchCommandSchema,
  type ChatConversation,
  type PageCapture,
  type PreviewState,
  type WorkbenchCommand,
  type WorkbenchSnapshot,
} from '@wsl/protocol';
import { WorkbenchApplication } from './application';
import type { WorkbenchRepository } from './repository';
import type { WorkbenchRuntime } from './ports';

const state: PreviewState = {
  page: { webContentsId: 42, documentGeneration: 1, url: 'wsl-demo://taskflow/index.html', title: 'fixture', partition: 'fixture' },
  loading: false,
  canGoBack: false,
  canGoForward: false,
  picking: false,
  cdp: { state: 'attached' },
  consoleIssueCount: 0,
  loadError: null,
  blockedNavigation: null,
  pickError: null,
};
const capture: PageCapture = {
  captureId: 'capture',
  capturedAt: '2026-10-08',
  page: state.page,
  element: {
    tagName: 'BUTTON',
    id: null,
    classes: [],
    role: null,
    ariaLabel: null,
    testId: null,
    text: 'fixture',
    selector: 'button',
    rect: null,
  },
  screenshot: { viewport: 'data:image/png;base64,AA==', element: null },
  consoleIssues: [],
};
const conversation = (id: string, generation: string, seq: number, text: string): ChatConversation => ({
  conversationId: id,
  generation,
  seq,
  state: 'idle',
  threadId: 'thread',
  turnId: 'turn-' + generation,
  messages: [{ id: generation, role: 'assistant', text }],
  toolExecutions: [],
  warnings: [],
  cleanupPending: false,
  error: null,
});
function setup() {
  let saved: WorkbenchSnapshot | null = null;
  const repository: WorkbenchRepository = {
    appendObservation: vi.fn(async () => crypto.randomUUID()),
    load: vi.fn(async () => saved),
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
    browserState: vi.fn(() => structuredClone(state)),
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
  const command = (payload: Record<string, unknown>) =>
    app.command({ commandId: crypto.randomUUID(), workspaceId: 'taskflow-demo', ...payload } as WorkbenchCommand);
  return { app, runtime, repository, command };
}

describe('R1-R7 backend migration baseline', () => {
  it('R5 does not publish a failed browser instance and retries the next command', async () => {
    const { app, runtime, command } = setup();
    const r = (await app.getSnapshot()).workspaces[0]!.resources.find((r) => r.kind === 'web')!;
    vi.mocked(runtime.ensureBrowser).mockImplementationOnce(() => {
      throw new Error('create failed');
    });
    const failed = await command({ type: 'browserAction', resourceId: r.resourceId, action: 'reload' });
    expect(failed.ok).toBe(false);
    expect(failed.snapshot.workspaces[0]!.resources.find((item) => item.resourceId === r.resourceId)!.instanceId).toBeNull();
    expect((await command({ type: 'browserAction', resourceId: r.resourceId, action: 'reload' })).ok).toBe(true);
    expect(runtime.ensureBrowser).toHaveBeenCalledTimes(2);
  });
  it('R6 permits local history when external session registration is unavailable', async () => {
    const { app, runtime, repository } = setup();
    await app.getSnapshot();
    vi.mocked(runtime.registerSession).mockRejectedValue(new Error('sbx offline'));
    const restored = new WorkbenchApplication(repository, runtime, vi.fn());
    await expect(restored.getSnapshot()).resolves.toMatchObject({ activeWorkspaceId: 'taskflow-demo' });
    expect(runtime.send).not.toHaveBeenCalled();
  });
  it('R6 coalesces explicit initialization retry after a repository failure', async () => {
    const { app, runtime, repository } = setup();
    await app.getSnapshot();
    vi.mocked(repository.load).mockRejectedValueOnce(new Error('temporary read failure'));
    const restored = new WorkbenchApplication(repository, runtime, vi.fn());
    await expect(restored.getSnapshot()).rejects.toThrow('temporary read failure');
    const retry = (restored as unknown as { retryInitialization?: () => Promise<WorkbenchSnapshot> }).retryInitialization;
    expect(retry).toBeTypeOf('function');
    const [first, second] = await Promise.all([retry!.call(restored), retry!.call(restored)]);
    expect(first.activeWorkspaceId).toBe(second.activeWorkspaceId);
    expect(repository.load).toHaveBeenCalledTimes(3);
    expect(runtime.send).not.toHaveBeenCalled();
  });
  it('R4 carries request identity through pick and refuses replaced capture callbacks', async () => {
    const { app, runtime, command } = setup();
    const w = (await app.getSnapshot()).workspaces[0]!;
    const r = w.resources.find((r) => r.kind === 'web')!;
    await command({ type: 'captureContext', resourceId: r.resourceId, sessionId: w.sessions[0]!.sessionId, requestId: 'old' });
    await command({ type: 'createTab', kind: 'session', title: 'second' });
    const second = (await app.getSnapshot()).workspaces[0]!.sessions[1]!;
    await command({ type: 'captureContext', resourceId: r.resourceId, sessionId: second.sessionId, requestId: 'new' });
    expect(runtime.browserAction).toHaveBeenLastCalledWith(r.resourceId, 'pick', undefined, 'new');
    const current = (await app.getSnapshot()).workspaces[0]!.resources.find((item) => item.resourceId === r.resourceId)!;
    const deliver = app.onCapture as unknown as (
      resourceId: string,
      capture: PageCapture,
      instanceId: string | null,
      generation: number,
      requestId: string,
    ) => void;
    deliver.call(app, r.resourceId, capture, current.instanceId, current.generation, 'old');
    expect((await app.getSnapshot()).workspaces[0]!.sessions[1]!.context).toBeNull();
    deliver.call(app, r.resourceId, capture, current.instanceId, current.generation, 'new');
    expect((await app.getSnapshot()).workspaces[0]!.sessions[1]!.context?.captureId).toBe('capture');
  });
  it('R1 saves each run conversation independently across subsequent runs and restart', async () => {
    const { app, runtime, repository, command } = setup();
    const session = (await app.getSnapshot()).workspaces[0]!.sessions[0]!;
    await command({ type: 'confirmTask', sessionId: session.sessionId, goal: 'fixture', targetRef: null });
    const version = (await app.getSnapshot()).workspaces[0]!.sessions[0]!.taskVersions[0]!;
    vi.mocked(runtime.send)
      .mockResolvedValueOnce(conversation(session.sessionId, 'one', 1, 'first log'))
      .mockResolvedValueOnce(conversation(session.sessionId, 'two', 1, 'second log'));
    await command({ type: 'startRun', sessionId: session.sessionId, taskVersionId: version.taskVersionId });
    await command({ type: 'startRun', sessionId: session.sessionId, taskVersionId: version.taskVersionId });
    const restored = new WorkbenchApplication(repository, runtime, vi.fn());
    const runs = (await restored.getSnapshot()).workspaces[0]!.runs as unknown as Array<{ conversation?: ChatConversation }>;
    expect(runs[0]?.conversation?.messages.map((m) => m.text)).toEqual(['first log']);
    expect(runs[1]?.conversation?.messages.map((m) => m.text)).toEqual(['second log']);
  });
  it('R1 exposes separate locate and read receipt commands at the IPC boundary', () => {
    expect(
      WorkbenchCommandSchema.safeParse({
        type: 'locateSession',
        commandId: 'locate',
        workspaceId: 'w',
        sessionId: 's',
        taskVersionId: 'v',
        runId: 'r',
      }).success,
    ).toBe(true);
    expect(
      WorkbenchCommandSchema.safeParse({
        type: 'markNotificationRead',
        commandId: 'read',
        workspaceId: 'w',
        notificationId: 'w:r:completed',
      }).success,
    ).toBe(true);
  });
});
