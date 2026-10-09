import { z } from 'zod';
export const AppTargetSchema = z.object({ workspaceId: z.string().min(1).max(200), projectId: z.uuid() }).strict();
export const AppSourceFileSchema = z.object({ path: z.string().min(1).max(500), base64: z.string().max(4_000_000) }).strict();
export const AppSourceSchema = z
  .object({ files: z.array(AppSourceFileSchema).min(1).max(256), sha256: z.string().regex(/^[a-f0-9]{64}$/) })
  .strict();
export const ManagedAppSchema = AppTargetSchema.extend({
  environmentId: z.literal('sandbox'),
  appInstanceId: z.string().nullable(),
  state: z.enum(['created', 'starting', 'running', 'stopping', 'stopped', 'failed']),
  url: z.string().nullable(),
  guestCwd: z.string(),
  guestPort: z.number().int().min(1).max(65535).nullable().optional(),
  error: z.string().nullable(),
  cleanupConfirmed: z.boolean(),
});
export type ManagedApp = z.infer<typeof ManagedAppSchema>;
export type AppTarget = z.infer<typeof AppTargetSchema>;
export type AppSource = z.infer<typeof AppSourceSchema>;
