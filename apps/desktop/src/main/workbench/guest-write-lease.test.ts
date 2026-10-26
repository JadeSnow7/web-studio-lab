import { describe, expect, it } from 'vitest';
import type { ChatConversation } from '@wsl/protocol';
import { GuestWriteLease } from './guest-write-lease';

const snap = (
  conversationId: ChatConversation['conversationId'],
  seq: number,
  state: ChatConversation['state'],
  cleanupPending: boolean,
): ChatConversation => ({
  conversationId,
  generation: 'g',
  seq,
  threadId: null,
  turnId: 't',
  state,
  messages: [],
  toolExecutions: [],
  warnings: [],
  cleanupPending,
  error: null,
});

describe('GuestWriteLease', () => {
  it('rejects a second slot while held and allows the holder to re-acquire', () => {
    const lease = new GuestWriteLease();
    lease.acquire('session-a', 3);
    expect(() => lease.acquire('session-b', 0)).toThrow(/^conflict: .*session-a/);
    expect(() => lease.acquire('session-a', 9)).not.toThrow();
    expect(lease.current()).toBe('session-a');
  });

  it('releases only on a newer, stopped and cleanup-confirmed snapshot of the holder', () => {
    const lease = new GuestWriteLease();
    const ticket = lease.acquire('session-a', 3);
    lease.observe(snap('session-a', 3, 'idle', false));
    expect(lease.current()).toBe('session-a');
    lease.observe(snap('session-b', 10, 'idle', false));
    expect(lease.current()).toBe('session-a');
    lease.observe(snap('session-a', 4, 'running', true));
    lease.sendSettled(ticket, snap('session-a', 4, 'running', true));
    lease.observe(snap('session-a', 5, 'cancelling', false));
    lease.observe(snap('session-a', 6, 'cancelled', true));
    lease.observe(snap('session-a', 7, 'failed', true));
    expect(lease.current()).toBe('session-a');
    lease.observe(snap('session-a', 8, 'cancelled', false));
    expect(lease.current()).toBeNull();
    expect(() => lease.acquire('session-b', 0)).not.toThrow();
  });

  it('settles an explicit rejection without losing an existing cleanup obligation', () => {
    const lease = new GuestWriteLease();
    const idle = lease.acquire('session-a', 3);
    lease.sendSettled(idle, snap('session-a', 3, 'idle', false));
    expect(lease.current()).toBeNull();

    const unknown = lease.acquire('session-a', -1);
    lease.sendSettled(unknown, undefined);
    expect(lease.current()).toBeNull();

    const failed = lease.acquire('session-a', 3);
    lease.observe(snap('session-a', 4, 'failed', true));
    lease.sendSettled(failed, snap('session-a', 4, 'failed', true));
    expect(lease.current()).toBe('session-a');
    lease.observe(snap('session-a', 5, 'failed', false));
    expect(lease.current()).toBeNull();
  });

  it('does not confuse a newer idle query with an accounted send', () => {
    const lease = new GuestWriteLease();
    const pending = lease.acquire('session-a', -1);
    lease.observe(snap('session-a', 0, 'idle', false));
    expect(lease.current()).toBe('session-a');
    lease.sendSettled(pending, snap('session-a', 0, 'idle', false));
    expect(lease.current()).toBeNull();
  });

  it('keeps the lease until every same-slot send is accounted for', () => {
    const lease = new GuestWriteLease();
    const first = lease.acquire('session-a', -1);
    const next = lease.acquire('session-a', -1);
    lease.sendSettled(first, undefined);
    expect(lease.current()).toBe('session-a');
    lease.observe(snap('session-a', 2, 'cancelled', false));
    expect(lease.current()).toBe('session-a');
    lease.sendSettled(next, snap('session-a', 2, 'cancelled', false));
    expect(lease.current()).toBeNull();
  });

  it('ignores old send tickets after the same slot acquires a new lease', () => {
    const lease = new GuestWriteLease();
    const old = lease.acquire('session-a', -1);
    lease.sendSettled(old, undefined);
    const current = lease.acquire('session-a', 3);
    lease.sendSettled(old, snap('session-a', 10, 'idle', false));
    lease.observe(snap('session-a', 2, 'idle', false));
    expect(lease.current()).toBe('session-a');
    lease.sendSettled(current, snap('session-a', 4, 'running', true));
    lease.observe(snap('session-a', 5, 'idle', false));
    expect(lease.current()).toBeNull();
  });

  it('does not accept a foreign or older snapshot as the send result', () => {
    const lease = new GuestWriteLease();
    const pending = lease.acquire('session-a', 3);
    lease.sendSettled(pending, snap('session-b', 4, 'idle', false));
    lease.sendSettled(pending, snap('session-a', 2, 'idle', false));
    lease.observe(snap('session-a', 4, 'idle', false));
    expect(lease.current()).toBe('session-a');
    lease.sendSettled(pending, snap('session-a', 4, 'idle', false));
    expect(lease.current()).toBeNull();
  });
});
