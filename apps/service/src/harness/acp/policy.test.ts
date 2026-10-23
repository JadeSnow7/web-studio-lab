import { describe, expect, it, vi } from 'vitest';
import { approvalPolicy } from './policy';
import type { PermissionOption, RequestPermissionParams } from './protocol';

describe('ACP 一次性审批策略', () => {
  it.each(['fetch', 'edit'])('只有持久选项时取消 %s 请求，不选择始终拒绝', async (kind) => {
    const onDeny = vi.fn();
    const ask = vi.fn();
    const params: RequestPermissionParams = {
      sessionId: 'session',
      toolCall: { toolCallId: 'tool', kind },
      options: [
        { optionId: 'always-allow', name: 'Always allow', kind: 'allow_always' },
        { optionId: 'always-reject', name: 'Always reject', kind: 'reject_always' },
      ],
    };
    expect(await approvalPolicy({ onDeny, ask })(params)).toEqual({ outcome: { outcome: 'cancelled' } });
    expect(onDeny).toHaveBeenCalledWith(params, '没有一次性允许选项');
    expect(ask).not.toHaveBeenCalled();
  });

  it('没有一次性允许选项时仍使用一次性拒绝', async () => {
    const params: RequestPermissionParams = {
      sessionId: 'session',
      toolCall: { toolCallId: 'tool', kind: 'fetch' },
      options: [
        { optionId: 'always-reject', name: 'Always reject', kind: 'reject_always' },
        { optionId: 'reject', name: 'Reject once', kind: 'reject_once' },
      ],
    };
    expect(await approvalPolicy({ onDeny: vi.fn(), ask: vi.fn() })(params)).toEqual({
      outcome: { outcome: 'selected', optionId: 'reject' },
    });
  });

  it('允许一次加始终拒绝时只把一次性允许交给用户', async () => {
    const allow: PermissionOption = { optionId: 'allow', name: 'Allow once', kind: 'allow_once' };
    const ask = vi.fn().mockResolvedValue({ outcome: { outcome: 'cancelled' } });
    const params: RequestPermissionParams = {
      sessionId: 'session',
      toolCall: { toolCallId: 'tool', kind: 'fetch' },
      options: [allow, { optionId: 'always-reject', name: 'Always reject', kind: 'reject_always' }],
    };
    expect(await approvalPolicy({ onDeny: vi.fn(), ask })(params)).toEqual({ outcome: { outcome: 'cancelled' } });
    expect(ask).toHaveBeenCalledWith(params, [allow]);
  });
});
