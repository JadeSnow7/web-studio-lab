import type { TerminalSnapshot } from '@wsl/protocol';
import type { SshObservationConnection, SshShell } from './observation-ssh';
import { TerminalObservation, type TerminalResource } from './observation-terminal';

/** SSH channel lifecycle is separate from the transport and from individual commands. */
export class SshTerminal {
  observation: TerminalObservation | null = null;
  private openToken = Symbol();
  private shell: SshShell | null = null;
  private opening: Promise<TerminalSnapshot> | null = null;
  private state: TerminalSnapshot = {
    seq: 0,
    sessionId: null,
    sandbox: 'ssh',
    cwd: null,
    state: 'idle',
    output: '',
    cleanupPending: false,
    error: null,
  };
  constructor(
    private readonly connection: Pick<SshObservationConnection, 'openShell' | 'available'>,
    private readonly identity: TerminalResource,
    private readonly emit: (state: TerminalSnapshot) => void,
  ) {}
  get() {
    return { ...this.state };
  }
  private publish() {
    this.state.seq++;
    this.emit(this.get());
    return this.get();
  }
  open(cols: number, rows: number) {
    if (this.opening) return Promise.reject(new Error('SSH terminal already opening'));
    const opening = this.start(cols, rows).finally(() => {
      if (this.opening === opening) this.opening = null;
    });
    this.opening = opening;
    return opening;
  }
  private async start(cols: number, rows: number) {
    if (this.shell || this.state.state === 'starting' || this.state.cleanupPending) throw new Error('SSH terminal already open');
    const token = (this.openToken = Symbol());
    this.state = { ...this.state, state: 'starting', output: '', outputOffset: 0, error: null, cleanupPending: true };
    this.publish();
    this.observation?.dispose();
    this.observation = null;
    let early = '';
    let ended = false;
    let shell: SshShell;
    try {
      shell = await this.connection.openShell(
        { cols, rows },
        {
          output: (data) => {
            if (token !== this.openToken) return;
            if (!this.observation) early = (early + data).slice(-262144);
            else this.observation.append(data);
            const combined = this.state.output + data;
            this.state.outputOffset = (this.state.outputOffset ?? 0) + Math.max(0, combined.length - 262144);
            this.state.output = combined.slice(-262144);
            this.publish();
          },
          closed: (result) => {
            if (token !== this.openToken) return;
            ended = true;
            this.observation?.close();
            this.shell = null;
            this.state.state = result.disconnected ? 'failed' : 'closed';
            this.state.cleanupPending = result.disconnected;
            this.state.error = result.disconnected ? 'Connection lost; remote process recovery is unknown' : null;
            this.publish();
          },
        },
      );
    } catch {
      if (token === this.openToken) {
        this.state.state = 'failed';
        this.state.cleanupPending = !this.connection.available;
        this.state.error = this.connection.available
          ? 'SSH shell could not be opened; server rejected channel'
          : 'SSH shell startup is unknown after connection loss';
        this.publish();
      }
      throw new Error(this.state.error ?? 'SSH shell could not be opened');
    }
    if (ended) throw new Error('SSH shell closed before initialization');
    this.shell = shell;
    this.observation = new TerminalObservation(this.identity, shell.sessionId, cols, rows);
    this.observation.append(early);
    this.state.sessionId = shell.sessionId;
    this.state.state = 'running';
    return this.publish();
  }
  private target(sessionId: string) {
    if (sessionId !== this.state.sessionId || !this.shell) throw new Error('stale terminal session');
    return this.shell;
  }
  write(sessionId: string, data: string) {
    this.target(sessionId).write(data);
  }
  resize(sessionId: string, cols: number, rows: number) {
    this.target(sessionId).resize(cols, rows);
    this.observation?.resize(cols, rows);
  }
  async close(sessionId: string) {
    if (sessionId !== this.state.sessionId) throw new Error('stale terminal session');
    if (!this.shell) {
      if (this.state.cleanupPending) throw new Error(this.state.error ?? 'Remote process cleanup is unknown');
      return this.get();
    }
    const target = this.target(sessionId);
    this.state.state = 'closing';
    this.publish();
    target.close();
    await new Promise<void>((resolve, reject) => {
      const started = Date.now();
      const timer = setInterval(() => {
        if (!this.shell) {
          clearInterval(timer);
          resolve();
        } else if (Date.now() - started > 3000) {
          clearInterval(timer);
          reject(new Error('SSH channel close unconfirmed'));
        }
      }, 25);
    });
    if (this.state.cleanupPending) throw new Error(this.state.error ?? 'Remote process cleanup is unknown');
    return this.get();
  }
  async shutdown() {
    try {
      if (this.opening) await this.opening;
      if (this.state.sessionId) await this.close(this.state.sessionId);
      else if (this.state.cleanupPending) throw new Error(this.state.error ?? 'Remote process cleanup is unknown');
    } finally {
      this.observation?.dispose();
    }
  }
}
