import { describe, expect, it, vi } from 'vitest';
import { createOcclusion } from './occlusion';
describe('native overlay barrier', () => {
  it('blocks layout while waiting, publishes only after confirmed hide, keeps other sources active', async () => {
    let confirm: (ok: boolean) => void = () => {
      throw new Error('missing pending hide');
    };
    const barrier = createOcclusion(
      () =>
        new Promise<boolean>((resolve) => {
          confirm = resolve;
        }),
    );
    const pending = barrier.open('left');
    expect(barrier.blocked()).toBe(true);
    expect(barrier.visible('left')).toBe(false);
    confirm(true);
    expect(await pending).toBe(true);
    expect(barrier.visible('left')).toBe(true);
    const second = barrier.open('right');
    confirm(true);
    await second;
    barrier.close('left');
    expect(barrier.blocked()).toBe(true);
    barrier.close('right');
    expect(barrier.blocked()).toBe(false);
  });
  it('does not expose a failed or cancelled opening and does not clear another source', async () => {
    const failed = createOcclusion(vi.fn().mockResolvedValue(false));
    expect(await failed.open('left')).toBe(false);
    expect(failed.visible('left')).toBe(false);
    expect(failed.blocked()).toBe(false);
    let confirm: (ok: boolean) => void = () => {
      throw new Error('missing pending hide');
    };
    const barrier = createOcclusion(
      () =>
        new Promise<boolean>((resolve) => {
          confirm = resolve;
        }),
    );
    const pending = barrier.open('right');
    barrier.close('right');
    confirm(true);
    expect(await pending).toBe(false);
    expect(barrier.blocked()).toBe(false);
  });
});
