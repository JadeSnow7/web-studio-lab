import { createHash, randomUUID } from 'node:crypto';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { MotaEditorRequestSchema, type MotaEditorFrame } from '@wsl/protocol';
import { MotaEditors } from './mota-editor';

const digest = (value: string) => createHash('sha256').update(value).digest('hex');
function fixture(service = new MotaEditors()) {
  const binding = {
    workspaceId: 'space',
    environmentId: 'sandbox',
    projectId: randomUUID(),
    appInstanceId: randomUUID(),
    resourceId: 'editor',
    resourceInstanceId: randomUUID(),
    resourceGeneration: 1,
    browserInstanceId: randomUUID(),
    browserGeneration: 1,
    documentGeneration: 1,
    editorEpoch: 1,
  };
  const editorSessionId = randomUUID();
  const frames: MotaEditorFrame[] = [];
  const reply = (frame: MotaEditorFrame, data: unknown = { settled: true }, change = {}) => {
    const { input: _input, ...envelope } = frame;
    return service.receive({ ...envelope, type: 'mota-editor-result', ok: true, data, ...change }, binding.appInstanceId);
  };
  const call = (
    method: string,
    input = {},
    write: (frame: MotaEditorFrame) => void = (frame) => {
      reply(frame);
    },
    requestId = randomUUID(),
    overrides = {},
  ) =>
    service.call(MotaEditorRequestSchema.parse({ binding, editorSessionId, method, input, requestId, ...overrides }), (frame) => {
      frames.push(frame);
      write(frame);
    });
  return { service, binding, editorSessionId, frames, reply, call };
}
afterEach(() => vi.useRealTimers());
describe('manual editor service ownership and transport', () => {
  it('correlates every envelope field and retains unknown ownership after invalid cleanup', async () => {
    const f = fixture();
    expect(await f.call('editor.open')).toMatchObject({ ok: true });
    expect(
      await f.call('editor.revoke', {}, (frame) => {
        f.reply(frame, { discarded: true, settled: true, operation: null }, { frameSeq: 1 });
      }),
    ).toMatchObject({ ok: false, error: { code: 'invalid_frame' } });
    expect(
      await f.call('editor.open', {}, undefined, randomUUID(), {
        editorSessionId: randomUUID(),
        binding: { ...f.binding, editorEpoch: 2 },
      }),
    ).toMatchObject({ ok: false, error: { code: 'budget_exceeded' } });
  });
  it.each(['editorSessionId', 'requestId', 'sessionIndex', 'editorEpoch', 'method', 'phase'] as const)(
    'rejects a wrong %s reply without granting ownership',
    async (key) => {
      const f = fixture();
      const change = { [key]: key.endsWith('Id') ? randomUUID() : key === 'method' ? 'editor.revoke' : key === 'phase' ? 'begin' : 99 };
      expect(
        await f.call('editor.open', {}, (frame) => {
          f.reply(frame, { settled: true }, change);
        }),
      ).toMatchObject({ ok: false, error: { code: 'invalid_frame' } });
      expect(await f.call('editor.read', { file: '_server/config.json' })).toMatchObject({ ok: false, error: { code: 'unavailable' } });
    },
  );
  it('does not consume another App pipe reply and preserves the 5s deadline without replay', async () => {
    vi.useFakeTimers();
    const f = fixture();
    const opening = f.call('editor.open', {}, (frame) => {
      const { input: _input, ...rest } = frame;
      f.service.receive({ ...rest, type: 'mota-editor-result', ok: true, data: { settled: true } }, randomUUID());
    });
    await vi.advanceTimersByTimeAsync(5000);
    expect(await opening).toMatchObject({ ok: false, error: { code: 'unknown' } });
    expect(f.frames).toHaveLength(1);
  });
  it('reserves opening synchronously, tombstones before awaiting, and cannot revive from a late open ACK', async () => {
    const f = fixture();
    let open: MotaEditorFrame | undefined;
    const opening = f.call('editor.open', {}, (frame) => {
      open = frame;
    });
    const revoking = f.call('editor.revoke', {}, (frame) => {
      f.reply(frame, { discarded: false, settled: true, operation: null });
    });
    if (!open) throw new Error('missing opening frame');
    f.reply(open);
    expect(await opening).toMatchObject({ ok: false, error: { code: 'revoked' } });
    expect(await revoking).toMatchObject({ ok: true });
    expect(await f.call('editor.open')).toMatchObject({ ok: false, error: { code: 'revoked' } });
    expect(
      await f.call('editor.open', {}, undefined, randomUUID(), {
        editorSessionId: randomUUID(),
        binding: { ...f.binding, editorEpoch: 2 },
      }),
    ).toMatchObject({ ok: true });
  });
  it('caps unsettled sessions at 16 and never evicts a timed out owner', async () => {
    vi.useFakeTimers();
    const service = new MotaEditors();
    const fixtures = Array.from({ length: 17 }, () => fixture(service));
    const openings = fixtures.slice(0, 16).map((f) => f.call('editor.open', {}, () => undefined));
    expect(await fixtures[16]!.call('editor.open')).toMatchObject({ ok: false, error: { code: 'budget_exceeded' } });
    await vi.advanceTimersByTimeAsync(5000);
    expect((await Promise.all(openings)).every((result) => !result.ok)).toBe(true);
    expect(await fixtures[16]!.call('editor.open')).toMatchObject({ ok: false, error: { code: 'budget_exceeded' } });
  });
  it('keeps the whole-stage deadline and unknown save idempotency without retransmitting commit', async () => {
    vi.useFakeTimers();
    const f = fixture();
    await f.call('editor.open');
    const requestId = randomUUID();
    const content = '{}';
    const metadata = { file: '_server/config.json', expectedHash: null, contentHash: digest(content), contentLength: 2 };
    const writer = (frame: MotaEditorFrame) => {
      f.reply(frame, frame.phase === 'end' ? { requestId, status: 'staged', receipt: null, error: null } : { settled: true });
    };
    expect(await f.call('editor.stage', { ...metadata, content }, writer, requestId)).toMatchObject({ ok: true });
    await vi.advanceTimersByTimeAsync(30000);
    expect(await f.call('editor.commit', metadata, writer, requestId)).toMatchObject({ ok: false, error: { code: 'expired' } });
    const count = f.frames.length;
    expect(await f.call('editor.commit', metadata, writer, requestId)).toMatchObject({ ok: false, error: { code: 'expired' } });
    expect(f.frames).toHaveLength(count);
    expect(
      await f.call('editor.status', { operationRequestId: requestId }, (frame) => {
        f.reply(frame, { requestId, status: 'staged', receipt: null, error: null });
      }),
    ).toMatchObject({ ok: true, data: { status: 'staged' } });
    const statusCount = f.frames.length;
    expect(await f.call('editor.commit', metadata, writer, requestId)).toMatchObject({ ok: false, error: { code: 'expired' } });
    expect(f.frames).toHaveLength(statusCount);
    expect(await f.call('editor.commit', { ...metadata, contentHash: '0'.repeat(64) }, writer, requestId)).toMatchObject({
      ok: false,
      error: { code: 'operation_conflict' },
    });
    expect(
      f.frames.every(
        (frame) =>
          Buffer.byteLength(JSON.stringify(frame) + '\n') <= 4096 &&
          Buffer.byteLength(JSON.stringify({ type: 'input', data: JSON.stringify(frame) + '\n' }) + '\n') <= 65536,
      ),
    ).toBe(true);
  });
  it('retains all 1024 manual operation records and refuses a new one rather than evicting unknown results', async () => {
    const f = fixture();
    await f.call('editor.open');
    const metadata = { file: '_server/config.json', expectedHash: null, contentHash: digest('{}'), contentLength: 2, content: '{}' };
    const first = randomUUID();
    const refuse = (frame: MotaEditorFrame) => {
      const { input: _input, ...envelope } = frame;
      f.service.receive(
        { ...envelope, type: 'mota-editor-result', ok: false, error: { code: 'source_changed', message: 'source_changed' } },
        f.binding.appInstanceId,
      );
    };
    for (let index = 0; index < 1024; index++) {
      const result = await f.call('editor.stage', metadata, refuse, index === 0 ? first : randomUUID());
      expect(result).toMatchObject({ ok: false, error: { code: 'source_changed' } });
    }
    const before = f.frames.length;
    expect(await f.call('editor.stage', metadata, refuse)).toMatchObject({ ok: false, error: { code: 'budget_exceeded' } });
    expect(await f.call('editor.stage', metadata, refuse, first)).toMatchObject({ ok: false, error: { code: 'source_changed' } });
    expect(f.frames).toHaveLength(before);
    f.service.retireApp(f.binding.appInstanceId);
    expect(await f.call('editor.open')).toMatchObject({ ok: false, error: { code: 'revoked' } });
  });
});
