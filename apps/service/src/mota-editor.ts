import { createHash } from 'node:crypto';
import {
  MOTA_EDITOR_LIMITS as limits,
  MotaEditorRequestSchema,
  MotaEditorFrameSchema,
  MotaEditorFrameResultSchema,
  type MotaEditorOperationSchema,
  type MotaEditorBinding,
  type MotaEditorRequest,
  type MotaEditorResult,
  type MotaEditorFrame,
  type MotaEditorFrameResult,
} from '@wsl/protocol';
import type { z } from 'zod';

type Operation = z.infer<typeof MotaEditorOperationSchema>;
type Save = { fingerprint: string; operation: Operation; blocked: boolean };
type Owner = {
  binding: MotaEditorBinding;
  editorSessionId: string;
  index: number;
  state: 'opening' | 'active' | 'revoked';
  settled: boolean;
  busy: boolean;
  idle: Promise<void>;
  release: () => void;
  snapshot: Buffer | null;
  stage: Buffer | null;
  stageRequestId: string | null;
  stageDeadline: number;
};
type Pending = {
  owner: Owner;
  frame: MotaEditorFrame;
  resolve: (value: MotaEditorFrameResult) => void;
  reject: (error: Error) => void;
};
const digest = (data: Buffer) => createHash('sha256').update(data).digest('hex');
class EditorRefusal extends Error {}
const bindingKey = (binding: MotaEditorBinding) => JSON.stringify(binding);
const metadata = (input: Extract<MotaEditorRequest, { method: 'editor.stage' | 'editor.commit' }>['input']) => ({
  file: input.file,
  expectedHash: input.expectedHash,
  contentLength: input.contentLength,
  contentHash: input.contentHash,
});

/** Manual owners are independent of AI runs. Unknown outcomes retain admission and buffers. */
export class MotaEditors {
  private readonly owners = new Map<string, Owner>();
  private readonly epochs = new Map<string, number>();
  private readonly records = new Map<string, Map<string, Save>>();
  private readonly pending = new Map<string, Pending>();
  private nextIndex = 0;

  private decodedBytes(): number {
    return [...this.owners.values()].reduce((sum, owner) => sum + (owner.snapshot?.length ?? 0) + (owner.stage?.length ?? 0), 0);
  }
  private reserve(owner: Owner, kind: 'snapshot' | 'stage', bytes: number): void {
    if (bytes > limits.fileBytes || this.decodedBytes() - (owner[kind]?.length ?? 0) + bytes > limits.decodedBytes)
      throw new Error('budget_exceeded');
    owner[kind] = Buffer.alloc(bytes);
  }
  revokeApp(appInstanceId: string): void {
    for (const owner of this.owners.values()) if (owner.binding.appInstanceId === appInstanceId) owner.state = 'revoked';
  }
  /** Caller must have independent proof that this exact App process has retired. */
  retireApp(appInstanceId: string): void {
    for (const [key, owner] of this.owners) {
      if (owner.binding.appInstanceId !== appInstanceId) continue;
      if ([...this.pending.values()].some((pending) => pending.owner === owner)) throw new Error('editor_reply_unsettled');
      this.owners.delete(key);
    }
    this.records.delete(appInstanceId);
    // The appInstance tombstone remains: its epoch can never be reused.
    this.epochs.set(appInstanceId, Number.MAX_SAFE_INTEGER);
  }
  private owner(request: MotaEditorRequest): Owner {
    const existing = this.owners.get(request.editorSessionId);
    if (existing) {
      if (bindingKey(existing.binding) !== bindingKey(request.binding)) throw new Error('stale_instance');
      return existing;
    }
    if (request.method !== 'editor.open' && request.method !== 'editor.revoke') throw new Error('unknown');
    const app = request.binding.appInstanceId;
    const epoch = this.epochs.get(app) ?? 0;
    if (request.binding.editorEpoch <= epoch) throw new Error('revoked');
    if (
      [...this.owners.values()].filter((owner) => !owner.settled).length >= limits.sessions ||
      [...this.owners.values()].some((owner) => owner.binding.appInstanceId === app && !owner.settled) ||
      [...this.owners.values()].filter((owner) => owner.binding.appInstanceId === app).length >= limits.operations
    )
      throw new Error('budget_exceeded');
    this.epochs.set(app, request.binding.editorEpoch);
    const owner: Owner = {
      binding: request.binding,
      editorSessionId: request.editorSessionId,
      index: ++this.nextIndex,
      state: request.method === 'editor.open' ? 'opening' : 'revoked',
      settled: false,
      busy: false,
      idle: Promise.resolve(),
      release: () => undefined,
      snapshot: null,
      stage: null,
      stageRequestId: null,
      stageDeadline: 0,
    };
    this.owners.set(request.editorSessionId, owner);
    return owner;
  }
  receive(input: unknown, appInstanceId: string): boolean {
    if (!input || typeof input !== 'object' || !('type' in input) || input.type !== 'mota-editor-result') return false;
    const parsed = MotaEditorFrameResultSchema.safeParse(input);
    const pending = this.pending.get(appInstanceId);
    if (!pending) return true;
    if (!parsed.success || Buffer.byteLength(JSON.stringify(input) + '\n') > limits.frameBytes) {
      pending.reject(new Error('invalid_frame'));
      return true;
    }
    const reply = parsed.data;
    const frame = pending.frame;
    if (
      pending.owner.binding.appInstanceId !== appInstanceId ||
      !(['editorSessionId', 'requestId', 'sessionIndex', 'editorEpoch', 'method', 'phase', 'frameSeq'] as const).every(
        (key) => frame[key] === reply[key],
      )
    )
      pending.reject(new Error('invalid_frame'));
    else pending.resolve(reply);
    return true;
  }
  private async exchange(
    owner: Owner,
    frame: MotaEditorFrame,
    deadline: number,
    write: (frame: MotaEditorFrame) => void,
  ): Promise<MotaEditorFrameResult> {
    MotaEditorFrameSchema.parse(frame);
    const line = JSON.stringify(frame) + '\n';
    // These are the actual decoded duplex line and its escaped outer guest envelope.
    if (Buffer.byteLength(line) > limits.frameBytes || Buffer.byteLength(JSON.stringify({ type: 'input', data: line }) + '\n') > 65536)
      throw new Error('budget_exceeded');
    const app = owner.binding.appInstanceId;
    if (this.pending.has(app)) throw new Error('busy');
    const remaining = deadline - Date.now();
    if (remaining <= 0) throw new Error('expired');
    let timer: ReturnType<typeof setTimeout> | undefined;
    try {
      return await new Promise<MotaEditorFrameResult>((resolve, reject) => {
        this.pending.set(app, { owner, frame, resolve, reject });
        timer = setTimeout(() => reject(new Error('unknown')), Math.min(limits.responseMs, remaining));
        try {
          write(frame);
        } catch (error) {
          reject(error);
        }
      });
    } finally {
      if (timer) clearTimeout(timer);
      this.pending.delete(app);
    }
  }
  async call(input: MotaEditorRequest, write: (frame: MotaEditorFrame) => void): Promise<MotaEditorResult> {
    const request = MotaEditorRequestSchema.parse(input);
    const response = {
      binding: request.binding,
      editorSessionId: request.editorSessionId,
      requestId: request.requestId,
      method: request.method,
    };
    let owner: Owner | undefined;
    let acquired = false;
    let save: Save | undefined;
    let saveAttempt = false;
    try {
      // Ownership and revoke tombstones are reserved before the first await.
      owner = this.owner(request);
      const saving = request.method === 'editor.stage' || request.method === 'editor.commit';
      if (request.method === 'editor.revoke') owner.state = 'revoked';
      else if (request.method !== 'editor.status' && !saving && owner.state === 'revoked') throw new Error('revoked');
      const startedAt = Date.now();
      if (owner.busy && request.method === 'editor.revoke') await owner.idle;
      if (owner.busy) throw new Error('busy');
      owner.busy = true;
      const registered = owner;
      owner.idle = new Promise<void>((resolve) => {
        registered.release = resolve;
      });
      acquired = true;
      const current = owner;
      const deadline = startedAt + limits.transferMs;
      let seq = 0;
      const send = async (method: MotaEditorFrame['method'], phase: MotaEditorFrame['phase'], input: unknown) => {
        if (!['editor.revoke', 'editor.status'].includes(method) && current.state === 'revoked') throw new Error('revoked');
        const frame = MotaEditorFrameSchema.parse({
          type: 'mota-editor',
          editorSessionId: request.editorSessionId,
          requestId: request.requestId,
          sessionIndex: current.index,
          editorEpoch: current.binding.editorEpoch,
          method,
          phase,
          frameSeq: seq++,
          input,
        });
        const result = await this.exchange(
          current,
          frame,
          method === 'editor.commit' ? Math.min(deadline, current.stageDeadline || deadline) : deadline,
          write,
        );
        if (!result.ok) throw new EditorRefusal(result.error.code);
        return result.data;
      };
      if (request.method === 'editor.open') {
        if (current.state !== 'opening') throw new Error('operation_conflict');
        const data = await send(request.method, 'single', request.binding);
        if (!('settled' in data) || 'operation' in data || current.state !== 'opening') throw new Error('revoked');
        current.state = 'active';
        return { ...response, ok: true, data: {} };
      }
      if (request.method === 'editor.revoke') {
        const data = await send(request.method, 'single', {});
        if (!('discarded' in data)) throw new Error('invalid_frame');
        const records = this.records.get(current.binding.appInstanceId);
        if (data.operation) {
          if (!records?.has(current.editorSessionId + ':' + data.operation.requestId)) throw new Error('invalid_frame');
          this.updateOperation(current, data.operation);
        }
        if (
          records &&
          [...records].some(
            ([key, save]) => key.startsWith(current.editorSessionId + ':') && !['committed', 'failed'].includes(save.operation.status),
          )
        )
          throw new Error('unknown');
        current.settled = true;
        current.snapshot = null;
        current.stage = null;
        return { ...response, ok: true, data };
      }
      if (request.method === 'editor.status') {
        const data = await send(request.method, 'single', request.input);
        if (!('status' in data) || data.requestId !== request.input.operationRequestId) throw new Error('invalid_frame');
        this.updateOperation(current, data);
        return { ...response, ok: true, data };
      }
      if (current.state !== 'active' && !saving) throw new Error('unavailable');
      if (request.method === 'editor.read') {
        if (current.stage) throw new Error('busy');
        const begin = await send(request.method, 'begin', request.input);
        if (!('contentLength' in begin) || 'requestId' in begin) throw new Error('invalid_frame');
        this.reserve(current, 'snapshot', begin.contentLength);
        const chunks: Buffer[] = [];
        let size = 0;
        while (size < begin.contentLength) {
          const block = await send(request.method, 'chunk', {});
          if (!('base64' in block)) throw new Error('invalid_frame');
          const bytes = Buffer.from(block.base64, 'base64');
          if (bytes.toString('base64') !== block.base64 || bytes.length !== Math.min(limits.chunkBytes, begin.contentLength - size))
            throw new Error('invalid_frame');
          chunks.push(bytes);
          size += bytes.length;
        }
        const end = await send(request.method, 'end', {});
        if (!('settled' in end) || 'operation' in end) throw new Error('invalid_frame');
        const bytes = Buffer.concat(chunks, size);
        if (begin.contentHash === null ? size !== 0 : digest(bytes) !== begin.contentHash) throw new Error('invalid_content');
        current.snapshot = bytes;
        const content = begin.contentHash === null ? null : new TextDecoder('utf-8', { fatal: true, ignoreBOM: true }).decode(bytes);
        return { ...response, ok: true, data: { ...begin, content } };
      }
      let records = this.records.get(current.binding.appInstanceId);
      if (!records) {
        records = new Map();
        this.records.set(current.binding.appInstanceId, records);
      }
      const key = request.editorSessionId + ':' + request.requestId;
      const fingerprint = JSON.stringify(metadata(request.input));
      save = records.get(key);
      if (save && save.fingerprint !== fingerprint) throw new Error('operation_conflict');
      let stagedBytes: Buffer | undefined;
      if (request.method === 'editor.stage') {
        if (Buffer.byteLength(request.input.content) !== request.input.contentLength) throw new Error('invalid_content');
        stagedBytes = Buffer.from(request.input.content, 'utf8');
        if (digest(stagedBytes) !== request.input.contentHash) throw new Error('invalid_content');
      }
      if (save?.operation.status === 'committed') return { ...response, ok: true, data: save.operation };
      if (save && (save.blocked || ['failed', 'unknown'].includes(save.operation.status)))
        throw new Error(save.operation.error ?? 'unknown');
      if (current.state !== 'active') throw new Error(current.state === 'revoked' ? 'revoked' : 'unavailable');
      if (request.method === 'editor.stage') {
        if (!stagedBytes) throw new Error('invalid_content');
        const bytes = stagedBytes;
        if (save) return { ...response, ok: true, data: save.operation };
        if (records.size >= limits.operations) throw new Error('budget_exceeded');
        if (current.stage) throw new Error('busy');
        this.reserve(current, 'stage', bytes.length);
        current.stage = bytes;
        current.stageRequestId = request.requestId;
        current.stageDeadline = deadline;
        save = { fingerprint, blocked: false, operation: { requestId: request.requestId, status: 'staging', receipt: null, error: null } };
        records.set(key, save);
        saveAttempt = true;
        const ack = (data: Awaited<ReturnType<typeof send>>) => {
          if (!('settled' in data) || 'operation' in data) throw new Error('invalid_frame');
        };
        ack(await send(request.method, 'begin', metadata(request.input)));
        for (let offset = 0; offset < bytes.length; offset += limits.chunkBytes)
          ack(await send(request.method, 'chunk', { base64: bytes.subarray(offset, offset + limits.chunkBytes).toString('base64') }));
        const end = await send(request.method, 'end', {});
        if (!('status' in end) || end.requestId !== request.requestId || end.status !== 'staged') throw new Error('invalid_frame');
        save.operation = end;
        return { ...response, ok: true, data: end };
      }
      if (!save || current.stageRequestId !== request.requestId) throw new Error('unknown');
      saveAttempt = true;
      const data = await send(request.method, 'single', request.input);
      if (!('status' in data) || data.requestId !== request.requestId) throw new Error('invalid_frame');
      if (!['committed', 'failed'].includes(data.status)) throw new Error('invalid_frame');
      this.validateReceipt(request, data);
      save.operation = data;
      if (data.status === 'committed' || data.status === 'failed') current.stage = null;
      return { ...response, ok: true, data };
    } catch (error) {
      const parsed = MotaEditorFrameResultSchema.options[0].shape.error.shape.code.safeParse(
        error instanceof Error ? error.message : 'unknown',
      );
      const code = parsed.success ? parsed.data : 'unknown';
      if (save && saveAttempt && save.operation.status !== 'committed') {
        save.operation = {
          requestId: request.requestId,
          status: error instanceof EditorRefusal ? 'failed' : 'unknown',
          receipt: null,
          error: code,
        };
        save.blocked = !(error instanceof EditorRefusal);
        if (error instanceof EditorRefusal && owner) owner.stage = null;
      }
      return { ...response, ok: false, error: { code, message: code } };
    } finally {
      if (owner && acquired) {
        owner.busy = false;
        owner.release();
      }
    }
  }
  private validateReceipt(request: Extract<MotaEditorRequest, { method: 'editor.commit' }>, operation: Operation): void {
    const receipt = operation.receipt;
    if (
      receipt &&
      (receipt.editorSessionId !== request.editorSessionId ||
        receipt.requestId !== request.requestId ||
        JSON.stringify(metadata(receipt)) !== JSON.stringify(metadata(request.input)) ||
        receipt.afterHash !== request.input.contentHash)
    )
      throw new Error('invalid_frame');
  }
  private updateOperation(owner: Owner, operation: Operation): void {
    const saved = this.records.get(owner.binding.appInstanceId)?.get(owner.editorSessionId + ':' + operation.requestId);
    if (!saved) {
      if (operation.status !== 'unknown') throw new Error('invalid_frame');
      return;
    }
    if (
      operation.receipt &&
      (operation.receipt.editorSessionId !== owner.editorSessionId ||
        JSON.stringify(metadata(operation.receipt)) !== saved.fingerprint ||
        operation.receipt.afterHash !== operation.receipt.contentHash)
    )
      throw new Error('invalid_frame');
    // A delayed unknown/failed reply never erases an already observed rename.
    if (saved.operation.status !== 'committed' && (!saved.blocked || ['committed', 'failed'].includes(operation.status)))
      saved.operation = operation;
  }
}
