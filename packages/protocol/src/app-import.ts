import { z } from 'zod';
import { AppTargetSchema, EduImportSchema, ManagedAppSchema } from './managed-app';

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
export const AppImportViewSchema = z
  .object({
    previewId: z.uuid(),
    phase: z.enum(['selecting', 'scanning', 'ready', 'copying', 'starting', 'cancelling', 'cancelled', 'failed', 'completed']),
    preview: EduAppImportPreviewSchema.nullable(),
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
export const AppImportRequestSchema = EduAppImportRequestSchema;
export const AppImportTargetSchema = AppTargetSchema.extend({ importOperationId: z.uuid() }).strict();
export const AppImportOutcomeSchema = z
  .object({
    app: ManagedAppSchema.nullable(),
    outcome: z.enum(['imported', 'cancelled', 'failed']),
    retryable: z.boolean(),
    errorCode: z.string().max(100).nullable(),
  })
  .strict();
export const AppImportPreviewSchema = EduAppImportPreviewSchema;
export type AppImportPreview = z.infer<typeof AppImportPreviewSchema>;
export type EduAppImportPreview = z.infer<typeof EduAppImportPreviewSchema>;
export type AppImportView = z.infer<typeof AppImportViewSchema>;
export type AppImportRequest = z.infer<typeof AppImportRequestSchema>;
export type EduAppImportRequest = z.infer<typeof EduAppImportRequestSchema>;
export type AppImportTarget = z.infer<typeof AppImportTargetSchema>;
export type AppImportOutcome = z.infer<typeof AppImportOutcomeSchema>;
