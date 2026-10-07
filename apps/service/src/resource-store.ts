import { createHash, randomUUID } from 'node:crypto';
import { mkdir, open, rename, rm } from 'node:fs/promises';
import path from 'node:path';
import { z } from 'zod';
import {
  PageResourceSnapshotSchema,
  ResourceCollectionSchema,
  ResourceStoreSpaceIdSchema,
  type PageResourceSnapshot,
  type ResourceCollection,
} from '@wsl/protocol';

const StoreSchema = z
  .object({ schemaVersion: z.literal(1), collections: z.array(ResourceCollectionSchema) })
  .strict()
  .refine((store) => new Set(store.collections.map((collection) => collection.spaceId)).size === store.collections.length, '空间身份重复');
type Store = z.infer<typeof StoreSchema>;
const sha = (text: string) => createHash('sha256').update(text, 'utf8').digest('hex');
// Parsing canonicalizes property order; remove only store-owned identity fields.
// New guest navigation/capture evidence is a new version even if its text matches.
function sameSnapshot(existing: PageResourceSnapshot, snapshot: PageResourceSnapshot): boolean {
  if (existing.extractionVersion !== snapshot.extractionVersion) return false;
  if (existing.extractionVersion === 'html-text-v1' && snapshot.extractionVersion === 'html-text-v1')
    return existing.contentSha256 === snapshot.contentSha256 && existing.title === snapshot.title;
  const previous = Object.fromEntries(Object.entries(existing).filter(([key]) => !['spaceId', 'resourceId', 'version'].includes(key)));
  return JSON.stringify(PageResourceSnapshotSchema.parse(previous)) === JSON.stringify(snapshot);
}
function assertDigest(snapshot: PageResourceSnapshot): void {
  if (sha(snapshot.text) !== snapshot.contentSha256) throw new Error('正文摘要与快照不一致');
}

/** 仅接收受信捕获接口校验的快照；所有空间共用内部固定文件，不把空间名当路径。 */
export class ResourceStore {
  private readonly file: string;
  private operations: Promise<void> = Promise.resolve();
  constructor(private readonly root: string) {
    this.file = path.join(root, 'space-resources.json');
  }
  private serial<T>(operation: () => Promise<T>): Promise<T> {
    const result = this.operations.then(operation);
    // 单次失败交给调用者；后续独立请求仍可尝试，不掩盖当前提交的错误。
    this.operations = result.then(
      () => undefined,
      () => undefined,
    );
    return result;
  }
  private async load(): Promise<Store> {
    let handle;
    try {
      handle = await open(this.file, 'r');
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') return { schemaVersion: 1, collections: [] };
      throw error;
    }
    try {
      if ((await handle.stat()).size > 16 * 1024 * 1024) throw new Error('资源存储超过文件大小限制');
      const store = StoreSchema.parse(JSON.parse(await handle.readFile('utf8')));
      for (const collection of store.collections) for (const resource of collection.resources) assertDigest(resource);
      return store;
    } finally {
      await handle.close();
    }
  }
  private async persist(store: Store): Promise<void> {
    const data = JSON.stringify(StoreSchema.parse(store));
    if (Buffer.byteLength(data, 'utf8') > 16 * 1024 * 1024) throw new Error('资源存储超过文件大小限制');
    await mkdir(this.root, { recursive: true, mode: 0o700 });
    const temporary = path.join(this.root, `.space-resources-${randomUUID()}.tmp`);
    try {
      const handle = await open(temporary, 'wx', 0o600);
      try {
        await handle.writeFile(data, 'utf8');
        await handle.sync();
      } finally {
        await handle.close();
      }
      await rename(temporary, this.file);
    } finally {
      await rm(temporary, { force: true });
    }
  }
  async list(spaceId: string): Promise<ResourceCollection> {
    ResourceStoreSpaceIdSchema.parse(spaceId);
    return this.serial(
      async () =>
        (await this.load()).collections.find((collection) => collection.spaceId === spaceId) ?? { spaceId, revision: 0, resources: [] },
    );
  }
  async save(spaceId: string, input: PageResourceSnapshot, resourceId?: string): Promise<ResourceCollection> {
    ResourceStoreSpaceIdSchema.parse(spaceId);
    const snapshot = PageResourceSnapshotSchema.parse(input);
    assertDigest(snapshot);
    if (resourceId) z.uuid().parse(resourceId);
    return this.serial(async () => {
      const store = await this.load();
      const current = store.collections.find((collection) => collection.spaceId === spaceId) ?? { spaceId, revision: 0, resources: [] };
      const existing = resourceId
        ? current.resources.find((resource) => resource.resourceId === resourceId)
        : current.resources.find((resource) => resource.url === snapshot.url);
      if (resourceId && !existing) throw new Error('空间资源不存在');
      if (existing && existing.url !== snapshot.url) throw new Error('更新资源必须来自同一 URL');
      if (existing && sameSnapshot(existing, snapshot)) return current;
      const resource = { ...snapshot, spaceId, resourceId: existing?.resourceId ?? randomUUID(), version: (existing?.version ?? 0) + 1 };
      const next = ResourceCollectionSchema.parse({
        spaceId,
        revision: current.revision + 1,
        resources: existing
          ? current.resources.map((item) => (item.resourceId === existing.resourceId ? resource : item))
          : [...current.resources, resource],
      });
      const index = store.collections.findIndex((collection) => collection.spaceId === spaceId);
      if (index === -1) store.collections.push(next);
      else store.collections[index] = next;
      await this.persist(store);
      return next;
    });
  }
  async remove(spaceId: string, resourceId: string): Promise<ResourceCollection> {
    ResourceStoreSpaceIdSchema.parse(spaceId);
    z.uuid().parse(resourceId);
    return this.serial(async () => {
      const store = await this.load();
      const index = store.collections.findIndex((collection) => collection.spaceId === spaceId);
      const current = store.collections[index];
      if (!current || !current.resources.some((resource) => resource.resourceId === resourceId)) throw new Error('空间资源不存在');
      const next = {
        ...current,
        revision: current.revision + 1,
        resources: current.resources.filter((resource) => resource.resourceId !== resourceId),
      };
      store.collections[index] = next;
      await this.persist(store);
      return next;
    });
  }
}
