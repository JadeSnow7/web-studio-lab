import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { describe, expect, it, vi } from 'vitest';
import { RecoveryJournal } from './edu-recovery-journal';
import { EduVerificationService } from './edu-verification';
import { MaintenanceGate } from './maintenance-gate';
import type { AppService, AppSnapshot } from './app-service';
import type { EduVerificationStatus } from '@wsl/protocol';
import type { ProviderConfig } from './edu-provider';
async function fixture() {
  const root = await mkdtemp(path.join(tmpdir(), 'edu-admission-'));
  const filename = path.join(root, 'journal.json');
  const input = { workspaceId: 'space', projectId: randomUUID(), appInstanceId: randomUUID(), sourceSha256: 'a'.repeat(64) };
  let instance: string = input.appInstanceId;
  let running = true;
  const snapshot = () =>
    ({
      ...input,
      appInstanceId: instance,
      state: running ? 'running' : 'stopped',
      profile: { projectKind: 'edu-web' },
      url: 'http://127.0.0.1:49150',
      cleanupConfirmed: true,
    }) as AppSnapshot;
  const apps = {
    inspectRecovery: vi.fn(async () => ({ appInstanceId: instance, sourceSha256: input.sourceSha256, url: 'http://127.0.0.1:49150' })),
    captureRecoverySource: vi.fn(async () => input.sourceSha256),
    stop: vi.fn(async () => ({ ...snapshot(), state: 'stopped', cleanupConfirmed: true })),
    start: vi.fn(async (_key: unknown, verification: unknown, reserved: string) => {
      expect(verification).toBeUndefined();
      const saved = JSON.parse(await readFile(filename, 'utf8'));
      expect(saved.admissionOnly).toBe(true);
      expect(saved.restoreInstanceIds).toContain(reserved);
      instance = reserved;
      running = true;
      return snapshot();
    }),
    restore: vi.fn(async () => snapshot()),
    export: vi.fn(),
    recoverOwned: vi.fn(),
    writeVerification: vi.fn(),
    closeVerificationInput: vi.fn(),
  };
  const loadConfig = vi.fn(async () => {
    throw Error('provider must never load');
  });
  const statuses: EduVerificationStatus[] = [];
  const open = (provider: () => Promise<ProviderConfig> = loadConfig) => {
    const gate = new MaintenanceGate();
    const service = new EduVerificationService(
      apps as unknown as AppService,
      gate,
      vi.fn(async () => undefined),
      {
        journal: new RecoveryJournal(filename, gate),
        loadConfig: provider,
        onStatus: (status) => statuses.push(status),
        fetch: vi.fn(async () => {
          throw new TypeError('closed', { cause: { code: 'ECONNREFUSED' } });
        }),
      },
    );
    return { gate, service };
  };
  return {
    root,
    filename,
    input,
    apps,
    loadConfig,
    statuses,
    open,
    setStopped: () => {
      running = false;
    },
    setInstance: (id: string) => {
      instance = id;
    },
  };
}
describe('admission-only durable recovery (simulated interruption)', () => {
  it('recovers original without provider; repeated result requires the exact restored instance', async () => {
    const f = await fixture();
    try {
      const { service, gate } = f.open();
      await service.initialize();
      const result = await service.recoverAdmission(f.input);
      expect(result).toMatchObject({ kind: 'admission-recovery', phase: 'ended', maintenanceLocked: false });
      expect(result.restoredIdentity!.appInstanceId).not.toBe(f.input.appInstanceId);
      expect(gate.isLocked()).toBe(false);
      expect(f.loadConfig).not.toHaveBeenCalled();
      expect((await service.recoverAdmission(f.input)).recoveryId).toBe(result.recoveryId);
      expect(f.apps.stop).toHaveBeenCalledOnce();
      f.setInstance(randomUUID());
      await expect(service.recoverAdmission(f.input)).rejects.toThrow('verification_recovery_identity_mismatch');
      expect(f.apps.stop).toHaveBeenCalledOnce();
    } finally {
      await rm(f.root, { recursive: true, force: true });
    }
  });
  it.each(['identity', 'source'] as const)('rejects changed %s before stop or journal creation', async (kind) => {
    const f = await fixture();
    try {
      if (kind === 'identity') f.setInstance(randomUUID());
      else f.apps.captureRecoverySource.mockResolvedValue('b'.repeat(64));
      const { service } = f.open();
      await service.initialize();
      await expect(service.recoverAdmission(f.input)).rejects.toThrow(/verification_recovery_(identity_mismatch|source_changed)/);
      expect(f.apps.stop).not.toHaveBeenCalled();
      expect(f.apps.start).not.toHaveBeenCalled();
      await expect(readFile(f.filename)).rejects.toMatchObject({ code: 'ENOENT' });
    } finally {
      await rm(f.root, { recursive: true, force: true });
    }
  });
  it('resumes a real cancel-only journal after interruption during default start', async () => {
    const f = await fixture();
    try {
      const first = f.open();
      await first.service.initialize();
      const actual = f.apps.start.getMockImplementation()!;
      f.apps.start.mockImplementationOnce(async (...args) => {
        await actual(...args);
        throw Error('simulated service exit after start');
      });
      await expect(first.service.recoverAdmission(f.input)).rejects.toThrow('verification_admission_recovery_unconfirmed');
      const interrupted = JSON.parse(await readFile(f.filename, 'utf8'));
      expect(interrupted.status.phase).toBe('restoring');
      const next = f.open();
      expect(next.gate.isLocked()).toBe(true);
      await next.service.initialize();
      const result = await next.service.recoverAdmission(f.input);
      expect(result.phase).toBe('ended');
      expect(next.gate.isLocked()).toBe(false);
      expect(f.loadConfig).not.toHaveBeenCalled();
      const saved = JSON.parse(await readFile(f.filename, 'utf8'));
      expect(saved.restoreInstanceIds).toHaveLength(2);
    } finally {
      await rm(f.root, { recursive: true, force: true });
    }
  });
});

it('retains failed begin journal before ownership; target reconcile creates a fresh AI0 instance', async () => {
  const f = await fixture();
  try {
    const provider = vi.fn(async () => ({
      schemaVersion: 1 as const,
      host: 'example.invalid',
      user: 'provider',
      identityFile: '/private/key',
      hostKeyAlias: 'provider.test',
      knownHostsFile: '/private/known',
      pythonExecutable: '/immutable/python',
      providerPath: '/immutable/provider.py',
    }));
    const { service, gate } = f.open(provider);
    await service.initialize();
    f.apps.export.mockRejectedValueOnce(new Error('simulated export failure'));
    await expect(service.begin(f.input)).rejects.toThrow('verification_begin_failed');
    expect(gate.isLocked()).toBe(true);
    expect(f.apps.stop).not.toHaveBeenCalled();
    const failed = f.statuses.at(-1)!;
    expect(failed.phase).toBe('failed');
    expect(JSON.parse(await readFile(f.filename, 'utf8')).status.phase).toBe('failed');
    await expect(service.recoverAdmission(f.input)).rejects.toThrow('verification_maintenance_locked');
    // The normal verification journal uses its own reserved restoration contract.
    f.apps.start.mockImplementationOnce(async (_key, verification, reserved) => {
      expect(verification).toBeUndefined();
      const saved = JSON.parse(await readFile(f.filename, 'utf8'));
      expect(saved.restoreInstanceIds).toContain(reserved);
      return { ...(await f.apps.restore()), appInstanceId: reserved };
    });
    const restored = await service.reconcile({ ...failed.lease.identity, sessionId: failed.lease.sessionId });
    expect(restored.phase).toBe('ended');
    expect(gate.isLocked()).toBe(false);
    expect(f.apps.stop).toHaveBeenCalledOnce();
  } finally {
    await rm(f.root, { recursive: true, force: true });
  }
});
it('keeps the admission gate through delayed startup reading an ended journal', async () => {
  const f = await fixture();
  try {
    const first = f.open();
    await first.service.initialize();
    const completed = await first.service.recoverAdmission(f.input);
    const gate = new MaintenanceGate();
    const queued = gate.admission();
    const journal = new RecoveryJournal(f.filename, gate);
    let ready!: () => void;
    const barrier = new Promise<void>((resolve) => {
      ready = resolve;
    });
    const service = new EduVerificationService(f.apps as unknown as AppService, gate, async () => undefined, {
      journal,
      ensureReady: () => barrier,
      loadConfig: f.loadConfig,
      fetch: async () => {
        throw new TypeError('closed', { cause: { code: 'ECONNREFUSED' } });
      },
    });
    const inspect = f.apps.inspectRecovery.getMockImplementation()!;
    f.apps.inspectRecovery.mockImplementation(async () => {
      expect(gate.isLocked()).toBe(true);
      return inspect();
    });
    const recovering = service.recoverAdmission(f.input);
    await service.initialize();
    expect(gate.isLocked()).toBe(true);
    ready();
    expect((await recovering).recoveryId).toBe(completed.recoveryId);
    expect(() => queued()).toThrow('verification_admission_revoked');
  } finally {
    await rm(f.root, { recursive: true, force: true });
  }
});
it.each(['null', 'cross-project', 'original', 'unreserved'] as const)(
  'rejects %s restored identity from a real journal and keeps startup locked',
  async (kind) => {
    const f = await fixture();
    try {
      const first = f.open();
      await first.service.initialize();
      await first.service.recoverAdmission(f.input);
      const saved = JSON.parse(await readFile(f.filename, 'utf8'));
      if (kind === 'null') saved.status.restoredIdentity = null;
      if (kind === 'cross-project') saved.status.restoredIdentity.projectId = randomUUID();
      if (kind === 'original') saved.status.restoredIdentity.appInstanceId = f.input.appInstanceId;
      if (kind === 'unreserved') saved.status.restoredIdentity.appInstanceId = randomUUID();
      await writeFile(f.filename, JSON.stringify(saved), { mode: 0o600 });
      const next = f.open();
      await expect(next.service.initialize()).rejects.toThrow();
      expect(next.gate.isLocked()).toBe(true);
      expect(f.apps.stop).toHaveBeenCalledOnce();
    } finally {
      await rm(f.root, { recursive: true, force: true });
    }
  },
);

it('does not replay completed admission on normal reopen; explicit marker recovery restarts a stopped reserved instance', async () => {
  const f = await fixture();
  try {
    const first = f.open();
    await first.service.initialize();
    const prior = await first.service.recoverAdmission(f.input);
    f.setStopped();
    const gate = new MaintenanceGate(),
      event = vi.fn();
    const service = new EduVerificationService(f.apps as unknown as AppService, gate, async () => undefined, {
      journal: new RecoveryJournal(f.filename, gate),
      onAdmissionStatus: event,
      fetch: async () => {
        throw new TypeError('closed', { cause: { code: 'ECONNREFUSED' } });
      },
    });
    await service.initialize();
    expect(gate.isLocked()).toBe(false);
    expect(event).not.toHaveBeenCalled();
    const recovered = await service.recoverAdmission(f.input);
    expect(recovered.phase).toBe('ended');
    expect(recovered.restoredIdentity!.appInstanceId).not.toBe(prior.restoredIdentity!.appInstanceId);
    expect(gate.isLocked()).toBe(false);
  } finally {
    await rm(f.root, { recursive: true, force: true });
  }
});
