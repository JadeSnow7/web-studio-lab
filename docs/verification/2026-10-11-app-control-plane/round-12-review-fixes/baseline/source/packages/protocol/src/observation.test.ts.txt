import { describe, expect, it } from 'vitest';
import { ObservationRequestSchema, ResourceInstanceIdentitySchema, FileInvalidationHintSchema } from './observation';
const resource = { workspaceId: 'w', environmentId: 'local', resourceId: 'file', kind: 'file', instanceId: 'i', instanceGeneration: 1 };
describe('observation resource binding', () => {
  it('requires stable resource and instance identity with a nonnegative instance generation', () => {
    expect(ResourceInstanceIdentitySchema.parse(resource)).toEqual(resource);
    expect(ResourceInstanceIdentitySchema.safeParse({ ...resource, instanceId: undefined }).success).toBe(false);
    expect(ResourceInstanceIdentitySchema.safeParse({ ...resource, instanceGeneration: -1 }).success).toBe(false);
  });
  it('keeps request, session and run attribution explicit rather than inferring focus', () => {
    const request = { requestId: 'r', workspaceId: 'w', sessionId: 's', runId: null, target: resource, tool: 'files.list', args: {} };
    expect(ObservationRequestSchema.parse(request)).toEqual(request);
    expect(ObservationRequestSchema.safeParse({ ...request, requestId: undefined }).success).toBe(false);
    expect(ObservationRequestSchema.safeParse({ ...request, runId: undefined }).success).toBe(false);
    expect(ObservationRequestSchema.safeParse({ ...request, hostRoot: '/secret' }).success).toBe(false);
    expect(ObservationRequestSchema.safeParse({ ...request, target: { ...resource, workspaceId: 'other' } }).success).toBe(false);
  });
  it('binds lossy hints to the same resource instance', () => {
    const hint = {
      ...resource,
      generation: 'g',
      watchGeneration: 1,
      sequence: 1,
      capturedAt: new Date().toISOString(),
      change: 'closed',
      coverage: { scope: 'observed-directories', recursive: false, lossy: true },
    };
    expect(FileInvalidationHintSchema.parse(hint)).toEqual(hint);
  });
});
