import { randomUUID } from 'node:crypto';
import { describe, expect, it, vi } from 'vitest';
import type { MotaControlRequest, MotaTaskBinding } from '@wsl/protocol';
import { MotaControls } from './mota-control';

const binding = (): MotaTaskBinding => ({
  workspaceId: 'w',
  environmentId: 'sandbox',
  projectId: randomUUID(),
  appInstanceId: randomUUID(),
  runId: randomUUID(),
  sessionId: 's',
  resourceId: 'r',
  browserInstanceId: 'b',
  browserGeneration: 0,
  webContentsId: 1,
  documentGeneration: 0,
});
const request = (owner: MotaTaskBinding, method: 'acquire' | 'release'): MotaControlRequest => ({
  type: 'mota-control',
  requestId: randomUUID(),
  binding: owner,
  method,
  input: {},
});
const ack = (input: MotaControlRequest) => ({
  type: 'mota-control-result',
  requestId: input.requestId,
  binding: input.binding,
  method: input.method,
  ok: true,
  data: { settled: true },
});
describe('Mota run control ownership', () => {
  it('release before queued acquire tombstones the exact run without writing, never clears unknown owners', async () => {
    const controls = new MotaControls();
    const owner = binding();
    const write = vi.fn();
    expect(await controls.call(request(owner, 'release'), write)).toMatchObject({ ok: false, error: { code: 'owner_unknown' } });
    controls.register(owner);
    expect(await controls.call(request(owner, 'release'), write)).toMatchObject({ ok: true, data: { settled: true } });
    expect(await controls.call(request(owner, 'acquire'), write)).toMatchObject({ ok: false, error: { code: 'lease_revoked' } });
    expect(write).not.toHaveBeenCalled();
    expect(controls.hasUnsettled(owner.workspaceId, owner.projectId)).toBe(false);
  });
  it('a pending acquire and release require their exact receipts and keep late acquires revoked', async () => {
    const controls = new MotaControls();
    const owner = binding();
    controls.register(owner);
    const first = request(owner, 'acquire'),
      release = request(owner, 'release');
    const write = vi.fn();
    const acquiring = controls.call(first, write);
    const releasing = controls.call(release, write);
    expect(controls.hasUnsettled(owner.workspaceId, owner.projectId)).toBe(true);
    controls.receive(ack(first));
    await acquiring;
    expect(() => controls.assertActive(owner)).toThrow('not_active');
    controls.receive(ack(release));
    await releasing;
    expect(controls.hasUnsettled(owner.workspaceId, owner.projectId)).toBe(false);
    expect(write.mock.calls.map(([call]) => call.method)).toEqual(['acquire', 'release']);
  });
  it('mismatched receipt never clears ownership; timeout is not retried or cleared by late ACK', async () => {
    const controls = new MotaControls(15);
    const owner = binding();
    controls.register(owner);
    const first = request(owner, 'acquire');
    const write = vi.fn();
    const acquiring = controls.call(first, write);
    controls.receive({ ...ack(first), binding: { ...owner, runId: randomUUID() } });
    await expect(acquiring).rejects.toThrow('identity_mismatch');
    const release = request(owner, 'release');
    await expect(controls.call(release, write)).rejects.toThrow('超时');
    controls.receive(ack(release));
    expect(controls.hasUnsettled(owner.workspaceId, owner.projectId)).toBe(true);
    expect(write).toHaveBeenCalledTimes(2);
    const reconcile = request(owner, 'release');
    const completing = controls.call(reconcile, write);
    controls.receive(ack(reconcile));
    await completing;
    expect(controls.hasUnsettled(owner.workspaceId, owner.projectId)).toBe(false);
  });
  it('transport exceptions retain the lease and never allow a map write before acquire confirmation', async () => {
    const controls = new MotaControls();
    const owner = binding();
    controls.register(owner);
    await expect(
      controls.call(request(owner, 'acquire'), () => {
        throw new Error('pipe closed');
      }),
    ).rejects.toThrow('pipe closed');
    const write = vi.fn();
    expect(
      await controls.call(
        {
          type: 'mota-control',
          requestId: randomUUID(),
          binding: owner,
          method: 'map.set',
          input: { operationId: randomUUID(), expectedSha256: 'a'.repeat(64), x: 0, y: 0 },
        },
        write,
      ),
    ).toMatchObject({ ok: false, error: { code: 'busy' } });
    expect(write).not.toHaveBeenCalled();
    expect(controls.hasUnsettled(owner.workspaceId, owner.projectId)).toBe(true);
  });
});
