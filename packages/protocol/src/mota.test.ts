import { describe, expect, it } from 'vitest';
import {
  MOTA_REQUIRED_FILES,
  MOTA_ROOT_DIRS,
  MOTA_ROOT_FILES,
  MOTA_SOURCE_BASE64_BYTES,
  MOTA_SOURCE_BYTES,
  MOTA_SOURCE_FILE_BYTES,
  MOTA_SOURCE_MAX_FILES,
  MotaImportSchema,
  MotaSourceFileSchema,
  MotaSourceSchema,
  isMotaExcludedName,
  isMotaSourcePath,
  motaBase64ByteLength,
  motaSourceIdentityInput,
} from './mota';

const metadata = MOTA_REQUIRED_FILES.map((path) => ({ path, sha256: 'a'.repeat(64), bytes: 1 }));
const source = { sourceSha256: 'b'.repeat(64), files: metadata };
const payload = { source, files: metadata.map(({ path }) => ({ path, base64: 'YQ==' })) };

describe('isolated mota source data contract', () => {
  it('uses the fixed server exposure roots and permits browser scripts, editor config and large media assets', () => {
    expect(MOTA_ROOT_FILES).toEqual(['index.html', 'editor.html', 'editor-mobile.html', 'styles.css', 'main.js', 'logo.png']);
    expect(MOTA_ROOT_DIRS).toEqual(['project', 'libs', 'extensions', '_server', '_docs']);
    for (const path of [
      ...MOTA_ROOT_FILES,
      ...MOTA_REQUIRED_FILES,
      '_server/config.json',
      '_server/table/comment.js',
      'project/images/tiles.png',
      'project/sounds/open.mp3',
      'project/fonts/字体.ttf',
      'extensions/custom.js',
      '_docs/index.html',
    ])
      expect(isMotaSourcePath(path), path).toBe(true);
  });
  it.each([
    '',
    '/',
    './index.html',
    '/index.html',
    'C:/project/a.js',
    'project\\a.js',
    'project//a.js',
    'project/../main.js',
    'project/./a.js',
    'project/%2e%2e/a.js',
    'project/a.js?token=x',
    'project/a.js#x',
    'project/a\u0000.js',
    'project/a\u007f.js',
    'README.md',
    'package.json',
    'src/main.js',
    'project',
    'project/.git/config',
    'project/.env',
    'project/.hidden/image.png',
    'project/node_modules/pkg/a.js',
    'project/credentials.json',
    'project/credentials/token.txt',
    '_server/Secrets.yaml',
    'project/access_token.txt',
    'project/id_ed25519',
    'project/id_rsa.pub',
    'project/cert.pem',
    'project/private.key',
    'project/server.js',
    '_server/server.py',
    '_server/server.cjs',
    '_server/safe-mota-server.cjs',
    'project/install.sh',
    'project/tool.exe',
    'project/' + 'x'.repeat(493),
  ])('rejects non-canonical, private or executable path %j', (path) => {
    expect(isMotaSourcePath(path)).toBe(false);
  });
  it('excludes sensitive names without excluding legitimate key images or editor config', () => {
    for (const name of ['.env.local', 'CREDENTIALS', 'secret', 'password.ini', 'server.mjs', 'id_rsa', 'key.pfx'])
      expect(isMotaExcludedName(name), name).toBe(true);
    for (const name of ['key.png', 'config.json', 'editor_file.js', 'main.js']) expect(isMotaExcludedName(name), name).toBe(false);
  });
  it('requires the complete game/editor source without Git or host execution metadata', () => {
    expect(MotaSourceSchema.parse(source)).toEqual(source);
    for (const required of MOTA_REQUIRED_FILES)
      expect(MotaSourceSchema.safeParse({ ...source, files: metadata.filter((file) => file.path !== required) }).success).toBe(false);
    for (const extra of [
      { repository: { commit: 'c'.repeat(40), dirty: false } },
      { hostPath: '/private/source' },
      { command: 'node server.js' },
    ])
      expect(MotaSourceSchema.safeParse({ ...source, ...extra }).success).toBe(false);
    for (const sourceSha256 of ['main', 'a'.repeat(63), 'A'.repeat(64), 'a'.repeat(65)])
      expect(MotaSourceSchema.safeParse({ ...source, sourceSha256 }).success).toBe(false);
    expect(MotaSourceSchema.safeParse({ ...source, files: [...metadata, metadata[0]] }).success).toBe(false);
  });
  it('enforces exact file count, per-file and total byte budgets', () => {
    const maximumFiles = [
      ...metadata,
      ...Array.from({ length: MOTA_SOURCE_MAX_FILES - metadata.length }, (_, index) => ({
        path: `project/assets/${index}.bin`,
        sha256: 'a'.repeat(64),
        bytes: 0,
      })),
    ];
    expect(MotaSourceSchema.safeParse({ ...source, files: maximumFiles }).success).toBe(true);
    expect(MotaSourceSchema.safeParse({ ...source, files: [...maximumFiles, { ...metadata[0], path: 'project/extra.bin' }] }).success).toBe(
      false,
    );
    const total = metadata.map((file, index) => ({
      ...file,
      bytes: index < 5 ? MOTA_SOURCE_FILE_BYTES : index === 5 ? MOTA_SOURCE_BYTES - 5 * MOTA_SOURCE_FILE_BYTES : 0,
    }));
    expect(MotaSourceSchema.safeParse({ ...source, files: total }).success).toBe(true);
    expect(
      MotaSourceSchema.safeParse({ ...source, files: total.map((file, index) => ({ ...file, bytes: file.bytes + (index === 6 ? 1 : 0) })) })
        .success,
    ).toBe(false);
    for (const bytes of [-1, 0.5, MOTA_SOURCE_FILE_BYTES + 1])
      expect(
        MotaSourceSchema.safeParse({ ...source, files: metadata.map((file, index) => (index === 0 ? { ...file, bytes } : file)) }).success,
      ).toBe(false);
  });
  it('validates canonical base64 and the 16 MiB encoded per-file boundary without decoding it', () => {
    for (const [value, bytes] of [
      ['', 0],
      ['YQ==', 1],
      ['YWI=', 2],
      ['YWJj', 3],
    ] as const)
      expect(motaBase64ByteLength(value)).toBe(bytes);
    for (const value of ['YQ', 'YQ=', 'YQ===', 'Y Q=', 'YR==', 'YWJ=', '====', 'YQ==\n', 'YW-J']) {
      expect(motaBase64ByteLength(value), value).toBeNull();
      expect(MotaSourceFileSchema.safeParse({ path: 'project/data.js', base64: value }).success, value).toBe(false);
    }
    const maximum = 'A'.repeat(MOTA_SOURCE_BASE64_BYTES);
    expect(motaBase64ByteLength(maximum)).toBe(MOTA_SOURCE_FILE_BYTES);
    expect(MotaSourceFileSchema.safeParse({ path: 'project/fonts/font.ttf', base64: maximum }).success).toBe(true);
    expect(MotaSourceFileSchema.safeParse({ path: 'project/fonts/font.ttf', base64: maximum + 'AAAA' }).success).toBe(false);
  });
  it('requires the same unique manifest/payload path set and declared byte lengths', () => {
    expect(MotaImportSchema.parse(payload)).toEqual(payload);
    expect(MotaImportSchema.safeParse({ ...payload, files: [...payload.files].reverse() }).success).toBe(true);
    for (const files of [
      payload.files.slice(1),
      [...payload.files, payload.files[0]],
      payload.files.map((file, index) => (index === 0 ? { ...file, path: 'project/foreign.js' } : file)),
      payload.files.map((file, index) => (index === 0 ? { ...file, base64: 'YWI=' } : file)),
    ])
      expect(MotaImportSchema.safeParse({ ...payload, files }).success).toBe(false);
    expect(MotaImportSchema.safeParse({ ...payload, hostPath: '/private/source' }).success).toBe(false);
  });
  it('defines source identity with fixed metadata keys and JS path ordering, independently of input order', () => {
    const files = [
      { bytes: 2, sha256: 'b'.repeat(64), path: 'project/b.js' },
      { bytes: 1, path: 'project/A.js', sha256: 'a'.repeat(64) },
    ];
    const expected = JSON.stringify([
      { path: 'project/A.js', sha256: 'a'.repeat(64), bytes: 1 },
      { path: 'project/b.js', sha256: 'b'.repeat(64), bytes: 2 },
    ]);
    expect(motaSourceIdentityInput(files)).toBe(expected);
    expect(motaSourceIdentityInput([...files].reverse())).toBe(expected);
    expect(motaSourceIdentityInput(files.map((file) => ({ ...file, bytes: file.bytes + 1 })))).not.toBe(expected);
    expect(files[0]?.path).toBe('project/b.js');
  });
});
