import { z } from 'zod';
import { ResourceInstanceIdentitySchema } from './observation';

export const EnvironmentDescriptionSchema = z
  .object({
    environmentId: z.enum(['local', 'sandbox', 'ssh']),
    kind: z.enum(['local', 'sandbox', 'ssh']),
    label: z.string().min(1).max(200),
    state: z.enum(['configured', 'unavailable']),
    reason: z.string().max(2000).nullable(),
    capabilities: z.object({ files: z.boolean(), terminal: z.boolean(), browser: z.boolean() }).strict(),
  })
  .strict();
export const EnvironmentListSchema = z.array(EnvironmentDescriptionSchema).max(3);
export type EnvironmentDescription = z.infer<typeof EnvironmentDescriptionSchema>;
export const RuntimeResourceIdentitySchema = ResourceInstanceIdentitySchema.refine(
  (identity) => identity.kind !== 'browser',
  'Browser instances are owned by Main',
);
