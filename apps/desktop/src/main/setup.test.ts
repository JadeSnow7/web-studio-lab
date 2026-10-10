import { mkdtemp, readFile, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { describe, expect, it, vi } from 'vitest';
import { RuntimeConfigSchema, ServiceRuntimeConfigSchema, type DependencyManifest } from '@wsl/protocol';
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
  it.each(['wsl-sbx-smoke-20261006', 'wsl-competition-01234567-89ab-cdef-0123-456789abcdef', 'a', 'a'.repeat(200)])(
    'restores and saves sandbox %s with existing settings across restart',
    async (sandbox) => {
      const { manager, file, implementation } = await open();
      const config = {
        ...manager.status().config,
        sbxBinary: '/opt/homebrew/bin/sbx',
        sandbox,
        localRoot: '/existing-project',
        ssh: { host: 'example.com', port: 2222, username: 'agent', hostKeySha256: 'a'.repeat(64), root: '/project' },
      };
      await writeFile(file, JSON.stringify({ ...manager.status(), stage: 'ready', config }));
      const restored = await SetupManager.open(file, config.pythonBinary, implementation);
      expect(restored.status().error).toBeNull();
      expect(restored.runtimeConfig()).toEqual(config);
      expect(ServiceRuntimeConfigSchema.parse({ ...config, sshAgent: null }).sandbox).toBe(sandbox);
      await restored.save({ localRoot: config.localRoot, ssh: config.ssh });
      const restarted = await SetupManager.open(file, config.pythonBinary, implementation);
      expect(restarted.runtimeConfig()).toEqual(config);
      expect(restarted.status().stage).toBe('ready');
      expect(restarted.status().modelConnectionVerified).toBe(false);
      expect(implementation.probe).not.toHaveBeenCalled();
      expect(implementation.createSandbox).not.toHaveBeenCalled();
    },
  );
  it.each(['', 'a'.repeat(201), 42])('rejects invalid persisted sandbox %s and preserves the file', async (sandbox) => {
    const { manager, file, implementation } = await open();
    const config = { ...manager.status().config, sandbox };
    expect(RuntimeConfigSchema.safeParse(config).success).toBe(false);
    expect(ServiceRuntimeConfigSchema.safeParse({ ...config, sshAgent: null }).success).toBe(false);
    const bytes = JSON.stringify({ ...manager.status(), config });
    await writeFile(file, bytes);
    const restored = await SetupManager.open(file, config.pythonBinary, implementation);
    expect(restored.status().error?.code).toBe('configuration-invalid');
    await expect(restored.save({ localRoot: null, ssh: null })).rejects.toMatchObject({ code: 'configuration-invalid' });
    expect(await readFile(file, 'utf8')).toBe(bytes);
  });
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
  it('rejects new setup actions after shutdown without invoking adapters or changing persisted settings', async () => {
    const { manager, file, implementation } = await open();
    await manager.prepare();
    await manager.shutdown();
    const bytes = await readFile(file, 'utf8');
    vi.mocked(implementation.check).mockClear();
    for (const action of [
      () => manager.check(),
      () => manager.prepare(),
      () => manager.retry(),
      () => manager.login('docker', false),
      () => manager.login('openai', true),
      () => manager.save({ localRoot: null, ssh: null }),
      () => manager.authorizeLocalRoot('/new-root'),
    ])
      await expect(Promise.resolve().then(action)).rejects.toMatchObject({ code: 'closing' });
    expect(implementation.check).not.toHaveBeenCalled();
    expect(implementation.login).not.toHaveBeenCalled();
    expect(await readFile(file, 'utf8')).toBe(bytes);
  });
  it('keeps admission closed while cleanup is pending and permits repeated shutdown cleanup recovery', async () => {
    const { manager, implementation } = await open();
    await manager.prepare();
    let release!: () => void;
    const cleanup = new Promise<void>((resolve) => {
      release = resolve;
    });
    implementation.login = vi.fn(async (_binary, _provider, signal) => {
      await new Promise<void>((resolve) => {
        signal.addEventListener('abort', () => resolve());
      });
      await cleanup;
      throw new SetupError('cleanup-unconfirmed', '退出未确认');
    });
    const loggingIn = manager.login('docker', false);
    await vi.waitFor(() => expect(implementation.login).toHaveBeenCalledOnce());
    const shuttingDown = manager.shutdown().then(
      () => null,
      (error: unknown) => error,
    );
    const admission = manager.check();
    release();
    await expect(admission).rejects.toMatchObject({ code: 'closing' });
    expect(await shuttingDown).toMatchObject({ message: '退出未确认' });
    await loggingIn;
    implementation.login = vi.fn(async () => undefined);
    await manager.shutdown();
    expect(manager.status().pendingLogin).toBeNull();
    expect(implementation.login).toHaveBeenCalledWith(expect.any(String), 'docker', expect.any(AbortSignal), expect.any(String), true);
    await expect(manager.prepare()).rejects.toMatchObject({ code: 'closing' });
  });
  it('preserves interrupted state without replaying installation', async () => {
    const { manager, file, implementation } = await open();
    await writeFile(file, JSON.stringify({ ...manager.status(), busy: true, stage: 'tools' }));
    const resumed = await SetupManager.open(file, '/python', implementation);
    expect(resumed.status().error?.code).toBe('interrupted');
    expect(implementation.installTools).not.toHaveBeenCalled();
  });
});
