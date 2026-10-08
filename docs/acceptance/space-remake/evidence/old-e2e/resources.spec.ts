import { mkdir } from 'node:fs/promises';
import { expect, test, type ElectronApplication, type Page } from '@playwright/test';
import type { PageIdentity, PreviewState, ResourceCollection, SpaceResource, StudioApi } from '../packages/protocol/src/index';
import { launchApp, previewInfo, screensDir, setWindowSize, shot } from './helpers';

interface ResourceFixture {
  collection: ResourceCollection;
  page: PageIdentity;
  text: string;
  captures: number;
  lastPage: PageIdentity | null;
  failRemove: boolean;
  failList: boolean;
}
type FixtureGlobal = typeof globalThis & { resourceUiFixture: ResourceFixture };
let app: ElectronApplication;
let page: Page;
test.afterEach(async () => {
  if (app) await app.close();
});

async function fixture() {
  ({ app, page } = await launchApp());
  await mkdir(screensDir, { recursive: true });
  await setWindowSize(app, 1440, 900);
  const state = await page.evaluate(() => (window as unknown as { studio: StudioApi }).studio.preview.getState());
  const document: PreviewState = {
    ...state,
    loading: false,
    loadError: null,
    page: { ...state.page, url: 'https://example.com/', title: 'Fixture Example Domain', documentGeneration: 99 },
  };
  await app.evaluate(({ ipcMain, BrowserWindow }, preview) => {
    const host = globalThis as FixtureGlobal;
    host.resourceUiFixture = {
      collection: { spaceId: 'taskflow-demo', revision: 0, resources: [] },
      page: preview.page,
      text: 'Fixture-only public body. <script>window.__resourceExecuted=true</script>',
      captures: 0,
      lastPage: null,
      failRemove: false,
      failList: false,
    };
    for (const channel of ['resources:list', 'resources:capture', 'resources:remove']) ipcMain.removeHandler(channel);
    ipcMain.handle('resources:list', async () => {
      if (host.resourceUiFixture.failList) throw new Error('fixture: list temporarily unavailable');
      return host.resourceUiFixture.collection;
    });
    ipcMain.handle('resources:capture', async (_event, request: { expectedPage: PageIdentity; resourceId?: string }) => {
      const fixture = host.resourceUiFixture;
      fixture.captures += 1;
      fixture.lastPage = request.expectedPage;
      await new Promise((resolve) => setTimeout(resolve, 160));
      const previous = fixture.collection.resources[0];
      if (previous?.text === fixture.text) return fixture.collection;
      const resource: SpaceResource = {
        page: fixture.page,
        requestedUrl: fixture.page.url,
        url: fixture.page.url,
        title: fixture.page.title,
        text: fixture.text,
        capturedAt: '2026-10-06T11:00:00.000Z',
        sourceSha256: 'a'.repeat(64),
        contentSha256: (previous ? 'c' : 'b').repeat(64),
        extractionVersion: 'html-text-v1',
        truncated: false,
        spaceId: 'taskflow-demo',
        resourceId: '12345678-1234-4234-9234-123456789abc',
        version: (previous?.version ?? 0) + 1,
      };
      fixture.collection = { ...fixture.collection, revision: fixture.collection.revision + 1, resources: [resource] };
      return fixture.collection;
    });
    ipcMain.handle('resources:remove', async () => {
      const fixture = host.resourceUiFixture;
      if (fixture.failRemove) throw new Error('fixture: space turn still running');
      fixture.collection = { ...fixture.collection, revision: fixture.collection.revision + 1, resources: [] };
      return fixture.collection;
    });
    BrowserWindow.getAllWindows()[0]!.webContents.send('preview:state', preview);
  }, document);
  await expect(page.getByText('公开网页 · 只读文档')).toBeVisible();
}

test('fixture UI：公开快照保存、重复、更新、失败恢复、移除确认、个人隔离与窄窗键盘', async () => {
  // This fixture tests renderer behavior only; it does not assert real network or Agent access.
  await fixture();
  const capture = page.getByRole('button', { name: '加入空间', exact: true });
  await capture.click();
  await expect(capture).toBeDisabled();
  await expect(capture).toBeEnabled();
  const received = await app.evaluate(() => {
    const fixture = (globalThis as FixtureGlobal).resourceUiFixture;
    return { captures: fixture.captures, expectedPage: fixture.lastPage, sourcePage: fixture.page };
  });
  expect(received.captures).toBe(1);
  expect(received.expectedPage).toEqual(received.sourcePage);
  await capture.click();
  await expect(page.locator('.browser-chrome').getByText('该网页已在空间中，正文未变化。')).toBeVisible();
  await page.getByRole('button', { name: '查看空间资源' }).click();
  const resourcePage = page.getByRole('region', { name: '空间网页资源' });
  const detail = resourcePage.getByRole('region', { name: '资源详情' });
  await expect(resourcePage.getByRole('table').getByRole('row')).toHaveCount(2);
  await expect(detail).toContainText('https://example.com/');
  await expect(detail).toContainText('12345678-1234-4234-9234-123456789abc');
  await expect(detail.locator('pre')).toContainText('<script>');
  expect(await page.evaluate(() => (window as Window & { __resourceExecuted?: boolean }).__resourceExecuted)).toBeUndefined();
  await app.evaluate(() => {
    (globalThis as FixtureGlobal).resourceUiFixture.text = 'Fixture updated body. 第二版内容。';
  });
  await detail.getByRole('button', { name: '用当前页面更新' }).click();
  await expect(detail).toContainText('只读快照 · v2');
  await expect(detail.locator('pre')).toHaveText('Fixture updated body. 第二版内容。');

  await app.evaluate(() => {
    (globalThis as FixtureGlobal).resourceUiFixture.failList = true;
  });
  await resourcePage.getByRole('button', { name: '刷新列表' }).click();
  await expect(resourcePage.getByRole('alert')).toContainText('list temporarily unavailable');
  await expect(detail).toContainText('第二版内容');
  await app.evaluate(() => {
    (globalThis as FixtureGlobal).resourceUiFixture.failList = false;
  });
  await resourcePage.getByRole('button', { name: '刷新列表' }).click();
  await expect(resourcePage.getByRole('alert')).toHaveCount(0);

  await setWindowSize(app, 1024, 768);
  await page.getByRole('button', { name: '收起通信栏（⌥⌘B）' }).click();
  await page.getByRole('button', { name: '显示或隐藏 Workshop（⌘B）' }).click();
  await detail.getByRole('button', { name: '移除资源' }).focus();
  await page.keyboard.press('Enter');
  const dialog = page.getByRole('dialog', { name: '从空间移除网页' });
  await expect(dialog).toBeVisible();
  await expect(dialog.getByRole('button', { name: '取消', exact: true })).toBeFocused();
  expect((await previewInfo(app)).visible).toBe(false);
  await page.keyboard.press('Tab');
  await expect(dialog.getByRole('button', { name: '移除网页', exact: true })).toBeFocused();
  await page.keyboard.press('Tab');
  expect(await page.evaluate(() => !!document.activeElement?.closest('dialog'))).toBe(true);
  await page.keyboard.press('Escape');
  await expect(dialog).toHaveCount(0);
  await expect(detail.getByRole('button', { name: '移除资源' })).toBeFocused();

  await app.evaluate(() => {
    (globalThis as FixtureGlobal).resourceUiFixture.failRemove = true;
  });
  await detail.getByRole('button', { name: '移除资源' }).click();
  await dialog.getByRole('button', { name: '移除网页', exact: true }).click();
  await expect(dialog.getByRole('alert')).toContainText('未移除资源');
  await expect(detail).toContainText('第二版内容');
  await dialog.getByRole('button', { name: '取消', exact: true }).click();
  await shot(page, 'resources-fixture-narrow-failure');

  await page.getByRole('button', { name: '显示或隐藏 Workshop（⌘B）' }).click();
  const nav = page.getByRole('navigation', { name: 'Workshop 导航' });
  await nav.getByRole('button', { name: '首页', exact: true }).click();
  await nav.getByRole('button', { name: '资源', exact: true }).click();
  await expect(resourcePage).toContainText('个人会话不提供空间网页资源');
  await expect(resourcePage).not.toContainText('Fixture Example Domain');
  await resourcePage.getByRole('button', { name: '打开空间页面' }).click();
  await page.getByRole('button', { name: '查看空间资源' }).click();
  await expect(detail).toContainText('第二版内容');
  await app.evaluate(() => {
    (globalThis as FixtureGlobal).resourceUiFixture.failRemove = false;
  });
  await detail.getByRole('button', { name: '移除资源' }).click();
  await dialog.getByRole('button', { name: '移除网页', exact: true }).click();
  await expect(dialog).toHaveCount(0);
  await expect(resourcePage).toContainText('当前空间还没有网页资源');
  await expect(resourcePage.getByRole('heading', { name: '空间资源', exact: true })).toBeFocused();
  await shot(page, 'resources-fixture-empty');
});
