import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { computeSourceRevision } from './revision.js';

export const MANIFEST_PATH = 'agent/app.manifest.json';
export const BUILD_STAMP_PATH = 'dist/agent-build.json';

async function readJson(path: string): Promise<unknown> {
  try {
    return JSON.parse(await readFile(path, 'utf8')) as unknown;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return null;
    throw error;
  }
}

/** 服务启动时读取一次构建戳。 */
export async function readBuildRevision(root: string): Promise<string | null> {
  return revisionField(await readJson(join(root, BUILD_STAMP_PATH)));
}

function revisionField(value: unknown): string | null {
  if (!value || typeof value !== 'object' || !('sourceRevision' in value)) return null;
  const revision = (value as { sourceRevision: unknown }).sourceRevision;
  return typeof revision === 'string' && /^[a-f0-9]{64}$/.test(revision) ? revision : null;
}

/**
 * 当前源码、已导出 manifest 与运行构建三者的修订。manifest 原样返回，由 Host 用协议 schema 校验；
 * stale 判定只比较修订，不信任 manifest 内的其他自述。
 */
export async function describeRevision(root: string, running?: { buildRevision: string | null }) {
  const [currentRevision, manifest, stamp] = await Promise.all([
    computeSourceRevision(root),
    readJson(join(root, MANIFEST_PATH)),
    running ? Promise.resolve(null) : readJson(join(root, BUILD_STAMP_PATH)),
  ]);
  const manifestRevision = revisionField(manifest);
  // 运行实例报告它启动时的构建修订：之后重建 dist 但未重启，服务端代码仍是旧的。
  const buildRevision = running ? running.buildRevision : revisionField(stamp);
  return {
    operationTrackingVersion: 1,
    currentRevision,
    manifestRevision,
    buildRevision,
    manifest: manifest ?? null,
    stale: {
      manifest: manifestRevision !== currentRevision,
      build: buildRevision !== currentRevision,
    },
  };
}
