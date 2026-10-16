import * as fs from 'node:fs/promises';
import { readFileSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import { createHash, randomUUID } from 'node:crypto';
import { EDU_REQUIRED_FILES, type AppProfile } from '@wsl/protocol';
import { mkdtemp, readFile, rm, mkdir, writeFile, symlink } from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import { describe, expect, it, vi } from 'vitest';
import { AppService, validateAppSources, type AppKey } from './app-service';
import { setup as setupMain, state as pageFixture, capture as captureFixture } from '../../desktop/src/main/workbench/sha-main-fixture';
import { AppControl } from '../../desktop/src/main/workbench/app-control';
import appHelper from './app-helper.py?raw';
import type { GuestFrame, GuestOutcome, GuestStart } from './sbx';

vi.mock('node:fs/promises', async (original) => ({ ...(await original<typeof fs>()) }));

const key: AppKey = { workspaceId: 'space-test', projectId: '767c75f6-ad3f-4905-81ed-7892ed7941ab' };
const files = [{ path: 'package.json', base64: Buffer.from('{}').toString('base64') }];
const eduFiles = [...EDU_REQUIRED_FILES, 'admin/src/App.tsx']
  .sort()
  .map((path) => ({ path, base64: Buffer.from(path).toString('base64') }));
function eduSource(sourceFiles = eduFiles) {
  const metadata = [...sourceFiles]
    .sort((a, b) => (a.path < b.path ? -1 : a.path > b.path ? 1 : 0))
    .map((file) => {
      const bytes = Buffer.from(file.base64, 'base64');
      return { path: file.path, sha256: createHash('sha256').update(bytes).digest('hex'), bytes: bytes.length };
    });
  return {
    repository: { commit: 'a'.repeat(40), dirty: false },
    sourceSha256: createHash('sha256').update(JSON.stringify(metadata)).digest('hex'),
    files: metadata,
  };
}
function fixture(
  settings: {
    sourceFiles?: typeof files;
    identityKey?: AppKey;
    recoveryError?: string;
    recoveryWrongIdentity?: boolean;
    recoveryEarlyExit?: boolean;
    crashOutcome?: GuestOutcome;
    startupFailure?: { stderr: string[]; stdout?: string; outcome?: GuestOutcome };
    startCleanupFailure?: boolean;
    recoveryBootReplacement?: 'valid' | 'invalid';
    healthTemplate?: string;
    closeGate?: Promise<void>;
    agentOutcome?: GuestOutcome;
    agentGate?: Promise<void>;
    agentCloseError?: string;
    agentDoneError?: string;
    exportGate?: Promise<void>;
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
  let appOutput: ((frame: GuestFrame) => void) | undefined;
  let identity: Record<string, unknown> = {};
  const recoveryBootId = randomUUID();
  const commands: string[][] = [];
  const prompts: Record<string, unknown>[] = [];
  const agentRequests: { url: string; token: string | null; body: string | null }[] = [];
  let templateId = 'wsl-standard-app';
  const requests: { operation: string; profile?: AppProfile }[] = [];
  const connection = {
    runtimeTarget: () => ({ binary: '/configured/sbx', sandbox: 'sandbox-test' }),
    getStatus: () => ({ available: true, reason: null, sandbox: 'sandbox-test', version: 'fixture', cwd: '/home/agent/workspace' }),
    start: (start: GuestStart, onFrame: (frame: GuestFrame) => void) => {
      if (start.mode !== 'codex') throw new Error('unexpected mode');
      const input = JSON.parse(start.prompt ?? '{}') as {
        operation: string;
        appInstanceId: string;
        importOperationId?: string;
        profile?: AppProfile;
      };
      requests.push(input);
      templateId = input.profile?.projectKind === 'edu-web' ? 'edu-web' : 'wsl-standard-app';
      prompts.push(input);
      starts++;
      let finish: ((result: GuestOutcome) => void) | undefined;
      let rejectDone!: (error: Error) => void;
      const done = new Promise<GuestOutcome>((resolve, reject) => {
        finish = resolve;
        rejectDone = reject;
      });
      identity = { ...(settings.identityKey ?? key), environmentId: 'sandbox', appInstanceId: input.appInstanceId };
      if (input.operation === 'start') appOutput = onFrame;
      if (input.operation === 'start') crash = () => finish?.(settings.crashOutcome ?? { confirmed: true, exitCode: 17, error: null });
      if (input.operation === 'start')
        queueMicrotask(() => {
          if (settings.startupFailure) {
            if (settings.startupFailure.stdout) onFrame({ type: 'output', stream: 'stdout', data: settings.startupFailure.stdout });
            for (const data of settings.startupFailure.stderr) onFrame({ type: 'output', stream: 'stderr', data });
            finish?.(settings.startupFailure.outcome ?? { confirmed: true, exitCode: 7, error: null });
            return;
          }
          onFrame({
            type: 'output',
            stream: 'stdout',
            data:
              (input.profile?.projectKind === 'edu-web'
                ? 'WSL_APP_SOURCE:' + eduSource(settings.sourceFiles ?? eduFiles).sourceSha256 + '\n'
                : '') +
              JSON.stringify({
                event: 'app-ready',
                port: guestPort,
                identity: { ...identity, ...(settings.wrongReadyIdentity ? { appInstanceId: randomUUID() } : {}) },
              }) +
              '\n',
          });
        });
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
              input.operation === 'import-source'
                ? {
                    importOperationId: input.importOperationId,
                    outcome: 'imported',
                    retryable: false,
                    errorCode: null,
                    profile: input.profile,
                    sourceSha256: input.profile?.projectKind === 'edu-web' ? input.profile.source.sourceSha256 : undefined,
                  }
                : input.operation === 'create'
                  ? { created: true }
                  : input.operation === 'agent'
                    ? {
                        exitCode: 0,
                        stdout: 'noise\n' + JSON.stringify({ ok: true, data: { args: (input as { args?: unknown }).args } }) + '\n',
                        stderr: '',
                      }
                    : input.operation === 'recover-owned'
                      ? settings.recoveryError
                        ? { recoveryError: settings.recoveryError }
                        : {
                            cleanupConfirmed: true,
                            identity: { ...identity, ...(settings.recoveryWrongIdentity ? { appInstanceId: randomUUID() } : {}) },
                            sourceSha256: eduSource(settings.sourceFiles ?? eduFiles).sourceSha256,
                            bootId: recoveryBootId,
                            ...(settings.recoveryBootReplacement
                              ? {
                                  bootReplacement: {
                                    previousBootId: settings.recoveryBootReplacement === 'valid' ? recoveryBootId : randomUUID(),
                                    currentBootId: randomUUID(),
                                  },
                                }
                              : {}),
                            leader: { pid: 111, startTicks: '42' },
                            members: [{ pid: 111, startTicks: '42' }],
                          }
                      : input.operation === 'apply-task'
                        ? { applied: true }
                        : { files: settings.sourceFiles ?? files },
            )}\n`,
          });
          if (input.operation === 'recover-owned' && !settings.recoveryEarlyExit) return;
          finish?.(
            input.operation === 'agent' && settings.agentOutcome ? settings.agentOutcome : { confirmed: true, exitCode: 0, error: null },
          );
        });
      return {
        done,
        close: async () => {
          closes++;
          if (input.operation === 'agent' && settings.agentCloseError) throw new Error(settings.agentCloseError);
          if (settings.closeGate) await settings.closeGate;
          commands.push(['child-close']);
          finish?.({
            confirmed: settings.cleanup !== false && !(input.operation === 'start' && settings.startCleanupFailure),
            exitCode: -15,
            error:
              settings.cleanup === false || (input.operation === 'start' && settings.startCleanupFailure)
                ? 'fixture cleanup unknown'
                : null,
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
          templateId: settings.healthTemplate ?? templateId,
          templateVersion: templateId === 'edu-web' ? '1.0.0' : '1.1.0',
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
    requests: () => requests,
    closes: () => closes,
    starts: () => starts,
    crash: () => crash?.(),
    output: (data: string, stream: 'stdout' | 'stderr' = 'stdout') => appOutput?.({ type: 'output', stream, data }),
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

describe('managed edu project profile', () => {
  it('imports, runs and exports edu with its own health contract and immutable source provenance', async () => {
    const test = fixture({ sourceFiles: eduFiles });
    const source = eduSource();
    const imported = await test.service.importEdu({ ...key, files: eduFiles, source });
    expect(imported.profile).toEqual({ projectKind: 'edu-web', profileVersion: 1, source });
    if (imported.profile?.projectKind === 'edu-web') imported.profile.source.repository.commit = 'f'.repeat(40);
    expect(test.service.get(key).profile).toEqual({ projectKind: 'edu-web', profileVersion: 1, source });
    const running = await test.service.start(key);
    expect(running).toMatchObject({ state: 'running', sourceSha256: source.sourceSha256 });
    await expect(test.service.export(key)).rejects.toThrow('停止');
    expect((await test.service.stop(key)).cleanupConfirmed).toBe(true);
    const exported = await test.service.export(key);
    expect(exported.files).toEqual(eduFiles);
    expect(exported.profile).toEqual({ projectKind: 'edu-web', profileVersion: 1, source });
    expect(test.requests().map((request) => request.profile?.projectKind)).toEqual(['edu-web', 'edu-web', 'edu-web']);
  });
  it('does not accept standard-template health for an edu project', async () => {
    const test = fixture({ sourceFiles: eduFiles, healthTemplate: 'wsl-standard-app' });
    await test.service.importEdu({ ...key, files: eduFiles, source: eduSource() });
    const result = await test.service.start(key);
    expect(result).toMatchObject({ state: 'failed', cleanupConfirmed: true, url: null });
    expect(result.error).toContain('身份不匹配');
  });
  it.each(['file-hash', 'aggregate-hash', 'missing-required', 'secret-path'])(
    'rejects invalid import %s before starting a guest',
    async (kind) => {
      const test = fixture();
      const input = { ...key, files: structuredClone(eduFiles), source: eduSource() };
      if (kind === 'file-hash') input.files[0]!.base64 = Buffer.from('changed').toString('base64');
      if (kind === 'aggregate-hash') input.source.sourceSha256 = '0'.repeat(64);
      if (kind === 'missing-required') {
        input.files.shift();
        input.source = eduSource(input.files);
      }
      if (kind === 'secret-path') {
        input.files.push({ path: 'server/.env.py', base64: Buffer.from('excluded').toString('base64') });
        input.source = eduSource(input.files);
      }
      await expect(test.service.importEdu(input)).rejects.toThrow();
      expect(test.starts()).toBe(0);
    },
  );
  it('persists an explicit versioned profile and restores it without starting a guest', async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), 'wsl-edu-registry-'));
    try {
      const test = fixture({ sourceFiles: eduFiles });
      const registryPath = path.join(root, 'registry.json');
      const first = new AppService(test.connection, { ...test.options, registryPath });
      await first.importEdu({ ...key, files: eduFiles, source: eduSource() });
      const bytes = JSON.parse(await readFile(registryPath, 'utf8'));
      expect(bytes.version).toBe(3);
      expect(bytes.apps[0].profile.projectKind).toBe('edu-web');
      const before = test.starts();
      const restored = await new AppService(test.connection, { ...test.options, registryPath }).restore(key);
      expect(restored).toMatchObject({
        state: 'stopped',
        cleanupConfirmed: true,
        profile: { projectKind: 'edu-web', profileVersion: 1, source: eduSource() },
      });
      expect(test.starts()).toBe(before);
      bytes.apps[0].profile.profileVersion = 99;
      const invalid = JSON.stringify(bytes);
      await writeFile(registryPath, invalid);
      await expect(new AppService(test.connection, { ...test.options, registryPath }).restore(key)).rejects.toThrow();
      expect(await readFile(registryPath, 'utf8')).toBe(invalid);
      expect(test.starts()).toBe(before);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });
});

describe('managed app ownership', () => {
  it.each(['standard-app', 'edu-web'] as const)(
    'keeps bounded startup stderr for %s without exposing mixed stdout or stale attempts',
    async (profile) => {
      const settings = {
        sourceFiles: profile === 'edu-web' ? eduFiles : files,
        startupFailure: {
          stderr: ['discarded-old-prefix\n' + 'x'.repeat(5000), 'fixture: startup ', 'intentionally rejected\n'],
          stdout: 'stdout is not the startup diagnostic\n',
        },
      };
      const test = fixture(settings);
      if (profile === 'edu-web') await test.service.importEdu({ ...key, files: eduFiles, source: eduSource() });
      else await test.service.create({ ...key, files });
      const failed = await test.service.start(key);
      expect(failed).toMatchObject({ state: 'failed', cleanupConfirmed: true, url: null });
      expect(failed.error).toContain('fixture: startup intentionally rejected');
      expect(failed.error).toContain('exitCode=7，cleanupConfirmed=true');
      expect(failed.error).not.toContain('stdout is not');
      expect(failed.error).not.toContain('discarded-old-prefix');
      expect(failed.error!.length).toBeLessThan(4200);
      expect(test.commands().some((command) => command[0] === '--publish')).toBe(false);
      settings.startupFailure.stderr = ['fresh startup diagnostic\n'];
      const retried = await test.service.start(key);
      expect(retried.error).toContain('fresh startup diagnostic');
      expect(retried.error).not.toContain('fixture: startup intentionally rejected');
    },
  );
  it('keeps startup stderr alongside transport and cleanup uncertainty', async () => {
    const test = fixture({
      startupFailure: {
        stderr: ['fixture: startup intentionally rejected\n'],
        outcome: { confirmed: false, exitCode: 7, error: 'transport cleanup unknown' },
      },
    });
    await test.service.create({ ...key, files });
    const failed = await test.service.start(key);
    expect(failed).toMatchObject({ state: 'failed', cleanupConfirmed: false });
    expect(failed.error).toContain('fixture: startup intentionally rejected');
    expect(failed.error).toContain('cleanupConfirmed=false');
    expect(failed.error).toContain('transport cleanup unknown');
    await expect(test.service.start(key)).rejects.toThrow('清理尚未确认');
  });
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
    JSON.stringify({ version: 99, sandbox: 'sandbox-test', apps: [] }),
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
        {
          ...key,
          state: 'failed',
          cleanupConfirmed: false,
          profile: { projectKind: 'standard-app', profileVersion: 1 },
          appInstanceId: null,
          url: null,
          guestPort: null,
          portPending: false,
          portRemovalPending: false,
          port: null,
          processExpected: false,
        },
        {
          ...second,
          state: 'stopped',
          cleanupConfirmed: true,
          profile: { projectKind: 'standard-app', profileVersion: 1 },
          appInstanceId: null,
          url: null,
          guestPort: null,
          portPending: false,
          portRemovalPending: false,
          port: null,
          processExpected: false,
        },
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

describe('running edu task sources and candidate ownership', () => {
  it('freezes and applies against the running instance while retaining its process and mapping owner', async () => {
    const test = fixture({ sourceFiles: eduFiles });
    const source = eduSource();
    await test.service.importEdu({ ...key, files: eduFiles, source });
    const running = await test.service.start(key);
    const binding = {
      ...key,
      runId: randomUUID(),
      appInstanceId: running.appInstanceId!,
      resourceId: 'web',
      instanceId: 'browser',
      generation: 1,
      webContentsId: 1,
      documentGeneration: 1,
      sourceSha256: source.sourceSha256,
      protectedFiles: source.files.filter((file) => !file.path.startsWith('admin/src/')),
    };
    const workspace = await test.service.taskSource(binding);
    expect(workspace.files).toEqual(eduFiles);
    expect(await test.service.prepareTask(binding, workspace)).toEqual({ binding, operation: 'prepare', ok: true, cleanupConfirmed: true });
    expect(await test.service.applyTask(binding, workspace)).toMatchObject({
      binding,
      operation: 'apply',
      ok: true,
      cleanupConfirmed: true,
      app: { appInstanceId: running.appInstanceId, state: 'running' },
    });
    expect(test.service.get(key)).toMatchObject({ state: 'running', appInstanceId: running.appInstanceId, cleanupConfirmed: false });
    const stopped = await test.service.stop(key);
    expect(stopped.state).toBe('stopped');
    expect(test.commands()).toContainEqual(['--unpublish', '43187/tcp4']);
  });
  it('rejects changed application instances before exporting or applying', async () => {
    const test = fixture({ sourceFiles: eduFiles });
    const source = eduSource();
    await test.service.importEdu({ ...key, files: eduFiles, source });
    await test.service.start(key);
    const binding = {
      ...key,
      runId: randomUUID(),
      appInstanceId: randomUUID(),
      resourceId: 'web',
      instanceId: 'browser',
      generation: 1,
      webContentsId: 1,
      documentGeneration: 1,
      sourceSha256: source.sourceSha256,
      protectedFiles: source.files.filter((file) => !file.path.startsWith('admin/src/')),
    };
    const count = test.requests().length;
    await expect(test.service.taskSource(binding)).rejects.toThrow('instance changed');
    expect(test.requests().length).toBe(count);
    await test.service.stop(key);
  });
});

describe('edu two-phase commit admission', () => {
  it('refuses unprepared commit and a stopped instance after preparation without dispatching writes', async () => {
    const test = fixture({ sourceFiles: eduFiles });
    const source = eduSource();
    await test.service.importEdu({ ...key, files: eduFiles, source });
    const running = await test.service.start(key);
    const binding = {
      ...key,
      runId: randomUUID(),
      appInstanceId: running.appInstanceId!,
      resourceId: 'web',
      instanceId: 'browser',
      generation: 1,
      webContentsId: 1,
      documentGeneration: 1,
      sourceSha256: source.sourceSha256,
      protectedFiles: source.files.filter((file) => !file.path.startsWith('admin/src/')),
    };
    const candidate = { runId: binding.runId, files: eduFiles };
    await expect(test.service.applyTask(binding, candidate)).resolves.toMatchObject({
      binding,
      operation: 'apply',
      ok: false,
      cleanupConfirmed: false,
      error: expect.stringContaining('not prepared'),
    });
    await test.service.prepareTask(binding, candidate);
    expect(test.requests().some((request) => request.operation === 'apply-task')).toBe(false);
    await test.service.stop(key);
    await expect(test.service.applyTask(binding, candidate)).resolves.toMatchObject({
      binding,
      operation: 'apply',
      ok: false,
      cleanupConfirmed: true,
      error: expect.stringContaining('not prepared'),
    });
    expect(test.requests().some((request) => request.operation === 'apply-task')).toBe(false);
  });
});

describe('edu standard control and send exclusion', () => {
  it.each(['running', 'stopped'] as const)('rejects Hono/PGlite operations and unbound sends on %s edu project', async (state) => {
    const test = fixture({ sourceFiles: eduFiles });
    const source = eduSource();
    await test.service.importEdu({ ...key, files: eduFiles, source });
    const running = await test.service.start(key);
    if (state === 'stopped') await test.service.stop(key);
    const before = test.prompts().length;
    for (const operation of [
      { op: 'describe' },
      { op: 'query', sql: 'select 1', limit: 1 },
      { op: 'reset', operationId: randomUUID() },
    ] as const) {
      expect(await test.service.agent(key, running.appInstanceId, operation, new AbortController().signal)).toMatchObject({
        envelope: { ok: false, error: { code: 'unsupported' } },
        operationDispatched: false,
      });
    }
    expect(test.prompts().length).toBe(before);
    expect(test.agentRequests()).toEqual([]);
    expect(
      test
        .prompts()
        .filter((prompt) => prompt.operation === 'start')
        .every((prompt) => !('agentToken' in prompt)),
    ).toBe(true);
    await expect(test.service.assertTaskAdmission(key.workspaceId)).rejects.toThrow('frozen candidate');
    if (state === 'running') await test.service.stop(key);
  });
});

describe('leased app stdout boundary', () => {
  it('intercepts a fragmented assessment above normal log budget and never logs audio or stderr', async () => {
    const t = fixture({ sourceFiles: eduFiles });
    const source = eduSource();
    await t.service.importEdu({ ...key, files: eduFiles, source });
    const lease = {
      schemaVersion: 1 as const,
      sessionId: randomUUID(),
      identity: { ...key, environmentId: 'sandbox' as const, appInstanceId: randomUUID() },
      sourceSha256: source.sourceSha256,
      expiresAtMs: Date.now() + 300000,
    };
    const request = vi.fn(),
      fail = vi.fn();
    await t.service.start(key, { lease, request, fail });
    const line = 'WSL_EDU_ASSESSMENT_REQUEST:' + JSON.stringify({ audioBase64: 'SYNTHETIC'.repeat(10000) }) + '\n';
    t.output(line.slice(0, 10));
    t.output(line.slice(10, 70000));
    t.output(line.slice(70000));
    t.output('PRIVATE_KEY_AUDIO', 'stderr');
    expect(request).toHaveBeenCalledExactlyOnceWith(line);
    expect(fail).not.toHaveBeenCalled();
    expect((await t.service.logs(key, 65536)).text).toBe('');
    t.output('unknown leased runtime output\n');
    expect(fail).toHaveBeenCalledOnce();
    await t.service.stop(key);
  });
  it('rejects an oversized leased frame without expanding ordinary ready budget', async () => {
    const t = fixture({ sourceFiles: eduFiles });
    const source = eduSource();
    await t.service.importEdu({ ...key, files: eduFiles, source });
    const lease = {
      schemaVersion: 1 as const,
      sessionId: randomUUID(),
      identity: { ...key, environmentId: 'sandbox' as const, appInstanceId: randomUUID() },
      sourceSha256: source.sourceSha256,
      expiresAtMs: Date.now() + 300000,
    };
    const request = vi.fn(),
      fail = vi.fn();
    await t.service.start(key, { lease, request, fail });
    t.output('WSL_EDU_ASSESSMENT_REQUEST:' + 'x'.repeat(1500000));
    expect(fail).toHaveBeenCalledOnce();
    expect(request).not.toHaveBeenCalled();
    expect((await t.service.logs(key, 65536)).text).toBe('');
    await t.service.stop(key);
  });
});

describe('default AI0 edu interrupted process recovery', () => {
  it('explicit stop reaches owned recovery after v3 registry restart without a lease journal', async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), 'edu-default-recovery-'));
    const t = fixture({ sourceFiles: eduFiles });
    const options = { ...t.options, registryPath: path.join(root, 'registry.json') };
    const owner = new AppService(t.connection, options);
    try {
      const source = eduSource();
      await owner.importEdu({ ...key, files: eduFiles, source });
      await owner.start(key);
      const restarted = new AppService(t.connection, options);
      const failed = await restarted.restore(key);
      expect(failed.state).toBe('failed');
      expect(failed.cleanupConfirmed).toBe(false);
      const capture = vi.spyOn(restarted, 'captureRecoverySource').mockResolvedValue(source.sourceSha256);
      const recover = vi.spyOn(restarted, 'recoverOwned').mockResolvedValue({ ...failed, state: 'stopped', cleanupConfirmed: true });
      expect((await restarted.stop(key)).cleanupConfirmed).toBe(true);
      expect(capture).toHaveBeenCalledOnce();
      expect(recover).toHaveBeenCalledOnce();
    } finally {
      await owner.stop(key);
      await rm(root, { recursive: true, force: true });
    }
  });
});

describe('default edu recovery through actual registry, source and keeper adapters', () => {
  it.each(['valid', 'wrong-instance', 'source-changed', 'keeper-lost', 'helper-lost', 'foreign-mapping'] as const)(
    'handles %s without adopting unknown processes or mappings',
    async (kind) => {
      const root = await mkdtemp(path.join(os.tmpdir(), 'edu-owned-stop-'));
      const currentFiles = eduFiles.map((file) => ({ ...file }));
      const t = fixture({
        sourceFiles: currentFiles,
        recoveryWrongIdentity: kind === 'wrong-instance',
        recoveryEarlyExit: kind === 'keeper-lost',
        ...(kind === 'helper-lost' ? { recoveryError: 'verification_recovery_helper_lost' } : {}),
      });
      const options = { ...t.options, registryPath: path.join(root, 'registry.json') };
      const owner = new AppService(t.connection, options);
      try {
        await owner.importEdu({ ...key, files: currentFiles, source: eduSource(currentFiles) });
        await owner.start(key);
        if (kind === 'source-changed')
          currentFiles.find((file) => file.path === 'admin/src/App.tsx')!.base64 = Buffer.from('concurrent edit').toString('base64');
        if (kind === 'foreign-mapping') t.addCompetingMapping();
        const restarted = new AppService(t.connection, options);
        const recovered = await restarted.stop(key);
        if (kind === 'valid') {
          expect(recovered).toMatchObject({ state: 'stopped', cleanupConfirmed: true });
          expect(t.commands()).toContainEqual(['--unpublish', '43187/tcp4']);
        } else {
          expect(recovered).toMatchObject({ state: 'failed', cleanupConfirmed: false });
          expect(t.commands().some((command) => command[0] === '--unpublish')).toBe(false);
        }
        const requests = t.prompts().filter((request) => request.operation === 'recover-owned');
        expect(requests).toHaveLength(kind === 'source-changed' ? 0 : 1);
      } finally {
        await owner.stop(key);
        await rm(root, { recursive: true, force: true });
      }
    },
  );
});

describe('durable mapping intent recovery', () => {
  it.each(['already-removed', 'publish-unknown', 'rebound'] as const)('keeps %s distinct from a confirmed owned tuple', async (kind) => {
    const root = await mkdtemp(path.join(os.tmpdir(), 'edu-mapping-intent-'));
    const t = fixture({ sourceFiles: eduFiles, unrelatedMapping: true });
    const file = path.join(root, 'registry.json');
    const options = { ...t.options, registryPath: file };
    const owner = new AppService(t.connection, options);
    try {
      await owner.importEdu({ ...key, files: eduFiles, source: eduSource() });
      await owner.start(key);
      const saved = JSON.parse(await readFile(file, 'utf8'));
      if (kind === 'already-removed') {
        saved.apps[0].portRemovalPending = true;
        t.dropMapping();
      }
      if (kind === 'publish-unknown') saved.apps[0].port = null;
      if (kind === 'rebound') t.rebind(50123);
      await writeFile(file, JSON.stringify(saved));
      const restarted = new AppService(t.connection, options);
      const result = await restarted.stop(key);
      if (kind === 'already-removed') expect(result).toMatchObject({ state: 'stopped', cleanupConfirmed: true });
      else
        expect(result).toMatchObject({
          state: 'failed',
          cleanupConfirmed: false,
          error: kind === 'publish-unknown' ? 'verification_recovery_publish_unknown' : 'verification_recovery_mapping_changed',
        });
      expect(t.commands().some((args) => args[0] === '--unpublish')).toBe(false);
    } finally {
      await owner.stop(key);
      await rm(root, { recursive: true, force: true });
    }
  });
});

describe('ended edu transport recovery admission', () => {
  it.each(['valid', 'bad-boot-evidence', 'source-changed', 'helper-lost', 'foreign-mapping'] as const)(
    'rechecks %s after the original transport ended unconfirmed',
    async (kind) => {
      const currentFiles = eduFiles.map((file) => ({ ...file }));
      const t = fixture({
        sourceFiles: currentFiles,
        crashOutcome: { confirmed: false, exitCode: 1, error: '[Errno 5] Input/output error' },
        recoveryBootReplacement: kind === 'bad-boot-evidence' ? 'invalid' : 'valid',
        ...(kind === 'helper-lost' ? { recoveryError: 'verification_recovery_helper_lost' } : {}),
      });
      await t.service.importEdu({ ...key, files: currentFiles, source: eduSource(currentFiles) });
      await t.service.start(key);
      if (kind === 'source-changed')
        currentFiles.find((f) => f.path === 'admin/src/App.tsx')!.base64 = Buffer.from('concurrent edit').toString('base64');
      if (kind === 'foreign-mapping') t.addCompetingMapping();
      t.crash();
      await Promise.resolve();
      const result = await t.service.stop(key);
      expect(result.cleanupConfirmed).toBe(kind === 'valid');
      expect(t.prompts().filter((p) => p.operation === 'recover-owned')).toHaveLength(kind === 'source-changed' ? 0 : 1);
      if (kind === 'valid') {
        expect(result.state).toBe('stopped');
        expect((await t.service.stop(key)).cleanupConfirmed).toBe(true);
        expect(t.prompts().filter((p) => p.operation === 'recover-owned')).toHaveLength(1);
      } else expect(t.commands().some((cmd) => cmd[0] === '--unpublish')).toBe(false);
    },
  );
  it('keeps unconfirmed standard transports outside edu recovery', async () => {
    const t = fixture({ crashOutcome: { confirmed: false, exitCode: 1, error: 'unconfirmed' } });
    await t.service.create({ ...key, files });
    await t.service.start(key);
    t.crash();
    await Promise.resolve();
    expect((await t.service.stop(key)).cleanupConfirmed).toBe(false);
    expect(t.prompts().some((p) => p.operation === 'recover-owned')).toBe(false);
  });
});

it('recovers an edu handle that becomes ended during the first stop before shared transport shutdown', async () => {
  const t = fixture({ sourceFiles: eduFiles, startCleanupFailure: true, recoveryBootReplacement: 'valid' });
  await t.service.importEdu({ ...key, files: eduFiles, source: eduSource() });
  await t.service.start(key);
  await expect(t.service.shutdown()).resolves.toBeUndefined();
  expect((await t.service.restore(key)).cleanupConfirmed).toBe(true);
  expect(t.prompts().filter((p) => p.operation === 'recover-owned')).toHaveLength(1);
});

it('rechecks a cancelled startup operation after its unconfirmed transport has ended', async () => {
  const t = fixture({ sourceFiles: eduFiles, startCleanupFailure: true, recoveryBootReplacement: 'valid' });
  await t.service.importEdu({ ...key, files: eduFiles, source: eduSource() });
  const starting = t.service.start(key);
  await vi.waitFor(() => expect(t.prompts().some((p) => p.operation === 'start')).toBe(true));
  const stopped = await t.service.stop(key);
  await starting;
  expect(stopped.cleanupConfirmed).toBe(true);
  expect(t.prompts().filter((p) => p.operation === 'recover-owned')).toHaveLength(1);
});

describe('durable edu applied-source publication', () => {
  it.each([false, true])('publishes a changed candidate only after registry publication, fail=%s', async (fail) => {
    const root = await mkdtemp(path.join(os.tmpdir(), 'wsl-sha-event-'));
    const registryPath = path.join(root, 'registry.json');
    const test = fixture({ sourceFiles: eduFiles });
    const source = eduSource();
    const candidateFiles = eduFiles.map((f) =>
      f.path === 'admin/src/App.tsx'
        ? {
            ...f,
            base64: Buffer.from('actual changed frontend candidate').toString('base64'),
          }
        : f,
    );
    const changedSha = eduSource(candidateFiles).sourceSha256;
    expect(changedSha).not.toBe(source.sourceSha256);
    const events: Array<{
      sha: string | undefined;
      state: string;
      durableSha: string;
    }> = [];
    const service = new AppService(test.connection, {
      ...test.options,
      registryPath,
      onSnapshot: (app) => {
        if (app.sourceSha256 === changedSha)
          events.push({
            sha: app.sourceSha256,
            state: app.state,
            durableSha: JSON.parse(readFileSync(registryPath, 'utf8')).apps[0].sourceSha256,
          });
      },
    });
    let release!: () => void, entered!: () => void;
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    const writing = new Promise<void>((resolve) => {
      entered = resolve;
    });
    const rename = fs.rename;
    let restoreRename: (() => void) | undefined;
    let operation: Promise<unknown> | undefined;
    try {
      await service.importEdu({ ...key, files: eduFiles, source });
      const running = await service.start(key);
      const binding = {
        ...key,
        runId: randomUUID(),
        appInstanceId: running.appInstanceId!,
        resourceId: 'web',
        instanceId: 'browser',
        generation: 1,
        webContentsId: 1,
        documentGeneration: 1,
        sourceSha256: source.sourceSha256,
        protectedFiles: source.files.filter((f) => !f.path.startsWith('admin/src/')),
      };
      const candidate = { runId: binding.runId, files: candidateFiles };
      await service.prepareTask(binding, candidate);
      const renameSpy = vi.spyOn(fs, 'rename').mockImplementation(async (from, to) => {
        if (to === registryPath) {
          entered();
          await gate;
          if (fail) throw new Error('controlled_registry_publication_failed');
        }
        return rename(from, to);
      });
      restoreRename = () => {
        renameSpy.mockRestore();
      };
      operation = service.applyTask(binding, candidate);
      await writing;
      expect(structuredClone(events)).toEqual([]);
      expect(JSON.parse(await readFile(registryPath, 'utf8')).apps[0].sourceSha256).toBe(source.sourceSha256);
      release();
      const outcome = (await operation) as Awaited<ReturnType<AppService['applyTask']>>;
      if (fail) {
        expect(outcome).toMatchObject({
          ok: false,
          operation: 'apply',
          cleanupConfirmed: true,
          error: 'controlled_registry_publication_failed',
        });
        expect(structuredClone(events)).toEqual([]);
        expect(JSON.parse(await readFile(registryPath, 'utf8')).apps[0].sourceSha256).toBe(source.sourceSha256);
      } else {
        expect(outcome).toMatchObject({ ok: true, operation: 'apply', cleanupConfirmed: true, app: { sourceSha256: changedSha } });
        expect(structuredClone(events)).toEqual([{ sha: changedSha, state: 'running', durableSha: changedSha }]);
      }
    } finally {
      release();
      if (operation) await operation;
      restoreRename?.();
      await service.stop(key);
      await rm(root, { recursive: true, force: true });
    }
  });
});

it('never rolls completed source back when real AppService events queue behind apply RPC', async () => {
  const { app, runtime, workspace, command, published } = await setupMain();
  const target: AppKey = {
    workspaceId: workspace.workspaceId,
    projectId: randomUUID(),
  };
  const test = fixture({ sourceFiles: eduFiles, identityKey: target });
  const eventPromises: Promise<void>[] = [];
  const actualEvents: Array<{ sourceSha256?: string }> = [];
  const service = new AppService(test.connection, {
    ...test.options,
    onSnapshot: (snapshot) => {
      actualEvents.push({ sourceSha256: snapshot.sourceSha256 });
      eventPromises.push(app.onApp(snapshot));
    },
  });
  const source = eduSource();
  const candidateFiles = eduFiles.map((f) =>
    f.path === 'admin/src/App.tsx'
      ? {
          ...f,
          base64: Buffer.from('integration frontend changed').toString('base64'),
        }
      : f,
  );
  const changedSha = eduSource(candidateFiles).sourceSha256;
  runtime.appSelectImportSource = vi.fn(async () => ({
    source,
    files: eduFiles,
    preview: {
      name: 'edu source fixture',
      profile: 'edu-web' as const,
      profileVersion: 1 as const,
      repository: source.repository,
      sourceSha256: source.sourceSha256,
      fileCount: source.files.length,
      totalBytes: source.files.reduce((total, file) => total + file.bytes, 0),
      warnings: [],
    },
    revalidate: async () => ({ source, files: eduFiles }),
  }));
  runtime.appImportSource = vi.fn((key, selected, importOperationId) => {
    // Confirmation allocates projectId and auto-starts before it returns. The
    // fake guest's health receipt must bind that exact project at dispatch.
    Object.assign(target, key);
    return service.importSource({ ...key, ...selected, importOperationId });
  });
  runtime.appCancelImport = vi.fn((key, importOperationId) => service.cancelImport({ ...key, importOperationId }));
  runtime.appStart = vi.fn((key) => service.start(key));
  runtime.appStop = vi.fn((key) => service.stop(key));
  runtime.eduTaskSource = vi.fn((key) => service.export(key, true));
  runtime.eduTaskCancel = vi.fn((binding) => service.cancelEduTask(binding));
  runtime.eduTaskPrepare = vi.fn((binding) =>
    service.prepareTask(binding, {
      runId: binding.runId,
      files: candidateFiles,
    }),
  );
  let eventsAtDispatch = 0;
  runtime.eduTaskApply = vi.fn((binding) => {
    eventsAtDispatch = actualEvents.length;
    return service.applyTask(binding, {
      runId: binding.runId,
      files: candidateFiles,
    });
  });
  runtime.registerSession = vi.fn();
  const sessionId = workspace.sessions[0]!.sessionId;
  const conversation = {
    conversationId: sessionId,
    generation: 'generation',
    turnId: 'turn',
    threadId: 'thread',
    seq: 1,
    state: 'running' as const,
    cleanupPending: true,
    messages: [],
    toolExecutions: [],
    warnings: [],
    error: null,
  };
  runtime.send = vi.fn(async () => conversation);
  let projectId: string | undefined;
  try {
    const importResult = await command({ type: 'importEduApp' });
    if (!importResult.ok) throw new Error(importResult.error.message);
    expect(importResult.ok).toBe(true);
    expect(runtime.appImportSource).not.toHaveBeenCalled();
    const preview = (await app.getSnapshot()).workspaces[0]!.appImport!;
    expect(preview.phase).toBe('ready');
    const confirmed = await command({ type: 'confirmAppImport', previewId: preview.previewId, sourceSha256: source.sourceSha256 });
    if (!confirmed.ok) throw new Error(confirmed.error.message);
    expect(runtime.appImportSource).toHaveBeenCalledTimes(1);
    expect(test.prompts().filter((prompt) => prompt.operation === 'import-source')).toHaveLength(1);
    const imported = (await app.getSnapshot()).workspaces[0]!.managedApp!;
    projectId = imported.projectId;
    // Confirming the two-phase import already starts the bound project once.
    expect(target.projectId).toBe(projectId);
    expect(runtime.appStart).toHaveBeenCalledExactlyOnceWith({ workspaceId: workspace.workspaceId, projectId });
    expect(imported).toMatchObject({ state: 'running', sourceSha256: source.sourceSha256 });
    const running = (await app.getSnapshot()).workspaces[0]!.managedApp!;
    const resource = (await app.getSnapshot()).workspaces[0]!.resources.find((r) => r.appProjectId === projectId)!;
    const page = {
      ...pageFixture,
      page: { ...pageFixture.page, url: running.url + '/student' },
    };
    vi.mocked(runtime.browserState).mockReturnValue(page);
    expect(
      (
        await command({
          type: 'captureContext',
          resourceId: resource.resourceId,
          sessionId,
          requestId: 'sha-capture',
        })
      ).ok,
    ).toBe(true);
    const active = (await app.getSnapshot()).workspaces[0]!.resources.find((r) => r.resourceId === resource.resourceId)!;
    app.onCapture(resource.resourceId, { ...captureFixture, page: page.page }, active.instanceId, active.generation, 'sha-capture');
    await app.getSnapshot();
    expect(
      (
        await command({
          type: 'confirmTask',
          sessionId,
          goal: 'frontend change',
          targetRef: { kind: 'web', resourceId: resource.resourceId },
        })
      ).ok,
    ).toBe(true);
    const version = (await app.getSnapshot()).workspaces[0]!.sessions[0]!.taskVersions.at(-1)!;
    expect(
      (
        await command({
          type: 'startRun',
          sessionId,
          taskVersionId: version.taskVersionId,
        })
      ).ok,
    ).toBe(true);
    await vi.waitFor(() => expect(runtime.send).toHaveBeenCalledOnce());
    const run = (await app.getSnapshot()).workspaces[0]!.runs.at(-1)!;
    app.onConversation({
      ...conversation,
      state: 'idle',
      seq: 2,
      cleanupPending: false,
      eduCandidateRunId: run.runId,
    });
    await vi.waitFor(async () => expect((await app.getSnapshot()).workspaces[0]!.runs.at(-1)?.state).toBe('completed'));
    await Promise.all(eventPromises);
    const completedSnapshots = published.filter(
      (snapshot) => snapshot.workspaces[0]?.runs.find((r) => r.runId === run.runId)?.state === 'completed',
    );
    expect(completedSnapshots.length).toBeGreaterThan(0);
    expect(completedSnapshots.map((s) => s.workspaces[0]!.managedApp?.sourceSha256)).toEqual(completedSnapshots.map(() => changedSha));
    expect(actualEvents.slice(eventsAtDispatch).map((e) => e.sourceSha256)).toEqual([changedSha]);
    const current = (await app.getSnapshot()).workspaces[0]!.managedApp!;
    await app.onApp({
      ...current,
      appInstanceId: randomUUID(),
      sourceSha256: source.sourceSha256,
    });
    expect((await app.getSnapshot()).workspaces[0]!.managedApp?.sourceSha256).toBe(changedSha);
  } finally {
    if (projectId) await service.stop({ workspaceId: workspace.workspaceId, projectId });
    await Promise.all(eventPromises);
  }
});

describe('edu finite helper cleanup facts', () => {
  const bindingFor = (appInstanceId: string) => {
    const source = eduSource();
    return {
      ...key,
      runId: randomUUID(),
      appInstanceId,
      resourceId: 'web',
      instanceId: 'browser',
      generation: 1,
      webContentsId: 1,
      documentGeneration: 1,
      sourceSha256: source.sourceSha256,
      protectedFiles: source.files.filter((file) => !file.path.startsWith('admin/src/')),
    };
  };
  it('cancel before queued source dispatch leaves a tombstone and never stops the App', async () => {
    const test = fixture({ sourceFiles: eduFiles });
    await test.service.importEdu({ ...key, files: eduFiles, source: eduSource() });
    const running = await test.service.start(key);
    const binding = bindingFor(running.appInstanceId!);
    test.service.registerEduTask(binding);
    const count = test.starts();
    expect(await test.service.cancelEduTask(binding)).toEqual({ binding, operation: 'cancel', ok: true, cleanupConfirmed: true });
    await expect(test.service.taskSource(binding)).rejects.toThrow('cancelled');
    expect(await test.service.prepareTask(binding, { runId: binding.runId, files: eduFiles })).toMatchObject({
      ok: false,
      cleanupConfirmed: true,
    });
    expect(test.starts()).toBe(count);
    expect(test.service.get(key)).toMatchObject({ state: 'running', appInstanceId: running.appInstanceId });
    expect(test.commands().some((args) => args[0] === '--unpublish')).toBe(false);
    await test.service.stop(key);
  });
  it('cancel waits for the precise export helper while preserving the long-lived App', async () => {
    let release!: () => void;
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    const test = fixture({ sourceFiles: eduFiles, exportGate: gate });
    await test.service.importEdu({ ...key, files: eduFiles, source: eduSource() });
    const running = await test.service.start(key);
    const binding = bindingFor(running.appInstanceId!);
    const preparing = test.service.prepareTask(binding, { runId: binding.runId, files: eduFiles });
    await vi.waitFor(() => expect(test.prompts().some((p) => p.operation === 'export')).toBe(true));
    const result = await test.service.cancelEduTask(binding);
    expect(result).toMatchObject({ operation: 'cancel', ok: true, cleanupConfirmed: true });
    expect(await preparing).toMatchObject({ operation: 'prepare', ok: false, cleanupConfirmed: true });
    expect(test.service.get(key)).toMatchObject({ state: 'running', appInstanceId: running.appInstanceId });
    expect(test.commands().some((args) => args[0] === '--unpublish')).toBe(false);
    release();
    await test.service.stop(key);
  });
  it('unknown old run cancellation cannot certify cleanup or permit a delayed prepare', async () => {
    const test = fixture({ sourceFiles: eduFiles });
    await test.service.importEdu({ ...key, files: eduFiles, source: eduSource() });
    const running = await test.service.start(key);
    const binding = bindingFor(running.appInstanceId!);
    const count = test.starts();
    expect(await test.service.cancelEduTask(binding)).toMatchObject({ ok: false, cleanupConfirmed: false });
    expect(await test.service.prepareTask(binding, { runId: binding.runId, files: eduFiles })).toMatchObject({
      ok: false,
      cleanupConfirmed: false,
    });
    expect(test.starts()).toBe(count);
    expect(await test.service.stop(key)).toMatchObject({ cleanupConfirmed: false });
  });
  it('preserves dispatch uncertainty even when the running App is healthy', async () => {
    const test = fixture({ sourceFiles: eduFiles });
    await test.service.importEdu({ ...key, files: eduFiles, source: eduSource() });
    const running = await test.service.start(key);
    const binding = bindingFor(running.appInstanceId!);
    const start = vi.spyOn(test.connection, 'start').mockImplementation(() => {
      throw new Error('transport lost after dispatch');
    });
    try {
      expect(await test.service.prepareTask(binding, { runId: binding.runId, files: eduFiles })).toMatchObject({
        ok: false,
        cleanupConfirmed: false,
      });
      expect(await test.service.cancelEduTask(binding)).toMatchObject({ ok: false, cleanupConfirmed: false });
      expect(await test.service.sourceSnapshot(key)).toMatchObject({ ok: false, cleanupConfirmed: true });
      expect(start).toHaveBeenCalledOnce();
    } finally {
      start.mockRestore();
      await test.service.stop(key);
    }
  });
});

it.each([1, 2] as const)('upgrades registry v%s without replaying a process or changing profile provenance', async (version) => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'wsl-registry-upgrade-'));
  const registryPath = path.join(root, 'registry.json');
  const source = eduSource();
  const profile: AppProfile =
    version === 1 ? { projectKind: 'standard-app', profileVersion: 1 } : { projectKind: 'edu-web', profileVersion: 1, source };
  const original = JSON.stringify({
    version,
    sandbox: 'sandbox-test',
    apps: [
      {
        ...key,
        state: 'stopped',
        cleanupConfirmed: true,
        ...(version === 2 ? { profile, sourceSha256: source.sourceSha256 } : {}),
      },
    ],
  });
  const test = fixture();
  try {
    await writeFile(registryPath, original);
    const service = new AppService(test.connection, { ...test.options, registryPath });
    expect(await service.restore(key)).toMatchObject({ profile, cleanupConfirmed: true });
    await service.stop(key);
    const saved = JSON.parse(await readFile(registryPath, 'utf8'));
    expect(saved.version).toBe(3);
    expect(saved.apps[0]).toMatchObject({ profile, processExpected: false, port: null, portPending: false });
    expect(test.starts()).toBe(0);
    if (version === 1) expect(await readFile(registryPath + '.schema-v1.json', 'utf8')).toBe(original);
    else {
      expect(saved.apps[0].sourceSha256).toBe(source.sourceSha256);
      await expect(readFile(registryPath + '.schema-v1.json')).rejects.toMatchObject({ code: 'ENOENT' });
    }
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
