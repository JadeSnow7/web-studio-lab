import { randomUUID } from 'node:crypto';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import type * as FsPromises from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import { expect, it, vi } from 'vitest';
import { WorkbenchApplication } from './application';
import { catalogForTestSnapshot } from './catalog-test-fixture';
import type { WorkbenchRuntime } from './ports';
import { FileWorkbenchRepository } from './repository';

const hooks = vi.hoisted(() => ({ beforeIO: null as null | ((operation: string, file: string) => Promise<void>) }));
vi.mock('node:fs/promises', async (original) => {
  const actual = await original<typeof FsPromises>();
  return {
    ...actual,
    readFile: async (...args: Parameters<typeof actual.readFile>) => {
      await hooks.beforeIO?.('read', String(args[0]));
      return actual.readFile(...args);
    },
    mkdir: async (...args: Parameters<typeof actual.mkdir>) => {
      await hooks.beforeIO?.('mkdir', String(args[0]));
      return actual.mkdir(...args);
    },
  };
});

it.each(['read', 'mkdir'])('freezes nested business and catalog bytes before the first %s await', async (operation) => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'wsl-save-boundary-'));
  let release!: () => void;
  const gate = new Promise<void>((resolve) => {
    release = resolve;
  });
  let entered!: () => void;
  const reached = new Promise<void>((resolve) => {
    entered = resolve;
  });
  let saving: Promise<void> | undefined;
  try {
    const app = new WorkbenchApplication(
      {
        migrationPending: false,
        load: async () => null,
        loadCatalog: catalogForTestSnapshot,
        save: async () => undefined,
        appendObservation: async () => '',
      },
      {} as WorkbenchRuntime,
      () => undefined,
    );
    const snapshot = await app.getSnapshot();
    const workspace = snapshot.workspaces[0]!;
    const projectId = randomUUID();
    workspace.managedApp = {
      workspaceId: workspace.workspaceId,
      projectId,
      environmentId: 'sandbox',
      appInstanceId: null,
      state: 'created',
      url: null,
      guestCwd: '/guest/entry',
      error: null,
      cleanupConfirmed: true,
    };
    const record = {
      request: {
        requestId: randomUUID(),
        workspaceId: workspace.workspaceId,
        sessionId: null,
        runId: null,
        target: {
          workspaceId: workspace.workspaceId,
          environmentId: 'local',
          resourceId: randomUUID(),
          kind: 'file' as const,
          instanceId: randomUUID(),
          instanceGeneration: 0,
        },
        tool: 'files.read' as const,
        args: { path: 'entry.txt' },
      },
      state: 'failed' as const,
      startedAt: new Date().toISOString(),
      endedAt: new Date().toISOString(),
      evidenceRef: null,
      result: { error: 'unavailable' as const, message: 'entry observation' },
    };
    workspace.observations.push(record);
    const catalog = await catalogForTestSnapshot(snapshot);
    const catalogResource = catalog.resources[0]!;
    const entryTitle = catalogResource.title;
    const repository = new FileWorkbenchRepository(path.join(root, 'state.json'));
    if (operation === 'mkdir') {
      await repository.save(snapshot, catalog);
      await repository.load();
    }
    hooks.beforeIO = async (kind, file) => {
      if (kind === operation && file === (operation === 'read' ? path.join(root, 'state.json') : root)) {
        entered();
        await gate;
      }
    };
    saving = repository.save(snapshot, catalog);
    await Promise.race([
      reached,
      saving.then(() => {
        throw new Error('save completed before the first I/O gate');
      }),
    ]);
    record.result.message = 'late observation';
    workspace.managedApp.guestCwd = '/guest/late';
    catalogResource.title = 'late title';
    release();
    await saving;
    hooks.beforeIO = null;
    const stored = JSON.parse(await readFile(path.join(root, 'state.json'), 'utf8'));
    expect(stored.snapshot.workspaces[0].observations[0].result.message).toBe('entry observation');
    expect(stored.snapshot.workspaces[0].managedApp.guestCwd).toBe('/guest/entry');
    expect(stored.catalog.resources[0].title).toBe(entryTitle);
    expect((await repository.load())!.workspaces[0]!.observations[0]!.result).toMatchObject({ message: 'entry observation' });
    expect(record.result.message).toBe('late observation');
    expect(workspace.managedApp.guestCwd).toBe('/guest/late');
    expect(catalogResource.title).toBe('late title');
  } finally {
    release();
    hooks.beforeIO = null;
    await saving?.catch(() => undefined);
    await rm(root, { recursive: true, force: true });
  }
});
