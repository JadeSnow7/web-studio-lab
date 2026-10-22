import { randomUUID } from 'node:crypto';
import { mkdir, readFile, rename, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { z } from 'zod';
import {
  APP_SOURCE_TRANSPORT,
  AppProfileSchema,
  EduSourceSchema,
  type AppImportOutcome,
  type AppImportRequest,
  type AppImportTarget,
  type AppProfile,
  type ManagedApp,
} from '@wsl/protocol';
import type { GuestProcess, GuestStart, SbxConnection } from './sbx';
import { encodeGuestStart } from './sbx';

const targetSchema = z
  .object({
    workspaceId: z.string().min(1).max(128),
    projectId: z.string().regex(/^[A-Za-z0-9][A-Za-z0-9_-]{0,127}$/),
    importOperationId: z.string().uuid(),
  })
  .strict();
const legacyRecordSchema = targetSchema.extend({
  source: EduSourceSchema.nullable(),
  outcome: z.enum(['pending', 'imported', 'cancelled', 'failed']),
  retryable: z.boolean(),
  errorCode: z.string().nullable(),
  cancelRequested: z.boolean(),
  published: z.boolean(),
  dispatched: z.boolean(),
});
const recordSchema = legacyRecordSchema
  .extend({
    profileKind: z.literal('edu-web').nullable(),
    source: EduSourceSchema.nullable(),
  })
  .superRefine((record, context) => {
    if (record.source && (record.profileKind === null || (record.profileKind === 'edu-web') !== 'repository' in record.source))
      context.addIssue({ code: 'custom', message: 'import profile and source disagree' });
  });
const journalSchema = z.discriminatedUnion('version', [
  z.object({ version: z.literal(1), sandbox: z.string().min(1).nullable(), operations: z.array(legacyRecordSchema).max(4096) }).strict(),
  z.object({ version: z.literal(2), sandbox: z.string().min(1).nullable(), operations: z.array(recordSchema).max(4096) }).strict(),
]);
const receiptSchema = z
  .object({
    importOperationId: z.string().uuid(),
    outcome: z.enum(['imported', 'cancelled', 'failed']),
    retryable: z.boolean(),
    errorCode: z
      .string()
      .max(100)
      .regex(/^import_[a-z0-9_]+$/)
      .nullable(),
    sourceSha256: z
      .string()
      .regex(/^[a-f0-9]{64}$/)
      .optional(),
    profile: AppProfileSchema.optional(),
  })
  .strict();
type Worker = Pick<GuestProcess, 'done' | 'close'> & Partial<Pick<GuestProcess, 'write' | 'closeInput'>>;
type Record = z.infer<typeof recordSchema> & {
  pending: Promise<AppImportOutcome> | null;
  worker: Worker | null;
  close: ReturnType<Worker['close']> | null;
  copying: boolean;
};
type Connection = Pick<SbxConnection, 'getStatus'> & { start: (...args: Parameters<SbxConnection['start']>) => Worker };
type Receipt = z.infer<typeof receiptSchema>;

/** Import jobs own copies, not running App processes. The guest receipt is the commit authority. */
export class AppImports {
  private records = new Map<string, Record>();
  private loading: Promise<void> | null = null;
  private persistence: Promise<void> = Promise.resolve();
  private closing = false;
  private legacyJournal: string | null = null;
  constructor(
    private connection: Connection,
    private options: {
      journalPath?: string;
      helper: string;
      app: (target: AppImportTarget) => ManagedApp | null;
      publish: (target: AppImportTarget, profile: AppProfile) => Promise<ManagedApp>;
    },
  ) {}

  private loaded() {
    return (this.loading ??= this.load().catch(() => {
      this.loading = null;
      throw new Error('import_journal_invalid');
    }));
  }
  ready() {
    return this.loaded();
  }
  private async load() {
    if (!this.options.journalPath) return;
    let raw: string;
    try {
      raw = await readFile(this.options.journalPath, 'utf8');
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') return;
      throw error;
    }
    const journal = journalSchema.parse(JSON.parse(raw));
    if (journal.sandbox !== this.connection.getStatus().sandbox && journal.operations.some((record) => record.dispatched))
      throw new Error('import_sandbox_changed');
    this.legacyJournal = journal.version === 1 ? raw : null;
    for (const saved of journal.operations) {
      if (this.records.has(saved.importOperationId)) throw new Error('import_duplicate_operation');
      this.records.set(saved.importOperationId, {
        ...saved,
        profileKind: 'profileKind' in saved ? saved.profileKind : saved.source ? 'edu-web' : null,
        pending: null,
        worker: null,
        close: null,
        copying: false,
      });
    }
  }
  private persist() {
    const target = this.options.journalPath;
    if (!target) return Promise.resolve();
    const contents = JSON.stringify({
      version: 2,
      sandbox: this.connection.getStatus().sandbox,
      operations: [...this.records.values()].map(
        ({ pending: _pending, worker: _worker, close: _close, copying: _copying, ...saved }) => saved,
      ),
    });
    const legacy = this.legacyJournal;
    const saving = this.persistence.then(async () => {
      await mkdir(path.dirname(target), { recursive: true });
      if (legacy !== null) {
        try {
          await writeFile(target + '.schema-v1.json', legacy, { flag: 'wx', mode: 0o400 });
        } catch (error) {
          if ((error as NodeJS.ErrnoException).code !== 'EEXIST' || (await readFile(target + '.schema-v1.json', 'utf8')) !== legacy)
            throw error;
        }
      }
      const temporary = `${target}.${randomUUID()}.tmp`;
      await writeFile(temporary, contents, { mode: 0o600 });
      await rename(temporary, target);
      this.legacyJournal = null;
    });
    this.persistence = saving.catch(() => undefined);
    return saving;
  }
  private record(target: AppImportTarget) {
    const parsed = targetSchema.parse(target);
    let record = this.records.get(parsed.importOperationId);
    if (record && (record.workspaceId !== parsed.workspaceId || record.projectId !== parsed.projectId))
      throw new Error('import_operation_conflict');
    if (!record) {
      if (this.records.size >= 4096) throw new Error('import_operation_limit');
      record = {
        ...parsed,
        source: null,
        profileKind: null,
        outcome: 'pending',
        retryable: false,
        errorCode: null,
        cancelRequested: false,
        published: false,
        dispatched: false,
        pending: null,
        worker: null,
        close: null,
        copying: false,
      };
      this.records.set(parsed.importOperationId, record);
    }
    return record;
  }
  private target(record: Record): AppImportTarget {
    return { workspaceId: record.workspaceId, projectId: record.projectId, importOperationId: record.importOperationId };
  }
  private result(record: Record): AppImportOutcome {
    return {
      app: record.published ? this.options.app(this.target(record)) : null,
      outcome: record.outcome === 'pending' ? 'failed' : record.outcome,
      retryable: record.retryable,
      errorCode: record.errorCode,
    };
  }
  busy(target: { workspaceId: string; projectId: string }) {
    return [...this.records.values()].some(
      (record) =>
        record.projectId === target.projectId &&
        (record.pending !== null || record.worker !== null || record.outcome === 'pending' || record.outcome === 'failed'),
    );
  }
  blocksWorkspace(workspaceId: string | null) {
    return [...this.records.values()].some(
      (record) =>
        record.workspaceId === workspaceId &&
        (record.pending !== null || record.worker !== null || record.outcome === 'pending' || record.outcome === 'failed'),
    );
  }
  private close(record: Record) {
    if (!record.worker) return Promise.resolve({ confirmed: true, exitCode: 0, error: null });
    return (record.close ??= record.worker.close().catch(() => ({ confirmed: false, exitCode: null, error: 'import_cleanup_unknown' })));
  }
  private async command(
    record: Record,
    operation: 'import-source' | 'reconcile-import',
    files?: AppImportRequest['files'],
  ): Promise<{ receipt: Receipt | null; stopped: boolean }> {
    let output = '';
    let oversized = false;
    let timer: ReturnType<typeof setTimeout> | undefined;
    try {
      const request: GuestStart = {
        type: 'start',
        mode: 'codex',
        argv: ['python3', '-I', '-u', '-c', this.options.helper],
        prompt: JSON.stringify({
          operation,
          ...this.target(record),
          ...(record.profileKind ? { profileKind: record.profileKind } : {}),
          ...(record.source ? { profile: { projectKind: record.profileKind, profileVersion: 1, source: record.source } } : {}),
          ...(files ? { files } : {}),
          ...(operation === 'reconcile-import' ? { cancel: record.cancelRequested } : {}),
        }),
      };
      // A deterministic encoding refusal has acquired no guest write capability.
      encodeGuestStart(request);
      record.copying = operation === 'import-source';
      record.close = null;
      // Persist dispatch intent before a child can acquire a guest write capability.
      record.dispatched = true;
      await this.persist();
      if (operation === 'import-source' && record.cancelRequested) return { receipt: null, stopped: true };
      const worker = this.connection.start(request, (frame) => {
        if (frame.type !== 'output' || frame.stream !== 'stdout') return;
        if (Buffer.byteLength(output) + Buffer.byteLength(frame.data) > APP_SOURCE_TRANSPORT.importResultBytes) {
          oversized = true;
          return;
        }
        output += frame.data;
      });
      record.worker = worker;
      const timedOut = new Promise<null>((resolve) => {
        timer = setTimeout(() => resolve(null), 30000);
      });
      const result = await Promise.race([worker.done.catch(() => null), timedOut]);
      let stopped = result?.confirmed === true;
      if (!stopped) stopped = (await this.close(record)).confirmed;
      if (!stopped) return { receipt: null, stopped: false };
      record.worker = null;
      record.close = null;
      if (!result || result.exitCode !== 0 || result.error || oversized) return { receipt: null, stopped: true };
      const lines = output.split('\n').filter((line) => line.startsWith('WSL_APP_RESULT:'));
      if (lines.length !== 1) return { receipt: null, stopped: true };
      const line = lines[0];
      if (line === undefined) return { receipt: null, stopped: true };
      const receipt = receiptSchema.parse(JSON.parse(line.slice('WSL_APP_RESULT:'.length)));
      if (receipt.importOperationId !== record.importOperationId) return { receipt: null, stopped: true };
      return { receipt, stopped: true };
    } catch {
      return { receipt: null, stopped: record.worker === null || (await this.close(record)).confirmed };
    } finally {
      if (timer) clearTimeout(timer);
      record.copying = false;
    }
  }
  private schedule(record: Record, files?: AppImportRequest['files']) {
    const pending = Promise.resolve().then(() => this.run(record, files));
    record.pending = pending;
    void pending
      .finally(() => {
        if (record.pending === pending) record.pending = null;
      })
      .catch(() => undefined);
    return pending;
  }
  private async run(record: Record, files?: AppImportRequest['files']): Promise<AppImportOutcome> {
    const fail = (errorCode: string, retryable: boolean) => {
      record.outcome = 'failed';
      record.errorCode = errorCode;
      record.retryable = retryable;
    };
    try {
      await this.persist();
    } catch {
      fail('import_storage_failed', !record.cancelRequested);
      return this.result(record);
    }
    if (!this.connection.getStatus().available) {
      if (record.dispatched) fail('import_cleanup_unknown', false);
      else if (record.cancelRequested) {
        record.outcome = 'cancelled';
        record.retryable = false;
        record.errorCode = null;
      } else fail('import_runtime_unavailable', true);
      try {
        await this.persist();
      } catch {
        fail('import_storage_failed', false);
      }
      return this.result(record);
    }
    if (record.worker) {
      // A later explicit reconciliation must be able to retry a previously
      // unconfirmed close; calls within one attempt still share its promise.
      record.close = null;
      if (!(await this.close(record)).confirmed) {
        fail('import_cleanup_unknown', false);
        return this.result(record);
      }
      record.worker = null;
      record.close = null;
    }
    const operation = record.cancelRequested || !files ? 'reconcile-import' : 'import-source';
    let result = await this.command(record, operation, files);
    if (
      result.stopped &&
      (!result.receipt || (operation === 'import-source' && record.cancelRequested && result.receipt.outcome !== 'imported'))
    )
      result = await this.command(record, 'reconcile-import');
    if (!result.stopped || !result.receipt) fail('import_cleanup_unknown', false);
    else {
      const receipt = result.receipt;
      if (receipt.outcome === 'imported') {
        const profile = receipt.profile;
        if (
          profile?.projectKind !== 'edu-web' ||
          (record.profileKind !== null && profile.projectKind !== record.profileKind) ||
          receipt.sourceSha256 !== profile.source.sourceSha256 ||
          (record.source && JSON.stringify(record.source) !== JSON.stringify(profile.source))
        )
          fail('import_receipt_invalid', false);
        else {
          record.source = profile.source;
          record.profileKind = profile.projectKind;
          record.published = true;
          try {
            await this.options.publish(this.target(record), profile);
            record.outcome = 'imported';
            record.retryable = false;
            record.errorCode = null;
          } catch {
            fail('import_registry_failed', true);
          }
        }
      } else {
        record.outcome = receipt.outcome;
        record.retryable = receipt.outcome === 'failed' && receipt.retryable;
        record.errorCode = receipt.errorCode;
        // The guest tombstone is authoritative even when the host crashed
        // before persisting its own cancellation intent.
        if (receipt.outcome === 'cancelled') record.cancelRequested = true;
      }
    }
    try {
      await this.persist();
    } catch {
      fail('import_storage_failed', record.outcome === 'imported' || record.retryable);
    }
    return this.result(record);
  }
  async import(input: AppImportRequest): Promise<AppImportOutcome> {
    await this.loaded();
    if (this.closing) throw new Error('import_service_closing');
    const competing = [...this.records.values()].some(
      (other) =>
        other.importOperationId !== input.importOperationId && other.projectId === input.projectId && other.outcome !== 'cancelled',
    );
    if (competing) throw new Error('import_target_conflict');
    if (!this.records.has(input.importOperationId) && this.options.app(input)) throw new Error('import_target_conflict');
    const record = this.record({ workspaceId: input.workspaceId, projectId: input.projectId, importOperationId: input.importOperationId });
    const profileKind = 'edu-web';
    if (
      (record.profileKind !== null && record.profileKind !== profileKind) ||
      (record.source && JSON.stringify(record.source) !== JSON.stringify(input.source))
    )
      throw new Error('import_operation_conflict');
    record.profileKind ??= profileKind;
    record.source ??= structuredClone(input.source);
    if (record.pending) return record.pending;
    if (record.outcome === 'cancelled' || (record.outcome === 'failed' && !record.retryable)) return this.result(record);
    if (record.outcome === 'imported' && this.options.app(this.target(record))) return this.result(record);
    record.outcome = 'pending';
    record.retryable = false;
    record.errorCode = null;
    return this.schedule(record, structuredClone(input.files));
  }
  async cancel(input: AppImportTarget): Promise<AppImportOutcome> {
    await this.loaded();
    if (!this.records.has(input.importOperationId) && this.options.app(input)) throw new Error('import_target_conflict');
    const record = this.record(input);
    record.cancelRequested = true;
    if (record.pending) {
      // Persist the revocation promptly; the running attempt also persists its
      // terminal outcome and remains responsible for stopping/reconciliation.
      void this.persist().catch(() => undefined);
      if (record.copying && record.worker) void this.close(record);
      return record.pending;
    }
    if (record.outcome === 'cancelled') return this.result(record);
    return this.schedule(record);
  }
  async shutdown() {
    this.closing = true;
    await this.loaded();
    const errors: unknown[] = [];
    for (const record of this.records.values())
      if (record.pending || record.worker || (record.dispatched && (record.outcome === 'pending' || record.outcome === 'failed'))) {
        try {
          const result = await this.cancel(this.target(record));
          if (result.outcome === 'failed' && !result.retryable) throw new Error('import_cleanup_unknown');
        } catch (error) {
          errors.push(error);
        }
      }
    if (errors.length) throw new AggregateError(errors, 'import_cleanup_unknown');
  }
}
