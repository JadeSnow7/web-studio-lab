import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { afterEach, describe, expect, it } from 'vitest';
import { FileMotaEditorOperationStore, type EditorOperationRecord } from './mota-editor-repository';
const roots: string[] = [];
afterEach(async () => {
  for (const root of roots.splice(0)) await rm(root, { recursive: true, force: true });
});
async function fixture() {
  const root = await mkdtemp(path.join(tmpdir(), 'mota-operation-store-'));
  roots.push(root);
  const file = path.join(root, 'mota-editor-operations.json');
  return { file, store: new FileMotaEditorOperationStore(file) };
}
function record(): EditorOperationRecord {
  return {
    binding: {
      workspaceId: 'space',
      environmentId: 'sandbox',
      projectId: randomUUID(),
      appInstanceId: 'old-instance',
      resourceId: 'editor',
      resourceInstanceId: 'resource',
      resourceGeneration: 1,
      browserInstanceId: 'browser',
      browserGeneration: 1,
      documentGeneration: 1,
      editorEpoch: 1,
    },
    editorSessionId: randomUUID(),
    sessionIndex: 1,
    metadata: { file: 'project/floors/MT1.js', expectedHash: null, contentHash: 'a'.repeat(64), contentLength: 12 },
    operation: { requestId: randomUUID(), status: 'staging', receipt: null, error: null },
    phase: 'submitted',
    durabilityIssue: null,
  };
}
describe('separate atomic editor metadata store', () => {
  it('publishes metadata only and restores pending as unknown without grants or source', async () => {
    const f = await fixture();
    expect(await f.store.load()).toEqual([]);
    const original = record();
    await f.store.save([original]);
    const bytes = await readFile(f.file, 'utf8');
    expect(JSON.parse(bytes).schemaVersion).toBe(1);
    expect(bytes).not.toMatch(/"content"|credentials|token|draft/);
    expect((await f.store.load())[0]).toMatchObject({
      phase: 'unknown',
      operation: { status: 'unknown', receipt: null, error: 'restart_pending' },
    });
    expect(original.phase).toBe('submitted');
  });
  it('retains exact committed receipts and durability issues across restart', async () => {
    const f = await fixture();
    const original = record();
    original.phase = 'committed';
    original.operation.status = 'committed';
    original.operation.receipt = {
      ...original.metadata,
      editorSessionId: original.editorSessionId,
      requestId: original.operation.requestId,
      afterHash: original.metadata.contentHash,
      durabilityError: 'post_rename_io_failed',
    };
    original.durabilityIssue = 'receipt notification failed';
    await f.store.save([original]);
    expect(await f.store.load()).toEqual([original]);
  });
  it('rejects corruption, unknown schemas, body fields and duplicate identities', async () => {
    const f = await fixture();
    for (const value of [
      { schemaVersion: 2, records: [] },
      { schemaVersion: 1, records: [{ ...record(), content: 'forbidden' }] },
      { schemaVersion: 1, records: [record(), record()] },
    ]) {
      if (value.records.length === 2) value.records[1] = value.records[0]!;
      await writeFile(f.file, JSON.stringify(value));
      await expect(f.store.load()).rejects.toThrow();
    }
  });
  it('fails intent publication when destination cannot be atomically replaced', async () => {
    const f = await fixture();
    const bad = new FileMotaEditorOperationStore(path.dirname(f.file));
    await expect(bad.save([record()])).rejects.toThrow();
  });
  it('rejects cross-App reuse of an original session/request instead of overwriting a recovered unknown', async () => {
    const f = await fixture();
    const first = record();
    const second = { ...first, binding: { ...first.binding, appInstanceId: 'other-app-instance' } };
    await writeFile(f.file, JSON.stringify({ schemaVersion: 1, records: [first, second] }));
    await expect(f.store.load()).rejects.toThrow('身份重复');
  });
});
