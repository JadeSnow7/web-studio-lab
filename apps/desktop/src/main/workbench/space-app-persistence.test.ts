import { codexHarnessRuntime } from './harness-test-fixture';
import { catalogSha256 } from './resource-catalog';
import { catalogForTestSnapshot } from './catalog-test-fixture';
import { mkdtemp, readFile, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { expect, it, vi } from 'vitest';
import { WorkbenchApplication, validateSnapshot } from './application';
import { FileWorkbenchRepository } from './repository';
import type { WorkbenchRuntime } from './ports';

it.each([1, 2, 3])(
  'migrates v%s with stable App and catalog identities, backs up bytes, then restores v5 metadata',
  async (schemaVersion) => {
    const file = path.join(await mkdtemp(path.join(tmpdir(), 'space-app-')), 'workbench.json');
    const repo = new FileWorkbenchRepository(file);
    const runtime = {
      ...codexHarnessRuntime,
      publicResourcesList: vi.fn().mockResolvedValue({ spaceId: 'taskflow-demo', revision: 0, resources: [] }),
    } as unknown as WorkbenchRuntime;
    const app = new WorkbenchApplication(
      {
        migrationPending: false,
        loadCatalog: catalogForTestSnapshot,
        load: async () => null,
        save: async () => undefined,
        appendObservation: async () => '',
      },
      runtime,
      vi.fn(),
    );
    const snapshot = await app.getSnapshot();
    const w = snapshot.workspaces[0]!;
    const projectId = randomUUID();
    w.managedApp = {
      workspaceId: w.workspaceId,
      projectId,
      environmentId: 'sandbox',
      appInstanceId: null,
      state: 'stopped',
      url: null,
      guestCwd: '/guest/project',
      error: null,
      cleanupConfirmed: true,
    };
    w.resources[0]!.appProjectId = projectId;
    // 旧版本文件不可能有这两个 schema 5 字段；即使出现，迁移也必须显式落为手动标题与空工程选择（OPS-1 R1），而不是沿用。
    w.tabs[0]!.autoTitle = true;
    w.sessions[0]!.taskProject = { appId: projectId, projectId };
    const sourceCatalog = await catalogForTestSnapshot(snapshot);
    const bytes = JSON.stringify({ schemaVersion, snapshot, ...(schemaVersion === 3 ? { catalog: sourceCatalog } : {}) });
    await writeFile(file, bytes);
    const migrated = (await repo.load())!;
    expect((await repo.load())!.workspaces[0]!.app?.appId).toBe(migrated.workspaces[0]!.app?.appId);
    expect(migrated.workspaces[0]!.resources.map(({ catalogResourceId: _catalogResourceId, ...resource }) => resource)).toEqual(
      w.resources.map(({ catalogResourceId: _catalogResourceId, ...resource }) => resource),
    );
    expect(migrated.workspaces[0]!.app).toMatchObject({ workspaceId: w.workspaceId, projectId, name: w.resources[0]!.title });
    expect(migrated.workspaces[0]!.tabs.map((tab) => tab.autoTitle)).toEqual(w.tabs.map(() => false));
    expect(migrated.workspaces[0]!.sessions.map((session) => session.taskProject)).toEqual(w.sessions.map(() => null));
    migrated.workspaces[0]!.app!.description = '保存后说明';
    const catalog = await repo.loadCatalog(migrated);
    for (const binding of catalog.migration?.runtimeBindings ?? []) {
      const resource = migrated.workspaces
        .find((w) => w.workspaceId === binding.workspaceId)
        ?.resources.find((r) => r.resourceId === binding.runtimeResourceId);
      if (resource) resource.catalogResourceId = binding.catalogResourceId;
    }
    await repo.save(migrated, catalog);
    expect(JSON.parse(await readFile(file, 'utf8')).schemaVersion).toBe(5);
    expect(await readFile(file + '.legacy-schema-' + schemaVersion + '.json', 'utf8')).toBe(bytes);
    if (schemaVersion === 3) expect(await repo.loadCatalog(migrated)).toEqual(sourceCatalog);
    expect((await repo.load())!.workspaces[0]!.app).toEqual(migrated.workspaces[0]!.app);
    migrated.workspaces[0]!.app!.workspaceId = 'forged';
    expect(() => validateSnapshot(migrated)).toThrow('App 描述');
  },
);

it('rolls back creation and edits when the repository fails, without invoking runtime create', async () => {
  let fail = false;
  const runtime = {
    ...codexHarnessRuntime,
    publicResourcesList: vi.fn().mockResolvedValue({ spaceId: 'taskflow-demo', revision: 0, resources: [] }),
    appCreate: vi.fn(async (target) => ({
      ...target,
      environmentId: 'sandbox',
      appInstanceId: null,
      state: 'created',
      url: null,
      guestCwd: '/guest/project',
      error: null,
      cleanupConfirmed: true,
    })),
  } as unknown as WorkbenchRuntime;
  const application = new WorkbenchApplication(
    {
      migrationPending: false,
      loadCatalog: catalogForTestSnapshot,
      load: async () => null,
      save: async () => {
        if (fail) throw new Error('disk full');
      },
      appendObservation: async () => '',
    },
    runtime,
    vi.fn(),
  );
  await application.getSnapshot();
  fail = true;
  expect(
    await application.command({
      type: 'createApp',
      commandId: randomUUID(),
      workspaceId: 'taskflow-demo',
      name: '不可保存',
      description: '',
    }),
  ).toMatchObject({ ok: false });
  expect(runtime.appCreate).not.toHaveBeenCalled();
  expect((await application.getSnapshot()).workspaces[0]!.app).toBeNull();
  fail = false;
  const created = await application.command({
    type: 'createApp',
    commandId: randomUUID(),
    workspaceId: 'taskflow-demo',
    name: '原名',
    description: '原说明',
  });
  const owner = created.snapshot.workspaces[0]!.app!;
  fail = true;
  expect(
    await application.command({
      type: 'updateApp',
      commandId: randomUUID(),
      workspaceId: 'taskflow-demo',
      appId: owner.appId,
      expectedAppRevision: 0,
      name: '保存失败',
      description: '',
    }),
  ).toMatchObject({ ok: false });
  expect((await application.getSnapshot()).workspaces[0]!.app).toEqual(owner);
});

it.each([false, true])('migrates the actual catalog-free space-app schema3 shape (App present: %s)', async (hasApp) => {
  const file = path.join(await mkdtemp(path.join(tmpdir(), 'space-app-v3-')), 'workbench.json');
  const application = new WorkbenchApplication(
    {
      migrationPending: false,
      loadCatalog: catalogForTestSnapshot,
      load: async () => null,
      save: async () => undefined,
      appendObservation: async () => '',
    },
    {
      publicResourcesList: vi.fn().mockResolvedValue({ spaceId: 'taskflow-demo', revision: 0, resources: [] }),
    } as unknown as WorkbenchRuntime,
    vi.fn(),
  );
  const snapshot = await application.getSnapshot();
  const workspace = snapshot.workspaces[0]!;
  const projectId = randomUUID();
  if (hasApp) {
    workspace.app = {
      appId: randomUUID(),
      workspaceId: workspace.workspaceId,
      projectId,
      name: '分支已有 App',
      description: '不能丢失的说明',
      revision: 7,
    };
    workspace.managedApp = {
      workspaceId: workspace.workspaceId,
      projectId,
      environmentId: 'sandbox',
      appInstanceId: null,
      state: 'stopped',
      url: null,
      guestCwd: '/guest/project',
      error: null,
      cleanupConfirmed: true,
    };
  }
  const resourceId = randomUUID();
  Object.assign(workspace, {
    publicResources: {
      spaceId: workspace.workspaceId,
      revision: 2,
      resources: [
        {
          spaceId: workspace.workspaceId,
          resourceId,
          version: 4,
          requestedUrl: 'https://example.com/doc',
          url: 'https://example.com/doc',
          title: '旧参考',
          text: 'legacy text',
          capturedAt: '2026-10-10T00:00:00.000Z',
          sourceSha256: catalogSha256('source'),
          contentSha256: catalogSha256('legacy text'),
          truncated: false,
          extractionVersion: 'html-text-v1',
          page: { webContentsId: 1, documentGeneration: 2, url: 'https://example.com/doc', title: '旧参考', partition: 'persist:space' },
        },
      ],
    },
  });
  const bytes = JSON.stringify({ schemaVersion: 3, snapshot });
  await writeFile(file, bytes);
  const repo = new FileWorkbenchRepository(file);
  const migrated = (await repo.load())!;
  expect(migrated.workspaces[0]!.app).toEqual(workspace.app);
  const catalog = await repo.loadCatalog(migrated);
  expect(catalog.resources).toContainEqual(expect.objectContaining({ resourceId, title: '旧参考' }));
  for (const binding of catalog.migration?.runtimeBindings ?? []) {
    migrated.workspaces
      .find((item) => item.workspaceId === binding.workspaceId)!
      .resources.find((item) => item.resourceId === binding.runtimeResourceId)!.catalogResourceId = binding.catalogResourceId;
  }
  await repo.save(migrated, catalog);
  expect(await readFile(file + '.legacy-schema-3.json', 'utf8')).toBe(bytes);
  expect(JSON.parse(await readFile(file, 'utf8')).schemaVersion).toBe(5);
  expect((await new FileWorkbenchRepository(file).load())!.workspaces[0]!.app).toEqual(workspace.app);

  const withoutAppMarkers = { ...snapshot, workspaces: snapshot.workspaces.map(({ app: _app, ...rest }) => rest) };
  await writeFile(file, JSON.stringify({ schemaVersion: 3, snapshot: withoutAppMarkers }));
  await expect(new FileWorkbenchRepository(file).load()).rejects.toThrow();
  await writeFile(file, JSON.stringify({ schemaVersion: 3, snapshot: { ...snapshot, workspaces: [] } }));
  await expect(new FileWorkbenchRepository(file).load()).rejects.toThrow();
  await writeFile(
    file,
    JSON.stringify({ schemaVersion: 3, snapshot: { ...snapshot, workspaces: [{ ...workspace, app: { malformed: true } }] } }),
  );
  await expect(new FileWorkbenchRepository(file).load()).rejects.toThrow();
});
