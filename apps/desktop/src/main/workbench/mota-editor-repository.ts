import { randomUUID } from 'node:crypto';
import { mkdir, open, readFile, rename, unlink } from 'node:fs/promises';
import path from 'node:path';
import { z } from 'zod';
import { MotaEditorBindingSchema, MotaEditorContentSchema, MotaEditorOperationSchema } from '@wsl/protocol';

export const EditorOperationRecordSchema = z
  .object({
    binding: MotaEditorBindingSchema,
    editorSessionId: z.uuid(),
    sessionIndex: z.number().int().positive(),
    metadata: MotaEditorContentSchema,
    operation: MotaEditorOperationSchema,
    phase: z.enum(['staging', 'submitted', 'committed', 'failed', 'unknown']),
    durabilityIssue: z.string().max(200).nullable(),
  })
  .strict()
  .refine((record) => {
    if (record.phase === 'committed' || record.phase === 'failed' || record.phase === 'unknown') {
      if (record.phase !== record.operation.status) return false;
    }
    const receipt = record.operation.receipt;
    return (
      !receipt ||
      (receipt.editorSessionId === record.editorSessionId &&
        receipt.afterHash === record.metadata.contentHash &&
        receipt.file === record.metadata.file &&
        receipt.expectedHash === record.metadata.expectedHash &&
        receipt.contentHash === record.metadata.contentHash &&
        receipt.contentLength === record.metadata.contentLength)
    );
  });
export type EditorOperationRecord = z.infer<typeof EditorOperationRecordSchema>;
const fileSchema = z.object({ schemaVersion: z.literal(1), records: z.array(EditorOperationRecordSchema).max(4096) }).strict();
export interface MotaEditorOperationStore {
  load(): Promise<EditorOperationRecord[]>;
  save(records: EditorOperationRecord[]): Promise<void>;
}

/** Separate from workbench snapshots: this journal can never contain draft bodies. */
export class FileMotaEditorOperationStore implements MotaEditorOperationStore {
  constructor(private readonly file: string) {}
  async load(): Promise<EditorOperationRecord[]> {
    let bytes: string;
    try {
      bytes = await readFile(this.file, 'utf8');
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') return [];
      throw error;
    }
    const records = fileSchema.parse(JSON.parse(bytes)).records;
    const keys = new Set<string>();
    const counts = new Map<string, number>();
    for (const record of records) {
      const key = record.editorSessionId + ':' + record.operation.requestId;
      if (keys.has(key)) throw new Error('编辑器操作记录身份重复');
      keys.add(key);
      const count = (counts.get(record.binding.appInstanceId) ?? 0) + 1;
      if (count > 1024) throw new Error('编辑器操作记录超过实例上限');
      counts.set(record.binding.appInstanceId, count);
      if (!['committed', 'failed'].includes(record.phase)) {
        record.phase = 'unknown';
        record.operation = { requestId: record.operation.requestId, status: 'unknown', receipt: null, error: 'restart_pending' };
      }
    }
    return records;
  }
  async save(records: EditorOperationRecord[]): Promise<void> {
    const bytes = JSON.stringify(fileSchema.parse({ schemaVersion: 1, records })) + '\n';
    const directory = path.dirname(this.file);
    await mkdir(directory, { recursive: true });
    const temporary = path.join(directory, '.mota-editor-' + randomUUID() + '.tmp');
    let published = false;
    try {
      const file = await open(temporary, 'wx', 0o600);
      try {
        await file.writeFile(bytes);
        await file.sync();
      } finally {
        await file.close();
      }
      await rename(temporary, this.file);
      published = true;
      const parent = await open(directory, 'r');
      try {
        await parent.sync();
      } finally {
        await parent.close();
      }
    } finally {
      if (!published)
        await unlink(temporary).catch((error: NodeJS.ErrnoException) => {
          if (error.code !== 'ENOENT') throw error;
        });
    }
  }
}
