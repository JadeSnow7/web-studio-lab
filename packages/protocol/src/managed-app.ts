import { z } from 'zod';
import { MotaSourceSchema } from './mota';

export const EDU_SOURCE_BYTES = 524288;
export const EDU_ROOT_FILES = ['README.md', 'SPEC.md', 'API.md', 'DESIGN.md', 'UX-CONTRACT.md', 'AGENTS.md'];
export const EDU_REQUIRED_FILES = [
  'admin/package.json',
  'admin/package-lock.json',
  'server/app.py',
  'server/requirements.lock',
  'server/requirements-test.lock',
  'server/wsl_runtime.py',
];
const excluded = new Set([
  '.git',
  'node_modules',
  'dist',
  '.venv',
  'venv',
  '__pycache__',
  '.pytest_cache',
  '.ruff_cache',
  '.mypy_cache',
  '.vite',
  '.data',
  'data',
  '.runtime',
  'coverage',
]);
export function isEduExcludedName(name: string): boolean {
  return excluded.has(name) || name.startsWith('.env') || name.startsWith('.wsl-');
}
export function isEduSourcePath(value: string): boolean {
  if (!value || value.length > 500 || value.includes('\\')) return false;
  if ([...value].some((char) => char.charCodeAt(0) < 32 || char.charCodeAt(0) === 127)) return false;
  const parts = value.split('/');
  if (parts.some((part) => !part || part === '.' || part === '..' || isEduExcludedName(part))) return false;
  if (parts.length === 1) return EDU_ROOT_FILES.includes(value);
  if (value === 'docs/development/webstudiolab.md') return true;
  return (
    (parts[0] === 'admin' && /\.(json|ts|tsx|js|mjs|css|html|md)$/.test(value)) ||
    (parts[0] === 'server' && /\.(py|txt|lock|md)$/.test(value))
  );
}
const sha256 = z.string().regex(/^[a-f0-9]{64}$/);
export const EduSourceSchema = z
  .object({
    repository: z.object({ commit: z.string().regex(/^[a-f0-9]{40}$/), dirty: z.boolean() }).strict(),
    sourceSha256: sha256,
    files: z
      .array(z.object({ path: z.string().refine(isEduSourcePath), sha256, bytes: z.number().int().min(0).max(EDU_SOURCE_BYTES) }).strict())
      .min(1)
      .max(256)
      .refine((files) => new Set(files.map((file) => file.path)).size === files.length, 'duplicate source path')
      .refine((files) => files.reduce((total, file) => total + file.bytes, 0) <= EDU_SOURCE_BYTES, 'source byte budget exceeded'),
  })
  .strict();
export const AppProfileSchema = z.discriminatedUnion('projectKind', [
  z.object({ projectKind: z.literal('standard-app'), profileVersion: z.literal(1) }).strict(),
  z.object({ projectKind: z.literal('edu-web'), profileVersion: z.literal(1), source: EduSourceSchema }).strict(),
  z.object({ projectKind: z.literal('mota-web'), profileVersion: z.literal(1), source: MotaSourceSchema }).strict(),
]);
export const AppTargetSchema = z.object({ workspaceId: z.string().min(1).max(200), projectId: z.uuid() }).strict();
export const SpaceAppSchema = AppTargetSchema.extend({
  appId: z.uuid(),
  name: z.string().trim().min(1).max(200),
  description: z.string().trim().max(2000),
  revision: z.number().int().nonnegative(),
}).strict();
export type SpaceApp = z.infer<typeof SpaceAppSchema>;
export const AppSourceFileSchema = z.object({ path: z.string().min(1).max(500), base64: z.string().max(4_000_000) }).strict();
export const EduImportSchema = AppTargetSchema.extend({ files: z.array(AppSourceFileSchema).min(1).max(256), source: EduSourceSchema });
export const AppSourceSchema = z
  .object({ files: z.array(AppSourceFileSchema).min(1).max(256), sha256, profile: AppProfileSchema.optional() })
  .strict();
export const ManagedAppSchema = AppTargetSchema.extend({
  profile: AppProfileSchema.optional(),
  sourceSha256: sha256.optional(),
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
export type AppProfile = z.infer<typeof AppProfileSchema>;
export type EduSource = z.infer<typeof EduSourceSchema>;
export type EduImport = z.infer<typeof EduImportSchema>;
