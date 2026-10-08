import { randomUUID } from 'node:crypto';
import { mkdir, readFile, rename, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { z } from 'zod';
import {
  WorkbenchSnapshotSchema,
  WorkbenchResourceSchema,
  WorkspaceSnapshotSchema,
  ObservationRecordSchema,
  type ObservationRecord,
  type WorkbenchSnapshot,
} from '@wsl/protocol';
const LegacySnapshot = WorkbenchSnapshotSchema.extend({
  workspaces: z.array(WorkspaceSnapshotSchema.extend({ resources: z.array(WorkbenchResourceSchema.omit({ environmentId: true })) })),
});
const FileSchema = z.discriminatedUnion('schemaVersion', [
  z.object({ schemaVersion: z.literal(1), snapshot: LegacySnapshot }).strict(),
  z.object({ schemaVersion: z.literal(2), snapshot: WorkbenchSnapshotSchema }).strict(),
]);
export interface WorkbenchRepository {
  load(): Promise<WorkbenchSnapshot | null>;
  save(snapshot: WorkbenchSnapshot): Promise<void>;
  appendObservation(record: ObservationRecord): Promise<string>;
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
    const stored = FileSchema.parse(JSON.parse(contents));
    if (stored.schemaVersion === 2) return stored.snapshot;
    return WorkbenchSnapshotSchema.parse({
      ...stored.snapshot,
      workspaces: stored.snapshot.workspaces.map((workspace) => ({
        ...workspace,
        resources: workspace.resources.map((resource) => ({
          ...resource,
          environmentId: resource.kind === 'web' ? 'local' : resource.kind === 'terminal' ? 'sandbox' : null,
          unavailableReason: ['file', 'ssh'].includes(resource.kind)
            ? '旧占位资源未绑定授权环境，请新建已配置资源'
            : resource.unavailableReason,
        })),
      })),
    });
  }
  async save(snapshot: WorkbenchSnapshot): Promise<void> {
    await mkdir(path.dirname(this.file), { recursive: true });
    const pending = this.file + '.pending';
    // Process and native handles are runtime leases. Persist business history only.
    const { notifications: _notifications, ...stored } = snapshot;
    const business = {
      ...stored,
      workspaces: stored.workspaces.map((workspace) => ({
        ...workspace,
        resources: workspace.resources.map((resource) => ({
          ...resource,
          instanceId: null,
          preview: null,
          terminal: resource.terminal
            ? {
                ...resource.terminal,
                sessionId: null,
                cwd: null,
                state: 'closed',
                error: resource.terminal.cleanupPending ? '应用重启；旧进程清理未确认，不自动重放' : resource.terminal.error,
              }
            : null,
        })),
      })),
    };
    await writeFile(pending, JSON.stringify({ schemaVersion: 2, snapshot: business }), { mode: 0o600 });
    await rename(pending, this.file);
  }
  async appendObservation(record: ObservationRecord): Promise<string> {
    const ref = path.join('observations', randomUUID() + '.json');
    await mkdir(path.join(path.dirname(this.file), 'observations'), { recursive: true, mode: 0o700 });
    await writeFile(path.join(path.dirname(this.file), ref), JSON.stringify(ObservationRecordSchema.parse(record)), {
      flag: 'wx',
      mode: 0o600,
    });
    return ref;
  }
}
