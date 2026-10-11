import { randomUUID } from 'node:crypto';
import type { TerminalSnapshot } from '@wsl/protocol';
import { TerminalObservation, type TerminalResource } from './observation-terminal';
import type { SbxConnection, GuestProcess } from './sbx';

export class Terminal {
  observation: TerminalObservation | null = null;
  private snapshot: TerminalSnapshot = {
    seq: 0,
    sessionId: null,
    sandbox: null,
    cwd: null,
    state: 'idle',
    output: '',
    outputOffset: 0,
    cleanupPending: false,
    error: null,
  };
  private active: GuestProcess | null = null;
  private closing = false;
  constructor(
    private readonly connection: SbxConnection,
    private readonly identity: TerminalResource,
    private readonly emit: (snapshot: TerminalSnapshot) => void,
  ) {}
  get(): TerminalSnapshot {
    const status = this.connection.getStatus();
    return { ...this.snapshot, sandbox: status.sandbox, cwd: status.cwd };
  }
  private publish() {
    this.snapshot.seq++;
    const snapshot = this.get();
    this.emit(snapshot);
    return snapshot;
  }
  async open(cols: number, rows: number): Promise<TerminalSnapshot> {
    if (this.closing) throw new Error('终端服务正在关闭');
    if (this.active) throw new Error(this.snapshot.error ?? '终端会话已打开');
    const status = this.connection.getStatus();
    if (!status.available) {
      this.snapshot.state = 'failed';
      this.snapshot.error = status.reason;
      this.publish();
      throw new Error(status.reason ?? 'sbx 不可用');
    }
    this.snapshot = {
      ...this.get(),
      sessionId: randomUUID(),
      state: 'starting',
      output: '',
      outputOffset: 0,
      cleanupPending: true,
      error: null,
    };
    this.observation?.dispose();
    this.observation = new TerminalObservation(this.identity, this.snapshot.sessionId!, cols, rows);
    this.publish();
    this.active = this.connection.start({ type: 'start', mode: 'terminal', cols, rows }, (frame) => {
      if (frame.type === 'ready' && this.snapshot.state === 'starting') this.snapshot.state = 'running';
      if (frame.type === 'cleanup') this.snapshot.cleanupPending = !frame.ok;
      if (frame.type === 'output') {
        this.observation?.append(frame.data);
        const combined = this.snapshot.output + frame.data;
        this.snapshot.output = combined.slice(-262144);
        this.snapshot.outputOffset = (this.snapshot.outputOffset ?? 0) + combined.length - this.snapshot.output.length;
      }
      if (frame.type === 'error') {
        this.snapshot.error = frame.error;
        this.snapshot.state = 'failed';
      }
      this.publish();
    });
    const active = this.active;
    void active.done.then((outcome) => {
      if (this.active !== active) return;
      this.observation?.close();
      this.snapshot.cleanupPending = !outcome.confirmed;
      if (outcome.confirmed) this.active = null;
      const wasClosing = this.snapshot.state === 'closing';
      this.snapshot.error = outcome.error ?? (!wasClosing && outcome.exitCode !== 0 ? `终端退出失败（${outcome.exitCode}）` : null);
      this.snapshot.state = this.snapshot.error ? 'failed' : 'closed';
      this.publish();
    });
    return this.get();
  }
  private target(sessionId: string): GuestProcess {
    if (this.snapshot.sessionId !== sessionId) throw new Error('终端会话身份已过期');
    if (!this.active || this.snapshot.state !== 'running') throw new Error(this.snapshot.error ?? '终端未运行');
    return this.active;
  }
  write(sessionId: string, data: string): void {
    this.target(sessionId).write({ type: 'input', data });
  }
  resize(sessionId: string, cols: number, rows: number): void {
    this.target(sessionId).write({ type: 'resize', cols, rows });
    this.observation?.resize(cols, rows);
  }
  async close(sessionId: string): Promise<TerminalSnapshot> {
    if (this.snapshot.sessionId !== sessionId) throw new Error('终端会话身份已过期');
    if (!this.active) return this.get();
    if (this.snapshot.state === 'failed') throw new Error(this.snapshot.error ?? 'guest 清理未确认');
    this.snapshot.state = 'closing';
    this.publish();
    const outcome = await this.active.close();
    if (outcome.error || !outcome.confirmed) throw new Error(outcome.error ?? 'guest 清理未确认');
    return this.get();
  }
  async shutdown(): Promise<void> {
    this.closing = true;
    if (this.active && this.snapshot.sessionId) await this.close(this.snapshot.sessionId);
    this.observation?.dispose();
  }
}
