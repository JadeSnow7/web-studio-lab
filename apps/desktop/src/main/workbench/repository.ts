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
  ResourceCatalogStateSchema,
  type ResourceCatalogState,
} from '@wsl/protocol';
import {
  LegacyWorkbenchSnapshotSchema,
  LegacyWorkspaceSnapshotSchema,
  migrateLegacyCatalog,
  parseResourceCatalog,
} from './resource-catalog-repository';
import { assertResourceDigest, createResourceCatalog } from './resource-catalog';
const LegacySnapshot = WorkbenchSnapshotSchema.extend({
  workspaces: z.array(LegacyWorkspaceSnapshotSchema.extend({ resources: z.array(WorkbenchResourceSchema.omit({ environmentId: true })) })),
});
const FileSchema = z.discriminatedUnion('schemaVersion', [
  z.object({ schemaVersion: z.literal(1), snapshot: LegacySnapshot }).strict(),
  z.object({ schemaVersion: z.literal(2), snapshot: LegacyWorkbenchSnapshotSchema }).strict(),
  z.object({ schemaVersion: z.literal(3), snapshot: WorkbenchSnapshotSchema, catalog: ResourceCatalogStateSchema }).strict(),
]);
/** Digests are verified where bodies enter: capture, migration and file load. Saves of Main-owned state skip rehashing. */
export function assertCatalogBindings(snapshot: WorkbenchSnapshot, catalog: ResourceCatalogState, verifyDigests = true): void {
  for (const workspace of snapshot.workspaces)
    for (const run of workspace.runs)
      if (run.referenceSnapshot) {
        const reference = run.referenceSnapshot;
        if (
          reference.accountId !== catalog.accountId ||
          reference.workspaceId !== workspace.workspaceId ||
          reference.sessionId !== run.sessionId
        )
          throw new Error('invalid_input: 历史参考归属不一致');
        if (verifyDigests) for (const revision of reference.resources) assertResourceDigest(revision);
      }
  for (const workspace of snapshot.workspaces)
    for (const resource of workspace.resources) {
      if (resource.kind === 'session') {
        if (resource.catalogResourceId) throw new Error('invalid_input: 会话不能关联账户资源');
        continue;
      }
      if (
        !resource.catalogResourceId ||
        !catalog.resources.some((item) => item.resourceId === resource.catalogResourceId) ||
        !catalog.links.some((link) => link.workspaceId === workspace.workspaceId && link.resourceId === resource.catalogResourceId)
      )
        throw new Error('invalid_input: 运行绑定的账户资源或空间连接不存在');
    }
}
export interface WorkbenchRepository {
  readonly migrationPending: boolean;
  load(): Promise<WorkbenchSnapshot | null>;
  loadCatalog(snapshot: WorkbenchSnapshot | null): Promise<ResourceCatalogState>;
  save(snapshot: WorkbenchSnapshot, catalog: ResourceCatalogState): Promise<void>;
  appendObservation(record: ObservationRecord): Promise<string>;
}
export class FileWorkbenchRepository implements WorkbenchRepository {
  private loadedFile: z.infer<typeof FileSchema> | null | undefined;
  constructor(private readonly file: string) {}
  get migrationPending(): boolean {
    return this.loadedFile != null && this.loadedFile.schemaVersion !== 3;
  }
  async load(): Promise<WorkbenchSnapshot | null> {
    let contents: string;
    try {
      contents = await readFile(this.file, 'utf8');
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') {
        this.loadedFile = null;
        return null;
      }
      throw error;
    }
    const stored = FileSchema.parse(JSON.parse(contents));
    this.loadedFile = stored;
    if (stored.schemaVersion === 3) {
      parseResourceCatalog(stored.catalog);
      assertCatalogBindings(stored.snapshot, stored.catalog);
      return stored.snapshot;
    }
    if (stored.schemaVersion === 2)
      return {
        ...WorkbenchSnapshotSchema.parse(stored.snapshot),
        workspaces: stored.snapshot.workspaces.map((workspace) => ({
          ...WorkspaceSnapshotSchema.parse(workspace),
          resources: workspace.resources.map(({ catalogResourceId: _catalogResourceId, ...resource }) => resource),
        })),
      };
    return WorkbenchSnapshotSchema.parse({
      ...stored.snapshot,
      workspaces: stored.snapshot.workspaces.map((workspace) => ({
        ...workspace,
        resources: workspace.resources.map((resource) => ({
          ...resource,
          catalogResourceId: undefined,
          environmentId: resource.kind === 'web' ? 'local' : resource.kind === 'terminal' ? 'sandbox' : null,
          unavailableReason: ['file', 'ssh'].includes(resource.kind)
            ? '旧占位资源未绑定授权环境，请新建已配置资源'
            : resource.unavailableReason,
        })),
      })),
    });
  }
  async loadCatalog(snapshot: WorkbenchSnapshot | null): Promise<ResourceCatalogState> {
    if (this.loadedFile === undefined) await this.load();
    const file = this.loadedFile;
    if (file?.schemaVersion === 3) {
      assertCatalogBindings(file.snapshot, file.catalog);
      return parseResourceCatalog(file.catalog);
    }
    let legacy: unknown = { schemaVersion: 1, collections: [] };
    try {
      legacy = JSON.parse(await readFile(path.join(path.dirname(this.file), 'chat', 'space-resources.json'), 'utf8')) as unknown;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
    }
    const source = snapshot
      ? {
          ...snapshot,
          workspaces: snapshot.workspaces.map((workspace) => ({
            ...workspace,
            publicResources: file?.snapshot.workspaces.find((item) => item.workspaceId === workspace.workspaceId)?.publicResources,
          })),
        }
      : null;
    return migrateLegacyCatalog(createResourceCatalog(randomUUID()), source, legacy, new Date().toISOString());
  }
  async save(snapshot: WorkbenchSnapshot, catalog: ResourceCatalogState): Promise<void> {
    // FileSchema below still validates the complete structure; only the per-save body rehash is skipped.
    assertCatalogBindings(snapshot, catalog, false);
    // Process and native handles are runtime leases. Persist business history only.
    const { notifications: _notifications, catalog: _catalog, ...stored } = snapshot;
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
    const validated = FileSchema.parse({ schemaVersion: 3, snapshot: business, catalog });
    let previous: string | undefined;
    // A schema3 file this repository loaded or wrote needs no backup; only unknown or legacy bytes are re-read.
    if (this.loadedFile?.schemaVersion !== 3)
      try {
        previous = await readFile(this.file, 'utf8');
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
      }
    if (previous !== undefined) {
      const old = FileSchema.parse(JSON.parse(previous));
      if (old.schemaVersion !== 3) {
        const backup = this.file + '.legacy-schema-' + old.schemaVersion + '.json';
        try {
          await writeFile(backup, previous, { flag: 'wx', mode: 0o400 });
        } catch (error) {
          if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error;
          if ((await readFile(backup, 'utf8')) !== previous) throw new Error('conflict: 旧工作台迁移备份与来源不一致', { cause: error });
        }
      }
    }
    await mkdir(path.dirname(this.file), { recursive: true });
    const pending = this.file + '.pending';
    await writeFile(pending, JSON.stringify({ schemaVersion: 3, snapshot: business, catalog }), { mode: 0o600 });
    await rename(pending, this.file);
    this.loadedFile = validated;
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
