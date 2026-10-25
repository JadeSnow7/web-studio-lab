import { expect, it } from 'vitest';
import { WorkflowCleanupUnconfirmedError, type CallEvent, type WorkflowCall, type WorkflowCallAdapter } from './call-adapter';
import { RoutedAdapterPool } from './routed-pool';

function deferred() {
  let resolve!: () => void;
  const promise = new Promise<void>((r) => {
    resolve = r;
  });
  return { promise, resolve };
}
const call = (label: string): WorkflowCall => ({
  callId: label,
  prompt: label,
  label,
  phase: null,
  effective: { harness: 'mock', profile: 'mock:default' },
  schema: null,
  isolation: 'readonly',
  tools: [],
  timeoutMs: 60_000,
});

it('typed return cleanup uncertainty dominates a concurrent ordinary next rejection and retains its Profile', async () => {
  const entered = deferred();
  let rejectNext!: (error: Error) => void;
  const started: (string | null)[] = [];
  const adapter: WorkflowCallAdapter = {
    harnessId: 'mock',
    run(c) {
      started.push(c.label);
      const iterator: AsyncIterableIterator<CallEvent> = {
        [Symbol.asyncIterator]() {
          return this;
        },
        async next() {
          if (c.label !== 'A') return { done: false, value: { type: 'result', text: 'successor' } };
          entered.resolve();
          return new Promise<IteratorResult<CallEvent>>((_resolve, reject) => {
            rejectNext = reject;
          });
        },
        async return() {
          rejectNext(new Error('ordinary pending next failure'));
          throw new WorkflowCleanupUnconfirmedError('return still cannot confirm the owned process');
        },
      };
      return iterator;
    },
  };
  const pool = new RoutedAdapterPool({
    defaultHarness: 'mock',
    members: [{ harnessId: 'mock', profileId: 'mock:default', profileDir: null, adapter }],
  });
  const first = pool.run(call('A'), new AbortController().signal)[Symbol.asyncIterator]();
  const nextResult = first.next().then(
    (value) => ({ value }),
    (error: unknown) => ({ error }),
  );
  await entered.promise;
  const abort = new AbortController();
  const queued = pool.run(call('B'), abort.signal)[Symbol.asyncIterator]();
  const queuedResult = queued.next();
  try {
    const closing = first.return?.().then(
      (value) => ({ value }),
      (error: unknown) => ({ error }),
    );
    expect(await closing).toMatchObject({ error: { code: 'workflow_cleanup_unconfirmed' } });
    expect(await nextResult).toMatchObject({ error: { code: 'workflow_cleanup_unconfirmed' } });
    expect(started).toEqual(['A']);
  } finally {
    abort.abort();
    await queuedResult;
  }
});
