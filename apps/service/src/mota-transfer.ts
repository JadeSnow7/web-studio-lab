import { createHash } from 'node:crypto';
import { z } from 'zod';
import { MotaImportSchema, motaSourceIdentityInput, type MotaImport } from '@wsl/protocol';
import type { GuestFrame, GuestOutcome, GuestProcess, GuestStart } from './sbx';

export const MOTA_TRANSFER_PREFIX = 'WSL_MOTA_TRANSFER:';
export const MOTA_TRANSFER_CHUNK_BYTES = 32 * 1024;
const INPUT_LIMIT = 64 * 1024;
const START_LIMIT = 1024 * 1024;
const FRAME_LIMIT = 4096;
const INPUT_BUDGET = 96 * 1024 * 1024;
const OUTPUT_LINE_LIMIT = 8192;
const OUTPUT_BUDGET = 16 * 1024 * 1024;
const STDERR_BUDGET = 64 * 1024;
const sha256 = z.string().regex(/^[a-f0-9]{64}$/);
const targetSchema = z
  .object({
    workspaceId: z.string().min(1).max(200),
    projectId: z.uuid(),
    importOperationId: z.uuid(),
  })
  .strict();
export const MotaTransferBindingSchema = targetSchema
  .extend({
    environmentId: z.literal('sandbox'),
    sourceSha256: sha256,
  })
  .strict();
export type MotaTransferBinding = z.infer<typeof MotaTransferBindingSchema>;
type Target = z.infer<typeof targetSchema>;
export type MotaTransferRequest = Target & MotaImport;
type Operation = 'begin' | 'file' | 'chunk' | 'file-end';
type FrameBase = { binding: MotaTransferBinding; seq: number };
export type MotaTransferInput = FrameBase &
  (
    | { type: 'begin'; fileCount: number; totalBytes: number }
    | { type: 'file'; fileIndex: number; path: string; bytes: number; sha256: string }
    | { type: 'chunk'; fileIndex: number; offset: number; base64: string }
    | { type: 'file-end'; fileIndex: number; bytes: number; sha256: string }
    | { type: 'finish'; fileCount: number; totalBytes: number; sourceSha256: string }
  );
const ackSchema = z
  .object({
    type: z.literal('ack'),
    binding: MotaTransferBindingSchema,
    seq: z
      .number()
      .int()
      .min(0)
      .max(FRAME_LIMIT - 1),
    operation: z.enum(['begin', 'file', 'chunk', 'file-end']),
    fileIndex: z.number().int().min(0).max(511).nullable(),
    offset: z
      .number()
      .int()
      .min(0)
      .max(12 * 1024 * 1024),
    sha256: sha256.nullable(),
  })
  .strict();
export const MotaTransferReceiptSchema = z
  .object({
    type: z.literal('receipt'),
    binding: MotaTransferBindingSchema,
    seq: z
      .number()
      .int()
      .min(0)
      .max(FRAME_LIMIT - 1),
    outcome: z.literal('imported'),
    fileCount: z.number().int().min(1).max(512),
    totalBytes: z
      .number()
      .int()
      .min(0)
      .max(64 * 1024 * 1024),
    sourceSha256: sha256,
  })
  .strict();
type Ack = z.infer<typeof ackSchema>;
export type MotaTransferReceipt = z.infer<typeof MotaTransferReceiptSchema>;
type Reply = Ack | MotaTransferReceipt;
type Worker = Pick<GuestProcess, 'done' | 'close' | 'closeInput' | 'write'>;
export type MotaTransferConnection = { start(request: GuestStart, onFrame: (frame: GuestFrame) => void): Worker };
type FailureCode =
  | 'mota_transfer_invalid_source'
  | 'mota_transfer_invalid_options'
  | 'mota_transfer_cancelled'
  | 'mota_transfer_budget_exceeded'
  | 'mota_transfer_invalid_reply'
  | 'mota_transfer_binding_mismatch'
  | 'mota_transfer_unexpected_reply'
  | 'mota_transfer_ack_timeout'
  | 'mota_transfer_total_timeout'
  | 'mota_transfer_eof'
  | 'mota_transfer_transport_failed'
  | 'mota_transfer_cleanup_unknown';
export type MotaTransferResult =
  | { ok: true; cleanupConfirmed: true; receipt: MotaTransferReceipt; errorCode: null }
  | { ok: false; cleanupConfirmed: boolean; receipt: MotaTransferReceipt | null; errorCode: FailureCode };
type Options = {
  helper: string;
  signal?: AbortSignal;
  ackTimeoutMs?: number;
  completionTimeoutMs?: number;
  cleanupTimeoutMs?: number;
  totalTimeoutMs?: number;
};
class TransferFailure extends Error {
  constructor(readonly code: FailureCode) {
    super(code);
  }
}
function digest(bytes: Uint8Array | string) {
  return createHash('sha256').update(bytes).digest('hex');
}
function sameBinding(a: MotaTransferBinding, b: MotaTransferBinding) {
  return (
    a.workspaceId === b.workspaceId &&
    a.environmentId === b.environmentId &&
    a.projectId === b.projectId &&
    a.importOperationId === b.importOperationId &&
    a.sourceSha256 === b.sourceSha256
  );
}
function sameReply(actual: Reply, expected: Reply) {
  if (actual.type !== expected.type || actual.seq !== expected.seq || !sameBinding(actual.binding, expected.binding)) return false;
  if (actual.type === 'ack' && expected.type === 'ack') {
    return (
      actual.operation === expected.operation &&
      actual.fileIndex === expected.fileIndex &&
      actual.offset === expected.offset &&
      actual.sha256 === expected.sha256
    );
  }
  return (
    actual.type === 'receipt' &&
    expected.type === 'receipt' &&
    actual.fileCount === expected.fileCount &&
    actual.totalBytes === expected.totalBytes &&
    actual.sourceSha256 === expected.sourceSha256
  );
}
function timeoutValue(value: number | undefined, maximum: number) {
  const resolved = value ?? maximum;
  if (!Number.isInteger(resolved) || resolved < 1 || resolved > maximum) throw new TransferFailure('mota_transfer_invalid_options');
  return resolved;
}
async function bounded<T>(promise: Promise<T>, milliseconds: number, code: FailureCode): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([
      promise,
      new Promise<never>((_, reject) => {
        timer = setTimeout(() => reject(new TransferFailure(code)), milliseconds);
      }),
    ]);
  } finally {
    clearTimeout(timer);
  }
}

/**
 * Mota-only stop-and-wait import. Nothing is wired to AppImports or a guest ingest helper yet.
 * The receiver must validate the full binding and global seq on every line, open files only
 * beneath its owned staging root, enforce the supplied file length/hash and canonical path,
 * ACK chunks only after consuming their bytes, verify file-end hashes, then atomically publish
 * at finish after computing motaSourceIdentityInput's digest. It emits exactly one bounded
 * WSL_MOTA_TRANSFER JSON reply per input; no server/origin events share this channel.
 * Begin is the only prompt (no manifest/payload); <=32 KiB raw chunks keep each duplex input
 * below 64 KiB. Budgets: 512 files/64 MiB source, 4096 frames/96 MiB input, 8 KiB reply lines/
 * 16 MiB stdout, 64 KiB stderr. After its final receipt the receiver waits for stdin EOF.
 * Caller must persist dispatch intent before calling and retain/reconcile uncertain cleanup;
 * a retained receipt on failure can mean publication happened before transport/cancellation.
 */
export async function transferMotaSource(
  connection: MotaTransferConnection,
  input: MotaTransferRequest,
  options: Options,
): Promise<MotaTransferResult> {
  let worker: Worker | null = null;
  let dispatched = false;
  let receipt: MotaTransferReceipt | null = null;
  let outcome: GuestOutcome | null = null;
  let failure: TransferFailure | null = null;
  let pending: { expected: Reply; resolve(reply: Reply): void; reject(error: TransferFailure): void } | null = null;
  let totalTimer: ReturnType<typeof setTimeout> | undefined;
  let closePromise: Promise<GuestOutcome> | null = null;
  let cleanupTimeoutMs = 12000;
  const ownedWorker = (): Worker | null => worker;
  let wakeFailure!: (error: TransferFailure) => void;
  const failed = new Promise<TransferFailure>((resolve) => {
    wakeFailure = resolve;
  });
  const fail = (code: FailureCode) => {
    if (failure) return;
    failure = new TransferFailure(code);
    wakeFailure(failure);
    pending?.reject(failure);
    pending = null;
  };
  const cancelled = () => fail('mota_transfer_cancelled');
  const check = () => {
    if (failure) throw failure;
  };
  try {
    const ackTimeoutMs = timeoutValue(options.ackTimeoutMs, 10000);
    const completionTimeoutMs = timeoutValue(options.completionTimeoutMs, 15000);
    cleanupTimeoutMs = timeoutValue(options.cleanupTimeoutMs, 12000);
    const totalTimeoutMs = timeoutValue(options.totalTimeoutMs, 120000);
    if (typeof options.helper !== 'string' || !options.helper) throw new TransferFailure('mota_transfer_invalid_options');
    if (options.signal?.aborted) throw new TransferFailure('mota_transfer_cancelled');
    let source: MotaImport;
    let target: Target;
    try {
      const envelope = targetSchema.extend({ source: z.unknown(), files: z.unknown() }).strict().parse(input);
      if (!Array.isArray(envelope.files) || envelope.files.length > 512) throw new Error('file budget exceeded');
      let encodedBytes = 0;
      for (const file of envelope.files) {
        if (!file || typeof file !== 'object' || !('base64' in file) || typeof file.base64 !== 'string') throw new Error('invalid file');
        encodedBytes += file.base64.length;
        if (encodedBytes > Math.ceil((64 * 1024 * 1024) / 3) * 4 + 4 * 512) throw new Error('source byte budget exceeded');
      }
      target = targetSchema.parse({
        workspaceId: envelope.workspaceId,
        projectId: envelope.projectId,
        importOperationId: envelope.importOperationId,
      });
      source = MotaImportSchema.parse({ source: envelope.source, files: envelope.files });
      const metadata = new Map(source.source.files.map((file) => [file.path, file]));
      for (const file of source.files) {
        const expected = metadata.get(file.path);
        if (!expected || digest(Buffer.from(file.base64, 'base64')) !== expected.sha256) throw new Error('source hash mismatch');
      }
      if (digest(motaSourceIdentityInput(source.source.files)) !== source.source.sourceSha256) throw new Error('manifest hash mismatch');
    } catch {
      throw new TransferFailure('mota_transfer_invalid_source');
    }
    const binding: MotaTransferBinding = { ...target, environmentId: 'sandbox', sourceSha256: source.source.sourceSha256 };
    const metadata = new Map(source.source.files.map((file) => [file.path, file]));
    const files = [...source.files].sort((a, b) => (a.path < b.path ? -1 : a.path > b.path ? 1 : 0));
    const totalBytes = source.source.files.reduce((sum, file) => sum + file.bytes, 0);
    let seq = 0;
    let sentBytes = 0;
    let stdoutBytes = 0;
    let stderrBytes = 0;
    let buffered = '';
    const encode = (frame: MotaTransferInput) => {
      check();
      const line = JSON.stringify(frame) + '\n';
      const bytes = Buffer.byteLength(line);
      sentBytes += bytes;
      if (
        frame.seq >= FRAME_LIMIT ||
        bytes > INPUT_LIMIT ||
        Buffer.byteLength(JSON.stringify({ type: 'input', data: line }) + '\n') > INPUT_LIMIT ||
        sentBytes > INPUT_BUDGET
      ) {
        throw new TransferFailure('mota_transfer_budget_exceeded');
      }
      return line;
    };
    const onFrame = (frame: GuestFrame) => {
      if (failure) return;
      if (frame.type === 'error') {
        fail('mota_transfer_transport_failed');
        return;
      }
      if (frame.type !== 'output') return;
      const bytes = Buffer.byteLength(frame.data);
      if (frame.stream === 'stderr') {
        stderrBytes += bytes;
        if (stderrBytes > STDERR_BUDGET) fail('mota_transfer_budget_exceeded');
        return;
      }
      stdoutBytes += bytes;
      if (stdoutBytes > OUTPUT_BUDGET) {
        fail('mota_transfer_budget_exceeded');
        return;
      }
      buffered += frame.data;
      let newline: number;
      while ((newline = buffered.indexOf('\n')) >= 0) {
        const line = buffered.slice(0, newline);
        buffered = buffered.slice(newline + 1);
        if (Buffer.byteLength(line) > OUTPUT_LINE_LIMIT) {
          fail('mota_transfer_budget_exceeded');
          return;
        }
        let reply: Reply;
        try {
          if (!line.startsWith(MOTA_TRANSFER_PREFIX)) throw new Error('wrong prefix');
          const value: unknown = JSON.parse(line.slice(MOTA_TRANSFER_PREFIX.length));
          reply = z.union([ackSchema, MotaTransferReceiptSchema]).parse(value);
        } catch {
          fail('mota_transfer_invalid_reply');
          return;
        }
        if (!sameBinding(reply.binding, binding)) {
          fail('mota_transfer_binding_mismatch');
          return;
        }
        if (!pending || !sameReply(reply, pending.expected)) {
          fail('mota_transfer_unexpected_reply');
          return;
        }
        const waiting = pending;
        pending = null;
        if (reply.type === 'receipt') receipt = reply;
        waiting.resolve(reply);
      }
      if (Buffer.byteLength(buffered) > OUTPUT_LINE_LIMIT) fail('mota_transfer_budget_exceeded');
    };
    const exchange = async (expected: Reply, send: () => void) => {
      check();
      if (pending) throw new TransferFailure('mota_transfer_unexpected_reply');
      const reply = new Promise<Reply>((resolve, reject) => {
        pending = { expected, resolve, reject };
      });
      try {
        send();
      } catch {
        fail('mota_transfer_transport_failed');
      }
      const result = await bounded(reply, ackTimeoutMs, 'mota_transfer_ack_timeout');
      check();
      return result;
    };
    const ack = (operation: Operation, fileIndex: number | null, offset: number, hash: string | null): Ack => ({
      type: 'ack',
      binding,
      seq,
      operation,
      fileIndex,
      offset,
      sha256: hash,
    });
    const send = async (frame: MotaTransferInput, expected: Reply) => {
      const line = encode(frame);
      await exchange(expected, () => {
        if (!worker) throw new Error('missing owned worker');
        worker.write({ type: 'input', data: line });
      });
      seq++;
    };
    options.signal?.addEventListener('abort', cancelled, { once: true });
    if (options.signal?.aborted) cancelled();
    totalTimer = setTimeout(() => fail('mota_transfer_total_timeout'), totalTimeoutMs);
    check();
    const begin: MotaTransferInput = { type: 'begin', binding, seq, fileCount: files.length, totalBytes };
    const request: GuestStart = {
      type: 'start',
      mode: 'codex',
      argv: ['python3', '-I', '-u', '-c', options.helper],
      duplex: true,
      prompt: encode(begin),
    };
    if (Buffer.byteLength(JSON.stringify(request) + '\n') > START_LIMIT) throw new TransferFailure('mota_transfer_budget_exceeded');
    await exchange(ack('begin', null, 0, null), () => {
      dispatched = true;
      worker = connection.start(request, onFrame);
      void worker.done.then(
        (result) => {
          outcome = result;
          if (!receipt || buffered) fail('mota_transfer_eof');
          else if (!result.confirmed) fail('mota_transfer_cleanup_unknown');
          else if (result.error || result.exitCode !== 0) fail('mota_transfer_transport_failed');
        },
        () => fail('mota_transfer_transport_failed'),
      );
    });
    seq++;
    for (const [fileIndex, file] of files.entries()) {
      const expected = metadata.get(file.path);
      if (!expected) throw new TransferFailure('mota_transfer_invalid_source');
      await send({ type: 'file', binding, seq, fileIndex, ...expected }, ack('file', fileIndex, 0, expected.sha256));
      const bytes = Buffer.from(file.base64, 'base64');
      for (let offset = 0; offset < bytes.length; offset += MOTA_TRANSFER_CHUNK_BYTES) {
        const chunk = bytes.subarray(offset, Math.min(offset + MOTA_TRANSFER_CHUNK_BYTES, bytes.length));
        await send(
          { type: 'chunk', binding, seq, fileIndex, offset, base64: chunk.toString('base64') },
          ack('chunk', fileIndex, offset + chunk.length, null),
        );
      }
      await send(
        { type: 'file-end', binding, seq, fileIndex, bytes: expected.bytes, sha256: expected.sha256 },
        ack('file-end', fileIndex, expected.bytes, expected.sha256),
      );
    }
    const expectedReceipt: MotaTransferReceipt = {
      type: 'receipt',
      binding,
      seq,
      outcome: 'imported',
      fileCount: files.length,
      totalBytes,
      sourceSha256: source.source.sourceSha256,
    };
    await send(
      { type: 'finish', binding, seq, fileCount: files.length, totalBytes, sourceSha256: source.source.sourceSha256 },
      expectedReceipt,
    );
    const completedWorker = ownedWorker();
    if (!completedWorker) throw new TransferFailure('mota_transfer_transport_failed');
    if (!outcome) completedWorker.closeInput();
    const result = await bounded(
      Promise.race([
        completedWorker.done,
        failed.then((error): never => {
          throw error;
        }),
      ]),
      completionTimeoutMs,
      'mota_transfer_eof',
    );
    check();
    if (!result.confirmed) throw new TransferFailure('mota_transfer_cleanup_unknown');
    if (result.error || result.exitCode !== 0 || buffered || !receipt) throw new TransferFailure('mota_transfer_transport_failed');
    return { ok: true, cleanupConfirmed: true, receipt, errorCode: null };
  } catch (error) {
    const code = error instanceof TransferFailure ? error.code : 'mota_transfer_transport_failed';
    let cleanupConfirmed = !dispatched;
    const closingWorker = ownedWorker();
    if (closingWorker) {
      try {
        closePromise ??= Promise.resolve().then(() => closingWorker.close());
        cleanupConfirmed = (await bounded(closePromise, cleanupTimeoutMs, 'mota_transfer_cleanup_unknown')).confirmed;
      } catch {
        cleanupConfirmed = false;
      }
    }
    return { ok: false, cleanupConfirmed, receipt, errorCode: code };
  } finally {
    clearTimeout(totalTimer);
    options.signal?.removeEventListener('abort', cancelled);
    pending = null;
  }
}
