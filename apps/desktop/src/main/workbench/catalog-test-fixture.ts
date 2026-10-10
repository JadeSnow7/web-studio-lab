import type { ResourceCatalogState, WorkbenchSnapshot } from '@wsl/protocol';
import { createResourceCatalog } from './resource-catalog';
import { migrateLegacyCatalog } from './resource-catalog-repository';

// Existing in-memory repository fixtures restore the same catalogue identity as their saved projection.
export async function catalogForTestSnapshot(snapshot: WorkbenchSnapshot | null): Promise<ResourceCatalogState> {
  if (snapshot?.catalog) {
    return {
      ...createResourceCatalog(snapshot.catalog.accountId),
      revision: snapshot.catalog.revision,
      resources: snapshot.catalog.resources.map(({ latestVersion: _latestVersion, versions: _versions, ...resource }) => resource),
      library: snapshot.catalog.library,
      links: snapshot.catalog.links,
      revisions: snapshot.workspaces.flatMap((workspace) => workspace.runs.flatMap((run) => run.referenceSnapshot?.resources ?? [])),
    };
  }
  const catalog = migrateLegacyCatalog(
    createResourceCatalog('test-account'),
    snapshot,
    { schemaVersion: 1, collections: [] },
    '2026-10-10T00:00:00.000Z',
  );
  for (const workspace of snapshot?.workspaces ?? [])
    for (const resource of workspace.resources) if (resource.kind !== 'session') resource.catalogResourceId = resource.resourceId;
  return catalog;
}
