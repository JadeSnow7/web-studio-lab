import { z } from 'zod';
export const EDU_SOURCE_BYTES = 524288;
// Encoding overhead is separate from the decoded 256-file / 512 KiB source budget.
// For 500 UTF-16 units/path: JSON needs <=6 bytes/unit, nested JSON <=7.
// Sum(base64 lengths) <= 4*floor((524288+2*256)/3) = 699732.
// With fixed fields and a <=128 KiB JSON-encoded trusted helper: request <=2276436,
// start+LF <=2703700, ASCII-escaped import receipt <=802560 bytes.
export const APP_SOURCE_TRANSPORT = Object.freeze({
  startFrameBytes: 3 * 1024 * 1024,
  requestBytes: 3 * 1024 * 1024,
  importResultBytes: 1024 * 1024,
  helperJsonBytes: 128 * 1024,
});
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
      .refine((files) => files.length > 256 || new Set(files.map((file) => file.path)).size === files.length, 'duplicate source path')
      .refine(
        (files) => files.length > 256 || files.reduce((total, file) => total + file.bytes, 0) <= EDU_SOURCE_BYTES,
        'source byte budget exceeded',
      ),
  })
  .strict();
export const AppProfileSchema = z.discriminatedUnion('projectKind', [
  z.object({ projectKind: z.literal('standard-app'), profileVersion: z.literal(1) }).strict(),
  z.object({ projectKind: z.literal('edu-web'), profileVersion: z.literal(1), source: EduSourceSchema }).strict(),
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
export const AppSourceSchema = z
  .object({ files: exportFiles, sha256: z.string().regex(/^[a-f0-9]{64}$/), profile: AppProfileSchema.optional() })
  .strict();
export const EduImportSchema = AppTargetSchema.extend({ files: exportFiles, source: EduSourceSchema }).strict();
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
/** 受管 App 工程在 sandbox guest 中的唯一工作目录（AppService 创建与恢复时使用同一规则）。 */
export const GUEST_APPS_ROOT = '/home/agent/workspace/.wsl-apps';
export const guestAppCwd = (projectId: string): string => `${GUEST_APPS_ROOT}/${projectId}`;
export type AppTarget = z.infer<typeof AppTargetSchema>;
export type AppSource = z.infer<typeof AppSourceSchema>;

export type AppProfile = z.infer<typeof AppProfileSchema>;
export type EduSource = z.infer<typeof EduSourceSchema>;
export type EduImport = z.infer<typeof EduImportSchema>;

export function appExportBudget(profile?: AppProfile) {
  if (profile && (profile.profileVersion !== 1 || !['standard-app', 'edu-web'].includes(profile.projectKind)))
    throw new Error('unsupported source export profile');
  return { ...STANDARD_APP_EXPORT_BUDGET };
}
