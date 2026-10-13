import { ResourceCollectionSchema } from './legacy-resources';
import { z } from 'zod';
import {
  PageResourceSnapshotSchema,
  ResourceCatalogStateSchema,
  WorkbenchSnapshotSchema,
  WorkspaceSnapshotSchema,
  type ResourceCatalogState,
  type ResourceDescriptor,
} from '@wsl/protocol';
import { assertResourceDigest, assertRevisionSource } from './resource-catalog';

export const LegacyWorkspaceSnapshotSchema = WorkspaceSnapshotSchema.extend({
  publicResources: ResourceCollectionSchema.nullable().optional(),
  publicResourcesError: z.string().nullable().optional(),
});
export const LegacyWorkbenchSnapshotSchema = WorkbenchSnapshotSchema.extend({ workspaces: z.array(LegacyWorkspaceSnapshotSchema) });
const LegacyStoreSchema = z
  .object({ schemaVersion: z.literal(1), collections: z.array(ResourceCollectionSchema) })
  .strict()
  .refine(
    (store) => new Set(store.collections.map((collection) => collection.spaceId)).size === store.collections.length,
    '旧空间身份重复',
  );
export function parseResourceCatalog(input: unknown): ResourceCatalogState {
  const state = ResourceCatalogStateSchema.parse(input);
  for (const revision of state.revisions) {
    assertResourceDigest(revision);
    const resource = state.resources.find((resource) => resource.resourceId === revision.resourceId);
    if (!resource) throw new Error('目录资源不存在');
    assertRevisionSource(resource, revision);
  }
  return state;
}
export function migrateLegacyCatalog(
  current: ResourceCatalogState,
  workbenchInput: unknown,
  legacyInput: unknown,
  now: string,
): ResourceCatalogState {
  if (current.migration) return current;
  const workbench = workbenchInput ? LegacyWorkbenchSnapshotSchema.parse(workbenchInput) : null;
  const legacy = LegacyStoreSchema.parse(legacyInput);
  const next = structuredClone(current);
  const bindings: { workspaceId: string; runtimeResourceId: string; catalogResourceId: string }[] = [];
  const collections = [...legacy.collections];
  for (const collection of legacy.collections)
    for (const resource of collection.resources) {
      assertResourceDigest({
        ...resource,
        evidence: {
          kind: 'web',
          snapshot: PageResourceSnapshotSchema.parse(
            Object.fromEntries(Object.entries(resource).filter(([key]) => !['spaceId', 'resourceId', 'version'].includes(key))),
          ),
        },
      });
    }
  for (const workspace of workbench?.workspaces ?? []) {
    if (workspace.publicResources) {
      const collection = ResourceCollectionSchema.parse(workspace.publicResources);
      if (collection.spaceId !== workspace.workspaceId) throw new Error('invalid_input: 旧工作台快照空间不匹配');
      for (const resource of collection.resources)
        assertResourceDigest({
          ...resource,
          evidence: {
            kind: 'web',
            snapshot: PageResourceSnapshotSchema.parse(
              Object.fromEntries(Object.entries(resource).filter(([key]) => !['spaceId', 'resourceId', 'version'].includes(key))),
            ),
          },
        });
      const stored = collections.find((item) => item.spaceId === collection.spaceId);
      if (!stored) collections.push(collection);
      else if (stored.revision < collection.revision) throw new Error('conflict: 旧资源文件落后于工作台快照');
    }
  }
  for (const collection of collections)
    for (const old of collection.resources) {
      if (next.resources.some((resource) => resource.resourceId === old.resourceId)) throw new Error('conflict: 旧资源身份重复');
      const { spaceId, resourceId, version, ...evidence } = old;
      const snapshot = PageResourceSnapshotSchema.parse(evidence);
      next.resources.push({
        resourceId,
        ownerAccountId: next.accountId,
        title: old.title || old.url,
        descriptor: { kind: 'web', url: old.url },
        createdAt: old.capturedAt,
      });
      next.revisions.push({
        resourceId,
        version,
        capturedAt: old.capturedAt,
        text: old.text,
        contentSha256: old.contentSha256,
        sourceSha256: old.sourceSha256,
        truncated: old.truncated,
        evidence: { kind: 'web', snapshot },
      });
      next.links.push({ workspaceId: spaceId, resourceId, referenceVersion: version, connectedAt: now });
    }
  for (const workspace of workbench?.workspaces ?? [])
    for (const old of workspace.resources) {
      if (old.kind === 'session') continue;
      if (next.resources.some((resource) => resource.resourceId === old.resourceId)) throw new Error('conflict: 旧运行资源与目录身份冲突');
      let descriptor: ResourceDescriptor;
      if (old.appProjectId)
        descriptor = {
          kind: 'development',
          entryKind: 'project',
          projectId: old.appProjectId,
          environmentId: old.environmentId,
          path: null,
        };
      else if (old.kind === 'web') {
        if (!old.url) throw new Error('invalid_input: 旧网页资源缺少 URL');
        descriptor = { kind: 'web', url: old.url };
      } else if (old.kind === 'file') descriptor = { kind: 'document', environmentId: old.environmentId, path: old.url };
      else descriptor = { kind: 'development', entryKind: old.kind, environmentId: old.environmentId, path: null, projectId: null };
      next.resources.push({
        resourceId: old.resourceId,
        ownerAccountId: next.accountId,
        title: old.title || old.resourceId,
        descriptor,
        createdAt: now,
      });
      next.links.push({ workspaceId: workspace.workspaceId, resourceId: old.resourceId, referenceVersion: null, connectedAt: now });
      bindings.push({ workspaceId: workspace.workspaceId, runtimeResourceId: old.resourceId, catalogResourceId: old.resourceId });
    }
  next.migration = { source: 'legacy-workbench-and-space-resources', completedAt: now, runtimeBindings: bindings };
  next.revision++;
  return parseResourceCatalog(next);
}
