import { it, expect } from 'vitest';
import { mkdtemp, rm, writeFile, chmod, stat, symlink, link, mkdir } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { RecoveryJournal, atomicPrivateJson } from './edu-recovery-journal';
import { MaintenanceGate } from './maintenance-gate';
const identity = { workspaceId: 'space', projectId: randomUUID(), environmentId: 'sandbox' as const, appInstanceId: randomUUID() };
const status = {
  lease: { schemaVersion: 1 as const, sessionId: randomUUID(), identity, sourceSha256: 'a'.repeat(64), expiresAtMs: 1000 },
  phase: 'active' as const,
  callsUsed: 1,
  maintenanceLocked: true,
  error: null,
};
const record = {
  schemaVersion: 1 as const,
  status,
  originalIdentity: { ...identity, appInstanceId: randomUUID() },
  restoreInstanceIds: [],
  urls: ['http://127.0.0.1:49152'],
  ownershipTaken: true,
};
it('a persisted verification journal locks a fresh service before async loading', async () => {
  const root = await mkdtemp(path.join(tmpdir(), 'edu-recovery-'));
  try {
    const file = path.join(root, 'verification.json');
    await atomicPrivateJson(file, record);
    const gate = new MaintenanceGate();
    const journal = new RecoveryJournal(file, gate);
    expect(gate.isLocked()).toBe(true);
    expect((await journal.open())?.status.phase).toBe('active');
    expect(gate.isLocked()).toBe(true);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
it('does not replace an existing public journal or write under an unowned/public parent', async () => {
  const root = await mkdtemp(path.join(tmpdir(), 'edu-recovery-private-'));
  try {
    const file = path.join(root, 'verification.json');
    await writeFile(file, 'private facts', { mode: 0o644 });
    await chmod(file, 0o644);
    expect((await stat(file)).mode & 0o777).toBe(0o644);
    await expect(atomicPrivateJson(file, record)).rejects.toThrow();
    await chmod(file, 0o600);
    await chmod(root, 0o777);
    await expect(atomicPrivateJson(file, record)).rejects.toThrow();
  } finally {
    await chmod(root, 0o700);
    await rm(root, { recursive: true, force: true });
  }
});

it.each(['symlink', 'hardlink', 'directory', 'oversized', 'linked-parent'] as const)(
  'rejects %s journals while keeping the startup gate closed',
  async (kind) => {
    const root = await mkdtemp(path.join(tmpdir(), 'edu-journal-negative-'));
    const original = path.join(root, 'facts.json');
    await atomicPrivateJson(original, record);
    try {
      let file = path.join(root, 'journal.json');
      if (kind === 'symlink') await symlink(original, file);
      if (kind === 'hardlink') await link(original, file);
      if (kind === 'directory') await mkdir(file);
      if (kind === 'oversized') await writeFile(file, ' '.repeat(32769), { mode: 0o600 });
      if (kind === 'linked-parent') {
        const alias = path.join(root, 'alias');
        await symlink(root, alias);
        file = path.join(alias, 'facts.json');
      }
      const gate = new MaintenanceGate(),
        journal = new RecoveryJournal(file, gate);
      expect(gate.isLocked()).toBe(true);
      await expect(journal.open()).rejects.toThrow();
      expect(gate.isLocked()).toBe(true);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  },
);
