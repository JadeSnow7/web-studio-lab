import { describe, expect, it } from 'vitest';
import { ChatServiceRequestSchema, invokeChannels } from '@wsl/protocol';
import { emptyReferences } from './reference-test-fixture';
describe('resource authority IPC seam', () => {
  it.each(['resources.list', 'resources.save', 'resources.remove'])('retires service %s writes and reads', (method) => {
    expect(ChatServiceRequestSchema.safeParse({ id: 'legacy', method, payload: { spaceId: 'taskflow-demo' } }).success).toBe(false);
  });
  it('requires a Main frozen capability even when references are empty', () => {
    expect(
      ChatServiceRequestSchema.safeParse({ id: 'send', method: 'send', payload: { conversationId: 'conv-personal-default', text: 'read' } })
        .success,
    ).toBe(false);
    expect(
      ChatServiceRequestSchema.safeParse({
        id: 'send',
        method: 'send',
        payload: { conversationId: 'conv-personal-default', text: 'read', references: emptyReferences('conv-personal-default') },
      }).success,
    ).toBe(true);
  });
  it('renderer personal send accepts only version selections and cannot forge owner or body', () => {
    const request = { conversationId: 'conv-personal-default', text: 'read', references: [{ resourceId: 'resource', version: 1 }] };
    expect(invokeChannels['chat:send'].request.safeParse(request).success).toBe(true);
    expect(invokeChannels['chat:send'].request.safeParse({ ...request, ownerAccountId: 'attacker' }).success).toBe(false);
    expect(
      invokeChannels['chat:send'].request.safeParse({ ...request, references: [{ resourceId: 'resource', version: 1, text: 'forged' }] })
        .success,
    ).toBe(false);
    expect(invokeChannels['chat:send'].request.safeParse({ ...request, observationScope: { workspaceId: 'foreign' } }).success).toBe(false);
  });
});
