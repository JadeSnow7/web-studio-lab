import { z } from 'zod';
import { AppTargetSchema, EduImportSchema, ManagedAppSchema } from './managed-app';
import { MOTA_REQUIRED_FILES, MOTA_SOURCE_BYTES, MOTA_SOURCE_MAX_FILES, MotaImportSchema } from './mota';

export const EduAppImportPreviewSchema = z
  .object({
    name: z.string().min(1).max(200),
    profile: z.literal('edu-web'),
    profileVersion: z.literal(1),
    repository: z.object({ commit: z.string().regex(/^[a-f0-9]{40}$/), dirty: z.boolean() }).strict(),
    sourceSha256: z.string().regex(/^[a-f0-9]{64}$/),
    fileCount: z.number().int().min(1).max(256),
    totalBytes: z.number().int().nonnegative().max(524288),
    warnings: z.array(z.string().max(500)).max(10),
  })
  .strict();
export const MotaAppImportPreviewSchema = z
  .object({
    name: z.string().min(1).max(200),
    profile: z.literal('mota-web'),
    profileVersion: z.literal(1),
    sourceSha256: z.string().regex(/^[a-f0-9]{64}$/),
    fileCount: z.number().int().min(MOTA_REQUIRED_FILES.length).max(MOTA_SOURCE_MAX_FILES),
    totalBytes: z.number().int().nonnegative().max(MOTA_SOURCE_BYTES),
    warnings: z.array(z.string().max(500)).max(10),
  })
  .strict();
export const AppImportPreviewSchema = z.discriminatedUnion('profile', [EduAppImportPreviewSchema, MotaAppImportPreviewSchema]);
export const AppImportViewSchema = z
  .object({
    previewId: z.uuid(),
    phase: z.enum(['selecting', 'scanning', 'ready', 'copying', 'starting', 'cancelling', 'cancelled', 'failed', 'completed']),
    preview: AppImportPreviewSchema.nullable(),
    progress: z.object({ files: z.number().int().nonnegative(), bytes: z.number().int().nonnegative() }).strict(),
    error: z
      .object({ code: z.string().max(100), message: z.string().max(1000) })
      .strict()
      .nullable(),
    canCancel: z.boolean(),
    canRetry: z.boolean(),
    projectId: z.uuid().nullable(),
    published: z.boolean(),
  })
  .strict();
export const EduAppImportRequestSchema = EduImportSchema.extend({ importOperationId: z.uuid() }).strict();
export const MotaAppImportRequestSchema = MotaImportSchema.safeExtend({
  ...AppTargetSchema.shape,
  profile: z.literal('mota-web'),
  importOperationId: z.uuid(),
}).strict();
export const AppImportRequestSchema = z.union([EduAppImportRequestSchema, MotaAppImportRequestSchema]);
export const AppImportTargetSchema = AppTargetSchema.extend({ importOperationId: z.uuid() }).strict();
export const AppImportOutcomeSchema = z
  .object({
    app: ManagedAppSchema.nullable(),
    outcome: z.enum(['imported', 'cancelled', 'failed']),
    retryable: z.boolean(),
    errorCode: z.string().max(100).nullable(),
  })
  .strict();
export type AppImportPreview = z.infer<typeof AppImportPreviewSchema>;
export type EduAppImportPreview = z.infer<typeof EduAppImportPreviewSchema>;
export type MotaAppImportPreview = z.infer<typeof MotaAppImportPreviewSchema>;
export type AppImportView = z.infer<typeof AppImportViewSchema>;
export type AppImportRequest = z.infer<typeof AppImportRequestSchema>;
export type EduAppImportRequest = z.infer<typeof EduAppImportRequestSchema>;
export type MotaAppImportRequest = z.infer<typeof MotaAppImportRequestSchema>;
export type AppImportTarget = z.infer<typeof AppImportTargetSchema>;
export type AppImportOutcome = z.infer<typeof AppImportOutcomeSchema>;
