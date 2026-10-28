import { createHash } from 'node:crypto';
import { AppSourceSchema, EDU_REQUIRED_FILES, isEduSourcePath, type AppProfile, type EduSource } from '@wsl/protocol';
import type { ManagedAppKind, SourceFile } from './types';

export function validateEduSources(files: readonly SourceFile[], baseline: EduSource, importing: boolean): string {
  AppSourceSchema.shape.files.parse(files);
  const current = [...files]
    .sort((a, b) => (a.path < b.path ? -1 : a.path > b.path ? 1 : 0))
    .map((file) => {
      if (!isEduSourcePath(file.path)) throw new Error('不支持的 edu 源码路径');
      const bytes = Buffer.from(file.base64, 'base64');
      return { path: file.path, sha256: createHash('sha256').update(bytes).digest('hex'), bytes: bytes.length };
    });
  for (const name of EDU_REQUIRED_FILES) if (!current.some((file) => file.path === name)) throw new Error('edu 工程缺少必需源码：' + name);
  const digest = createHash('sha256').update(JSON.stringify(current)).digest('hex');
  if (importing && (digest !== baseline.sourceSha256 || JSON.stringify(current) !== JSON.stringify(baseline.files)))
    throw new Error('edu 源码与来源散列不匹配');
  const protectedFiles = (metadata: EduSource['files']) => metadata.filter((file) => !file.path.startsWith('admin/src/'));
  if (!importing && JSON.stringify(protectedFiles(current)) !== JSON.stringify(protectedFiles(baseline.files)))
    throw new Error('edu 后端或锁文件变化，需要显式重新导入来源');
  return digest;
}

export const eduWebKind: ManagedAppKind<Extract<AppProfile, { projectKind: 'edu-web' }>> = {
  projectKind: 'edu-web',
  health: { templateId: 'edu-web', templateVersions: ['1.0.0'] },
  pinnedSource: {
    initialSha256: (profile) => profile.source.sourceSha256,
    verify: (files, profile, importing) => validateEduSources(files, profile.source, importing),
  },
  recoversOwnedInstance: true,
  installsDependencyArchive: false,
  unavailable: {
    agent: 'edu 应用尚未开放任务与标准控制面',
    sourceSnapshot: 'edu 应用任务源码采集尚未开放',
    task: 'denied: edu tasks require a separately implemented candidate workflow',
  },
};
