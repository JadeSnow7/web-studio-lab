import { z } from 'zod';
import { MAX_RESOURCE_BUNDLE_BYTES, MAX_RESOURCE_TEXT_BYTES, PageResourceSnapshotSchema, utf8ByteLength } from './resources';

export const MAX_RESEARCH_SOURCES = 16;
export const MAX_RESEARCH_BYTES = MAX_RESOURCE_BUNDLE_BYTES;
export const MAX_RESEARCH_TEXT_BYTES = MAX_RESOURCE_TEXT_BYTES;
export const MAX_NATIVE_SEARCH_RECORDS = 32;
export const MAX_NATIVE_SEARCH_BYTES = 65536;

const Id = z.string().min(1).max(200);
const Hash = z.string().regex(/^[a-f0-9]{64}$/);
// Reuse the existing host reader contract, without accepting guest-only captures.
// Public DNS and redirect admission remain the reader adapter's responsibility.
const HostSnapshot = PageResourceSnapshotSchema.options[0];
const PublicUrl = HostSnapshot.shape.url;

export const ResearchGrantSchema = z
  .object({
    grantId: z.uuid(),
    accountId: Id,
    workspaceId: Id,
    sessionId: Id,
    taskVersionId: Id,
    runId: Id,
    mode: z.literal('live'),
    purpose: z.literal('public-web-research'),
    grantedAt: z.iso.datetime(),
  })
  .strict();
export type ResearchGrant = z.infer<typeof ResearchGrantSchema>;

export const ResearchTurnContextSchema = z
  .object({ grant: ResearchGrantSchema, generation: z.string().min(1).max(128), turnId: z.string().min(1).max(128) })
  .strict();
export type ResearchTurnContext = z.infer<typeof ResearchTurnContextSchema>;

export const ResearchToolNameSchema = z.enum(['research.open', 'research.include']);
export type ResearchToolName = z.infer<typeof ResearchToolNameSchema>;
const OpenInput = z.object({ tool: z.literal('research.open'), args: z.object({ url: PublicUrl }).strict() }).strict();
const IncludeInput = z
  .object({ tool: z.literal('research.include'), args: z.object({ captureId: z.uuid(), contentSha256: Hash }).strict() })
  .strict();
export const ResearchToolInputSchema = z.discriminatedUnion('tool', [OpenInput, IncludeInput]);
export type ResearchToolInput = z.infer<typeof ResearchToolInputSchema>;
const CallIdentity = { callId: z.uuid(), context: ResearchTurnContextSchema };
export const ResearchCallSchema = z.discriminatedUnion('tool', [OpenInput.extend(CallIdentity), IncludeInput.extend(CallIdentity)]);
export type ResearchCall = z.infer<typeof ResearchCallSchema>;

export const ResearchCaptureSummarySchema = z
  .object({
    captureId: z.uuid(),
    readerResourceId: Id,
    requestedUrl: HostSnapshot.shape.requestedUrl,
    url: PublicUrl,
    title: HostSnapshot.shape.title,
    capturedAt: HostSnapshot.shape.capturedAt,
    sourceSha256: Hash,
    contentSha256: Hash,
    extractionVersion: z.literal('html-text-v1'),
    truncated: z.boolean(),
    textBytes: z.number().int().min(0).max(MAX_RESEARCH_TEXT_BYTES),
  })
  .strict();
export type ResearchCaptureSummary = z.infer<typeof ResearchCaptureSummarySchema>;

export const ResearchCaptureSchema = ResearchCaptureSummarySchema.extend({
  page: HostSnapshot.shape.page,
  text: HostSnapshot.shape.text,
})
  .strict()
  .refine((capture) => capture.page.url === capture.url && capture.page.title === capture.title, '研究正文与页面身份不一致')
  .refine((capture) => utf8ByteLength(capture.text) === capture.textBytes, '研究正文 UTF-8 字节数不一致');
// Protocol validates structure and byte counts; Main/repository recompute hashes
// from the actual captured text. A well-shaped hash is not proof of content.
export type ResearchCapture = z.infer<typeof ResearchCaptureSchema>;

export const ResearchInclusionSchema = z.object({ captureId: z.uuid(), contentSha256: Hash, includedAt: z.iso.datetime() }).strict();
export type ResearchInclusion = z.infer<typeof ResearchInclusionSchema>;

export const ResearchErrorCodeSchema = z.enum([
  'unauthorized',
  'invalid_request',
  'cancelled',
  'timeout',
  'stale',
  'blocked',
  'budget_exceeded',
  'storage_failed',
  'unavailable',
]);
export type ResearchErrorCode = z.infer<typeof ResearchErrorCodeSchema>;
export const ResearchIncludedSourceSchema = ResearchCaptureSummarySchema.extend({
  includedAt: z.iso.datetime(),
  text: HostSnapshot.shape.text,
})
  .strict()
  .refine((source) => utf8ByteLength(source.text) === source.textBytes, '纳入正文 UTF-8 字节数不一致');
export type ResearchIncludedSource = z.infer<typeof ResearchIncludedSourceSchema>;
export const ResearchToolResultSchema = z.union([
  z.object({ ok: z.literal(true), tool: z.literal('research.open'), capture: ResearchCaptureSummarySchema }).strict(),
  z.object({ ok: z.literal(true), tool: z.literal('research.include'), source: ResearchIncludedSourceSchema }).strict(),
  z
    .object({
      ok: z.literal(false),
      tool: ResearchToolNameSchema,
      error: z.object({ code: ResearchErrorCodeSchema, message: z.string().min(1).max(1000) }).strict(),
    })
    .strict(),
]);
export type ResearchToolResult = z.infer<typeof ResearchToolResultSchema>;
export const ResearchReplySchema = z
  .object({ callId: z.uuid(), context: ResearchTurnContextSchema, result: ResearchToolResultSchema })
  .strict();
export type ResearchReply = z.infer<typeof ResearchReplySchema>;

const runIdentityIsConsistent = (run: { captures: ResearchCaptureSummary[]; inclusions: ResearchInclusion[] }) =>
  new Set(run.captures.map((capture) => capture.captureId)).size === run.captures.length &&
  new Set(run.inclusions.map((inclusion) => inclusion.captureId)).size === run.inclusions.length &&
  run.inclusions.every((inclusion) =>
    run.captures.some((capture) => capture.captureId === inclusion.captureId && capture.contentSha256 === inclusion.contentSha256),
  );
export const ResearchRunStateSchema = z
  .object({
    grant: ResearchGrantSchema,
    captures: z.array(ResearchCaptureSchema).max(MAX_RESEARCH_SOURCES),
    inclusions: z.array(ResearchInclusionSchema).max(MAX_RESEARCH_SOURCES),
  })
  .strict()
  .refine(runIdentityIsConsistent, '研究来源身份重复或纳入记录没有匹配的正文')
  .refine((state) => utf8ByteLength(JSON.stringify(state)) <= MAX_RESEARCH_BYTES, '研究资料超过完整 JSON 字节预算');
export type ResearchRunState = z.infer<typeof ResearchRunStateSchema>;
export const ResearchRunSummarySchema = z
  .object({
    grant: ResearchGrantSchema,
    captures: z.array(ResearchCaptureSummarySchema).max(MAX_RESEARCH_SOURCES),
    inclusions: z.array(ResearchInclusionSchema).max(MAX_RESEARCH_SOURCES),
  })
  .strict()
  .refine(runIdentityIsConsistent, '研究摘要身份重复或纳入记录没有匹配的来源');
export type ResearchRunSummary = z.infer<typeof ResearchRunSummarySchema>;

export const ResearchNativeSearchRecordSchema = z
  .object({
    itemId: Id,
    turnId: z.string().min(1).max(128),
    status: z.enum(['in_progress', 'completed', 'failed', 'unknown']),
    observedAt: z.iso.datetime(),
    query: z.string().max(4000).optional(),
    // A discovered URL is audit metadata, not permission to open it.
    candidateUrls: z
      .array(
        z
          .url({ protocol: /^https?$/ })
          .max(2048)
          .refine((url) => !/^https?:\/\/[^/?#]*@/i.test(url), '不允许候选 URL 凭据'),
      )
      .max(32)
      .optional(),
    schemaUnsupported: z.boolean(),
    truncated: z.boolean(),
  })
  .strict();
export type ResearchNativeSearchRecord = z.infer<typeof ResearchNativeSearchRecordSchema>;
export const ResearchNativeSearchRecordsSchema = z
  .array(ResearchNativeSearchRecordSchema)
  .max(MAX_NATIVE_SEARCH_RECORDS)
  .refine((records) => utf8ByteLength(JSON.stringify(records)) <= MAX_NATIVE_SEARCH_BYTES, '原生搜索审计超过完整 JSON 字节预算');
