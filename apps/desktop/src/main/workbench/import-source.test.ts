import { describe, expect, it } from 'vitest';
import { MOTA_REQUIRED_FILES, type EduImport } from '@wsl/protocol';
import type { MotaImportSource } from './ports';
import { describeImport, importError } from './import-source';

function input(contents: string): Pick<EduImport, 'source' | 'files'> {
  return {
    source: {
      repository: { commit: 'a'.repeat(40), dirty: true },
      sourceSha256: 'b'.repeat(64),
      files: [{ path: 'admin/package.json', bytes: Buffer.byteLength(contents), sha256: 'c'.repeat(64) }],
    },
    files: [{ path: 'admin/package.json', base64: Buffer.from(contents).toString('base64') }],
  };
}
describe('static edu profile preview', () => {
  it('reports supported metadata without exposing script values or source bytes', () => {
    const preview = describeImport(
      input(JSON.stringify({ scripts: { build: 'echo private-build-token', typecheck: 'echo private-check-token' } })),
      'example\n',
    );
    expect(preview).toMatchObject({ name: 'example', profile: 'edu-web', fileCount: 1 });
    expect(preview.warnings.join(' ')).toMatch(/安装锁定依赖/);
    expect(JSON.stringify(preview)).not.toMatch(/private-build-token|private-check-token|base64/);
  });
  it.each(['[]', '{}', '{', '{"scripts":{"build":1,"typecheck":"tsc"}}'])('rejects unsupported package metadata %s', (contents) => {
    expect(() => describeImport(input(contents), 'example')).toThrow();
  });
  it('does not disclose arbitrary filesystem, Git, or provider errors', () => {
    expect(importError(new Error('/Users/private/.env TOKEN=do-not-show'))).toEqual({
      code: 'source_unavailable',
      message: '无法安全检查工程。请选择可读取的本机 edu-web Git 根目录或魔塔工程目录后重试。',
    });
  });
});

describe('static mota profile preview', () => {
  const source: MotaImportSource = {
    profile: 'mota-web',
    source: { sourceSha256: 'a'.repeat(64), files: MOTA_REQUIRED_FILES.map((path) => ({ path, sha256: 'b'.repeat(64), bytes: 0 })) },
    files: MOTA_REQUIRED_FILES.map((path) => ({ path, base64: '' })),
  };
  it('uses the explicit profile without requiring Git or leaking payloads', () => {
    const preview = describeImport(source, '魔塔\n');
    expect(preview).toMatchObject({ name: '魔塔', profile: 'mota-web', fileCount: MOTA_REQUIRED_FILES.length, totalBytes: 0 });
    expect(preview).not.toHaveProperty('repository');
    expect(preview.warnings.join(' ')).toContain('不执行工程脚本');
    expect(preview.warnings.join(' ')).toContain('暂不支持任意改码或源码导出');
    expect(JSON.stringify(preview)).not.toContain('base64');
  });
  it('rejects partial Mota structures without falling back to edu', () => {
    expect(() => describeImport({ ...source, files: source.files.slice(1) }, '魔塔')).toThrow();
  });
});
