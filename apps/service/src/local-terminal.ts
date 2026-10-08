import { spawn, type ChildProcessWithoutNullStreams } from 'node:child_process';
import { createInterface } from 'node:readline';
import { randomUUID } from 'node:crypto';
import { z } from 'zod';
import type { TerminalSnapshot } from '@wsl/protocol';
import { TerminalObservation, type TerminalResource } from './observation-terminal';
import helper from './local-terminal.py?raw';
import bashRc from './terminal-bash-integration.sh?raw';
import zshRc from './terminal-zsh-integration.sh?raw';

const FrameSchema = z.discriminatedUnion('type', [
  z.object({ type: z.literal('ready') }).strict(),
  z.object({ type: z.literal('output'), data: z.string().max(65536) }).strict(),
  z.object({ type: z.literal('exit'), exitCode: z.number().int() }).strict(),
  z.object({ type: z.literal('cleanup'), ok: z.boolean() }).strict(),
]);

/** Python stdlib PTY avoids Electron/native Node ABI coupling. No new daemon. */
export class LocalTerminal {
  observation: TerminalObservation | null = null;
  private child: ChildProcessWithoutNullStreams | null = null;
  private snapshot: TerminalSnapshot;
  private cleanupConfirmed = false;
  constructor(
    private readonly cwd: string,
    private readonly identity: TerminalResource,
    private readonly emit: (snapshot: TerminalSnapshot) => void,
  ) {
    this.snapshot = {
      seq: 0,
      sessionId: null,
      sandbox: null,
      cwd,
      state: 'idle',
      output: '',
      outputOffset: 0,
      cleanupPending: false,
      error: null,
    };
  }
  get() {
    return { ...this.snapshot };
  }
  private publish() {
    this.snapshot.seq++;
    this.emit(this.get());
  }
  async open(cols: number, rows: number) {
    if (this.snapshot.cleanupPending && !this.child) throw new Error('previous PTY cleanup unconfirmed');
    if (this.child) throw new Error('终端已打开');
    if (!Number.isInteger(cols) || !Number.isInteger(rows) || cols < 2 || cols > 500 || rows < 1 || rows > 300)
      throw new Error('invalid_range');
    this.cleanupConfirmed = false;
    const sessionId = randomUUID();
    const shell = process.platform === 'darwin' ? '/bin/zsh' : '/bin/bash';
    this.observation?.dispose();
    this.observation = new TerminalObservation(this.identity, sessionId, cols, rows);
    this.snapshot = { ...this.snapshot, sessionId, state: 'starting', output: '', outputOffset: 0, cleanupPending: true, error: null };
    const child = spawn('/usr/bin/python3', ['-u', '-c', helper], { cwd: this.cwd, stdio: ['pipe', 'pipe', 'pipe'] });
    this.child = child;
    child.stdin.on('error', () => {
      this.snapshot.error = 'PTY input transport closed';
      this.publish();
    });
    const lines = createInterface({ input: child.stdout });
    lines.on('line', (line) => {
      if (this.child !== child) return;
      try {
        const frame = FrameSchema.parse(JSON.parse(line));
        if (frame.type === 'ready' && this.snapshot.state === 'starting') this.snapshot.state = 'running';
        if (frame.type === 'cleanup') this.cleanupConfirmed = frame.ok;
        if (frame.type === 'output') {
          this.observation?.append(frame.data);
          const combined = this.snapshot.output + frame.data;
          this.snapshot.output = combined.slice(-262144);
          this.snapshot.outputOffset = (this.snapshot.outputOffset ?? 0) + combined.length - this.snapshot.output.length;
        }
        this.publish();
      } catch {
        this.snapshot.error = 'invalid PTY transport';
        this.publish();
      }
    });
    // Drain errors but do not expose arbitrary inherited paths or secrets as context.
    child.stderr.resume();
    child.once('error', () => {
      this.snapshot.error = 'local PTY helper unavailable';
      this.snapshot.state = 'failed';
      this.publish();
    });
    child.once('close', (code) => {
      if (this.child !== child) return;
      this.observation?.close();
      this.child = null;
      const confirmed = code === 0 && this.cleanupConfirmed;
      this.snapshot.state = confirmed ? 'closed' : 'failed';
      this.snapshot.cleanupPending = !confirmed;
      if (!confirmed) this.snapshot.error = 'local PTY helper exited without cleanup confirmation';
      this.publish();
    });
    child.stdin.write(
      JSON.stringify({ cwd: this.cwd, shell, cols, rows, rc: Buffer.from(shell.endsWith('zsh') ? zshRc : bashRc).toString('base64') }) +
        '\n',
    );
    this.publish();
    return this.get();
  }
  private target(sessionId: string) {
    if (sessionId !== this.snapshot.sessionId) throw new Error('stale_ref');
    if (!this.child || this.snapshot.state !== 'running') throw new Error('unavailable');
    return this.child;
  }
  write(sessionId: string, data: string) {
    if (Buffer.byteLength(data) > 65536) throw new Error('input too large');
    this.target(sessionId).stdin.write(JSON.stringify({ type: 'input', data }) + '\n');
  }
  resize(sessionId: string, cols: number, rows: number) {
    const child = this.target(sessionId);
    this.observation?.resize(cols, rows);
    child.stdin.write(JSON.stringify({ type: 'resize', cols, rows }) + '\n');
  }
  async close(sessionId: string) {
    if (sessionId !== this.snapshot.sessionId) throw new Error('stale_ref');
    if (!this.child) {
      if (this.snapshot.cleanupPending) throw new Error(this.snapshot.error ?? 'local PTY cleanup unconfirmed');
      return this.get();
    }
    const child = this.child;
    this.snapshot.state = 'closing';
    this.publish();
    child.stdin.write('{"type":"close"}\n');
    await new Promise<void>((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error('PTY cleanup timeout')), 5000);
      child.once('close', () => {
        clearTimeout(timer);
        resolve();
      });
    });
    if (this.snapshot.cleanupPending) throw new Error(this.snapshot.error ?? 'PTY cleanup unconfirmed');
    return this.get();
  }
  async shutdown() {
    try {
      if (this.snapshot.sessionId) await this.close(this.snapshot.sessionId);
    } finally {
      this.observation?.dispose();
    }
  }
}
