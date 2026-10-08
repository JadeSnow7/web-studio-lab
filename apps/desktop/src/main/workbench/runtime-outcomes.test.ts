import { describe, expect, it, vi } from 'vitest';
import type { PageCapture, PreviewState, TerminalSnapshot, WorkbenchCommand, WorkbenchSnapshot } from '@wsl/protocol';
import { WorkbenchApplication } from './application';
import type { WorkbenchRuntime } from './ports';
const state: PreviewState = {
  page: { webContentsId: 1, documentGeneration: 0, url: 'wsl-demo://taskflow/', title: '', partition: 'fixture' },
  loading: false,
  picking: false,
  canGoBack: false,
  canGoForward: false,
  cdp: { state: 'idle' },
  consoleIssueCount: 0,
  pickError: null,
  loadError: null,
  blockedNavigation: null,
};
async function setup() {
  let saved: WorkbenchSnapshot | null = null;
  const runtime = {
    publicResourcesList: vi.fn().mockResolvedValue({ spaceId: 'taskflow-demo', revision: 0, resources: [] }),
    ensureBrowser: vi.fn(),
    browserState: vi.fn(() => state),
    browserAction: vi.fn(),
    terminalOpen: vi.fn(),
  } as unknown as WorkbenchRuntime;
  const app = new WorkbenchApplication(
    {
      load: async () => saved,
      save: async (snapshot) => {
        saved = structuredClone(snapshot);
      },
    },
    runtime,
    vi.fn(),
  );
  const workspace = (await app.getSnapshot()).workspaces[0]!;
  const command = (payload: Record<string, unknown>) =>
    app.command({ commandId: crypto.randomUUID(), workspaceId: workspace.workspaceId, ...payload } as WorkbenchCommand);
  return { app, runtime, workspace, command };
}
const capture: PageCapture = {
  captureId: 'capture',
  capturedAt: 'fixture',
  page: state.page,
  element: {
    tagName: 'button',
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
const outcome = (session: unknown) =>
  (session as { captureRequest?: { requestId: string; state: string; error: string | null } }).captureRequest;
describe('Main runtime outcome ownership', () => {
  it('reports pending until screenshot completion and publishes completion for exactly that request', async () => {
    const { app, workspace, command } = await setup();
    const r = workspace.resources.find((r) => r.kind === 'web')!;
    const session = workspace.sessions[0]!;
    await command({ type: 'captureContext', resourceId: r.resourceId, sessionId: session.sessionId, requestId: 'request' });
    let snapshot = (await app.getSnapshot()).workspaces[0]!;
    const current = snapshot.resources.find((item) => item.resourceId === r.resourceId)!;
    app.onPreview(r.resourceId, { ...state, picking: false }, current.instanceId, current.generation);
    expect(outcome((await app.getSnapshot()).workspaces[0]!.sessions[0])).toMatchObject({ requestId: 'request', state: 'pending' });
    app.onCapture(r.resourceId, capture, current.instanceId, current.generation, 'request');
    snapshot = (await app.getSnapshot()).workspaces[0]!;
    expect(outcome(snapshot.sessions[0])).toMatchObject({ requestId: 'request', state: 'completed' });
    expect(snapshot.sessions[0]!.context?.captureId).toBe('capture');
  });
  it('keeps an old failure/cancellation from changing the replacement request outcome', async () => {
    const { app, workspace, command } = await setup();
    const r = workspace.resources.find((r) => r.kind === 'web')!;
    const session = workspace.sessions[0]!;
    await command({ type: 'captureContext', resourceId: r.resourceId, sessionId: session.sessionId, requestId: 'old' });
    await command({ type: 'captureContext', resourceId: r.resourceId, sessionId: session.sessionId, requestId: 'new' });
    const current = (await app.getSnapshot()).workspaces[0]!.resources.find((item) => item.resourceId === r.resourceId)!;
    const fail = app.onCaptureError as unknown as (
      resourceId: string,
      requestId: string,
      instanceId: string | null,
      generation: number,
      kind: string,
      error: string,
    ) => void;
    fail.call(app, r.resourceId, 'old', current.instanceId, current.generation, 'failed', 'old failure');
    await command({ type: 'cancelCapture', resourceId: r.resourceId, requestId: 'old' });
    expect(outcome((await app.getSnapshot()).workspaces[0]!.sessions[0])).toMatchObject({
      requestId: 'new',
      state: 'pending',
      error: null,
    });
    await command({ type: 'cancelCapture', resourceId: r.resourceId, requestId: 'new' });
    expect(outcome((await app.getSnapshot()).workspaces[0]!.sessions[0])).toMatchObject({ requestId: 'new', state: 'cancelled' });
  });
  it('preserves confirmed terminal output and cleanup on failure, rejecting duplicate and old sequence updates', async () => {
    const { app, runtime, workspace, command } = await setup();
    const r = workspace.resources.find((r) => r.kind === 'terminal')!;
    const terminal: TerminalSnapshot = {
      sessionId: 'current',
      seq: 10,
      state: 'running',
      output: 'current prompt',
      cleanupPending: true,
      error: null,
      sandbox: 'fixture',
      cwd: '/workspace',
    };
    vi.mocked(runtime.terminalOpen).mockResolvedValue(terminal);
    await command({ type: 'terminalOpen', resourceId: r.resourceId, cols: 80, rows: 24 });
    app.onTerminal(r.resourceId, { ...terminal, seq: 9, sessionId: 'old', output: 'late' });
    app.onTerminal(r.resourceId, { ...terminal, output: 'duplicate' });
    let current = (await app.getSnapshot()).workspaces[0]!.resources.find((item) => item.resourceId === r.resourceId)!;
    expect(current.terminal).toEqual(terminal);
    app.onTerminal(r.resourceId, { ...terminal, seq: 11, state: 'failed', error: '未确认远端退出' });
    current = (await app.getSnapshot()).workspaces[0]!.resources.find((item) => item.resourceId === r.resourceId)!;
    expect(current.terminal).toMatchObject({ output: 'current prompt', cleanupPending: true, error: '未确认远端退出', state: 'failed' });
  });
});
