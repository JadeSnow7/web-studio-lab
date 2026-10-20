import { z } from 'zod';

export const MOTA_EDITOR_LIMITS = Object.freeze({
  fileBytes: 262144,
  chunkBytes: 1024,
  chunks: 256,
  frameBytes: 4096,
  frames: 264,
  responseMs: 5000,
  transferMs: 30000,
  sessions: 16,
  decodedBytes: 8388608,
  operations: 1024,
});
const generation = z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER);
const id = z
  .string()
  .min(1)
  .max(200)
  .refine((value) => ![...value].some((character) => character.charCodeAt(0) < 32 || character.charCodeAt(0) === 127));
const hash = z.string().regex(/^[a-f0-9]{64}$/);
export const MotaEditorFileSchema = z.enum(['project/floors/MT1.js', '_server/config.json']);
export const MotaEditorBindingSchema = z
  .object({
    workspaceId: id,
    environmentId: z.literal('sandbox'),
    projectId: z.uuid(),
    appInstanceId: id,
    resourceId: id,
    resourceInstanceId: id,
    resourceGeneration: generation,
    browserInstanceId: id,
    browserGeneration: generation,
    documentGeneration: generation,
    editorEpoch: generation.min(1),
  })
  .strict();
export type MotaEditorBinding = z.infer<typeof MotaEditorBindingSchema>;
export const MotaEditorContentSchema = z
  .object({
    file: MotaEditorFileSchema,
    expectedHash: hash.nullable(),
    contentLength: z.number().int().min(0).max(MOTA_EDITOR_LIMITS.fileBytes),
    contentHash: hash,
  })
  .strict();
export const MotaEditorReceiptSchema = MotaEditorContentSchema.extend({
  editorSessionId: z.uuid(),
  requestId: z.uuid(),
  afterHash: hash,
  durabilityError: z.string().min(1).max(200).nullable(),
}).strict();
export type MotaEditorReceipt = z.infer<typeof MotaEditorReceiptSchema>;
export const MotaEditorOperationSchema = z
  .object({
    requestId: z.uuid(),
    status: z.enum(['staging', 'staged', 'committed', 'failed', 'unknown']),
    receipt: MotaEditorReceiptSchema.nullable(),
    error: z.string().min(1).max(200).nullable(),
  })
  .strict()
  .refine((value) => (value.status === 'committed' ? value.receipt?.requestId === value.requestId : value.receipt === null));
const empty = z.object({}).strict();
const logical = { binding: MotaEditorBindingSchema, editorSessionId: z.uuid(), requestId: z.uuid() };
export const MotaEditorRequestSchema = z.discriminatedUnion('method', [
  z.object({ ...logical, method: z.literal('editor.open'), input: empty }).strict(),
  z.object({ ...logical, method: z.literal('editor.read'), input: z.object({ file: MotaEditorFileSchema }).strict() }).strict(),
  z
    .object({
      ...logical,
      method: z.literal('editor.stage'),
      input: MotaEditorContentSchema.extend({ content: z.string().max(262144) }).strict(),
    })
    .strict(),
  z.object({ ...logical, method: z.literal('editor.commit'), input: MotaEditorContentSchema }).strict(),
  z.object({ ...logical, method: z.literal('editor.revoke'), input: empty }).strict(),
  z.object({ ...logical, method: z.literal('editor.status'), input: z.object({ operationRequestId: z.uuid() }).strict() }).strict(),
]);
export type MotaEditorRequest = z.infer<typeof MotaEditorRequestSchema>;
export const MotaEditorErrorSchema = z
  .object({
    code: z.enum([
      'invalid_frame',
      'stale_instance',
      'revoked',
      'busy',
      'source_changed',
      'invalid_content',
      'operation_conflict',
      'budget_exceeded',
      'expired',
      'unknown',
      'unavailable',
    ]),
    message: z.string().min(1).max(200),
  })
  .strict();
const envelope = {
  editorSessionId: z.uuid(),
  requestId: z.uuid(),
  sessionIndex: generation.min(1),
  editorEpoch: generation.min(1),
  frameSeq: z.number().int().min(0).max(263),
};
const rawBase64 = z
  .string()
  .min(4)
  .max(1368)
  .regex(/^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/)
  .refine((value) => {
    const alphabet = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/';
    const padding = value.endsWith('==') ? 2 : value.endsWith('=') ? 1 : 0;
    const last = alphabet.indexOf(value[value.length - padding - 1] ?? '');
    return (value.length / 4) * 3 - padding <= 1024 && (padding === 2 ? last % 16 === 0 : padding === 1 ? last % 4 === 0 : true);
  });
const wire = { ...envelope, type: z.literal('mota-editor') };
export const MotaEditorFrameSchema = z.union([
  z.object({ ...wire, method: z.literal('editor.open'), phase: z.literal('single'), input: MotaEditorBindingSchema }).strict(),
  z
    .object({
      ...wire,
      method: z.literal('editor.read'),
      phase: z.literal('begin'),
      input: z.object({ file: MotaEditorFileSchema }).strict(),
    })
    .strict(),
  z.object({ ...wire, method: z.literal('editor.read'), phase: z.enum(['chunk', 'end']), input: empty }).strict(),
  z.object({ ...wire, method: z.literal('editor.stage'), phase: z.literal('begin'), input: MotaEditorContentSchema }).strict(),
  z
    .object({ ...wire, method: z.literal('editor.stage'), phase: z.literal('chunk'), input: z.object({ base64: rawBase64 }).strict() })
    .strict(),
  z.object({ ...wire, method: z.literal('editor.stage'), phase: z.literal('end'), input: empty }).strict(),
  z.object({ ...wire, method: z.literal('editor.commit'), phase: z.literal('single'), input: MotaEditorContentSchema }).strict(),
  z.object({ ...wire, method: z.literal('editor.revoke'), phase: z.literal('single'), input: empty }).strict(),
  z
    .object({
      ...wire,
      method: z.literal('editor.status'),
      phase: z.literal('single'),
      input: z.object({ operationRequestId: z.uuid() }).strict(),
    })
    .strict(),
]);
export type MotaEditorFrame = z.infer<typeof MotaEditorFrameSchema>;
const method = z.enum(['editor.open', 'editor.read', 'editor.stage', 'editor.commit', 'editor.revoke', 'editor.status']);
const result = { ...envelope, type: z.literal('mota-editor-result'), method, phase: z.enum(['single', 'begin', 'chunk', 'end']) };
const ack = z.object({ settled: z.literal(true) }).strict();
const settlement = z.object({ discarded: z.boolean(), settled: z.literal(true), operation: MotaEditorOperationSchema.nullable() }).strict();
const readHeader = z
  .object({ contentLength: z.number().int().min(0).max(262144), contentHash: hash.nullable() })
  .strict()
  .refine((value) => value.contentHash !== null || value.contentLength === 0);
const block = z.object({ base64: rawBase64 }).strict();
const success = { ...envelope, type: z.literal('mota-editor-result'), ok: z.literal(true) };
export const MotaEditorFrameResultSchema = z.union([
  z.object({ ...result, ok: z.literal(false), error: MotaEditorErrorSchema }).strict(),
  z.object({ ...success, method: z.literal('editor.open'), phase: z.literal('single'), data: ack }).strict(),
  z.object({ ...success, method: z.literal('editor.read'), phase: z.literal('begin'), data: readHeader }).strict(),
  z.object({ ...success, method: z.literal('editor.read'), phase: z.literal('chunk'), data: block }).strict(),
  z.object({ ...success, method: z.literal('editor.read'), phase: z.literal('end'), data: ack }).strict(),
  z
    .object({ ...success, method: z.literal('editor.stage'), phase: z.literal('begin'), data: z.union([ack, MotaEditorOperationSchema]) })
    .strict(),
  z.object({ ...success, method: z.literal('editor.stage'), phase: z.literal('chunk'), data: ack }).strict(),
  z.object({ ...success, method: z.literal('editor.stage'), phase: z.literal('end'), data: MotaEditorOperationSchema }).strict(),
  z.object({ ...success, method: z.literal('editor.commit'), phase: z.literal('single'), data: MotaEditorOperationSchema }).strict(),
  z.object({ ...success, method: z.literal('editor.revoke'), phase: z.literal('single'), data: settlement }).strict(),
  z.object({ ...success, method: z.literal('editor.status'), phase: z.literal('single'), data: MotaEditorOperationSchema }).strict(),
]);
export type MotaEditorFrameResult = z.infer<typeof MotaEditorFrameResultSchema>;
export const MotaEditorResultSchema = z
  .object({
    ...logical,
    method,
    ok: z.boolean(),
    data: z
      .union([
        empty,
        z
          .object({
            content: z.string().max(262144).nullable(),
            contentHash: hash.nullable(),
            contentLength: z.number().int().min(0).max(262144),
          })
          .strict(),
        MotaEditorOperationSchema,
        z.object({ discarded: z.boolean(), settled: z.literal(true), operation: MotaEditorOperationSchema.nullable() }).strict(),
      ])
      .optional(),
    error: MotaEditorErrorSchema.optional(),
  })
  .strict()
  .refine((value) =>
    value.ok ? value.data !== undefined && value.error === undefined : value.error !== undefined && value.data === undefined,
  )
  .refine((value) => {
    if (!value.ok) return true;
    if (value.method === 'editor.open') return empty.safeParse(value.data).success;
    if (value.method === 'editor.revoke') return settlement.safeParse(value.data).success;
    if (value.method === 'editor.read') return value.data !== undefined && 'content' in value.data;
    return MotaEditorOperationSchema.safeParse(value.data).success;
  });
export type MotaEditorResult = z.infer<typeof MotaEditorResultSchema>;
export const MotaEditorReadDataSchema = z
  .object({ content: z.string().max(262144).nullable(), contentHash: hash.nullable(), contentLength: z.number().int().min(0).max(262144) })
  .strict();

// Narrow product IPC DTOs. Native identity, hashes and byte limits are owned by Main.
export const MotaEditorReadInputSchema = z
  .object({ sessionIndex: generation.min(1), requestId: z.uuid(), file: MotaEditorFileSchema })
  .strict();
export const MotaEditorSaveInputSchema = MotaEditorReadInputSchema.extend({
  expectedHash: hash.nullable(),
  content: z.string().max(262144),
}).strict();
export const MotaEditorCloseInputSchema = z.object({ sessionIndex: generation.min(1), requestId: z.uuid() }).strict();
export const MotaEditorStatusInputSchema = z
  .object({ sessionIndex: generation.min(1).nullable(), requestId: z.uuid(), operationRequestId: z.uuid().optional() })
  .strict();
export type MotaEditorReadInput = z.infer<typeof MotaEditorReadInputSchema>;
export type MotaEditorSaveInput = z.infer<typeof MotaEditorSaveInputSchema>;
export type MotaEditorCloseInput = z.infer<typeof MotaEditorCloseInputSchema>;
export type MotaEditorStatusInput = z.infer<typeof MotaEditorStatusInputSchema>;
export type MotaEditorOperation = z.infer<typeof MotaEditorOperationSchema>;
export type MotaEditorProjection = {
  sessionIndex: number | null;
  state: 'opening' | 'active' | 'revoked';
  theme: 'light' | 'dark' | 'warm' | 'system';
  error: string | null;
  operations: { sessionIndex: number; operation: MotaEditorOperation; durabilityIssue: string | null }[];
};
export type MotaEditorReadResult = { sessionIndex: number; content: string | null; contentHash: string | null; contentLength: number };
export interface MotaEditorBridge {
  read(input: MotaEditorReadInput): Promise<MotaEditorReadResult>;
  save(input: MotaEditorSaveInput): Promise<MotaEditorProjection['operations'][number]>;
  close(input: MotaEditorCloseInput): Promise<void>;
  status(input: MotaEditorStatusInput): Promise<MotaEditorProjection>;
  onState(listener: (state: MotaEditorProjection) => void): () => void;
}
