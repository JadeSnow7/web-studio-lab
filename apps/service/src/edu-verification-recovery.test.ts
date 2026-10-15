import { mkdtemp, rm, readFile, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { describe, it, expect, vi } from 'vitest';
import { RecoveryJournal, atomicPrivateJson, type RecoveryRecord } from './edu-recovery-journal';
import { EduVerificationService } from './edu-verification';
import { MaintenanceGate } from './maintenance-gate';
import type { AppService, AppSnapshot } from './app-service';
const source = 'a'.repeat(64);
const original = { workspaceId: 'space', projectId: randomUUID(), environmentId: 'sandbox' as const, appInstanceId: randomUUID() };
const leased = { ...original, appInstanceId: randomUUID() };
function record(phase: 'preparing' | 'active' | 'restoring'): RecoveryRecord {
  return {
    schemaVersion: 1,
    originalIdentity: original,
    status: {
      lease: { schemaVersion: 1, sessionId: randomUUID(), identity: leased, sourceSha256: source, expiresAtMs: 1000 },
      phase,
      callsUsed: 1,
      maintenanceLocked: true,
      error: null,
    },
    restoreInstanceIds: phase === 'restoring' ? [randomUUID()] : [],
    urls: ['http://127.0.0.1:49152'],
    ownershipTaken: phase !== 'preparing',
  };
}
async function fixture(phase: 'preparing' | 'active' | 'restoring') {
  const root = await mkdtemp(path.join(tmpdir(), 'edu-real-journal-'));
  const file = path.join(root, 'journal.json');
  const value = record(phase);
  await atomicPrivateJson(file, value);
  const selected =
    phase === 'preparing' ? original.appInstanceId : phase === 'active' ? leased.appInstanceId : value.restoreInstanceIds[0]!;
  let facts = {
    appInstanceId: selected,
    sourceSha256: source,
    url: 'http://127.0.0.1:49153',
    cleanupConfirmed: false,
    processExpected: true,
    portPending: true,
    port: { host_ip: '127.0.0.1' as const, host_port: 49153, sandbox_port: 44000, protocol: 'tcp4' },
  };
  const snapshot = () =>
    ({
      ...original,
      appInstanceId: facts.appInstanceId,
      sourceSha256: facts.sourceSha256,
      profile: { projectKind: 'edu-web' },
      state: facts.cleanupConfirmed ? 'stopped' : 'running',
      url: facts.url,
      cleanupConfirmed: facts.cleanupConfirmed,
    }) as AppSnapshot;
  const apps = {
    inspectRecovery: vi.fn(async () => structuredClone(facts)),
    captureRecoverySource: vi.fn(async () => source),
    recoverOwned: vi.fn(async () => {
      facts = { ...facts, cleanupConfirmed: true, processExpected: false, portPending: false, url: '' };
      return snapshot();
    }),
    start: vi.fn(async (_key: unknown, verification: unknown, reserved?: string) => {
      expect(verification).toBeUndefined();
      expect(reserved).toBeTruthy();
      const persisted = JSON.parse(await readFile(file, 'utf8'));
      expect(persisted.restoreInstanceIds).toContain(reserved);
      facts = { ...facts, appInstanceId: reserved!, cleanupConfirmed: false, processExpected: true, url: 'http://127.0.0.1:49154' };
      return { ...snapshot(), state: 'running' } as AppSnapshot;
    }),
    restore: vi.fn(async () => snapshot()),
    stop: vi.fn(async () => {
      return apps.recoverOwned();
    }),
    export: vi.fn(),
    writeVerification: vi.fn(),
    closeVerificationInput: vi.fn(),
  };
  const drain = vi.fn(async () => undefined),
    fetchClosed = vi.fn(async () => {
      throw new TypeError('closed', { cause: { code: 'ECONNREFUSED' } });
    });
  const open = () => {
    const gate = new MaintenanceGate();
    const journal = new RecoveryJournal(file, gate);
    const service = new EduVerificationService(apps as unknown as AppService, gate, drain, { journal, fetch: fetchClosed });
    return { gate, journal, service };
  };
  return {
    root,
    file,
    value,
    apps,
    drain,
    fetchClosed,
    open,
    target: { ...leased, sessionId: value.status.lease.sessionId },
    setFacts: (updates: Partial<typeof facts>) => {
      facts = { ...facts, ...updates };
    },
  };
}
describe('durable verification recovery; simulated process interruption', () => {
  it.each(['preparing', 'active', 'restoring'] as const)(
    'recovers %s without renewing assessment and commits ended before unlock',
    async (phase) => {
      const f = await fixture(phase);
      try {
        const { gate, service } = f.open();
        expect(gate.isLocked()).toBe(true);
        await service.initialize();
        expect(service.status(f.target)).toMatchObject({
          phase: 'failed',
          error: 'verification_recovery_required',
          maintenanceLocked: true,
        });
        const restored = await service.reconcile(f.target);
        expect(restored.phase).toBe('ended');
        expect(gate.isLocked()).toBe(false);
        expect(f.drain).toHaveBeenCalledOnce();
        expect(f.apps.recoverOwned).toHaveBeenCalledOnce();
        expect(f.apps.writeVerification).not.toHaveBeenCalled();
        const saved = JSON.parse(await readFile(f.file, 'utf8'));
        expect(saved.status).toMatchObject({ phase: 'ended', maintenanceLocked: false });
        expect(saved.urls).toEqual(expect.arrayContaining(['http://127.0.0.1:49152', 'http://127.0.0.1:49153', 'http://127.0.0.1:49154']));
        const fresh = f.open();
        expect(fresh.gate.isLocked()).toBe(true);
        await fresh.service.initialize();
        expect(fresh.gate.isLocked()).toBe(false);
      } finally {
        await rm(f.root, { recursive: true, force: true });
      }
    },
  );
  it.each(['instance', 'source', 'actual-source'] as const)('rejects changed %s before touching any project', async (kind) => {
    const f = await fixture('active');
    try {
      if (kind === 'instance') f.setFacts({ appInstanceId: randomUUID() });
      if (kind === 'source') f.setFacts({ sourceSha256: 'b'.repeat(64) });
      if (kind === 'actual-source') f.apps.captureRecoverySource.mockResolvedValue('b'.repeat(64));
      const { gate, service } = f.open();
      await service.initialize();
      await expect(service.reconcile(f.target)).rejects.toThrow(/verification_recovery_(identity_mismatch|source_changed)/);
      expect(f.apps.recoverOwned).not.toHaveBeenCalled();
      expect(f.apps.start).not.toHaveBeenCalled();
      expect(gate.isLocked()).toBe(true);
    } finally {
      await rm(f.root, { recursive: true, force: true });
    }
  });
  it('retains old URLs after cleanup failed, including a new default started before the service disappeared', async () => {
    const f = await fixture('active');
    try {
      const first = f.open();
      await first.service.initialize();
      const realStart = f.apps.start.getMockImplementation()!;
      f.apps.start.mockImplementationOnce(async (...args) => {
        await realStart(...args);
        throw new Error('simulated interruption after default ownership persisted');
      });
      await expect(first.service.reconcile(f.target)).rejects.toThrow('verification_recovery_unconfirmed');
      expect(first.gate.isLocked()).toBe(true);
      const middle = JSON.parse(await readFile(f.file, 'utf8'));
      expect(middle.status.phase).toBe('restoring');
      expect(middle.restoreInstanceIds).toHaveLength(1);
      const second = f.open();
      await second.service.initialize();
      await second.service.reconcile(f.target);
      const ended = JSON.parse(await readFile(f.file, 'utf8'));
      expect(ended.restoreInstanceIds).toHaveLength(2);
      expect(ended.urls).toContain('http://127.0.0.1:49154');
      expect(second.gate.isLocked()).toBe(false);
      expect(f.apps.recoverOwned).toHaveBeenCalledTimes(2);
    } finally {
      await rm(f.root, { recursive: true, force: true });
    }
  });
  it('keeps a bad journal locked and rejects wrong session even if registry is otherwise valid', async () => {
    const f = await fixture('active');
    try {
      await writeFile(f.file, '{"bad":true}', { mode: 0o600 });
      const { gate, service } = f.open();
      await expect(service.initialize()).rejects.toThrow();
      expect(gate.isLocked()).toBe(true);
      expect(() => service.status({ ...f.target, sessionId: randomUUID() })).toThrow('verification_session_mismatch');
      expect(f.apps.recoverOwned).not.toHaveBeenCalled();
    } finally {
      await rm(f.root, { recursive: true, force: true });
    }
  });
});

it('does not replay ended verification on normal reopen; explicit marker recovery restarts a stopped reserved instance', async () => {
  const f = await fixture('active');
  try {
    const first = f.open();
    await first.service.initialize();
    await first.service.reconcile(f.target);
    const saved = JSON.parse(await readFile(f.file, 'utf8'));
    f.setFacts({ cleanupConfirmed: true, processExpected: false, url: '' });
    const gate = new MaintenanceGate(),
      event = vi.fn();
    const service = new EduVerificationService(f.apps as unknown as AppService, gate, f.drain, {
      journal: new RecoveryJournal(f.file, gate),
      onStatus: event,
      fetch: f.fetchClosed,
    });
    await service.initialize();
    expect(gate.isLocked()).toBe(false);
    expect(event).not.toHaveBeenCalled();
    const result = await service.reconcile(f.target);
    expect(result.phase).toBe('ended');
    expect(gate.isLocked()).toBe(false);
    const next = JSON.parse(await readFile(f.file, 'utf8'));
    expect(next.restoreInstanceIds).toHaveLength(saved.restoreInstanceIds.length + 1);
  } finally {
    await rm(f.root, { recursive: true, force: true });
  }
});
it('rejects an unrelated replacement after a completed recovery without stopping it', async () => {
  const f = await fixture('active');
  try {
    const first = f.open();
    await first.service.initialize();
    await first.service.reconcile(f.target);
    const stopped = f.apps.stop.mock.calls.length;
    f.setFacts({ appInstanceId: randomUUID() });
    await expect(first.service.reconcile(f.target)).rejects.toThrow('verification_recovery_identity_mismatch');
    expect(f.apps.stop).toHaveBeenCalledTimes(stopped);
  } finally {
    await rm(f.root, { recursive: true, force: true });
  }
});
