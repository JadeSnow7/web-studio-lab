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

import { ExitCoordinator, exitFailureDialog } from './shutdown';

it('shows concrete causes and defaults to cancel with an explicit unsafe exit warning', () => {
  const options = exitFailureDialog(
    new AggregateError([new Error('app-registry.json: sandbox 无效'), new Error('terminal 未确认')], '清理失败'),
  );
  expect(options.buttons).toEqual(['重试清理', '取消退出', '仍然退出']);
  expect(options.defaultId).toBe(1);
  expect(options.cancelId).toBe(1);
  expect(options.detail).toContain('sandbox 无效');
  expect(options.detail).toContain('terminal 未确认');
  expect(options.detail).toContain('进程可能继续运行');
  expect(options.detail).toContain('取消退出');
});
it('successful cleanup closes without prompting', async () => {
  const prompt = vi.fn();
  await expect(new ExitCoordinator(async () => undefined, prompt).request()).resolves.toBe(true);
  expect(prompt).not.toHaveBeenCalled();
});
it.each([1, 2])('failed cleanup only closes for explicit still-exit response (%s)', async (response) => {
  const cleanup = vi.fn(async () => {
    throw new Error('sandbox:null');
  });
  const prompt = vi.fn(async () => response);
  await expect(new ExitCoordinator(cleanup, prompt).request()).resolves.toBe(response === 2);
  expect(cleanup).toHaveBeenCalledOnce();
  expect(prompt).toHaveBeenCalledWith(expect.objectContaining({ detail: expect.stringContaining('sandbox:null') }));
});
it('retry performs fresh cleanup after rejection', async () => {
  const cleanup = vi.fn().mockRejectedValueOnce(new Error('registry broken')).mockResolvedValueOnce(undefined);
  const prompt = vi.fn(async () => 0);
  await expect(new ExitCoordinator(cleanup, prompt).request()).resolves.toBe(true);
  expect(cleanup).toHaveBeenCalledTimes(2);
  expect(prompt).toHaveBeenCalledOnce();
});
it('times out visibly and retries the in-flight attempt without repeating side effects', async () => {
  vi.useFakeTimers();
  try {
    let resolve!: () => void;
    const cleanup = vi.fn(
      () =>
        new Promise<void>((done) => {
          resolve = done;
        }),
    );
    const prompt = vi.fn().mockResolvedValueOnce(0).mockResolvedValueOnce(1);
    const coordinator = new ExitCoordinator(cleanup, prompt, 100);
    const closing = coordinator.request();
    await vi.advanceTimersByTimeAsync(200);
    await expect(closing).resolves.toBe(false);
    expect(cleanup).toHaveBeenCalledOnce();
    expect(prompt).toHaveBeenCalledWith(expect.objectContaining({ detail: expect.stringContaining('超时') }));
    resolve();
    await expect(coordinator.request()).resolves.toBe(true);
    expect(cleanup).toHaveBeenCalledOnce();
  } finally {
    vi.useRealTimers();
  }
});
