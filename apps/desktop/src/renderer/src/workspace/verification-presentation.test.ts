import { describe, expect, it } from 'vitest';
import type { EduVerificationView } from '@wsl/protocol';
import { verificationPresentation } from './verification-presentation';
const view: EduVerificationView = {
  original: null,
  target: { workspaceId: 'w', projectId: 'p', appInstanceId: 'i', sessionId: 's' },
  urls: [],
  recoveryRequired: false,
  error: null,
  status: {
    phase: 'active',
    callsUsed: 1,
    maintenanceLocked: true,
    error: null,
    lease: {
      schemaVersion: 1,
      sessionId: 's',
      identity: { workspaceId: 'w', projectId: 'p', environmentId: 'sandbox', appInstanceId: 'i' },
      sourceSha256: 'a'.repeat(64),
      expiresAtMs: 301000,
    },
  },
};
describe('发音验证呈现', () => {
  it('shows bounded time and remaining calls without unlocking an expired lease', () => {
    expect(verificationPresentation(view, 1000)).toMatchObject({
      locked: true,
      remainingCalls: 1,
      remainingSeconds: 300,
      canEnd: true,
      canReconcile: false,
    });
    expect(verificationPresentation({ ...view, status: { ...view.status!, callsUsed: 2 } }, 400000)).toMatchObject({
      locked: true,
      remainingCalls: 0,
      remainingSeconds: 0,
    });
  });
  it('distinguishes stopped, restoring, recovery-only and ended states', () => {
    expect(verificationPresentation({ ...view, status: { ...view.status!, phase: 'revoked' } }, 1000)).toMatchObject({
      locked: true,
      canEnd: true,
    });
    expect(verificationPresentation({ ...view, status: { ...view.status!, phase: 'restoring' } }, 1000).canEnd).toBe(false);
    expect(verificationPresentation({ ...view, status: null, recoveryRequired: true }, 1000)).toMatchObject({
      locked: true,
      canEnd: false,
      canReconcile: true,
    });
    expect(
      verificationPresentation({ ...view, status: { ...view.status!, phase: 'ended', maintenanceLocked: false } }, 1000),
    ).toMatchObject({ locked: false, canEnd: false, canReconcile: false });
    expect(verificationPresentation(null, 1000).label).toContain('评分关闭');
  });
  it('offers recovery for a frozen original without a fabricated scoring target', () => {
    const pending = {
      ...view,
      status: null,
      target: null,
      recoveryRequired: true,
      original: { workspaceId: 'w', projectId: 'p', appInstanceId: 'i', sourceSha256: 'a'.repeat(64) },
    };
    expect(verificationPresentation(pending, 1000)).toMatchObject({ locked: true, canEnd: false, canReconcile: true });
    const recovery = {
      schemaVersion: 1 as const,
      kind: 'admission-recovery' as const,
      recoveryId: 'r',
      originalIdentity: { workspaceId: 'w', projectId: 'p', appInstanceId: 'i', environmentId: 'sandbox' as const },
      sourceSha256: 'a'.repeat(64),
      phase: 'restoring' as const,
      restoredIdentity: { workspaceId: 'w', projectId: 'p', environmentId: 'sandbox' as const, appInstanceId: 'fresh' },
      maintenanceLocked: true,
      error: null,
    };
    expect(verificationPresentation({ ...pending, admissionRecovery: recovery }, 1000).label).toContain('正在恢复默认');
    expect(
      verificationPresentation(
        { ...pending, recoveryRequired: false, admissionRecovery: { ...recovery, phase: 'ended', maintenanceLocked: false } },
        1000,
      ).locked,
    ).toBe(false);
  });
});
