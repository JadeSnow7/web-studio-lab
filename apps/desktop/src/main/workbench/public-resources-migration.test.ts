import { describe, expect, it, vi } from 'vitest';
import type { PreviewState, ResourceCollection, WorkbenchCommand } from '@wsl/protocol';
import { WorkbenchApplication } from './application';
import type { WorkbenchRuntime } from './ports';
const state: PreviewState = {
  page: { webContentsId: 42, documentGeneration: 1, url: 'https://example.com/', title: 'fixture', partition: 'fixture' },
  loading: false,
  picking: false,
  canGoBack: false,
  canGoForward: false,
  cdp: { state: 'idle' },
  consoleIssueCount: 0,
  loadError: null,
  blockedNavigation: null,
  pickError: null,
};
const collection = (revision: number): ResourceCollection => ({ spaceId: 'taskflow-demo', revision, resources: [] });
async function setup(list = vi.fn().mockResolvedValue(collection(0))) {
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
    observe: vi.fn(),
    publicResourcesList: list,
    publicResourcesCapture: vi.fn().mockResolvedValue(collection(1)),
    publicResourcesRemove: vi.fn().mockResolvedValue(collection(2)),
    ensureBrowser: vi.fn(),
    browserState: () => state,
    validateBrowserUrl: vi.fn(),
    hideBrowsers: vi.fn(),
  } as unknown as WorkbenchRuntime;
  const app = new WorkbenchApplication(
    { appendObservation: vi.fn(async () => crypto.randomUUID()), load: async () => null, save: async () => {} },
    runtime,
    vi.fn(),
  );
  const w = (await app.getSnapshot()).workspaces[0]!;
  const web = w.resources.find((r) => r.kind === 'web')!;
  const command = (payload: Record<string, unknown>) =>
    app.command({ commandId: crypto.randomUUID(), workspaceId: w.workspaceId, ...payload } as WorkbenchCommand);
  return { app, runtime, command, web };
}
describe('Main public resource contract migration', () => {
  it.each(['capture', 'remove'])('refuses an initialization list older than the newer %s result', async (action) => {
    let finish!: (value: ResourceCollection) => void;
    const { app, command, web } = await setup(
      vi.fn(
        () =>
          new Promise((resolve) => {
            finish = resolve;
          }),
      ),
    );
    await command(
      action === 'capture'
        ? { type: 'capturePublicResource', resourceId: web.resourceId }
        : { type: 'removePublicResource', savedResourceId: 'saved' },
    );
    finish(collection(0));
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect((await app.getSnapshot()).workspaces[0]!.publicResources?.revision).toBe(action === 'capture' ? 1 : 2);
  });
  it('deduplicates a pending command retry without another capture or collection mutation', async () => {
    const { app, runtime, web } = await setup();
    let finish!: (value: ResourceCollection) => void;
    vi.mocked(runtime.publicResourcesCapture).mockImplementation(
      () =>
        new Promise((resolve) => {
          finish = resolve;
        }),
    );
    const command: WorkbenchCommand = {
      type: 'capturePublicResource',
      commandId: 'retry-same-operation',
      workspaceId: 'taskflow-demo',
      resourceId: web.resourceId,
    };
    const first = app.command(command);
    const retry = app.command(command);
    await vi.waitFor(() => expect(runtime.publicResourcesCapture).toHaveBeenCalledOnce());
    finish(collection(1));
    expect((await first).ok).toBe(true);
    expect((await retry).ok).toBe(true);
    expect(runtime.publicResourcesCapture).toHaveBeenCalledOnce();
    expect((await app.getSnapshot()).workspaces[0]!.publicResources?.revision).toBe(1);
  });
  it('preserves the previous collection on failure, shows the cause, and clears it after explicit retry', async () => {
    const { app, command, runtime, web } = await setup();
    await command({ type: 'capturePublicResource', resourceId: web.resourceId });
    vi.mocked(runtime.publicResourcesRemove).mockRejectedValueOnce(new Error('资源任务运行中，请先停止回复'));
    const failure = await command({ type: 'removePublicResource', savedResourceId: 'saved' });
    expect(failure.ok).toBe(false);
    expect(failure.snapshot.workspaces[0]!.publicResources).toEqual(collection(1));
    expect(failure.snapshot.workspaces[0]!.publicResourcesError).toContain('请先停止回复');
    expect((await command({ type: 'removePublicResource', savedResourceId: 'saved' })).ok).toBe(true);
    const after = (await app.getSnapshot()).workspaces[0]!;
    expect(after.publicResourcesError).toBeNull();
    expect(after.publicResources?.revision).toBe(2);
  });
  it('does not inherit, rename or operate on TaskFlow public resources in another workspace', async () => {
    const { app, command, runtime, web } = await setup();
    await command({ type: 'capturePublicResource', resourceId: web.resourceId });
    await app.command({ type: 'createWorkspace', commandId: 'other', workspaceId: 'other', name: 'Other' });
    for (const payload of [
      { type: 'capturePublicResource', resourceId: web.resourceId },
      { type: 'removePublicResource', savedResourceId: 'saved' },
    ]) {
      const result = await app.command({ ...payload, commandId: crypto.randomUUID(), workspaceId: 'other' } as WorkbenchCommand);
      expect(result.ok).toBe(false);
      if (!result.ok) expect(result.error.code).toBe('unsupported');
    }
    const snapshot = await app.getSnapshot();
    expect(snapshot.workspaces.find((w) => w.workspaceId === 'other')!.publicResources).toBeNull();
    expect(snapshot.workspaces.find((w) => w.workspaceId === 'taskflow-demo')!.publicResources).toEqual(collection(1));
    expect(runtime.publicResourcesCapture).toHaveBeenCalledOnce();
    expect(runtime.publicResourcesRemove).not.toHaveBeenCalled();
  });
});
