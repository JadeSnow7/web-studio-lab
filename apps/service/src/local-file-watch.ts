import { watch, type FSWatcher } from 'node:fs';
import { lstat, stat, realpath } from 'node:fs/promises';
import path from 'node:path';

type Change = 'change' | 'rename' | 'delete' | 'unknown' | 'root_replaced' | 'closed';
export class LocalFileWatch {
  watchGeneration = 1;
  private sequence = 0;
  private readonly originalRoot: string;
  private closed = false;
  private failed = false;
  private rootIdentity?: { dev: number; ino: number };
  private readonly watchers = new Map<string, FSWatcher>();
  private readonly identities = new Map<string, { dev: number; ino: number }>();
  private readonly pending = new Set<Change>();
  private readonly candidates = new Map<string, { event: string; filename: string | null }>();
  private flushing = false;
  private timer?: ReturnType<typeof setTimeout>;
  private queue = Promise.resolve();
  private lastHint?: { watchGeneration: number; sequence: number; capturedAt: string; change: Change };
  constructor(
    private root: string,
    private readonly onHint: (hint: NonNullable<LocalFileWatch['lastHint']>) => void,
    private readonly onRootReplaced: () => void,
    private readonly maxDirectories = 32,
  ) {
    this.originalRoot = root;
  }
  authorizeRoot(identity: { dev: number; ino: number }, canonical: string) {
    this.rootIdentity ??= identity;
    this.root = canonical;
  }
  status(directory?: string) {
    if (directory) {
      const canonicalRelative = path.relative(this.root, directory);
      if (canonicalRelative === '..' || canonicalRelative.startsWith('../') || path.isAbsolute(canonicalRelative)) {
        const originalRelative = path.relative(this.originalRoot, directory);
        if (originalRelative !== '..' && !originalRelative.startsWith('../') && !path.isAbsolute(originalRelative))
          directory = path.resolve(this.root, originalRelative);
      }
    }
    return {
      supported: true,
      state: this.closed ? 'closed' : this.failed ? 'partial' : this.watchers.size ? 'watching' : 'starting',
      watchGeneration: this.watchGeneration,
      watchedDirectories: this.watchers.size,
      maxDirectories: this.maxDirectories,
      scope: 'observed-directories',
      recursive: false,
      lossy: true,
      coverage: 'partial',
      ...(directory ? { watched: this.watchers.has(directory) } : {}),
      ...(this.lastHint ? { lastHint: this.lastHint } : {}),
    };
  }
  async observe(directory: string) {
    this.queue = this.queue.then(async () => {
      if (this.closed) return;
      if (!this.rootIdentity) this.root = await realpath(this.root).catch(() => this.root);
      directory = await realpath(directory).catch(() => directory);
      if (this.closed) return;
      if (!(await this.checkRoot())) return;
      for (const target of [this.root, directory]) {
        if (this.closed) return;
        if (this.watchers.has(target)) {
          const previous = this.identities.get(target);
          const current = await stat(target).catch(() => undefined);
          if (this.closed) return;
          if (current && previous?.dev === current.dev && previous.ino === current.ino) continue;
          this.watchers.get(target)?.close();
          this.watchers.delete(target);
          this.identities.delete(target);
          this.watchGeneration++;
          this.sequence = 0;
          this.schedule('unknown');
        }
        if (this.watchers.size >= this.maxDirectories) {
          this.failed = true;
          continue;
        }
        const relative = path.relative(this.root, target);
        if (relative === '..' || relative.startsWith('../') || path.isAbsolute(relative)) continue;
        try {
          const canonical = await realpath(target);
          if (canonical !== target) {
            this.failed = true;
            continue;
          }
          const identity = await stat(target);
          if (this.closed) return;
          const watcher = watch(target, { persistent: false, recursive: false }, (event, filename) => {
            // Coalesce before any asynchronous work: at most one candidate per
            // watched directory, even during an arbitrarily large event burst.
            this.candidates.set(target, { event, filename: filename === null ? null : String(filename).slice(0, 1024) });
            this.schedule(event === 'change' ? 'change' : 'rename');
          });
          watcher.on('error', () => {
            this.failed = true;
            watcher.close();
            this.watchers.delete(target);
            this.schedule('unknown');
          });
          this.watchers.set(target, watcher);
          this.identities.set(target, { dev: identity.dev, ino: identity.ino });
        } catch {
          this.failed = true;
        }
      }
      await this.checkRoot();
    });
    await this.queue;
  }
  async checkRoot() {
    if (this.closed) return false;
    let current;
    try {
      current = await stat(this.root);
    } catch {
      current = undefined;
    }
    if (this.closed) return false;
    if (!this.rootIdentity && current) this.rootIdentity = { dev: current.dev, ino: current.ino };
    if (!current || current.dev !== this.rootIdentity?.dev || current.ino !== this.rootIdentity?.ino) {
      this.onRootReplaced();
      this.emit('root_replaced');
      this.stop();
      return false;
    }
    return true;
  }
  private schedule(change: Change) {
    if (this.closed) return;
    this.pending.add(change);
    if (this.flushing) return;
    this.timer ??= setTimeout(() => {
      this.timer = undefined;
      void this.flush();
    }, 60);
    this.timer.unref();
  }
  private async flush() {
    if (this.flushing || this.closed) return;
    this.flushing = true;
    try {
      if (!(await this.checkRoot()) || this.closed) return;
      const candidates = [...this.candidates];
      this.candidates.clear();
      for (const [target, { filename }] of candidates) {
        if (!filename || path.basename(filename) !== filename) {
          this.pending.add('unknown');
          continue;
        }
        try {
          await lstat(path.join(target, filename));
        } catch (error) {
          if ((error as NodeJS.ErrnoException).code === 'ENOENT') this.pending.add('delete');
        }
      }
      const pending = [...this.pending];
      this.pending.clear();
      if (!this.closed) for (const change of pending) this.emit(change);
    } finally {
      this.flushing = false;
      if (this.candidates.size && !this.closed) this.schedule('unknown');
    }
  }
  private emit(change: Change) {
    this.lastHint = { watchGeneration: this.watchGeneration, sequence: ++this.sequence, capturedAt: new Date().toISOString(), change };
    this.onHint(this.lastHint);
  }
  private stop() {
    this.closed = true;
    if (this.timer) clearTimeout(this.timer);
    this.timer = undefined;
    this.pending.clear();
    this.candidates.clear();
    for (const watcher of this.watchers.values()) watcher.close();
    this.watchers.clear();
    this.identities.clear();
  }
  close() {
    if (!this.closed) {
      this.stop();
      this.emit('closed');
    }
  }
}
