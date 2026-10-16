import { randomUUID } from 'node:crypto';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { EduTaskBindingSchema, type EduTaskBinding } from '@wsl/protocol';
import { EduTaskOperations } from './edu-task-operations';
import type { GuestOutcome } from './sbx';

function deferred<T>() {
  let complete: ((value: T) => void) | undefined;
  let fail: ((reason: unknown) => void) | undefined;
  const promise = new Promise<T>((resolve, reject) => {
    complete = resolve;
    fail = reject;
  });
  return {
    promise,
    resolve(value: T) {
      if (!complete) throw new Error('fixture promise not initialized');
      complete(value);
    },
    reject(reason: unknown) {
      if (!fail) throw new Error('fixture promise not initialized');
      fail(reason);
    },
  };
}

function binding(overrides: Partial<EduTaskBinding> = {}): EduTaskBinding {
  return EduTaskBindingSchema.parse({
    runId: randomUUID(),
    workspaceId: 'edu-space',
    projectId: '00000000-0000-4000-8000-000000000002',
    appInstanceId: '00000000-0000-4000-8000-000000000003',
    resourceId: 'browser-resource',
    instanceId: 'browser-instance',
    generation: 1,
    webContentsId: 7,
    documentGeneration: 2,
    sourceSha256: 'a'.repeat(64),
    protectedFiles: [{ path: 'server/app.py', sha256: 'b'.repeat(64), bytes: 1 }],
    ...overrides,
  });
}

const confirmed: GuestOutcome = { confirmed: true, exitCode: 0, error: null };
const unknown: GuestOutcome = { confirmed: false, exitCode: null, error: 'transport lost' };

function child() {
  const done = deferred<GuestOutcome>();
  return { completion: done, done: done.promise, close: vi.fn(async (): Promise<GuestOutcome> => ({ ...confirmed })) };
}

afterEach(() => vi.useRealTimers());

describe('finite edu task helper ownership', () => {
  it('records cancellation before admission without claiming that an unknown guest stopped', async () => {
    const operations = new EduTaskOperations();
    const input = binding();
    expect(await operations.cancel(input)).toBe(false);
    const owner = operations.admit(input);
    expect(owner).toMatchObject({ cancelled: true, dispatchUnknown: true, pending: null, helper: null });
    expect(operations.known(input)).toBe(owner);
    expect(operations.busy(input)).toBe(true);
    expect(operations.clean(input)).toBe(false);
    const work = vi.fn(async () => undefined);
    await expect(operations.run(owner, work)).rejects.toThrow('edu_task_cancelled');
    expect(work).not.toHaveBeenCalled();
    expect(await operations.cancel(input)).toBe(false);
  });

  it('confirms cancellation of an admitted owner before work can dispatch', async () => {
    const operations = new EduTaskOperations();
    const input = binding();
    const owner = operations.admit(input);
    const work = vi.fn(async () => undefined);
    const pending = operations.run(owner, work);
    const rejected = expect(pending).rejects.toThrow('edu_task_cancelled');
    expect(await operations.cancel(input)).toBe(true);
    await rejected;
    expect(work).not.toHaveBeenCalled();
    expect(owner.pending).toBeNull();
    expect(operations.clean(input)).toBe(true);
    expect(operations.admit(input)).toBe(owner);
    expect(() => operations.beginDispatch(owner)).toThrow('edu_task_cancelled');
    expect(await operations.cancel(input)).toBe(true);
  });

  it('keeps a launch exception unknown and blocks other runs for the same project', async () => {
    const operations = new EduTaskOperations();
    const input = binding();
    const owner = operations.admit(input);
    await expect(
      operations.run(owner, async () => {
        operations.beginDispatch(owner);
        throw new Error('launch may already have dispatched');
      }),
    ).rejects.toThrow('launch may already have dispatched');
    expect(owner.dispatchUnknown).toBe(true);
    expect(operations.clean(input)).toBe(false);
    expect(() => operations.assertActive(owner)).toThrow('edu_task_helper_cleanup_unknown');
    const next = operations.admit(binding());
    const work = vi.fn(async () => undefined);
    await expect(operations.run(next, work)).rejects.toThrow('edu_task_operation_busy');
    expect(work).not.toHaveBeenCalled();
    expect(await operations.cancel(input)).toBe(false);
    await expect(operations.shutdown()).rejects.toThrow('edu_task_helper_cleanup_unknown');
    expect(owner.dispatchUnknown).toBe(true);
  });

  it('does not invent dispatch uncertainty for work that fails before launch', async () => {
    const operations = new EduTaskOperations();
    const input = binding();
    const owner = operations.admit(input);
    await expect(
      operations.run(owner, async () => {
        throw new Error('local validation rejected');
      }),
    ).rejects.toThrow('local validation rejected');
    expect(owner.dispatchUnknown).toBe(false);
    expect(operations.clean(input)).toBe(true);
    expect(await operations.cancel(input)).toBe(true);
  });

  it('registers and closes a child returned after cancellation began', async () => {
    const operations = new EduTaskOperations();
    const input = binding();
    const owner = operations.admit(input);
    const process = child();
    const dispatch = deferred<void>();
    const release = deferred<void>();
    const pending = operations.run(owner, async () => {
      operations.beginDispatch(owner);
      dispatch.resolve(undefined);
      await release.promise;
      return operations.wait(owner, process, 1000);
    });
    await dispatch.promise;
    let cancelled = false;
    const cancellation = operations.cancel(input).then((value) => {
      cancelled = true;
      return value;
    });
    await Promise.resolve();
    expect(cancelled).toBe(false);
    expect(owner.dispatchUnknown).toBe(true);
    release.resolve(undefined);
    expect(await cancellation).toBe(true);
    expect(await pending).toEqual(confirmed);
    expect(process.close).toHaveBeenCalledOnce();
    expect(owner).toMatchObject({ helper: null, pending: null, dispatchUnknown: false });
  });

  it('waits for the operation tail as well as the helper cleanup before confirming cancel', async () => {
    const operations = new EduTaskOperations();
    const input = binding();
    const owner = operations.admit(input);
    const process = child();
    const registered = deferred<void>();
    const cleaned = deferred<void>();
    const releaseTail = deferred<void>();
    const pending = operations.run(owner, async () => {
      operations.beginDispatch(owner);
      const result = operations.wait(owner, process, 1000);
      registered.resolve(undefined);
      await result;
      cleaned.resolve(undefined);
      await releaseTail.promise;
    });
    await registered.promise;
    let settled = false;
    const cancellation = operations.cancel(input).then((value) => {
      settled = true;
      return value;
    });
    await cleaned.promise;
    expect(owner.helper).toBeNull();
    expect(owner.pending).not.toBeNull();
    expect(operations.clean(input)).toBe(false);
    expect(settled).toBe(false);
    releaseTail.resolve(undefined);
    expect(await cancellation).toBe(true);
    await pending;
  });

  it.each(['unknown', 'throws'] as const)('retains the same helper after %s close and retries on later cancel', async (failure) => {
    const operations = new EduTaskOperations();
    const input = binding();
    const owner = operations.admit(input);
    const process = child();
    if (failure === 'unknown') process.close.mockResolvedValueOnce(unknown);
    else process.close.mockRejectedValueOnce(new Error('close failed'));
    operations.beginDispatch(owner);
    const waiting = operations.wait(owner, process, 1000);
    const handle = owner.helper;
    expect(handle?.child).toBe(process);
    expect(await operations.cancel(input)).toBe(false);
    expect(await waiting).toMatchObject({ confirmed: false });
    expect(owner.helper).toBe(handle);
    expect(operations.busy(input)).toBe(true);
    expect(await operations.cancel(input)).toBe(true);
    expect(process.close).toHaveBeenCalledTimes(2);
    expect(owner.helper).toBeNull();
  });

  it('deduplicates simultaneous closes while retaining an owned handle until confirmation', async () => {
    const operations = new EduTaskOperations();
    const input = binding();
    const owner = operations.admit(input);
    const process = child();
    const closeGate = deferred<GuestOutcome>();
    process.close.mockImplementation(() => closeGate.promise);
    operations.beginDispatch(owner);
    const waiting = operations.wait(owner, process, 1000);
    const first = operations.cancel(input);
    const second = operations.cancel(input);
    await Promise.resolve();
    expect(process.close).toHaveBeenCalledOnce();
    expect(owner.helper?.child).toBe(process);
    closeGate.resolve(confirmed);
    expect(await Promise.all([first, second])).toEqual([true, true]);
    expect(await waiting).toEqual(confirmed);
  });

  it('retains a transport-lost child until close confirms cleanup', async () => {
    const operations = new EduTaskOperations();
    const input = binding();
    const owner = operations.admit(input);
    const process = child();
    operations.beginDispatch(owner);
    const waiting = operations.wait(owner, process, 1000);
    process.completion.reject(new Error('lost guest transport'));
    expect(await waiting).toMatchObject({ confirmed: false });
    expect(owner.helper?.child).toBe(process);
    expect(operations.clean(input)).toBe(false);
    expect(await operations.cancel(input)).toBe(true);
    expect(process.close).toHaveBeenCalledOnce();
  });

  it('uses the same stop path on timeout and preserves an unconfirmed helper', async () => {
    vi.useFakeTimers();
    const operations = new EduTaskOperations();
    const input = binding();
    const owner = operations.admit(input);
    const process = child();
    process.close.mockResolvedValueOnce(unknown);
    operations.beginDispatch(owner);
    const waiting = operations.wait(owner, process, 25);
    await vi.advanceTimersByTimeAsync(25);
    expect(await waiting).toMatchObject({ confirmed: false });
    expect(owner.cancelled).toBe(true);
    expect(owner.helper?.child).toBe(process);
    expect(process.close).toHaveBeenCalledOnce();
    expect(await operations.cancel(input)).toBe(true);
    expect(process.close).toHaveBeenCalledTimes(2);
    expect(vi.getTimerCount()).toBe(0);
  });

  it('does not close a naturally finished helper or any unregistered App', async () => {
    const operations = new EduTaskOperations();
    const input = binding();
    const owner = operations.admit(input);
    const process = child();
    const unrelatedApp = child();
    operations.beginDispatch(owner);
    const waiting = operations.wait(owner, process, 1000);
    process.completion.resolve(confirmed);
    expect(await waiting).toEqual(confirmed);
    expect(operations.clean(input)).toBe(true);
    await operations.shutdown();
    expect(process.close).not.toHaveBeenCalled();
    expect(unrelatedApp.close).not.toHaveBeenCalled();
  });

  it('rejects changes to every frozen binding field without cancelling the real owner', async () => {
    const operations = new EduTaskOperations();
    const input = binding();
    const owner = operations.admit(input);
    const changes: Partial<EduTaskBinding>[] = [
      { workspaceId: 'another-space' },
      { projectId: randomUUID() },
      { appInstanceId: randomUUID() },
      { resourceId: 'another-resource' },
      { instanceId: 'another-instance' },
      { generation: 2 },
      { webContentsId: 8 },
      { documentGeneration: 3 },
      { sourceSha256: 'c'.repeat(64) },
      { protectedFiles: [{ path: 'server/app.py', sha256: 'c'.repeat(64), bytes: 1 }] },
    ];
    for (const change of changes) {
      const mismatch = { ...input, ...change };
      expect(() => operations.admit(mismatch)).toThrow('edu_task_binding_mismatch');
      await expect(operations.cancel(mismatch)).rejects.toThrow('edu_task_binding_mismatch');
    }
    expect(owner.cancelled).toBe(false);
    expect(() => operations.assertActive(owner)).not.toThrow();
    expect(await operations.cancel(input)).toBe(true);
  });

  it('returns target-filtered cloned bindings for the AppService cleanup path', () => {
    const operations = new EduTaskOperations();
    const first = binding();
    const other = binding({ projectId: randomUUID() });
    operations.admit(first);
    operations.admit(other);
    const copies = operations.bindings(first);
    expect(copies).toEqual([first]);
    const copy = copies.at(0);
    if (!copy) throw new Error('missing binding fixture');
    copy.sourceSha256 = 'c'.repeat(64);
    copy.protectedFiles.splice(0);
    expect(operations.known(first)?.binding).toEqual(first);
    expect(operations.bindings()).toHaveLength(2);
  });

  it('bounds tombstones without turning an unrecorded cancellation into success', async () => {
    const operations = new EduTaskOperations();
    for (let index = 0; index < 4096; index++) expect(await operations.cancel(binding())).toBe(false);
    const extra = binding();
    expect(await operations.cancel(extra)).toBe(false);
    expect(operations.known(extra)).toBeUndefined();
    expect(() => operations.admit(extra)).toThrow('edu_task_operation_limit');
    expect(operations.bindings()).toHaveLength(4096);
  });

  it('shutdown closes all finite owners, rejects new admission, and retains unknown handles for retry', async () => {
    const operations = new EduTaskOperations();
    const first = operations.admit(binding());
    const second = operations.admit(binding({ projectId: randomUUID() }));
    const bad = child();
    const good = child();
    bad.close.mockResolvedValueOnce(unknown);
    operations.beginDispatch(first);
    operations.beginDispatch(second);
    const firstWait = operations.wait(first, bad, 1000);
    const secondWait = operations.wait(second, good, 1000);
    const closing = operations.shutdown();
    expect(() => operations.admit(binding())).toThrow('edu_task_operations_closing');
    expect(() => operations.beginDispatch(first)).toThrow('edu_task_operations_closing');
    await expect(closing).rejects.toBeInstanceOf(AggregateError);
    expect(await firstWait).toMatchObject({ confirmed: false });
    expect(await secondWait).toEqual(confirmed);
    expect(first.helper?.child).toBe(bad);
    expect(second.helper).toBeNull();
    expect(good.close).toHaveBeenCalledOnce();
    await expect(operations.shutdown()).resolves.toBeUndefined();
    expect(bad.close).toHaveBeenCalledTimes(2);
    expect(first.helper).toBeNull();
  });

  it('shutdown waits for a dispatched child that is registered after closing began', async () => {
    const operations = new EduTaskOperations();
    const input = binding();
    const owner = operations.admit(input);
    const process = child();
    const dispatched = deferred<void>();
    const release = deferred<void>();
    const pending = operations.run(owner, async () => {
      operations.beginDispatch(owner);
      dispatched.resolve(undefined);
      await release.promise;
      return operations.wait(owner, process, 1000);
    });
    await dispatched.promise;
    let settled = false;
    const closing = operations.shutdown().then(() => {
      settled = true;
    });
    await Promise.resolve();
    expect(settled).toBe(false);
    expect(owner.dispatchUnknown).toBe(true);
    release.resolve(undefined);
    await closing;
    expect(await pending).toEqual(confirmed);
    expect(process.close).toHaveBeenCalledOnce();
    expect(operations.clean(input)).toBe(true);
  });
});
