import { randomUUID } from 'node:crypto';
import { z } from 'zod';

/** Installed by CDP before site scripts, including same-origin child documents. */
export function eduAudioMonitorSource(key: string): string {
  return `(() => {
    const key = ${JSON.stringify(key)};
    const apply = Reflect.apply, define = Object.defineProperty, freeze = Object.freeze;
    const NativePromise = Promise, NativeError = DOMException, NativeEvent = CustomEvent;
    const then = Promise.prototype.then;
    const setAdd = Set.prototype.add, setDelete = Set.prototype.delete, setEach = Set.prototype.forEach;
    const size = Object.getOwnPropertyDescriptor(Set.prototype, 'size').get;
    const tracks = new Set(), pending = new Set();
    const nativeStop = MediaStreamTrack.prototype.stop;
    const nativeReady = Object.getOwnPropertyDescriptor(MediaStreamTrack.prototype, 'readyState').get;
    const nativeTrackClone = MediaStreamTrack.prototype.clone;
    const nativeStreamClone = MediaStream.prototype.clone, nativeTracks = MediaStream.prototype.getTracks;
    const devices = navigator.mediaDevices;
    const devicePrototype = Object.getPrototypeOf(devices);
    const nativeGetUserMedia = devices.getUserMedia;
    const dispatch = EventTarget.prototype.dispatchEvent;
    const listen = EventTarget.prototype.addEventListener;
    let revoked = true, draining = false, epoch = 0;
    const documentId = crypto.randomUUID();
    const count = set => apply(size, set, []);
    const stopTrack = track => apply(nativeStop, track, []);
    const state = track => apply(nativeReady, track, []);
    const recordTrack = track => {
      state(track); // Native brand check: page-created receipts are never evidence.
      apply(setAdd, tracks, [track]);
      if (revoked) stopTrack(track);
      return track;
    };
    const recordStream = stream => {
      const found = apply(nativeTracks, stream, []);
      for (let i = 0; i < found.length; i++) recordTrack(found[i]);
      return stream;
    };
    const follow = promise => {
      const requestedEpoch = epoch;
      const wrapped = apply(then, promise, [stream => {
        recordStream(stream);
        if (revoked || requestedEpoch !== epoch) {
          const found = apply(nativeTracks, stream, []);
          for (let i = 0; i < found.length; i++) stopTrack(found[i]);
          throw new NativeError('Recording context was revoked', 'NotAllowedError');
        }
        return stream;
      }]);
      apply(setAdd, pending, [wrapped]);
      const remove = () => apply(setDelete, pending, [wrapped]);
      apply(then, wrapped, [remove, remove]);
      return wrapped;
    };
    const waitPending = () => new NativePromise(resolve => {
      let remaining = count(pending);
      if (!remaining) { resolve(); return; }
      const settled = () => { if (--remaining === 0) resolve(); };
      apply(setEach, pending, [promise => apply(then, promise, [settled, settled])]);
    });
    const receipt = () => {
      let ended = 0;
      apply(setEach, tracks, [track => { if (state(track) === 'ended') ended++; }]);
      return { __proto__: null, documentId, epoch, tracks: count(tracks), ended, pending: count(pending) };
    };
    const api = freeze({
      recordTrack, recordStream, follow,
      activate() { if (!draining) revoked = false; return receipt(); },
      async stop() {
        revoked = true; epoch++; draining = true;
        try {
          apply(dispatch, window, [new NativeEvent('wsl:deactivate')]);
          apply(setEach, tracks, [stopTrack]);
          await waitPending();
          apply(setEach, tracks, [stopTrack]);
          return receipt();
        } finally { draining = false; }
      }
    });
    let owner = api;
    if (window !== window.top) {
      try { owner = window.top[key] || api; } catch { owner = api; }
    }
    define(globalThis, key, { value: api, writable: false, configurable: false });
    const getUserMedia = function(constraints) { return owner.follow(apply(nativeGetUserMedia, this, [constraints])); };
    define(devicePrototype, 'getUserMedia', { value: getUserMedia, writable: false, configurable: false });
    define(devices, 'getUserMedia', { value: getUserMedia, writable: false, configurable: false });
    define(MediaStreamTrack.prototype, 'clone', { value: function() { return owner.recordTrack(apply(nativeTrackClone, this, [])); }, writable: false, configurable: false });
    define(MediaStream.prototype, 'clone', { value: function() { return owner.recordStream(apply(nativeStreamClone, this, [])); }, writable: false, configurable: false });
    for (const name of ['getUserMedia', 'webkitGetUserMedia', 'mozGetUserMedia']) {
      if (typeof navigator[name] === 'function') {
        const blocked = function() { throw new NativeError('Legacy capture is disabled', 'NotAllowedError'); };
        define(Object.getPrototypeOf(navigator), name, { value: blocked, writable: false, configurable: false });
        define(navigator, name, { value: blocked, writable: false, configurable: false });
      }
    }
    apply(listen, window, ['pagehide', () => { void api.stop(); }]);
    apply(listen, document, ['visibilitychange', () => { if (document.visibilityState === 'hidden') void api.stop(); }]);
  })();`;
}
const ReceiptSchema = z
  .object({
    documentId: z.uuid(),
    epoch: z.number().int().nonnegative(),
    tracks: z.number().int().nonnegative(),
    ended: z.number().int().nonnegative(),
    pending: z.number().int().nonnegative(),
  })
  .strict();
export type EduAudioReceipt = z.infer<typeof ReceiptSchema>;
const EvaluationSchema = z.object({ result: z.object({ value: z.unknown().optional() }), exceptionDetails: z.unknown().optional() });
export class EduAudioMonitor {
  private readonly key = '__wslEduAudio_' + randomUUID().replaceAll('-', '');
  private installed: Promise<void> | null = null;
  private documentId: string | null = null;
  constructor(private readonly send: (method: string, params?: Record<string, unknown>) => Promise<unknown>) {}
  install(): Promise<void> {
    return (this.installed ??= this.send('Page.enable')
      .then(() => this.send('Page.addScriptToEvaluateOnNewDocument', { source: eduAudioMonitorSource(this.key) }))
      .then(() => undefined));
  }
  private async call(method: 'activate' | 'stop'): Promise<EduAudioReceipt> {
    const result = EvaluationSchema.parse(
      await this.send('Runtime.evaluate', {
        expression: `this[${JSON.stringify(this.key)}].${method}()`,
        awaitPromise: true,
        returnByValue: true,
      }),
    );
    if (result.exceptionDetails) throw new Error('edu 音轨监视器执行失败：' + JSON.stringify(result.exceptionDetails));
    return ReceiptSchema.parse(result.result.value);
  }
  releaseDocument(): void {
    this.documentId = null;
  }
  async activate(): Promise<EduAudioReceipt> {
    const result = await this.call('activate');
    this.documentId = result.documentId;
    return result;
  }
  async stop(): Promise<EduAudioReceipt | null> {
    if (this.documentId === null) return null; // No capture can be authorized before activation.
    let deadline: ReturnType<typeof setTimeout> | undefined;
    // An unresolved OS prompt or disconnected debugger cannot hold navigation or
    // shutdown indefinitely. Expiry is failed proof; the controller destroys it.
    const expired = new Promise<never>((_resolve, reject) => {
      deadline = setTimeout(() => reject(new Error('edu 音轨清理截止时间已到，实际结束未确认')), 2000);
    });
    let result: EduAudioReceipt;
    try {
      result = await Promise.race([this.call('stop'), expired]);
    } finally {
      clearTimeout(deadline);
    }
    if (result.documentId !== this.documentId || result.pending !== 0 || result.tracks !== result.ended)
      throw new Error('edu 实际音轨结束未确认');
    return result;
  }
}
