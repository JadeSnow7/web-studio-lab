import { test, expect } from '@playwright/test';
import { mkdtemp, readFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { launchApp, workspaceSnapshot, previewInfo, setWindowSize, setWorkspaceTheme, screensDir } from './helpers';

test('Workshop typed creation persists resources and restores modal focus', async () => {
  const { app, page } = await launchApp({ sbxBin: new URL('./fixtures/sbx.mjs', import.meta.url).pathname });
  try {
    await setWorkspaceTheme(page, 'dark');
    await page.screenshot({ path: path.join(screensDir, 'workshop-actions-dark.png') });
    await expect(page.getByRole('region', { name: '标准应用服务' })).toHaveCount(0);
    for (const [label, kind, title] of [
      ['新建网页', 'web', '文档页'],
      ['新建终端', 'terminal', '实验终端'],
      ['新建会话', 'session', '实验会话'],
    ] as const) {
      const trigger = page.getByRole('button', { name: label, exact: true });
      await trigger.click();
      const dialog = page.getByRole('dialog', { name: '新建标签' });
      await expect(dialog.getByLabel('标签类型')).toHaveValue(kind);
      await expect.poll(async () => (await previewInfo(app)).visible).toBe(false);
      await page.keyboard.press('Escape');
      await expect(trigger).toBeFocused();
      await trigger.click();
      await dialog.getByLabel('名称', { exact: true }).fill(title);
      if (kind === 'web') {
        await dialog.getByLabel('网页地址', { exact: true }).fill('http://unsafe.invalid');
        await dialog.getByRole('button', { name: '保存', exact: true }).click();
        await expect(dialog.getByRole('alert')).toBeVisible();
        await expect(dialog.getByLabel('名称', { exact: true })).toHaveValue(title);
        await dialog.getByLabel('网页地址', { exact: true }).fill('wsl-demo://taskflow/index.html');
      }
      if (kind === 'terminal') {
        await expect(dialog.getByRole('button', { name: '保存', exact: true })).toBeDisabled();
        await dialog.getByLabel('资源环境', { exact: true }).selectOption('sandbox');
      }
      await dialog.getByRole('button', { name: '保存', exact: true }).evaluate((node) => {
        (node as HTMLButtonElement).click();
        (node as HTMLButtonElement).click();
      });
      await expect(dialog).not.toBeVisible();
      const snapshot = await workspaceSnapshot(page);
      const workspace = snapshot.workspaces.find((w) => w.workspaceId === snapshot.activeWorkspaceId)!;
      const tabs = workspace.tabs.filter((tab) => tab.title === title);
      expect(tabs).toHaveLength(1);
      expect(tabs[0]!.targetRef.kind).toBe(kind);
      if (kind === 'terminal') {
        await expect(page.getByRole('button', { name: '连接终端', exact: true })).toBeEnabled();
        expect(workspace.resources.find((r) => r.resourceId === tabs[0]!.targetRef.resourceId)?.terminal?.state).not.toBe('running');
      }
      if (kind === 'session') expect(workspace.runs).toHaveLength(0);
    }
    await page.getByRole('button', { name: '关闭错误提示', exact: true }).click();
    await setWindowSize(app, 900, 700);
    await page.getByRole('button', { name: '展开 Workshop', exact: true }).click();
    for (const name of ['新建网页', '新建终端', '新建会话', '新建 App'])
      await expect(page.getByRole('button', { name, exact: true })).toBeVisible();
    await page.screenshot({ path: path.join(screensDir, 'workshop-actions-narrow.png') });
  } finally {
    await app.close();
  }
});

test('Workshop App dialog creates, exports, reports startup failure and restores persisted ownership', async () => {
  const profile = await mkdtemp(path.join(tmpdir(), 'wsl-workshop-app-'));
  const options = { userData: profile, sbxBin: new URL('./fixtures/sbx-app-actions.mjs', import.meta.url).pathname };
  let { app, page } = await launchApp(options);
  try {
    await page.getByRole('button', { name: '新建 App', exact: true }).click();
    const dialog = page.getByRole('dialog', { name: '空间 App' });
    await expect(dialog.getByRole('button', { name: '关闭', exact: true })).toBeFocused();
    await expect.poll(async () => (await previewInfo(app)).visible).toBe(false);
    expect((await workspaceSnapshot(page)).workspaces.find((w) => w.workspaceId === 'taskflow-demo')!.managedApp).toBeUndefined();
    await dialog.getByRole('button', { name: '创建标准应用', exact: true }).evaluate((node) => {
      (node as HTMLButtonElement).click();
      (node as HTMLButtonElement).click();
    });
    const form = page.getByRole('dialog', { name: '创建 App', exact: true });
    await form.getByLabel('App 名称').fill('Workshop 测试应用');
    await form.getByRole('button', { name: '保存 App' }).evaluate((node) => {
      (node as HTMLButtonElement).click();
      (node as HTMLButtonElement).click();
    });
    await expect(form).not.toBeVisible();
    await page.getByRole('button', { name: '管理 App', exact: true }).click();
    await expect(dialog.getByRole('status').first()).toHaveText('已创建');
    const getApp = async () => (await workspaceSnapshot(page)).workspaces.find((w) => w.workspaceId === 'taskflow-demo')!.managedApp!;
    const projectId = (await getApp()).projectId;
    await page.screenshot({ path: path.join(screensDir, 'workshop-actions-app.png') });
    expect((await getApp()).appInstanceId).toBeNull();
    await dialog.getByRole('button', { name: '导出源码', exact: true }).click();
    await expect(dialog.getByText(/源码已导出/)).toBeVisible();
    const exported = (await workspaceSnapshot(page)).workspaces.find((w) => w.workspaceId === 'taskflow-demo')!.appExport!;
    expect(await readFile(path.join(exported.path, 'README.md'), 'utf8')).toBe('fixture source\n');
    await dialog.getByRole('button', { name: '启动应用', exact: true }).click();
    await expect(dialog.getByRole('button', { name: '取消启动', exact: true })).toBeEnabled();
    await dialog.getByRole('button', { name: '取消启动', exact: true }).click();
    await expect.poll(async () => (await getApp()).state).toBe('stopped');
    expect((await getApp()).cleanupConfirmed).toBe(true);
    await expect(dialog.getByRole('button', { name: '启动应用', exact: true })).toBeEnabled();
    await dialog.getByRole('button', { name: '启动应用', exact: true }).click();
    await expect.poll(async () => (await getApp()).state).toBe('failed');
    await expect(dialog.getByRole('alert').first()).toBeVisible();
    await page.keyboard.press('Escape');
    await expect(page.getByRole('button', { name: '管理 App', exact: true })).toBeFocused();
    await app.close();
    ({ app, page } = await launchApp(options));
    await page.getByRole('button', { name: '管理 App', exact: true }).click();
    expect((await getApp()).projectId).toBe(projectId);
    await expect(page.getByRole('dialog', { name: '空间 App' }).getByRole('button', { name: '启动应用', exact: true })).toBeEnabled();
  } finally {
    await app.close();
  }
});

test('App operations stay with their workspace after closing and switching', async () => {
  const { app, page } = await launchApp({ sbxBin: new URL('./fixtures/sbx-app-actions.mjs', import.meta.url).pathname });
  try {
    await page.evaluate(() =>
      window.studio.workbench.command({
        type: 'createWorkspace',
        workspaceId: 'other-app-space',
        commandId: crypto.randomUUID(),
        name: '另一个 App 空间',
      }),
    );
    await page.getByRole('button', { name: '新建 App', exact: true }).click();
    const dialog = page.getByRole('dialog', { name: '空间 App' });
    await dialog.getByRole('button', { name: '创建标准应用', exact: true }).click();
    const form = page.getByRole('dialog', { name: '创建 App', exact: true });
    await form.getByLabel('App 名称').fill('固定原空间的 App');
    await form.getByRole('button', { name: '保存 App' }).click();
    await expect(form.getByRole('status')).toHaveText('正在保存 App…');
    await page.keyboard.press('Escape');
    await expect(form).toBeVisible();
    // Navigation may arrive from another window while saving; it cannot redirect the frozen recipient.
    await page.evaluate(() =>
      window.studio.workbench.command({
        type: 'switchWorkspace',
        commandId: crypto.randomUUID(),
        workspaceId: 'other-app-space',
      }),
    );
    expect((await workspaceSnapshot(page)).workspaces.find((w) => w.workspaceId === 'taskflow-demo')?.managedApp?.state).toBe('starting');
    await expect(form).not.toBeVisible();
    expect((await workspaceSnapshot(page)).activeWorkspaceId).toBe('other-app-space');
    // Another window's navigation preserves this window's selected space.
    await expect(page.getByRole('button', { name: '管理 App', exact: true })).toBeVisible();
    await page.getByRole('button', { name: '切换空间', exact: true }).click();
    await page
      .getByRole('dialog', { name: '切换空间' })
      .getByRole('button', { name: /另一个 App 空间.*个标签/ })
      .click();
    await page.getByRole('button', { name: '新建 App', exact: true }).click();
    await expect(dialog.getByRole('button', { name: '创建标准应用', exact: true })).toBeEnabled();
    expect((await workspaceSnapshot(page)).workspaces.find((w) => w.workspaceId === 'taskflow-demo')?.managedApp?.state).toBe('created');
    await expect(dialog.getByRole('alert')).toHaveCount(0);
    await expect(dialog.getByRole('button', { name: '创建标准应用', exact: true })).toBeEnabled();
    expect((await workspaceSnapshot(page)).workspaces.find((w) => w.workspaceId === 'other-app-space')?.managedApp).toBeUndefined();
    await page.keyboard.press('Escape');
    await page.getByRole('button', { name: '切换空间', exact: true }).click();
    await page
      .getByRole('dialog', { name: '切换空间' })
      .getByRole('button', { name: /TaskFlow.*个标签/ })
      .click();
    await page.getByRole('button', { name: '管理 App', exact: true }).click();
    await dialog.getByRole('button', { name: '启动应用', exact: true }).click();
    await expect(dialog.getByRole('button', { name: '取消启动', exact: true })).toBeEnabled();
    await page.keyboard.press('Escape');
    await page.getByRole('button', { name: '切换空间', exact: true }).click();
    await page
      .getByRole('dialog', { name: '切换空间' })
      .getByRole('button', { name: /另一个 App 空间.*个标签/ })
      .click();
    await page.getByRole('button', { name: '新建 App', exact: true }).click();
    expect((await workspaceSnapshot(page)).workspaces.find((w) => w.workspaceId === 'taskflow-demo')?.managedApp?.state).toBe('starting');
    await expect
      .poll(async () => (await workspaceSnapshot(page)).workspaces.find((w) => w.workspaceId === 'taskflow-demo')?.managedApp?.state)
      .toBe('failed');
    await expect(dialog.getByRole('alert')).toHaveCount(0);
    await expect(dialog.getByRole('button', { name: '创建标准应用', exact: true })).toBeEnabled();
  } finally {
    await app.close();
  }
});
