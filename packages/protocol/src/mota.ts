import { z } from 'zod';

export const MOTA_SOURCE_MAX_FILES = 512;
export const MOTA_SOURCE_BYTES = 64 * 1024 * 1024;
export const MOTA_SOURCE_FILE_BYTES = 12 * 1024 * 1024;
export const MOTA_SOURCE_BASE64_BYTES = 16 * 1024 * 1024;
export const MOTA_ROOT_FILES = ['index.html', 'editor.html', 'editor-mobile.html', 'styles.css', 'main.js', 'logo.png'];
export const MOTA_ROOT_DIRS = ['project', 'libs', 'extensions', '_server', '_docs'];
export const MOTA_REQUIRED_FILES = [
  'index.html',
  'editor.html',
  'main.js',
  'libs/core.js',
  'project/data.js',
  'project/floors/MT1.js',
  '_server/editor.js',
  '_server/editor_file.js',
];

const excludedNames = new Set([
  'node_modules',
  '__pycache__',
  'credentials',
  'credential',
  'secrets',
  'secret',
  'password',
  'passwords',
  'passwd',
  'token',
  'tokens',
  'access_token',
  'refresh_token',
  'authorized_keys',
  'known_hosts',
]);
const credentialFile =
  /^(?:credentials?|secrets?|passwords?|passwd|tokens?|access_token|refresh_token)\.(?:json|txt|ya?ml|toml|ini|conf|env)$/i;
const privateKeyFile = /^(?:id_rsa|id_dsa|id_ecdsa|id_ed25519)(?:\.|$)/i;
const excludedExtension = /\.(?:pem|key|p12|pfx|keystore|py|pyc|sh|bash|zsh|bat|cmd|ps1|exe|dll|so|dylib)$/i;
const serverEntry = /^(?:(?:safe-)?mota-)?server\.(?:js|cjs|mjs|py)$/i;

/** A source name is data only; supplied server entrypoints and credentials never enter the managed copy. */
export function isMotaExcludedName(name: string): boolean {
  return (
    !name ||
    name.startsWith('.') ||
    excludedNames.has(name.toLowerCase()) ||
    credentialFile.test(name) ||
    privateKeyFile.test(name) ||
    excludedExtension.test(name) ||
    serverEntry.test(name)
  );
}

/** Canonical relative file paths. HTTP adapters may normalize one leading ./ before calling this predicate. */
export function isMotaSourcePath(value: string): boolean {
  if (!value || value.length > 500 || /[\\%?#:]/.test(value)) return false;
  if ([...value].some((character) => character.charCodeAt(0) < 32 || character.charCodeAt(0) === 127)) return false;
  const parts = value.split('/');
  if (parts.some(isMotaExcludedName)) return false;
  return parts.length === 1 ? MOTA_ROOT_FILES.includes(value) : MOTA_ROOT_DIRS.includes(parts[0]!);
}

const sha256 = z.string().regex(/^[a-f0-9]{64}$/);
export const MotaSourceManifestFileSchema = z
  .object({ path: z.string().refine(isMotaSourcePath), sha256, bytes: z.number().int().min(0).max(MOTA_SOURCE_FILE_BYTES) })
  .strict();
export const MotaSourceSchema = z
  .object({
    sourceSha256: sha256,
    files: z
      .array(MotaSourceManifestFileSchema)
      .min(MOTA_REQUIRED_FILES.length)
      .max(MOTA_SOURCE_MAX_FILES)
      .refine((files) => new Set(files.map((file) => file.path)).size === files.length, 'duplicate source path')
      .refine((files) => files.reduce((total, file) => total + file.bytes, 0) <= MOTA_SOURCE_BYTES, 'source byte budget exceeded')
      .refine(
        (files) => MOTA_REQUIRED_FILES.every((required) => files.some((file) => file.path === required)),
        'missing required mota file',
      ),
  })
  .strict();

/** Validate canonical base64 without allocating decoded copies of a large asset. */
export function motaBase64ByteLength(value: string): number | null {
  if (value.length > MOTA_SOURCE_BASE64_BYTES || value.length % 4 !== 0) return null;
  const padding = value.endsWith('==') ? 2 : value.endsWith('=') ? 1 : 0;
  const body = value.slice(0, value.length - padding);
  if (/[^A-Za-z0-9+/]/.test(body) || (padding && !body)) return null;
  const last = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/'.indexOf(body.at(-1) ?? '');
  if ((padding === 2 && last % 16 !== 0) || (padding === 1 && last % 4 !== 0)) return null;
  return (value.length / 4) * 3 - padding;
}
export const MotaSourceFileSchema = z
  .object({
    path: z.string().refine(isMotaSourcePath),
    base64: z
      .string()
      .max(MOTA_SOURCE_BASE64_BYTES)
      .refine((value) => motaBase64ByteLength(value) !== null, 'invalid canonical base64'),
  })
  .strict();

// Target identity is composed by the service request schema; this payload contains no host path or executable command.
export const MotaImportSchema = z
  .object({ source: MotaSourceSchema, files: z.array(MotaSourceFileSchema).min(MOTA_REQUIRED_FILES.length).max(MOTA_SOURCE_MAX_FILES) })
  .strict()
  .superRefine(({ source, files }, context) => {
    const paths = new Set(files.map((file) => file.path));
    if (paths.size !== files.length || paths.size !== source.files.length || source.files.some((file) => !paths.has(file.path)))
      context.addIssue({ code: 'custom', message: 'manifest and payload paths must match exactly', path: ['files'] });
    const metadata = new Map(source.files.map((file) => [file.path, file]));
    for (const [index, file] of files.entries())
      if (metadata.get(file.path)?.bytes !== motaBase64ByteLength(file.base64))
        context.addIssue({ code: 'custom', message: 'payload byte length differs from manifest', path: ['files', index, 'base64'] });
  });

export type MotaSourceManifestFile = z.infer<typeof MotaSourceManifestFileSchema>;
export type MotaSource = z.infer<typeof MotaSourceSchema>;
export type MotaSourceFile = z.infer<typeof MotaSourceFileSchema>;
export type MotaImport = z.infer<typeof MotaImportSchema>;

/** SHA-256 this exact UTF-8 string in Main/service after checking the actual file bytes and hashes. */
export function motaSourceIdentityInput(files: readonly MotaSourceManifestFile[]): string {
  return JSON.stringify(
    [...files]
      .sort((left, right) => (left.path < right.path ? -1 : left.path > right.path ? 1 : 0))
      .map(({ path, sha256, bytes }) => ({ path, sha256, bytes })),
  );
}
