import { describe, expect, it } from 'vitest';
import { AppSourceSchema } from './managed-app';

const bytes = (size: number) => 'YWFh'.repeat(Math.floor(size / 3)) + ['', 'YQ==', 'YWE='][size % 3];
const file = (base64: string, path = 'source.txt') => ({ path, base64 });
const source = (files: ReturnType<typeof file>[]) => ({ files, sha256: 'a'.repeat(64) });

describe('standard app export wire contract', () => {
  it.each([524287, 524288, 524289])('bounds a single decoded file at %i bytes', (size) => {
    expect(AppSourceSchema.safeParse(source([file(bytes(size))])).success).toBe(size <= 524288);
  });
  it.each([524287, 524288, 524289])('bounds aggregate decoded bytes at %i', (size) => {
    expect(AppSourceSchema.safeParse(source([file(bytes(262144)), file(bytes(size - 262144), 'second')])).success).toBe(size <= 524288);
  });
  it.each([0, 255, 256, 257])('bounds file count at %i', (count) => {
    expect(AppSourceSchema.safeParse(source(Array.from({ length: count }, (_, i) => file('', String(i))))).success).toBe(
      count > 0 && count <= 256,
    );
  });
  it.each(['', 'Zg==', 'Zm8=', 'Zm9v', '5Lit5paH'])('accepts valid encoding %j', (encoded) => {
    expect(AppSourceSchema.safeParse(source([file(encoded)])).success).toBe(true);
  });
  it.each(['Zg', 'Zg=', 'Zg===', 'Zm=8', 'Z g==', 'Zg==\n', '!!!!', '中文', '===='])('rejects malformed encoding %j', (encoded) => {
    expect(AppSourceSchema.safeParse(source([file(encoded)])).success).toBe(false);
  });
  it.each(['', '!'])('rejects an overlong encoded string structurally, suffix %j', (suffix) => {
    let result: ReturnType<typeof AppSourceSchema.safeParse> | undefined;
    expect(() => {
      result = AppSourceSchema.safeParse(source([file(bytes(4 * 1024 * 1024) + suffix)]));
    }).not.toThrow();
    expect(result?.success).toBe(false);
  });
  it.each([{ profile: { projectKind: 'standard-app' } }, { budget: { maxFiles: 512, maxSourceBytes: 8388608 } }])(
    'rejects export contract extensions %j',
    (extra) => {
      expect(AppSourceSchema.safeParse({ ...source([file('')]), ...extra }).success).toBe(false);
    },
  );
});
