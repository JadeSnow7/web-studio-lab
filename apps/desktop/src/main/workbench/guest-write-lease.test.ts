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
    lease.acquire('session-a', 3);
    lease.observe(snap('session-a', 3, 'idle', false));
    expect(lease.current()).toBe('session-a');
    lease.observe(snap('session-b', 10, 'idle', false));
    expect(lease.current()).toBe('session-a');
    lease.observe(snap('session-a', 4, 'running', true));
    lease.observe(snap('session-a', 5, 'cancelling', false));
    lease.observe(snap('session-a', 6, 'cancelled', true));
    lease.observe(snap('session-a', 7, 'failed', true));
    expect(lease.current()).toBe('session-a');
    lease.observe(snap('session-a', 8, 'cancelled', false));
    expect(lease.current()).toBeNull();
    expect(() => lease.acquire('session-b', 0)).not.toThrow();
  });

  it('on rejected send releases when nothing started, keeps when a newer snapshot still needs cleanup', () => {
    const lease = new GuestWriteLease();
    lease.acquire('session-a', 3);
    lease.sendRejected('session-a', snap('session-a', 3, 'idle', false));
    expect(lease.current()).toBeNull();

    lease.acquire('session-a', 3);
    lease.sendRejected('session-a', undefined);
    expect(lease.current()).toBeNull();

    lease.acquire('session-a', 3);
    lease.sendRejected('session-a', snap('session-a', 4, 'failed', true));
    expect(lease.current()).toBe('session-a');
    lease.sendRejected('session-b', undefined);
    expect(lease.current()).toBe('session-a');
  });
});
