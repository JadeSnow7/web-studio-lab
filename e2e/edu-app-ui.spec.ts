import { mkdir } from 'node:fs/promises';
import path from 'node:path';
import { expect, test } from '@playwright/test';
import { launchApp, screensDir, setWindowSize, workspaceSnapshot } from './helpers';

test('edu import shares App management; cancelling native selection preserves the standard creation flow', async () => {
  const { app, page } = await launchApp();
  try {
    // Only the native selection response is controlled. No guest or model is launched.
    await app.evaluate(({ dialog }) => {
      dialog.showOpenDialog = async () => ({ canceled: true, filePaths: [] });
    });
    await page.getByRole('button', { name: '新建 App', exact: true }).click();
    await setWindowSize(app, 960, 700);
    const dialog = page.getByRole('dialog', { name: '空间 App', exact: true });
    const imported = dialog.getByRole('button', { name: '导入 edu 工程', exact: true });
    await expect(imported).toBeVisible();
    await imported.focus();
    await page.keyboard.press('Enter');
    await expect(imported).toBeEnabled();
    await expect(dialog.getByRole('alert')).toHaveCount(0);
    const workspace = (await workspaceSnapshot(page)).workspaces[0]!;
    expect(workspace.app).toBeFalsy();
    expect(workspace.managedApp).toBeFalsy();
    await mkdir(screensDir, { recursive: true });
    await page.screenshot({ path: path.join(screensDir, 'edu-app-import-empty-narrow.png') });
    await dialog.getByRole('button', { name: '创建标准应用', exact: true }).click();
    await expect(page.getByRole('dialog', { name: '创建 App', exact: true })).toBeVisible();
    await page.getByRole('button', { name: '取消', exact: true }).click();
    expect((await workspaceSnapshot(page)).workspaces[0]!.app).toBeFalsy();
  } finally {
    await app.close();
  }
});
