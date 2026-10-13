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
