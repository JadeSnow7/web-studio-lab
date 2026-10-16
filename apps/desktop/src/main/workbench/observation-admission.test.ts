import { catalogForTestSnapshot } from './catalog-test-fixture';
import { randomUUID } from 'node:crypto';
import { describe, it, expect, vi } from 'vitest';
import type { WorkbenchRuntime } from './ports';
import type { WorkbenchRepository } from './repository';
import { WorkbenchApplication } from './application';
import type { WorkbenchSnapshot, ObservationRequest, ObservationResult, WorkbenchCommand } from '@wsl/protocol';
async function setup() {
  const archived: unknown[] = [];
  const repository: WorkbenchRepository = {
    migrationPending: false,
    loadCatalog: catalogForTestSnapshot,
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
    releaseResource: vi.fn(),
    observe: vi.fn(async (request) => result(request)),
    registerSession: vi.fn(),
    captureResource: vi.fn(),
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
    app.command({
      workspaceId,
      commandId: randomUUID(),
      ...payload,
    } as WorkbenchCommand);
  const file = async (workspaceId = 'taskflow-demo', environmentId = 'local') => {
    expect(
      (
        await command(workspaceId, {
          type: 'createTab',
          kind: 'file',
          environmentId,
        })
      ).ok,
    ).toBe(true);
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
    data: {
      text: '内容',
      encoding: 'utf-8',
      contentSha256: 'hash',
      hashScope: 'whole_file',
    },
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

describe('candidate10 isolation and local rollback', () => {
  it('requires distinct pending/completed snapshots at the same seq', async () => {
    const { app, runtime, file, emit, archived } = await setup();
    const resource = await file();
    let grant!: (value: ObservationResult) => void;
    vi.mocked(runtime.observe).mockImplementationOnce(
      () =>
        new Promise((resolve) => {
          grant = resolve;
        }),
    );
    const work = app.observe(input(resource.resourceId));
    await vi.waitFor(() => expect(runtime.observe).toHaveBeenCalledOnce());
    const pending = (
      vi.mocked(emit).mock.calls.at(-1)![0] as {
        snapshot: Awaited<ReturnType<typeof app.getSnapshot>>;
      }
    ).snapshot;
    const returned = await app.getSnapshot();
    returned.workspaces[0]!.observations[0]!.request.args['path'] = 'getter-mutated';
    expect((await app.getSnapshot()).workspaces[0]!.observations[0]!.request.args['path']).toBe('note.txt');
    grant(result(vi.mocked(runtime.observe).mock.calls[0]![0]));
    expect(await work).not.toHaveProperty('error');
    const completed = (vi.mocked(emit).mock.calls.at(-1)![0] as { snapshot: typeof pending }).snapshot;
    expect(completed.seq).toBe(pending.seq);
    expect(completed).not.toBe(pending);
    expect(pending.workspaces[0]!.observations[0]!.state).toBe('pending');
    expect(completed.workspaces[0]!.observations[0]!.state).toBe('completed');
    expect(completed.workspaces[0]!.observations[0]!.evidenceRef).toBeTruthy();
    completed.workspaces[0]!.observations[0]!.request.args['path'] = 'event-mutated';
    expect((await app.getSnapshot()).workspaces[0]!.observations[0]!.request.args['path']).toBe('note.txt');
    expect(archived[0]).toMatchObject({
      state: 'completed',
      request: { args: { path: 'note.txt' } },
    });
  });
  it('isolates catalog arrays and nested links across getters', async () => {
    const { app } = await setup();
    const first = await app.getSnapshot();
    const before = structuredClone(first);
    expect(first.catalog!.links.length).toBeGreaterThan(0);
    first.catalog!.links[0]!.workspaceId = 'getter-mutated';
    const second = await app.getSnapshot();
    expect(second).toEqual(before);
    expect(second.catalog!.links).not.toBe(first.catalog!.links);
    expect(second.catalog!.library).not.toBe(first.catalog!.library);
  });
  it('preserves full pre-admission resource identity/history on failed save', async () => {
    const { app, repository, runtime, file, emit, archived } = await setup();
    const resource = await file();
    const before = await app.getSnapshot();
    const count = vi.mocked(emit).mock.calls.length;
    vi.mocked(repository.save).mockRejectedValueOnce(new Error('candidate07 disk full'));
    expect(await app.observe(input(resource.resourceId))).toMatchObject({
      error: 'unavailable',
    });
    const after = await app.getSnapshot();
    expect(after.storageError).toContain('candidate07 disk full');
    expect({ ...after, storageError: before.storageError }).toEqual(before);
    expect(runtime.observe).not.toHaveBeenCalled();
    expect(archived).toHaveLength(0);
    expect(emit).toHaveBeenCalledTimes(count);
  });
});

describe('candidate10 exact admission write-set', () => {
  it('keeps both public state copies but does not deep-copy the full snapshot for admission rollback', async () => {
    const { app, file } = await setup();
    const resource = await file();
    const internal = (app as unknown as { snapshot: WorkbenchSnapshot }).snapshot;
    const clone = vi.spyOn(globalThis, 'structuredClone');
    try {
      expect(await app.observe(input(resource.resourceId))).not.toHaveProperty('error');
      expect(clone.mock.calls.filter(([value]) => value === internal)).toHaveLength(2);
    } finally {
      clone.mockRestore();
    }
  });
  it('restores the evicted slot, file identity and all other workspace/session histories after save rejection', async () => {
    const { app, file, repository, runtime, command } = await setup();
    const resource = await file();
    await command('other', { type: 'createWorkspace', name: 'Other' });
    await file('other');
    const internal = (app as unknown as { snapshot: WorkbenchSnapshot }).snapshot;
    const target = internal.workspaces.find((w) => w.workspaceId === 'taskflow-demo')!;
    const session = target.sessions[0]!;
    const history = Array.from({ length: 200 }, () => ({
      request: {
        requestId: randomUUID(),
        workspaceId: 'taskflow-demo',
        sessionId: session.sessionId,
        runId: null,
        target: {
          workspaceId: 'taskflow-demo',
          environmentId: 'local',
          resourceId: resource.resourceId,
          kind: 'file' as const,
          instanceId: randomUUID(),
          instanceGeneration: 1,
        },
        tool: 'files.read' as const,
        args: { path: 'note.txt' },
      },
      state: 'completed' as const,
      startedAt: '2026-10-14T00:00:00.000Z',
      endedAt: '2026-10-14T00:00:00.001Z',
      result: null,
      evidenceRef: 'prior',
    }));
    session.observations = history;
    const raw = target.resources.find((r) => r.resourceId === resource.resourceId)!;
    raw.instanceId = null;
    const before = await app.getSnapshot();
    vi.mocked(repository.save).mockRejectedValueOnce(new Error('undo slot failed'));
    expect(await app.observe(input(resource.resourceId, 'taskflow-demo', session.sessionId))).toMatchObject({ error: 'unavailable' });
    const after = await app.getSnapshot();
    expect({ ...after, storageError: before.storageError }).toEqual(before);
    expect(runtime.observe).not.toHaveBeenCalled();
  });
  it('restores catalog bindings, append arrays and revision when binding persistence fails', async () => {
    const { app, file, repository, runtime, command } = await setup();
    const resource = await file();
    await command('other', { type: 'createWorkspace', name: 'Other' });
    const other = await file('other');
    const internal = (app as unknown as { snapshot: WorkbenchSnapshot }).snapshot;
    delete internal.workspaces.find((w) => w.workspaceId === 'other')!.resources.find((r) => r.resourceId === other.resourceId)!
      .catalogResourceId;
    const before = await app.getSnapshot();
    vi.mocked(repository.save).mockRejectedValueOnce(new Error('catalog persistence failed'));
    expect(await app.observe(input(resource.resourceId))).toMatchObject({
      error: 'unavailable',
    });
    const after = await app.getSnapshot();
    expect({ ...after, storageError: before.storageError }).toEqual(before);
    expect(runtime.observe).not.toHaveBeenCalled();
  });
});
