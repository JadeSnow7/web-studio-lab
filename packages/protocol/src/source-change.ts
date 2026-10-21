import { z } from 'zod';
import { AppTargetSchema } from './managed-app';

export const SOURCE_MAX_BYTES = 200 * 1024 * 1024;
export const SOURCE_MAX_FILES = 20000;
export const SOURCE_MAX_DIRECTORIES = 20000;
export const SOURCE_CHUNK_BYTES = 48 * 1024;
export const SOURCE_TRANSPORT_MAX_BYTES = 352 * 1024 * 1024;
export const SOURCE_PATCH_MAX_BYTES = 256 * 1024;
export const SOURCE_DIFF_MAX_FILES = 200;

const utf8Bytes = (value: string): number => {
  let bytes = 0;
  for (const char of value) {
    const code = char.codePointAt(0) ?? 0;
    bytes += code < 128 ? 1 : code < 2048 ? 2 : code < 65536 ? 3 : 4;
  }
  return bytes;
};
const excluded = new Set([
  'node_modules',
  'dist',
  '.data',
  'data',
  '.vite',
  '.git',
  '.env',
  '.npmrc',
  '.netrc',
  '.pypirc',
  '.git-credentials',
  '.ssh',
  '.aws',
  '.azure',
  '.gnupg',
  '.codex',
  '.docker',
  'id_rsa',
  'id_dsa',
  'id_ecdsa',
  'id_ed25519',
  'id_ecdsa_sk',
  'id_ed25519_sk',
]);
export const SourcePathSchema = z
  .string()
  .min(1)
  .max(1024)
  .refine((value) => {
    if (value.length > 1024) return false;
    const parts = value.split('/');
    return (
      utf8Bytes(value) <= 1024 &&
      value.normalize('NFC') === value &&
      !value.includes('\\') &&
      !value.includes(':') &&
      !/[\p{Cc}\p{Cf}\p{Cs}\p{Zl}\p{Zp}]/u.test(value) &&
      parts.length <= 64 &&
      parts.every((part) => part !== '' && part !== '.' && part !== '..' && !/[. ]$/.test(part)) &&
      parts.every(
        (part) => !excluded.has(part.toLowerCase()) && !part.toLowerCase().startsWith('.wsl-') && !part.toLowerCase().startsWith('.env.'),
      )
    );
  }, '不安全或不支持的源码路径');
const base64Bytes = (value: string) => (value.length / 4) * 3 - (value.endsWith('==') ? 2 : value.endsWith('=') ? 1 : 0);
const base64 = (maxBytes: number) =>
  z
    .string()
    .max(Math.ceil(maxBytes / 3) * 4)
    .refine((value) => {
      const padding = value.endsWith('==') ? 2 : value.endsWith('=') ? 1 : 0;
      if (
        value.length % 4 !== 0 ||
        base64Bytes(value) > maxBytes ||
        /[^A-Za-z0-9+/=]/.test(value) ||
        value.indexOf('=') !== (padding ? value.length - padding : -1)
      )
        return false;
      const alphabet = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/';
      if (value.endsWith('==')) return alphabet.indexOf(value.at(-3) ?? '') % 16 === 0;
      if (value.endsWith('=')) return alphabet.indexOf(value.at(-2) ?? '') % 4 === 0;
      return true;
    }, '无效或超限的源码编码');
export const SourceFileSchema = z
  .object({ path: SourcePathSchema, mode: z.enum(['100644', '100755']), base64: base64(SOURCE_MAX_BYTES) })
  .strict();
export const AppSourceSnapshotSchema = AppTargetSchema.extend({
  files: z.array(SourceFileSchema).max(SOURCE_MAX_FILES),
  totalBytes: z.number().int().min(0).max(SOURCE_MAX_BYTES),
})
  .strict()
  .superRefine((snapshot, context) => {
    if (snapshot.files.length > SOURCE_MAX_FILES) return;
    let bytes = 0;
    const paths = new Map<string, string>();
    const directories = new Map<string, string>();
    for (const file of snapshot.files) {
      if (file.path.length > 1024) return;
      bytes += base64Bytes(file.base64);
      const folded = file.path.toUpperCase().toLowerCase().normalize('NFC');
      const parts = file.path.split('/');
      if (parts.length > 64) return;
      let invalid = paths.has(folded) || directories.has(folded);
      for (let i = 1; i < parts.length; i++) {
        const directory = parts.slice(0, i).join('/');
        const key = directory.toUpperCase().toLowerCase().normalize('NFC');
        if (paths.has(key) || (directories.has(key) && directories.get(key) !== directory)) invalid = true;
        directories.set(key, directory);
        if (directories.size > SOURCE_MAX_DIRECTORIES) {
          context.addIssue({ code: 'custom', message: '源码目录数量超限' });
          return;
        }
      }
      paths.set(folded, file.path);
      if (invalid) context.addIssue({ code: 'custom', message: '源码路径重复、大小写或文件目录冲突' });
    }
    if (bytes !== snapshot.totalBytes || bytes > SOURCE_MAX_BYTES)
      context.addIssue({ code: 'custom', message: '源码字节预算或回执不一致' });
  });
export const AppSourceSnapshotResultSchema = z.discriminatedUnion('ok', [
  z.object({ ok: z.literal(true), cleanupConfirmed: z.literal(true), snapshot: AppSourceSnapshotSchema }).strict(),
  z.object({ ok: z.literal(false), target: AppTargetSchema, cleanupConfirmed: z.boolean(), error: z.string().min(1).max(1000) }).strict(),
]);
export type AppSourceSnapshotResult = z.infer<typeof AppSourceSnapshotResultSchema>;
export const SourceSnapshotFrameSchema = z.discriminatedUnion('type', [
  z.object({ type: z.literal('file'), path: SourcePathSchema, mode: SourceFileSchema.shape.mode }).strict(),
  z.object({ type: z.literal('chunk'), base64: base64(SOURCE_CHUNK_BYTES) }).strict(),
  z.object({ type: z.literal('end-file') }).strict(),
  z
    .object({
      type: z.literal('complete'),
      totalBytes: z.number().int().min(0).max(SOURCE_MAX_BYTES),
      fileCount: z.number().int().min(0).max(SOURCE_MAX_FILES),
    })
    .strict(),
]);
const tree = z
  .string()
  .length(40)
  .regex(/^[a-f0-9]{40}$/);
export const SourceChangeFileSchema = z
  .object({
    path: SourcePathSchema,
    change: z.enum(['added', 'modified', 'deleted', 'renamed']),
    additions: z.number().int().nonnegative(),
    deletions: z.number().int().nonnegative(),
    binary: z.boolean(),
  })
  .strict();
export const CapturedSourceChangeSchema = z
  .object({
    state: z.literal('captured'),
    baseTree: tree,
    afterTree: tree,
    files: z.array(SourceChangeFileSchema).max(SOURCE_DIFF_MAX_FILES),
    additions: z.number().int().nonnegative(),
    deletions: z.number().int().nonnegative(),
    truncated: z.boolean(),
    patchSha256: z
      .string()
      .length(64)
      .regex(/^[a-f0-9]{64}$/),
  })
  .strict();
export const SourceChangeSchema = z.discriminatedUnion('state', [
  z.object({ state: z.literal('baseline'), baseTree: tree }).strict(),
  CapturedSourceChangeSchema,
  z.object({ state: z.literal('unavailable'), reason: z.string().min(1).max(1000) }).strict(),
]);
export const RunPatchQuerySchema = z.object({ workspaceId: z.string().min(1).max(200), runId: z.uuid() }).strict();
export const RunPatchResultSchema = RunPatchQuerySchema.extend({
  patchSha256: CapturedSourceChangeSchema.shape.patchSha256,
  patch: z
    .string()
    .max(SOURCE_PATCH_MAX_BYTES)
    .refine((text) => utf8Bytes(text) <= SOURCE_PATCH_MAX_BYTES, 'diff 超出字节预算'),
}).strict();
export type AppSourceSnapshot = z.infer<typeof AppSourceSnapshotSchema>;
export type SourceSnapshotFrame = z.infer<typeof SourceSnapshotFrameSchema>;
export type SourceChange = z.infer<typeof SourceChangeSchema>;
export type SourceChangeFile = z.infer<typeof SourceChangeFileSchema>;
export type CapturedSourceChange = z.infer<typeof CapturedSourceChangeSchema>;
export type RunPatchResult = z.infer<typeof RunPatchResultSchema>;
