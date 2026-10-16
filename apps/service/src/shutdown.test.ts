import { expect, it, vi } from 'vitest';
import { shutdownServiceOwners } from './shutdown';

it('waits for app cleanup before closing connections, and attempts every owner on failure', async () => {
  const order: string[] = [];
  let release!: () => void;
  const app = vi.fn(async () => {
    order.push('app');
    await new Promise<void>((done) => {
      release = done;
    });
    throw new Error('registry sandbox:null');
  });
  const chat = vi.fn(async () => {
    order.push('chat');
    throw new Error('chat unknown');
  });
  const environments = vi.fn(async () => {
    order.push('environments');
    throw new Error('terminal unknown');
  });
  const stopping = shutdownServiceOwners(app, chat, environments);
  const rejection = expect(stopping).rejects.toThrow(/registry sandbox:null.*chat unknown.*terminal unknown/s);
  await Promise.resolve();
  expect(order).toEqual(['app']);
  release();
  await rejection;
  expect(order).toEqual(['app', 'chat', 'environments']);
});
it('succeeds when all service owners confirm cleanup', async () => {
  const owner = vi.fn(async () => undefined);
  await expect(shutdownServiceOwners(owner, owner, owner)).resolves.toBeUndefined();
  expect(owner).toHaveBeenCalledTimes(3);
});

it('retains nested aggregate and cause diagnostics in the RPC message and preserves original failures', async () => {
  const registry = new Error("EACCES: permission denied, open '/fixture/chat/app-registry.json'");
  const appFailure = new AggregateError(
    [
      new Error('cannot persist app registry', { cause: registry }),
      new AggregateError(['mapping cleanup unconfirmed'], 'app mapping failure', { cause: new Error('sandbox unavailable') }),
    ],
    '应用所属进程清理未确认',
    { cause: new Error('app owner cleanup failed') },
  );
  const chatFailure = new Error('chat cleanup failed', { cause: 'transport unavailable' });
  const environments = vi.fn(async () => undefined);
  const result = await shutdownServiceOwners(
    async () => {
      throw appFailure;
    },
    async () => {
      throw chatFailure;
    },
    environments,
  ).catch((error: unknown) => error);
  expect(result).toBeInstanceOf(AggregateError);
  expect((result as AggregateError).errors).toEqual([appFailure, chatFailure]);
  expect((result as Error).message).toBe(
    [
      '应用所属进程清理未确认',
      'cannot persist app registry',
      registry.message,
      'app mapping failure',
      'mapping cleanup unconfirmed',
      'sandbox unavailable',
      'app owner cleanup failed',
      'chat cleanup failed',
      'transport unavailable',
    ].join('\n'),
  );
  expect(environments).toHaveBeenCalledOnce();
});

it('bounds cyclic error references without hiding the other cleanup diagnostics', async () => {
  const cause = new Error('cyclic cause');
  cause.cause = cause;
  const aggregate = new AggregateError([], 'cyclic aggregate');
  aggregate.errors.push(aggregate, cause, new Error('app-registry.json unavailable'));
  await expect(
    shutdownServiceOwners(
      async () => {
        throw aggregate;
      },
      async () => undefined,
      async () => undefined,
    ),
  ).rejects.toThrow(
    'cyclic aggregate\n[circular error reference]\ncyclic cause\n[circular error reference]\napp-registry.json unavailable',
  );
});

it('continues rejecting failed cleanup and permits a fresh retry once the owner is repaired', async () => {
  const failure = new AggregateError([new Error('app-registry.json is a directory')], '应用所属进程清理未确认');
  const apps = vi.fn<() => Promise<void>>().mockRejectedValueOnce(failure).mockResolvedValueOnce(undefined);
  const chat = vi.fn(async () => undefined);
  const environments = vi.fn(async () => undefined);
  await expect(shutdownServiceOwners(apps, chat, environments)).rejects.toThrow('app-registry.json is a directory');
  await expect(shutdownServiceOwners(apps, chat, environments)).resolves.toBeUndefined();
  expect(apps).toHaveBeenCalledTimes(2);
  expect(chat).toHaveBeenCalledTimes(2);
  expect(environments).toHaveBeenCalledTimes(2);
});
