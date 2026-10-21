import { z } from 'zod';
export const AppTargetSchema = z.object({ workspaceId: z.string().min(1).max(200), projectId: z.uuid() }).strict();
export const SpaceAppSchema = AppTargetSchema.extend({
  appId: z.uuid(),
  name: z.string().trim().min(1).max(200),
  description: z.string().trim().max(2000),
  revision: z.number().int().nonnegative(),
}).strict();
export type SpaceApp = z.infer<typeof SpaceAppSchema>;
export const AppSourceFileSchema = z.object({ path: z.string().min(1).max(500), base64: z.string().max(4_000_000) }).strict();
export const STANDARD_APP_EXPORT_BUDGET = Object.freeze({ maxFiles: 256, maxSourceBytes: 524288 });
const exportFiles = z
  .array(
    AppSourceFileSchema.extend({
      base64: z.string().max(Math.ceil(STANDARD_APP_EXPORT_BUDGET.maxSourceBytes / 3) * 4),
    }),
  )
  .min(1)
  .max(STANDARD_APP_EXPORT_BUDGET.maxFiles)
  .superRefine((files, context) => {
    // Zod refinements can still run after max() fails. Bound work before scanning encoding.
    if (files.length > STANDARD_APP_EXPORT_BUDGET.maxFiles) return;
    let remaining = STANDARD_APP_EXPORT_BUDGET.maxSourceBytes;
    for (const [index, file] of files.entries()) {
      const encoded = file.base64;
      const reject = (message: string) => context.addIssue({ code: 'custom', path: [index, 'base64'], message });
      if (encoded.length > Math.ceil(remaining / 3) * 4) {
        reject('应用源码超出传输预算');
        return;
      }
      const padding = encoded.endsWith('==') ? 2 : encoded.endsWith('=') ? 1 : 0;
      const decodedBytes = (encoded.length / 4) * 3 - padding;
      if (decodedBytes > remaining) {
        reject('应用源码超出传输预算');
        return;
      }
      if (encoded.length % 4 !== 0) {
        reject('无效源码编码');
        return;
      }
      // A bounded linear scan avoids recursive regexp backtracking on untrusted strings.
      for (let offset = 0; offset < encoded.length - padding; offset++) {
        const char = encoded.charCodeAt(offset);
        if (!((char >= 65 && char <= 90) || (char >= 97 && char <= 122) || (char >= 48 && char <= 57) || char === 43 || char === 47)) {
          reject('无效源码编码');
          return;
        }
      }
      remaining -= decodedBytes;
    }
  });
export const AppSourceSchema = z.object({ files: exportFiles, sha256: z.string().regex(/^[a-f0-9]{64}$/) }).strict();
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
