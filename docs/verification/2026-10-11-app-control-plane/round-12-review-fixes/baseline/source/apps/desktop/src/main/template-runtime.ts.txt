import { createHash } from 'node:crypto';
import { readFileSync, readdirSync, lstatSync } from 'node:fs';
import path from 'node:path';
import { DependencyManifestSchema, TemplateDependenciesSchema } from '@wsl/protocol';

const hash = (bytes: Buffer | string) => createHash('sha256').update(bytes).digest('hex');
/** Paths and expected hashes come only from the installed application, never persisted user settings. */
export function packagedTemplateRuntime(resources: string) {
  const runtimeRoot = path.join(resources, 'runtime');
  const manifest = DependencyManifestSchema.parse(JSON.parse(readFileSync(path.join(runtimeRoot, 'dependencies.json'), 'utf8')));
  if (!manifest.template) throw new Error('安装包缺少标准模板离线依赖');
  const template = manifest.template;
  const templateRoot = path.join(resources, 'templates/standard-app');
  const hashes: Record<string, string> = {};
  const walk = (directory: string, prefix = '') => {
    for (const name of readdirSync(directory).sort()) {
      const relative = prefix + name;
      const file = path.join(directory, name);
      const info = lstatSync(file);
      if (info.isDirectory()) walk(file, relative + '/');
      else if (info.isFile()) {
        if (relative !== 'template-manifest.json') hashes[relative] = hash(readFileSync(file));
      } else throw new Error('标准模板包含不支持的文件');
    }
  };
  walk(templateRoot);
  const ordinal = Object.fromEntries(
    Object.keys(hashes)
      .sort()
      .map((name) => [name, hashes[name]]),
  );
  if (hash(JSON.stringify(ordinal)) !== template.contentSha256 || hashes['package-lock.json'] !== template.lockSha256)
    throw new Error('标准模板源码或锁文件校验失败');
  const archivePath = path.join(runtimeRoot, template.path);
  if (hash(readFileSync(archivePath)) !== template.sha256) throw new Error('标准模板依赖归档校验失败');
  return TemplateDependenciesSchema.parse({
    archivePath,
    archiveSha256: template.sha256,
    lockSha256: template.lockSha256,
    platform: template.platform,
    arch: template.arch,
    libc: template.libc,
  });
}
