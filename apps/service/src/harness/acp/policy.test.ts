import { describe, expect, it } from 'vitest';
import { AcpTurn } from './turn';
import { workspaceWritePolicy } from './policy';
import type { RequestPermissionParams } from './protocol';

const options: RequestPermissionParams['options'] = [
  { optionId: 'yes', name: 'Allow', kind: 'allow_once' },
  { optionId: 'no', name: 'Reject', kind: 'reject_once' },
];
async function permissionAfterTool(kind?: string) {
  let promptId: number | undefined;
  let answer: unknown;
  const turn: AcpTurn = new AcpTurn(
    (line) => {
      const message = JSON.parse(line) as { id: number; method?: string; result?: unknown };
      queueMicrotask(() => {
        const receive = (value: object) => turn.receive(JSON.stringify({ jsonrpc: '2.0', ...value }));
        if (message.method === 'initialize')
          receive({ id: message.id, result: { protocolVersion: 1, agentCapabilities: {}, authMethods: [] } });
        else if (message.method === 'session/new') receive({ id: message.id, result: { sessionId: 's' } });
        else if (message.method === 'session/prompt') {
          promptId = message.id;
          if (kind)
            receive({
              method: 'session/update',
              params: { sessionId: 's', update: { sessionUpdate: 'tool_call', toolCallId: 't', kind, status: 'pending' } },
            });
          receive({ id: 1000, method: 'session/request_permission', params: { sessionId: 's', toolCall: { toolCallId: 't' }, options } });
        } else if (message.id === 1000) {
          answer = message.result;
          receive({ id: promptId, result: { stopReason: 'end_turn' } });
        }
      });
    },
    () => undefined,
    {
      cwd: '/workspace',
      mcpServers: [],
      sessionRef: null,
      prompt: 'fixture',
      signal: new AbortController().signal,
      decidePermission: workspaceWritePolicy(),
    },
  );
  await turn.run();
  turn.close('test complete');
  return answer;
}
describe('workspace-write permission kinds', () => {
  it.each(['fetch', 'switch_mode', undefined])('does not turn omitted kind into allow for prior %s', async (kind) => {
    expect(await permissionAfterTool(kind)).toEqual({ outcome: { outcome: 'selected', optionId: 'no' } });
  });
  it('resolves a known edit kind for an ID-only permission request', async () => {
    expect(await permissionAfterTool('edit')).toEqual({ outcome: { outcome: 'selected', optionId: 'yes' } });
  });
  it('the policy itself rejects unknown kind even if called without a tracked tool', async () => {
    expect(await workspaceWritePolicy()({ sessionId: 's', toolCall: { toolCallId: 't' }, options })).toEqual({
      outcome: { outcome: 'selected', optionId: 'no' },
    });
  });
});
