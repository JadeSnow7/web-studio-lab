import { describe, expect, it, vi } from 'vitest';
import { approvalPolicy } from './policy';
import type { PermissionOption, PermissionOutcome, RequestPermissionParams } from './protocol';
import { AcpTurn } from './turn';

describe('ACP 一次性审批策略', () => {
  it('直接调用策略时缺失 kind 仍必须询问，不自动允许', async () => {
    const onDeny = vi.fn();
    const ask = vi.fn().mockResolvedValue({ outcome: { outcome: 'selected', optionId: 'reject' } });
    const options: PermissionOption[] = [
      { optionId: 'allow', name: 'Allow once', kind: 'allow_once' },
      { optionId: 'reject', name: 'Reject once', kind: 'reject_once' },
    ];
    const params: RequestPermissionParams = { sessionId: 'session', toolCall: { toolCallId: 'tool' }, options };
    expect(await approvalPolicy({ onDeny, ask })(params)).toEqual({ outcome: { outcome: 'selected', optionId: 'reject' } });
    expect(ask).toHaveBeenCalledExactlyOnceWith(params, options);
    expect(onDeny).not.toHaveBeenCalled();
  });

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

describe('ACP ID-only 请求的真实轮次审批', () => {
  it.each([
    { label: '未登记工具必须等待审批', knownKind: null, shouldAsk: true },
    { label: '已登记 edit 仍自动允许一次', knownKind: 'edit', shouldAsk: false },
    { label: '已登记 fetch 必须等待审批', knownKind: 'fetch', shouldAsk: true },
    { label: '已登记 switch_mode 必须等待审批', knownKind: 'switch_mode', shouldAsk: true },
  ])('$label', async ({ knownKind, shouldAsk }) => {
    const written: { id?: number | string; method?: string; result?: unknown; error?: unknown }[] = [];
    let resolveApproval: (outcome: PermissionOutcome) => void = () => {
      throw new Error('approval promise not initialized');
    };
    const pending = new Promise<PermissionOutcome>((resolve) => {
      resolveApproval = resolve;
    });
    const ask = vi.fn(() => pending);
    const onDeny = vi.fn();
    const turn = new AcpTurn(
      (line) => written.push(JSON.parse(line)),
      () => undefined,
      {
        cwd: '/w',
        mcpServers: [],
        sessionRef: null,
        prompt: 'test',
        signal: new AbortController().signal,
        decidePermission: approvalPolicy({ onDeny, ask }),
      },
    );
    const running = turn.run().then(
      (result) => ({ result }),
      (error: unknown) => ({ error }),
    );
    const reply = async (method: string, result: unknown) => {
      await expect.poll(() => written.find((message) => message.method === method)).toBeDefined();
      const id = written.find((message) => message.method === method)!.id!;
      turn.receive(JSON.stringify({ jsonrpc: '2.0', id, result }));
    };
    const allow: PermissionOption = { optionId: 'allow', name: 'Allow once', kind: 'allow_once' };
    const reject: PermissionOption = { optionId: 'reject', name: 'Reject once', kind: 'reject_once' };
    const responses = () => written.filter((message) => message.id === 'permission');
    try {
      await reply('initialize', { protocolVersion: 1, agentCapabilities: {} });
      await reply('session/new', { sessionId: 'session' });
      await expect.poll(() => written.some((message) => message.method === 'session/prompt')).toBe(true);
      if (knownKind) {
        turn.receive(
          JSON.stringify({
            jsonrpc: '2.0',
            method: 'session/update',
            params: {
              sessionId: 'session',
              update: { sessionUpdate: 'tool_call', toolCallId: 'tool', kind: knownKind, title: 'Test tool', status: 'pending' },
            },
          }),
        );
      }
      turn.receive(
        JSON.stringify({
          jsonrpc: '2.0',
          id: 'permission',
          method: 'session/request_permission',
          params: { sessionId: 'session', toolCall: { toolCallId: 'tool' }, options: [allow, reject] },
        }),
      );
      // Drain the RPC promise chain without a sleep; the user's decision is still unresolved.
      await new Promise<void>((resolve) => setImmediate(resolve));
      if (shouldAsk) {
        expect(responses()).toEqual([]);
        expect(ask).toHaveBeenCalledExactlyOnceWith(
          expect.objectContaining({ toolCall: expect.objectContaining({ toolCallId: 'tool', kind: knownKind }) }),
          [allow, reject],
        );
        resolveApproval({ outcome: { outcome: 'selected', optionId: 'reject' } });
      } else {
        expect(ask).not.toHaveBeenCalled();
      }
      await expect.poll(() => responses()).toHaveLength(1);
      expect(responses()).toEqual([
        { jsonrpc: '2.0', id: 'permission', result: { outcome: { outcome: 'selected', optionId: shouldAsk ? 'reject' : 'allow' } } },
      ]);
      expect(onDeny).not.toHaveBeenCalled();
      await reply('session/prompt', { stopReason: 'end_turn' });
      await expect(running).resolves.toMatchObject({ result: { stopReason: 'end_turn' } });
    } finally {
      resolveApproval({ outcome: { outcome: 'cancelled' } });
      turn.close('test cleanup');
      await running;
    }
  });
});
