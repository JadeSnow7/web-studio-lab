import { createHash, randomUUID } from 'node:crypto';
import { lstat, mkdir, realpath, writeFile } from 'node:fs/promises';
import path from 'node:path';
import {
  AppSourceSchema,
  AppTargetSchema,
  appExportBudget,
  EDU_REQUIRED_FILES,
  isEduSourcePath,
  type AppSource,
  type AppTarget,
} from '@wsl/protocol';

const hash = (content: Buffer | string) => createHash('sha256').update(content).digest('hex');
export async function exportAppSource(directory: string, target: AppTarget, supplied: AppSource) {
  AppTargetSchema.parse(target);
  const source = AppSourceSchema.parse(supplied);
  const budget = appExportBudget(source.profile);
  if (hash(JSON.stringify(source.files)) !== source.sha256) throw new Error('源码导出散列不匹配');
  const paths = new Set<string>();
  let total = 0;
  const decoded = source.files.map((file) => {
    const parts = file.path.split('/');
    if (
      file.path.includes('\\') ||
      [...file.path].some((char) => char.charCodeAt(0) < 32 || char.charCodeAt(0) === 127) ||
      parts.some((part) => !part || part === '.' || part === '..') ||
      paths.has(file.path) ||
      !/^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/.test(file.base64)
    )
      throw new Error('源码导出路径或编码无效');
    paths.add(file.path);
    const bytes = Buffer.from(file.base64, 'base64');
    total += bytes.length;
    if (total > budget.maxSourceBytes) throw new Error('源码导出超出预算');
    return { path: file.path, bytes };
  });
  for (const file of decoded) {
    const parts = file.path.split('/');
    for (let index = 1; index < parts.length; index++)
      if (paths.has(parts.slice(0, index).join('/'))) throw new Error('源码导出文件与目录冲突');
  }
  const exportId = randomUUID();
  let manifest: unknown = { ...target, ...source };
  let sha256 = source.sha256;
  const edu = source.profile?.projectKind === 'edu-web' ? source.profile.source : null;
  if (edu) {
    if (decoded.some((file) => !isEduSourcePath(file.path)) || EDU_REQUIRED_FILES.some((file) => !paths.has(file)))
      throw new Error('edu 导出文件不符合 profile');
    if (hash(JSON.stringify(edu.files)) !== edu.sourceSha256) throw new Error('edu 导入基线散列不匹配');
    const files = decoded
      .map((file) => ({ path: file.path, sha256: hash(file.bytes), bytes: file.bytes.length }))
      .sort((a, b) => (a.path < b.path ? -1 : a.path > b.path ? 1 : 0));
    const protectedFiles = (items: typeof files) => items.filter((file) => !file.path.startsWith('admin/src/'));
    if (JSON.stringify(protectedFiles(files)) !== JSON.stringify(protectedFiles(edu.files)))
      throw new Error('edu 后端或锁文件变化，需要显式重新导入来源');
    sha256 = hash(JSON.stringify(files));
    manifest = {
      schemaVersion: 1,
      projectKind: 'edu-web',
      profileVersion: 1,
      sourceKind: 'workbench-export',
      repository: { commit: edu.repository.commit, dirty: edu.repository.dirty || sha256 !== edu.sourceSha256 },
      sourceSha256: sha256,
      files,
      workbench: { ...target, environmentId: 'sandbox', exportId, exportedAt: new Date().toISOString(), importBase: edu },
    };
  }
  await mkdir(directory, { recursive: true, mode: 0o700 });
  if ((await lstat(directory)).isSymbolicLink()) throw new Error('导出目录不能是符号链接');
  const output = path.join(await realpath(directory), target.projectId + '-' + exportId);
  await mkdir(output, { mode: 0o700 });
  const root = edu ? path.join(output, 'source') : output;
  if (edu) await mkdir(root, { mode: 0o700 });
  for (const file of decoded) {
    const destination = path.join(root, file.path);
    await mkdir(path.dirname(destination), { recursive: true, mode: 0o700 });
    await writeFile(destination, file.bytes, { flag: 'wx', mode: 0o600 });
  }
  const manifestPath = edu ? path.join(output, 'manifest.json') : output + '.manifest.json';
  await writeFile(manifestPath, JSON.stringify(manifest, null, 2), { flag: 'wx', mode: 0o600 });
  return { path: root, manifestPath, sha256 };
}
