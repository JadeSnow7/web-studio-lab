import { randomUUID } from 'node:crypto';
import { describe, expect, it, vi } from 'vitest';
import type { ManagedApp, WorkbenchCommand } from '@wsl/protocol';
import { WorkbenchApplication } from './application';
import type { WorkbenchRuntime } from './ports';

async function setup() {
  let instance: ManagedApp | null = null;
  const runtime = {
    publicResourcesList: vi.fn().mockResolvedValue({ spaceId: 'taskflow-demo', revision: 0, resources: [] }),
    appCreate: vi.fn(
      async (target) =>
        (instance = {
          ...target,
          environmentId: 'sandbox',
          appInstanceId: null,
          state: 'created',
          url: null,
          guestCwd: '/guest/project',
          error: null,
          cleanupConfirmed: true,
        }),
    ),
    appStart: vi.fn(
      async () =>
        (instance = {
          ...instance!,
          appInstanceId: randomUUID(),
          state: 'running',
          url: 'http://127.0.0.1:49152',
          cleanupConfirmed: false,
        }),
    ),
    appStop: vi.fn(async () => (instance = { ...instance!, state: 'stopped', url: null, cleanupConfirmed: true })),
    appExport: vi.fn(async () => ({ path: '/exports/project', sha256: 'a'.repeat(64) })),
    releaseAppBrowser: vi.fn(),
  } as unknown as WorkbenchRuntime;
  const app = new WorkbenchApplication(
    { load: async () => null, save: async () => undefined, appendObservation: async () => '' },
    runtime,
    vi.fn(),
  );
  await app.getSnapshot();
  const send = (type: 'createApp' | 'startApp' | 'stopApp' | 'exportApp', commandId = randomUUID()) =>
    app.command({ type, commandId, workspaceId: 'taskflow-demo' });
  return { app, runtime, send };
}
describe('managed application ownership', () => {
  it('binds a single project, starts a real browser resource, stops its lease and exports source', async () => {
    const { app, runtime, send } = await setup();
    expect((await send('createApp')).ok).toBe(true);
    expect((await send('createApp')).ok).toBe(false);
    const started = await send('startApp');
    expect(started.ok).toBe(true);
    const w = started.snapshot.workspaces[0]!;
    const resource = w.resources.find((r) => r.appProjectId);
    expect(resource).toMatchObject({
      kind: 'web',
      environmentId: 'sandbox',
      url: w.managedApp!.url,
      appProjectId: w.managedApp!.projectId,
    });
    await send('stopApp');
    expect(runtime.releaseAppBrowser).toHaveBeenCalledWith(resource!.resourceId);
    expect((await app.getSnapshot()).workspaces[0]!.managedApp).toMatchObject({ state: 'stopped', cleanupConfirmed: true });
    await send('exportApp');
    expect((await app.getSnapshot()).workspaces[0]!.appExport?.path).toBe('/exports/project');
  });
  it('deduplicates inflight commands and rejects identity reuse across command types', async () => {
    const { runtime, send } = await setup();
    const id = randomUUID();
    const results = await Promise.all([send('createApp', id), send('createApp', id)]);
    expect(results.every((r) => r.ok)).toBe(true);
    expect(runtime.appCreate).toHaveBeenCalledTimes(1);
    expect((await send('startApp', id)).ok).toBe(false);
  });
  it('allows stop while startup is pending and ignores the late started result', async () => {
    const { app, runtime, send } = await setup();
    await send('createApp');
    let finish!: (app: ManagedApp) => void;
    let entered!: () => void;
    const called = new Promise<void>((resolve) => (entered = resolve));
    runtime.appStart = vi.fn(() => {
      entered();
      return new Promise<ManagedApp>((resolve) => (finish = resolve));
    });
    const pending = send('startApp');
    await called;
    const snapshot = (await app.getSnapshot()).workspaces[0]!.managedApp!;
    await send('stopApp');
    finish({ ...snapshot, state: 'running', appInstanceId: randomUUID(), url: 'http://127.0.0.1:49153' });
    await pending;
    const w = (await app.getSnapshot()).workspaces[0]!;
    expect(w.managedApp?.state).toBe('stopped');
    expect(w.resources.some((r) => r.appProjectId)).toBe(false);
  });
  it('records unexpected exit only for the current app identity', async () => {
    const { app, send } = await setup();
    await send('createApp');
    await send('startApp');
    const current = (await app.getSnapshot()).workspaces[0]!.managedApp!;
    await app.onApp({ ...current, appInstanceId: 'old', state: 'failed', url: null });
    expect((await app.getSnapshot()).workspaces[0]!.managedApp?.state).toBe('running');
    await app.onApp({ ...current, state: 'failed', url: null, error: 'process exited', cleanupConfirmed: true });
    const w = (await app.getSnapshot()).workspaces[0]!;
    expect(w.managedApp?.state).toBe('failed');
    expect(w.resources.find((r) => r.appProjectId)?.unavailableReason).toBe('process exited');
  });
  it('rejects nonexistent workspace before creating any service', async () => {
    const { app, runtime } = await setup();
    const result = await app.command({ type: 'createApp', workspaceId: 'foreign', commandId: randomUUID() } as WorkbenchCommand);
    expect(result.ok).toBe(false);
    expect(runtime.appCreate).not.toHaveBeenCalled();
  });
});

describe('application initialization event race', () => {
  it('does not publish created from an intermediate event while the create command owns completion', async () => {
    const { app, runtime, send } = await setup();
    let finish!: (app: ManagedApp) => void;
    let created!: ManagedApp;
    let entered!: () => void;
    const called = new Promise<void>((resolve) => (entered = resolve));
    runtime.appCreate = vi.fn((target) => {
      created = {
        ...target,
        environmentId: 'sandbox',
        appInstanceId: null,
        state: 'created',
        url: null,
        guestCwd: '/guest/project',
        error: null,
        cleanupConfirmed: false,
      };
      entered();
      return new Promise<ManagedApp>((resolve) => (finish = resolve));
    });
    const pending = send('createApp');
    await called;
    await app.onApp(created);
    expect((await app.getSnapshot()).workspaces[0]!.managedApp?.state).toBe('starting');
    runtime.appStart = vi.fn(async () => ({
      ...created,
      state: 'running' as const,
      appInstanceId: randomUUID(),
      url: 'http://127.0.0.1:49152',
    }));
    finish({ ...created, cleanupConfirmed: true });
    await pending;
    expect((await app.getSnapshot()).workspaces[0]!.managedApp?.state).toBe('created');
    expect((await send('startApp')).ok).toBe(true);
  });
});

it.each(['confirmed', 'unknown', 'wrong-project'] as const)('restores app cleanup from service authority only: %s', async (kind) => {
  const { app, runtime, send } = await setup();
  await send('createApp');
  await send('startApp');
  const saved = structuredClone(await app.getSnapshot());
  const previous = saved.workspaces[0]!.managedApp!;
  runtime.validateBrowserUrl = vi.fn();
  runtime.appGet = vi.fn(async (): Promise<ManagedApp> => ({
    ...previous,
    projectId: kind === 'wrong-project' ? 'other-project' : previous.projectId,
    appInstanceId: null,
    state: kind === 'unknown' ? 'failed' : 'stopped',
    url: null,
    cleanupConfirmed: kind !== 'unknown',
  }));
  const restored = new WorkbenchApplication(
    { load: async () => saved, save: async () => undefined, appendObservation: async () => '' },
    runtime,
    vi.fn(),
  );
  const result = (await restored.getSnapshot()).workspaces[0]!.managedApp!;
  expect(runtime.appGet).toHaveBeenCalledWith({ workspaceId: 'taskflow-demo', projectId: previous.projectId });
  expect(result.cleanupConfirmed).toBe(kind === 'confirmed');
  expect(result.state).toBe(kind === 'confirmed' ? 'stopped' : 'failed');
  expect(result.url).toBeNull();
  expect(runtime.appStart).toHaveBeenCalledTimes(1); // initial run only; recovery never replays
});
