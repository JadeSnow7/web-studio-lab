import { execFileSync } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { mkdtemp, readFile, rm, mkdir, writeFile, symlink } from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import { describe, expect, it, vi } from 'vitest';
import { AppService, validateAppSources, type AppKey } from './app-service';
import appHelper from './app-helper.py?raw';
import type { GuestFrame, GuestOutcome, GuestStart } from './sbx';

const key: AppKey = { workspaceId: 'space-test', projectId: 'project-test' };
const files = [{ path: 'package.json', base64: Buffer.from('{}').toString('base64') }];
function fixture(
  settings: {
    wrongIdentity?: boolean;
    wrongReadyIdentity?: boolean;
    guestPort?: number;
    unrelatedMapping?: boolean;
    publishGate?: Promise<void>;
    cleanup?: boolean;
    unconfirmedPublish?: boolean;
    noHealth?: boolean;
    timeout?: number;
  } = {},
) {
  let published = false;
  let persistentRequest = false;
  let competingMapping = false;
  let mappedHostPort = 49152;
  const guestPort = settings.guestPort ?? 43187;
  let closes = 0;
  let starts = 0;
  let crash: (() => void) | undefined;
  let identity: Record<string, unknown> = {};
  const commands: string[][] = [];
  const connection = {
    runtimeTarget: () => ({ binary: '/configured/sbx', sandbox: 'sandbox-test' }),
    getStatus: () => ({ available: true, reason: null, sandbox: 'sandbox-test', version: 'fixture', cwd: '/home/agent/workspace' }),
    start: (start: GuestStart, onFrame: (frame: GuestFrame) => void) => {
      if (start.mode !== 'codex') throw new Error('unexpected mode');
      const input = JSON.parse(start.prompt ?? '{}') as { operation: string; appInstanceId: string };
      starts++;
      let finish: ((result: GuestOutcome) => void) | undefined;
      const done = new Promise<GuestOutcome>((resolve) => {
        finish = resolve;
      });
      identity = { ...key, environmentId: 'sandbox', appInstanceId: input.appInstanceId };
      if (input.operation === 'start') crash = () => finish?.({ confirmed: true, exitCode: 17, error: null });
      if (input.operation === 'start')
        queueMicrotask(() =>
          onFrame({
            type: 'output',
            stream: 'stdout',
            data:
              JSON.stringify({
                event: 'app-ready',
                port: guestPort,
                identity: { ...identity, ...(settings.wrongReadyIdentity ? { appInstanceId: randomUUID() } : {}) },
              }) + '\n',
          }),
        );
      if (input.operation !== 'start')
        queueMicrotask(() => {
          onFrame({
            type: 'output',
            stream: 'stdout',
            data: `WSL_APP_RESULT:${JSON.stringify(input.operation === 'create' ? { created: true } : { files })}\n`,
          });
          finish?.({ confirmed: true, exitCode: 0, error: null });
        });
      return {
        done,
        close: () => {
          closes++;
          commands.push(['child-close']);
          finish?.({
            confirmed: settings.cleanup !== false,
            exitCode: -15,
            error: settings.cleanup === false ? 'fixture cleanup unknown' : null,
          });
          return done;
        },
      };
    },
  };
  const options = {
    startupTimeoutMs: settings.timeout ?? 2000,
    ports: async (args: string[]) => {
      commands.push(args);
      if (args[0] === '--publish') {
        published = true;
        persistentRequest = true;
        if (settings.publishGate) await settings.publishGate;
        return settings.unconfirmedPublish ? 'missing receipt' : `Published 127.0.0.1:49152 -> ${guestPort}/tcp4\n`;
      }
      if (args[0] === '--unpublish') {
        if (args[1] === `${guestPort}/tcp4`) persistentRequest = false;
        published = false;
        return '';
      }
      return JSON.stringify([
        ...(published ? [{ host_ip: '127.0.0.1', host_port: mappedHostPort, sandbox_port: guestPort, protocol: 'tcp4' }] : []),
        ...(competingMapping ? [{ host_ip: '127.0.0.1', host_port: 50112, sandbox_port: guestPort, protocol: 'tcp4' }] : []),
        ...(settings.unrelatedMapping ? [{ host_ip: '127.0.0.1', host_port: 50111, sandbox_port: 3000, protocol: 'tcp4' }] : []),
      ]);
    },
    fetch: async () => {
      if (settings.noHealth) throw new TypeError('not listening');
      return new Response(
        JSON.stringify({
          ok: true,
          templateId: 'wsl-standard-app',
          templateVersion: '1.0.0',
          identity: { ...identity, ...(settings.wrongIdentity ? { appInstanceId: randomUUID() } : {}) },
        }),
      );
    },
  };
  return {
    connection,
    options,
    service: new AppService(connection, options),
    commands: () => commands,
    closes: () => closes,
    starts: () => starts,
    crash: () => crash?.(),
    rebind: (port: number) => {
      mappedHostPort = port;
    },
    addCompetingMapping: () => {
      competingMapping = true;
    },
    wake: () => {
      published = persistentRequest;
    },
    hasMapping: () => published,
    dropMapping: () => {
      published = false;
    },
  };
}

describe('managed app ownership', () => {
  it('shutdown publishes the same instance cleanup receipt for Main persistence before returning', async () => {
    const test = fixture();
    const onSnapshot = vi.fn();
    const service = new AppService(test.connection, { ...test.options, onSnapshot });
    await service.create({ ...key, files });
    const running = await service.start(key);
    onSnapshot.mockClear();
    await service.shutdown();
    expect(onSnapshot).toHaveBeenLastCalledWith(
      expect.objectContaining({ appInstanceId: running.appInstanceId, state: 'stopped', cleanupConfirmed: true, url: null }),
    );
  });
  it('rejects traversal, duplicate paths and reserved outputs before guest effects', () => {
    for (const unsafe of ['../x', '/x', 'a//b', 'node_modules/a', '.data/pglite', '.wsl-identity.json'])
      expect(() => validateAppSources([{ path: unsafe, base64: '' }])).toThrow();
    expect(() => validateAppSources([...files, ...files])).toThrow('重复');
  });
  it('uses a fresh instance across restart and only removes its receipt-bound mapping', async () => {
    const test = fixture();
    expect((await test.service.create({ ...key, files })).state).toBe('created');
    const first = await test.service.start(key);
    expect(first.state).toBe('running');
    expect(first.cleanupConfirmed).toBe(false);
    expect((await test.service.stop(key)).cleanupConfirmed).toBe(true);
    const second = await test.service.start(key);
    expect(second.appInstanceId).not.toBe(first.appInstanceId);
    await test.service.stop(key);
    expect(test.commands().filter((args) => args[0] === '--unpublish')).toEqual([
      ['--unpublish', '43187/tcp4'],
      ['--unpublish', '43187/tcp4'],
    ]);
    test.wake();
    expect(test.hasMapping()).toBe(false);
    expect((await test.service.export(key)).files).toEqual(files);
  });
  it('publishes the actual dynamic guest port and removes it before closing the guest session', async () => {
    const test = fixture({ guestPort: 41239, unrelatedMapping: true });
    await test.service.create({ ...key, files });
    const started = await test.service.start(key);
    expect(started.state).toBe('running');
    expect(started.guestPort).toBe(41239);
    expect(test.commands()).toContainEqual(['--publish', '41239/tcp4']);
    const stopped = await test.service.stop(key);
    expect(stopped.guestPort).toBe(41239);
    expect(stopped.cleanupConfirmed).toBe(true);
    const commands = test.commands();
    const unpublish = commands.findIndex((args) => args[0] === '--unpublish');
    expect(commands[unpublish]).toEqual(['--unpublish', '41239/tcp4']);
    expect(commands[unpublish + 1]).toEqual(['--json']);
    expect(commands[unpublish + 2]).toEqual(['child-close']);
  });
  it('refuses guest-wide persistent unpublish when another mapping shares the guest port', async () => {
    const test = fixture();
    await test.service.create({ ...key, files });
    await test.service.start(key);
    test.addCompetingMapping();
    const stopped = await test.service.stop(key);
    expect(stopped.cleanupConfirmed).toBe(false);
    expect(stopped.error).toContain('重复');
    expect(test.commands().some((args) => args[0] === '--unpublish')).toBe(false);
  });
  it.each(['rebound', 'missing'])('keeps cleanup undetermined if the owned mapping is %s', async (kind) => {
    const test = fixture();
    await test.service.create({ ...key, files });
    expect((await test.service.start(key)).state).toBe('running');
    if (kind === 'rebound') test.rebind(49163);
    else test.dropMapping();
    const result = await test.service.stop(key);
    expect(result.state).toBe('failed');
    expect(result.cleanupConfirmed).toBe(false);
    expect(result.error).toContain('映射已变化或丢失');
    expect(test.commands().some((args) => args[0] === '--unpublish')).toBe(false);
    expect(test.closes()).toBe(1);
  });
  it('does not touch a mapping after an unexpected guest exit breaks continuity', async () => {
    const test = fixture();
    await test.service.create({ ...key, files });
    expect((await test.service.start(key)).state).toBe('running');
    test.crash();
    await expect.poll(() => test.service.get(key).error).toContain('映射连续性未知');
    expect(test.service.get(key).cleanupConfirmed).toBe(false);
    expect(test.commands().some((args) => args[0] === '--unpublish')).toBe(false);
  });
  it('rejects foreign app-ready identity before publishing a port', async () => {
    const test = fixture({ wrongReadyIdentity: true });
    await test.service.create({ ...key, files });
    const result = await test.service.start(key);
    expect(result.state).toBe('failed');
    expect(result.cleanupConfirmed).toBe(true);
    expect(test.commands().some((args) => args[0] === '--publish')).toBe(false);
  });
  it('cancel during publication waits for its receipt and unpublishes before closing the guest', async () => {
    let release: (() => void) | undefined;
    const publishGate = new Promise<void>((resolve) => {
      release = resolve;
    });
    const test = fixture({ publishGate });
    await test.service.create({ ...key, files });
    const starting = test.service.start(key);
    await expect.poll(() => test.commands().some((args) => args[0] === '--publish')).toBe(true);
    const stopping = test.service.stop(key);
    release?.();
    const result = await stopping;
    await starting;
    expect(result.cleanupConfirmed).toBe(true);
    expect(result.state).toBe('stopped');
    const unpublish = test.commands().findIndex((args) => args[0] === '--unpublish');
    expect(unpublish).toBeGreaterThan(0);
    expect(test.commands()[unpublish + 1]).toEqual(['--json']);
    expect(test.commands()[unpublish + 2]).toEqual(['child-close']);
  });
  it('refuses another app health identity and cleans owned guest and mapping', async () => {
    const test = fixture({ wrongIdentity: true });
    await test.service.create({ ...key, files });
    const result = await test.service.start(key);
    expect(result.state).toBe('failed');
    expect(result.error).toContain('身份不匹配');
    expect(result.cleanupConfirmed).toBe(true);
    expect(test.closes()).toBeGreaterThan(0);
  });
  it('does not infer port ownership from listing after ambiguous publish', async () => {
    const test = fixture({ unconfirmedPublish: true });
    await test.service.create({ ...key, files });
    expect((await test.service.start(key)).cleanupConfirmed).toBe(false);
    expect(test.commands().some((args) => args[0] === '--unpublish')).toBe(false);
    await expect(test.service.start(key)).rejects.toThrow('清理');
  });
  it('cancel waits for cleanup and blocks restart if cleanup is unknown', async () => {
    const test = fixture({ noHealth: true, cleanup: false });
    await test.service.create({ ...key, files });
    const pending = test.service.start(key);
    await new Promise((resolve) => setTimeout(resolve, 20));
    const stopped = await test.service.stop(key);
    expect(stopped.state).toBe('failed');
    expect(stopped.cleanupConfirmed).toBe(false);
    await pending;
    await expect(test.service.start(key)).rejects.toThrow('清理');
  });
  it('startup timeout enters cleanup and leaves retained sources exportable', async () => {
    const test = fixture({ noHealth: true, timeout: 10 });
    await test.service.create({ ...key, files });
    const result = await test.service.start(key);
    expect(result.state).toBe('failed');
    expect(result.cleanupConfirmed).toBe(true);
    expect((await test.service.export(key)).files).toEqual(files);
  });
  it('restores stopped source bindings without creating or replaying processes', async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), 'wsl-app-registry-'));
    try {
      const test = fixture();
      const registryPath = path.join(root, 'registry.json');
      const first = new AppService(test.connection, { ...test.options, registryPath });
      await first.create({ ...key, files });
      await first.start(key);
      const interrupted = new AppService(test.connection, { ...test.options, registryPath });
      const beforeRestore = test.starts();
      expect(await interrupted.restore(key)).toMatchObject({ state: 'failed', cleanupConfirmed: false, appInstanceId: null });
      expect(test.starts()).toBe(beforeRestore);
      await expect(interrupted.start(key)).rejects.toThrow('清理');
      await first.stop(key);
      expect(JSON.parse(await readFile(registryPath, 'utf8')).sandbox).toBe('sandbox-test');
      const restored = new AppService(test.connection, { ...test.options, registryPath });
      expect(await restored.restore(key)).toMatchObject({ state: 'stopped', cleanupConfirmed: true, appInstanceId: null });
      expect((await restored.start(key)).state).toBe('running');
      await restored.shutdown();
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });
});

// Executes the same source/ownership helper on a private host test root. This is
// a filesystem boundary test, not a substitute for sandbox process acceptance.
describe('app helper filesystem boundaries', () => {
  async function setup() {
    const root = await mkdtemp(path.join(os.tmpdir(), 'wsl-app-files-'));
    const execute = (operation: string, workspaceId = key.workspaceId) =>
      execFileSync(
        'python3',
        [
          '-c',
          `import sys,json
from pathlib import Path
scope={'__name__':'wsl_test'}
exec(sys.argv[3],scope)
scope['ROOT']=Path(sys.argv[1])
scope['run'](json.loads(sys.argv[2]))`,
          root,
          JSON.stringify({ ...key, workspaceId, operation, files }),
          appHelper,
        ],
        { encoding: 'utf8', timeout: 2000, stdio: ['ignore', 'pipe', 'pipe'] },
      );
    execute('create');
    return { root, execute, project: path.join(root, key.projectId) };
  }
  it('exclusive project creation preserves original files and rejects a foreign workspace', async () => {
    const test = await setup();
    try {
      expect(() => test.execute('create')).toThrow();
      expect(() => test.execute('export', 'other-space')).toThrow();
      expect(await readFile(path.join(test.project, 'package.json'), 'utf8')).toBe('{}');
    } finally {
      await rm(test.root, { recursive: true, force: true });
    }
  });
  it('exports source bytes while excluding persistent data, dependencies and build output', async () => {
    const test = await setup();
    try {
      for (const directory of ['node_modules', 'dist', '.data']) {
        await mkdir(path.join(test.project, directory));
        await writeFile(path.join(test.project, directory, 'secret'), 'excluded');
      }
      const result = JSON.parse(test.execute('export').trim().slice('WSL_APP_RESULT:'.length));
      expect(result.files).toEqual(files);
    } finally {
      await rm(test.root, { recursive: true, force: true });
    }
  });
  it('rejects source symlinks and FIFOs without following or blocking on them', async () => {
    const test = await setup();
    try {
      const pointer = path.join(test.project, 'pointer');
      await symlink('/etc/hosts', pointer);
      expect(() => test.execute('export')).toThrow();
      await rm(pointer);
      execFileSync('mkfifo', [path.join(test.project, 'pipe')]);
      expect(() => test.execute('export')).toThrow();
    } finally {
      await rm(test.root, { recursive: true, force: true });
    }
  });
});
