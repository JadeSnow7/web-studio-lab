import { randomUUID } from 'node:crypto';
import { mkdir, open, readFile, rename, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { z } from 'zod';
import { RunSourceRepository } from './run-source-repository';
import {
  type AppSourceSnapshot,
  type CapturedSourceChange,
  WorkbenchSnapshotSchema,
  WorkbenchResourceSchema,
  WorkbenchSessionSchema,
  WorkbenchTabSchema,
  WorkspaceSnapshotSchema,
  SpaceAppSchema,
  HarnessSelectionSchema,
  TaskProjectSchema,
  ObservationRecordSchema,
  type ObservationRecord,
  type WorkbenchSession,
  type WorkbenchSnapshot,
  type WorkbenchTab,
  type WorkspaceSnapshot,
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
// The App metadata branch and the resource catalog branch both persisted version 3.
// An explicit App field on every workspace identifies the catalog-free branch;
// missing catalog bytes alone must not make a damaged catalog file migratable.
const SpaceAppV3Snapshot = LegacyWorkbenchSnapshotSchema.extend({
  workspaces: z.array(LegacyWorkspaceSnapshotSchema.extend({ app: SpaceAppSchema.nullable() })).min(1),
});
/** 当前持久化版本（OPS-1 R1）。只有这一版不需要迁移备份；更新的版本拒绝加载并保留原文件。 */
const CURRENT_SCHEMA = 5;
/** Fields schema 5 added; a schema 4 body that carries any of them is not a genuine schema 4 file. */
const SCHEMA5_SESSION_FIELDS = { taskProject: true, taskProjectDecided: true } as const;
// Schema 4 (W4 tip): no session project selection and no tab title mode; harnessSelection may be absent (default null).
// Frozen shape: the current schemas minus the schema 5 fields. A later batch that adds a required session or tab field
// must omit it here too, otherwise genuine schema 4 files stop migrating (repository.test.ts covers a real v4 body).
const SchemaV4Snapshot = WorkbenchSnapshotSchema.extend({
  workspaces: z.array(
    WorkspaceSnapshotSchema.extend({
      tabs: z.array(WorkbenchTabSchema.omit({ autoTitle: true })),
      sessions: z.array(
        WorkbenchSessionSchema.omit(SCHEMA5_SESSION_FIELDS).extend({
          taskProject: z.never().optional(),
          taskProjectDecided: z.never().optional(),
        }),
      ),
    }),
  ),
});
// Schema 5 writes W4's harnessSelection and the OPS fields explicitly; a body missing them is malformed, not defaulted,
// and a session with unknown keys is refused rather than stripped.
const SchemaV5Snapshot = WorkbenchSnapshotSchema.extend({
  workspaces: z.array(
    WorkspaceSnapshotSchema.extend({
      tabs: z.array(WorkbenchTabSchema.extend({ autoTitle: z.boolean() })),
      sessions: z.array(
        WorkbenchSessionSchema.extend({
          harnessSelection: HarnessSelectionSchema.nullable(),
          taskProject: TaskProjectSchema.nullable(),
          taskProjectDecided: z.boolean(),
        }).strict(),
      ),
    }),
  ),
});
const FileSchema = z.union([
  z.object({ schemaVersion: z.literal(1), snapshot: LegacySnapshot }).strict(),
  z.object({ schemaVersion: z.literal(2), snapshot: LegacyWorkbenchSnapshotSchema }).strict(),
  z.object({ schemaVersion: z.literal(3), snapshot: WorkbenchSnapshotSchema, catalog: ResourceCatalogStateSchema }).strict(),
  z.object({ schemaVersion: z.literal(3), snapshot: SpaceAppV3Snapshot }).strict(),
  z.object({ schemaVersion: z.literal(4), snapshot: SchemaV4Snapshot, catalog: ResourceCatalogStateSchema }).strict(),
  z.object({ schemaVersion: z.literal(CURRENT_SCHEMA), snapshot: SchemaV5Snapshot, catalog: ResourceCatalogStateSchema }).strict(),
]);
type PreSchema5Snapshot = Omit<WorkbenchSnapshot, 'workspaces'> & {
  workspaces: Array<
    Omit<WorkspaceSnapshot, 'tabs' | 'sessions'> & {
      tabs: Array<Omit<WorkbenchTab, 'autoTitle'>>;
      sessions: Array<Omit<WorkbenchSession, keyof typeof SCHEMA5_SESSION_FIELDS>>;
    }
  >;
};
/**
 * 迁移到 schema 5（OPS-1 R1）：旧标签一律为手动标题，旧会话的工程选择为空且“尚未决定”（之后首次采集受管 App 页面时由 Main
 * 自动开启）。历史任务版本（含已冻结的 appTarget）原样保留，不从页面、App 或任务文字推断、回填；harnessSelection 原样保留。
 */
function migrateToSchema5(snapshot: PreSchema5Snapshot): WorkbenchSnapshot {
  return {
    ...snapshot,
    workspaces: snapshot.workspaces.map((workspace) => ({
      ...workspace,
      tabs: workspace.tabs.map((tab) => ({ ...tab, autoTitle: false })),
      sessions: workspace.sessions.map((session) => ({ ...session, taskProject: null, taskProjectDecided: false })),
    })),
  };
}
/** Writes and fsyncs a file before it is renamed over the original or relied on as a migration backup. */
async function writeDurably(file: string, contents: string, flag: 'w' | 'wx', mode: number): Promise<void> {
  const handle = await open(file, flag, mode);
  try {
    await handle.writeFile(contents);
    await handle.sync();
  } finally {
    await handle.close();
  }
}
type CatalogBoundSnapshot = { workspaces: Array<Pick<WorkspaceSnapshot, 'workspaceId' | 'resources' | 'runs'>> };
/** Digests are verified where bodies enter: capture, migration and file load. Saves of Main-owned state skip rehashing. */
export function assertCatalogBindings(snapshot: CatalogBoundSnapshot, catalog: ResourceCatalogState, verifyDigests = true): void {
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
/** Legacy Apps already have a stable project identity; derive metadata without creating or starting a project. */
function migrateAppDescriptions(snapshot: WorkbenchSnapshot): WorkbenchSnapshot {
  return {
    ...snapshot,
    workspaces: snapshot.workspaces.map((workspace) => ({
      ...workspace,
      app:
        workspace.app ??
        (workspace.managedApp
          ? {
              appId: workspace.managedApp.projectId,
              workspaceId: workspace.workspaceId,
              projectId: workspace.managedApp.projectId,
              name: workspace.resources.find((resource) => resource.appProjectId === workspace.managedApp?.projectId)?.title ?? '标准应用',
              description: '',
              revision: 0,
            }
          : null),
    })),
  };
}
export interface WorkbenchRepository {
  readonly migrationPending: boolean;
  load(): Promise<WorkbenchSnapshot | null>;
  loadCatalog(snapshot: WorkbenchSnapshot | null): Promise<ResourceCatalogState>;
  save(snapshot: WorkbenchSnapshot, catalog: ResourceCatalogState): Promise<void>;
  appendObservation(record: ObservationRecord): Promise<string>;
  createSourceBaseline?(runId: string, source: AppSourceSnapshot, signal: AbortSignal): Promise<{ baseTree: string }>;
  captureSourceChange?(runId: string, baseTree: string, source: AppSourceSnapshot, signal: AbortSignal): Promise<CapturedSourceChange>;
  readRunPatch?(runId: string, patchSha256: string): Promise<string>;
}
export class FileWorkbenchRepository implements WorkbenchRepository {
  private loadedFile: z.infer<typeof FileSchema> | null | undefined;
  private readonly sourceRepository: RunSourceRepository;
  constructor(private readonly file: string) {
    this.sourceRepository = new RunSourceRepository(path.join(path.dirname(file), 'runs'));
  }
  createSourceBaseline(runId: string, source: AppSourceSnapshot, signal: AbortSignal) {
    return this.sourceRepository.createBaseline(runId, source, signal);
  }
  captureSourceChange(runId: string, baseTree: string, source: AppSourceSnapshot, signal: AbortSignal) {
    return this.sourceRepository.capture(runId, baseTree, source, signal);
  }
  readRunPatch(runId: string, patchSha256: string) {
    return this.sourceRepository.readPatch(runId, patchSha256);
  }

  get migrationPending(): boolean {
    return this.loadedFile != null && this.loadedFile.schemaVersion !== CURRENT_SCHEMA;
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
    if ('catalog' in stored) {
      parseResourceCatalog(stored.catalog);
      assertCatalogBindings(stored.snapshot, stored.catalog);
      if (stored.schemaVersion === CURRENT_SCHEMA) return stored.snapshot;
      return migrateToSchema5(stored.schemaVersion === 4 ? stored.snapshot : migrateAppDescriptions(stored.snapshot));
    }
    if (stored.schemaVersion === 2 || stored.schemaVersion === 3)
      return this.migrateLegacy({
        ...WorkbenchSnapshotSchema.parse(stored.snapshot),
        workspaces: stored.snapshot.workspaces.map((workspace) => ({
          ...WorkspaceSnapshotSchema.parse(workspace),
          resources: workspace.resources.map(({ catalogResourceId: _catalogResourceId, ...resource }) => resource),
        })),
      });
    return this.migrateLegacy(
      WorkbenchSnapshotSchema.parse({
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
      }),
    );
  }
  /** Schema 1–3 (no catalog): App descriptions first, then the schema 5 fields. */
  private migrateLegacy(snapshot: WorkbenchSnapshot): WorkbenchSnapshot {
    return migrateToSchema5(migrateAppDescriptions(snapshot));
  }
  async loadCatalog(snapshot: WorkbenchSnapshot | null): Promise<ResourceCatalogState> {
    if (this.loadedFile === undefined) await this.load();
    const file = this.loadedFile;
    if (file && 'catalog' in file) {
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
    const validated = FileSchema.parse({ schemaVersion: CURRENT_SCHEMA, snapshot: business, catalog });
    // Freeze the accepted business/catalog bytes before backup or filesystem I/O can yield.
    const serialized = JSON.stringify({ schemaVersion: CURRENT_SCHEMA, snapshot: business, catalog });
    let previous: string | undefined;
    // A current-schema file this repository loaded or wrote needs no backup; only unknown or legacy bytes are re-read.
    if (this.loadedFile?.schemaVersion !== CURRENT_SCHEMA)
      try {
        previous = await readFile(this.file, 'utf8');
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
      }
    if (previous !== undefined) {
      const old = FileSchema.parse(JSON.parse(previous));
      if (old.schemaVersion !== CURRENT_SCHEMA) {
        const backup = this.file + '.legacy-schema-' + old.schemaVersion + '.json';
        try {
          // Never overwrite an existing backup; the original bytes must be durable before the file is replaced.
          await writeDurably(backup, previous, 'wx', 0o400);
        } catch (error) {
          if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error;
          if ((await readFile(backup, 'utf8')) !== previous)
            throw new Error(
              `conflict: 旧工作台迁移备份与来源不一致；${path.basename(this.file)} 未改动，移走或核对 ${path.basename(backup)} 后才能迁移`,
              { cause: error },
            );
        }
      }
    }
    await mkdir(path.dirname(this.file), { recursive: true });
    const pending = this.file + '.pending';
    await writeDurably(pending, serialized, 'w', 0o600);
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
