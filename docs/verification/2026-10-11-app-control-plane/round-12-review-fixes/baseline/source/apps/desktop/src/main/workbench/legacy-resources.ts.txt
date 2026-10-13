import { z } from 'zod';
import { PageResourceSnapshotSchema, MAX_RESOURCE_BUNDLE_BYTES, MAX_SPACE_RESOURCES, utf8ByteLength } from '@wsl/protocol';
const SpaceIdSchema = z.string().min(1).max(200);
const ResourceIdSchema = z.uuid();
export const SpaceResourceSchema = z
  .object({ spaceId: SpaceIdSchema, resourceId: ResourceIdSchema, version: z.number().int().positive() })
  .passthrough()
  .transform((value, ctx) => {
    const { spaceId, resourceId, version, ...input } = value;
    const result = PageResourceSnapshotSchema.safeParse(input);
    if (!result.success) {
      for (const issue of result.error.issues) ctx.addIssue({ code: 'custom', message: issue.message, path: issue.path });
      return z.NEVER;
    }
    return { ...result.data, spaceId, resourceId, version };
  });
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
export type SpaceResource = z.infer<typeof SpaceResourceSchema>;
export type ResourceCollection = z.infer<typeof ResourceCollectionSchema>;
