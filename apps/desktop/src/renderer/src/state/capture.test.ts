import { beforeEach, expect, it, vi } from 'vitest';
import { WorkbenchSnapshotSchema, type WorkbenchCommand, type PageCapture } from '@wsl/protocol';
import { captureContext, cancelContextCapture } from './capture';
import { workspaceStore, projectSnapshot } from './workspace';
const page = { webContentsId: 7, documentGeneration: 1, url: 'wsl-demo://taskflow/index.html', title: '网页', partition: 'test' };
const makeSnapshot = () =>
  WorkbenchSnapshotSchema.parse({
    appInstanceId: 'capture',
    storageError: null,
    activeWorkspaceId: 'space',
    seq: 1,
    workspaces: [
      {
        workspaceId: 'space',
        name: 'space',
        revision: 1,
        tabs: [],
        layout: { kind: 'pane', paneId: 'pane', tabId: null },
        activePaneId: 'pane',
        theme: 'light',
        runs: [],
        publicResources: null,
        resources: [
          {
            resourceId: 'web',
            kind: 'web',
            environmentId: 'local',
            title: 'web',
            url: page.url,
            instanceId: 'native',
            generation: 1,
            terminal: null,
            unavailableReason: null,
            preview: {
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
            },
          },
        ],
        sessions: [
          {
            sessionId: 'owner',
            resourceId: 'owner-resource',
            title: 'owner',
            draft: '',
            conversation: null,
            context: null,
            contextTarget: null,
            taskTargetRef: null,
            contextApplicability: 'unknown',
            taskVersions: [],
          },
        ],
      },
    ],
  });
const capture: PageCapture = {
  captureId: 'captured',
  capturedAt: '2026-10-08T00:00:00Z',
  page,
  element: {
    tagName: 'p',
    id: null,
    classes: [],
    role: null,
    ariaLabel: null,
    testId: null,
    text: 'element',
    selector: 'p',
    rect: { x: 0, y: 0, width: 1, height: 1 },
  },
  screenshot: { viewport: 'data:image/png;base64,AA', element: null },
  consoleIssues: [],
};
let calls: WorkbenchCommand[];
beforeEach(() => {
  calls = [];
  workspaceStore.set(() => ({ snapshot: makeSnapshot(), selectedId: 'space', error: null }));
  vi.stubGlobal('requestAnimationFrame', (fn: FrameRequestCallback) => {
    queueMicrotask(() => fn(0));
    return 1;
  });
  vi.stubGlobal('window', {
    studio: {
      workbench: {
        command: vi.fn(async (command: WorkbenchCommand) => {
          calls.push(command);
          const snapshot = structuredClone(workspaceStore.get().snapshot!);
          snapshot.seq++;
          if (command.type === 'captureContext') {
            snapshot.workspaces[0]!.resources[0]!.preview!.picking = true;
            snapshot.workspaces[0]!.sessions[0]!.captureRequest = {
              requestId: command.requestId,
              resourceId: command.resourceId,
              state: 'pending',
              error: null,
            };
          }
          return { ok: true as const, snapshot };
        }),
      },
    },
  });
});
it('opens the target before capture, and after screenshot completion locates the frozen owner', async () => {
  await captureContext('space', 'owner', 'web');
  expect(calls.map((c) => c.type)).toEqual(['openTab', 'captureContext']);
  const capturing = structuredClone(workspaceStore.get().snapshot!);
  capturing.seq++;
  // Controller exits inspect mode before asynchronous screenshot completion.
  capturing.workspaces[0]!.resources[0]!.preview!.picking = false;
  projectSnapshot(capturing);
  expect(calls.map((c) => c.type)).not.toContain('locateSession');
  const completed = structuredClone(capturing);
  completed.seq++;
  completed.workspaces[0]!.sessions[0]!.captureRequest!.state = 'completed';
  completed.workspaces[0]!.sessions[0]!.context = capture;
  completed.workspaces[0]!.sessions[0]!.contextTarget = { kind: 'web', resourceId: 'web' };
  projectSnapshot(completed);
  await vi.waitFor(() => expect(calls.at(-1)).toMatchObject({ type: 'locateSession', workspaceId: 'space', sessionId: 'owner' }));
});
it('replacement creates a new request ID and cancellation identifies only that request', async () => {
  await captureContext('space', 'owner', 'web');
  const first = calls.find((c) => c.type === 'captureContext')!;
  await captureContext('space', 'owner', 'web');
  const second = calls.filter((c) => c.type === 'captureContext').at(-1)!;
  expect(first).not.toMatchObject({ requestId: (second as Extract<WorkbenchCommand, { type: 'captureContext' }>).requestId });
  const stale = structuredClone(workspaceStore.get().snapshot!);
  stale.seq++;
  stale.workspaces[0]!.sessions[0]!.captureRequest = {
    requestId: (first as Extract<WorkbenchCommand, { type: 'captureContext' }>).requestId,
    resourceId: 'web',
    state: 'failed',
    error: 'old',
  };
  projectSnapshot(stale);
  await cancelContextCapture('space', 'web');
  expect(calls.at(-1)).toMatchObject({
    type: 'cancelCapture',
    requestId: (second as Extract<WorkbenchCommand, { type: 'captureContext' }>).requestId,
  });
  const late = structuredClone(workspaceStore.get().snapshot!);
  late.seq++;
  late.workspaces[0]!.sessions[0]!.context = capture;
  late.workspaces[0]!.sessions[0]!.contextTarget = { kind: 'web', resourceId: 'web' };
  projectSnapshot(late);
  expect(calls.map((c) => c.type)).not.toContain('locateSession');
});

it('failed target opening releases ownership and never starts picking', async () => {
  vi.stubGlobal('window', {
    studio: {
      workbench: {
        command: vi.fn(async (command: WorkbenchCommand) => {
          calls.push(command);
          return { ok: false as const, error: { code: 'not_found', message: 'target missing' }, snapshot: workspaceStore.get().snapshot! };
        }),
      },
    },
  });
  await captureContext('space', 'owner', 'web');
  expect(calls.map((c) => c.type)).toEqual(['openTab']);
  expect(() => cancelContextCapture('space', 'web')).toThrow('没有由此工作台发起');
});

it('failed capture receipt releases completion subscription', async () => {
  await captureContext('space', 'owner', 'web');
  const failed = structuredClone(workspaceStore.get().snapshot!);
  failed.seq++;
  failed.workspaces[0]!.sessions[0]!.captureRequest!.state = 'failed';
  projectSnapshot(failed);
  expect(() => cancelContextCapture('space', 'web')).toThrow('没有由此工作台发起');
  const late = structuredClone(failed);
  late.seq++;
  late.workspaces[0]!.sessions[0]!.captureRequest!.state = 'completed';
  projectSnapshot(late);
  expect(calls.map((c) => c.type)).not.toContain('locateSession');
});
it('same-URL navigation invalidates the UI completion route', async () => {
  await captureContext('space', 'owner', 'web');
  const navigated = structuredClone(workspaceStore.get().snapshot!);
  navigated.seq++;
  navigated.workspaces[0]!.resources[0]!.preview!.page.documentGeneration++;
  navigated.workspaces[0]!.sessions[0]!.captureRequest!.state = 'cancelled';
  projectSnapshot(navigated);
  const late = structuredClone(navigated);
  late.seq++;
  late.workspaces[0]!.sessions[0]!.context = capture;
  late.workspaces[0]!.sessions[0]!.contextTarget = { kind: 'web', resourceId: 'web' };
  projectSnapshot(late);
  expect(calls.map((c) => c.type)).not.toContain('locateSession');
});

it('a different page replacing the same receiver releases the old subscription and request', async () => {
  const value = structuredClone(workspaceStore.get().snapshot!);
  value.workspaces[0]!.resources.push({ ...value.workspaces[0]!.resources[0]!, resourceId: 'second-web' });
  workspaceStore.set((s) => ({ ...s, snapshot: value }));
  const stops: Array<ReturnType<typeof vi.fn>> = [];
  const subscribe = workspaceStore.subscribe.bind(workspaceStore);
  const spy = vi.spyOn(workspaceStore, 'subscribe').mockImplementation((listener) => {
    const stop = vi.fn(subscribe(listener));
    stops.push(stop);
    return stop;
  });
  try {
    await captureContext('space', 'owner', 'web');
    await captureContext('space', 'owner', 'second-web');
    expect(stops[0]).toHaveBeenCalledTimes(1);
    expect(() => cancelContextCapture('space', 'web')).toThrow('没有由此工作台发起');
    await cancelContextCapture('space', 'second-web');
    expect(stops[1]).toHaveBeenCalledTimes(1);
  } finally {
    spy.mockRestore();
  }
});
