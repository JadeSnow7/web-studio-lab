import { describe, it, expect } from 'vitest';
import { ChatServiceRequestSchema, ChatServiceMessageSchema } from './chat';
let fixtureId = 0;
const nextFixtureId = () => `10000000-0000-4000-8000-${(++fixtureId).toString().padStart(12, '0')}`;
const target = { workspaceId: 'space', projectId: nextFixtureId(), appInstanceId: nextFixtureId() };
describe('short pronunciation verification contract', () => {
  it('begin requires the caller-frozen instance and source; no provider configuration is accepted', () => {
    const payload = { ...target, sourceSha256: 'a'.repeat(64) };
    expect(ChatServiceRequestSchema.safeParse({ id: 'begin', method: 'app.verification.begin', payload }).success).toBe(true);
    for (const changed of [
      { ...payload, appInstanceId: undefined },
      { ...payload, sourceSha256: undefined },
      { ...payload, providerPath: '/renderer' },
      { ...payload, maxCalls: 100 },
    ])
      expect(ChatServiceRequestSchema.safeParse({ id: 'begin', method: 'app.verification.begin', payload: changed }).success).toBe(false);
  });
  it('status/end bind session plus leased instance and publish the global maintenance lock', () => {
    const sessionId = nextFixtureId();
    for (const method of ['app.verification.status', 'app.verification.end', 'app.verification.reconcile'])
      expect(ChatServiceRequestSchema.safeParse({ id: 'target', method, payload: { ...target, sessionId } }).success).toBe(true);
    const status = {
      lease: {
        schemaVersion: 1,
        sessionId,
        identity: { ...target, environmentId: 'sandbox' },
        sourceSha256: 'a'.repeat(64),
        expiresAtMs: Date.now() + 300000,
      },
      phase: 'revoked',
      callsUsed: 2,
      maintenanceLocked: true,
      error: null,
    };
    expect(ChatServiceMessageSchema.safeParse({ type: 'edu-verification-event', status }).success).toBe(true);
    expect(ChatServiceMessageSchema.safeParse({ type: 'response', id: 'lease', result: status }).success).toBe(true);
    expect(ChatServiceMessageSchema.safeParse({ type: 'edu-verification-event', status: { ...status, callsUsed: 3 } }).success).toBe(false);
  });
});
