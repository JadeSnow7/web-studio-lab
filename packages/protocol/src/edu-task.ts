import { z } from 'zod';
import { EduSourceSchema, ManagedAppSchema } from './managed-app';
import { ChatSlotSchema } from './chat-slot';

// Only Main creates this binding after checking the confirmed page capture.
export const EduTaskBindingSchema = z
  .object({
    runId: z.uuid(),
    workspaceId: z.string().min(1).max(200),
    projectId: z.uuid(),
    appInstanceId: z.uuid(),
    resourceId: z.string().min(1),
    instanceId: z.string().min(1),
    generation: z.number().int().nonnegative(),
    webContentsId: z.number().int().positive(),
    documentGeneration: z.number().int().nonnegative(),
    sourceSha256: z.string().regex(/^[a-f0-9]{64}$/),
    protectedFiles: EduSourceSchema.shape.files,
  })
  .strict();
export type EduTaskBinding = z.infer<typeof EduTaskBindingSchema>;

export const EduTaskOperationSchema = z.enum(['prepare', 'apply', 'cancel']);
export const EduTaskOperationResultSchema = z.union([
  z
    .object({
      binding: EduTaskBindingSchema,
      operation: z.enum(['prepare', 'cancel']),
      ok: z.literal(true),
      cleanupConfirmed: z.literal(true),
    })
    .strict(),
  z
    .object({
      binding: EduTaskBindingSchema,
      operation: z.literal('apply'),
      ok: z.literal(true),
      cleanupConfirmed: z.literal(true),
      app: ManagedAppSchema,
    })
    .strict(),
  z
    .object({
      binding: EduTaskBindingSchema,
      operation: EduTaskOperationSchema,
      ok: z.literal(false),
      cleanupConfirmed: z.boolean(),
      error: z.string().min(1).max(1000),
    })
    .strict(),
]);
export type EduTaskOperation = z.infer<typeof EduTaskOperationSchema>;
export type EduTaskOperationResult = z.infer<typeof EduTaskOperationResultSchema>;

// This receipt proves only that the model entrypoint was not called. Helper cleanup remains a separate owned operation.
export const EduTaskDispatchRejectionSchema = z
  .object({
    kind: z.literal('edu-task-dispatch-rejected'),
    conversationId: ChatSlotSchema,
    binding: EduTaskBindingSchema,
    executorStarted: z.literal(false),
    error: z.string().min(1).max(1000),
  })
  .strict();
export type EduTaskDispatchRejection = z.infer<typeof EduTaskDispatchRejectionSchema>;
