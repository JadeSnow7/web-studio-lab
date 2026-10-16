import { randomUUID } from 'node:crypto';
import { describe, expect, it, vi } from 'vitest';
import type { AppImportOutcome, AppTarget, EduImport, ManagedApp, WorkbenchCommand, WorkbenchSnapshot } from '@wsl/protocol';
import { WorkbenchApplication } from './application';
import { catalogForTestSnapshot } from './catalog-test-fixture';
import type { AppImportSelection, WorkbenchRuntime } from './ports';

const source: Pick<EduImport, 'source' | 'files'> = {
  source: {
    repository: { commit: 'a'.repeat(40), dirty: true },
    sourceSha256: 'b'.repeat(64),
    files: [{ path: 'server/app.py', bytes: 4, sha256: 'c'.repeat(64) }],
  },
  files: [{ path: 'server/app.py', base64: 'dGVzdA==' }],
};
function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((done) => {
    resolve = done;
  });
  return { promise, resolve };
}
async function fixture(saved: WorkbenchSnapshot | null = null) {
  let instance: ManagedApp | null = saved?.workspaces[0]?.managedApp ?? null;
  let durable: WorkbenchSnapshot | null = saved;
  const selected: AppImportSelection = {
    ...structuredClone(source),
    preview: {
      name: 'edu-web',
      profile: 'edu-web',
      profileVersion: 1,
      repository: source.source.repository,
      sourceSha256: source.source.sourceSha256,
      fileCount: 1,
      totalBytes: 4,
      warnings: [],
    },
    revalidate: vi.fn(async () => structuredClone(source)),
  };
  const runtime = {
    appSelectImportSource: vi.fn(async () => selected),
    appImportSource: vi.fn(
      async (target: AppTarget, _input: Pick<EduImport, 'source' | 'files'>, _operationId: string): Promise<AppImportOutcome> => {
        instance = {
          ...target,
          profile: { projectKind: 'edu-web', profileVersion: 1, source: source.source },
          sourceSha256: source.source.sourceSha256,
          environmentId: 'sandbox',
          appInstanceId: null,
          state: 'created',
          url: null,
          guestCwd: '/guest/owned',
          error: null,
          cleanupConfirmed: true,
        };
        return { app: instance, outcome: 'imported', retryable: false, errorCode: null };
      },
    ),
    appCancelImport: vi.fn(async (): Promise<AppImportOutcome> => ({ app: null, outcome: 'cancelled', retryable: false, errorCode: null })),
    appStart: vi.fn(
      async (): Promise<ManagedApp> =>
        (instance = {
          ...instance!,
          appInstanceId: randomUUID(),
          state: 'running',
          url: 'http://127.0.0.1:49152',
          cleanupConfirmed: false,
        }),
    ),
    appStop: vi.fn(async (): Promise<ManagedApp> => (instance = { ...instance!, state: 'stopped', url: null, cleanupConfirmed: true })),
    appGet: vi.fn(async () => ({ ...instance!, state: 'failed', url: null })),
    ensureBrowser: vi.fn(),
    browserState: vi.fn(() => null),
    browserLayout: vi.fn(),
    browserAction: vi.fn(async () => undefined),
    releaseAppBrowser: vi.fn(),
    hideBrowsers: vi.fn(),
    validateBrowserUrl: vi.fn(),
  };
  const save = vi.fn(async (snapshot: WorkbenchSnapshot) => {
    durable = structuredClone(snapshot);
  });
  const app = new WorkbenchApplication(
    { migrationPending: false, loadCatalog: catalogForTestSnapshot, load: async () => saved, save, appendObservation: async () => '' },
    runtime as unknown as WorkbenchRuntime,
    vi.fn(),
  );
  await app.getSnapshot();
  save.mockClear();
  const workspace = async () => (await app.getSnapshot()).workspaces[0]!;
  const preview = async () => {
    await app.command({ type: 'previewAppImport', commandId: randomUUID(), workspaceId: 'taskflow-demo' });
    return (await workspace()).appImport!;
  };
  const send = async (type: 'confirmAppImport' | 'cancelAppImport' | 'retryAppImport') => {
    const view = (await workspace()).appImport!;
    return app.command({
      type,
      commandId: randomUUID(),
      workspaceId: 'taskflow-demo',
      previewId: view.previewId,
      ...(type === 'confirmAppImport' ? { sourceSha256: view.preview!.sourceSha256 } : {}),
    } as WorkbenchCommand);
  };
  return { app, runtime, selected, save, workspace, preview, send, durable: () => durable };
}

describe('two phase source import ownership', () => {
  it('previews without guest or persistence and successful import does not focus the browser', async () => {
    const f = await fixture();
    const before = await f.workspace();
    const view = await f.preview();
    expect(view).toMatchObject({ phase: 'ready', published: false, projectId: null });
    expect(f.runtime.appImportSource).not.toHaveBeenCalled();
    expect(f.save).not.toHaveBeenCalled();
    expect((await f.send('confirmAppImport')).ok).toBe(true);
    const after = await f.workspace();
    expect(after.appImport?.phase).toBe('completed');
    expect(after.layout).toEqual(before.layout);
    expect(f.runtime.ensureBrowser).toHaveBeenCalled();
    expect(f.runtime.browserAction).not.toHaveBeenCalled();
    expect(f.durable()?.workspaces[0]?.appImport).toBeUndefined();
    expect(JSON.stringify(f.durable())).not.toContain('dGVzdA==');
  });
  it('binds confirmation to preview, workspace and fresh source bytes', async () => {
    const f = await fixture();
    const old = await f.preview();
    const current = await f.preview();
    for (const [workspaceId, previewId, sourceSha256] of [
      ['taskflow-demo', old.previewId, old.preview!.sourceSha256],
      ['other', current.previewId, current.preview!.sourceSha256],
      ['taskflow-demo', current.previewId, '0'.repeat(64)],
    ])
      expect(
        (
          await f.app.command({
            type: 'confirmAppImport',
            commandId: randomUUID(),
            workspaceId: workspaceId!,
            previewId: previewId!,
            sourceSha256: sourceSha256!,
          })
        ).ok,
      ).toBe(false);
    vi.mocked(f.selected.revalidate).mockResolvedValueOnce({ ...source, files: [{ path: 'server/app.py', base64: 'Y2hhbmdlZA==' }] });
    expect((await f.send('confirmAppImport')).ok).toBe(false);
    expect((await f.workspace()).appImport?.error?.code).toBe('source_changed');
    expect(f.runtime.appImportSource).not.toHaveBeenCalled();
    expect((await f.workspace()).managedApp).toBeFalsy();
  });
  it('coalesces different command IDs confirming the same preview into one copy and start', async () => {
    const f = await fixture();
    await f.preview();
    const gate = deferred<Pick<EduImport, 'source' | 'files'>>();
    vi.mocked(f.selected.revalidate).mockReturnValueOnce(gate.promise);
    const first = f.send('confirmAppImport');
    const second = f.send('confirmAppImport');
    await vi.waitFor(() => expect(f.selected.revalidate).toHaveBeenCalledTimes(1));
    gate.resolve(source);
    expect((await Promise.all([first, second])).every((result) => result.ok)).toBe(true);
    expect(f.runtime.appImportSource).toHaveBeenCalledTimes(1);
    expect(f.runtime.appStart).toHaveBeenCalledTimes(1);
  });
  it('rolls back an initial save rejection before guest dispatch and retries with the reserved identity', async () => {
    const f = await fixture();
    await f.preview();
    const revision = (await f.workspace()).revision;
    f.save.mockRejectedValueOnce(new Error('/private/secret failure'));
    expect((await f.send('confirmAppImport')).ok).toBe(false);
    const failed = await f.workspace();
    const project = failed.appImport!.projectId;
    expect(failed.managedApp).toBeFalsy();
    expect(failed.app).toBeFalsy();
    expect(failed.pendingAppImport).toBeFalsy();
    expect(failed.revision).toBe(revision);
    expect(failed.appImport).toMatchObject({ canCancel: true, canRetry: true });
    expect(f.runtime.appImportSource).not.toHaveBeenCalled();
    expect(JSON.stringify(failed.appImport)).not.toContain('/private/secret');
    expect((await f.send('retryAppImport')).ok).toBe(true);
    expect((await f.workspace()).managedApp?.projectId).toBe(project);
  });
  it('can discard an unsaved reservation and select again without guest effects', async () => {
    const f = await fixture();
    const old = await f.preview();
    f.save.mockRejectedValueOnce(new Error('disk unavailable'));
    expect((await f.send('confirmAppImport')).ok).toBe(false);
    expect((await f.send('cancelAppImport')).ok).toBe(true);
    expect((await f.workspace()).appImport).toMatchObject({ phase: 'cancelled', projectId: null, published: false });
    expect((await f.preview()).previewId).not.toBe(old.previewId);
    expect(f.runtime.appImportSource).not.toHaveBeenCalled();
    expect(f.runtime.appStart).not.toHaveBeenCalled();
  });
  it('reports service failure and retries the same project and import operation', async () => {
    const f = await fixture();
    const view = await f.preview();
    f.runtime.appImportSource.mockResolvedValueOnce({
      app: null,
      outcome: 'failed',
      retryable: true,
      errorCode: 'import_runtime_unavailable',
    });
    expect((await f.send('confirmAppImport')).ok).toBe(false);
    expect(f.runtime.appStart).not.toHaveBeenCalled();
    const project = (await f.workspace()).managedApp!.projectId;
    expect((await f.send('retryAppImport')).ok).toBe(true);
    expect(f.runtime.appImportSource.mock.calls.map((call) => call[0].projectId)).toEqual([project, project]);
    expect(f.runtime.appImportSource.mock.calls.map((call) => call[2])).toEqual([view.previewId, view.previewId]);
    expect((await f.workspace()).appImport?.previewId).toBe(view.previewId);
  });
  it('waits for the copy and cancellation receipt before clearing an unpublished binding', async () => {
    const f = await fixture();
    await f.preview();
    const copy = deferred<AppImportOutcome>();
    const cancelled = deferred<AppImportOutcome>();
    f.runtime.appImportSource.mockReturnValueOnce(copy.promise);
    f.runtime.appCancelImport.mockReturnValueOnce(cancelled.promise);
    const confirmation = f.send('confirmAppImport');
    await vi.waitFor(() => expect(f.runtime.appImportSource).toHaveBeenCalled());
    const cancellation = f.send('cancelAppImport');
    let settled = false;
    void cancellation.then(() => {
      settled = true;
    });
    await vi.waitFor(() => expect(f.runtime.appCancelImport).toHaveBeenCalled());
    cancelled.resolve({ app: null, outcome: 'cancelled', retryable: false, errorCode: null });
    await Promise.resolve();
    expect(settled).toBe(false);
    expect((await f.workspace()).managedApp).toBeTruthy();
    copy.resolve({ app: null, outcome: 'cancelled', retryable: false, errorCode: null });
    await confirmation;
    expect((await cancellation).ok).toBe(true);
    expect((await f.workspace()).managedApp).toBeNull();
    expect((await f.workspace()).appImport).toMatchObject({ phase: 'cancelled', published: false, canRetry: false });
    expect(f.runtime.appStart).not.toHaveBeenCalled();
    expect(f.runtime.appStop).not.toHaveBeenCalled();
  });
  it('gives a cancellation arriving before confirmation priority with no guest effects', async () => {
    const f = await fixture();
    const view = await f.preview();
    const cancel = f.app.command({
      type: 'cancelAppImport',
      commandId: randomUUID(),
      workspaceId: 'taskflow-demo',
      previewId: view.previewId,
    });
    const confirm = f.app.command({
      type: 'confirmAppImport',
      commandId: randomUUID(),
      workspaceId: 'taskflow-demo',
      previewId: view.previewId,
      sourceSha256: view.preview!.sourceSha256,
    });
    expect((await confirm).ok).toBe(false);
    expect((await cancel).ok).toBe(true);
    expect(f.runtime.appImportSource).not.toHaveBeenCalled();
    expect(f.runtime.appStart).not.toHaveBeenCalled();
  });
  it('can cancel after publication save failed, then retry starts the retained project without copying again', async () => {
    const f = await fixture();
    await f.preview();
    let rejected = false;
    const save = f.save.getMockImplementation()!;
    f.save.mockImplementation(async (snapshot) => {
      if (!rejected && snapshot.workspaces[0]?.managedApp?.state === 'created') {
        rejected = true;
        throw new Error('disk unavailable');
      }
      await save(snapshot);
    });
    expect((await f.send('confirmAppImport')).ok).toBe(false);
    const project = (await f.workspace()).managedApp!.projectId;
    expect((await f.workspace()).appImport?.published).toBe(true);
    expect((await f.workspace()).pendingAppImport).toBeTruthy();
    expect((await f.send('cancelAppImport')).ok).toBe(true);
    expect((await f.workspace()).pendingAppImport).toBeNull();
    expect((await f.workspace()).managedApp).toMatchObject({ projectId: project, state: 'stopped', cleanupConfirmed: true });
    expect((await f.send('retryAppImport')).ok).toBe(true);
    expect(f.runtime.appImportSource).toHaveBeenCalledTimes(1);
    expect(f.runtime.appStart).toHaveBeenCalledTimes(1);
  });
  it('retains a copy published during cancellation and never replays its old receipt over a later stop', async () => {
    const f = await fixture();
    await f.preview();
    const entered = deferred<void>();
    const copy = deferred<AppImportOutcome>();
    const importer = f.runtime.appImportSource.getMockImplementation()!;
    let published!: AppImportOutcome;
    f.runtime.appImportSource.mockImplementationOnce(async (...args) => {
      published = await importer(...args);
      entered.resolve();
      return copy.promise;
    });
    f.runtime.appCancelImport.mockImplementationOnce(async () => published);
    const confirming = f.send('confirmAppImport');
    await entered.promise;
    const save = f.save.getMockImplementation()!;
    let rejected = false;
    f.save.mockImplementation(async (snapshot) => {
      if (!rejected && snapshot.workspaces[0]?.managedApp?.state === 'created') {
        rejected = true;
        throw new Error('disk unavailable');
      }
      await save(snapshot);
    });
    const cancelling = f.send('cancelAppImport');
    await vi.waitFor(() => expect(f.runtime.appCancelImport).toHaveBeenCalled());
    copy.resolve(published);
    await confirming;
    expect((await cancelling).ok).toBe(false);
    expect((await f.workspace()).appImport).toMatchObject({ published: true, canCancel: true });
    expect(f.runtime.appStart).not.toHaveBeenCalled();
    expect((await f.send('cancelAppImport')).ok).toBe(true);
    expect((await f.workspace()).managedApp).toMatchObject({ state: 'stopped', cleanupConfirmed: true });
    expect(f.runtime.appCancelImport).toHaveBeenCalledTimes(1);
    expect((await f.send('retryAppImport')).ok).toBe(true);
    expect(f.runtime.appImportSource).toHaveBeenCalledTimes(1);
  });
  it('treats failed start as failed even when the runtime resolved normally', async () => {
    const f = await fixture();
    await f.preview();
    f.runtime.appStart.mockImplementationOnce(async () => ({
      ...(await f.workspace()).managedApp!,
      state: 'failed',
      error: 'startup failed',
      cleanupConfirmed: true,
    }));
    expect((await f.send('confirmAppImport')).ok).toBe(false);
    expect((await f.workspace()).appImport).toMatchObject({
      phase: 'failed',
      published: true,
      canRetry: true,
      error: { code: 'start_failed' },
    });
  });
  it('does not claim cancellation or allow retry while stopping the published app is unconfirmed', async () => {
    const f = await fixture();
    await f.preview();
    f.runtime.appStart.mockImplementationOnce(async () => ({
      ...(await f.workspace()).managedApp!,
      state: 'failed',
      cleanupConfirmed: true,
    }));
    expect((await f.send('confirmAppImport')).ok).toBe(false);
    f.runtime.appStop.mockImplementationOnce(async () => ({
      ...(await f.workspace()).managedApp!,
      state: 'stopped',
      cleanupConfirmed: false,
    }));
    expect((await f.send('cancelAppImport')).ok).toBe(false);
    expect((await f.workspace()).appImport).toMatchObject({ phase: 'failed', published: true, canCancel: true, canRetry: false });
    expect((await f.send('retryAppImport')).ok).toBe(false);
    expect((await f.send('cancelAppImport')).ok).toBe(true);
    expect((await f.workspace()).appImport?.phase).toBe('cancelled');
  });
  it('recovers an uncertain copy after desktop restart without allowing a normal start to bypass it', async () => {
    const f = await fixture();
    await f.preview();
    f.runtime.appImportSource.mockResolvedValueOnce({
      app: null,
      outcome: 'failed',
      retryable: false,
      errorCode: 'import_cleanup_unknown',
    });
    expect((await f.send('confirmAppImport')).ok).toBe(false);
    const restarted = await fixture(structuredClone(f.durable()!));
    const recovered = await restarted.workspace();
    expect(recovered.appImport).toMatchObject({ phase: 'failed', canCancel: true, canRetry: false });
    expect((await restarted.app.command({ type: 'startApp', commandId: randomUUID(), workspaceId: recovered.workspaceId })).ok).toBe(false);
    expect(restarted.runtime.appStart).not.toHaveBeenCalled();
    expect((await restarted.send('cancelAppImport')).ok).toBe(true);
    expect((await restarted.workspace()).managedApp).toBeNull();
    expect((await restarted.workspace()).pendingAppImport).toBeNull();
  });
});
