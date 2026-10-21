import * as fs from 'node:fs/promises';
import { execFileSync } from 'node:child_process';
import { createHash, randomUUID } from 'node:crypto';
import { mkdtemp, readFile, rm, mkdir, writeFile, symlink } from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import { describe, expect, it, vi } from 'vitest';
import { AppService, validateAppSources, type AppKey } from './app-service';
import { AppControl } from '../../desktop/src/main/workbench/app-control';
import appHelper from './app-helper.py?raw';
import type { GuestFrame, GuestOutcome, GuestStart } from './sbx';

vi.mock('node:fs/promises', async (original) => ({ ...(await original<typeof fs>()) }));

const key: AppKey = { workspaceId: 'space-test', projectId: 'project-test' };
const files = [{ path: 'package.json', base64: Buffer.from('{}').toString('base64') }];
function fixture(
  settings: {
    closeGate?: Promise<void>;
    agentOutcome?: GuestOutcome;
    agentGate?: Promise<void>;
    agentCloseError?: string;
    startCloseError?: string;
    commandCloseError?: string;
    deferStartDoneOnClose?: boolean;
    agentDoneError?: string;
    exportGate?: Promise<void>;
    exportFiles?: typeof files;
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
  let rejectApp: ((error: Error) => void) | undefined;
  let identity: Record<string, unknown> = {};
  const commands: string[][] = [];
  const prompts: Record<string, unknown>[] = [];
  const agentRequests: { url: string; token: string | null; body: string | null }[] = [];
  const connection = {
    runtimeTarget: () => ({ binary: '/configured/sbx', sandbox: 'sandbox-test' }),
    getStatus: () => ({ available: true, reason: null, sandbox: 'sandbox-test', version: 'fixture', cwd: '/home/agent/workspace' }),
    start: (start: GuestStart, onFrame: (frame: GuestFrame) => void) => {
      if (start.mode !== 'codex') throw new Error('unexpected mode');
      const input = JSON.parse(start.prompt ?? '{}') as { operation: string; appInstanceId: string };
      prompts.push(input);
      starts++;
      let finish: ((result: GuestOutcome) => void) | undefined;
      let rejectDone: (error: Error) => void = () => {
        throw new Error('Uninitialised done rejection');
      };
      const done = new Promise<GuestOutcome>((resolve, reject) => {
        finish = resolve;
        rejectDone = reject;
      });
      identity = { ...key, environmentId: 'sandbox', appInstanceId: input.appInstanceId };
      if (input.operation === 'start') {
        crash = () => finish?.({ confirmed: true, exitCode: 17, error: null });
        rejectApp = rejectDone;
      }
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
        queueMicrotask(async () => {
          if (input.operation === 'export' && settings.exportGate) await settings.exportGate;
          if (input.operation === 'agent' && settings.agentGate) await settings.agentGate;
          if (input.operation === 'agent' && settings.agentDoneError) {
            rejectDone(new Error(settings.agentDoneError));
            return;
          }
          onFrame({
            type: 'output',
            stream: 'stdout',
            data: `WSL_APP_RESULT:${JSON.stringify(
              input.operation === 'create'
                ? { created: true }
                : input.operation === 'agent'
                  ? {
                      exitCode: 0,
                      stdout: 'noise\n' + JSON.stringify({ ok: true, data: { args: (input as { args?: unknown }).args } }) + '\n',
                      stderr: '',
                    }
                  : { files: settings.exportFiles ?? files },
            )}\n`,
          });
          finish?.(
            input.operation === 'agent' && settings.agentOutcome ? settings.agentOutcome : { confirmed: true, exitCode: 0, error: null },
          );
        });
      return {
        done,
        close: async () => {
          closes++;
          if (input.operation === 'agent' && settings.agentCloseError) throw new Error(settings.agentCloseError);
          if (input.operation === 'start' && settings.startCloseError) throw new Error(settings.startCloseError);
          if (['create', 'export'].includes(input.operation) && settings.commandCloseError) throw new Error(settings.commandCloseError);
          if (settings.closeGate) await settings.closeGate;
          commands.push(['child-close']);
          if (input.operation === 'start' && settings.deferStartDoneOnClose) return { confirmed: true, exitCode: -15, error: null };
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
    fetch: async (url: string | URL | Request, init?: RequestInit) => {
      if (String(url).includes('/api/__agent/')) {
        const headers = new Headers(init?.headers);
        agentRequests.push({ url: String(url), token: headers.get('x-wsl-agent-token'), body: (init?.body as string | undefined) ?? null });
        return new Response(JSON.stringify({ ok: true, data: { path: new URL(String(url)).pathname } }));
      }
      if (settings.noHealth) throw new TypeError('not listening');
      return new Response(
        JSON.stringify({
          ok: true,
          templateId: 'wsl-standard-app',
          templateVersion: '1.1.0',
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
    prompts: () => prompts,
    agentRequests: () => agentRequests,
    closes: () => closes,
    starts: () => starts,
    crash: () => crash?.(),
    rejectApp: () => {
      if (!rejectApp) throw new Error('No App process');
      return rejectApp;
    },
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

async function settleAppFixture(service: AppService): Promise<void> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    await Promise.race([
      service.stop(key).catch(() => undefined),
      new Promise<never>((_resolve, reject) => {
        timer = setTimeout(() => reject(new Error('Fixture cleanup did not settle')), 2000);
      }),
    ]);
  } finally {
    clearTimeout(timer);
  }
}

describe('R3 App asynchronous completion failures', () => {
  it('publishes exit persistence failure while retaining unknown cleanup', async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), 'wsl-app-completion-'));
    const registryPath = path.join(root, 'registry.json');
    const test = fixture();
    const onSnapshot = vi.fn();
    const service = new AppService(test.connection, { ...test.options, registryPath, onSnapshot });
    let writing: ReturnType<typeof vi.spyOn> | undefined;
    try {
      await service.create({ ...key, files });
      const running = await service.start(key);
      writing = vi.spyOn(fs, 'writeFile').mockRejectedValueOnce(new Error('controlled_exit_persist_failure'));
      test.crash();
      await expect.poll(() => service.get(key).error).toContain('controlled_exit_persist_failure');
      expect(service.get(key)).toMatchObject({ appInstanceId: running.appInstanceId, state: 'failed', cleanupConfirmed: false, url: null });
      expect(onSnapshot).toHaveBeenLastCalledWith(
        expect.objectContaining({ state: 'failed', error: expect.stringContaining('controlled_exit_persist_failure') }),
      );
      await expect(service.start(key)).rejects.toThrow(/清理|进行中/);
      writing.mockRestore();
      expect((await service.stop(key)).cleanupConfirmed).toBe(false);
      expect(JSON.parse(await readFile(registryPath, 'utf8')).apps[0]).toMatchObject({ state: 'failed', cleanupConfirmed: false });
      expect(test.commands().some((args) => args[0] === '--unpublish')).toBe(false);
    } finally {
      writing?.mockRestore();
      await settleAppFixture(service);
      await rm(root, { recursive: true, force: true });
    }
  });
  it.each(['sync', 'async'] as const)('retains a %s publisher failure in the queryable snapshot', async (kind) => {
    const test = fixture();
    const service = new AppService(test.connection, {
      ...test.options,
      onSnapshot: (snapshot) => {
        if (snapshot.state !== 'failed') return;
        const error = new Error(`controlled_${kind}_publish_failure`);
        if (kind === 'async') return Promise.reject(error);
        throw error;
      },
    });
    await service.create({ ...key, files });
    await service.start(key);
    test.crash();
    await expect.poll(() => service.get(key).error).toContain(`controlled_${kind}_publish_failure`);
    expect(service.get(key)).toMatchObject({ state: 'failed', cleanupConfirmed: false, url: null });
  });
  it('does not invent an exit or cleanup receipt when running done rejects', async () => {
    const test = fixture();
    await test.service.create({ ...key, files });
    const running = await test.service.start(key);
    test.rejectApp()(new Error('controlled_running_done_rejection'));
    await expect.poll(() => test.service.get(key).state).toBe('failed');
    await expect.poll(() => test.service.get(key).error).toContain('controlled_running_done_rejection');
    expect(test.service.get(key)).toMatchObject({ appInstanceId: running.appInstanceId, cleanupConfirmed: false, url: null });
    await expect(test.service.start(key)).rejects.toThrow(/清理|进行中/);
    expect(test.commands().some((args) => args[0] === '--unpublish')).toBe(false);
  });
  it('rejects startup when done rejects before the successful health reply returns', async () => {
    const test = fixture();
    const service = new AppService(test.connection, {
      ...test.options,
      fetch: async (...args) => {
        test.rejectApp()(new Error('controlled_startup_done_rejection'));
        return test.options.fetch(...args);
      },
    });
    await service.create({ ...key, files });
    const result = await service.start(key);
    expect(result).toMatchObject({ state: 'failed', cleanupConfirmed: false, url: null });
    expect(result.error).toContain('controlled_startup_done_rejection');
  });
  it('ignores a former process rejection after confirmed stop and replacement', async () => {
    const test = fixture({ deferStartDoneOnClose: true });
    await test.service.create({ ...key, files });
    const first = await test.service.start(key);
    const rejectOld = test.rejectApp();
    expect((await test.service.stop(key)).cleanupConfirmed).toBe(true);
    const second = await test.service.start(key);
    expect(second.appInstanceId).not.toBe(first.appInstanceId);
    rejectOld(new Error('controlled_stale_done_rejection'));
    try {
      await new Promise<void>((resolve) => setImmediate(resolve));
      expect(test.service.get(key)).toEqual(second);
      expect(test.hasMapping()).toBe(true);
    } finally {
      await test.service.stop(key);
    }
  });
  it.each(['exit', 'rejection'] as const)('does not unpublish after process %s during the cleanup port query', async (kind) => {
    const test = fixture();
    let armed = false;
    const service = new AppService(test.connection, {
      ...test.options,
      ports: async (args) => {
        const receipt = await test.options.ports(args);
        if (armed && args[0] === '--json') {
          armed = false;
          if (kind === 'exit') test.crash();
          else test.rejectApp()(new Error('controlled_cleanup_query_rejection'));
        }
        return receipt;
      },
    });
    await service.create({ ...key, files });
    await service.start(key);
    armed = true;
    const stopped = await service.stop(key);
    expect(armed).toBe(false);
    expect(stopped).toMatchObject({ state: 'failed', cleanupConfirmed: false });
    expect(test.commands().some((args) => args[0] === '--unpublish')).toBe(false);
    expect(test.hasMapping()).toBe(true);
  });
  it('records finite-helper close rejection and allows explicit cleanup after the operation ends', async () => {
    let release: () => void = () => {
      throw new Error('Uninitialised gate');
    };
    const settings = {
      exportGate: new Promise<void>((resolve) => {
        release = resolve;
      }),
      commandCloseError: undefined as string | undefined,
    };
    const test = fixture(settings);
    await test.service.create({ ...key, files });
    settings.commandCloseError = 'controlled_command_close_failure';
    const exporting = expect(test.service.export(key)).rejects.toThrow('取消');
    try {
      await expect.poll(test.starts).toBe(2);
      await expect(test.service.stop(key)).rejects.toThrow('controlled_command_close_failure');
      expect(test.service.get(key)).toMatchObject({
        state: 'failed',
        cleanupConfirmed: false,
        error: expect.stringContaining('controlled_command_close_failure'),
      });
      await expect(test.service.start(key)).rejects.toThrow(/进行中|清理/);
    } finally {
      settings.commandCloseError = undefined;
      release();
      await exporting;
      await test.service.stop(key);
    }
    expect(test.service.get(key)).toMatchObject({ state: 'stopped', cleanupConfirmed: true });
  });
  it('waits for the asynchronous exit publisher before stop completes and admission reopens', async () => {
    let release: () => void = () => {
      throw new Error('Uninitialised gate');
    };
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    let publishing = false;
    const test = fixture();
    const service = new AppService(test.connection, {
      ...test.options,
      onSnapshot: async (snapshot) => {
        if (snapshot.state === 'failed' && !publishing) {
          publishing = true;
          await gate;
        }
      },
    });
    await service.create({ ...key, files });
    const otherKey = { ...key, projectId: 'project-second' };
    await service.create({ ...otherKey, files });
    const running = await service.start(key);
    test.crash();
    let stopped = false;
    let stopping: Promise<unknown> | undefined;
    try {
      await expect.poll(() => publishing).toBe(true);
      const admitted = test.starts();
      await expect(service.start(key)).rejects.toThrow(/进行中|清理/);
      await expect(service.export(key)).rejects.toThrow(/停止|进行中/);
      const request = await service.agent(key, running.appInstanceId, { op: 'describe' }, new AbortController().signal);
      expect(request.envelope).toMatchObject({ ok: false, error: { code: 'app_busy' } });
      await expect(service.start(otherKey)).rejects.toThrow(/首版|进行中/);
      expect(test.starts()).toBe(admitted);
      expect(test.agentRequests()).toHaveLength(0);
      stopping = service.stop(key).then((result) => {
        stopped = true;
        return result;
      });
      await new Promise<void>((resolve) => setImmediate(resolve));
      expect(stopped).toBe(false);
    } finally {
      release();
      await stopping;
      await settleAppFixture(service);
    }
    expect(stopped).toBe(true);
  });

  it.each(['create', 'start'] as const)(
    'records an asynchronous %s notification failure without changing operation facts',
    async (phase) => {
      const test = fixture();
      const service = new AppService(test.connection, {
        ...test.options,
        onSnapshot: async (snapshot) => {
          if (snapshot.state === (phase === 'create' ? 'created' : 'starting')) throw new Error(`controlled_${phase}_notification_failure`);
        },
      });
      try {
        await service.create({ ...key, files });
        if (phase === 'start') await service.start(key);
        await expect.poll(() => service.get(key).error).toContain(`controlled_${phase}_notification_failure`);
        expect(service.get(key)).toMatchObject({ state: phase === 'create' ? 'created' : 'running', cleanupConfirmed: phase === 'create' });
        expect(test.starts()).toBe(phase === 'create' ? 1 : 2);
        expect(test.hasMapping()).toBe(phase === 'start');
      } finally {
        await settleAppFixture(service);
      }
    },
  );
  it('ignores a stale asynchronous creation notification after a new running snapshot owns the project', async () => {
    let reject: (error: Error) => void = (_error) => {
      throw new Error('Uninitialised publisher rejection');
    };
    const publication = new Promise<void>((_resolve, rejectPublication) => {
      reject = rejectPublication;
    });
    const test = fixture();
    const service = new AppService(test.connection, {
      ...test.options,
      onSnapshot: (snapshot) => (snapshot.state === 'created' ? publication : undefined),
    });
    try {
      await service.create({ ...key, files });
      const running = await service.start(key);
      reject(new Error('controlled_stale_publication'));
      await new Promise<void>((resolve) => setImmediate(resolve));
      expect(service.get(key)).toEqual(running);
      expect(service.get(key).error).toBeNull();
      expect(test.hasMapping()).toBe(true);
    } finally {
      reject(new Error('fixture publication settled'));
      await settleAppFixture(service);
    }
  });
  it('bounds accumulated snapshot errors while retaining the latest failure and unknown ownership', async () => {
    const settings = { startCloseError: 'controlled_long_close_' + 'x'.repeat(10000) };
    const test = fixture(settings);
    await test.service.create({ ...key, files });
    await test.service.start(key);
    test.crash();
    await expect.poll(() => test.service.get(key).state).toBe('failed');
    await new Promise<void>((resolve) => setImmediate(resolve));
    expect(test.service.get(key).error?.length).toBeLessThanOrEqual(4000);
    for (let index = 0; index < 12; index++) {
      settings.startCloseError = `controlled_latest_close_${index}_` + 'y'.repeat(10000);
      const stopped = await test.service.stop(key);
      expect(stopped).toMatchObject({ state: 'failed', cleanupConfirmed: false, url: null });
      expect(stopped.error).toContain(`controlled_latest_close_${index}_`);
      expect(stopped.error?.length).toBeLessThanOrEqual(4000);
    }
    expect(test.commands().some((args) => args[0] === '--unpublish')).toBe(false);
  });
  it.each(['persist', 'publisher'] as const)('preserves confirmed cleanup when the final stop %s fails', async (kind) => {
    const root = await mkdtemp(path.join(os.tmpdir(), 'wsl-app-confirmed-stop-'));
    const test = fixture();
    let failPublication = false;
    const service = new AppService(test.connection, {
      ...test.options,
      registryPath: path.join(root, 'registry.json'),
      onSnapshot: async (snapshot) => {
        if (failPublication && snapshot.state === 'stopped') throw new Error('controlled_final_stop_publisher');
      },
    });
    let writing: ReturnType<typeof vi.spyOn> | undefined;
    try {
      await service.create({ ...key, files });
      const running = await service.start(key);
      const starts = test.starts();
      if (kind === 'persist') writing = vi.spyOn(fs, 'writeFile').mockRejectedValueOnce(new Error('controlled_final_stop_persist'));
      else failPublication = true;
      await expect(service.stop(key)).rejects.toThrow(`controlled_final_stop_${kind}`);
      expect(service.get(key)).toMatchObject({
        state: 'failed',
        cleanupConfirmed: true,
        url: null,
        appInstanceId: running.appInstanceId,
        error: expect.stringContaining(`controlled_final_stop_${kind}`),
      });
      expect(test.hasMapping()).toBe(false);
      expect(test.starts()).toBe(starts);
      writing?.mockRestore();
      failPublication = false;
      expect((await service.stop(key)).state).toBe('stopped');
      expect(test.starts()).toBe(starts);
    } finally {
      writing?.mockRestore();
      failPublication = false;
      await settleAppFixture(service);
      await rm(root, { recursive: true, force: true });
    }
  });
  it('retains finite-helper ownership when the unchanged 30-second cancellation close rejects', async () => {
    let release: () => void = () => {
      throw new Error('Uninitialised gate');
    };
    const settings = {
      exportGate: new Promise<void>((resolve) => {
        release = resolve;
      }),
      commandCloseError: undefined as string | undefined,
    };
    const test = fixture(settings);
    await test.service.create({ ...key, files });
    settings.commandCloseError = 'controlled_timeout_close_failure';
    vi.useFakeTimers();
    const exporting = expect(test.service.export(key)).rejects.toThrow('取消');
    try {
      await vi.waitFor(() => expect(test.starts()).toBe(2));
      await vi.advanceTimersByTimeAsync(30000);
      expect(test.closes()).toBe(1);
      expect(test.service.get(key)).toMatchObject({
        state: 'failed',
        cleanupConfirmed: false,
        error: expect.stringContaining('controlled_timeout_close_failure'),
      });
      await expect(test.service.start(key)).rejects.toThrow(/进行中|清理/);
      await expect(test.service.export(key)).rejects.toThrow(/停止|进行中/);
      expect(test.starts()).toBe(2);
    } finally {
      vi.useRealTimers();
      settings.commandCloseError = undefined;
      release();
      await exporting;
      await settleAppFixture(test.service);
    }
    expect(test.service.get(key)).toMatchObject({ state: 'stopped', cleanupConfirmed: true });
  });
});

describe('managed app ownership', () => {
  it('rejects export after shutdown and closes admission before loading settles', async () => {
    const test = fixture();
    await test.service.create({ ...key, files });
    await test.service.shutdown();
    await expect(test.service.export(key)).rejects.toThrow('关闭');
    const other = fixture();
    const creation = other.service.create({ ...key, files });
    const closing = other.service.shutdown();
    await expect(creation).rejects.toThrow('关闭');
    await closing;
    expect(other.starts()).toBe(0);
  });
  it('shares stop cleanup and rejects new operations until its receipt settles', async () => {
    let release!: () => void;
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    const test = fixture({ closeGate: gate });
    await test.service.create({ ...key, files });
    await test.service.start(key);
    const first = test.service.stop(key);
    const second = test.service.stop(key);
    try {
      await vi.waitFor(() => expect(test.closes()).toBeGreaterThan(0));
      await expect(test.service.start(key)).rejects.toThrow(/进行中|清理/);
      await expect(test.service.export(key)).rejects.toThrow(/停止|进行中/);
      expect(test.closes()).toBe(1);
    } finally {
      release();
      await Promise.all([first, second]);
    }
    expect(test.closes()).toBe(1);
  });
  it('stop cancels a held export process and still publishes its cleanup receipt', async () => {
    let release!: () => void;
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    const test = fixture({ exportGate: gate });
    await test.service.create({ ...key, files });
    const exporting = test.service.export(key);
    const rejected = expect(exporting).rejects.toThrow('取消');
    await vi.waitFor(() => expect(test.starts()).toBe(2));
    const stopping = test.service.stop(key);
    try {
      await vi.waitFor(() => expect(test.closes()).toBe(1), { timeout: 200 });
      const stopped = await stopping;
      expect(stopped).toMatchObject({ state: 'stopped', cleanupConfirmed: true });
      await rejected;
    } finally {
      release();
      await Promise.allSettled([exporting, stopping, rejected]);
    }
  });
  it('serializes registry publication across projects so an older write cannot win', async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), 'wsl-registry-order-'));
    const target = path.join(root, 'registry.json');
    const originalWrite = fs.writeFile;
    let release!: () => void;
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    let writes = 0;
    const writing = vi.spyOn(fs, 'writeFile').mockImplementation(async (...args) => {
      writes++;
      if (writes === 1) await gate;
      return originalWrite(...args);
    });
    const test = fixture();
    const service = new AppService(test.connection, { ...test.options, registryPath: target });
    try {
      const first = service.create({ ...key, files });
      await vi.waitFor(() => expect(writes).toBe(1));
      const second = service.create({ ...key, projectId: 'project-second', files });
      // Both guest commands complete while the first registry publication is held.
      await vi.waitFor(() => expect(test.starts()).toBe(2));
      await new Promise<void>((resolve) => setImmediate(resolve));
      expect(writes).toBe(1);
      release();
      await Promise.all([first, second]);
      const registry = JSON.parse(await readFile(target, 'utf8'));
      expect(registry.apps).toHaveLength(2);
    } finally {
      release();
      writing.mockRestore();
      await rm(root, { recursive: true, force: true });
    }
  });
  it.each([
    '{broken',
    JSON.stringify({ version: 1, sandbox: null, apps: [] }),
    JSON.stringify({ version: 2, sandbox: 'sandbox-test', apps: [] }),
  ])('preserves an invalid registry and retries reading after external repair: %s', async (original) => {
    const root = await mkdtemp(path.join(os.tmpdir(), 'wsl-app-invalid-'));
    try {
      const test = fixture();
      const registryPath = path.join(root, 'registry.json');
      await writeFile(registryPath, original);
      const service = new AppService(test.connection, { ...test.options, registryPath });
      await expect(service.shutdown()).rejects.toThrow();
      expect(await readFile(registryPath, 'utf8')).toBe(original);
      expect(test.starts()).toBe(0);
      await writeFile(registryPath, JSON.stringify({ version: 1, sandbox: 'sandbox-test', apps: [] }));
      await expect(service.shutdown()).resolves.toBeUndefined();
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });
  it('rejects missing sandbox identity before guest or registry effects', async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), 'wsl-app-null-'));
    try {
      const test = fixture();
      const registryPath = path.join(root, 'registry.json');
      const connection = { ...test.connection, getStatus: () => ({ ...test.connection.getStatus(), sandbox: null }) };
      const service = new AppService(connection, { ...test.options, registryPath });
      await expect(service.create({ ...key, files })).rejects.toThrow('沙箱身份');
      expect(test.starts()).toBe(0);
      await expect(readFile(registryPath)).rejects.toMatchObject({ code: 'ENOENT' });
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });
  it('keeps validated registry identity when runtime status becomes unavailable during cleanup', async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), 'wsl-app-identity-'));
    try {
      const test = fixture();
      let sandbox: string | null = 'sandbox-test';
      const connection = { ...test.connection, getStatus: () => ({ ...test.connection.getStatus(), sandbox }) };
      const registryPath = path.join(root, 'registry.json');
      const service = new AppService(connection, { ...test.options, registryPath });
      await service.create({ ...key, files });
      sandbox = null;
      await service.shutdown();
      expect(JSON.parse(await readFile(registryPath, 'utf8')).sandbox).toBe('sandbox-test');
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });
  it('does not certify an interrupted historical app as cleaned', async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), 'wsl-app-unknown-'));
    try {
      const test = fixture();
      const registryPath = path.join(root, 'registry.json');
      await writeFile(
        registryPath,
        JSON.stringify({ version: 1, sandbox: 'sandbox-test', apps: [{ ...key, state: 'running', cleanupConfirmed: false }] }),
      );
      const service = new AppService(test.connection, { ...test.options, registryPath });
      await expect(service.shutdown()).rejects.toThrow('核对');
      expect(JSON.parse(await readFile(registryPath, 'utf8')).apps[0].cleanupConfirmed).toBe(false);
      expect(test.starts()).toBe(0);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });
  it('attempts later historical entries after the first cleanup remains unknown', async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), 'wsl-app-multiple-'));
    try {
      const test = fixture();
      const registryPath = path.join(root, 'registry.json');
      const second = { workspaceId: 'space-other', projectId: 'project-other' };
      await writeFile(
        registryPath,
        JSON.stringify({
          version: 1,
          sandbox: 'sandbox-test',
          apps: [
            { ...key, state: 'running', cleanupConfirmed: false },
            { ...second, state: 'stopped', cleanupConfirmed: true },
          ],
        }),
      );
      const onSnapshot = vi.fn();
      const service = new AppService(test.connection, { ...test.options, registryPath, onSnapshot });
      await expect(service.shutdown()).rejects.toThrow('核对');
      expect(onSnapshot).toHaveBeenCalledTimes(2);
      expect(onSnapshot).toHaveBeenLastCalledWith(expect.objectContaining({ ...second, state: 'stopped', cleanupConfirmed: true }));
      expect(JSON.parse(await readFile(registryPath, 'utf8')).apps).toEqual([
        { ...key, state: 'failed', cleanupConfirmed: false },
        { ...second, state: 'stopped', cleanupConfirmed: true },
      ]);
      expect(test.starts()).toBe(0);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });
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
describe('standard app export service contract', () => {
  it.each(['running', 'unknown'])('rejects export while app cleanup is %s without starting a helper', async (state) => {
    const settings = { cleanup: state !== 'unknown' };
    const test = fixture(settings);
    try {
      await test.service.create({ ...key, files });
      await test.service.start(key);
      if (state === 'unknown') expect((await test.service.stop(key)).cleanupConfirmed).toBe(false);
      const before = test.starts();
      await expect(test.service.export(key)).rejects.toThrow('请先停止应用并确认清理');
      expect(test.starts()).toBe(before);
    } finally {
      if (state === 'unknown') await expect(test.service.shutdown()).rejects.toThrow('fixture cleanup unknown');
      else await test.service.shutdown();
    }
  });
  it.each(['../x', '/x', 'a//b', 'node_modules/a', '.data/pglite', '.wsl-identity.json'])(
    'retains export rejection of unsafe/reserved path %s',
    async (unsafe) => {
      const test = fixture({ exportFiles: [{ path: unsafe, base64: '' }] });
      try {
        await test.service.create({ ...key, files });
        await expect(test.service.export(key)).rejects.toThrow('不安全');
      } finally {
        await test.service.shutdown();
      }
    },
  );
  it('retains export duplicate rejection', async () => {
    const test = fixture({ exportFiles: [...files, ...files] });
    try {
      await test.service.create({ ...key, files });
      await expect(test.service.export(key)).rejects.toThrow('重复');
    } finally {
      await test.service.shutdown();
    }
  });
  it('sends the fixed budget only to export and preserves its result hash', async () => {
    const test = fixture();
    try {
      await test.service.create({ ...key, files });
      const result = await test.service.export(key);
      expect(test.prompts().find((request) => request.operation === 'create')).not.toHaveProperty('exportBudget');
      expect(test.prompts().find((request) => request.operation === 'export')).toMatchObject({
        exportBudget: { maxFiles: 256, maxSourceBytes: 524288 },
      });
      expect(result.files).toEqual(files);
      expect(result.sha256).toBe(createHash('sha256').update(JSON.stringify(files)).digest('hex'));
    } finally {
      await test.service.shutdown();
    }
  });
  it.each(['Zg==!', 'A'.repeat(5592408)])(
    'rejects malformed or oversized guest export without a raw engine error (%#)',
    async (encoded) => {
      const test = fixture({ exportFiles: [{ path: 'file', base64: encoded }] });
      try {
        await test.service.create({ ...key, files });
        const failure = await test.service.export(key).catch((error: unknown) => error);
        expect(failure).toBeInstanceOf(Error);
        expect(failure).not.toBeInstanceOf(RangeError);
        expect((await test.service.get(key)).cleanupConfirmed).toBe(true);
      } finally {
        await test.service.shutdown();
      }
    },
  );
});

describe('app helper filesystem boundaries', () => {
  async function setup() {
    const root = await mkdtemp(path.join(os.tmpdir(), 'wsl-app-files-'));
    const execute = (operation: string, workspaceId = key.workspaceId, exportBudget: unknown = { maxFiles: 256, maxSourceBytes: 524288 }) =>
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
          JSON.stringify({ ...key, workspaceId, operation, files, ...(operation === 'export' ? { exportBudget } : {}) }),
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
  it.each(['read', 'write', 'existing'])(
    'dependency import %s failure removes only its own temporary archive and permits retry',
    async (failure) => {
      const test = await setup();
      try {
        const result = execFileSync(
          'python3',
          [
            '-c',
            `import sys,json,io,hashlib,types
from pathlib import Path
scope={'__name__':'wsl_test'}
exec(sys.argv[3],scope)
scope['ROOT']=Path(sys.argv[1])
scope['sys']=types.SimpleNamespace(platform='linux',stdin=types.SimpleNamespace(buffer=io.BytesIO(b'partial')))
scope['os']=types.SimpleNamespace(uname=lambda:types.SimpleNamespace(machine='aarch64'))
root=Path(sys.argv[1])/json.loads(sys.argv[2])['projectId']
(root/'package-lock.json').write_bytes(b'lock')
archive=root/'.wsl-deps.tar.gz'
request=dict(json.loads(sys.argv[2]),operation='dependencies',platform='linux',arch='arm64',lockSha256=hashlib.sha256(b'lock').hexdigest(),sha256='0'*64)
mode=sys.argv[4]
original=Path.open
class Writer:
    def __init__(self,handle): self.handle=handle
    def __enter__(self): self.handle.__enter__(); return self
    def __exit__(self,*args): return self.handle.__exit__(*args)
    def write(self,data): self.handle.write(data); raise OSError('injected write failure')
class Reader:
    def read(self,size): raise OSError('injected read failure')
if mode=='existing': archive.write_bytes(b'foreign')
if mode=='read': scope['sys'].stdin.buffer=Reader()
if mode=='write': Path.open=lambda self,*args,**kwargs: Writer(original(self,*args,**kwargs)) if self==archive else original(self,*args,**kwargs)
error=None
try: scope['run'](request)
except Exception as failure: error=str(failure)
finally: Path.open=original
exists=archive.exists()
foreign=archive.read_bytes().decode() if mode=='existing' and exists else None
if mode!='existing':
    scope['sys'].stdin.buffer=io.BytesIO(b'retry')
    try: scope['run'](request)
    except Exception as retry: retry_error=str(retry)
else: retry_error=None
print(json.dumps(dict(error=error,exists=exists,foreign=foreign,retry_error=retry_error)))`,
            test.root,
            JSON.stringify(key),
            appHelper,
            failure,
          ],
          { encoding: 'utf8', timeout: 2000 },
        );
        const receipt = JSON.parse(result.trim().split('\n').at(-1) ?? '');
        expect(receipt.error).toBeTruthy();
        if (failure === 'existing') {
          expect(receipt.exists).toBe(true);
          expect(receipt.foreign).toBe('foreign');
        } else {
          expect(receipt.exists).toBe(false);
          expect(receipt.retry_error).toBe('dependency archive hash mismatch');
        }
      } finally {
        await rm(test.root, { recursive: true, force: true });
      }
    },
  );
  it.each([524287, 524288, 524289])('enforces fixed helper decoded budget for one file at %i bytes', async (size) => {
    const test = await setup();
    const content = Buffer.alloc(size, 97);
    try {
      await writeFile(path.join(test.project, 'package.json'), content);
      if (size > 524288) {
        try {
          test.execute('export');
          throw new Error('unexpected export success');
        } catch (error) {
          expect(error).toMatchObject({ status: 1 });
          expect(String((error as { stdout?: unknown }).stdout)).not.toContain('WSL_APP_RESULT:');
        }
      } else {
        const result = JSON.parse(test.execute('export').trim().slice('WSL_APP_RESULT:'.length));
        expect(Buffer.from(result.files[0].base64, 'base64').equals(content)).toBe(true);
      }
      expect((await readFile(path.join(test.project, 'package.json'))).equals(content)).toBe(true);
    } finally {
      await rm(test.root, { recursive: true, force: true });
    }
  });
  it.each([524287, 524288, 524289])('enforces fixed helper aggregate budget at %i bytes', async (size) => {
    const test = await setup();
    const first = Buffer.alloc(262144, 97);
    const second = Buffer.alloc(size - first.length, 98);
    try {
      await writeFile(path.join(test.project, 'package.json'), first);
      await writeFile(path.join(test.project, 'second'), second);
      if (size > 524288) expect(() => test.execute('export')).toThrow();
      else {
        const result = JSON.parse(test.execute('export').trim().slice('WSL_APP_RESULT:'.length));
        expect(result.files).toHaveLength(2);
        expect(Buffer.from(result.files[0].base64, 'base64').equals(first)).toBe(true);
        expect(Buffer.from(result.files[1].base64, 'base64').equals(second)).toBe(true);
      }
      expect((await readFile(path.join(test.project, 'package.json'))).equals(first)).toBe(true);
      expect((await readFile(path.join(test.project, 'second'))).equals(second)).toBe(true);
    } finally {
      await rm(test.root, { recursive: true, force: true });
    }
  });
  it.each([0, 255, 256, 257])('enforces helper result count %i including empty files', async (count) => {
    const test = await setup();
    try {
      await rm(path.join(test.project, 'package.json'));
      for (let index = 0; index < count; index++) await writeFile(path.join(test.project, String(index)), '');
      if (count === 0 || count > 256) expect(() => test.execute('export')).toThrow();
      else expect(JSON.parse(test.execute('export').trim().slice('WSL_APP_RESULT:'.length)).files).toHaveLength(count);
    } finally {
      await rm(test.root, { recursive: true, force: true });
    }
  });
  it.each([
    null,
    {},
    { maxFiles: 257, maxSourceBytes: 524288 },
    { maxFiles: 256, maxSourceBytes: 8388608 },
    { maxFiles: 256, maxSourceBytes: 524288, extra: true },
    { maxFiles: 1, maxSourceBytes: 1 },
  ])('rejects nonfixed helper export budget %j', async (budget) => {
    const test = await setup();
    try {
      expect(() => test.execute('export', key.workspaceId, budget)).toThrow();
      expect(await readFile(path.join(test.project, 'package.json'), 'utf8')).toBe('{}');
    } finally {
      await rm(test.root, { recursive: true, force: true });
    }
  });
  it('bounds every actual helper read by remaining budget plus one, including growth at open', async () => {
    const test = await setup();
    try {
      const result = execFileSync(
        'python3',
        [
          '-c',
          `import sys,json
from pathlib import Path
scope={'__name__':'wsl_test'}
exec(sys.argv[3],scope)
scope['ROOT']=Path(sys.argv[1])
root=Path(sys.argv[1])/json.loads(sys.argv[2])['projectId']
(root/'a').write_bytes(b'a'*524287)
(root/'z').write_bytes(b'z')
(root/'package.json').unlink()
original=Path.open
reads=[]
class Reader:
    def __init__(self,handle,name): self.handle=handle; self.name=name
    def __enter__(self): self.handle.__enter__(); return self
    def __exit__(self,*args): return self.handle.__exit__(*args)
    def read(self,size): reads.append([self.name,size]); return self.handle.read(size)
def opened(self,*args,**kwargs):
    if self==root/'z' and args==('rb',):
        with original(self,'ab') as out: out.write(b'growth')
    handle=original(self,*args,**kwargs)
    return Reader(handle,self.name) if args==('rb',) else handle
Path.open=opened
error=None
try: scope['run'](dict(json.loads(sys.argv[2]),operation='export',exportBudget=dict(maxFiles=256,maxSourceBytes=524288)))
except Exception as failure: error=str(failure)
finally: Path.open=original
print(json.dumps(dict(error=error,reads=reads)))`,
          test.root,
          JSON.stringify(key),
          appHelper,
        ],
        { encoding: 'utf8', timeout: 2000 },
      );
      const receipt = JSON.parse(result.trim().split('\n').at(-1) ?? '');
      expect(receipt.error).toMatch(/budget/);
      expect(receipt.reads).toEqual([
        ['a', 524289],
        ['z', 2],
      ]);
      expect(result).not.toContain('WSL_APP_RESULT:');
    } finally {
      await rm(test.root, { recursive: true, force: true });
    }
  });
  it('preserves real helper Unicode bytes and empty files with padded base64', async () => {
    const test = await setup();
    try {
      const contents = Buffer.from('中文!');
      await writeFile(path.join(test.project, '中文.txt'), contents);
      await writeFile(path.join(test.project, 'empty'), '');
      const result = JSON.parse(test.execute('export').trim().slice('WSL_APP_RESULT:'.length));
      expect(result.files).toEqual([{ path: 'empty', base64: '' }, ...files, { path: '中文.txt', base64: contents.toString('base64') }]);
      expect(await readFile(path.join(test.project, '中文.txt'))).toEqual(contents);
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

describe('managed app control plane', () => {
  it.each(['running', 'stopped'])('pre-cancelled agent on %s app neither fetches nor starts a guest', async (state) => {
    const test = fixture();
    await test.service.create({ ...key, files });
    const running = state === 'running' ? await test.service.start(key) : null;
    const before = test.prompts().length;
    const controller = new AbortController();
    controller.abort();
    const result = await test.service.agent(key, running?.appInstanceId ?? null, { op: 'snapshot' }, controller.signal);
    expect(test.prompts()).toHaveLength(before);
    expect(test.agentRequests()).toEqual([]);
    expect(result).toMatchObject({
      cleanupConfirmed: true,
      operationDispatched: false,
      envelope: { ok: false, error: { code: 'cancelled' } },
    });
    if (running) await test.service.stop(key);
  });
  it('stop during CLI admission persistence prevents a late guest launch', async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), 'wsl-agent-admission-'));
    const test = fixture();
    const service = new AppService(test.connection, { ...test.options, registryPath: path.join(root, 'registry.json') });
    await service.create({ ...key, files });
    const originalWrite = fs.writeFile;
    let release!: () => void;
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    let entered = false;
    const writing = vi.spyOn(fs, 'writeFile').mockImplementation(async (...args) => {
      if (!entered) {
        entered = true;
        await gate;
      }
      return originalWrite(...args);
    });
    try {
      const starts = test.starts();
      const pending = service.agent(key, null, { op: 'describe' }, new AbortController().signal);
      await vi.waitFor(() => expect(entered).toBe(true));
      const stopping = service.stop(key);
      await vi.waitFor(async () => expect((await service.get(key)).state).toBe('stopping'));
      release();
      const [result, stopped] = await Promise.all([pending, stopping]);
      expect(stopped).toMatchObject({ state: 'stopped', cleanupConfirmed: true });
      expect(test.starts()).toBe(starts);
      expect(result).toMatchObject({ operationDispatched: false });
    } finally {
      release();
      writing.mockRestore();
      await service.shutdown();
      await rm(root, { recursive: true, force: true });
    }
  });
  it('start passes a fresh token only to the start helper; HTTP agent calls carry it and stop revokes it', async () => {
    const test = fixture();
    await test.service.create({ ...key, files });
    const running = await test.service.start(key);
    expect(running.state).toBe('running');
    const startPrompt = test.prompts().find((prompt) => prompt.operation === 'start')!;
    expect(startPrompt.agentToken).toMatch(/^[0-9a-f]{64}$/);
    expect(
      test
        .prompts()
        .filter((prompt) => prompt.operation !== 'start')
        .every((prompt) => !('agentToken' in prompt)),
    ).toBe(true);
    const signal = new AbortController().signal;
    const query = await test.service.agent(key, running.appInstanceId, { op: 'query', sql: 'select 1', limit: 5 }, signal);
    expect(query).toEqual({ mode: 'http', cleanupConfirmed: true, envelope: { ok: true, data: { path: '/api/__agent/db/query' } } });
    expect(test.agentRequests()[0]).toEqual({
      url: 'http://127.0.0.1:49152/api/__agent/db/query',
      token: startPrompt.agentToken,
      body: JSON.stringify({ sql: 'select 1', limit: 5 }),
    });
    const stale = await test.service.agent(key, 'old-instance', { op: 'reset', operationId: randomUUID() }, signal);
    expect(stale.envelope).toEqual({ ok: false, error: { code: 'stale_instance', message: expect.any(String) } });
    expect(test.agentRequests()).toHaveLength(1);
    await test.service.stop(key);
    const second = await test.service.start(key);
    const tokens = test
      .prompts()
      .filter((prompt) => prompt.operation === 'start')
      .map((prompt) => prompt.agentToken);
    expect(new Set(tokens).size).toBe(2);
    expect(second.appInstanceId).not.toBe(running.appInstanceId);
    await test.service.stop(key);
    const write = await test.service.agent(key, second.appInstanceId, { op: 'seed', operationId: randomUUID() }, signal);
    expect(write.envelope).toEqual({ ok: false, error: { code: 'app_not_running', message: expect.any(String) } });
  });

  it('stopped reads run the helper agent operation with fixed read-only argv and parse the last JSON line', async () => {
    const test = fixture();
    await test.service.create({ ...key, files });
    const result = await test.service.agent(key, null, { op: 'query', sql: "select 'x'", limit: 3 }, new AbortController().signal);
    expect(result.mode).toBe('cli');
    expect(result.envelope).toEqual({ ok: true, data: { args: ['db', 'query', "select 'x'", '--limit', '3'] } });
    const agentPrompt = test.prompts().find((prompt) => prompt.operation === 'agent')!;
    expect(agentPrompt).toEqual({
      operation: 'agent',
      workspaceId: key.workspaceId,
      projectId: key.projectId,
      args: ['db', 'query', "select 'x'", '--limit', '3'],
    });
    const describe = await test.service.agent(key, null, { op: 'describe' }, new AbortController().signal);
    expect(describe.envelope).toEqual({ ok: true, data: { args: ['describe'] } });
  });

  it('retains an unconfirmed CLI handle and prevents reuse even after repeated close', async () => {
    const test = fixture({ agentOutcome: { confirmed: false, exitCode: null, error: 'lost cleanup' } });
    await test.service.create({ ...key, files });
    const result = await test.service.agent(key, null, { op: 'describe' }, new AbortController().signal);
    expect(result.cleanupConfirmed).toBe(false);
    const before = test.starts();
    expect((await test.service.agent(key, null, { op: 'describe' }, new AbortController().signal)).envelope).toMatchObject({
      ok: false,
      error: { code: 'app_busy' },
    });
    expect(test.starts()).toBe(before);
    const cancelled = new AbortController();
    cancelled.abort();
    expect(await test.service.agent(key, null, { op: 'describe' }, cancelled.signal)).toMatchObject({ operationDispatched: false });
    expect((await test.service.stop(key)).cleanupConfirmed).toBe(false);
    await expect(test.service.start(key)).rejects.toThrow();
  });
  it('surfaces rejected CLI close and preserves the handle without waiting forever for done', async () => {
    const test = fixture({ agentGate: new Promise(() => undefined), agentCloseError: 'close rejected' });
    await test.service.create({ ...key, files });
    const controller = new AbortController();
    const pending = test.service.agent(key, null, { op: 'describe' }, controller.signal);
    await vi.waitFor(() => expect(test.prompts().some((prompt) => prompt.operation === 'agent')).toBe(true));
    controller.abort();
    expect(await pending).toMatchObject({ cleanupConfirmed: false, envelope: { ok: false, error: { code: 'cancelled' } } });
    expect(await test.service.stop(key)).toMatchObject({ cleanupConfirmed: false, error: expect.stringContaining('close rejected') });
    await expect(test.service.start(key)).rejects.toThrow();
  });
  it('retains ownership when the CLI done promise rejects', async () => {
    const test = fixture({ agentDoneError: 'done rejected' });
    await test.service.create({ ...key, files });
    await expect(test.service.agent(key, null, { op: 'describe' }, new AbortController().signal)).rejects.toThrow('done rejected');
    expect(await test.service.stop(key)).toMatchObject({ cleanupConfirmed: false, error: expect.stringContaining('done rejected') });
    await expect(test.service.start(key)).rejects.toThrow();
  });
  it.each(['lost_response', 'cancelled', 'write_404', 'oversize', 'wrong_instance', 'missing', 'malformed'])(
    'reconciles %s without replaying a database write',
    async (kind) => {
      const operationId = randomUUID();
      const controller = new AbortController();
      const calls: string[] = [];
      const envelope = { ok: true, data: { seeded: true } };
      const tracked = fixture();
      let instanceId = '';
      const fetcher = async (url: string | URL | Request, init?: RequestInit) => {
        const path = new URL(String(url)).pathname;
        if (!path.includes('/api/__agent/')) return originalHealth(url, init);
        calls.push((init?.method ?? 'GET') + ' ' + path);
        if (path.endsWith('/describe')) return Response.json({ ok: true, data: { operationTrackingVersion: 1 } });
        if (path.endsWith('/db/seed')) {
          expect(new Headers(init?.headers).get('x-wsl-agent-operation-id')).toBe(operationId);
          if (kind === 'cancelled') controller.abort();
          throw new Error('response lost');
        }
        if (path.endsWith('/cancel'))
          return Response.json({ ok: true, data: { operationId, appInstanceId: instanceId, operation: 'seed', state: 'running' } });
        if (kind === 'missing') return Response.json({ ok: false, error: { code: 'not_found', message: 'missing' } }, { status: 404 });
        if (kind === 'malformed') return new Response('{');
        return Response.json({
          ok: true,
          data: {
            operationId,
            appInstanceId: kind === 'wrong_instance' ? 'other' : instanceId,
            operation: 'seed',
            state: 'succeeded',
            envelope,
          },
        });
      };
      const originalHealth = tracked.options.fetch;
      const controlled = new AppService(tracked.connection, { ...tracked.options, reconciliationTimeoutMs: 20, fetch: fetcher });
      await controlled.create({ ...key, files });
      instanceId = (await controlled.start(key)).appInstanceId!;
      const result = await controlled.agent(key, instanceId, { op: 'seed', operationId }, controller.signal);
      expect(result.cleanupConfirmed).toBe(['lost_response', 'cancelled', 'write_404', 'oversize'].includes(kind));
      expect(calls.filter((call) => call.endsWith('/db/seed'))).toHaveLength(1);
      expect(calls.some((call) => call.endsWith('/cancel'))).toBe(true);
      expect(calls.some((call) => call.startsWith('GET /api/__agent/operations/'))).toBe(true);
      if (result.cleanupConfirmed) expect(result.operation).toMatchObject({ operationId, appInstanceId: instanceId, state: 'succeeded' });
      await controlled.stop(key);
    },
  );

  it('rechecks instance and cancellation after asynchronous write capability discovery', async () => {
    const test = fixture();
    let release!: () => void;
    let entered!: () => void;
    const enteredPromise = new Promise<void>((resolve) => {
      entered = resolve;
    });
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    const calls: string[] = [];
    const originalHealth = test.options.fetch;
    const controlled = new AppService(test.connection, {
      ...test.options,
      fetch: async (url, init) => {
        if (!String(url).includes('/api/__agent/')) return originalHealth(url, init);
        calls.push(String(url));
        entered();
        await gate;
        return Response.json({ ok: true, data: { operationTrackingVersion: 1 } });
      },
    });
    await controlled.create({ ...key, files });
    const instance = await controlled.start(key);
    const pending = controlled.agent(key, instance.appInstanceId, { op: 'seed', operationId: randomUUID() }, new AbortController().signal);
    await enteredPromise;
    await controlled.stop(key);
    release();
    expect(await pending).toMatchObject({ operationDispatched: false, cleanupConfirmed: true });
    expect(calls.some((url) => url.endsWith('/db/seed'))).toBe(false);
  });
  it('a capacity rejection proves the write never started and does not strand service occupancy', async () => {
    const test = fixture();
    const originalHealth = test.options.fetch;
    const controlled = new AppService(test.connection, {
      ...test.options,
      fetch: async (url, init) => {
        if (!String(url).includes('/api/__agent/')) return originalHealth(url, init);
        return String(url).endsWith('/describe')
          ? Response.json({ ok: true, data: { operationTrackingVersion: 1 } })
          : Response.json({ ok: false, error: { code: 'operation_capacity', message: 'full' } }, { status: 409 });
      },
    });
    await controlled.create({ ...key, files });
    const instance = await controlled.start(key);
    expect(
      await controlled.agent(key, instance.appInstanceId, { op: 'seed', operationId: randomUUID() }, new AbortController().signal),
    ).toMatchObject({ operationDispatched: false, cleanupConfirmed: true });
    expect((await controlled.start(key)).appInstanceId).toBe(instance.appInstanceId);
    await controlled.stop(key);
  });

  it('logs return a bounded UTF-8 tail of the current instance output', async () => {
    const test = fixture();
    await test.service.create({ ...key, files });
    await test.service.start(key);
    const logs = await test.service.logs(key, 20);
    expect(logs.totalBytes).toBeGreaterThan(20);
    expect(logs.truncated).toBe(true);
    expect(Buffer.byteLength(logs.text, 'utf8')).toBeLessThanOrEqual(20);
    await test.service.stop(key);
  });
});

describe('app helper agent operation', () => {
  const run = (root: string, request: Record<string, unknown>) =>
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
        JSON.stringify({ ...key, ...request }),
        appHelper,
      ],
      { encoding: 'utf8', timeout: 5000, stdio: ['ignore', 'pipe', 'pipe'] },
    );
  it('allows only describe and read-only db commands and reports projects without the control plane', async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), 'wsl-app-agent-'));
    try {
      run(root, { operation: 'create', files });
      for (const args of [['db', 'reset'], ['db', 'seed'], ['api', 'call', 'GET', '/api/health'], ['manifest', '--write'], ['db'], []])
        expect(() => run(root, { operation: 'agent', args }), JSON.stringify(args)).toThrow(/not allowed/);
      expect(run(root, { operation: 'agent', args: ['describe'] })).toContain('"unsupported"');
      expect(() => run(root, { operation: 'agent', args: ['describe'], workspaceId: 'other-space' })).toThrow(/identity/);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });
});

describe('Main to Service pre-dispatch read exclusion', () => {
  it.each(['starting', 'stopping'])('does not strand a CLI reservation while App lifecycle is %s', async (state) => {
    let release!: () => void;
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    const test = fixture(state === 'starting' ? { publishGate: gate } : { closeGate: gate });
    await test.service.create({ ...key, files });
    if (state === 'stopping') await test.service.start(key);
    const lifecycle = state === 'starting' ? test.service.start(key) : test.service.stop(key);
    await vi.waitFor(() => {
      expect(test.service.get(key).state).toBe(state);
      if (state === 'starting') expect(test.commands().some((args) => args[0] === '--publish')).toBe(true);
    });
    const control = new AppControl({
      context: async () => ({
        workspaceId: key.workspaceId,
        sessionId: 'session',
        runId: 'run',
        allowsReset: false,
        app: test.service.get(key),
        browser: null,
      }),
      ui: () => {
        throw new Error('no browser');
      },
      agent: (target, instance, operation, signal) => test.service.agent(target, instance, operation, signal),
      logs: (target, maxBytes) => test.service.logs(target, maxBytes),
      leaseValid: () => false,
      restart: () => {
        throw new Error('no restart');
      },
      store: { savePending: async () => undefined, appendAudit: async () => undefined, writeEvidence: async () => '' },
    });
    try {
      const result = await control.call(
        { workspaceId: key.workspaceId, sessionId: 'session', runId: 'run', sources: [] },
        'app.describe',
        {},
      );
      expect(result).toMatchObject({ ok: false, error: { code: 'app_busy' } });
      expect(test.prompts().filter((prompt) => prompt.operation === 'agent')).toEqual([]);
      expect(control.hasPending(key.workspaceId, 'run')).toBe(false);
    } finally {
      release();
      await lifecycle;
      if (state === 'starting') await test.service.stop(key);
    }
  });
});

describe('Main read reservation follows actual Service transport', () => {
  it.each(['starting', 'stopped'] as const)(
    'clears a read reservation when frozen context is %s and Service is already running',
    async (contextState) => {
      const test = fixture();
      await test.service.create({ ...key, files });
      const running = await test.service.start(key);
      const previousFetch = test.options.fetch;
      test.options.fetch = async (url, init) =>
        String(url).endsWith('/api/__agent/describe')
          ? Response.json({
              ok: true,
              data: {
                currentRevision: 'a'.repeat(64),
                manifestRevision: null,
                buildRevision: null,
                manifest: null,
                operationTrackingVersion: 1,
              },
            })
          : previousFetch(url, init);
      const control = new AppControl({
        context: async () => ({
          workspaceId: key.workspaceId,
          sessionId: 'session',
          runId: 'run',
          allowsReset: false,
          app: { ...running, state: contextState },
          browser: null,
        }),
        ui: () => {
          throw new Error('no browser');
        },
        agent: (target, instance, operation, signal) => test.service.agent(target, instance, operation, signal),
        logs: (target, maxBytes) => test.service.logs(target, maxBytes),
        leaseValid: () => false,
        restart: () => {
          throw new Error('no restart');
        },
        store: { savePending: async () => undefined, appendAudit: async () => undefined, writeEvidence: async () => '' },
      });
      try {
        expect(
          await control.call({ workspaceId: key.workspaceId, sessionId: 'session', runId: 'run', sources: [] }, 'app.describe', {}),
        ).toMatchObject({ ok: true });
        expect(test.prompts().filter((prompt) => prompt.operation === 'agent')).toEqual([]);
        expect(control.hasPending(key.workspaceId, 'run')).toBe(false);
      } finally {
        await test.service.stop(key);
      }
    },
  );
});
