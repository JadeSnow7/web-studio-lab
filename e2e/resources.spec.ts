import { expect, test, type ElectronApplication, type Page } from '@playwright/test';
import type {
  WorkbenchSnapshot,
  WorkbenchCommand,
  WorkbenchResult,
  ResourceCollection,
  SpaceResource,
  PreviewState,
} from '../packages/protocol/src';
import { launchApp, browserState, setWindowSize, shot, workshopNavigate } from './helpers';
let app: ElectronApplication, page: Page;
test.afterEach(async () => {
  await app?.close();
});
interface Fixture {
  collection: ResourceCollection;
  preview: PreviewState;
  text: string;
  captures: number;
  lastResource: string | null;
  failRemove: boolean;
  failRead: boolean;
  seq: number;
}
type FixtureGlobal = typeof globalThis & { resourceUiFixture: Fixture };
async function fixture() {
  ({ app, page } = await launchApp());
  await setWindowSize(app, 1440, 900);
  const original = await browserState(page);
  const preview = {
    ...original,
    loading: false,
    loadError: null,
    page: { ...original.page, url: 'https://example.com/', title: 'Fixture Example Domain', documentGeneration: 99 },
  };
  await app.evaluate(({ ipcMain }, document) => {
    const host = globalThis as FixtureGlobal;
    host.resourceUiFixture = {
      collection: { spaceId: 'taskflow-demo', revision: 0, resources: [] },
      preview: document,
      text: 'Fixture-only public body. <script>window.__resourceExecuted=true</script>',
      captures: 0,
      lastResource: null,
      failRemove: false,
      failRead: false,
      seq: 10000,
    };
    type Handler = (event: Electron.IpcMainInvokeEvent, payload?: unknown) => Promise<unknown>;
    const handlers = (ipcMain as unknown as { _invokeHandlers: Map<string, Handler> })._invokeHandlers;
    const get = handlers.get('workbench:get-snapshot')!,
      command = handlers.get('workbench:command')!;
    const project = (snapshot: WorkbenchSnapshot) => {
      const f = host.resourceUiFixture;
      const space = snapshot.workspaces.find((w) => w.workspaceId === 'taskflow-demo')!;
      space.publicResources = f.collection;
      space.resources.find((r) => r.kind === 'web')!.preview = f.preview;
      return { ...snapshot, seq: ++f.seq };
    };
    ipcMain.removeHandler('workbench:get-snapshot');
    ipcMain.handle('workbench:get-snapshot', async (event) => {
      if (host.resourceUiFixture.failRead) throw new Error('fixture: list temporarily unavailable');
      return project((await get(event)) as WorkbenchSnapshot);
    });
    ipcMain.removeHandler('workbench:command');
    ipcMain.handle('workbench:command', async (event, request: WorkbenchCommand) => {
      const f = host.resourceUiFixture;
      if (request.type === 'capturePublicResource') {
        f.captures++;
        f.lastResource = request.resourceId;
        await new Promise((r) => setTimeout(r, 160));
        const previous = f.collection.resources[0];
        if (previous?.text !== f.text) {
          const resource: SpaceResource = {
            page: f.preview.page,
            requestedUrl: f.preview.page.url,
            url: f.preview.page.url,
            title: f.preview.page.title,
            text: f.text,
            capturedAt: '2026-10-06T11:00:00.000Z',
            sourceSha256: 'a'.repeat(64),
            contentSha256: (previous ? 'c' : 'b').repeat(64),
            extractionVersion: 'html-text-v1',
            truncated: false,
            spaceId: 'taskflow-demo',
            resourceId: '12345678-1234-4234-9234-123456789abc',
            version: (previous?.version ?? 0) + 1,
          };
          f.collection = { ...f.collection, revision: f.collection.revision + 1, resources: [resource] };
        }
        return { ok: true, snapshot: project((await get(event)) as WorkbenchSnapshot) };
      }
      if (request.type === 'removePublicResource') {
        if (f.failRemove)
          return {
            ok: false,
            error: { code: 'execution_failed', message: 'fixture: space turn still running' },
            snapshot: project((await get(event)) as WorkbenchSnapshot),
          };
        f.collection = { ...f.collection, revision: f.collection.revision + 1, resources: [] };
        return { ok: true, snapshot: project((await get(event)) as WorkbenchSnapshot) };
      }
      const result = (await command(event, request)) as WorkbenchResult;
      return { ...result, snapshot: project(result.snapshot) };
    });
  }, preview);
  await page.getByRole('button', { name: '切换空间', exact: true }).click();
  await expect(page.getByRole('dialog', { name: '切换空间' })).toBeVisible();
  await page.keyboard.press('Escape');
  await expect(page.getByRole('dialog', { name: '切换空间' })).not.toBeVisible();
  // Reading the authoritative transport publishes the controlled fixture DTO to the renderer.
  await workshopNavigate(page, '资源');
  await page.getByRole('button', { name: '刷新列表', exact: true }).click();
  await workshopNavigate(page, '空间');
}

test('fixture UI：公开快照保存、重复、更新、失败恢复、移除确认、个人隔离与窄窗键盘', async () => {
  // Controlled DTO transport exercises UI only; real protocol/store coverage is public-document.spec.ts.
  await fixture();
  const capture = page.getByRole('button', { name: '加入空间', exact: true });
  await capture.click();
  await expect(capture).toBeDisabled();
  await expect(capture).toBeEnabled();
  expect(
    await app.evaluate(() => ({
      captures: (globalThis as FixtureGlobal).resourceUiFixture.captures,
      resourceId: (globalThis as FixtureGlobal).resourceUiFixture.lastResource,
    })),
  ).toMatchObject({ captures: 1 });
  await capture.click();
  await expect(capture).toBeEnabled();
  expect(await app.evaluate(() => (globalThis as FixtureGlobal).resourceUiFixture.collection.resources)).toHaveLength(1);
  await page.getByRole('button', { name: '查看空间资源', exact: true }).click();
  const resources = page.getByRole('region', { name: '空间网页资源' }),
    detail = resources.getByRole('region', { name: '资源详情' });
  await expect(resources.getByRole('table').getByRole('row')).toHaveCount(2);
  await expect(detail).toContainText('https://example.com/');
  await expect(detail).toContainText('12345678-1234-4234-9234-123456789abc');
  await expect(detail.locator('pre')).toContainText('<script>');
  expect(await page.evaluate(() => (window as Window & { __resourceExecuted?: boolean }).__resourceExecuted)).toBeUndefined();
  await app.evaluate(() => {
    (globalThis as FixtureGlobal).resourceUiFixture.text = 'Fixture updated body. 第二版内容。';
  });
  await resources.getByRole('button', { name: '用当前页面更新' }).click();
  await expect(detail).toContainText('第二版内容');
  await expect(detail).toContainText('v2');
  await app.evaluate(() => {
    (globalThis as FixtureGlobal).resourceUiFixture.failRemove = true;
  });
  await resources.getByRole('button', { name: '移除资源' }).click();
  const confirm = page.getByRole('dialog', { name: '从空间移除网页' });
  await expect(confirm.getByRole('button', { name: '取消', exact: true })).toBeFocused();
  await confirm.getByRole('button', { name: '移除网页', exact: true }).click();
  await expect(confirm).toBeVisible();
  await expect(confirm).toContainText('未移除资源');
  await app.evaluate(() => {
    (globalThis as FixtureGlobal).resourceUiFixture.failRemove = false;
  });
  await confirm.getByRole('button', { name: '移除网页', exact: true }).click();
  await expect(confirm).not.toBeVisible();
  await expect(resources.getByRole('heading', { name: '空间资源', exact: true })).toBeFocused();
  await expect(resources).toContainText('当前空间还没有网页资源');
  await app.evaluate(() => {
    (globalThis as FixtureGlobal).resourceUiFixture.failRead = true;
  });
  await resources.getByRole('button', { name: '刷新列表' }).click();
  await expect(page.getByRole('alert').last()).toContainText('list temporarily unavailable');
  await app.evaluate(() => {
    (globalThis as FixtureGlobal).resourceUiFixture.failRead = false;
  });
  await resources.getByRole('button', { name: '刷新列表' }).click();
  await workshopNavigate(page, '首页');
  await expect(page.getByRole('region', { name: '混合输入' })).toContainText('不读取其他空间');
  await setWindowSize(app, 900, 700);
  await expect(page.getByRole('region', { name: '混合输入' }).getByRole('textbox')).toBeVisible();
  await shot(page, 'resources-fixture-narrow');
});
