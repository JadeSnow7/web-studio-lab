import { createHash, randomUUID } from 'node:crypto';
import { describe, expect, it, vi } from 'vitest';
import type { MotaEditorRequest, MotaEditorResult, MotaEditorSaveInput } from '@wsl/protocol';
import { MotaEditorAuthority, MOTA_EDITOR_URL, type MotaEditorFacts } from './mota-editor';
import type { MotaEditorNativePort, MotaEditorServicePort } from './ports';
import type { EditorOperationRecord, MotaEditorOperationStore } from './mota-editor-repository';

const hash = (text: string) => createHash('sha256').update(text).digest('hex');
function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (error: Error) => void;
  const promise = new Promise<T>((yes, no) => {
    resolve = yes;
    reject = no;
  });
  return { promise, resolve, reject };
}
function fixture(restored: EditorOperationRecord[] = []) {
  let facts: MotaEditorFacts = {
    workspaceId: 'space',
    projectId: randomUUID(),
    appInstanceId: 'existing-app-instance',
    resourceId: 'editor',
    resourceInstanceId: 'resource-instance',
    resourceGeneration: 1,
    browserInstanceId: 'native-browser',
    browserGeneration: 1,
    webContentsId: 42,
    processId: 3,
    routingId: 4,
    documentGeneration: 1,
    navigationEpoch: 1,
    url: MOTA_EDITOR_URL,
    assetVersion: 'a'.repeat(64),
    manifestDigest: 'b'.repeat(64),
    trusted: true,
    visible: true,
    destroyed: false,
    theme: 'light',
  };
  let permitted = true;
  let baseline = hash('before');
  const operations = new Map<string, NonNullable<MotaEditorResult['data']>>();
  const store: MotaEditorOperationStore = { load: vi.fn(async () => structuredClone(restored)), save: vi.fn(async () => undefined) };
  const request = vi.fn(async (request: MotaEditorRequest): Promise<MotaEditorResult> => {
    let data: NonNullable<MotaEditorResult['data']> = {};
    if (request.method === 'editor.read') data = { content: 'before', contentHash: baseline, contentLength: 6 };
    if (request.method === 'editor.stage') data = { requestId: request.requestId, status: 'staged', receipt: null, error: null };
    if (request.method === 'editor.commit') {
      expect(vi.mocked(store.save)).toHaveBeenCalled();
      data = {
        requestId: request.requestId,
        status: 'committed',
        error: null,
        receipt: {
          ...request.input,
          editorSessionId: request.editorSessionId,
          requestId: request.requestId,
          afterHash: request.input.contentHash,
          durabilityError: null,
        },
      };
      baseline = request.input.contentHash;
      operations.set(request.requestId, data);
    }
    if (request.method === 'editor.revoke') data = { discarded: true, settled: true, operation: null };
    if (request.method === 'editor.status')
      data = operations.get(request.input.operationRequestId) ?? {
        requestId: request.input.operationRequestId,
        status: 'unknown',
        receipt: null,
        error: null,
      };
    return {
      binding: request.binding,
      editorSessionId: request.editorSessionId,
      requestId: request.requestId,
      method: request.method,
      ok: true,
      data,
    };
  });
  const ports: MotaEditorNativePort & MotaEditorServicePort = {
    ensureMotaEditor: vi.fn(),
    motaEditorFacts: () => facts,
    motaEditorLayout: vi.fn(),
    motaEditorVisibility: vi.fn(),
    releaseMotaEditor: vi.fn(),
    motaEditorRequest: request,
  };
  const authority = new MotaEditorAuthority(ports, store, () => permitted);
  const index = () => authority.projection('editor').sessionIndex!;
  const open = async () => {
    await authority.openMotaEditor(facts);
    return index();
  };
  const read = () =>
    authority.readMotaEditorFile('editor', { sessionIndex: index(), requestId: randomUUID(), file: 'project/floors/MT1.js' });
  const input = (): MotaEditorSaveInput => ({
    sessionIndex: index(),
    requestId: randomUUID(),
    file: 'project/floors/MT1.js',
    expectedHash: hash('before'),
    content: 'after中文🙂',
  });
  const change = (update: Partial<MotaEditorFacts>) => {
    facts = { ...facts, ...update };
    authority.factsChanged(facts);
  };
  return {
    authority,
    ports,
    request,
    store,
    index,
    open,
    read,
    input,
    change,
    facts: () => facts,
    deny: () => {
      permitted = false;
    },
  };
}
describe('Main trusted editor authority (synthetic native/service ports)', () => {
  it('refuses a stage ACK for another logical operation before any commit dispatch', async () => {
    const f = fixture();
    await f.open();
    await f.read();
    const original = f.request.getMockImplementation()!;
    f.request.mockImplementation(async (request) => {
      const result = await original(request);
      if (request.method === 'editor.stage') result.data = { requestId: randomUUID(), status: 'staged', receipt: null, error: null };
      return result;
    });
    expect((await f.authority.saveMotaEditorFile('editor', f.input())).operation.status).toBe('failed');
    expect(f.request.mock.calls.some(([request]) => request.method === 'editor.commit')).toBe(false);
  });
  it('settles guest validation failure without comparing local error presentation as a different operation', async () => {
    const f = fixture();
    await f.open();
    await f.read();
    const input = f.input();
    const original = f.request.getMockImplementation()!;
    f.request.mockImplementation(async (request) => {
      const envelope = {
        binding: request.binding,
        editorSessionId: request.editorSessionId,
        requestId: request.requestId,
        method: request.method,
      };
      if (request.method === 'editor.stage')
        return { ...envelope, ok: false, error: { code: 'invalid_content', message: 'invalid_content' } };
      if (request.method === 'editor.revoke')
        return {
          ...envelope,
          ok: true,
          data: {
            discarded: true,
            settled: true,
            operation: { requestId: input.requestId, status: 'failed', receipt: null, error: 'invalid_content' },
          },
        };
      return original(request);
    });
    const result = await f.authority.saveMotaEditorFile('editor', input);
    expect(result.operation.status).toBe('failed');
    expect(result.operation.error).toBe('invalid_content: invalid_content');
    await vi.waitFor(async () => expect(await f.open()).not.toBe(input.sessionIndex));
    expect(f.request.mock.calls.some(([request]) => request.method === 'editor.commit')).toBe(false);
  });
  it('settles a late commit only on its original session, then opens a requested new view without inheriting its baseline', async () => {
    const f = fixture();
    await f.open();
    await f.read();
    const input = f.input();
    const original = f.request.getMockImplementation()!;
    const wait = deferred<void>();
    f.request.mockImplementation(async (request) => {
      if (request.method === 'editor.commit') await wait.promise;
      return original(request);
    });
    const saving = f.authority.saveMotaEditorFile('editor', input);
    await vi.waitFor(() => expect(f.request.mock.calls.some(([request]) => request.method === 'editor.commit')).toBe(true));
    f.change({ visible: false });
    await vi.waitFor(() => expect(f.request.mock.calls.some(([request]) => request.method === 'editor.revoke')).toBe(true));
    f.change({ visible: true });
    wait.resolve();
    const result = await saving;
    expect(result.operation.status).toBe('committed');
    await vi.waitFor(() => expect(f.index()).not.toBe(input.sessionIndex));
    await vi.waitFor(() => expect(f.authority.projection('editor').state).toBe('active'));
    await expect(f.authority.saveMotaEditorFile('editor', f.input())).rejects.toThrow('source_changed');
    expect((await f.authority.saveMotaEditorFile('editor', input)).operation).toEqual(result.operation);
  });
  it('does not release an unconfirmed revoked session merely because original status proves commit', async () => {
    const f = fixture();
    await f.open();
    await f.read();
    const input = f.input();
    const original = f.request.getMockImplementation()!;
    f.request.mockImplementation(async (request) => {
      if (request.method === 'editor.revoke') throw new Error('revoke reply dropped');
      const result = await original(request);
      if (request.method === 'editor.commit') throw new Error('commit reply dropped');
      return result;
    });
    expect((await f.authority.saveMotaEditorFile('editor', input)).operation.status).toBe('unknown');
    const state = await f.authority.motaEditorOperationStatus('editor', {
      sessionIndex: input.sessionIndex,
      operationRequestId: input.requestId,
      requestId: randomUUID(),
    });
    expect(state.operations[0]?.operation.status).toBe('committed');
    await expect(f.open()).rejects.toThrow('busy');
  });
  it('derives immutable binding, reads and persists intent before commit; retains idempotent receipts after revoke', async () => {
    const f = fixture();
    await f.open();
    await f.read();
    const input = f.input();
    const saved = await f.authority.saveMotaEditorFile('editor', input);
    expect(saved.operation).toMatchObject({
      status: 'committed',
      receipt: { contentLength: Buffer.byteLength(input.content), contentHash: hash(input.content) },
    });
    const intent = vi.mocked(f.store.save).mock.calls[0]![0][0]!;
    expect(intent).toMatchObject({ phase: 'submitted', metadata: { contentHash: hash(input.content) } });
    expect(JSON.stringify(intent)).not.toContain(input.content);
    f.change({ visible: false });
    const count = f.request.mock.calls.filter(([request]) => request.method === 'editor.commit').length;
    expect(await f.authority.saveMotaEditorFile('editor', input)).toEqual(saved);
    await expect(f.authority.saveMotaEditorFile('editor', { ...input, content: 'changed' })).rejects.toThrow('operation_conflict');
    expect(f.request.mock.calls.filter(([request]) => request.method === 'editor.commit')).toHaveLength(count);
  });
  it.each([
    'visible',
    'trusted',
    'destroyed',
    'url',
    'processId',
    'routingId',
    'documentGeneration',
    'navigationEpoch',
    'resourceGeneration',
    'resourceInstanceId',
    'browserGeneration',
    'browserInstanceId',
    'appInstanceId',
    'manifestDigest',
    'assetVersion',
  ] as const)('rejects stale native %s at each dispatch boundary', async (field) => {
    const f = fixture();
    await f.open();
    await f.read();
    const input = f.input();
    f.deny();
    const original = f.facts()[field];
    f.change({ [field]: typeof original === 'boolean' ? !original : typeof original === 'number' ? original + 1 : original + '-changed' });
    await expect(f.authority.saveMotaEditorFile('editor', input)).rejects.toThrow('revoked');
    expect(f.request.mock.calls.some(([request]) => request.method === 'editor.stage')).toBe(false);
  });
  it('never treats a fresh session/index as authority without Main scope and a read snapshot', async () => {
    const f = fixture();
    f.deny();
    await f.open();
    expect(f.index()).toBeNull();
    const g = fixture();
    await g.open();
    await expect(g.authority.saveMotaEditorFile('editor', g.input())).rejects.toThrow('source_changed');
    await expect(
      g.authority.readMotaEditorFile('other-resource', { sessionIndex: g.index(), requestId: randomUUID(), file: '_server/config.json' }),
    ).rejects.toThrow('revoked');
  });
  it('does not dispatch commit after navigation during stage or intent persistence', async () => {
    for (const boundary of ['stage', 'persist']) {
      const f = fixture();
      await f.open();
      await f.read();
      const input = f.input();
      const wait = deferred<void>();
      const original = f.request.getMockImplementation()!;
      if (boundary === 'stage')
        f.request.mockImplementation(async (request) => {
          if (request.method === 'editor.stage') await wait.promise;
          return original(request);
        });
      else
        vi.mocked(f.store.save).mockImplementationOnce(async () => {
          await wait.promise;
        });
      const save = f.authority.saveMotaEditorFile('editor', input);
      await vi.waitFor(() =>
        expect(
          boundary === 'stage'
            ? f.request.mock.calls.some(([request]) => request.method === 'editor.stage')
            : vi.mocked(f.store.save).mock.calls.length > 0,
        ).toBe(true),
      );
      f.change({ navigationEpoch: 2, trusted: false });
      wait.resolve();
      expect((await save).operation.status).toBe('failed');
      expect(f.request.mock.calls.some(([request]) => request.method === 'editor.commit')).toBe(false);
    }
  });
  it('tombstones a delayed open ACK without reactivation or automatic open retry', async () => {
    const f = fixture();
    const wait = deferred<MotaEditorResult>();
    const original = f.request.getMockImplementation()!;
    let opening: MotaEditorRequest | undefined;
    f.request.mockImplementation(async (request) => {
      if (request.method === 'editor.open') {
        opening = request;
        return wait.promise;
      }
      return original(request);
    });
    const open = f.open();
    await vi.waitFor(() => expect(opening).toBeDefined());
    f.change({ trusted: false, navigationEpoch: 2 });
    wait.resolve({ ...opening!, ok: true, data: {} });
    await open;
    expect(f.authority.projection('editor').state).toBe('revoked');
    await vi.waitFor(() => expect(f.request.mock.calls.some(([request]) => request.method === 'editor.revoke')).toBe(true));
    expect(f.request.mock.calls.filter(([request]) => request.method === 'editor.open')).toHaveLength(1);
  });
  it('does not commit if atomic intent publication fails', async () => {
    const f = fixture();
    await f.open();
    await f.read();
    vi.mocked(f.store.save).mockRejectedValueOnce(new Error('intent fsync failed'));
    expect((await f.authority.saveMotaEditorFile('editor', f.input())).operation.status).toBe('failed');
    expect(f.request.mock.calls.some(([request]) => request.method === 'editor.commit')).toBe(false);
  });
  it('preserves the original committed receipt after result persistence or notification failure', async () => {
    const f = fixture();
    await f.open();
    await f.read();
    const input = f.input();
    vi.mocked(f.store.save).mockImplementation(async (records) => {
      if (records.some((record) => record.phase === 'committed')) throw new Error('receipt fsync failed');
    });
    vi.mocked(f.ports.motaEditorVisibility).mockImplementation(() => {
      throw new Error('notification failed');
    });
    const result = await f.authority.saveMotaEditorFile('editor', input);
    expect(result.operation.status).toBe('committed');
    expect(result.durabilityIssue).toBeTruthy();
    expect((await f.authority.saveMotaEditorFile('editor', input)).operation).toEqual(result.operation);
    expect(f.request.mock.calls.filter(([request]) => request.method === 'editor.commit')).toHaveLength(1);
  });
  it('keeps dropped commit responses unknown and reconciles only the original operation without resend', async () => {
    const f = fixture();
    await f.open();
    await f.read();
    const input = f.input();
    const original = f.request.getMockImplementation()!;
    f.request.mockImplementation(async (request) => {
      const reply = await original(request);
      if (request.method === 'editor.commit') throw new Error('dropped reply');
      return reply;
    });
    const result = await f.authority.saveMotaEditorFile('editor', input);
    expect(result.operation.status).toBe('unknown');
    expect((await f.authority.saveMotaEditorFile('editor', input)).operation.status).toBe('unknown');
    await expect(f.open()).rejects.toThrow('busy');
    const projection = await f.authority.motaEditorOperationStatus('editor', {
      sessionIndex: input.sessionIndex,
      requestId: randomUUID(),
      operationRequestId: input.requestId,
    });
    expect(projection.operations[0]?.operation.status).toBe('committed');
    expect(f.request.mock.calls.filter(([request]) => request.method === 'editor.commit')).toHaveLength(1);
  });
  it('rejects mismatched receipts, oversized UTF-8 and forged envelope additions', async () => {
    const f = fixture();
    await f.open();
    await f.read();
    const input = f.input();
    await expect(f.authority.saveMotaEditorFile('editor', { ...input, content: '中'.repeat(100000) })).rejects.toThrow('256 KiB');
    await expect(f.authority.saveMotaEditorFile('editor', { ...input, root: '/host' } as MotaEditorSaveInput)).rejects.toThrow();
    const original = f.request.getMockImplementation()!;
    f.request.mockImplementation(async (request) => {
      const reply = await original(request);
      return request.method === 'editor.commit' ? { ...reply, requestId: randomUUID() } : reply;
    });
    expect((await f.authority.saveMotaEditorFile('editor', input)).operation.status).toBe('unknown');
  });
  it('keeps an unknown owner charged and never silently adopts current hash as a receipt', async () => {
    const f = fixture();
    await f.open();
    await f.read();
    const input = f.input();
    const original = f.request.getMockImplementation()!;
    f.request.mockImplementation(async (request) => {
      if (request.method === 'editor.commit' || request.method === 'editor.revoke') throw new Error('disconnected');
      return original(request);
    });
    await f.authority.saveMotaEditorFile('editor', input);
    const status = await f.authority.motaEditorOperationStatus('editor', {
      sessionIndex: input.sessionIndex,
      requestId: randomUUID(),
      operationRequestId: input.requestId,
    });
    expect(status.operations[0]?.operation).toMatchObject({ status: 'unknown', receipt: null });
    await expect(f.open()).rejects.toThrow('busy');
  });
  it('restores metadata without dispatch, and refuses the 16-owner, 1024/App and 4096-global bounds without eviction', async () => {
    const seed = fixture();
    await seed.open();
    await seed.read();
    await seed.authority.saveMotaEditorFile('editor', seed.input());
    const original = vi.mocked(seed.store.save).mock.calls.at(-1)![0][0]!;
    const records = (count: number, unknown: boolean, sameApp: boolean): EditorOperationRecord[] =>
      Array.from({ length: count }, (_, index) => ({
        ...structuredClone(original),
        editorSessionId: randomUUID(),
        sessionIndex: index + 1,
        binding: { ...original.binding, appInstanceId: sameApp ? 'existing-app-instance' : 'retired-' + index },
        phase: unknown ? 'unknown' : 'failed',
        operation: { requestId: randomUUID(), status: unknown ? 'unknown' : 'failed', receipt: null, error: 'retained original' },
      }));
    const recovered = fixture(records(16, true, false));
    expect(recovered.request).not.toHaveBeenCalled();
    await expect(recovered.open()).rejects.toThrow('busy');
    expect(recovered.request).not.toHaveBeenCalled();
    for (const [count, sameApp] of [
      [1024, true],
      [4096, false],
    ] as const) {
      const f = fixture(records(count, false, sameApp));
      await f.open();
      await f.read();
      await expect(f.authority.saveMotaEditorFile('editor', f.input())).rejects.toThrow('budget_exceeded');
      expect(f.request.mock.calls.some(([request]) => request.method === 'editor.stage')).toBe(false);
      expect(f.authority.projection('editor').operations).toHaveLength(count);
    }
  });
});
