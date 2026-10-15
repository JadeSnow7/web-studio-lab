import { z } from 'zod';
import { EduSourceSchema } from './managed-app';

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
