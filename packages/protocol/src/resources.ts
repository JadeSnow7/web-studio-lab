import { z } from 'zod';
import { PageIdentitySchema } from './preview';

export const MAX_RESOURCE_TEXT_BYTES = 65536;
export const MAX_RESOURCE_BUNDLE_BYTES = 524288;
export const MAX_SPACE_RESOURCES = 16;

// 在 Node 与无 Node 的 renderer 之间复用，孤立代理项按 UTF-8 的替换字符计算。
// 按 UTF-16 码元遍历：每次保存都会校验全部正文，逐码点迭代器在大目录上开销显著。
export function utf8ByteLength(value: string): number {
  let bytes = 0;
  for (let index = 0; index < value.length; index++) {
    const unit = value.charCodeAt(index);
    if (unit <= 0x7f) bytes += 1;
    else if (unit <= 0x7ff) bytes += 2;
    else if (unit <= 0xdbff && unit >= 0xd800 && (value.charCodeAt(index + 1) & 0xfc00) === 0xdc00) {
      bytes += 4;
      index++;
    } else bytes += 3;
  }
  return bytes;
}
const HashSchema = z.string().regex(/^[a-f0-9]{64}$/);
const PublicUrlSchema = z
  .url({ protocol: /^https$/ })
  .max(2048)
  .refine((url) => !/^https:\/\/[^/?#]*@/i.test(url), '不允许 URL 凭据');
const BrowserUrlSchema = z
  .url({ protocol: /^https?$/ })
  .max(2048)
  .refine((value) => !/^https?:\/\/[^/?#]*@/i.test(value), '不允许 URL 凭据');
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
const RenderedHostSnapshotObject = z
  .object({
    ...SnapshotFields,
    requestedUrl: BrowserUrlSchema,
    url: BrowserUrlSchema,
    page: ResourcePageSchema.extend({ url: BrowserUrlSchema }),
    extractionVersion: z.literal('host-rendered-dom-text-v1'),
    sourceKind: z.literal('rendered-visible-text'),
  })
  .strict();
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
  .discriminatedUnion('extractionVersion', [HostSnapshotObject, RenderedHostSnapshotObject, GuestSnapshotObject])
  .refine(pageMatchesSnapshot, '页面身份与快照不一致');
export type GuestResourcePage = z.infer<typeof GuestResourcePageSchema>;
export type GuestPageResourceSnapshot = z.infer<typeof GuestPageResourceSnapshotSchema>;
export type PageResourceSnapshot = z.infer<typeof PageResourceSnapshotSchema>;
