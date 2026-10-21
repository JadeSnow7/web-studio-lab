import { randomUUID } from 'node:crypto';
import vm from 'node:vm';
import { describe, expect, it, vi } from 'vitest';
import { EduAudioMonitor, eduAudioMonitorSource } from './edu-audio-monitor';

function document() {
  const context = vm.createContext({ crypto: { randomUUID }, DOMException });
  vm.runInContext(
    `
    class Track {
      #state = 'live';
      get readyState() { return this.#state; }
      stop() { this.#state = 'ended'; }
      clone() { return new Track(); }
    }
    class Stream {
      constructor(tracks) { this.tracks = tracks; }
      getTracks() { if (!(this instanceof Stream)) throw new Error('brand'); return this.tracks; }
      clone() { return new Stream(this.tracks.map(track => track.clone())); }
    }
    class Devices { getUserMedia() { return grant; } }
    class Navigator { getUserMedia() {} }
    class Target { dispatchEvent() {} addEventListener() {} }
    let resolveGrant;
    let grant = new Promise(resolve => { resolveGrant = resolve; });
    globalThis.MediaStreamTrack = Track; globalThis.MediaStream = Stream;
    globalThis.navigator = new Navigator(); navigator.mediaDevices = new Devices();
    globalThis.EventTarget = Target; globalThis.CustomEvent = class {};
    globalThis.window = new Target(); window.top = window;
    globalThis.document = new Target(); document.visibilityState = 'visible';
  `,
    context,
  );
  vm.runInContext(eduAudioMonitorSource('monitor'), context);
  const run = <T>(source: string): T => vm.runInContext(source, context) as T;
  return run;
}
describe('document-start native audio ownership', () => {
  it('stops originals, track clones and stream clones using saved native methods/getter', async () => {
    const run = document();
    run(
      'monitor.activate(); const recording = navigator.mediaDevices.getUserMedia({audio:true}); const original = new MediaStreamTrack(); resolveGrant(new MediaStream([original]));',
    );
    await run<Promise<unknown>>('recording');
    run(`const cloned = original.clone(); const copied = new MediaStream([original]).clone();
      original.stop = () => {}; Object.defineProperty(original, 'readyState', {value:'live'});
      Object.prototype.toJSON = () => ({ended:999});`);
    const receipt = await run<Promise<{ tracks: number; ended: number; pending: number }>>('monitor.stop()');
    expect(receipt).toMatchObject({ tracks: 3, ended: 3, pending: 0 });
    expect(run('cloned.readyState')).toBe('ended');
    expect(run("Object.getOwnPropertyDescriptor(navigator.mediaDevices, 'getUserMedia').configurable")).toBe(false);
    expect(run("Object.getOwnPropertyDescriptor(MediaStreamTrack.prototype, 'clone').writable")).toBe(false);
    expect(() => run('monitor.recordTrack({readyState:"ended"})')).toThrow();
    expect(() => run('Object.getPrototypeOf(navigator).getUserMedia()')).toThrow('Legacy capture is disabled');
  });
  it('waits for late native grants and ends tracks before rejecting their delivery', async () => {
    const run = document();
    run('monitor.activate(); const recording = navigator.mediaDevices.getUserMedia({audio:true});');
    const recording = run<Promise<unknown>>('recording');
    const rejected = expect(recording).rejects.toMatchObject({ name: 'NotAllowedError' });
    const cleanup = run<Promise<{ tracks: number; ended: number; pending: number }>>('monitor.stop()');
    let completed = false;
    void cleanup.then(() => {
      completed = true;
    });
    await Promise.resolve();
    expect(completed).toBe(false);
    run('const late = new MediaStreamTrack(); resolveGrant(new MediaStream([late]));');
    await rejected;
    expect(await cleanup).toMatchObject({ tracks: 1, ended: 1, pending: 0 });
    expect(run('late.readyState')).toBe('ended');
  });
});
describe('CDP cleanup receipts', () => {
  const documentId = randomUUID();
  const receipt = { documentId, epoch: 1, tracks: 2, ended: 2, pending: 0 };
  it('installs once and requires the real document, zero pending and every track ended', async () => {
    const send = vi.fn().mockResolvedValue({ result: { value: receipt } });
    const monitor = new EduAudioMonitor(send);
    await monitor.install();
    await monitor.install();
    expect(send).toHaveBeenCalledTimes(2);
    await monitor.activate();
    await expect(monitor.stop()).resolves.toEqual(receipt);
    for (const change of [{ documentId: randomUUID() }, { ended: 1 }, { pending: 1 }]) {
      send.mockResolvedValueOnce({ result: { value: { ...receipt, ...change } } });
      await expect(monitor.stop()).rejects.toThrow('实际音轨结束未确认');
    }
    send.mockResolvedValueOnce({ result: {}, exceptionDetails: { text: 'monitor missing' } });
    await expect(monitor.stop()).rejects.toThrow();
  });
  it('fails closed at the finite deadline when pending native capture or CDP never settles', async () => {
    vi.useFakeTimers();
    try {
      const send = vi
        .fn()
        .mockResolvedValueOnce({ result: { value: receipt } })
        .mockImplementationOnce(() => new Promise(() => {}));
      const monitor = new EduAudioMonitor(send);
      await monitor.activate();
      const failed = expect(monitor.stop()).rejects.toThrow('截止时间已到');
      await vi.advanceTimersByTimeAsync(2000);
      await failed;
    } finally {
      vi.useRealTimers();
    }
  });
  it('does not claim any track proof before a document was activated', async () => {
    const send = vi.fn();
    expect(await new EduAudioMonitor(send).stop()).toBeNull();
    expect(send).not.toHaveBeenCalled();
  });
});
