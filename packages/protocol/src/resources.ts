import { z } from 'zod';
import { ChatSlotSchema } from './chat-slot';
import { PageIdentitySchema } from './preview';

export const MAX_RESOURCE_TEXT_BYTES = 65536;
export const MAX_RESOURCE_BUNDLE_BYTES = 524288;
export const MAX_SPACE_RESOURCES = 16;
export const RESOURCE_SPACE_ID = 'taskflow-demo';

// 在 Node 与无 Node 的 renderer 之间复用，孤立代理项按 UTF-8 的替换字符计算。
export function utf8ByteLength(value: string): number {
  let bytes = 0;
  for (const char of value) {
    const point = char.codePointAt(0)!;
    bytes += point <= 0x7f ? 1 : point <= 0x7ff ? 2 : point <= 0xffff ? 3 : 4;
  }
  return bytes;
}
const SpaceIdSchema = z.string().regex(/^[a-z0-9][a-z0-9-]{0,63}$/);
const ResourceIdSchema = z.uuid();
const HashSchema = z.string().regex(/^[a-f0-9]{64}$/);
const PublicUrlSchema = z
  .url({ protocol: /^https$/ })
  .max(2048)
  .refine((url) => !/^https:\/\/[^/?#]*@/i.test(url), '不允许 URL 凭据');
const ResourcePageSchema = PageIdentitySchema.extend({
  url: PublicUrlSchema,
  title: z.string().max(4096),
  partition: z.string().min(1).max(128),
}).strict();
// The original host page remains a separate strict variant. A guest capture
// never borrows an Electron webContentsId or a host session partition.
// Check the original string before z.url trims/normalizes it. Protocol types
// remain portable between the host, guest and renderer (no Node/DOM dependency).
const GuestPublicUrlSchema = z
  .string()
  .max(2048)
  .refine(
    (value) =>
      !Array.from(value).some((char) => char.charCodeAt(0) <= 32 || char.charCodeAt(0) === 127 || char === '\\') &&
      /^https:\/\/(?:\[[0-9a-f:.]+\]|[^/?#:@\\]+)(?::443)?(?:[/?#]|$)/iu.test(value),
    'Guest resources require HTTPS 443 without credentials',
  )
  .pipe(PublicUrlSchema);
export const GuestResourcePageSchema = z
  .object({
    kind: z.literal('sandbox-chromium'),
    sandboxName: z.string().regex(/^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/),
    browserInstanceId: z.uuid(),
    targetId: z.string().regex(/^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/),
    navigationEpoch: z.number().int().nonnegative(),
    url: GuestPublicUrlSchema,
    title: z.string().max(4096),
  })
  .strict();
const SnapshotFields = {
  requestedUrl: PublicUrlSchema,
  url: PublicUrlSchema,
  title: z.string().max(4096),
  text: z.string().refine((text) => utf8ByteLength(text) <= MAX_RESOURCE_TEXT_BYTES, '正文超过 UTF-8 字节限制'),
  capturedAt: z.iso.datetime(),
  sourceSha256: HashSchema,
  contentSha256: HashSchema,
  truncated: z.boolean(),
};
const HostSnapshotObject = z.object({ ...SnapshotFields, page: ResourcePageSchema, extractionVersion: z.literal('html-text-v1') }).strict();
const GuestSnapshotObject = z
  .object({
    ...SnapshotFields,
    requestedUrl: GuestPublicUrlSchema,
    url: GuestPublicUrlSchema,
    page: GuestResourcePageSchema,
    extractionVersion: z.literal('rendered-dom-text-v1'),
    // sourceSha256 hashes Chromium's decoded main-response body, not wire bytes.
    sourceKind: z.literal('decoded-main-response'),
    captureId: z.uuid(),
    screenshotSha256: HashSchema,
  })
  .strict();
const pageMatchesSnapshot = (snapshot: { page: { url: string; title: string }; url: string; title: string }) =>
  snapshot.page.url === snapshot.url && snapshot.page.title === snapshot.title;
export const GuestPageResourceSnapshotSchema = GuestSnapshotObject.refine(pageMatchesSnapshot, '页面身份与快照不一致');
export const PageResourceSnapshotSchema = z
  .discriminatedUnion('extractionVersion', [HostSnapshotObject, GuestSnapshotObject])
  .refine(pageMatchesSnapshot, '页面身份与快照不一致');
const ResourceIdentityFields = { spaceId: SpaceIdSchema, resourceId: ResourceIdSchema, version: z.number().int().positive() };
export const SpaceResourceSchema = z
  .discriminatedUnion('extractionVersion', [
    HostSnapshotObject.extend(ResourceIdentityFields),
    GuestSnapshotObject.extend(ResourceIdentityFields),
  ])
  .refine(pageMatchesSnapshot, '页面身份与快照不一致');
const ScopedResourcesSchema = z.array(SpaceResourceSchema).max(MAX_SPACE_RESOURCES);
export const ResourceCollectionSchema = z
  .object({
    spaceId: SpaceIdSchema,
    revision: z.number().int().nonnegative(),
    resources: ScopedResourcesSchema,
  })
  .strict()
  .refine((collection) => collection.resources.every((resource) => resource.spaceId === collection.spaceId), '资源不属于当前空间')
  .refine(
    (collection) =>
      new Set(collection.resources.map((resource) => resource.resourceId)).size === collection.resources.length &&
      new Set(collection.resources.map((resource) => resource.url)).size === collection.resources.length,
    '资源身份或 URL 重复',
  )
  .refine(
    (collection) =>
      utf8ByteLength(
        JSON.stringify({
          conversationId: 'conv-space-taskflow-demo-impl',
          generation: '\u0000'.repeat(128),
          turnId: '\u0000'.repeat(128),
          spaceId: collection.spaceId,
          collectionRevision: collection.revision,
          resources: collection.resources,
        }),
      ) <= MAX_RESOURCE_BUNDLE_BYTES,
    '空间资源超过完整轮次 JSON 字节限制',
  );
export const ResourceBundleSchema = z
  .object({
    conversationId: ChatSlotSchema,
    generation: z.string().min(1).max(128),
    turnId: z.string().min(1).max(128),
    spaceId: z.literal(RESOURCE_SPACE_ID).nullable(),
    collectionRevision: z.number().int().nonnegative(),
    resources: ScopedResourcesSchema,
  })
  .strict()
  .refine(
    (bundle) =>
      bundle.spaceId === null
        ? bundle.resources.length === 0 && bundle.collectionRevision === 0
        : bundle.spaceId === RESOURCE_SPACE_ID && bundle.resources.every((resource) => resource.spaceId === bundle.spaceId),
    '会话与资源空间不一致',
  )
  .refine(
    (bundle) =>
      bundle.conversationId === 'conv-personal-default'
        ? bundle.spaceId === null
        : bundle.conversationId === 'conv-space-taskflow-demo-impl'
          ? bundle.spaceId === RESOURCE_SPACE_ID
          : true,
    '固定会话的资源授权不匹配',
  )
  .refine((bundle) => new Set(bundle.resources.map((resource) => resource.resourceId)).size === bundle.resources.length, '资源身份重复')
  .refine((bundle) => utf8ByteLength(JSON.stringify(bundle)) <= MAX_RESOURCE_BUNDLE_BYTES, '资源包超过 JSON 字节限制');
export const ResourceListRequestSchema = z.object({ spaceId: z.literal(RESOURCE_SPACE_ID) }).strict();
export const ResourceCaptureRequestSchema = ResourceListRequestSchema.extend({
  expectedPage: PageIdentitySchema.strict(),
  resourceId: ResourceIdSchema.optional(),
}).strict();
export const ResourceRemoveRequestSchema = ResourceListRequestSchema.extend({ resourceId: ResourceIdSchema }).strict();
export const ResourceSaveRequestSchema = ResourceListRequestSchema.extend({
  snapshot: PageResourceSnapshotSchema,
  resourceId: ResourceIdSchema.optional(),
}).strict();
export const ResourceStoreSpaceIdSchema = SpaceIdSchema;
export type GuestResourcePage = z.infer<typeof GuestResourcePageSchema>;
export type GuestPageResourceSnapshot = z.infer<typeof GuestPageResourceSnapshotSchema>;
export type PageResourceSnapshot = z.infer<typeof PageResourceSnapshotSchema>;
export type SpaceResource = z.infer<typeof SpaceResourceSchema>;
export type ResourceCollection = z.infer<typeof ResourceCollectionSchema>;
export type ResourceBundle = z.infer<typeof ResourceBundleSchema>;
