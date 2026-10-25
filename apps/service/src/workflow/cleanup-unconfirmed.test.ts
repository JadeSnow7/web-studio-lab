import { existsSync, mkdtempSync, readFileSync, watch, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { createRun } from './kernel';
import { WorkflowCleanupUnconfirmedError, type CallEvent, type WorkflowCall, type WorkflowCallAdapter } from './call-adapter';
import { RoutedAdapterPool } from './routed-pool';
import type { JournalEvent } from './contract';

function deferred() {
  let resolve!: () => void;
  const promise = new Promise<void>((r) => {
    resolve = r;
  });
  return { promise, resolve };
}
function iterator(next: () => Promise<IteratorResult<CallEvent>>, close: () => Promise<void>): AsyncIterableIterator<CallEvent> {
  return {
    [Symbol.asyncIterator]() {
      return this;
    },
    next,
    async return() {
      await close();
      return { done: true, value: undefined };
    },
  };
}
const never = () => new Promise<IteratorResult<CallEvent>>(() => {});
const result = async (): Promise<IteratorResult<CallEvent>> => ({ done: false, value: { type: 'result', text: 'ok' } });
const program = (body: string) =>
  `export const meta={name:'cleanup',description:'ownership boundary'}; export default async function main(){${body}}`;
const PROFILE = 'mock:default';
const call = (label: string): WorkflowCall => ({
  callId: label,
  prompt: label,
  label,
  phase: null,
  effective: { harness: 'mock', profile: PROFILE },
  schema: null,
  isolation: 'readonly',
  tools: [],
  timeoutMs: 60_000,
});
afterEach(() => {
  vi.useRealTimers();
});

describe('unconfirmed cleanup is an owner boundary', () => {
  it('aborted return rejects done/stop only after other in-flight cleanup, without terminalizing the unknown call', async () => {
    const first = deferred(),
      second = deferred(),
      closeA = deferred(),
      closeB = deferred(),
      returnedA = deferred(),
      returningB = deferred();
    const events: JournalEvent[] = [],
      calls: (string | null)[] = [];
    const adapter: WorkflowCallAdapter = {
      harnessId: 'mock',
      run(c) {
        calls.push(c.label);
        if (c.label === 'A')
          return iterator(
            async () => {
              first.resolve();
              return never();
            },
            async () => {
              await closeA.promise;
              returnedA.resolve();
              throw new WorkflowCleanupUnconfirmedError('A cleanup unknown');
            },
          );
        return iterator(
          async () => {
            second.resolve();
            return never();
          },
          async () => {
            returningB.resolve();
            await closeB.promise;
          },
        );
      },
    };
    const run = await createRun({
      script: program("return parallel([()=>agent('A',{label:'A'}),()=>agent('B',{label:'B'}),()=>agent('C',{label:'C'})]);"),
      adapter,
      maxConcurrentCalls: 2,
      journal: {
        append: async (e) => {
          events.push(e);
        },
      },
    });
    let settled = false;
    const completion = run.done.then(
      (outcome) => {
        settled = true;
        return { outcome };
      },
      (error: unknown) => {
        settled = true;
        return { error };
      },
    );
    await Promise.all([first.promise, second.promise]);
    const stopped = run.stop().catch((error: unknown) => error);
    await returningB.promise;
    closeA.resolve();
    await returnedA.promise;
    await new Promise<void>((r) => setImmediate(r));
    expect(settled).toBe(false);
    expect(calls).toEqual(['A', 'B']);
    closeB.resolve();
    expect(await completion).toMatchObject({ error: { code: 'workflow_cleanup_unconfirmed' } });
    expect(await stopped).toMatchObject({ code: 'workflow_cleanup_unconfirmed' });
    expect(run.status).toBe('stopping');
    expect(events.filter((e) => e.t === 'run' && e.status !== 'running')).toEqual([]);
    expect(events.filter((e) => e.t === 'call_end' && e.callSeq === 1)).toEqual([]);
  }, 60_000);

  it('timeout return uncertainty does not retry or dispatch a queued successor', async () => {
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });
    const started = deferred();
    const calls: (string | null)[] = [],
      events: JournalEvent[] = [];
    const adapter: WorkflowCallAdapter = {
      harnessId: 'mock',
      run(c) {
        calls.push(c.label);
        if (calls.length > 1) return iterator(result, async () => {});
        return iterator(
          async () => {
            started.resolve();
            return never();
          },
          async () => {
            throw new WorkflowCleanupUnconfirmedError('timeout cleanup unknown');
          },
        );
      },
    };
    const run = await createRun({
      script: program("return parallel([()=>agent('A',{label:'A',timeoutMs:1000,retries:3}),()=>agent('C',{label:'C'})]);"),
      adapter,
      maxConcurrentCalls: 1,
      journal: {
        append: async (e) => {
          events.push(e);
        },
      },
    });
    const completion = run.done.then(
      (outcome) => ({ outcome }),
      (error: unknown) => ({ error }),
    );
    await started.promise;
    await vi.advanceTimersByTimeAsync(1000);
    expect(await completion).toMatchObject({ error: { code: 'workflow_cleanup_unconfirmed' } });
    expect(calls).toEqual(['A']);
    expect(events.filter((e) => e.t === 'attempt_start' && e.callSeq === 1)).toHaveLength(1);
    expect(events.filter((e) => e.t === 'run' && e.status !== 'running')).toEqual([]);
  }, 60_000);

  it('natural next cleanup uncertainty aborts other work and waits for its confirmed return', async () => {
    const startedA = deferred(),
      startedB = deferred(),
      fail = deferred(),
      closeB = deferred(),
      returningB = deferred();
    const calls: (string | null)[] = [],
      events: JournalEvent[] = [];
    const adapter: WorkflowCallAdapter = {
      harnessId: 'mock',
      run(c) {
        calls.push(c.label);
        if (c.label === 'A')
          return iterator(
            async () => {
              startedA.resolve();
              await fail.promise;
              throw new WorkflowCleanupUnconfirmedError('natural exit cleanup unknown');
            },
            async () => {},
          );
        return iterator(
          async () => {
            startedB.resolve();
            return never();
          },
          async () => {
            returningB.resolve();
            await closeB.promise;
          },
        );
      },
    };
    const run = await createRun({
      script: program("return parallel([()=>agent('A',{label:'A',retries:3}),()=>agent('B',{label:'B'}),()=>agent('C',{label:'C'})]);"),
      adapter,
      maxConcurrentCalls: 2,
      journal: {
        append: async (e) => {
          events.push(e);
        },
      },
    });
    let settled = false;
    const completion = run.done.then(
      (outcome) => {
        settled = true;
        return { outcome };
      },
      (error: unknown) => {
        settled = true;
        return { error };
      },
    );
    await Promise.all([startedA.promise, startedB.promise]);
    fail.resolve();
    await returningB.promise;
    expect(settled).toBe(false);
    expect(calls).toEqual(['A', 'B']);
    closeB.resolve();
    expect(await completion).toMatchObject({ error: { code: 'workflow_cleanup_unconfirmed' } });
    expect(events.filter((e) => e.t === 'call_end' && e.callSeq === 1)).toEqual([]);
    expect(events.filter((e) => e.t === 'run' && e.status !== 'running')).toEqual([]);
  }, 60_000);

  it('uncertainty waits for an already-started publication before rejecting ownership', async () => {
    const fail = deferred(),
      publishEntered = deferred(),
      publishRelease = deferred(),
      nextEntered = deferred();
    const events: JournalEvent[] = [];
    const adapter: WorkflowCallAdapter = {
      harnessId: 'mock',
      run(c) {
        if (c.label === 'A')
          return iterator(
            async () => {
              nextEntered.resolve();
              await fail.promise;
              throw new WorkflowCleanupUnconfirmedError('cleanup unknown beside publisher');
            },
            async () => {},
          );
        return iterator(
          async () => ({ done: false, value: { type: 'result', text: 'lane', candidate: { files: [] } } }),
          async () => {},
        );
      },
    };
    const run = await createRun({
      script: program("const a=agent('A',{label:'A'});const b=agent('B',{label:'B',isolation:'lane'});return [await a,await b];"),
      adapter,
      appTarget: { workspaceId: 'w', projectId: 'p' },
      baseTree: 'a'.repeat(40),
      laneWorkspace: async () => ({ baseTree: 'a'.repeat(40), files: [] }),
      publishCandidate: async () => {
        publishEntered.resolve();
        await publishRelease.promise;
        return { publication: { baseTree: 'a'.repeat(40), afterTree: 'b'.repeat(40), patchSha256: 'c'.repeat(64), files: [] } };
      },
      journal: {
        append: async (e) => {
          events.push(e);
        },
      },
    });
    let settled = false;
    const completion = run.done.then(
      (outcome) => {
        settled = true;
        return { outcome };
      },
      (error: unknown) => {
        settled = true;
        return { error };
      },
    );
    await Promise.all([nextEntered.promise, publishEntered.promise]);
    fail.resolve();
    await new Promise<void>((r) => setImmediate(r));
    expect(settled).toBe(false);
    publishRelease.resolve();
    expect(await completion).toMatchObject({ error: { code: 'workflow_cleanup_unconfirmed' } });
    expect(events.find((e) => e.t === 'call_end' && e.callSeq === 2)).toMatchObject({ status: 'ok' });
    expect(events.filter((e) => e.t === 'run' && e.status !== 'running')).toEqual([]);
  }, 60_000);

  it.each(['abort', 'timeout'] as const)(
    'pending next uncertainty outranks a resolved return after %s',
    async (kind) => {
      if (kind === 'timeout') vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });
      const started = deferred();
      let rejectNext!: (error: Error) => void;
      let calls = 0;
      const adapter: WorkflowCallAdapter = {
        harnessId: 'mock',
        run() {
          calls += 1;
          if (calls > 1) return iterator(result, async () => {});
          return iterator(
            () => {
              started.resolve();
              return new Promise<IteratorResult<CallEvent>>((_resolve, reject) => {
                rejectNext = reject;
              });
            },
            async () => {
              rejectNext(new WorkflowCleanupUnconfirmedError('pending next proves cleanup unknown'));
            },
          );
        },
      };
      const run = await createRun({
        script: program("return agent('A',{timeoutMs:1000,retries:3});"),
        adapter,
        journal: { append: async () => {} },
      });
      const completion = run.done.then(
        (outcome) => ({ outcome }),
        (error: unknown) => ({ error }),
      );
      await started.promise;
      const stopped =
        kind === 'abort'
          ? run.stop().then(
              (outcome) => ({ outcome }),
              (error: unknown) => ({ error }),
            )
          : undefined;
      if (kind === 'timeout') await vi.advanceTimersByTimeAsync(1000);
      expect(await completion).toMatchObject({ error: { code: 'workflow_cleanup_unconfirmed' } });
      if (stopped) expect(await stopped).toMatchObject({ error: { code: 'workflow_cleanup_unconfirmed' } });
      expect(calls).toBe(1);
    },
    60_000,
  );

  it('generic return failure during user stop remains internal_error', async () => {
    const started = deferred();
    const events: JournalEvent[] = [];
    const adapter: WorkflowCallAdapter = {
      harnessId: 'mock',
      run: () =>
        iterator(
          async () => {
            started.resolve();
            return never();
          },
          async () => {
            throw new Error('ordinary return bug');
          },
        ),
    };
    const run = await createRun({
      script: program("return agent('A');"),
      adapter,
      journal: {
        append: async (event) => {
          events.push(event);
        },
      },
    });
    await started.promise;
    await expect(run.stop()).resolves.toMatchObject({ status: 'failed', failureCode: 'internal_error' });
    expect(events.filter((event) => event.t === 'run' && event.status === 'stopped')).toEqual([]);
  }, 60_000);

  it('ordinary adapter exceptions keep the existing internal_error terminal', async () => {
    const adapter: WorkflowCallAdapter = {
      harnessId: 'mock',
      run: () =>
        iterator(
          async () => {
            throw new Error('ordinary adapter bug');
          },
          async () => {},
        ),
    };
    const run = await createRun({ script: program("return agent('A');"), adapter, journal: { append: async () => {} } });
    expect(await run.done).toMatchObject({ status: 'failed', failureCode: 'internal_error' });
  }, 60_000);

  it.each(['next', 'return', 'return-next-reject'] as const)(
    'pool retains the frozen member after %s cleanup uncertainty',
    async (phase) => {
      const entered = deferred(),
        release = deferred();
      let rejectNext!: (error: Error) => void;
      const started: (string | null)[] = [];
      const member: WorkflowCallAdapter = {
        harnessId: 'mock',
        run(c) {
          started.push(c.label);
          if (c.label !== 'A') return iterator(result, async () => {});
          return iterator(
            async () => {
              entered.resolve();
              if (phase === 'next') {
                await release.promise;
                throw new WorkflowCleanupUnconfirmedError('member next cleanup unknown');
              }
              return new Promise<IteratorResult<CallEvent>>((_r, reject) => {
                rejectNext = reject;
              });
            },
            async () => {
              const error = new WorkflowCleanupUnconfirmedError('member return cleanup unknown');
              rejectNext?.(error);
              if (phase !== 'return-next-reject') throw error;
            },
          );
        },
      };
      const pool = new RoutedAdapterPool({
        defaultHarness: 'mock',
        members: [{ harnessId: 'mock', profileId: PROFILE, profileDir: null, adapter: member }],
      });
      const a = pool.run(call('A'), new AbortController().signal)[Symbol.asyncIterator]();
      const first = a.next().then(
        (value) => ({ value }),
        (error: unknown) => ({ error }),
      );
      await entered.promise;
      const abortB = new AbortController();
      const b = pool.run(call('B'), abortB.signal)[Symbol.asyncIterator]();
      const second = b.next();
      try {
        if (phase === 'next') {
          release.resolve();
          expect(await first).toMatchObject({ error: { code: 'workflow_cleanup_unconfirmed' } });
        } else {
          const closed = a.return?.().then(
            (value) => ({ value }),
            (error: unknown) => ({ error }),
          );
          expect(await closed).toMatchObject({ error: { code: 'workflow_cleanup_unconfirmed' } });
          await first;
        }
        await new Promise<void>((r) => setImmediate(r));
        expect(started).toEqual(['A']);
      } finally {
        abortB.abort();
        await second;
      }
    },
    60_000,
  );
  it('pool releases a confirmed failed terminal normally for its queued successor', async () => {
    const entered = deferred(),
      release = deferred();
    const started: (string | null)[] = [];
    const adapter: WorkflowCallAdapter = {
      harnessId: 'mock',
      run(c) {
        started.push(c.label);
        return iterator(
          async () => {
            if (c.label === 'A') {
              entered.resolve();
              await release.promise;
              return { done: false, value: { type: 'failed', code: 'permission_denied', message: 'denied after confirmed cleanup' } };
            }
            return result();
          },
          async () => {},
        );
      },
    };
    const pool = new RoutedAdapterPool({
      defaultHarness: 'mock',
      members: [{ harnessId: 'mock', profileId: PROFILE, profileDir: null, adapter }],
    });
    const a = pool.run(call('A'), new AbortController().signal)[Symbol.asyncIterator]();
    const first = a.next();
    await entered.promise;
    const b = pool.run(call('B'), new AbortController().signal)[Symbol.asyncIterator]();
    const second = b.next();
    release.resolve();
    expect((await first).value).toMatchObject({ type: 'failed', code: 'permission_denied' });
    expect((await second).value).toMatchObject({ type: 'result' });
    expect(started).toEqual(['A', 'B']);
  }, 60_000);
});

function startupWorker() {
  const dir = mkdtempSync(path.join(tmpdir(), 'wsl-startup-abort-'));
  const workerPath = path.join(dir, 'worker.mjs');
  const source = `import {parentPort} from 'node:worker_threads'; import fs from 'node:fs'; const dir=${JSON.stringify(dir)};
let watcher, announced=false; const ready=()=>{if(announced)return;announced=true;watcher.close();parentPort.postMessage({t:'ready'});};
parentPort.on('message',m=>{fs.appendFileSync(dir+'/messages',m.t+'\\n');if(m.t==='dispose'){fs.writeFileSync(dir+'/disposed','yes');parentPort.close();process.exit(0);}if(m.t==='load')parentPort.postMessage({t:'settled',ok:true,value:null,pendingCalls:0});});
watcher=fs.watch(dir,()=>{if(fs.existsSync(dir+'/release'))ready();});fs.writeFileSync(dir+'/started','yes');if(fs.existsSync(dir+'/release'))ready();`;
  writeFileSync(workerPath, source);
  let resolveStarted!: () => void;
  const started = new Promise<void>((resolve) => {
    resolveStarted = resolve;
  });
  const watcher = watch(dir, () => {
    if (existsSync(path.join(dir, 'started'))) {
      watcher.close();
      resolveStarted();
    }
  });
  return { dir, workerUrl: pathToFileURL(workerPath), started, closeWatcher: () => watcher.close() };
}
describe('pending workflow launch admission', () => {
  it.each([false, true])(
    'aborted signal blocks journal/load before kernel start, alreadyAborted=%s',
    async (alreadyAborted) => {
      const worker = startupWorker();
      const abort = new AbortController();
      const events: JournalEvent[] = [];
      if (alreadyAborted) {
        abort.abort();
        writeFileSync(path.join(worker.dir, 'release'), 'yes');
      }
      const attempt = createRun({
        script: program('return null;'),
        signal: abort.signal,
        workerUrl: worker.workerUrl,
        adapter: { harnessId: 'mock', run: () => iterator(result, async () => {}) },
        journal: {
          append: async (e) => {
            events.push(e);
          },
        },
      }).then(
        (run) => ({ run }),
        (error: unknown) => ({ error }),
      );
      if (!alreadyAborted) {
        await worker.started;
        abort.abort();
        writeFileSync(path.join(worker.dir, 'release'), 'yes');
      }
      const observed = await attempt;
      try {
        expect(observed).toMatchObject({ error: { name: 'AbortError' } });
      } finally {
        worker.closeWatcher();
        if ('run' in observed) await observed.run.stop();
      }
      expect(events).toEqual([]);
      if (alreadyAborted) expect(existsSync(path.join(worker.dir, 'started'))).toBe(false);
      else {
        expect(readFileSync(path.join(worker.dir, 'messages'), 'utf8')).toBe('dispose\n');
        expect(existsSync(path.join(worker.dir, 'disposed'))).toBe(true);
      }
    },
    60_000,
  );
});
