import { createHash, randomUUID } from 'node:crypto';
import { Terminal as HeadlessTerminal } from '@xterm/headless';
import type { ResourceInstanceIdentity } from '@wsl/protocol';

/** Node's base64 decoder is permissive; shell metadata must be canonical UTF-8. */
function decodeShellMetadata(value: string | undefined): string | null {
  if (value === undefined || value.length > 16384 || !/^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/.test(value))
    return null;
  const bytes = Buffer.from(value, 'base64');
  if (bytes.toString('base64') !== value) return null;
  try {
    const text = new TextDecoder('utf-8', { fatal: true, ignoreBOM: true }).decode(bytes);
    return text.includes('\0') ? null : text;
  } catch {
    return null;
  }
}

export type TerminalResource = ResourceInstanceIdentity & { kind: 'terminal' };
export interface CommandRecord {
  commandId: string;
  command: string;
  cwd: string | null;
  startedAt: string;
  endedAt: string | null;
  status: 'running' | 'completed' | 'unknown';
  exitCode: number | null;
  startSeq: number;
  endSeq: number | null;
  source: 'shell_integration';
  commandCoverage: 'first_simple_command' | 'full_input';
}
interface OutputRecord {
  seq: number;
  capturedAt: string;
  data: string;
  cols: number;
  rows: number;
  kind: 'output' | 'resize';
  droppedChars: number;
}

/** One observer per actual PTY; the UI and observer receive the identical VT stream.
 * Headless never sends query replies: the attached human terminal remains the responder.
 */
export class TerminalObservation {
  readonly generation = randomUUID();
  readonly capabilities = ['read_screen', 'read_output', 'read_command'];
  private readonly vt: HeadlessTerminal;
  private output: OutputRecord[] = [];
  private outputChars = 0;
  private seq = 0;
  private processedSeq = 0;
  private pending = Promise.resolve();
  private pendingChars = 0;
  private parserGap = false;
  private droppedChars = 0;
  private closed = false;
  private disposed = false;
  private commands: CommandRecord[] = [];
  private current: CommandRecord | null = null;
  private cwd: string | null = null;
  private commandsSeen = 0;
  private revision = 0;
  private dimensions: { cols: number; rows: number };
  constructor(
    readonly resource: TerminalResource,
    readonly sessionId: string,
    cols: number,
    rows: number,
    private readonly maxOutputChars = 262144,
  ) {
    this.resource = Object.freeze({ ...resource });
    this.dimensions = { cols, rows };
    this.vt = new HeadlessTerminal({ cols, rows, scrollback: 5000, allowProposedApi: true });
    // Application OSC from our per-session bash rc. Metadata is self-reported data,
    // never an authorization source; any process writing the PTY can imitate it.
    this.vt.parser.registerOscHandler(777, (payload) => {
      const fields = payload.split(';');
      const [tag, kind, value, directory] = fields;
      if (tag !== 'wsl') return false;
      const invalidate = () => {
        if (this.current) this.current.status = 'unknown';
        this.current = null;
      };
      if (kind === 'start' || kind === 'start_full') {
        const command = decodeShellMetadata(value);
        const cwd = directory === undefined ? null : decodeShellMetadata(directory);
        if (fields.length !== 4 || !command || cwd === null) {
          invalidate();
          return true;
        }
        invalidate();
        this.cwd = cwd;
        this.current = {
          commandId: randomUUID(),
          command,
          cwd: this.cwd,
          startedAt: new Date().toISOString(),
          endedAt: null,
          status: 'running',
          exitCode: null,
          startSeq: this.processedSeq + 1,
          endSeq: null,
          source: 'shell_integration',
          commandCoverage: kind === 'start_full' ? 'full_input' : 'first_simple_command',
        };
        this.commands.push(this.current);
        this.commandsSeen++;
        if (this.commands.length > 200) this.commands.shift();
      } else if (kind === 'end') {
        if (fields.length !== 3 || !/^(0|[1-9]\d{0,2})$/.test(value ?? '') || Number(value) > 255) {
          invalidate();
          return true;
        }
        if (!this.current) return true;
        this.current.exitCode = Number(value);
        this.current.status = 'completed';
        this.current.endedAt = new Date().toISOString();
        this.current.endSeq = this.processedSeq + 1;
        this.current = null;
      }
      return true;
    });
  }
  append(data: string): void {
    if (this.closed || !data) return;
    const seq = ++this.seq;
    this.revision++;
    // Retain whole bounded chunks, including an explicitly observable head gap.
    const bounded = data.slice(-this.maxOutputChars);
    this.droppedChars += data.length - bounded.length;
    this.output.push({
      seq,
      capturedAt: new Date().toISOString(),
      data: bounded,
      cols: this.dimensions.cols,
      rows: this.dimensions.rows,
      kind: 'output',
      droppedChars: data.length - bounded.length,
    });
    this.outputChars += bounded.length;
    while ((this.outputChars > this.maxOutputChars || this.output.length > 8192) && this.output.length > 1) {
      const removed = this.output.shift()!;
      this.outputChars -= removed.data.length;
      this.droppedChars += removed.data.length;
    }
    if (this.pendingChars + data.length > 1048576) {
      // Bounded failure instead of claiming that a screen with dropped VT is correct.
      this.parserGap = true;
      return;
    }
    if (this.parserGap) return;
    this.pendingChars += data.length;
    this.pending = this.pending.then(
      () =>
        new Promise<void>((resolve) => {
          this.vt.write(data, () => {
            this.processedSeq = seq;
            this.pendingChars -= data.length;
            resolve();
          });
        }),
    );
  }
  resize(cols: number, rows: number): void {
    this.assertAvailable();
    if (!Number.isInteger(cols) || !Number.isInteger(rows) || cols < 2 || cols > 500 || rows < 1 || rows > 300)
      throw new Error('invalid_range');
    this.revision++;
    const seq = ++this.seq;
    this.dimensions = { cols, rows };
    this.output.push({ seq, capturedAt: new Date().toISOString(), data: '', cols, rows, kind: 'resize', droppedChars: 0 });
    if (this.output.length > 8192) {
      const removed = this.output.shift()!;
      this.outputChars -= removed.data.length;
      this.droppedChars += removed.data.length;
    }
    this.pending = this.pending.then(() => {
      this.vt.resize(cols, rows);
      this.processedSeq = seq;
    });
  }
  close(): void {
    this.closed = true;
    this.revision++;
    this.pending = this.pending.then(() => {
      if (this.current) {
        this.current.status = 'unknown';
        this.current.endedAt = new Date().toISOString();
      }
    });
  }
  dispose(): void {
    if (this.disposed) return;
    this.close();
    this.disposed = true;
    void this.pending.then(() => this.vt.dispose());
  }
  private assertAvailable() {
    if (this.disposed) throw new Error('unavailable: terminal observer disposed');
  }
  private observation(
    source: string,
    data: Record<string, unknown>,
    status: 'complete' | 'partial' | 'unknown',
    range: Record<string, unknown>,
    reasons: string[] = [],
    nextCursor?: string,
  ) {
    this.assertAvailable();
    const snapshotId = randomUUID();
    return {
      resource: this.resource,
      generation: this.generation,
      revision: { value: String(this.revision), strength: 'sequence' as const },
      snapshotId,
      capturedAt: new Date().toISOString(),
      source,
      representation: source,
      coverage: { status, range, reasons },
      data,
      ...(nextCursor ? { nextCursor } : {}),
    };
  }
  async readScreen(options: { viewportY?: number; maxLines?: number } = {}) {
    this.assertAvailable();
    let timer: ReturnType<typeof setTimeout> | undefined;
    try {
      await Promise.race([
        this.pending,
        new Promise<never>((_, reject) => {
          timer = setTimeout(() => reject(new Error('temporarily_unavailable')), 3000);
        }),
      ]);
    } finally {
      clearTimeout(timer);
    }
    this.assertAvailable();
    if (this.parserGap) throw new Error('gap: terminal parser backlog overflow; reopen session');
    const buffer = this.vt.buffer.active;
    const start = options.viewportY ?? buffer.baseY;
    if (!Number.isInteger(start) || start < 0 || start >= buffer.length) throw new Error('gap: viewport outside retained buffer');
    const count = Math.min(this.vt.rows, Math.max(1, options.maxLines ?? this.vt.rows));
    const lines = Array.from({ length: Math.min(count, buffer.length - start) }, (_, index) => {
      const line = buffer.getLine(start + index)!;
      return { line: start + index, text: line.translateToString(true), wrapped: line.isWrapped };
    });
    const result = this.observation(
      'terminal_screen',
      {
        sessionId: this.sessionId,
        buffer: buffer.type,
        cols: this.vt.cols,
        rows: this.vt.rows,
        cursor: { x: buffer.cursorX, y: buffer.cursorY },
        baseY: buffer.baseY,
        viewportY: start,
        processedSeq: this.processedSeq,
        receivedSeq: this.seq,
        closed: this.closed,
        lines,
        queryResponder: 'renderer',
      },
      count < this.vt.rows ? 'partial' : 'complete',
      { startLine: start, lines: lines.length, scope: options.viewportY === undefined ? 'latest_screen' : 'requested_scrollback_viewport' },
      ['Coverage is retained rendered cells only; a UI viewport must be explicitly supplied, not inferred.'],
    );
    result.revision.value = String(this.processedSeq);
    return result;
  }
  readOutput(options: { cursor?: string; maxChars?: number } = {}) {
    this.assertAvailable();
    const maxChars = Math.min(65536, Math.max(1, options.maxChars ?? 16384));
    const first = this.output[0]?.seq ?? this.seq + 1;
    let seq = first;
    let offset = 0;
    if (options.cursor) {
      let cursor;
      try {
        cursor = JSON.parse(Buffer.from(options.cursor, 'base64url').toString('utf8'));
      } catch {
        throw new Error('stale_cursor');
      }
      if (cursor.binding !== this.binding() || cursor.generation !== this.generation || cursor.source !== 'terminal_output')
        throw new Error('stale_cursor');
      seq = cursor.seq;
      offset = cursor.offset;
      if (!Number.isInteger(seq) || !Number.isInteger(offset) || offset < 0 || seq > this.seq + 1) throw new Error('stale_cursor');
      if (seq === this.seq + 1 && offset !== 0) throw new Error('stale_cursor');
      if (seq < first) throw new Error('gap: output cursor evicted');
    }
    const records: OutputRecord[] = [];
    let chars = 0;
    for (const record of this.output.filter((item) => item.seq >= seq)) {
      if (offset > record.data.length) throw new Error('stale_cursor');
      const piece = record.data.slice(offset, offset + maxChars - chars);
      records.push({ ...record, data: piece });
      chars += piece.length;
      offset += piece.length;
      seq = record.seq;
      if (offset === record.data.length) {
        seq++;
        offset = 0;
      }
      if (chars === maxChars) break;
    }
    const nextCursor = Buffer.from(
      JSON.stringify({ binding: this.binding(), generation: this.generation, source: 'terminal_output', seq, offset }),
    ).toString('base64url');
    const partial = seq <= this.seq || first > 1 || this.droppedChars > 0;
    return this.observation(
      'terminal_output',
      {
        sessionId: this.sessionId,
        records,
        firstAvailableSeq: first,
        droppedChars: this.droppedChars,
        latestSeq: this.seq,
        stream: 'pty_combined',
      },
      partial ? 'partial' : 'complete',
      { maxChars, returnedChars: chars, retainedFromSeq: first },
      [
        ...(first > 1 || this.droppedChars > 0 ? ['Earlier output evicted; chunk droppedChars describes partial records.'] : []),
        ...(seq <= this.seq ? ['Result limit; continue with cursor.'] : []),
      ],
      nextCursor,
    );
  }
  async readCommand(options: { commandId?: string; limit?: number } = {}) {
    await this.readScreen({ maxLines: 1 });
    const records = options.commandId
      ? this.commands.filter((item) => item.commandId === options.commandId)
      : this.commands.slice(-Math.min(100, Math.max(1, options.limit ?? 20)));
    if (options.commandId && !records.length) throw new Error('not_found: command absent or evicted');
    return this.observation(
      'terminal_commands',
      {
        sessionId: this.sessionId,
        commands: structuredClone(records).map((record) => ({
          ...record,
          command: record.command.slice(0, 2000),
          commandTruncated: record.command.length > 2000,
        })),
        integration: this.commandsSeen ? 'observed' : 'not_observed',
      },
      this.commandsSeen ? 'partial' : 'unknown',
      { retained: this.commands.length, totalSeen: this.commandsSeen },
      [
        'Shell integration is self-reported, captures first simple command and foreground prompt status; background attribution and full compound command text are unknown. PTY exit is not command exit.',
      ],
    );
  }
  private binding() {
    return createHash('sha256').update(JSON.stringify(this.resource)).digest('hex');
  }
}
