import { EduAppImportPreviewSchema, type EduAppImportPreview } from '@wsl/protocol';
import type { AppImportSource } from './ports';

export class ImportFailure extends Error {
  constructor(
    readonly code: string,
    message: string,
  ) {
    super(message);
  }
}

/** Only static data is inspected. Adding a profile requires a separate, reviewed detector and runtime. */
export function describeImport(source: AppImportSource, name: string): EduAppImportPreview {
  const displayName = [...name]
    .filter((character) => character.charCodeAt(0) >= 32 && character.charCodeAt(0) !== 127)
    .join('')
    .trim()
    .slice(0, 200);
  const descriptor = source.files.find((file) => file.path === 'admin/package.json');
  let manifest: unknown;
  try {
    manifest = JSON.parse(Buffer.from(descriptor?.base64 ?? '', 'base64').toString('utf8'));
  } catch {
    throw new ImportFailure('unsupported_profile', '目前支持带受管运行入口的 edu-web 工程；工程描述无法识别。');
  }
  if (!manifest || typeof manifest !== 'object' || Array.isArray(manifest))
    throw new ImportFailure('unsupported_profile', '工程描述格式不受支持。');
  const scripts = (manifest as { scripts?: unknown }).scripts;
  if (
    !scripts ||
    typeof scripts !== 'object' ||
    Array.isArray(scripts) ||
    !['build', 'typecheck'].every((key) => typeof (scripts as Record<string, unknown>)[key] === 'string')
  )
    throw new ImportFailure('unsupported_profile', 'edu-web 工程需要声明 build 和 typecheck；静态检查不会执行这些命令。');
  return EduAppImportPreviewSchema.parse({
    name: displayName || 'edu-web',
    profile: 'edu-web',
    profileVersion: 1,
    repository: source.source.repository,
    sourceSha256: source.source.sourceSha256,
    fileCount: source.source.files.length,
    totalBytes: source.source.files.reduce((total, file) => total + file.bytes, 0),
    warnings: [
      '只复制受支持的源码；环境文件、账号、数据库、依赖及构建缓存不会导入。',
      '导入后会在隔离环境安装锁定依赖并运行工程的测试、类型检查和构建；可能访问依赖下载网络。',
      '当前仅支持 edu-web，需要已配置的隔离环境及 Python 3.12；导入不授予录音或模型权限。',
    ],
  });
}

/** Never forward raw filesystem, Git, subprocess or provider errors to the renderer. */
export function importError(error: unknown): { code: string; message: string } {
  if (error instanceof ImportFailure) return { code: error.code, message: error.message };
  const message = error instanceof Error ? error.message : '';
  if (/变化|changed/.test(message)) return { code: 'source_changed', message: '工程内容已变化，请重新选择并检查。' };
  if (/预算|budget|超出/.test(message))
    return { code: 'source_too_large', message: '工程超出当前支持的源码大小或文件数量，请缩小范围后重试。' };
  if (/符号链接|硬链接|路径|symlink|hardlink/.test(message))
    return { code: 'unsafe_source', message: '工程包含不支持的链接或路径，请使用独立的普通源码文件。' };
  if (/必需源码|submodule|partial-clone|过滤器/.test(message))
    return { code: 'unsupported_profile', message: '工程结构不完整或配置不受支持；请选择完整的 edu-web Git 工程。' };
  return { code: 'source_unavailable', message: '无法安全检查工程。请选择可读取的本机 edu-web Git 根目录后重试。' };
}
