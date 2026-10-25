import { describe, expect, it, vi } from 'vitest';
import { ServiceWorkflowHost } from './workflow-host';
import type { WorkflowRunOutcome } from '@wsl/protocol';

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((r) => {
    resolve = r;
  });
  return { promise, resolve };
}
function setup(ready = Promise.resolve()) {
  const done = deferred<WorkflowRunOutcome>();
  const stop = vi.fn(async () => {});
  const launch = deferred<void>();
  let held = false;
  const run = vi.fn(async () => {
    if (held) await launch.promise;
    return { done: done.promise, stop };
  });
  const host = new ServiceWorkflowHost({
    ready,
    post: vi.fn(),
    start: () => {
      throw new Error('unused');
    },
    harnesses: [],
    engine: { run },
  });
  const request = { id: 'r', method: 'workflow-run' as const, runId: 'run', script: '', args: null, cache: [] };
  return {
    host,
    done,
    stop,
    launch,
    run,
    request,
    hold: () => {
      held = true;
    },
  };
}
describe('service workflow shutdown ownership', () => {
  it('waits for active kernel cleanup and rejects new admissions synchronously', async () => {
    const x = setup();
    await x.host.execute(x.request);
    let ended = false;
    const closing = x.host.shutdown().then(() => {
      ended = true;
    });
    await expect(x.host.execute({ ...x.request, runId: 'later' })).rejects.toThrow(/closing/);
    await vi.waitFor(() => expect(x.stop).toHaveBeenCalledTimes(1));
    expect(ended).toBe(false);
    x.done.resolve({ status: 'stopped' });
    await closing;
    expect(ended).toBe(true);
  });
  it('ready-pending admission never starts a kernel after shutdown begins', async () => {
    const ready = deferred<void>();
    const x = setup(ready.promise);
    const admission = x.host.execute(x.request);
    const result = admission.catch((e: unknown) => e);
    const closing = x.host.shutdown();
    ready.resolve();
    await closing;
    expect(await result).toBeInstanceOf(Error);
    expect(x.run).not.toHaveBeenCalled();
  });
  it('owns an engine launch in flight until its eventual handle is stopped and cleaned', async () => {
    const x = setup();
    x.hold();
    const admission = x.host.execute(x.request);
    await vi.waitFor(() => expect(x.run).toHaveBeenCalledTimes(1));
    let ended = false;
    const closing = x.host.shutdown().then(() => {
      ended = true;
    });
    x.launch.resolve();
    await admission;
    await vi.waitFor(() => expect(x.stop).toHaveBeenCalledTimes(1));
    expect(ended).toBe(false);
    x.done.resolve({ status: 'stopped' });
    await closing;
  });
  it('does not acknowledge an unconfirmed cleanup or erase the owned handle', async () => {
    const x = setup();
    x.stop.mockRejectedValue(new Error('cleanup unconfirmed'));
    await x.host.execute(x.request);
    await expect(x.host.shutdown()).rejects.toThrow(/cleanup unconfirmed/);
    await expect(x.host.shutdown()).rejects.toThrow(/cleanup unconfirmed/);
    expect(x.stop).toHaveBeenCalledTimes(2);
  });
});
