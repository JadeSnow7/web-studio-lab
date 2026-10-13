import { afterEach, expect, it } from 'vitest';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { packagedTemplateRuntime } from './template-runtime';
const directories: string[] = [];
afterEach(() => directories.splice(0).forEach((directory) => rmSync(directory, { recursive: true, force: true })));
const hash = (value: string) => createHash('sha256').update(value).digest('hex');
function fixture() {
  const root = mkdtempSync(path.join(tmpdir(), 'wsl-template-runtime-'));
  directories.push(root);
  mkdirSync(path.join(root, 'runtime'), { recursive: true });
  mkdirSync(path.join(root, 'templates/standard-app'), { recursive: true });
  writeFileSync(path.join(root, 'templates/standard-app/package-lock.json'), '{}');
  writeFileSync(path.join(root, 'templates/standard-app/template-manifest.json'), '{}');
  writeFileSync(path.join(root, 'runtime/template-dependencies.tar.gz'), 'archive');
  const payload = {
    path: 'guest-tools.tar.gz',
    sha256: hash('archive'),
    expandedBytes: 1,
    source: 'https://example.com/a',
    license: 'MIT',
  };
  const manifest = {
    schemaVersion: 1,
    platform: 'darwin-arm64',
    minimumFreeBytes: 1,
    python: { ...payload, version: '3', archiveSha256: hash('archive'), executable: 'python/bin/python3' },
    guest: { ...payload, node: '24.21.0', pnpm: '10.34.6', codex: '0.160.0' },
    template: {
      ...payload,
      path: 'template-dependencies.tar.gz',
      lockSha256: hash('{}'),
      contentSha256: hash(JSON.stringify({ 'package-lock.json': hash('{}') })),
      platform: 'linux',
      arch: 'arm64',
      libc: 'glibc',
    },
    baseImage: 'docker.io/docker/sandbox-templates@sha256:8b4cd0a46c8b600bc6b6a64af23c03d4c2807fbfc61f47568092a93fb9dc88b0',
  };
  writeFileSync(path.join(root, 'runtime/dependencies.json'), JSON.stringify(manifest));
  return { root, manifest };
}
it('derives the only offline archive from installed resources with source, lock and archive hashes', () => {
  const { root } = fixture();
  expect(packagedTemplateRuntime(root)).toMatchObject({
    archivePath: path.join(root, 'runtime/template-dependencies.tar.gz'),
    archiveSha256: hash('archive'),
    lockSha256: hash('{}'),
    libc: 'glibc',
  });
});
it.each(['archive', 'lock', 'source'])('rejects a changed %s before handing any configuration to the service', (kind) => {
  const { root } = fixture();
  const file =
    kind === 'archive'
      ? 'runtime/template-dependencies.tar.gz'
      : kind === 'lock'
        ? 'templates/standard-app/package-lock.json'
        : 'templates/standard-app/extra.ts';
  writeFileSync(path.join(root, file), 'changed');
  expect(() => packagedTemplateRuntime(root)).toThrow(/校验失败/);
});
it('rejects missing bundled template metadata and traversal archive path', () => {
  const { root, manifest } = fixture();
  manifest.template.path = '../outside';
  writeFileSync(path.join(root, 'runtime/dependencies.json'), JSON.stringify(manifest));
  expect(() => packagedTemplateRuntime(root)).toThrow();
});
