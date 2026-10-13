import { createHash, randomUUID } from 'node:crypto';
import {
  MAX_RESOURCE_BUNDLE_BYTES,
  MAX_SPACE_RESOURCES,
  utf8ByteLength,
  type CatalogResource,
  type CatalogCommand,
  type CatalogReferenceSelection,
  type CatalogReferenceSnapshot,
  type ResourceCatalogState,
  type ResourceRevision,
} from '@wsl/protocol';

export interface CatalogContext {
  accountId: string;
  now: string;
  workspaceIds: string[];
  dependencies: { workspaceId: string; resourceId: string; kind: 'instance' | 'tab' | 'turn' }[];
}
export const catalogSha256 = (text: string) => createHash('sha256').update(text, 'utf8').digest('hex');
/**
 * Deduplication window for persisted catalogue command IDs. Every catalogue change advances the revision, so a
 * replay of an evicted ID carries a stale expectedCatalogRevision and is rejected as a conflict instead of applied
 * twice; openCatalogResource changes no catalogue state and a replay only reuses the space binding.
 */
export const MAX_APPLIED_CATALOG_COMMANDS = 512;
export function recordAppliedCommand(state: ResourceCatalogState, command: { commandId: string; fingerprint: string }): void {
  state.appliedCommands.push(command);
  if (state.appliedCommands.length > MAX_APPLIED_CATALOG_COMMANDS)
    state.appliedCommands.splice(0, state.appliedCommands.length - MAX_APPLIED_CATALOG_COMMANDS);
}
export function createResourceCatalog(accountId: string): ResourceCatalogState {
  return {
    schemaVersion: 1,
    accountId,
    revision: 0,
    resources: [],
    library: [],
    links: [],
    revisions: [],
    appliedCommands: [],
    migration: null,
  };
}
function assertOwner(state: ResourceCatalogState, context: CatalogContext): void {
  if (state.accountId !== context.accountId) throw new Error('unauthorized: 账户身份不匹配');
}
function assertRevision(state: ResourceCatalogState, expected: number): void {
  if (state.revision !== expected) throw new Error('conflict: 资源目录版本冲突，请刷新后重试');
}
function requireResource(state: ResourceCatalogState, resourceId: string) {
  const resource = state.resources.find((item) => item.resourceId === resourceId);
  if (!resource) throw new Error('not_found: 账户资源不存在');
  return resource;
}
export function listLibrary(state: ResourceCatalogState) {
  return state.library.map((entry) => ({
    ...requireResource(state, entry.resourceId),
    savedAt: entry.savedAt,
    links: state.links.filter((link) => link.resourceId === entry.resourceId),
    latestVersion: Math.max(
      0,
      ...state.revisions.filter((revision) => revision.resourceId === entry.resourceId).map((revision) => revision.version),
    ),
  }));
}
export function applyCatalogCommand(state: ResourceCatalogState, command: CatalogCommand, context: CatalogContext): ResourceCatalogState {
  assertOwner(state, context);
  const fingerprint = catalogSha256(JSON.stringify(command));
  const applied = state.appliedCommands.find((item) => item.commandId === command.commandId);
  if (applied) {
    if (applied.fingerprint !== fingerprint) throw new Error('conflict: 命令 ID 已被不同请求使用');
    return state;
  }
  assertRevision(state, command.expectedCatalogRevision);
  if ('workspaceId' in command && !context.workspaceIds.includes(command.workspaceId)) throw new Error('not_found: 空间不存在');
  if ('resourceId' in command) requireResource(state, command.resourceId);
  const next = structuredClone(state);
  switch (command.type) {
    case 'bookmarkLink': {
      const resourceId = randomUUID();
      next.resources.push({
        resourceId,
        ownerAccountId: context.accountId,
        title: command.title,
        descriptor: { kind: 'web', url: new URL(command.url).href },
        createdAt: context.now,
      });
      next.library.push({ resourceId, savedAt: context.now });
      break;
    }
    case 'bookmarkResource':
      if (!next.library.some((entry) => entry.resourceId === command.resourceId))
        next.library.push({ resourceId: command.resourceId, savedAt: context.now });
      break;
    case 'unbookmarkResource':
      next.library = next.library.filter((entry) => entry.resourceId !== command.resourceId);
      break;
    case 'updateResource':
      requireResource(next, command.resourceId).title = command.title;
      break;
    case 'connectResource':
      if (!next.links.some((link) => link.workspaceId === command.workspaceId && link.resourceId === command.resourceId))
        next.links.push({
          workspaceId: command.workspaceId,
          resourceId: command.resourceId,
          referenceVersion: null,
          connectedAt: context.now,
        });
      break;
    case 'disconnectResource':
    case 'deleteResource': {
      if (
        context.dependencies.some(
          (dependency) =>
            dependency.resourceId === command.resourceId &&
            (command.type === 'deleteResource' || dependency.workspaceId === command.workspaceId),
        )
      )
        throw new Error('conflict: 存在活动依赖，请先关闭页面、停止实例并等待执行结束');
      if (command.type === 'deleteResource') {
        if (next.links.some((link) => link.resourceId === command.resourceId)) throw new Error('conflict: 资源仍有空间连接');
        next.resources = next.resources.filter((resource) => resource.resourceId !== command.resourceId);
        next.library = next.library.filter((entry) => entry.resourceId !== command.resourceId);
        next.revisions = next.revisions.filter((revision) => revision.resourceId !== command.resourceId);
      } else next.links = next.links.filter((link) => link.workspaceId !== command.workspaceId || link.resourceId !== command.resourceId);
      break;
    }
    case 'selectReference': {
      const link = next.links.find((link) => link.workspaceId === command.workspaceId && link.resourceId === command.resourceId);
      if (!link) throw new Error('unauthorized: 资源未连接到空间');
      if (
        command.version !== null &&
        !next.revisions.some((revision) => revision.resourceId === command.resourceId && revision.version === command.version)
      )
        throw new Error('not_found: 资源版本不存在');
      link.referenceVersion = command.version;
      break;
    }
  }
  next.revision++;
  recordAppliedCommand(next, { commandId: command.commandId, fingerprint });
  return next;
}
export function assertResourceDigest(revision: Omit<ResourceRevision, 'version'> | ResourceRevision): void {
  if (catalogSha256(revision.text) !== revision.contentSha256) throw new Error('invalid_input: 正文摘要不匹配');
  if (revision.evidence.kind === 'web') {
    const snapshot = revision.evidence.snapshot;
    if (
      snapshot.text !== revision.text ||
      snapshot.contentSha256 !== revision.contentSha256 ||
      snapshot.sourceSha256 !== revision.sourceSha256 ||
      snapshot.capturedAt !== revision.capturedAt ||
      snapshot.truncated !== revision.truncated
    )
      throw new Error('invalid_input: 来源证据与正文不匹配');
  }
}
export function assertRevisionSource(resource: CatalogResource, revision: Omit<ResourceRevision, 'version'> | ResourceRevision): void {
  if ((resource.descriptor.kind === 'web') !== (revision.evidence.kind === 'web')) throw new Error('conflict: 捕获证据类型与资源不匹配');
  if (
    revision.evidence.kind === 'file' &&
    (resource.descriptor.kind !== 'document' ||
      resource.descriptor.environmentId !== revision.evidence.environmentId ||
      resource.descriptor.path !== revision.evidence.path)
  )
    throw new Error('conflict: 文件捕获与资源身份不一致');
  if (
    revision.evidence.kind === 'web' &&
    (resource.descriptor.kind !== 'web' || resource.descriptor.url !== revision.evidence.snapshot.url)
  )
    throw new Error('conflict: 捕获页面与资源身份不一致');
}
export function appendResourceRevision(
  state: ResourceCatalogState,
  revision: Omit<ResourceRevision, 'version'>,
  expectedRevision: number,
  context: CatalogContext,
): ResourceCatalogState {
  assertOwner(state, context);
  assertRevision(state, expectedRevision);
  const resource = requireResource(state, revision.resourceId);
  assertResourceDigest(revision);
  assertRevisionSource(resource, revision);
  const version = Math.max(0, ...state.revisions.filter((item) => item.resourceId === revision.resourceId).map((item) => item.version)) + 1;
  const next = structuredClone(state);
  next.revisions.push(structuredClone({ ...revision, version }));
  next.revision++;
  return next;
}
export function freezeCatalogReferences(state: ResourceCatalogState, selection: CatalogReferenceSelection): CatalogReferenceSnapshot {
  if (selection.workspaceId !== null && selection.references.length) throw new Error('invalid_input: 空间参考从已选择的连接固定');
  const references =
    selection.workspaceId === null
      ? selection.references
      : state.links
          .filter((link) => link.workspaceId === selection.workspaceId && link.referenceVersion !== null)
          .map((link) => ({ resourceId: link.resourceId, version: link.referenceVersion }));
  if (references.length > MAX_SPACE_RESOURCES) throw new Error('invalid_input: 每轮最多 16 个参考资料');
  if (new Set(references.map((reference) => reference.resourceId)).size !== references.length)
    throw new Error('invalid_input: 参考资料重复');
  const resources = references.map((reference) => {
    if (selection.workspaceId === null && !state.library.some((entry) => entry.resourceId === reference.resourceId))
      throw new Error('unauthorized: 个人参考必须来自收藏');
    const revision = state.revisions.find(
      (revision) => revision.resourceId === reference.resourceId && revision.version === reference.version,
    );
    if (!revision) throw new Error('not_found: 参考版本不存在');
    return structuredClone(revision);
  });
  const result = {
    accountId: state.accountId,
    workspaceId: selection.workspaceId,
    sessionId: selection.sessionId,
    catalogRevision: state.revision,
    resources,
  };
  if (utf8ByteLength(JSON.stringify(result)) > MAX_RESOURCE_BUNDLE_BYTES) throw new Error('invalid_input: 参考资料包超过 JSON 字节限制');
  return result;
}
