import { z } from 'zod';
import { AppTargetSchema } from './managed-app';
const uuid = z.string().regex(/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/);
export const EduVerificationIdentitySchema = AppTargetSchema.extend({
  environmentId: z.literal('sandbox'),
  appInstanceId: uuid,
}).strict();
export const EduVerificationBeginSchema = AppTargetSchema.extend({
  appInstanceId: uuid,
  sourceSha256: z.string().regex(/^[a-f0-9]{64}$/),
}).strict();
export const EduVerificationTargetSchema = AppTargetSchema.extend({ appInstanceId: uuid, sessionId: uuid }).strict();
export const EduVerificationLeaseSchema = z
  .object({
    schemaVersion: z.literal(1),
    sessionId: uuid,
    identity: EduVerificationIdentitySchema,
    sourceSha256: z.string().regex(/^[a-f0-9]{64}$/),
    expiresAtMs: z.number().int().positive().max(Number.MAX_SAFE_INTEGER),
  })
  .strict();
export const EduVerificationStatusSchema = z
  .object({
    lease: EduVerificationLeaseSchema,
    phase: z.enum(['preparing', 'active', 'revoking', 'restoring', 'revoked', 'ended', 'failed']),
    callsUsed: z.number().int().min(0).max(2),
    maintenanceLocked: z.boolean(),
    error: z.string().max(200).nullable(),
  })
  .strict();
export type EduVerificationLease = z.infer<typeof EduVerificationLeaseSchema>;
export type EduVerificationStatus = z.infer<typeof EduVerificationStatusSchema>;
export type EduVerificationBegin = z.infer<typeof EduVerificationBeginSchema>;
export type EduVerificationTarget = z.infer<typeof EduVerificationTargetSchema>;

export const EduAdmissionRecoveryStatusSchema = z
  .object({
    schemaVersion: z.literal(1),
    kind: z.literal('admission-recovery'),
    recoveryId: uuid,
    originalIdentity: EduVerificationIdentitySchema,
    sourceSha256: z.string().regex(/^[a-f0-9]{64}$/),
    phase: z.enum(['revoking', 'restoring', 'ended', 'failed']),
    restoredIdentity: EduVerificationIdentitySchema.nullable(),
    maintenanceLocked: z.boolean(),
    error: z.string().max(200).nullable(),
  })
  .strict()
  .refine((status) => {
    const restored = status.restoredIdentity;
    if (!restored) return status.phase !== 'restoring' && status.phase !== 'ended';
    return (
      restored.workspaceId === status.originalIdentity.workspaceId &&
      restored.projectId === status.originalIdentity.projectId &&
      restored.environmentId === status.originalIdentity.environmentId &&
      restored.appInstanceId !== status.originalIdentity.appInstanceId
    );
  });
export type EduAdmissionRecoveryStatus = z.infer<typeof EduAdmissionRecoveryStatusSchema>;
