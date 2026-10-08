import { mkdir, readFile, rename, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { z } from 'zod';
import { WorkbenchSnapshotSchema, type WorkbenchSnapshot } from '@wsl/protocol';
const FileSchema = z.object({ schemaVersion: z.literal(1), snapshot: WorkbenchSnapshotSchema }).strict();
export interface WorkbenchRepository {
  load(): Promise<WorkbenchSnapshot | null>;
  save(snapshot: WorkbenchSnapshot): Promise<void>;
}
export class FileWorkbenchRepository implements WorkbenchRepository {
  constructor(private readonly file: string) {}
  async load(): Promise<WorkbenchSnapshot | null> {
    let contents: string;
    try {
      contents = await readFile(this.file, 'utf8');
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') return null;
      throw error;
    }
    return FileSchema.parse(JSON.parse(contents)).snapshot;
  }
  async save(snapshot: WorkbenchSnapshot): Promise<void> {
    await mkdir(path.dirname(this.file), { recursive: true });
    const pending = this.file + '.pending';
    // Notifications are a projection of run facts; only reading receipts are stored.
    const { notifications: _notifications, ...stored } = snapshot;
    await writeFile(pending, JSON.stringify({ schemaVersion: 1, snapshot: stored }), { mode: 0o600 });
    await rename(pending, this.file);
  }
}
