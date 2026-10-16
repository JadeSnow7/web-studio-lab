import { createHash, randomUUID } from 'node:crypto';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { MOTA_REQUIRED_FILES, motaSourceIdentityInput } from '@wsl/protocol';
import {
  MOTA_TRANSFER_CHUNK_BYTES,
  MOTA_TRANSFER_PREFIX,
  transferMotaSource,
  type MotaTransferConnection,
  type MotaTransferInput,
  type MotaTransferRequest,
} from './mota-transfer';
import type { GuestFrame, GuestOutcome, GuestStart } from './sbx';

const hash = (data: Buffer | string) => createHash('sha256').update(data).digest('hex');
const clean: GuestOutcome = { confirmed: true, error: null, exitCode: 0 };
function request(large = false): MotaTransferRequest {
  const files = MOTA_REQUIRED_FILES.map((name) => ({ path: name, base64: Buffer.from(name).toString('base64') }));
  // A real >1 MiB payload would exceed GuestStart's limit if sent as one prompt.
  if (large) files.push({ path: 'project/images/synthetic.png', base64: Buffer.alloc(2 * 1024 * 1024 + 7, 37).toString('base64') });
  files.push({ path: 'project/empty.animate', base64: '' });
  const metadata = files.map((file) => {
    const bytes = Buffer.from(file.base64, 'base64');
    return { path: file.path, sha256: hash(bytes), bytes: bytes.length };
  });
  return {
    workspaceId: 'synthetic-transfer',
    projectId: randomUUID(),
    importOperationId: randomUUID(),
    files,
    source: { files: metadata, sourceSha256: hash(motaSourceIdentityInput(metadata)) },
  };
}
function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((done) => {
    resolve = done;
  });
  return { promise, resolve };
}
type Reply = Record<string, unknown>;
type ReceiverOptions = {
  hold?: MotaTransferInput['type'];
  eof?: MotaTransferInput['type'];
  reply?: (input: MotaTransferInput, reply: Reply) => Reply | string;
  duplicate?: boolean;
  stderrOverflow?: boolean;
  outcome?: GuestOutcome;
  closePending?: boolean;
  closeRejects?: boolean;
  afterReceipt?: () => void;
};
/** Independent byte accumulator; it neither trusts the declared file hash nor skips to a receipt. */
function receiver(options: ReceiverOptions = {}) {
  const starts: GuestStart[] = [];
  const inputs: MotaTransferInput[] = [];
  const inputLengths: number[] = [];
  const written = new Map<string, Buffer>();
  const done = deferred<GuestOutcome>();
  let emit: (frame: GuestFrame) => void = () => {
    throw new Error('receiver not started');
  };
  let release: (() => void) | null = null;
  let heldOnce = false;
  let closeCalls = 0;
  let inputClosed = false;
  let sequence = 0;
  let current: { index: number; path: string; bytes: number; sha256: string; chunks: Buffer[]; offset: number } | null = null;
  let expectedBinding: MotaTransferInput['binding'] | undefined;
  const consume = (line: string) => {
    const input = JSON.parse(line) as MotaTransferInput;
    inputLengths.push(Buffer.byteLength(line));
    inputs.push(input);
    expect(input.seq).toBe(sequence++);
    expectedBinding ??= input.binding;
    expect(input.binding).toEqual(expectedBinding);
    if (options.eof === input.type) {
      done.resolve({ ...clean, exitCode: 1 });
      return;
    }
    let reply: Reply = {
      type: 'ack',
      binding: input.binding,
      seq: input.seq,
      operation: input.type,
      fileIndex: null,
      offset: 0,
      sha256: null,
    };
    if (input.type === 'file') {
      expect(current).toBeNull();
      expect(input.fileIndex).toBe(written.size);
      current = { index: input.fileIndex, path: input.path, bytes: input.bytes, sha256: input.sha256, chunks: [], offset: 0 };
      reply = { ...reply, fileIndex: input.fileIndex, sha256: input.sha256 };
    } else if (input.type === 'chunk') {
      if (!current) throw new Error('chunk before file declaration');
      expect(input.fileIndex).toBe(current.index);
      expect(input.offset).toBe(current.offset);
      const bytes = Buffer.from(input.base64, 'base64');
      expect(bytes.length).toBeGreaterThan(0);
      expect(bytes.length).toBeLessThanOrEqual(MOTA_TRANSFER_CHUNK_BYTES);
      current.chunks.push(bytes);
      current.offset += bytes.length;
      expect(current.offset).toBeLessThanOrEqual(current.bytes);
      reply = { ...reply, fileIndex: input.fileIndex, offset: current.offset };
    } else if (input.type === 'file-end') {
      if (!current) throw new Error('end before file declaration');
      const bytes = Buffer.concat(current.chunks);
      expect(input.fileIndex).toBe(current.index);
      expect(bytes.length).toBe(current.bytes);
      expect(bytes.length).toBe(input.bytes);
      expect(hash(bytes)).toBe(input.sha256);
      expect(hash(bytes)).toBe(current.sha256);
      written.set(current.path, bytes);
      current = null;
      reply = { ...reply, fileIndex: input.fileIndex, offset: input.bytes, sha256: input.sha256 };
    } else if (input.type === 'finish') {
      expect(current).toBeNull();
      const metadata = [...written].map(([name, bytes]) => ({ path: name, bytes: bytes.length, sha256: hash(bytes) }));
      const sourceSha256 = hash(motaSourceIdentityInput(metadata));
      expect(written.size).toBe(input.fileCount);
      expect(metadata.reduce((sum, file) => sum + file.bytes, 0)).toBe(input.totalBytes);
      expect(sourceSha256).toBe(input.sourceSha256);
      expect(sourceSha256).toBe(input.binding.sourceSha256);
      reply = {
        type: 'receipt',
        binding: input.binding,
        seq: input.seq,
        outcome: 'imported',
        fileCount: written.size,
        totalBytes: input.totalBytes,
        sourceSha256,
      };
    }
    const respond = () => {
      if (options.stderrOverflow && input.type === 'chunk') {
        emit({ type: 'output', stream: 'stderr', data: 'private-output'.repeat(6000) });
        return;
      }
      const transformed = options.reply?.(input, reply) ?? reply;
      const text = typeof transformed === 'string' ? transformed : MOTA_TRANSFER_PREFIX + JSON.stringify(transformed) + '\n';
      // Every ordinary reply crosses an arbitrary transport fragment boundary.
      emit({ type: 'output', stream: 'stdout', data: text.slice(0, 17) });
      emit({ type: 'output', stream: 'stdout', data: text.slice(17) });
      if (options.duplicate && input.type === 'chunk') emit({ type: 'output', stream: 'stdout', data: text });
      if (input.type === 'finish') options.afterReceipt?.();
    };
    if (!heldOnce && options.hold === input.type) {
      heldOnce = true;
      release = respond;
    } else queueMicrotask(respond);
  };
  const connection: MotaTransferConnection = {
    start(start, onFrame) {
      starts.push(start);
      emit = onFrame;
      if (start.mode !== 'codex' || !start.duplex || !start.prompt) throw new Error('expected duplex Mota startup');
      expect(start.argv.slice(0, 4)).toEqual(['python3', '-I', '-u', '-c']);
      expect(Object.keys(JSON.parse(start.prompt)).sort()).toEqual(['binding', 'fileCount', 'seq', 'totalBytes', 'type']);
      consume(start.prompt);
      return {
        done: done.promise,
        write(frame) {
          if (frame.type !== 'input') throw new Error('only chunk protocol input is expected');
          expect(inputClosed).toBe(false);
          consume(frame.data);
        },
        closeInput() {
          inputClosed = true;
          done.resolve(options.outcome ?? clean);
        },
        close() {
          closeCalls++;
          if (options.closeRejects) return Promise.reject(new Error('synthetic private transport detail'));
          if (options.closePending) return new Promise<GuestOutcome>(() => {});
          const outcome = options.outcome ?? clean;
          done.resolve(outcome);
          return Promise.resolve(outcome);
        },
      };
    },
  };
  return {
    connection,
    starts,
    inputs,
    inputLengths,
    written,
    closeCalls: () => closeCalls,
    held: () => release !== null,
    release() {
      const callback = release;
      release = null;
      if (!callback) throw new Error('no held reply');
      callback();
    },
  };
}

afterEach(() => {
  vi.useRealTimers();
});

describe('Mota stop-and-wait source transfer', () => {
  it('transfers a payload larger than the start-frame limit with one bounded chunk in flight', async () => {
    const source = request(true);
    const guest = receiver({ hold: 'chunk' });
    const transfer = transferMotaSource(guest.connection, source, { helper: '# synthetic ingest' });
    await vi.waitFor(() => expect(guest.held()).toBe(true));
    const count = guest.inputs.length;
    await Promise.resolve();
    await Promise.resolve();
    expect(guest.inputs.length).toBe(count);
    expect(guest.inputs.at(-1)?.type).toBe('chunk');
    guest.release();
    const result = await transfer;
    expect(result).toMatchObject({
      ok: true,
      cleanupConfirmed: true,
      errorCode: null,
      receipt: { sourceSha256: source.source.sourceSha256, fileCount: source.files.length },
    });
    expect(Buffer.byteLength(JSON.stringify(source))).toBeGreaterThan(1024 * 1024);
    expect(Buffer.byteLength(JSON.stringify(guest.starts[0]))).toBeLessThan(4096);
    expect(Math.max(...guest.inputLengths)).toBeLessThan(65536);
    for (const file of source.files) {
      // Native byte equality keeps the complete multi-MiB assertion without a JS property walk.
      expect(guest.written.get(file.path)?.equals(Buffer.from(file.base64, 'base64'))).toBe(true);
    }
    expect(guest.inputs.filter((frame) => frame.type === 'chunk').length).toBeGreaterThan(64);
    expect(guest.closeCalls()).toBe(0);
  });

  it.each([
    'binding',
    'sequence',
    'offset',
    'hash',
    'operation',
    'unknown-field',
    'duplicate',
    'non-json',
    'prefix',
    'oversized',
    'stderr',
  ] as const)('stops sending and closes the owned worker after an invalid %s reply', async (kind) => {
    const source = request();
    const guest = receiver({
      duplicate: kind === 'duplicate',
      stderrOverflow: kind === 'stderr',
      reply(input, reply) {
        if (input.type !== 'chunk') return reply;
        if (kind === 'binding') return { ...reply, binding: { ...input.binding, importOperationId: randomUUID() } };
        if (kind === 'sequence') return { ...reply, seq: input.seq + 1 };
        if (kind === 'offset') return { ...reply, offset: Number(reply.offset) + 1 };
        if (kind === 'hash') return { ...reply, sha256: 'a'.repeat(64) };
        if (kind === 'operation') return { ...reply, operation: 'file' };
        if (kind === 'unknown-field') return { ...reply, ignored: true };
        if (kind === 'non-json') return MOTA_TRANSFER_PREFIX + '{\n';
        if (kind === 'prefix') return 'unframed helper output\n';
        if (kind === 'oversized') return 'x'.repeat(8193) + '\n';
        return reply;
      },
    });
    const result = await transferMotaSource(guest.connection, source, { helper: '# synthetic ingest' });
    expect(result.ok).toBe(false);
    expect(result.cleanupConfirmed).toBe(true);
    expect(result.receipt).toBeNull();
    expect(guest.closeCalls()).toBe(1);
    expect(guest.inputs.at(-1)?.type).toBe('chunk');
    expect(guest.inputs.some((frame) => frame.type === 'finish')).toBe(false);
    expect(JSON.stringify(result)).not.toContain('private-output');
    if (kind === 'binding') expect(result.errorCode).toBe('mota_transfer_binding_mismatch');
    if (kind === 'oversized' || kind === 'stderr') expect(result.errorCode).toBe('mota_transfer_budget_exceeded');
  });

  it('rejects a finish receipt whose source digest does not match the accumulated source', async () => {
    const guest = receiver({ reply: (input, reply) => (input.type === 'finish' ? { ...reply, sourceSha256: '0'.repeat(64) } : reply) });
    const result = await transferMotaSource(guest.connection, request(), { helper: '# synthetic ingest' });
    expect(result).toMatchObject({ ok: false, cleanupConfirmed: true, receipt: null, errorCode: 'mota_transfer_unexpected_reply' });
    expect(guest.closeCalls()).toBe(1);
  });

  it.each(['ack', 'total', 'cleanup'] as const)('bounds the %s wait without sending another frame', async (kind) => {
    vi.useFakeTimers();
    const guest = receiver({ hold: 'begin', closePending: kind === 'cleanup' });
    const transfer = transferMotaSource(guest.connection, request(), {
      helper: '# synthetic ingest',
      ackTimeoutMs: kind === 'total' ? 100 : 20,
      totalTimeoutMs: kind === 'total' ? 20 : 1000,
      cleanupTimeoutMs: 30,
    });
    await vi.advanceTimersByTimeAsync(60);
    const result = await transfer;
    expect(result).toMatchObject({
      ok: false,
      cleanupConfirmed: kind !== 'cleanup',
      receipt: null,
      errorCode: kind === 'total' ? 'mota_transfer_total_timeout' : 'mota_transfer_ack_timeout',
    });
    expect(guest.inputs).toHaveLength(1);
    expect(guest.closeCalls()).toBe(1);
  });

  it.each(['before', 'chunk', 'receipt'] as const)('preserves publication facts when cancellation occurs at %s', async (stage) => {
    const controller = new AbortController();
    const guest = receiver({
      hold: stage === 'chunk' ? 'chunk' : undefined,
      afterReceipt: stage === 'receipt' ? () => controller.abort() : undefined,
    });
    if (stage === 'before') controller.abort();
    const transfer = transferMotaSource(guest.connection, request(), { helper: '# synthetic ingest', signal: controller.signal });
    if (stage === 'chunk') {
      await vi.waitFor(() => expect(guest.held()).toBe(true));
      controller.abort();
    }
    const result = await transfer;
    expect(result).toMatchObject({ ok: false, cleanupConfirmed: true, errorCode: 'mota_transfer_cancelled' });
    if (stage === 'receipt') expect(result.receipt?.outcome).toBe('imported');
    else expect(result.receipt).toBeNull();
    expect(guest.starts).toHaveLength(stage === 'before' ? 0 : 1);
    expect(guest.closeCalls()).toBe(stage === 'before' ? 0 : 1);
  });

  it('treats EOF before the expected ACK as failure even when the controller confirms cleanup', async () => {
    const guest = receiver({ eof: 'chunk' });
    const result = await transferMotaSource(guest.connection, request(), { helper: '# synthetic ingest' });
    expect(result).toMatchObject({ ok: false, cleanupConfirmed: true, receipt: null, errorCode: 'mota_transfer_eof' });
    expect(guest.inputs.at(-1)?.type).toBe('chunk');
  });

  it.each(['unknown-cleanup', 'nonzero-exit'] as const)('does not promote a valid receipt to success after %s', async (kind) => {
    const guest = receiver({
      outcome: kind === 'unknown-cleanup' ? { confirmed: false, error: 'unconfirmed', exitCode: null } : { ...clean, exitCode: 1 },
    });
    const result = await transferMotaSource(guest.connection, request(), { helper: '# synthetic ingest' });
    expect(result).toMatchObject({ ok: false, cleanupConfirmed: kind !== 'unknown-cleanup', receipt: { outcome: 'imported' } });
    expect(guest.closeCalls()).toBe(1);
  });

  it('reports unknown cleanup when the transport close rejects without leaking its detail', async () => {
    const guest = receiver({ closeRejects: true, reply: (input, reply) => (input.type === 'chunk' ? { ...reply, offset: -1 } : reply) });
    const result = await transferMotaSource(guest.connection, request(), { helper: '# synthetic ingest' });
    expect(result).toMatchObject({ ok: false, cleanupConfirmed: false, receipt: null, errorCode: 'mota_transfer_invalid_reply' });
    expect(JSON.stringify(result)).not.toContain('synthetic private');
  });

  it.each(['file-hash', 'manifest-hash', 'missing', 'duplicate', 'file-budget'] as const)(
    'rejects invalid %s before acquiring a guest writer',
    async (kind) => {
      const source = request();
      if (kind === 'file-hash') source.source.files[0]!.sha256 = '0'.repeat(64);
      if (kind === 'manifest-hash') source.source.sourceSha256 = '0'.repeat(64);
      if (kind === 'missing') source.files.pop();
      if (kind === 'duplicate') source.files.push({ ...source.files[0]! });
      if (kind === 'file-budget') source.files = Array.from({ length: 513 }, () => ({ ...source.files[0]! }));
      const guest = receiver();
      expect(await transferMotaSource(guest.connection, source, { helper: '# synthetic ingest' })).toEqual({
        ok: false,
        cleanupConfirmed: true,
        receipt: null,
        errorCode: 'mota_transfer_invalid_source',
      });
      expect(guest.starts).toEqual([]);
    },
  );

  it('checks the actual serialized start budget before spawning a helper', async () => {
    const guest = receiver();
    expect(await transferMotaSource(guest.connection, request(), { helper: '#'.repeat(1024 * 1024) })).toEqual({
      ok: false,
      cleanupConfirmed: true,
      receipt: null,
      errorCode: 'mota_transfer_budget_exceeded',
    });
    expect(guest.starts).toEqual([]);
  });
});
