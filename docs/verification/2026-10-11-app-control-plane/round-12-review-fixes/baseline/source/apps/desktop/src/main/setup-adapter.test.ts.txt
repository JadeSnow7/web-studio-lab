import { mkdtemp, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { describe, expect, it, vi, afterEach } from 'vitest';
import { DependencyManifestSchema } from '@wsl/protocol';
import { NativeSetupAdapter, downloadSbx, setupCommand } from './setup-adapter';
const base = 'docker.io/docker/sandbox-templates@sha256:8b4cd0a46c8b600bc6b6a64af23c03d4c2807fbfc61f47568092a93fb9dc88b0';
const manifest = DependencyManifestSchema.parse({
  schemaVersion: 1,
  platform: 'darwin-arm64',
  minimumFreeBytes: 1024,
  python: {
    path: 'python/bin/python3',
    executable: 'python/bin/python3',
    sha256: 'a'.repeat(64),
    archiveSha256: 'b'.repeat(64),
    expandedBytes: 1024,
    source: 'https://example.com/python',
    license: 'Python',
    version: '3.14.4',
  },
  guest: {
    path: 'guest.tar.gz',
    sha256: 'c'.repeat(64),
    expandedBytes: 1024,
    source: 'https://example.com/guest',
    license: 'MIT',
    node: '24.21.0',
    pnpm: '10.34.6',
    codex: '0.160.0',
  },
  baseImage: base,
});
async function fixture(output: unknown) {
  const root = await mkdtemp(path.join(tmpdir(), 'wsl-command-'));
  const binary = path.join(root, 'sbx');
  await writeFile(binary, '#!/usr/bin/env node\nconsole.log(' + JSON.stringify(JSON.stringify(output)) + ');', { mode: 0o700 });
  return { binary, adapter: new NativeSetupAdapter(root, '/Applications/App.app', root) };
}
afterEach(() => vi.unstubAllGlobals());
describe('installer native boundaries', () => {
  it('accepts actual sanitized sbx inspect shape, rejects mounts and daemon drift', async () => {
    const inspection = {
      name: 'owned',
      agent: 'codex',
      kits: [],
      state: 'stopped',
      image: 'docker/sandbox-templates:codex-docker',
      image_digest: base.split('@')[1],
      cpus: 2,
      memory: '4g',
      runtime_mounts: [],
      sessions: 0,
      daemon_version: 'v0.47.0',
    };
    const good = await fixture(inspection);
    await expect(good.adapter.inspectSandbox(good.binary, 'owned', manifest, new AbortController().signal)).resolves.toBeUndefined();
    for (const changed of [
      { runtime_mounts: [{ source: '/private' }] },
      { daemon_version: 'v0.48.0' },
      { name: 'other' },
      { image_digest: 'sha256:other' },
    ]) {
      const bad = await fixture({ ...inspection, ...changed });
      await expect(bad.adapter.inspectSandbox(bad.binary, 'owned', manifest, new AbortController().signal)).rejects.toThrow('隔离环境');
    }
  });
  it('extracts only presence from filtered secret metadata', async () => {
    const present = await fixture({ secrets: [{ scope: 'global', type: 'oauth', name: 'openai', secret: 'sensitive' }] });
    expect(await present.adapter.modelConfigured(present.binary, new AbortController().signal)).toBe(true);
    const absent = await fixture({ secrets: [] });
    expect(await absent.adapter.modelConfigured(absent.binary, new AbortController().signal)).toBe(false);
  });
  it('waits for child close on cancellation and rejects timed out success', async () => {
    const signal = new AbortController();
    const pending = setupCommand(process.execPath, ['-e', 'setInterval(()=>{},1000)'], signal.signal);
    signal.abort();
    await expect(pending).rejects.toThrow('取消');
    await expect(
      setupCommand(
        process.execPath,
        ['-e', "process.on('SIGTERM',()=>process.exit(0));setInterval(()=>{},1000)"],
        new AbortController().signal,
        100,
      ),
    ).rejects.toThrow('超时');
  });
  it('does not expose failing child output', async () => {
    const request = setupCommand(process.execPath, ['-e', "console.error('private token');process.exit(1)"], new AbortController().signal);
    await expect(request).rejects.toMatchObject({ code: 'command-failed', message: expect.stringContaining('退出码 1') });
    await expect(request).rejects.toMatchObject({ message: expect.not.stringContaining('private token') });
  });
  it('rejects interrupted downloads before extraction', async () => {
    let reads = 0;
    vi.stubGlobal(
      'fetch',
      vi.fn(
        async () =>
          new Response(
            new ReadableStream({
              pull(controller) {
                if (reads++ === 0) controller.enqueue(new TextEncoder().encode('partial'));
                else controller.error(new Error('interrupted transfer'));
              },
            }),
          ),
      ),
    );
    const root = await mkdtemp(path.join(tmpdir(), 'wsl-download-interrupted-'));
    await expect(downloadSbx(path.join(root, 'archive'), new AbortController().signal)).rejects.toThrow('interrupted transfer');
  });
  it('rejects corrupt downloads before extraction', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => new Response('corrupt')),
    );
    const root = await mkdtemp(path.join(tmpdir(), 'wsl-download-'));
    await expect(downloadSbx(path.join(root, 'archive'), new AbortController().signal)).rejects.toThrow('校验失败');
  });
});
