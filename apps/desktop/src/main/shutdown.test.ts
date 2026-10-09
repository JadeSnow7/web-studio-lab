import { expect, it, vi } from 'vitest';
import { shutdownOwners } from './shutdown';
it('still closes application services when setup cleanup rejects and leaves failure retryable', async () => {
  const setup = vi.fn(async (): Promise<void> => {
    throw new Error('setup unknown');
  });
  const service = vi.fn(async () => undefined);
  await expect(shutdownOwners([setup, service])).rejects.toThrow('运行资源清理未确认');
  expect(service).toHaveBeenCalledOnce();
  setup.mockImplementation(async () => undefined);
  await expect(shutdownOwners([setup, service])).resolves.toBeUndefined();
  expect(service).toHaveBeenCalledTimes(2);
});
