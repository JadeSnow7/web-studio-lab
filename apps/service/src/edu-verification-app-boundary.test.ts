import * as fs from 'node:fs/promises';
import { createHash, randomUUID } from 'node:crypto';
import { mkdtemp, rm, mkdir, writeFile } from 'node:fs/promises';
import { readFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { describe, expect, it, vi } from 'vitest';
import { EDU_REQUIRED_FILES } from '@wsl/protocol';
import { AppService, type AppKey, type AppSnapshot } from './app-service';
import { EduVerificationService } from './edu-verification';
import { RecoveryJournal } from './edu-recovery-journal';
import { MaintenanceGate } from './maintenance-gate';
import type { GuestFrame, GuestOutcome, GuestStart } from './sbx';

vi.mock('node:fs/promises', async (original) => ({ ...(await original<typeof fs>()) }));

const provider = {
  schemaVersion: 1 as const,
  host: 'example.invalid',
  user: 'provider',
  identityFile: '/private/key',
  hostKeyAlias: 'provider.test',
  knownHostsFile: '/private/hosts',
  pythonExecutable: '/provider/python',
  providerPath: '/provider/program.py',
};
async function fixture() {
  const key: AppKey = { workspaceId: 'strict-app-boundary', projectId: randomUUID() };
  const files = [...EDU_REQUIRED_FILES, 'admin/src/App.tsx']
    .sort()
    .map((file) => ({ path: file, base64: Buffer.from(file).toString('base64') }));
  const metadata = files.map((file) => {
    const bytes = Buffer.from(file.base64, 'base64');
    return { path: file.path, sha256: createHash('sha256').update(bytes).digest('hex'), bytes: bytes.length };
  });
  const source = {
    repository: { commit: 'a'.repeat(40), dirty: false },
    sourceSha256: createHash('sha256').update(JSON.stringify(metadata)).digest('hex'),
    files: metadata,
  };
  let identity: Record<string, unknown> = {},
    published = false,
    launches = 0,
    hostPort = 49151;
  const connection = {
    runtimeTarget: () => ({ binary: '/not-executed/sbx', sandbox: 'strict-boundary-guest' }),
    getStatus: () => ({
      available: true,
      reason: null,
      sandbox: 'strict-boundary-guest',
      version: 'fixture',
      cwd: '/home/agent/workspace',
    }),
    start: (start: GuestStart, onFrame: (frame: GuestFrame) => void) => {
      if (start.mode !== 'codex') throw new Error('unexpected guest mode');
      const input = JSON.parse(start.prompt!);
      launches++;
      let finish!: (outcome: GuestOutcome) => void;
      const done = new Promise<GuestOutcome>((resolve) => {
        finish = resolve;
      });
      if (input.operation === 'start') identity = { ...key, environmentId: 'sandbox', appInstanceId: input.appInstanceId };
      queueMicrotask(() => {
        if (input.operation === 'start')
          onFrame({
            type: 'output',
            stream: 'stdout',
            data: 'WSL_APP_SOURCE:' + source.sourceSha256 + '\n' + JSON.stringify({ event: 'app-ready', port: 43187, identity }) + '\n',
          });
        else {
          onFrame({
            type: 'output',
            stream: 'stdout',
            data: 'WSL_APP_RESULT:' + JSON.stringify(input.operation === 'create' ? { created: true } : { files }) + '\n',
          });
          finish({ confirmed: true, exitCode: 0, error: null });
        }
      });
      return {
        done,
        close: async () => {
          finish({ confirmed: true, exitCode: 0, error: null });
          return done;
        },
      };
    },
  };
  const root = await mkdtemp(path.join(os.tmpdir(), 'edu-real-app-key-'));
  const registryPath = path.join(root, 'registry', 'apps.json');
  const snapshots: AppSnapshot[] = [],
    trace: string[] = [];
  let healthHook: (() => Promise<void>) | null = null,
    invalidHealth = false;
  const apps = new AppService(connection, {
    registryPath,
    onSnapshot: (snapshot) => {
      snapshots.push(structuredClone(snapshot));
      trace.push('app:' + snapshot.state + ':' + snapshot.appInstanceId);
      if (snapshot.state === 'running') {
        const durable = JSON.parse(readFileSync(registryPath, 'utf8')).apps.find(
          (item: { projectId: string }) => item.projectId === key.projectId,
        );
        expect(durable.state).toBe('running');
        expect(durable.appInstanceId).toBe(snapshot.appInstanceId);
      }
    },
    startupTimeoutMs: 2000,
    ports: async (args) => {
      if (args[0] === '--publish') {
        published = true;
        hostPort++;
        return `Published 127.0.0.1:${hostPort} -> 43187/tcp4\n`;
      }
      if (args[0] === '--unpublish') {
        published = false;
        return '';
      }
      return JSON.stringify(published ? [{ host_ip: '127.0.0.1', host_port: hostPort, sandbox_port: 43187, protocol: 'tcp4' }] : []);
    },
    fetch: async () => {
      await healthHook?.();
      return new Response(
        JSON.stringify({
          ok: true,
          templateId: 'edu-web',
          templateVersion: '1.0.0',
          identity: invalidHealth ? { ...identity, appInstanceId: randomUUID() } : identity,
        }),
      );
    },
  });
  const gate = new MaintenanceGate(),
    journal = new RecoveryJournal(path.join(root, 'journal.json'), gate),
    runner = vi.fn(async () => Buffer.alloc(0));
  const service = new EduVerificationService(apps, gate, async () => undefined, {
    loadConfig: async () => provider,
    runner,
    journal,
    onStatus: (status) => trace.push('verification:' + status.phase + ':' + status.lease.identity.appInstanceId),
    fetch: async () => {
      throw new TypeError('not listening', { cause: { code: 'ECONNREFUSED' } });
    },
  });
  await apps.importEdu({ ...key, files, source });
  const original = await apps.start(key);
  const input = { ...key, appInstanceId: original.appInstanceId!, sourceSha256: source.sourceSha256 };
  const monitored = [
    vi.spyOn(apps, 'restore'),
    vi.spyOn(apps, 'export'),
    vi.spyOn(apps, 'stop'),
    vi.spyOn(apps, 'start'),
    vi.spyOn(apps, 'inspectRecovery'),
    vi.spyOn(apps, 'captureRecoverySource'),
  ];
  return {
    apps,
    service,
    gate,
    runner,
    input,
    key,
    source,
    original,
    snapshots,
    trace,
    registryPath,
    setHealthHook: (hook: (() => Promise<void>) | null) => {
      healthHook = hook;
    },
    setInvalidHealth: () => {
      invalidHealth = true;
    },
    launches: () => launches,
    assertKeys: () => {
      for (const method of monitored)
        for (const args of method.mock.calls) expect(Object.keys(args[0]).sort()).toEqual(['projectId', 'workspaceId']);
    },
    close: async () => {
      await apps.stop(key);
      await rm(root, { recursive: true, force: true });
    },
  };
}
describe('verification uses the real strict AppService project boundary', () => {
  it('AppService rejects begin identity as a project key; service begin/end and reconcile project it without weakening strictness', async () => {
    const f = await fixture();
    try {
      await expect(f.apps.restore(f.input)).rejects.toMatchObject({ name: 'ZodError' });
      const direct = f.apps.restore(f.key);
      await expect(direct).resolves.toMatchObject({ state: 'running' });
      // Forwarding spies retain real AppService methods; there is no permissive restore mock.
      for (const spy of [vi.mocked(f.apps.restore)]) spy.mockClear();
      const active = await f.service.begin(f.input);
      expect(active.phase).toBe('active');
      expect(active.callsUsed).toBe(0);
      expect(active.lease.identity.appInstanceId).not.toBe(f.original.appInstanceId);
      const target = { ...f.key, appInstanceId: active.lease.identity.appInstanceId, sessionId: active.lease.sessionId };
      const ended = await f.service.end(target);
      expect(ended.phase).toBe('ended');
      expect(f.gate.isLocked()).toBe(false);
      expect((await f.apps.restore(f.key)).appInstanceId).not.toBe(active.lease.identity.appInstanceId);
      expect((await f.service.reconcile(target)).phase).toBe('ended');
      expect(f.runner).not.toHaveBeenCalled();
      f.assertKeys();
    } finally {
      await f.close();
    }
  });
  it('cancel-only admission recovery passes exact keys to inspect/capture/stop/start and preserves original identity in its journal', async () => {
    const f = await fixture();
    try {
      const recovered = await f.service.recoverAdmission(f.input);
      expect(recovered.phase).toBe('ended');
      expect(recovered.originalIdentity.appInstanceId).toBe(f.original.appInstanceId);
      expect(recovered.sourceSha256).toBe(f.source.sourceSha256);
      expect(recovered.restoredIdentity?.appInstanceId).not.toBe(f.original.appInstanceId);
      expect(f.gate.isLocked()).toBe(false);
      expect(f.runner).not.toHaveBeenCalled();
      f.assertKeys();
    } finally {
      await f.close();
    }
  });
  it.each(['appInstanceId', 'sourceSha256'] as const)(
    'project projection retains frozen %s rejection before taking ownership',
    async (field) => {
      const f = await fixture();
      const before = f.launches();
      try {
        await expect(f.service.begin({ ...f.input, [field]: field === 'appInstanceId' ? randomUUID() : 'b'.repeat(64) })).rejects.toThrow(
          'verification_source_or_instance_changed',
        );
        expect(f.launches()).toBe(before);
        expect((await f.apps.restore(f.key)).appInstanceId).toBe(f.original.appInstanceId);
        expect(f.runner).not.toHaveBeenCalled();
        f.assertKeys();
      } finally {
        await f.close();
      }
    },
  );
});

describe('real AppService start publication before verification activation', () => {
  it('publishes one durable running snapshot for the leased instance before active even though startup events are asynchronous', async () => {
    const f = await fixture();
    f.trace.length = 0;
    f.snapshots.length = 0;
    try {
      const active = await f.service.begin(f.input),
        id = active.lease.identity.appInstanceId;
      const leased = f.snapshots.filter((snapshot) => snapshot.appInstanceId === id);
      expect(leased.at(-1)?.state).toBe('running');
      expect(leased.at(-1)?.url).toBeTruthy();
      expect(leased.filter((snapshot) => snapshot.state === 'running')).toHaveLength(1);
      expect(f.trace.indexOf('app:running:' + id)).toBeGreaterThanOrEqual(0);
      expect(f.trace.indexOf('app:running:' + id)).toBeLessThan(f.trace.indexOf('verification:active:' + id));
      const count = f.snapshots.length;
      await f.apps.start(f.key);
      expect(f.snapshots).toHaveLength(count);
      await f.service.end({ ...f.key, appInstanceId: id, sessionId: active.lease.sessionId });
    } finally {
      await f.close();
    }
  });
  it('publishes a failed startup terminal snapshot after durable state and never false running', async () => {
    const f = await fixture();
    await f.apps.stop(f.key);
    f.snapshots.length = 0;
    f.setInvalidHealth();
    try {
      const failed = await f.apps.start(f.key);
      expect(failed.state).toBe('failed');
      expect(f.snapshots.at(-1)?.state).toBe('failed');
      expect(f.snapshots.filter((snapshot) => snapshot.state === 'failed')).toHaveLength(1);
      expect(f.snapshots.some((snapshot) => snapshot.state === 'running')).toBe(false);
      expect(JSON.parse(readFileSync(f.registryPath, 'utf8')).apps[0].state).toBe('failed');
    } finally {
      await f.close();
    }
  });
  it('never publishes completed running if final durable registry publication fails', async () => {
    const f = await fixture();
    await f.apps.stop(f.key);
    f.snapshots.length = 0;
    f.setHealthHook(async () => {
      await rm(path.dirname(f.registryPath), { recursive: true });
      await writeFile(path.dirname(f.registryPath), 'blocks registry parent');
    });
    try {
      await expect(f.apps.start(f.key)).rejects.toThrow();
      expect(f.snapshots.some((snapshot) => snapshot.state === 'running')).toBe(false);
      expect(f.snapshots.some((snapshot) => snapshot.state === 'starting')).toBe(true);
    } finally {
      f.setHealthHook(null);
      await rm(path.dirname(f.registryPath), { force: true, recursive: true });
      await mkdir(path.dirname(f.registryPath));
      await f.close();
    }
  });
});

it('a stop superseding startup during final durable publication cannot emit delayed running', async () => {
  const f = await fixture();
  await f.apps.stop(f.key);
  f.snapshots.length = 0;
  let unlock!: () => void, entered!: () => void;
  const held = new Promise<void>((resolve) => {
      unlock = resolve;
    }),
    cut = new Promise<void>((resolve) => {
      entered = resolve;
    });
  const realRename = (await vi.importActual<typeof fs>('node:fs/promises')).rename;
  let publications = 0;
  const rename = vi.spyOn(fs, 'rename').mockImplementation(async (from, to) => {
    if (to === f.registryPath && ++publications === 2) {
      entered();
      await held;
    }
    return realRename(from, to);
  });
  try {
    const starting = f.apps.start(f.key);
    await cut;
    const stopping = f.apps.stop(f.key);
    unlock();
    await starting;
    const stopped = await stopping;
    expect(stopped.state).toBe('stopped');
    expect(stopped.cleanupConfirmed).toBe(true);
    expect(f.snapshots.some((snapshot) => snapshot.state === 'running')).toBe(false);
    expect(f.snapshots.at(-1)?.state).toBe('stopped');
  } finally {
    unlock();
    rename.mockRestore();
    await f.close();
  }
});
