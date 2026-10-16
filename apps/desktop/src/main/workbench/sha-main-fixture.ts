import { catalogForTestSnapshot } from './catalog-test-fixture';
import { vi } from 'vitest';
import type { PageCapture, PreviewState, WorkbenchCommand, WorkbenchSnapshot } from '@wsl/protocol';
import { WorkbenchApplication } from './application';
import type { WorkbenchRuntime } from './ports';
export const state: PreviewState = {
  page: {
    webContentsId: 1,
    documentGeneration: 0,
    url: 'wsl-demo://taskflow/',
    title: '',
    partition: 'fixture',
  },
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
export async function setup() {
  let saved: WorkbenchSnapshot | null = null;
  const published: WorkbenchSnapshot[] = [];
  const runtime = {
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
    releaseResource: vi.fn(),
    observe: vi.fn(),
    ensureBrowser: vi.fn(),
    browserState: vi.fn(() => state),
    browserAction: vi.fn(),
    terminalOpen: vi.fn(),
  } as unknown as WorkbenchRuntime;
  const app = new WorkbenchApplication(
    {
      appendObservation: vi.fn(async () => crypto.randomUUID()),
      migrationPending: false,
      loadCatalog: catalogForTestSnapshot,
      load: async () => saved,
      save: async (snapshot) => {
        saved = structuredClone(snapshot);
      },
    },
    runtime,
    (event) => published.push(structuredClone(event.snapshot)),
  );
  const workspace = (await app.getSnapshot()).workspaces[0]!;
  const command = (payload: Record<string, unknown>) =>
    app.command({
      commandId: crypto.randomUUID(),
      workspaceId: workspace.workspaceId,
      ...payload,
    } as WorkbenchCommand);
  return { app, runtime, workspace, command, published };
}
export const capture: PageCapture = {
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
