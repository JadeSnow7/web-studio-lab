import { emptyReferences } from './reference-test-fixture';
import { describe, expect, it, vi } from 'vitest';
import { MotaStateSchema, ObservationSourcesSchema, type MotaState } from '@wsl/protocol';
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
  const chat = new CodexChat('', () => undefined, connection);
  chat.register(space, 'taskflow-demo');
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

function motaState(blockCount = 144): MotaState {
  return MotaStateSchema.parse({
    appInstanceId: '88f5f2b5-c4ed-4829-bf87-f3386d1cc3d0',
    documentGeneration: 2,
    played: true,
    floorId: 'MT1',
    hero: { x: 6, y: 11, hp: 1000, atk: 10, def: 10, money: 0, coin: 0, keys: { yellow: 0, blue: 0, red: 0 } },
    moving: false,
    locked: false,
    event: { id: null, type: null },
    dialogue: null,
    map: {
      width: 64,
      height: 64,
      blocks: Array.from({ length: blockCount }, (_, index) => ({
        x: index % 64,
        y: Math.floor(index / 64),
        id: 1,
        eventId: 'yellowWall',
        disabled: false,
      })),
      truncated: false,
    },
    canvas: {
      rect: { x: 252.5, y: 47.5, width: 624, height: 624 },
      viewport: { width: 1129, height: 719 },
      logicalWidth: 416,
      logicalHeight: 416,
      offsetX: 0,
      offsetY: 0,
      scale: 1.5,
    },
  });
}
function motaMcp(result: unknown, overrides: Record<string, unknown> = {}) {
  return {
    id: 'mota-native',
    type: 'mcp_tool_call',
    server: 'wsl_space',
    tool: 'app_mota_act',
    arguments: { appInstanceId: '88f5f2b5-c4ed-4829-bf87-f3386d1cc3d0', documentGeneration: 1, action: { type: 'newGame' } },
    status: 'completed',
    error: null,
    result,
    ...overrides,
  };
}
async function recordMcp(item: ReturnType<typeof motaMcp>) {
  const f = fixture();
  await f.chat.send(space, 'read', undefined, emptyReferences(space));
  f.emit({ type: 'item.completed', item });
  const record = f.chat.get(space).toolExecutions[0]!;
  f.finish();
  await f.chat.shutdown();
  return record;
}
describe('native Mota MCP duplicate evidence', () => {
  it.each(['structured_content', 'structuredContent', 'both'] as const)(
    'keeps a complete real-shaped newGame receipt with %s',
    async (alias) => {
      const envelope = { untrusted: true, data: { ok: true, tool: 'app.mota.act', data: motaState() } };
      const content = [
        { type: 'text', text: JSON.stringify(envelope), annotations: { audience: ['user'] }, _meta: { trace: 'text-meta' } },
      ];
      const metadata = { isError: false, _meta: { trace: 'preserved' } };
      const result = {
        ...metadata,
        content,
        ...(alias !== 'structuredContent' ? { structured_content: envelope } : {}),
        ...(alias !== 'structured_content' ? { structuredContent: { data: envelope.data, untrusted: true } } : {}),
      };
      const before = structuredClone(result);
      expect(JSON.stringify({ status: 'completed', result, error: null }).length).toBeGreaterThan(16000);
      const record = await recordMcp(motaMcp(result));
      expect(record).toMatchObject({ exitCode: 0, truncated: false });
      expect(record.output.length).toBeLessThanOrEqual(16000);
      expect(JSON.parse(record.output)).toEqual({ status: 'completed', result: { ...metadata, content }, error: null });
      expect(JSON.parse(JSON.parse(record.output).result.content[0].text)).toEqual(envelope);
      expect(result).toEqual(before);
    },
  );
  it.each(['state', 'map_read', 'map_set'] as const)('supports the other typed Mota receipt: %s', async (kind) => {
    const data =
      kind === 'state'
        ? motaState()
        : kind === 'map_read'
          ? {
              floorId: 'MT1',
              sha256: 'a'.repeat(64),
              width: 64,
              height: 64,
              map: Array.from({ length: 64 }, () => Array<number>(64).fill(0)),
            }
          : {
              operationId: '00000000-0000-4000-8000-000000000001',
              floorId: 'MT1',
              beforeSha256: 'a'.repeat(64),
              afterSha256: 'b'.repeat(64),
              change: { x: 6, y: 10, before: 0, after: 53 },
            };
    const tool = kind === 'state' ? 'app.mota.state' : `app.mota.${kind.replace('_', '.')}`;
    const envelope = { untrusted: true, data: { ok: true, tool, data } };
    const result = {
      content: [{ type: 'text', text: JSON.stringify(envelope) }],
      structured_content: envelope,
      ...(kind === 'map_set' ? { _meta: { padding: 'm'.repeat(15200) } } : {}),
    };
    expect(JSON.stringify({ status: 'completed', result, error: null }).length).toBeGreaterThan(16000);
    const record = await recordMcp(motaMcp(result, { tool: `app_mota_${kind}` }));
    expect(record.truncated).toBe(false);
    const saved = JSON.parse(record.output);
    expect(saved.result._meta).toEqual(result._meta);
    expect(JSON.parse(saved.result.content[0].text)).toEqual(envelope);
  });
  it('retains business error, native error status, isError and transport error without upgrading the result', async () => {
    const envelope = {
      untrusted: true,
      data: {
        ok: false,
        tool: 'app.mota.act',
        error: { code: 'write_rejected', message: '保存被拒绝', details: { reason: 'x'.repeat(9000) } },
      },
    };
    const result = { content: [{ type: 'text', text: JSON.stringify(envelope) }], structured_content: envelope, isError: true };
    const record = await recordMcp(motaMcp(result, { status: 'failed', error: { message: 'native error' } }));
    expect(record).toMatchObject({ exitCode: 1, truncated: false });
    expect(JSON.parse(record.output)).toEqual({
      status: 'failed',
      error: { message: 'native error' },
      result: { content: result.content, isError: true },
    });
  });
  it.each([16000, 16001])('preserves the exact single-copy limit at %s characters', async (length) => {
    const envelope = { untrusted: true, data: { ok: true, tool: 'app.mota.act', data: motaState() } };
    const compactResult = { content: [{ type: 'text', text: JSON.stringify(envelope) }], _meta: { padding: '' } };
    const base = JSON.stringify({ status: 'completed', result: compactResult, error: null }).length;
    compactResult._meta.padding = 'm'.repeat(length - base);
    const record = await recordMcp(motaMcp({ ...compactResult, structured_content: envelope }));
    expect(record.truncated).toBe(length > 16000);
    if (length === 16000) {
      expect(record.output).toHaveLength(16000);
      expect(JSON.parse(record.output).result).toEqual(compactResult);
    } else expect(JSON.parse(record.output).truncated).toBe(true);
  });
  it.each([
    'conflict',
    'alias-conflict',
    'extra-text',
    'malformed',
    'invalid-state',
    'invalid-error',
    'wrong-tool',
    'wrong-server',
    'untrusted',
    'single-overflow',
    'metadata-overflow',
    'no-duplicate',
  ] as const)('does not label non-equivalent or incomplete evidence as complete: %s', async (kind) => {
    const envelope: Record<string, unknown> = {
      untrusted: true,
      data: { ok: true, tool: 'app.mota.act', data: motaState(kind === 'single-overflow' ? 300 : 144) },
    };
    if (kind === 'invalid-state') (envelope.data as Record<string, unknown>).data = { ...motaState(), documentGeneration: -1 };
    if (kind === 'invalid-error')
      envelope.data = { ok: false, tool: 'app.mota.act', error: { code: 'invented', message: 'x'.repeat(9000) } };
    if (kind === 'untrusted') envelope.untrusted = false;
    const content = [{ type: 'text', text: kind === 'malformed' ? '{broken' : JSON.stringify(envelope) }];
    const result: Record<string, unknown> = { content, structured_content: envelope };
    if (kind === 'conflict') result.structured_content = { ...envelope, untrusted: false };
    if (kind === 'alias-conflict') result.structuredContent = { ...envelope, untrusted: false };
    if (kind === 'extra-text') content.push({ type: 'text', text: 'additional evidence' });
    if (kind === 'metadata-overflow') result._meta = { audit: 'm'.repeat(17000) };
    if (kind === 'no-duplicate') {
      delete result.structured_content;
      content[0]!.text = JSON.stringify({ ...envelope, data: { ok: true, tool: 'app.mota.act', data: motaState(300) } });
    }
    if (kind === 'malformed') result._meta = { padding: 'm'.repeat(17000) };
    const record = await recordMcp(
      motaMcp(result, {
        ...(kind === 'wrong-tool' ? { tool: 'app_mota_state' } : {}),
        ...(kind === 'wrong-server' ? { server: 'other' } : {}),
      }),
    );
    expect(record.truncated).toBe(true);
    expect(record.output.length).toBeLessThanOrEqual(16000);
    expect(JSON.parse(record.output).truncated).toBe(true);
  });
  it('keeps the aggregate evidence budget and explicitly omits older complete receipts', async () => {
    const f = fixture();
    await f.chat.send(space, 'read', undefined, emptyReferences(space));
    const envelope = { untrusted: true, data: { ok: true, tool: 'app.mota.act', data: motaState() } };
    const result = { content: [{ type: 'text', text: JSON.stringify(envelope) }], structured_content: envelope };
    for (let index = 0; index < 20; index++) f.emit({ type: 'item.completed', item: motaMcp(result, { id: `mota-${index}` }) });
    const records = f.chat.get(space).toolExecutions;
    expect(records.reduce((sum, record) => sum + record.output.length, 0)).toBeLessThanOrEqual(131072);
    expect(records.some((record) => record.truncated && JSON.parse(record.output).receiptOmitted)).toBe(true);
    expect(records.at(-1)?.truncated).toBe(false);
    for (const record of records.filter((record) => !record.truncated))
      expect(JSON.parse(JSON.parse(record.output).result.content[0].text)).toEqual(envelope);
    f.finish();
    await f.chat.shutdown();
  });
});
describe('space resources per-turn capability', () => {
  it('binds host registered dynamic spaces and explicit personal references without service storage', async () => {
    const f = fixture();
    f.chat.register('session-other', 'other');
    const selected = emptyReferences('session-other', 'other');
    const sent = await f.chat.send('session-other', 'read', undefined, selected);
    expect(f.start.mock.calls[0]?.[0]).toMatchObject({
      resourceBundle: {
        workspaceId: 'other',
        catalogRevision: 0,
        resources: [],
        turnId: sent.turnId,
        generation: sent.generation,
        conversationId: 'session-other',
      },
    });
    expect(f.resources.list).not.toHaveBeenCalled();
    f.finish();
    await f.chat.shutdown();
  });
  it('refuses unregistered, foreign-space and crossed personal ownership before starting a process', async () => {
    const f = fixture();
    await expect(f.chat.send('session-unregistered', 'read', undefined, emptyReferences('session-unregistered'))).rejects.toThrow(
      '宿主注册',
    );
    f.chat.register('session-other', 'other');
    expect(() => f.chat.register('session-other', 'foreign')).toThrow('归属已冻结');
    await expect(f.chat.send('session-other', 'read', undefined, emptyReferences('session-other', 'foreign'))).rejects.toThrow('参考资料');
    await expect(f.chat.send(personal, 'read', undefined, emptyReferences(personal, 'other'))).rejects.toThrow('参考资料');
    expect(f.start).not.toHaveBeenCalled();
    await f.chat.shutdown();
  });
  it('personal conversation receives the explicit empty Main capability without listing a space', async () => {
    const f = fixture();
    await f.chat.send(personal, 'hello', undefined, emptyReferences(personal));
    expect(f.resources.list).not.toHaveBeenCalled();
    expect(f.start.mock.calls[0]?.[0]).toMatchObject({ resourceBundle: { workspaceId: null, resources: [], accountId: 'test-account' } });
    f.finish();
    await f.chat.shutdown();
  });
  it('unknown cleanup in another slot blocks a new resource turn', async () => {
    const f = fixture();
    await f.chat.send(personal, 'hello', undefined, emptyReferences(personal));
    f.finish(false);
    await vi.waitFor(() => expect(f.chat.get(personal).state).toBe('failed'));
    await expect(f.chat.send(space, 'read', undefined, emptyReferences(space))).rejects.toThrow(/cleanup|清理/);
  });
  it.each(['cancel', 'shutdown'] as const)('%s prevents new execution and confirms process cleanup', async (operation) => {
    const f = fixture();
    await f.chat.send(space, 'running', undefined, emptyReferences(space));
    if (operation === 'cancel') await f.chat.cancel(space);
    else await f.chat.shutdown();
    expect(f.start).toHaveBeenCalledOnce();
    if (operation === 'shutdown') await expect(f.chat.send(space, 'late', undefined, emptyReferences(space))).rejects.toThrow('关闭');
    else expect(f.chat.get(space)).toMatchObject({ state: 'cancelled', cleanupPending: false });
    await f.chat.shutdown();
  });
  it('keeps a readable identity receipt for large real MCP results', async () => {
    const f = fixture();
    await f.chat.send(space, 'read', undefined, emptyReferences(space));
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
      await f.chat.send(space, 'read', undefined, emptyReferences(space));
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
    await f.chat.send(space, 'read', undefined, emptyReferences(space));
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
    await f.chat.send(space, 'read', undefined, emptyReferences(space));
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
    await f.chat.send(space, 'read', undefined, emptyReferences(space));
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
    await f.chat.send(space, 'read', undefined, emptyReferences(space));
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
