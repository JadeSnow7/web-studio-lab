import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { createServer } from 'node:http';
import path from 'node:path';
import { expect, test, type Page } from '@playwright/test';
import { launchApp, screensDir, setWindowSize, setWorkspaceTheme, workspaceSnapshot, workshopNavigate } from './helpers';
import {
  chooseImportSource,
  createEduImportFixture,
  deferImportPicker,
  importCommands,
  installDelayedImportService,
  releaseDelayedImportService,
  observeImportCommands,
  resolveImportPicker,
  sourceTreeDigest,
} from './edu-import-fixture';

const owner = async (page: Page) => {
  const workspace = (await workspaceSnapshot(page)).workspaces.find((item) => item.workspaceId === 'taskflow-demo');
  if (!workspace) throw new Error('fixture workspace unavailable');
  return workspace;
};
const dialog = (page: Page) => page.getByRole('dialog', { name: '空间 App', exact: true });
const importButton = (page: Page) => dialog(page).getByRole('button', { name: '导入已有 edu 工程', exact: true });
const previewReady = async (page: Page) => {
  await expect.poll(async () => (await owner(page)).appImport?.phase).toBe('ready');
  await expect(dialog(page).getByRole('button', { name: '确认导入并启动', exact: true })).toBeEnabled();
};

test('native selection cancel preserves standard creation and does not create an App', async () => {
  const { app, page } = await launchApp();
  try {
    await chooseImportSource(app, null);
    await page.getByRole('button', { name: '新建 App', exact: true }).click();
    await importButton(page).focus();
    await page.keyboard.press('Enter');
    await expect(importButton(page)).toBeEnabled();
    await expect(dialog(page).getByRole('alert')).toHaveCount(0);
    expect((await owner(page)).managedApp).toBeFalsy();
    expect((await owner(page)).app).toBeFalsy();
    await dialog(page).getByRole('button', { name: '创建标准应用', exact: true }).click();
    await expect(page.getByRole('dialog', { name: '创建 App', exact: true })).toBeVisible();
    await page.getByRole('button', { name: '取消', exact: true }).click();
    expect((await owner(page)).app).toBeFalsy();
  } finally {
    await app.close();
  }
});

test('real static preview is source-bound, secret-free, keyboard accessible and preserved across close in all themes', async () => {
  const root = await createEduImportFixture();
  const before = await sourceTreeDigest(root);
  const { app, page } = await launchApp();
  try {
    await observeImportCommands(app);
    for (const theme of ['light', 'dark', 'warm']) {
      const navigation = page.getByRole('navigation', { name: 'Workshop 导航' });
      await setWindowSize(app, 1440, 900);
      await expect(navigation).toBeVisible();
      await setWorkspaceTheme(page, theme);
      await setWindowSize(app, 960, 700);
      // Narrow layout intentionally unmounts the docked sidebar. Open its real titlebar trigger.
      await expect(navigation).not.toBeVisible();
      await page.getByRole('button', { name: '展开 Workshop', exact: true }).click();
      await expect(navigation).toBeVisible();
      await page.getByRole('button', { name: '新建 App', exact: true }).click();
      await chooseImportSource(app, root);
      await importButton(page).click();
      await previewReady(page);
      const preview = (await owner(page)).appImport?.preview;
      expect(preview).toMatchObject({ profile: 'edu-web', profileVersion: 1, fileCount: 8, repository: { dirty: false } });
      expect(preview?.sourceSha256).toMatch(/^[a-f0-9]{64}$/);
      expect((await owner(page)).app).toBeFalsy();
      expect((await owner(page)).managedApp).toBeFalsy();
      await expect(dialog(page)).toContainText('Python 3.12');
      await expect(dialog(page)).not.toContainText('must-never-appear-in-preview');
      await expect(dialog(page).getByRole('button', { name: '确认导入并启动', exact: true })).toBeInViewport();
      await expect(dialog(page).getByRole('button', { name: '取消导入', exact: true })).toBeInViewport();
      await mkdir(screensDir, { recursive: true });
      await page.screenshot({ path: path.join(screensDir, `edu-import-preview-${theme}-narrow.png`) });
      const id = (await owner(page)).appImport?.previewId;
      await page.keyboard.press('Escape');
      await expect(dialog(page)).not.toBeVisible();
      await expect(page.getByRole('button', { name: '新建 App', exact: true })).toBeFocused();
      expect((await owner(page)).appImport?.previewId).toBe(id);
      await page.keyboard.press('Enter');
      await previewReady(page);
      await dialog(page).getByRole('button', { name: '取消导入', exact: true }).click();
      await expect.poll(async () => (await owner(page)).appImport?.phase).toBe('cancelled');
      await dialog(page).getByRole('button', { name: '关闭', exact: true }).click();
    }
    expect(await sourceTreeDigest(root)).toBe(before);
    expect(
      (await importCommands(app)).filter((type) => ['confirmAppImport', 'retryAppImport', 'startApp', 'openAppPage'].includes(type)),
    ).toEqual([]);
  } finally {
    await app.close();
    await rm(root, { recursive: true, force: true });
  }
});

test('cancelled and closed native selections cannot create an App or reopen the dialog', async () => {
  const root = await createEduImportFixture();
  const { app, page } = await launchApp();
  try {
    await observeImportCommands(app);
    await page.getByRole('button', { name: '新建 App', exact: true }).click();
    await deferImportPicker(app);
    await importButton(page).evaluate((node) => {
      (node as HTMLButtonElement).click();
      (node as HTMLButtonElement).click();
    });
    await expect.poll(async () => (await owner(page)).appImport?.phase).toBe('selecting');
    await expect
      .poll(() => app.evaluate(() => typeof (globalThis as typeof globalThis & { importPickerResolve?: unknown }).importPickerResolve))
      .toBe('function');
    await dialog(page).getByRole('button', { name: '取消导入', exact: true }).click();
    await resolveImportPicker(app, root);
    await expect.poll(async () => (await owner(page)).appImport?.phase).toBe('cancelled');
    expect((await importCommands(app)).filter((type) => type === 'previewAppImport')).toHaveLength(1);
    expect((await owner(page)).managedApp).toBeFalsy();
    await chooseImportSource(app, root);
    await importButton(page).click();
    await previewReady(page);
    await dialog(page).getByRole('button', { name: '重新选择工程', exact: true }).focus();
    await deferImportPicker(app);
    await page.keyboard.press('Enter');
    await expect.poll(async () => (await owner(page)).appImport?.phase).toBe('selecting');
    await expect
      .poll(() => app.evaluate(() => typeof (globalThis as typeof globalThis & { importPickerResolve?: unknown }).importPickerResolve))
      .toBe('function');
    await page.keyboard.press('Escape');
    await expect(dialog(page)).not.toBeVisible();
    await resolveImportPicker(app, root);
    await expect.poll(async () => (await owner(page)).appImport?.phase).toBe('ready');
    await expect(dialog(page)).not.toBeVisible();
    expect((await owner(page)).managedApp).toBeFalsy();
    expect((await importCommands(app)).filter((type) => type === 'openAppPage')).toEqual([]);
  } finally {
    await app.close();
    await rm(root, { recursive: true, force: true });
  }
});

test('unsupported source and source changes explain recovery; failed import retries without duplicate confirmation', async () => {
  const root = await createEduImportFixture();
  const unsupported = await mkdtemp(path.join(tmpdir(), 'wsl-unsupported-import-'));
  await writeFile(path.join(unsupported, 'README.md'), 'Unsupported synthetic project.');
  const { app, page } = await launchApp();
  try {
    await observeImportCommands(app);
    await page.getByRole('button', { name: '新建 App', exact: true }).click();
    await chooseImportSource(app, unsupported);
    await importButton(page).click();
    await expect.poll(async () => (await owner(page)).appImport?.phase).toBe('failed');
    await mkdir(screensDir, { recursive: true });
    await page.screenshot({ path: path.join(screensDir, 'edu-import-unsupported-error.png') });
    await expect(dialog(page).getByRole('alert')).toHaveCount(1);
    await expect(dialog(page).getByRole('alert')).toBeVisible();
    await dialog(page).getByRole('button', { name: '关闭', exact: true }).click();
    await page.getByRole('button', { name: '新建 App', exact: true }).click();
    await expect(dialog(page).getByRole('alert')).toHaveCount(1);
    await expect(dialog(page).getByRole('region', { name: '导入已有工程', exact: true }).getByRole('alert')).toBeVisible();
    await expect(dialog(page).getByRole('button', { name: '确认导入并启动', exact: true })).toHaveCount(0);
    expect((await owner(page)).managedApp).toBeFalsy();
    await chooseImportSource(app, root);
    await dialog(page).getByRole('button', { name: '重新选择工程', exact: true }).click();
    await previewReady(page);
    await expect(dialog(page).getByRole('alert')).toHaveCount(0);
    await writeFile(path.join(root, 'admin/src/App.tsx'), 'export const App = () => <main>Changed after preview</main>;\n');
    await dialog(page).getByRole('button', { name: '确认导入并启动', exact: true }).click();
    await expect.poll(async () => (await owner(page)).appImport?.phase).toBe('failed');
    await expect(dialog(page).getByRole('alert')).toHaveCount(1);
    await expect(dialog(page).getByRole('alert')).toContainText(/变化|重新/);
    expect((await owner(page)).managedApp).toBeFalsy();
    await chooseImportSource(app, root);
    await dialog(page).getByRole('button', { name: '重新选择工程', exact: true }).click();
    await previewReady(page);
    await expect(dialog(page).getByRole('alert')).toHaveCount(0);
    const selectedDigest = await sourceTreeDigest(root);
    await dialog(page)
      .getByRole('button', { name: '确认导入并启动', exact: true })
      .evaluate((node) => {
        (node as HTMLButtonElement).click();
        (node as HTMLButtonElement).click();
      });
    await expect.poll(async () => (await owner(page)).appImport?.phase, { timeout: 20000 }).toBe('failed');
    await expect(dialog(page).getByRole('alert')).toHaveCount(1);
    await expect(dialog(page).getByRole('alert')).toBeVisible();
    expect((await importCommands(app)).filter((type) => type === 'confirmAppImport')).toHaveLength(2);
    await expect(dialog(page)).not.toContainText('正在启动应用');
    const reserved = await owner(page);
    expect(reserved.pendingAppImport?.projectId).toBe(reserved.managedApp?.projectId);
    expect(reserved.managedApp).toMatchObject({ appInstanceId: null, cleanupConfirmed: false });
    const retry = dialog(page).getByRole('button', { name: '重试导入', exact: true });
    await expect(retry).toBeEnabled();
    await retry.click();
    await expect.poll(async () => (await owner(page)).appImport?.phase, { timeout: 20000 }).toBe('failed');
    await expect(dialog(page).getByRole('alert')).toHaveCount(1);
    expect((await importCommands(app)).filter((type) => type === 'retryAppImport')).toHaveLength(1);
    await expect(dialog(page)).not.toContainText('正在启动应用');
    await dialog(page).getByRole('button', { name: '关闭', exact: true }).click();
    await page.getByRole('button', { name: '管理 App', exact: true }).click();
    await expect(dialog(page)).not.toContainText('正在启动应用');
    await expect(dialog(page).getByRole('alert')).toHaveCount(1);
    await expect(dialog(page).getByRole('button', { name: '核对并取消', exact: true })).toBeEnabled();
    expect((await owner(page)).pendingAppImport).toEqual(reserved.pendingAppImport);
    expect(await sourceTreeDigest(root)).toBe(selectedDigest);
    await mkdir(screensDir, { recursive: true });
    await page.screenshot({ path: path.join(screensDir, 'edu-import-failed-retry.png') });
  } finally {
    await app.close();
    await rm(root, { recursive: true, force: true });
    await rm(unsupported, { recursive: true, force: true });
  }
});

for (const departure of ['close', 'close-and-reopen', 'navigate'] as const) {
  test(`controlled service reply: ${departure} during confirmed import cannot activate a late successful App`, async () => {
    const root = await createEduImportFixture();
    const before = await sourceTreeDigest(root);
    // Local synthetic response target, never a sandbox or model endpoint.
    const server = createServer((_request, response) => {
      response.writeHead(200, { 'content-type': 'text/html; charset=utf-8' });
      response.end('<!doctype html><title>Synthetic import UI fixture</title><p>Not a live guest</p>');
    });
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
    server.unref();
    const address = server.address();
    if (!address || typeof address === 'string') throw new Error('fixture server did not obtain a loopback port');
    const { app, page } = await launchApp({ appControlInjection: true });
    try {
      await observeImportCommands(app);
      await installDelayedImportService(app, `http://127.0.0.1:${address.port}`);
      await chooseImportSource(app, root);
      await page.getByRole('button', { name: '新建 App', exact: true }).click();
      await importButton(page).click();
      await previewReady(page);
      const baseline = await owner(page);
      await dialog(page).getByRole('button', { name: '确认导入并启动', exact: true }).click();
      await expect.poll(async () => (await owner(page)).appImport?.phase).toBe('starting');
      await page.keyboard.press('Escape');
      await expect(dialog(page)).not.toBeVisible();
      if (departure === 'close-and-reopen') {
        await page.getByRole('button', { name: '管理 App', exact: true }).click();
        await expect(dialog(page)).toBeVisible();
      } else if (departure === 'navigate') await workshopNavigate(page, '资源');
      await releaseDelayedImportService(app);
      await expect.poll(async () => (await owner(page)).appImport?.phase).toBe('completed');
      // Let the confirmation response and renderer continuation both finish before asserting no navigation.
      await page.evaluate(() => new Promise<void>((resolve) => requestAnimationFrame(() => requestAnimationFrame(() => resolve()))));
      const completed = await owner(page);
      expect(completed.managedApp?.state).toBe('running');
      expect(completed.managedApp?.guestCwd).toContain('/synthetic-ui-fixture/');
      expect(completed.activePaneId).toBe(baseline.activePaneId);
      expect((await importCommands(app)).filter((type) => type === 'openAppPage')).toEqual([]);
      if (departure === 'close-and-reopen') await expect(dialog(page)).toBeVisible();
      else await expect(dialog(page)).not.toBeVisible();
      if (departure === 'navigate') await expect(page.getByRole('heading', { name: '我的资源', exact: true })).toBeVisible();
      if (departure === 'close-and-reopen') {
        for (const [label, pathname] of [
          ['打开学生页', '/student'],
          ['打开管理员页', '/'],
        ] as const) {
          await dialog(page).getByRole('button', { name: label, exact: true }).click();
          await expect.poll(() => app.windows().some((view) => view.url() === `http://127.0.0.1:${address.port}${pathname}`)).toBe(true);
        }
        await mkdir(screensDir, { recursive: true });
        await page.screenshot({ path: path.join(screensDir, 'edu-import-running-two-pages.png') });
      }

      expect(await sourceTreeDigest(root)).toBe(before);
    } finally {
      await app.close();
      await new Promise<void>((resolve, reject) => server.close((error) => (error ? reject(error) : resolve())));
      await rm(root, { recursive: true, force: true });
    }
  });
}
