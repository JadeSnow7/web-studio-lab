import type { SpaceResource } from './legacy-resources';
import { FileWorkbenchRepository } from './repository';
import { mkdtemp, readFile, writeFile, mkdir } from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import { describe, expect, it } from 'vitest';
import { WorkbenchSnapshotSchema } from '@wsl/protocol';
import { createResourceCatalog, catalogSha256 } from './resource-catalog';
import { migrateLegacyCatalog, parseResourceCatalog } from './resource-catalog-repository';

const itemAt = <T>(items: T[], index = 0): T => {
  const item = items[index];
  if (item === undefined) throw new Error('fixture item missing');
  return item;
};
const now = '2026-10-10T00:00:00.000Z';
const legacyResource = (spaceId = 'space-a', resourceId = '10000000-0000-4000-8000-000000000001'): SpaceResource => ({
  spaceId,
  resourceId,
  version: 4,
  requestedUrl: 'https://example.com/doc',
  url: 'https://example.com/doc',
  title: 'doc',
  text: 'legacy text',
  capturedAt: now,
  sourceSha256: catalogSha256('source'),
  contentSha256: catalogSha256('legacy text'),
  truncated: false,
  extractionVersion: 'html-text-v1',
  page: { webContentsId: 1, documentGeneration: 2, url: 'https://example.com/doc', title: 'doc', partition: 'persist:space' },
});
const legacyStore = () => ({
  schemaVersion: 1,
  collections: [
    { spaceId: 'space-a', revision: 2, resources: [legacyResource()] },
    { spaceId: 'space-b', revision: 1, resources: [legacyResource('space-b', '10000000-0000-4000-8000-000000000002')] },
  ],
});
const workbench = () =>
  WorkbenchSnapshotSchema.parse({
    appInstanceId: 'old',
    activeWorkspaceId: 'space-a',
    seq: 0,
    storageError: null,
    workspaces: [
      {
        workspaceId: 'space-a',
        name: 'A',
        revision: 0,
        tabs: [],
        resources: [
          {
            resourceId: 'runtime-web',
            catalogResourceId: 'runtime-web',
            environmentId: 'local',
            kind: 'web',
            title: 'open doc',
            url: 'https://example.com/doc',
            instanceId: 'old-instance',
            generation: 7,
            preview: null,
            terminal: null,
            unavailableReason: null,
          },
          {
            resourceId: 'runtime-session',
            environmentId: null,
            kind: 'session',
            title: 'session',
            url: null,
            instanceId: null,
            generation: 0,
            preview: null,
            terminal: null,
            unavailableReason: null,
          },
        ],
        sessions: [],
        runs: [],
        layout: { kind: 'pane', paneId: 'p', tabId: null },
        activePaneId: 'p',
        theme: 'dark',
      },
    ],
  });

describe('RESOURCE-OWNERSHIP-1 migration/persistence R09', () => {
  it('preserves distinct same-URL IDs, versions/digests/reference, runtime IDs and excludes sessions', () => {
    const source = workbench();
    const state = migrateLegacyCatalog(createResourceCatalog('local'), source, legacyStore(), now);
    expect(state.resources).toHaveLength(3);
    expect(state.library).toEqual([]);
    expect(state.revisions.map(({ version }) => version)).toEqual([4, 4]);
    expect(state.links.filter(({ referenceVersion }) => referenceVersion === 4)).toHaveLength(2);
    expect(state.migration?.runtimeBindings).toEqual([
      { workspaceId: 'space-a', runtimeResourceId: 'runtime-web', catalogResourceId: 'runtime-web' },
    ]);
    expect(state.revisions[0]?.contentSha256).toBe(legacyResource().contentSha256);
    expect(JSON.stringify(state)).not.toContain('old-instance');
    expect(JSON.stringify(source)).toContain('old-instance');
    expect(migrateLegacyCatalog(state, source, legacyStore(), now)).toEqual(state);
  });
  it('imports managed app browsers as project entries without transient preview URL', () => {
    const source = workbench();
    const browser = itemAt(itemAt(source.workspaces).resources);
    browser.appProjectId = '20000000-0000-4000-8000-000000000001';
    browser.url = 'http://127.0.0.1:39211';
    browser.environmentId = 'sandbox';
    const state = migrateLegacyCatalog(createResourceCatalog('local'), source, legacyStore(), now);
    expect(state.resources.find((resource) => resource.resourceId === browser.resourceId)?.descriptor).toEqual({
      kind: 'development',
      entryKind: 'project',
      projectId: browser.appProjectId,
      environmentId: 'sandbox',
      path: null,
    });
    expect(JSON.stringify(state)).not.toContain('39211');
  });
  it('rejects corrupted digests, foreign identity and future schema before returning a migrated state', () => {
    const state = createResourceCatalog('local');
    for (const store of [
      { schemaVersion: 99, collections: [] },
      { schemaVersion: 1, collections: [{ spaceId: 'wrong', revision: 0, resources: [legacyResource()] }] },
      {
        schemaVersion: 1,
        collections: [{ spaceId: 'space-a', revision: 0, resources: [{ ...legacyResource(), contentSha256: catalogSha256('wrong') }] }],
      },
    ])
      expect(() => migrateLegacyCatalog(state, null, store, now)).toThrow();
    expect(state.resources).toEqual([]);
    expect(state.migration).toBeNull();
  });
  it('atomically commits catalog and migration marker, restarts without reading legacy again', async () => {
    const directory = await mkdtemp(path.join(os.tmpdir(), 'catalog-'));
    const file = path.join(directory, 'catalog.json');
    await mkdir(path.join(directory, 'chat'));
    const legacy = path.join(directory, 'chat', 'space-resources.json');
    const bytes = JSON.stringify(legacyStore());
    await writeFile(legacy, bytes);
    const repository = new FileWorkbenchRepository(file);
    const state = await repository.loadCatalog(workbench());
    await repository.save(workbench(), state);
    expect(await readFile(legacy, 'utf8')).toBe(bytes);
    await writeFile(legacy, 'corrupt after migration');
    expect(await new FileWorkbenchRepository(file).loadCatalog(workbench())).toEqual(state);
    expect((await repository.loadCatalog(workbench())).migration).not.toBeNull();
  });
  it('rejects persisted source tampering even when outer text digest remains valid', async () => {
    const state = migrateLegacyCatalog(createResourceCatalog('local'), workbench(), legacyStore(), now);
    const revision = state.revisions[0];
    if (!revision || revision.evidence.kind !== 'web') throw new Error('fixture missing webpage');
    revision.evidence.snapshot.url = 'https://foreign.example/';
    revision.evidence.snapshot.page.url = 'https://foreign.example/';
    expect(() => parseResourceCatalog(state)).toThrow();
    const directory = await mkdtemp(path.join(os.tmpdir(), 'catalog-tamper-'));
    const file = path.join(directory, 'workbench.json');
    const bytes = JSON.stringify({ schemaVersion: 3, snapshot: workbench(), catalog: state });
    await writeFile(file, bytes);
    await expect(new FileWorkbenchRepository(file).load()).rejects.toThrow();
    expect(await readFile(file, 'utf8')).toBe(bytes);
  });
  it.each(['missing-resource', 'missing-link'] as const)('rejects corrupt schema3 runtime association: %s', async (kind) => {
    const state = migrateLegacyCatalog(createResourceCatalog('local'), workbench(), legacyStore(), now);
    const source = workbench();
    if (kind === 'missing-resource') itemAt(itemAt(source.workspaces).resources).catalogResourceId = 'absent';
    else state.links = state.links.filter((link) => link.resourceId !== 'runtime-web');
    const directory = await mkdtemp(path.join(os.tmpdir(), 'catalog-binding-'));
    const file = path.join(directory, 'workbench.json');
    const bytes = JSON.stringify({ schemaVersion: 3, snapshot: source, catalog: state });
    await writeFile(file, bytes);
    await expect(new FileWorkbenchRepository(file).load()).rejects.toThrow('运行绑定');
    expect(await readFile(file, 'utf8')).toBe(bytes);
  });
  it('preserves old workbench bytes in a read-only migration backup before schema3 commit', async () => {
    const directory = await mkdtemp(path.join(os.tmpdir(), 'catalog-backup-'));
    const file = path.join(directory, 'workbench.json');
    const bytes = JSON.stringify({ schemaVersion: 2, snapshot: workbench() }, null, 2);
    await writeFile(file, bytes);
    const repository = new FileWorkbenchRepository(file);
    const state = await repository.loadCatalog(workbench());
    await repository.save(workbench(), state);
    expect(await readFile(file + '.legacy-schema-2.json', 'utf8')).toBe(bytes);
    expect(JSON.parse(await readFile(file, 'utf8')).schemaVersion).toBe(3);
  });
  it('preserves corrupt/future destination bytes and legacy bytes on initialization/save failure', async () => {
    const directory = await mkdtemp(path.join(os.tmpdir(), 'catalog-fail-'));
    const file = path.join(directory, 'catalog.json');
    const repository = new FileWorkbenchRepository(file);
    for (const bytes of ['broken', 'null', '{"schemaVersion":99}']) {
      await writeFile(file, bytes);
      await expect(repository.loadCatalog(workbench())).rejects.toThrow();
      expect(await readFile(file, 'utf8')).toBe(bytes);
    }
    const blocked = path.join(directory, 'blocked');
    await mkdir(blocked);
    const legacy = path.join(directory, 'legacy.json');
    const bytes = JSON.stringify(legacyStore());
    await writeFile(legacy, bytes);
    await expect(
      new FileWorkbenchRepository(blocked).save(workbench(), migrateLegacyCatalog(createResourceCatalog('a'), null, legacyStore(), now)),
    ).rejects.toThrow();
    expect(await readFile(legacy, 'utf8')).toBe(bytes);
  });
  it('preserves the committed file when a complete schema3 candidate is invalid', async () => {
    const directory = await mkdtemp(path.join(os.tmpdir(), 'catalog-invalid-save-'));
    const file = path.join(directory, 'workbench.json');
    const repository = new FileWorkbenchRepository(file);
    const state = migrateLegacyCatalog(createResourceCatalog('local'), workbench(), legacyStore(), now);
    await repository.save(workbench(), state);
    const bytes = await readFile(file, 'utf8');
    const candidate = workbench();
    itemAt(candidate.workspaces).tabs.push({
      tabId: 'invalid',
      title: 'x'.repeat(201),
      pinned: false,
      group: null,
      targetRef: { kind: 'web', resourceId: 'runtime-web' },
    });
    await expect(repository.save(candidate, state)).rejects.toThrow();
    expect(await readFile(file, 'utf8')).toBe(bytes);
    expect(await new FileWorkbenchRepository(file).load()).not.toBeNull();
  });
  it('refuses a conflicting immutable legacy backup and keeps both sources untouched', async () => {
    const directory = await mkdtemp(path.join(os.tmpdir(), 'catalog-conflict-backup-'));
    const file = path.join(directory, 'workbench.json');
    const bytes = JSON.stringify({ schemaVersion: 2, snapshot: workbench() });
    await writeFile(file, bytes);
    await writeFile(file + '.legacy-schema-2.json', 'another legacy source');
    const repository = new FileWorkbenchRepository(file);
    const source = await repository.load();
    const state = await repository.loadCatalog(source);
    if (!source) throw new Error('fixture');
    for (const binding of state.migration!.runtimeBindings)
      itemAt(itemAt(source.workspaces).resources).catalogResourceId = binding.catalogResourceId;
    await expect(repository.save(source, state)).rejects.toThrow('备份');
    expect(await readFile(file, 'utf8')).toBe(bytes);
    expect(await readFile(file + '.legacy-schema-2.json', 'utf8')).toBe('another legacy source');
  });
});
