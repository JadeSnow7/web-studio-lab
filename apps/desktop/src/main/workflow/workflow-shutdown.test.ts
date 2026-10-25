import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { describe, expect, it, vi } from 'vitest';
import { ServiceWorkflowHost } from '../../../../service/src/workflow-host';
import { ServiceWorkflowEnginePort } from './service-engine-port';
import type { ChatServiceMessage, ChatServiceRequest } from '@wsl/protocol';
import { WorkflowProcessUnconfirmedError } from './engine-port';
import { WorkflowApplication } from './application';
import { SqliteWorkflowJournal } from './journal-sqlite';
import type { WorkflowRunOutcome } from '@wsl/protocol';
function deferred<T>() {
  let resolve!: (v: T) => void;
  const promise = new Promise<T>((r) => {
    resolve = r;
  });
  return { promise, resolve };
}
function setup() {
  const journal = new SqliteWorkflowJournal(path.join(mkdtempSync(path.join(tmpdir(), 'wsl-shutdown-')), 'journal.db'));
  const done = deferred<WorkflowRunOutcome>();
  const stop = vi.fn(async () => {});
  const run = vi.fn(async () => ({ done: done.promise, stop }));
  return { journal, done, stop, run };
}
describe('Main workflow shutdown ownership', () => {
  it('owns a pending source snapshot, aborts it, and never launches afterward', async () => {
    const x = setup();
    const entered = deferred<void>();
    let signal!: AbortSignal;
    const app = new WorkflowApplication({
      journal: x.journal,
      engine: { run: x.run, shutdown: async () => {} },
      appSource: {
        snapshot: async (_target, s) => {
          signal = s;
          entered.resolve();
          return new Promise((_r, reject) => s.addEventListener('abort', () => reject(new Error('snapshot aborted')), { once: true }));
        },
        apply: async () => {
          throw new Error('unused');
        },
      },
    });
    const pending = app.run({
      requestId: 'one',
      script: "export default async function(){ return agent('task', { isolation: 'lane' }); }",
      args: null,
      appTarget: { workspaceId: 'w', projectId: 'p' },
    });
    const rejected = pending.catch((e: unknown) => e);
    await entered.promise;
    await app.shutdown();
    expect(signal.aborted).toBe(true);
    expect(await rejected).toBeInstanceOf(Error);
    expect(x.run).not.toHaveBeenCalled();
    await expect(app.run({ requestId: 'two', script: '', args: null })).rejects.toThrow(/closing/);
    await expect(app.resume({ requestId: 'three', parentWorkflowRunId: 'missing', script: '', args: null })).rejects.toThrow(/closing/);
    await expect(app.applyCandidate('missing')).rejects.toThrow(/closing/);
    x.journal.close();
  });
  it('waits for an in-flight engine launch and its cleanup receipt', async () => {
    const x = setup();
    const launch = deferred<void>();
    x.run.mockImplementation(async () => {
      await launch.promise;
      return { done: x.done.promise, stop: x.stop };
    });
    const app = new WorkflowApplication({ journal: x.journal, engine: { run: x.run, shutdown: async () => {} } });
    const accepted = app.run({ requestId: 'one', script: '', args: null });
    await vi.waitFor(() => expect(x.run).toHaveBeenCalledOnce());
    let ended = false;
    const closing = app.shutdown().then(() => {
      ended = true;
    });
    launch.resolve();
    await accepted;
    await vi.waitFor(() => expect(x.stop).toHaveBeenCalledOnce());
    expect(ended).toBe(false);
    x.done.resolve({ status: 'stopped' });
    await closing;
    x.journal.close();
  });
});

it('automatic host cleanup failure rejects Main done and retains needs_reconciliation ownership', async () => {
  const x = setup();
  let rejectDone!: (error: Error) => void;
  const done = new Promise<WorkflowRunOutcome>((_resolve, reject) => {
    rejectDone = reject;
  });
  const failure = new Error('automatic guest cleanup unconfirmed');
  const messages: ChatServiceMessage[] = [];
  type Event = Extract<
    ChatServiceMessage,
    { type: 'workflow-event' | 'workflow-done' | 'workflow-cleanup-unconfirmed' | 'workflow-candidate' | 'workflow-lanebase' }
  >;
  let listener!: (message: Event) => void;
  const service = new ServiceWorkflowHost({
    ready: Promise.resolve(),
    harnesses: [],
    start: () => {
      throw new Error('unused');
    },
    post: (message) => {
      messages.push(message);
      listener(message as Event);
    },
    engine: {
      run: async () => ({
        done,
        stop: async () => {
          throw failure;
        },
      }),
    },
  });
  const port = new ServiceWorkflowEnginePort({
    workflowRequest: (request) => service.execute({ ...request, id: 'rpc' } as ChatServiceRequest),
    setWorkflowListener: (next) => {
      listener = next;
    },
    onExit: () => {},
  });
  const event = vi.fn();
  const app = new WorkflowApplication({ journal: x.journal, engine: port, onEvent: event });
  const accepted = await app.run({ requestId: 'automatic', script: '', args: null });
  rejectDone(failure);
  await vi.waitFor(() => expect(app.status(accepted.workflowRunId).status).toBe('needs_reconciliation'));
  expect(messages).toContainEqual({ type: 'workflow-cleanup-unconfirmed', runId: accepted.workflowRunId, error: failure.message });
  expect(messages.some((message) => message.type === 'workflow-done')).toBe(false);
  expect(event).toHaveBeenCalledWith(accepted.workflowRunId);
  expect(() => app.reconcileAsStopped(accepted.workflowRunId)).toThrow(/live workflow owner/);
  await expect(app.run({ requestId: 'later', script: '', args: null })).rejects.toMatchObject({ code: 'run_busy' });
  await expect(app.shutdown()).rejects.toThrow(/workflow cleanup unconfirmed/);
  expect(x.journal.getRun(accepted.workflowRunId)!.status).toBe('needs_reconciliation');
  x.journal.close();
});

it('Main shutdown immediately revokes a remote launch before waiting for its pending admission', async () => {
  const x = setup();
  const entered = deferred<void>();
  let signal!: AbortSignal;
  const requests: ChatServiceRequest[] = [];
  let started = false;
  const service = new ServiceWorkflowHost({
    ready: Promise.resolve(),
    harnesses: [],
    post: () => {},
    start: () => {
      throw new Error('unused');
    },
    engine: {
      run: async (spec) => {
        signal = spec.signal!;
        entered.resolve();
        await new Promise<void>((_resolve, reject) =>
          signal.addEventListener('abort', () => reject(new Error('launch cancelled before kernel start')), { once: true }),
        );
        started = true;
        return { done: x.done.promise, stop: x.stop };
      },
    },
  });
  const port = new ServiceWorkflowEnginePort({
    workflowRequest: (request) => {
      const wire = { ...request, id: 'rpc' } as ChatServiceRequest;
      requests.push(wire);
      return service.execute(wire);
    },
    setWorkflowListener: () => {},
    onExit: () => {},
  });
  const app = new WorkflowApplication({ journal: x.journal, engine: port });
  const admission = app.run({ requestId: 'pending-remote', script: '', args: null });
  const result = admission.catch((error: unknown) => error);
  await entered.promise;
  const closing = app.shutdown();
  expect(signal.aborted).toBe(true);
  expect(requests.map((request) => request.method)).toEqual(['workflow-run', 'workflow-shutdown']);
  expect(requests.every((request) => !('signal' in request))).toBe(true);
  await closing;
  expect(await result).toBeInstanceOf(Error);
  expect(started).toBe(false);
  expect(x.stop).not.toHaveBeenCalled();
  x.journal.close();
});

it('a lost admission receipt cannot be manually reconciled while its process owner is unknown', async () => {
  const x = setup();
  const failure = new WorkflowProcessUnconfirmedError('admission receipt lost');
  const app = new WorkflowApplication({
    journal: x.journal,
    engine: {
      run: async () => {
        throw failure;
      },
      shutdown: async () => {
        throw failure;
      },
    },
  });
  await expect(app.run({ requestId: 'unknown-admission', script: '', args: null })).rejects.toMatchObject({ code: 'process_unconfirmed' });
  const row = x.journal.listRuns()[0]!;
  expect(row.status).toBe('needs_reconciliation');
  expect(() => app.reconcileAsStopped(row.runId)).toThrow(/live workflow owner/);
  await expect(app.stop(row.runId)).rejects.toMatchObject({ code: 'process_unconfirmed' });
  await expect(app.shutdown()).rejects.toThrow(/workflow cleanup unconfirmed/);
  x.journal.close();
});

it('beginShutdown and its exit attempt share one failed remote receipt without implicit retry', async () => {
  const x = setup();
  const shutdown = vi.fn(async () => {
    throw new Error('cleanup unconfirmed');
  });
  const app = new WorkflowApplication({ journal: x.journal, engine: { run: x.run, shutdown } });
  app.beginShutdown();
  await Promise.resolve();
  await expect(app.shutdown()).rejects.toThrow(/workflow cleanup unconfirmed/);
  expect(shutdown).toHaveBeenCalledTimes(1);
  await expect(app.shutdown()).rejects.toThrow(/workflow cleanup unconfirmed/);
  expect(shutdown).toHaveBeenCalledTimes(2);
  x.journal.close();
});
