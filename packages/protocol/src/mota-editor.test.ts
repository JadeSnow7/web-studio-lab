import { describe, expect, it } from 'vitest';
import { ChatServiceRequestSchema } from './chat';
import { MotaEditorFrameSchema, MotaEditorRequestSchema, MOTA_EDITOR_LIMITS } from './mota-editor';

const uuid = '12345678-1234-4234-8234-123456789abc';
const binding = {
  workspaceId: 'space',
  environmentId: 'sandbox',
  projectId: uuid,
  appInstanceId: uuid,
  resourceId: 'editor',
  resourceInstanceId: uuid,
  resourceGeneration: 1,
  browserInstanceId: uuid,
  browserGeneration: 2,
  documentGeneration: 3,
  editorEpoch: 4,
};
const request = { binding, editorSessionId: uuid, requestId: uuid, method: 'editor.open', input: {} };
describe('private Mota editor DTOs', () => {
  it('preserves existing bounded AppInstance strings and UUID project identities', () => {
    expect(MotaEditorRequestSchema.safeParse({ ...request, binding: { ...binding, appInstanceId: 'app-existing-instance' } }).success).toBe(
      true,
    );
    expect(MotaEditorRequestSchema.safeParse({ ...request, binding: { ...binding, appInstanceId: 'x'.repeat(201) } }).success).toBe(false);
    expect(MotaEditorRequestSchema.safeParse({ ...request, binding: { ...binding, appInstanceId: 'bad\nidentity' } }).success).toBe(false);
    expect(MotaEditorRequestSchema.safeParse({ ...request, binding: { ...binding, projectId: 'not-a-project-uuid' } }).success).toBe(false);
  });
  it('accepts a strict independent RPC and rejects AI run identities and unknown fields', () => {
    expect(ChatServiceRequestSchema.parse({ id: 'rpc', method: 'app.motaEditor', payload: request }).method).toBe('app.motaEditor');
    expect(MotaEditorRequestSchema.safeParse({ ...request, binding: { ...binding, runId: uuid } }).success).toBe(false);
    expect(MotaEditorRequestSchema.safeParse({ ...request, root: '/source' }).success).toBe(false);
    expect(MotaEditorRequestSchema.safeParse({ ...request, method: 'editor.read', input: { file: 'project/floors/MT2.js' } }).success).toBe(
      false,
    );
  });
  it('bounds compact frames without replacing original IDs', () => {
    const frame = {
      type: 'mota-editor',
      editorSessionId: uuid,
      requestId: uuid,
      sessionIndex: 1,
      editorEpoch: 4,
      frameSeq: 256,
      method: 'editor.stage',
      phase: 'chunk',
      input: { base64: 'YQ=='.repeat(342) },
    };
    expect(MotaEditorFrameSchema.safeParse(frame).success).toBe(false);
    expect(MotaEditorFrameSchema.safeParse({ ...frame, input: { base64: 'YWFh'.repeat(341) + 'YQ==' } }).success).toBe(true);
    expect(MotaEditorFrameSchema.safeParse({ ...frame, requestId: 'short', input: { base64: 'YQ==' } }).success).toBe(false);
    expect(MOTA_EDITOR_LIMITS).toMatchObject({ chunkBytes: 1024, chunks: 256, frameBytes: 4096, frames: 264 });
  });
});
