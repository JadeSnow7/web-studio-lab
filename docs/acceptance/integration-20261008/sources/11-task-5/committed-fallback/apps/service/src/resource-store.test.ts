import { createHash } from 'node:crypto';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
  invokeChannels,
  PageResourceSnapshotSchema,
  ResourceBundleSchema,
  ResourceCollectionSchema,
  type PageResourceSnapshot,
  type GuestPageResourceSnapshot,
} from '@wsl/protocol';
import { ResourceStore } from './resource-store';

const sha = (value: string) => createHash('sha256').update(value).digest('hex');
const snapshot = (
  text = 'Example Domain',
  url = 'https://example.com/',
): Extract<PageResourceSnapshot, { extractionVersion: 'html-text-v1' }> => ({
  page: { webContentsId: 7, documentGeneration: 2, url, title: 'Example Domain', partition: 'persist:preview' },
  requestedUrl: url,
  url,
  title: 'Example Domain',
  text,
  capturedAt: '2026-10-06T12:00:00.000Z',
  sourceSha256: sha('<html>source</html>'),
  contentSha256: sha(text),
  extractionVersion: 'html-text-v1',
  truncated: false,
});
let root: string;
let store: ResourceStore;
beforeEach(async () => {
  root = await mkdtemp(path.join(tmpdir(), 'wsl-resources-'));
  store = new ResourceStore(root);
});
afterEach(async () => {
  await rm(root, { recursive: true, force: true });
});

describe('空间资源的权威存储', () => {
  it('持久化真实快照；同 URL 内容重复幂等，正文变化递增版本', async () => {
    const first = await store.save('taskflow-demo', snapshot());
    expect(first.revision).toBe(1);
    expect(first.resources[0]).toMatchObject({ version: 1, text: 'Example Domain', url: 'https://example.com/' });
    expect(await store.save('taskflow-demo', snapshot())).toEqual(first);
    const changed = await store.save('taskflow-demo', snapshot('Updated'));
    expect(changed.revision).toBe(2);
    expect(changed.resources[0]?.resourceId).toBe(first.resources[0]?.resourceId);
    expect(changed.resources[0]?.version).toBe(2);
    expect(await new ResourceStore(root).list('taskflow-demo')).toEqual(changed);
  });
  it('资源身份随空间隔离，删除后不可读，其他空间不变', async () => {
    const a = await store.save('taskflow-demo', snapshot());
    const b = await store.save('second-space', snapshot());
    expect(a.resources[0]?.resourceId).not.toBe(b.resources[0]?.resourceId);
    await expect(store.remove('second-space', a.resources[0]!.resourceId)).rejects.toThrow();
    await store.remove('taskflow-demo', a.resources[0]!.resourceId);
    expect((await store.list('taskflow-demo')).resources).toEqual([]);
    expect(await store.list('second-space')).toEqual(b);
  });
  it('显式更新只接受同 URL 的已有身份', async () => {
    const first = await store.save('taskflow-demo', snapshot());
    await expect(
      store.save('taskflow-demo', snapshot('other', 'https://docs.docker.com/'), first.resources[0]!.resourceId),
    ).rejects.toThrow();
    expect(await store.list('taskflow-demo')).toEqual(first);
  });
  it('拒绝路径空间、摘要伪造、导航身份错绑与 UTF-8 超量正文', async () => {
    await expect(store.list('../outside')).rejects.toThrow();
    await expect(store.save('taskflow-demo', { ...snapshot(), contentSha256: '0'.repeat(64) })).rejects.toThrow();
    await expect(
      store.save('taskflow-demo', { ...snapshot(), page: { ...snapshot().page, url: 'https://other.example/' } }),
    ).rejects.toThrow();
    await expect(store.save('taskflow-demo', snapshot('字'.repeat(21846)))).rejects.toThrow();
    expect((await store.list('taskflow-demo')).resources).toHaveLength(0);
  });
  it('并发保存串行提交，不丢记录；空间最多 16 条', async () => {
    await Promise.all(Array.from({ length: 16 }, (_, i) => store.save('taskflow-demo', snapshot(`page ${i}`, `https://example.com/${i}`))));
    expect((await store.list('taskflow-demo')).resources).toHaveLength(16);
    await expect(store.save('taskflow-demo', snapshot('overflow', 'https://example.com/17'))).rejects.toThrow();
  });
  it('整集合 JSON 有界，失败保留此前提交', async () => {
    for (let i = 0; i < 7; i++) await store.save('taskflow-demo', snapshot('x'.repeat(65536), `https://example.com/${i}`));
    const before = await store.list('taskflow-demo');
    await expect(store.save('taskflow-demo', snapshot('x'.repeat(65536), 'https://example.com/8'))).rejects.toThrow();
    expect(await store.list('taskflow-demo')).toEqual(before);
  });
  it('损坏持久记录明确失败，不能静默当空列表', async () => {
    await store.save('taskflow-demo', snapshot());
    const file = path.join(root, 'space-resources.json');
    expect(JSON.parse(await readFile(file, 'utf8'))).toBeTruthy();
    await writeFile(file, '{invalid', 'utf8');
    await expect(new ResourceStore(root).list('taskflow-demo')).rejects.toThrow();
  });
});

describe('资源输入边界', () => {
  it('renderer 只能申报页面身份；不能伪造正文、未知字段或其他空间', () => {
    const request = { spaceId: 'taskflow-demo', expectedPage: snapshot().page };
    expect(invokeChannels['resources:capture'].request.safeParse(request).success).toBe(true);
    expect(invokeChannels['resources:capture'].request.safeParse({ ...request, text: 'forged' }).success).toBe(false);
    expect(invokeChannels['resources:list'].request.safeParse({ spaceId: 'second-space' }).success).toBe(false);
    expect(invokeChannels['resources:remove'].request.safeParse({ spaceId: 'taskflow-demo', resourceId: '../../file' }).success).toBe(
      false,
    );
  });
  it('快照拒绝危险 scheme，bundle 校验资源所属空间及字节上限', () => {
    expect(PageResourceSnapshotSchema.safeParse(snapshot('local', 'file:///etc/passwd')).success).toBe(false);
    const resource = { ...snapshot(), spaceId: 'second-space', resourceId: '7d772386-eccb-4b61-a184-bbfb736b9441', version: 1 };
    expect(
      ResourceBundleSchema.safeParse({
        conversationId: 'conv-space-taskflow-demo-impl',
        generation: 'g',
        turnId: 't',
        spaceId: 'taskflow-demo',
        collectionRevision: 1,
        resources: [resource],
      }).success,
    ).toBe(false);
    expect(
      ResourceBundleSchema.safeParse({
        conversationId: 'conv-personal-default',
        generation: 'g',
        turnId: 't',
        spaceId: null,
        collectionRevision: 0,
        resources: [resource],
      }).success,
    ).toBe(false);
  });
});

it('每个接受的接近上限集合都容纳最长合法轮次身份，不先保存后变得不可读取', () => {
  let accepted = 0;
  let rejected = 0;
  for (let lastSize = 53000; lastSize <= 65536; lastSize += 127) {
    const resources = Array.from({ length: 8 }, (_, i) => ({
      ...snapshot('x'.repeat(i === 7 ? lastSize : 65536), `https://example.com/${i}`),
      spaceId: 'taskflow-demo',
      resourceId: `7d772386-eccb-4b61-a184-bbfb736b944${i}`,
      version: 1,
    }));
    const parsed = ResourceCollectionSchema.safeParse({ spaceId: 'taskflow-demo', revision: 8, resources });
    if (!parsed.success) {
      rejected++;
      continue;
    }
    accepted++;
    expect(
      ResourceBundleSchema.safeParse({
        conversationId: 'conv-space-taskflow-demo-impl',
        generation: '\u0000'.repeat(128),
        turnId: '\u0000'.repeat(128),
        spaceId: parsed.data.spaceId,
        collectionRevision: parsed.data.revision,
        resources: parsed.data.resources,
      }).success,
    ).toBe(true);
  }
  expect(accepted).toBeGreaterThan(0);
  expect(rejected).toBeGreaterThan(0);
});

const guestSnapshot = (): GuestPageResourceSnapshot => ({
  ...snapshot(),
  page: {
    kind: 'sandbox-chromium',
    sandboxName: 'wsl-sbx-smoke-20261006',
    browserInstanceId: '5cd9a82c-d94e-4774-854d-e58083e49e9b',
    targetId: 'CDP-TARGET-1',
    navigationEpoch: 1,
    url: 'https://example.com/',
    title: 'Example Domain',
  },
  extractionVersion: 'rendered-dom-text-v1',
  sourceKind: 'decoded-main-response',
  captureId: '9106578b-e2ce-4c19-a8b7-06753245eaa5',
  screenshotSha256: 'c'.repeat(64),
});

describe('guest capture versions refer to the complete captured artifact', () => {
  it('an exact retry is idempotent even when JSON key order changes, and persists provenance', async () => {
    const input = guestSnapshot();
    const first = await store.save('taskflow-demo', input);
    const reordered = Object.fromEntries(Object.entries(input).reverse()) as GuestPageResourceSnapshot;
    reordered.page = Object.fromEntries(Object.entries(input.page).reverse()) as GuestPageResourceSnapshot['page'];
    expect(await store.save('taskflow-demo', reordered, first.resources[0]!.resourceId)).toEqual(first);
    expect(await new ResourceStore(root).list('taskflow-demo')).toEqual(first);
    expect(first.resources[0]).toMatchObject({ captureId: input.captureId, screenshotSha256: input.screenshotSha256, page: input.page });
  });

  const changedArtifacts: [string, (input: GuestPageResourceSnapshot) => void][] = [
    [
      'capture',
      (input) => {
        input.captureId = '047e64b6-7f96-4402-ad2c-c1a3d789aa21';
      },
    ],
    [
      'capture time',
      (input) => {
        input.capturedAt = '2026-10-06T16:01:00.000Z';
      },
    ],
    [
      'main response',
      (input) => {
        input.sourceSha256 = 'd'.repeat(64);
      },
    ],
    [
      'screenshot',
      (input) => {
        input.screenshotSha256 = 'd'.repeat(64);
      },
    ],
    [
      'browser',
      (input) => {
        input.page.browserInstanceId = '047e64b6-7f96-4402-ad2c-c1a3d789aa21';
      },
    ],
    [
      'target',
      (input) => {
        input.page.targetId = 'CDP-TARGET-2';
      },
    ],
    [
      'navigation',
      (input) => {
        input.page.navigationEpoch = 2;
      },
    ],
    [
      'sandbox',
      (input) => {
        input.page.sandboxName = 'different-sandbox';
      },
    ],
    [
      'requested URL',
      (input) => {
        input.requestedUrl = 'https://example.com/redirect';
      },
    ],
    [
      'truncation',
      (input) => {
        input.truncated = true;
      },
    ],
  ];
  it.each(changedArtifacts)('a new %s produces a new version even when text is unchanged', async (_label, mutate) => {
    const first = await store.save('taskflow-demo', guestSnapshot());
    const changed = guestSnapshot();
    mutate(changed);
    const second = await store.save('taskflow-demo', changed);
    expect(second.revision).toBe(2);
    expect(second.resources[0]).toMatchObject({ ...changed, resourceId: first.resources[0]!.resourceId, version: 2 });
    expect(await store.save('taskflow-demo', changed)).toEqual(second);
  });
  it('crossing host and guest capture sources never returns stale provenance', async () => {
    const host = await store.save('taskflow-demo', snapshot());
    const guest = await store.save('taskflow-demo', guestSnapshot());
    expect(guest.resources[0]).toMatchObject({
      resourceId: host.resources[0]!.resourceId,
      version: 2,
      extractionVersion: 'rendered-dom-text-v1',
    });
    const backToHost = await store.save('taskflow-demo', snapshot());
    expect(backToHost.resources[0]).toMatchObject({
      resourceId: host.resources[0]!.resourceId,
      version: 3,
      extractionVersion: 'html-text-v1',
    });
    expect(backToHost.resources[0]).not.toHaveProperty('captureId');
  });
  it('rejects a forged guest text digest without replacing the prior capture', async () => {
    const first = await store.save('taskflow-demo', guestSnapshot());
    await expect(store.save('taskflow-demo', { ...guestSnapshot(), text: 'tampered' })).rejects.toThrow();
    expect(await store.list('taskflow-demo')).toEqual(first);
  });
});
