import { z } from 'zod';

const AbsolutePath = z.string().min(1).max(4096).startsWith('/');
export const SshSettingsSchema = z
  .object({
    host: z.string().min(1).max(253),
    port: z.number().int().min(1).max(65535),
    username: z.string().min(1).max(200),
    hostKeySha256: z.string().regex(/^[a-f0-9]{64}$/i),
    root: AbsolutePath,
  })
  .strict();
export const RuntimeConfigSchema = z
  .object({
    schemaVersion: z.literal(1),
    sbxBinary: AbsolutePath.nullable(),
    sandbox: z
      .string()
      .regex(/^wsl-competition-[a-f0-9-]{36}$/)
      .nullable(),
    pythonBinary: AbsolutePath,
    localRoot: AbsolutePath.nullable(),
    ssh: SshSettingsSchema.nullable(),
  })
  .strict();
export type RuntimeConfig = z.infer<typeof RuntimeConfigSchema>;
export const ServiceRuntimeConfigSchema = RuntimeConfigSchema.extend({
  sandbox: z.string().min(1).max(200).nullable(),
  sshAgent: AbsolutePath.nullable(),
}).strict();
export type ServiceRuntimeConfig = z.infer<typeof ServiceRuntimeConfigSchema>;
export const SetupStageSchema = z.enum(['check', 'sbx', 'docker-login', 'sandbox', 'tools', 'model-login', 'probe', 'ready']);
export const SetupSnapshotSchema = z
  .object({
    schemaVersion: z.literal(1),
    stage: SetupStageSchema,
    busy: z.boolean(),
    error: z.object({ code: z.string(), message: z.string() }).strict().nullable(),
    pendingLogin: z
      .object({ id: z.string().uuid(), provider: z.enum(['docker', 'openai']) })
      .strict()
      .nullable(),
    modelCredentialsConfigured: z.boolean(),
    modelConnectionVerified: z.literal(false),
    config: RuntimeConfigSchema,
    restartRequired: z.boolean(),
  })
  .strict();
export type SetupSnapshot = z.infer<typeof SetupSnapshotSchema>;
export const SetupSettingsSchema = z.object({ localRoot: AbsolutePath.nullable(), ssh: SshSettingsSchema.nullable() }).strict();
export const SetupLoginSchema = z.object({ provider: z.enum(['docker', 'openai']), acknowledgeGlobalCredentials: z.boolean() }).strict();
const PayloadSchema = z
  .object({
    path: z
      .string()
      .min(1)
      .refine((value) => !value.startsWith('/') && !value.split('/').includes('..')),
    sha256: z.string().regex(/^[a-f0-9]{64}$/),
    expandedBytes: z.number().int().positive(),
    source: z.string().url(),
    license: z.string().min(1),
  })
  .strict();
export const DependencyManifestSchema = z
  .object({
    schemaVersion: z.literal(1),
    platform: z.literal('darwin-arm64'),
    minimumFreeBytes: z.number().int().positive(),
    python: PayloadSchema.extend({
      version: z.string().min(1),
      archiveSha256: z.string().regex(/^[a-f0-9]{64}$/),
      executable: z.string().min(1),
    }).strict(),
    guest: PayloadSchema.extend({ node: z.literal('24.21.0'), pnpm: z.literal('10.34.6'), codex: z.literal('0.160.0') }).strict(),
    baseImage: z.literal('docker.io/docker/sandbox-templates@sha256:8b4cd0a46c8b600bc6b6a64af23c03d4c2807fbfc61f47568092a93fb9dc88b0'),
  })
  .strict();
export type DependencyManifest = z.infer<typeof DependencyManifestSchema>;
