import { mkdtemp, readFile, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { describe, expect, it, vi } from 'vitest';
import type { DependencyManifest } from '@wsl/protocol';
import { SetupManager, SetupError, type SetupAdapter } from './setup';

const manifest: DependencyManifest = {
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
    path: 'guest-tools.tar.gz',
    sha256: 'c'.repeat(64),
    expandedBytes: 1024,
    source: 'https://example.com/tools',
    license: 'MIT',
    node: '24.21.0',
    pnpm: '10.34.6',
    codex: '0.160.0',
  },
  baseImage: 'docker.io/docker/sandbox-templates@sha256:8b4cd0a46c8b600bc6b6a64af23c03d4c2807fbfc61f47568092a93fb9dc88b0',
};
function adapter(): SetupAdapter {
  return {
    check: vi.fn(async () => manifest),
    installSbx: vi.fn(async () => '/Applications/Sbx.app/Contents/MacOS/sbx'),
    sandboxExists: vi.fn(async () => false),
    createSandbox: vi.fn(async () => undefined),
    inspectSandbox: vi.fn(async () => undefined),
    installTools: vi.fn(async () => undefined),
    probe: vi.fn(async () => undefined),
    modelConfigured: vi.fn(async () => true),
    login: vi.fn(async () => undefined),
  };
}
async function open(implementation = adapter()) {
  const directory = await mkdtemp(path.join(tmpdir(), 'wsl-setup-'));
  const file = path.join(directory, 'runtime.json');
  return { manager: await SetupManager.open(file, '/App/runtime/python/bin/python3', implementation), file, implementation };
}
describe('persisted installer', () => {
  it('stops for explicit Docker action, then completes probes with existing model credential metadata', async () => {
    const { manager, implementation } = await open();
    const states: string[] = [];
    manager.subscribe((state) => states.push(state.stage));
    expect((await manager.prepare()).stage).toBe('docker-login');
    expect(implementation.createSandbox).not.toHaveBeenCalled();
    const result = await manager.prepare();
    expect(result.stage).toBe('ready');
    expect(result.modelConnectionVerified).toBe(false);
    expect(result.restartRequired).toBe(true);
    expect(states).toContain('tools');
    expect(states).toContain('probe');
    expect(implementation.login).not.toHaveBeenCalled();
  });
  it('reconciles a create that succeeded remotely before its response failed, across restart', async () => {
    const { manager, implementation, file } = await open();
    let exists = false;
    implementation.sandboxExists = vi.fn(async () => exists);
    implementation.createSandbox = vi.fn(async () => {
      exists = true;
      throw new Error('lost acknowledgement');
    });
    await manager.prepare();
    const failure = await manager.prepare();
    expect(failure.error?.code).toBe('operation-failed');
    const name = failure.config.sandbox;
    const resumed = await SetupManager.open(file, '/App/runtime/python/bin/python3', implementation);
    expect((await resumed.retry()).config.sandbox).toBe(name);
    expect(implementation.createSandbox).toHaveBeenCalledTimes(1);
    expect((await resumed.status()).stage).toBe('ready');
  });
  it('keeps model login pending when credentials absent and requires explicit global consent', async () => {
    const { manager, implementation } = await open();
    implementation.modelConfigured = vi.fn(async () => false);
    await manager.prepare();
    expect((await manager.prepare()).stage).toBe('model-login');
    expect(() => manager.login('openai', false)).toThrow('全局凭据');
    expect(implementation.login).not.toHaveBeenCalled();
    await manager.login('openai', true);
    expect(implementation.login).toHaveBeenCalledOnce();
    expect(manager.status().stage).toBe('model-login');
  });
  it('stages settings without mutating active leases and preserves newer records', async () => {
    const { manager, implementation, file } = await open();
    await expect(manager.save({ localRoot: '/forged', ssh: null })).rejects.toThrow('目录选择器');
    manager.authorizeLocalRoot('/chosen');
    await manager.save({ localRoot: '/chosen', ssh: null });
    expect(manager.runtimeConfig().localRoot).toBeNull();
    const resumed = await SetupManager.open(file, '/App/runtime/python/bin/python3', implementation);
    expect(resumed.runtimeConfig().localRoot).toBe('/chosen');
    expect(resumed.status().restartRequired).toBe(false);
    const invalid = JSON.stringify({ ...resumed.status(), schemaVersion: 99 });
    await writeFile(file, invalid);
    const broken = await SetupManager.open(file, '/python', implementation);
    expect(broken.status().error?.code).toBe('configuration-invalid');
    await expect(broken.prepare()).rejects.toThrow('原文件已保留');
    await expect(broken.save({ localRoot: '/new', ssh: null })).rejects.toThrow('原文件已保留');
    expect(await readFile(file, 'utf8')).toBe(invalid);
  });
  it('cancels an owned operation, blocks concurrent writes, and waits for shutdown cleanup', async () => {
    const { manager, implementation } = await open();
    let entered: () => void = () => undefined;
    const started = new Promise<void>((resolve) => {
      entered = resolve;
    });
    implementation.check = vi.fn(
      (signal: AbortSignal) =>
        new Promise<DependencyManifest>((_, reject) => {
          entered();
          signal.addEventListener('abort', () => setTimeout(() => reject(new Error('secret should not persist')), 10));
        }),
    );
    const pending = manager.prepare();
    await started;
    await expect(manager.save({ localRoot: '/new', ssh: null })).rejects.toThrow('正在进行');
    await manager.shutdown();
    const result = await pending;
    expect(result.busy).toBe(false);
    expect(result.error?.code).toBe('cancelled');
    expect(JSON.stringify(result)).not.toContain('secret should not persist');
    expect(implementation.createSandbox).not.toHaveBeenCalled();
  });
  it('retains uncertain login identity across abort/restart and blocks later operations', async () => {
    const { manager, implementation, file } = await open();
    await manager.prepare();
    implementation.login = vi.fn(async (_binary, _provider, signal) => {
      await new Promise<void>((resolve) => {
        if (signal.aborted) resolve();
        else signal.addEventListener('abort', () => resolve());
      });
      throw new SetupError('cleanup-unconfirmed', '登录进程退出未确认');
    });
    const pending = manager.login('docker', false);
    while (!manager.status().pendingLogin) await new Promise((resolve) => setTimeout(resolve, 1));
    await expect(manager.shutdown()).rejects.toThrow('退出未确认');
    await pending;
    expect(manager.status().error?.code).toBe('cleanup-unconfirmed');
    const resumed = await SetupManager.open(file, '/python', implementation);
    await expect(resumed.prepare()).rejects.toThrow('尚待确认');
    implementation.login = vi.fn(async () => undefined);
    await resumed.shutdown();
    const restored = resumed.status();
    expect(restored.pendingLogin).toBeNull();
    expect(implementation.login).toHaveBeenCalledWith(expect.any(String), 'docker', expect.any(AbortSignal), expect.any(String), true);
  });
  it('preserves interrupted state without replaying installation', async () => {
    const { manager, file, implementation } = await open();
    await writeFile(file, JSON.stringify({ ...manager.status(), busy: true, stage: 'tools' }));
    const resumed = await SetupManager.open(file, '/python', implementation);
    expect(resumed.status().error?.code).toBe('interrupted');
    expect(implementation.installTools).not.toHaveBeenCalled();
  });
});
