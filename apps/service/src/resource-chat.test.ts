import { describe, expect, it, vi } from 'vitest';
import { ObservationSourcesSchema } from '@wsl/protocol';
import { CodexChat, parseCodexLine } from './codex-chat';
import type { GuestFrame, GuestStart, SbxConnection } from './sbx';

const space = 'conv-space-taskflow-demo-impl' as const;
const personal = 'conv-personal-default' as const;
function fixture() {
  let frame: (value: GuestFrame) => void = () => undefined;
  let resolve!: (value: { confirmed: boolean; error: string | null; exitCode: number }) => void;
  const done = new Promise<{ confirmed: boolean; error: string | null; exitCode: number }>((r) => {
    resolve = r;
  });
  const start = vi.fn((_: GuestStart, emit: typeof frame) => {
    frame = emit;
    return {
      done,
      close: async () => {
        resolve({ confirmed: true, error: null, exitCode: 0 });
        return done;
      },
    };
  });
  const connection = {
    start,
    getStatus: () => ({ available: true }),
    getCleanupPending: () => false,
    shutdown: async () => undefined,
  } as unknown as SbxConnection;
  const resources = { list: vi.fn(async (spaceId: string) => ({ spaceId, revision: 4, resources: [] })) };
  const chat = new CodexChat('', () => undefined, connection, resources);
  return {
    chat,
    start,
    resources,
    emit(event: unknown) {
      frame({ type: 'output', stream: 'stdout', data: JSON.stringify(event) + '\n' });
    },
    finish(confirmed = true) {
      for (const event of [
        { type: 'thread.started', thread_id: 'thread-1' },
        { type: 'item.completed', item: { id: 'reply', type: 'agent_message', text: 'done' } },
        { type: 'turn.completed' },
      ])
        frame({ type: 'output', stream: 'stdout', data: JSON.stringify(event) + '\n' });
      resolve({ confirmed, error: confirmed ? null : 'cleanup unknown', exitCode: 0 });
    },
  };
}
describe('space resources per-turn capability', () => {
  it('binds only the fixed space to an immutable per-turn bundle', async () => {
    const f = fixture();
    const sent = await f.chat.send(space, 'read');
    expect(f.resources.list).toHaveBeenCalledWith('taskflow-demo');
    expect(f.start.mock.calls[0]?.[0]).toMatchObject({
      resourceBundle: {
        spaceId: 'taskflow-demo',
        collectionRevision: 4,
        resources: [],
        turnId: sent.turnId,
        generation: sent.generation,
        conversationId: space,
      },
    });
    f.finish();
    await f.chat.shutdown();
  });
  it('binds a host-registered dynamic session to TaskFlow resources and freezes its workspace', async () => {
    const f = fixture();
    const id = 'session-dynamic';
    await expect(f.chat.send(id, 'unregistered')).rejects.toThrow('宿主注册');
    f.chat.register(id, 'taskflow-demo');
    expect(() => f.chat.register(id, 'other')).toThrow('归属已冻结');
    await f.chat.send(id, 'read');
    expect(f.start.mock.calls[0]?.[0]).toMatchObject({
      resourceBundle: { conversationId: id, spaceId: 'taskflow-demo', collectionRevision: 4 },
    });
    expect(() => f.chat.assertResourceMutationAllowed('taskflow-demo')).toThrow();
    f.finish();
    await vi.waitFor(() => expect(f.chat.get(id).state).toBe('idle'));
    f.chat.invalidateResources('taskflow-demo');
    expect(f.chat.get(id).threadId).toBeNull();
    await f.chat.shutdown();
  });
  it('another registered workspace has no TaskFlow capability', async () => {
    const f = fixture();
    f.chat.register('session-other', 'other');
    await f.chat.send('session-other', 'hello');
    expect(f.resources.list).not.toHaveBeenCalled();
    expect(f.start.mock.calls[0]?.[0]).toMatchObject({ resourceBundle: { spaceId: null, resources: [] } });
    f.finish();
    await f.chat.shutdown();
  });
  it('personal conversation receives an empty capability without listing a space', async () => {
    const f = fixture();
    await f.chat.send(personal, 'hello');
    expect(f.resources.list).not.toHaveBeenCalled();
    expect(f.start.mock.calls[0]?.[0]).toMatchObject({ resourceBundle: { spaceId: null, resources: [] } });
    f.finish();
    await f.chat.shutdown();
  });
  it('blocks active resource mutation and resets CLI context after mutation', async () => {
    const f = fixture();
    await f.chat.send(space, 'read');
    expect(() => f.chat.assertResourceMutationAllowed('taskflow-demo')).toThrow();
    f.finish();
    await vi.waitFor(() => expect(f.chat.get(space).state).toBe('idle'));
    f.chat.assertResourceMutationAllowed('taskflow-demo');
    f.chat.invalidateResources('taskflow-demo');
    expect(f.chat.get(space).threadId).toBeNull();
    expect(f.chat.get(space).warnings.join(' ')).toContain('资源');
    await f.chat.shutdown();
  });
  it('unknown cleanup in another slot blocks a new resource turn', async () => {
    const f = fixture();
    await f.chat.send(personal, 'hello');
    f.finish(false);
    await vi.waitFor(() => expect(f.chat.get(personal).state).toBe('failed'));
    await expect(f.chat.send(space, 'read')).rejects.toThrow(/cleanup|清理/);
  });
  it('reserves the slot while reading resources and prevents a late start after reset', async () => {
    const f = fixture();
    let release!: (value: { spaceId: string; revision: number; resources: [] }) => void;
    f.resources.list.mockImplementation(
      () =>
        new Promise((resolve) => {
          release = resolve;
        }),
    );
    const sending = f.chat.send(space, 'pending');
    await expect(f.chat.send(space, 'duplicate')).rejects.toThrow('等待回复');
    expect(() => f.chat.assertResourceMutationAllowed('taskflow-demo')).toThrow();
    const resetting = f.chat.reset(space);
    release({ spaceId: 'taskflow-demo', revision: 1, resources: [] });
    await sending;
    await resetting;
    expect(f.start).not.toHaveBeenCalled();
    expect(f.chat.get(space).messages).toHaveLength(0);
    await f.chat.shutdown();
  });
  it('shutdown during resource capture never starts a late guest', async () => {
    const f = fixture();
    let release!: (value: { spaceId: string; revision: number; resources: [] }) => void;
    f.resources.list.mockImplementation(
      () =>
        new Promise((resolve) => {
          release = resolve;
        }),
    );
    const sending = f.chat.send(space, 'pending');
    const stopping = f.chat.shutdown();
    release({ spaceId: 'taskflow-demo', revision: 1, resources: [] });
    await sending;
    await stopping;
    expect(f.start).not.toHaveBeenCalled();
  });
  it('keeps a readable identity receipt for large real MCP results', async () => {
    const f = fixture();
    await f.chat.send(space, 'read');
    const data = {
      resourceId: 'id-1',
      version: 2,
      url: 'https://example.com/',
      title: 'Example Domain',
      contentSha256: 'a'.repeat(64),
      text: 'body'.repeat(10000),
    };
    f.emit({
      type: 'item.completed',
      item: {
        id: 'mcp-large',
        type: 'mcp_tool_call',
        server: 'wsl_space',
        tool: 'read_resource',
        arguments: { resourceId: 'id-1', version: 2 },
        status: 'completed',
        result: { content: [{ type: 'text', text: JSON.stringify({ untrusted: true, data }) }] },
        error: null,
      },
    });
    const record = f.chat.get(space).toolExecutions[0]!;
    expect(record.command).toContain('mcp:wsl_space.read_resource');
    expect(record.exitCode).toBe(0);
    expect(record.truncated).toBe(true);
    expect(JSON.parse(record.output)).toMatchObject({
      status: 'completed',
      untrusted: true,
      receipt: {
        resourceId: 'id-1',
        version: 2,
        url: 'https://example.com/',
        contentSha256: 'a'.repeat(64),
        textExcerpt: data.text.slice(0, 2000),
      },
    });
    f.finish();
    await f.chat.shutdown();
  });
  it.each(['none', 'range', 'timestamp', 'started'] as const)(
    'retains observation provenance with oversized metadata=%s',
    async (oversized) => {
      const f = fixture();
      await f.chat.send(space, 'read');
      const metadata = {
        resource: {
          workspaceId: 'taskflow-demo',
          environmentId: 'sandbox',
          resourceId: 'term-1',
          kind: 'terminal',
          instanceId: 'instance-1',
          instanceGeneration: 3,
        },
        generation: 'pty-3',
        revision: { value: '42', strength: 'sequence' },
        snapshotId: '00000000-0000-4000-8000-000000000042',
        startedAt: oversized === 'started' ? '2026-10-08T12:00:00.' + '1'.repeat(20000) + 'Z' : '2026-10-08T12:00:00.000Z',
        source: 'pty',
        representation: 'terminal-output',
        capturedAt: oversized === 'timestamp' ? '2026-10-08T12:00:00.' + '1'.repeat(20000) + 'Z' : '2026-10-08T12:00:00.000Z',
        coverage: { status: 'complete', range: { start: 0, end: 32745, detail: oversized === 'range' ? '中'.repeat(20000) : '' } },
        evidenceRef: 'observation-42.json',
      };
      f.emit({
        type: 'item.completed',
        item: {
          id: 'observation-large',
          type: 'mcp_tool_call',
          server: 'wsl_space',
          tool: 'terminal_read_output',
          arguments: { resourceId: 'term-1' },
          status: 'completed',
          error: null,
          result: { structuredContent: { untrusted: true, data: { ...metadata, data: { output: '中'.repeat(20000) } } } },
        },
      });
      const record = f.chat.get(space).toolExecutions[0]!;
      f.finish();
      await f.chat.shutdown();
      expect(record.truncated).toBe(true);
      expect(record.output.length).toBeLessThanOrEqual(16000);
      const { revision: _revision, coverage: _coverage, capturedAt: _capturedAt, startedAt: _startedAt, ...identity } = metadata;
      expect(JSON.parse(record.output)).toEqual(
        oversized !== 'none'
          ? {
              status: 'completed',
              truncated: true,
              untrusted: true,
              receipt: { ...identity, coverage: { status: 'complete' } },
              metadataOmitted: ['revision', 'coverage.range', 'coverage.reasons', 'nextCursor', 'capturedAt', 'startedAt'],
            }
          : { status: 'completed', truncated: true, untrusted: true, receipt: metadata },
      );
    },
  );
  it.each(['sources', 'error'] as const)('keeps bounded protocol %s receipts', async (kind) => {
    const f = fixture();
    await f.chat.send(space, 'read');
    const sources = Array.from({ length: 500 }, (_, i) => ({
      resource: { workspaceId: 'taskflow-demo', environmentId: null, resourceId: `file-${i}`, kind: 'file' },
      instance: null,
      title: '文件',
      capabilities: [],
      state: 'unavailable',
      reason: '未绑定',
    }));
    const data =
      kind === 'sources'
        ? { kind, workspaceId: 'taskflow-demo', sources }
        : { error: 'unavailable', message: '中'.repeat(20000), details: { reason: '大'.repeat(20000) } };
    f.emit({
      type: 'item.completed',
      item: {
        id: 'large-protocol',
        type: 'mcp_tool_call',
        server: 'wsl_space',
        tool: 'workspace_list_sources',
        status: 'completed',
        error: null,
        result: { structuredContent: { untrusted: true, data } },
      },
    });
    const record = f.chat.get(space).toolExecutions[0]!;
    f.finish();
    await f.chat.shutdown();
    expect(record.truncated).toBe(true);
    expect(record.output.length).toBeLessThanOrEqual(16000);
    const summary = JSON.parse(record.output);
    if (kind === 'sources') {
      expect(summary.receipt).toMatchObject({ kind, workspaceId: 'taskflow-demo', sourceCount: 500 });
      expect(summary.receipt.sources.length).toBeGreaterThan(0);
      expect(summary.receipt.sources).toEqual(
        sources.slice(0, summary.receipt.sources.length).map(({ resource, instance }) => ({ resource, instance })),
      );
      expect(summary.receipt.sourcesOmitted).toBe(500 - summary.receipt.sources.length);
      expect(summary.receipt.snapshotId).toBeUndefined();
    } else
      expect(summary.receipt).toEqual({ error: 'unavailable', message: '中'.repeat(2000), messageOmitted: true, detailsOmitted: true });
  });
  it.each(['workspace', 'status'] as const)('bounds unbounded protocol %s fields in receipts', async (field) => {
    const f = fixture();
    await f.chat.send(space, 'read');
    f.emit({
      type: 'item.completed',
      item: {
        id: 'unbounded',
        type: 'mcp_tool_call',
        server: 'wsl_space',
        tool: 'workspace_list_sources',
        status: field === 'status' ? 's'.repeat(20000) : 'completed',
        error: null,
        result: {
          structuredContent: {
            untrusted: true,
            data: { kind: 'sources', workspaceId: field === 'workspace' ? 'w'.repeat(20000) : 'taskflow-demo', sources: [] },
          },
        },
      },
    });
    const record = f.chat.get(space).toolExecutions[0]!;
    f.finish();
    await f.chat.shutdown();
    expect(record.output.length).toBeLessThanOrEqual(16000);
    if (field === 'workspace') {
      expect(ObservationSourcesSchema.safeParse({ kind: 'sources', workspaceId: 'w'.repeat(20000), sources: [] }).success).toBe(false);
      expect(JSON.parse(record.output)).toEqual({ status: 'completed', truncated: true, untrusted: true, receipt: {} });
    } else expect(JSON.parse(record.output)).toEqual({ truncated: true, receiptUnavailable: 'MCP metadata exceeded the record limit' });
  });
  it('total MCP evidence limit remains valid JSON with explicit omission', async () => {
    const f = fixture();
    await f.chat.send(space, 'read');
    for (let index = 0; index < 20; index++)
      f.emit({
        type: 'item.completed',
        item: {
          id: `mcp-${index}`,
          type: 'mcp_tool_call',
          server: 'wsl_space',
          tool: 'read_resource',
          arguments: { resourceId: 'id-1', version: 1 },
          status: 'completed',
          result: { content: [{ type: 'text', text: 'x'.repeat(12000) }] },
          error: null,
        },
      });
    const records = f.chat.get(space).toolExecutions;
    expect(records.reduce((sum, record) => sum + record.output.length, 0)).toBeLessThanOrEqual(131072);
    expect(records.every((record) => typeof JSON.parse(record.output) === 'object')).toBe(true);
    expect(records.some((record) => JSON.parse(record.output).receiptOmitted)).toBe(true);
    f.finish();
    await f.chat.shutdown();
  });
  it('mixed tiny and large MCP records cannot exceed the aggregate limit', async () => {
    const f = fixture();
    await f.chat.send(space, 'read');
    for (let index = 0; index < 65; index++)
      f.emit({
        type: 'item.completed',
        item: {
          id: `mixed-${index}`,
          type: 'mcp_tool_call',
          server: 'wsl_space',
          tool: 'list_resources',
          arguments: {},
          status: 'completed',
          result: index < 50 ? {} : { content: [{ type: 'text', text: 'x'.repeat(15000) }] },
          error: null,
        },
      });
    const records = f.chat.get(space).toolExecutions;
    expect(records.reduce((sum, record) => sum + record.output.length, 0)).toBeLessThanOrEqual(131072);
    expect(records.every((record) => typeof JSON.parse(record.output) === 'object')).toBe(true);
    f.finish();
    await f.chat.shutdown();
  });
  it('preserves structured MCP result as evidence instead of dropping it', () => {
    const result = parseCodexLine(
      JSON.stringify({
        type: 'item.completed',
        item: {
          id: 'mcp-1',
          type: 'mcp_tool_call',
          server: 'wsl_space',
          tool: 'read_resource',
          arguments: { resourceId: 'r', version: 1 },
          result: { content: [{ type: 'text', text: 'actual body' }] },
          error: null,
          status: 'completed',
        },
      }),
    );
    expect(result).toMatchObject({
      item: { server: 'wsl_space', tool: 'read_resource', result: { content: [{ type: 'text', text: 'actual body' }] } },
    });
  });
});
