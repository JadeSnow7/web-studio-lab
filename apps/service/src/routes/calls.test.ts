import { describe, expect, it, vi } from 'vitest';
import { CancellableCalls, MainRelay } from './calls';

describe('CancellableCalls', () => {
  it('rejects a duplicate id while running and releases it afterwards', async () => {
    const calls = new CancellableCalls('duplicate');
    let finish!: () => void;
    const first = calls.run('a', () => new Promise<void>((resolve) => (finish = resolve)));
    await expect(calls.run('a', async () => undefined)).rejects.toThrow('duplicate');
    finish();
    await first;
    await expect(calls.run('a', async () => 'again')).resolves.toBe('again');
  });

  it('aborts one call by id or all held calls', async () => {
    const calls = new CancellableCalls('duplicate');
    const signals: AbortSignal[] = [];
    const hold = (signal: AbortSignal) =>
      new Promise<void>((resolve) => {
        signals.push(signal);
        signal.addEventListener('abort', () => resolve(), { once: true });
      });
    const one = calls.run('one', hold);
    const two = calls.run('two', hold);
    const three = calls.run('three', hold);
    calls.cancel('one');
    await one;
    expect(signals.map((signal) => signal.aborted)).toEqual([true, false, false]);
    calls.abortAll();
    await Promise.all([two, three]);
    expect(signals.every((signal) => signal.aborted)).toBe(true);
  });
});

describe('MainRelay', () => {
  it('resolves with the reply and ignores unknown or repeated replies', async () => {
    const relay = new MainRelay<string>();
    const call = vi.fn<(id: string) => void>();
    const abort = vi.fn<(id: string) => void>();
    const pending = relay.request(new AbortController().signal, 'cancelled', call, abort);
    const id = call.mock.calls[0]?.[0] ?? '';
    relay.reply('unknown', 'wrong');
    relay.reply(id, 'answer');
    relay.reply(id, 'late');
    await expect(pending).resolves.toBe('answer');
    expect(abort).not.toHaveBeenCalled();
  });

  it('notifies Main and resolves the cancelled result on abort', async () => {
    const relay = new MainRelay<string>();
    const controller = new AbortController();
    const call = vi.fn<(id: string) => void>();
    const abort = vi.fn<(id: string) => void>();
    const pending = relay.request(controller.signal, 'cancelled', call, abort);
    controller.abort();
    await expect(pending).resolves.toBe('cancelled');
    expect(abort).toHaveBeenCalledExactlyOnceWith(call.mock.calls[0]?.[0]);
    relay.reply(call.mock.calls[0]?.[0] ?? '', 'late');
  });

  it('never posts the call when the signal is already aborted', async () => {
    const relay = new MainRelay<string>();
    const call = vi.fn<(id: string) => void>();
    const abort = vi.fn<(id: string) => void>();
    await expect(relay.request(AbortSignal.abort(), 'cancelled', call, abort)).resolves.toBe('cancelled');
    expect(call).not.toHaveBeenCalled();
    expect(abort).toHaveBeenCalledOnce();
  });
});
