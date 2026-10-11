import { z } from 'zod';
import { ChatSlotSchema } from './chat-slot';
import { PageResourceSnapshotSchema, MAX_RESOURCE_TEXT_BYTES, MAX_RESOURCE_BUNDLE_BYTES, utf8ByteLength } from './resources';

const Id = z.string().regex(/^[A-Za-z0-9][A-Za-z0-9._:-]{0,199}$/);
const Version = z.number().int().positive();
const Revision = z.number().int().nonnegative();
const Hash = z.string().regex(/^[a-f0-9]{64}$/);
const Environment = z.enum(['local', 'sandbox', 'ssh']);
// Saving a URL is metadata only; opening/capturing retains its own capability checks.
export const BookmarkUrlSchema = z
  .string()
  .max(2048)
  .refine(
    (value) =>
      !/[\s\\]/u.test(value) &&
      !/^[a-z-]+:\/\/[^/?#]*@/iu.test(value) &&
      z.url({ protocol: /^(?:https?|wsl-demo)$/ }).safeParse(value).success,
    '链接必须是无凭据 HTTP/HTTPS 或内部演示地址',
  );
export const ResourceDescriptorSchema = z.discriminatedUnion('kind', [
  z.object({ kind: z.literal('web'), url: BookmarkUrlSchema }).strict(),
  z.object({ kind: z.literal('document'), environmentId: Environment.nullable(), path: z.string().min(1).max(4096).nullable() }).strict(),
  z
    .object({
      kind: z.literal('development'),
      entryKind: z.enum(['project', 'terminal', 'ssh']),
      environmentId: Environment.nullable(),
      path: z.string().min(1).max(4096).nullable(),
      projectId: z.uuid().nullable(),
    })
    .strict(),
]);
export const CatalogResourceSchema = z
  .object({
    resourceId: Id,
    ownerAccountId: Id,
    title: z.string().min(1).max(4096),
    descriptor: ResourceDescriptorSchema,
    createdAt: z.iso.datetime(),
  })
  .strict();
export const LibraryEntrySchema = z.object({ resourceId: Id, savedAt: z.iso.datetime() }).strict();
export const WorkspaceResourceLinkSchema = z
  .object({ workspaceId: Id, resourceId: Id, referenceVersion: Version.nullable(), connectedAt: z.iso.datetime() })
  .strict();
export const ResourceRevisionSchema = z
  .object({
    resourceId: Id,
    version: Version,
    capturedAt: z.iso.datetime(),
    text: z.string().refine((text) => utf8ByteLength(text) <= MAX_RESOURCE_TEXT_BYTES, '正文超过 UTF-8 字节限制'),
    contentSha256: Hash,
    sourceSha256: Hash,
    truncated: z.boolean(),
    evidence: z.discriminatedUnion('kind', [
      z.object({ kind: z.literal('web'), snapshot: PageResourceSnapshotSchema }).strict(),
      z.object({ kind: z.literal('file'), environmentId: Environment, path: z.string().min(1).max(4096), fileVersion: Id }).strict(),
    ]),
  })
  .strict()
  .refine(
    (revision) =>
      revision.evidence.kind !== 'web' ||
      (revision.evidence.snapshot.text === revision.text &&
        revision.evidence.snapshot.contentSha256 === revision.contentSha256 &&
        revision.evidence.snapshot.sourceSha256 === revision.sourceSha256 &&
        revision.evidence.snapshot.capturedAt === revision.capturedAt &&
        revision.evidence.snapshot.truncated === revision.truncated),
    '版本正文与网页证据不一致',
  );
export const CatalogRuntimeBindingSchema = z.object({ workspaceId: Id, runtimeResourceId: Id, catalogResourceId: Id }).strict();
export const ResourceCatalogStateSchema = z
  .object({
    schemaVersion: z.literal(1),
    accountId: Id,
    revision: Revision,
    resources: z.array(CatalogResourceSchema),
    library: z.array(LibraryEntrySchema),
    links: z.array(WorkspaceResourceLinkSchema),
    revisions: z.array(ResourceRevisionSchema),
    appliedCommands: z.array(z.object({ commandId: Id, fingerprint: Hash }).strict()),
    migration: z
      .object({
        source: z.literal('legacy-workbench-and-space-resources'),
        completedAt: z.iso.datetime(),
        runtimeBindings: z.array(CatalogRuntimeBindingSchema),
      })
      .strict()
      .nullable(),
  })
  .strict()
  .superRefine((state, ctx) => {
    const reject = (message: string) => ctx.addIssue({ code: 'custom', message });
    const unique = (values: string[]) => new Set(values).size === values.length;
    const key = (...parts: (string | number)[]) => JSON.stringify(parts);
    if (
      !unique(state.resources.map((r) => r.resourceId)) ||
      !unique(state.library.map((r) => r.resourceId)) ||
      !unique(state.links.map((r) => key(r.workspaceId, r.resourceId))) ||
      !unique(state.revisions.map((r) => key(r.resourceId, r.version))) ||
      !unique(state.appliedCommands.map((r) => r.commandId))
    )
      reject('目录身份重复');
    const ids = new Set(state.resources.map((r) => r.resourceId));
    if (state.resources.some((r) => r.ownerAccountId !== state.accountId)) reject('资源不属于账户');
    if ([...state.library, ...state.links, ...state.revisions].some((r) => !ids.has(r.resourceId))) reject('目录引用不存在');
    for (const revision of state.revisions) {
      const descriptor = state.resources.find((resource) => resource.resourceId === revision.resourceId)?.descriptor;
      if (!descriptor) continue;
      if (revision.evidence.kind === 'web') {
        if (descriptor.kind !== 'web' || descriptor.url !== revision.evidence.snapshot.url) reject('网页证据与资源身份不一致');
      } else if (
        descriptor.kind !== 'document' ||
        descriptor.environmentId !== revision.evidence.environmentId ||
        descriptor.path !== revision.evidence.path
      )
        reject('文件证据与资源身份不一致');
    }
    if (
      state.links.some(
        (link) =>
          link.referenceVersion !== null &&
          !state.revisions.some((r) => r.resourceId === link.resourceId && r.version === link.referenceVersion),
      )
    )
      reject('引用版本不存在');
  });
const Base = { commandId: Id, expectedCatalogRevision: Revision };
const Resource = { ...Base, resourceId: Id };
const Link = { ...Resource, workspaceId: Id };
export const CatalogCommandSchema = z.discriminatedUnion('type', [
  z.object({ ...Base, type: z.literal('bookmarkLink'), title: z.string().trim().min(1).max(4096), url: BookmarkUrlSchema }).strict(),
  z.object({ ...Resource, type: z.literal('bookmarkResource') }).strict(),
  z.object({ ...Resource, type: z.literal('unbookmarkResource') }).strict(),
  z.object({ ...Resource, type: z.literal('updateResource'), title: z.string().trim().min(1).max(4096) }).strict(),
  z.object({ ...Resource, type: z.literal('deleteResource') }).strict(),
  z.object({ ...Link, type: z.literal('connectResource') }).strict(),
  z.object({ ...Link, type: z.literal('disconnectResource') }).strict(),
  z.object({ ...Link, type: z.literal('selectReference'), version: Version.nullable() }).strict(),
]);
export const CatalogReferenceSelectionSchema = z
  .object({ workspaceId: Id.nullable(), sessionId: Id, references: z.array(z.object({ resourceId: Id, version: Version }).strict()) })
  .strict();
// Main's immutable selection result. The service adds its verified turn/generation envelope.
export const CatalogReferenceSnapshotSchema = z
  .object({
    accountId: Id,
    workspaceId: Id.nullable(),
    sessionId: Id,
    catalogRevision: Revision,
    resources: z.array(ResourceRevisionSchema),
  })
  .strict();
export type ResourceDescriptor = z.infer<typeof ResourceDescriptorSchema>;
export type CatalogResource = z.infer<typeof CatalogResourceSchema>;
export type ResourceRevision = z.infer<typeof ResourceRevisionSchema>;
export type ResourceCatalogState = z.infer<typeof ResourceCatalogStateSchema>;
export type CatalogCommand = z.infer<typeof CatalogCommandSchema>;
export type CatalogReferenceSelection = z.infer<typeof CatalogReferenceSelectionSchema>;
export type CatalogReferenceSnapshot = z.infer<typeof CatalogReferenceSnapshotSchema>;

export const CatalogSummarySchema = z
  .object({
    accountId: Id,
    revision: Revision,
    resources: z.array(CatalogResourceSchema.extend({ latestVersion: z.number().int().nonnegative(), versions: z.array(Version) })),
    library: z.array(LibraryEntrySchema),
    links: z.array(WorkspaceResourceLinkSchema),
  })
  .strict();
export const CatalogQuerySchema = z.object({ resourceId: Id, version: Version }).strict();
export const RunReferenceQuerySchema = z.object({ workspaceId: Id, runId: Id }).strict();
export const CatalogActionSchema = z.union([
  CatalogCommandSchema,
  z.object({ ...Base, type: z.literal('bookmarkRuntimeResource'), workspaceId: Id, runtimeResourceId: Id }).strict(),
  z.object({ ...Base, type: z.literal('openCatalogResource'), workspaceId: Id, resourceId: Id }).strict(),
  z.object({ ...Base, type: z.literal('captureResourceRevision'), workspaceId: Id, runtimeResourceId: Id }).strict(),
]);
export const PersonalChatSendSchema = z
  .object({
    conversationId: z.literal('conv-personal-default'),
    text: z.string().trim().min(1).max(32000),
    references: CatalogReferenceSelectionSchema.shape.references.default([]),
  })
  .strict();
export const ResourceBundleSchema = CatalogReferenceSnapshotSchema.extend({
  conversationId: ChatSlotSchema,
  generation: z.string().min(1).max(128),
  turnId: z.string().min(1).max(128),
})
  .strict()
  .refine((bundle) => bundle.conversationId === bundle.sessionId, '参考与会话身份不一致')
  .refine(
    (bundle) => bundle.resources.length <= 16 && new Set(bundle.resources.map((r) => r.resourceId)).size === bundle.resources.length,
    '参考最多16条且不可重复',
  )
  .refine((bundle) => utf8ByteLength(JSON.stringify(bundle)) <= MAX_RESOURCE_BUNDLE_BYTES, '参考超过完整JSON字节限制');
export type ResourceBundle = z.infer<typeof ResourceBundleSchema>;
export type CatalogSummary = z.infer<typeof CatalogSummarySchema>;
export type CatalogAction = z.infer<typeof CatalogActionSchema>;
