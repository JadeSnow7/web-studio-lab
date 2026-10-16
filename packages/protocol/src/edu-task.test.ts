import { describe, expect, it } from 'vitest';
import { EduTaskBindingSchema, EduTaskDispatchRejectionSchema, EduTaskOperationResultSchema } from './edu-task';
import { ChatServiceMessageSchema, ChatServiceRequestSchema } from './chat';
import { WorkbenchRunSchema } from './workspace';

const binding = EduTaskBindingSchema.parse({
  runId: '00000000-0000-4000-8000-000000000001',
  workspaceId: 'workspace',
  projectId: '00000000-0000-4000-8000-000000000002',
  appInstanceId: '00000000-0000-4000-8000-000000000003',
  resourceId: 'browser-resource',
  instanceId: 'browser-instance',
  generation: 1,
  webContentsId: 7,
  documentGeneration: 2,
  sourceSha256: 'a'.repeat(64),
  protectedFiles: [{ path: 'admin/src/App.tsx', sha256: 'b'.repeat(64), bytes: 1 }],
});
const app = {
  workspaceId: binding.workspaceId,
  projectId: binding.projectId,
  environmentId: 'sandbox',
  appInstanceId: binding.appInstanceId,
  state: 'running',
  url: 'http://127.0.0.1:3000',
  guestCwd: '/home/agent/workspace/.wsl-apps/project',
  error: null,
  cleanupConfirmed: false,
};
const oldRun = {
  runId: binding.runId,
  workspaceId: binding.workspaceId,
  sessionId: 'session',
  taskVersionId: 'task',
  targetRef: null,
  state: 'completed',
  startedAt: 'then',
  endedAt: 'then',
  error: null,
  candidateId: 'candidate',
  validation: { state: 'not_run', applicability: 'unknown', reason: null },
  review: null,
};

describe('edu task cleanup contracts with source evidence', () => {
  it('represents pre-model rejection without implying that the source helper was cleaned up', () => {
    const result = {
      kind: 'edu-task-dispatch-rejected',
      conversationId: 'conv-personal-default',
      binding,
      executorStarted: false,
      error: 'source mismatch',
    };
    expect(ChatServiceMessageSchema.parse({ type: 'response', id: 'request', result })).toEqual({
      type: 'response',
      id: 'request',
      result,
    });
    for (const invalid of [
      { ...result, executorStarted: true },
      { ...result, executorStarted: undefined },
      { ...result, binding: { runId: binding.runId } },
      { ...result, conversationId: undefined },
      { ...result, error: '' },
      { ...result, error: 'x'.repeat(1001) },
      { ...result, cleanupConfirmed: true },
      { ...result, knownNotSent: true },
    ])
      expect(EduTaskDispatchRejectionSchema.safeParse(invalid).success).toBe(false);
  });
  it.each(['prepare', 'cancel'] as const)('round-trips the full owned %s receipt through the service envelope', (operation) => {
    const result = { binding, operation, ok: true, cleanupConfirmed: true };
    expect(ChatServiceMessageSchema.parse({ type: 'response', id: 'request', result })).toEqual({
      type: 'response',
      id: 'request',
      result,
    });
    expect(EduTaskOperationResultSchema.safeParse({ ...result, app }).success).toBe(false);
  });
  it('requires an authoritative App only for confirmed successful apply', () => {
    const result = { binding, operation: 'apply', ok: true, cleanupConfirmed: true, app };
    expect(EduTaskOperationResultSchema.parse(result)).toEqual(result);
    expect(EduTaskOperationResultSchema.safeParse({ ...result, app: undefined }).success).toBe(false);
    expect(EduTaskOperationResultSchema.safeParse({ ...result, cleanupConfirmed: false }).success).toBe(false);
    expect(EduTaskOperationResultSchema.safeParse({ ...result, ok: false, error: 'failed' }).success).toBe(false);
  });
  it.each([true, false])('keeps explicit failure cleanupConfirmed=%s and rejects incomplete or widened receipts', (cleanupConfirmed) => {
    const result = { binding, operation: 'apply', ok: false, cleanupConfirmed, error: 'helper outcome' };
    expect(EduTaskOperationResultSchema.parse(result)).toEqual(result);
    for (const malformed of [
      { ...result, cleanupConfirmed: undefined },
      { ...result, error: '' },
      { ...result, error: 'x'.repeat(1001) },
      { ...result, operation: 'start' },
      { ...result, binding: { ...binding, resourceId: undefined } },
      { ...result, binding: { ...binding, hostPath: '/outside' } },
      { ...result, hostPath: '/outside' },
    ])
      expect(EduTaskOperationResultSchema.safeParse(malformed).success).toBe(false);
  });
  it('accepts cancellation only with the full frozen binding, without disturbing source collection requests', () => {
    const request = { id: 'request', method: 'app.cancelEduTask', payload: binding };
    expect(ChatServiceRequestSchema.parse(request)).toEqual(request);
    expect(ChatServiceRequestSchema.safeParse({ ...request, payload: { runId: binding.runId } }).success).toBe(false);
    const source = {
      id: 'source',
      method: 'app.source.snapshot',
      payload: { callId: binding.runId, target: { workspaceId: binding.workspaceId, projectId: binding.projectId } },
    };
    expect(ChatServiceRequestSchema.parse(source)).toEqual(source);
  });
  it('preserves independent D and edu unresolved facts through a persisted-run round trip', () => {
    const input = {
      ...oldRun,
      eduTask: binding,
      eduTaskCleanupPending: true,
      sourceCleanupPending: true,
      sourceChange: { state: 'unavailable', reason: 'collector cleanup unknown' },
    };
    const restored = WorkbenchRunSchema.parse(JSON.parse(JSON.stringify(WorkbenchRunSchema.parse(input))));
    expect(restored).toMatchObject(input);
    expect(restored.validation.state).toBe('not_run');
    expect(restored.review).toBeNull();
  });
  it('does not synthesize cleanup or evidence fields while reading a legacy schema4 run', () => {
    const parsed = WorkbenchRunSchema.parse(oldRun);
    for (const field of ['eduTask', 'eduTaskCleanupPending', 'sourceChange', 'sourceCleanupPending'])
      expect(parsed).not.toHaveProperty(field);
  });
});
