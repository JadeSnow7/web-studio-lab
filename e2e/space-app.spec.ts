import type { WorkbenchSnapshot, WorkbenchCommand, WorkbenchResult, SpaceApp } from '../packages/protocol/src';
import { mkdir } from 'node:fs/promises';
import path from 'node:path';
import { expect, test } from '@playwright/test';
import { launchApp, screensDir, workspaceSnapshot, setWindowSize, setWorkspaceTheme } from './helpers';

test('App form validates, cancels, creates and edits within its space; missing sandbox keeps draft and registered identity', async () => {
  // Missing sandbox is deliberate: this checks the honest failure UI, not live app execution.
  const { app, page } = await launchApp();
  try {
    await page.getByRole('button', { name: '新建 App', exact: true }).click();
    await page.getByRole('button', { name: '创建标准应用', exact: true }).click();
    let dialog = page.getByRole('dialog', { name: '创建 App', exact: true });
    await expect(dialog).toBeVisible();
    await dialog.getByRole('button', { name: '保存 App' }).click();
    await expect(dialog.getByRole('alert')).toContainText('请输入 App 名称');
    await dialog.getByLabel('App 名称').fill('取消的 App');
    await dialog.getByRole('button', { name: '取消', exact: true }).click();
    expect((await workspaceSnapshot(page)).workspaces[0]!.app).toBeFalsy();
    await page.getByRole('button', { name: '新建 App', exact: true }).click();
    await page.getByRole('button', { name: '创建标准应用', exact: true }).click();
    dialog = page.getByRole('dialog', { name: '创建 App', exact: true });
    await dialog.getByLabel('App 名称').fill('我的工作板');
    await dialog.getByLabel('App 说明').fill('用于验证名称和说明的持久化');
    await dialog.getByRole('button', { name: '保存 App' }).click();
    dialog = page.getByRole('dialog', { name: '编辑 App', exact: true });
    await expect(dialog.getByRole('alert')).toBeVisible({ timeout: 15000 });
    await expect(dialog.getByLabel('App 名称')).toHaveValue('我的工作板');
    const created = (await workspaceSnapshot(page)).workspaces[0]!;
    expect(created.app?.name).toBe('我的工作板');
    expect(created.managedApp?.state).toBe('failed');
    await dialog.getByLabel('App 名称').fill('修改后的工作板');
    await dialog.getByRole('button', { name: '保存 App' }).click();
    await expect(dialog).not.toBeVisible();
    const edited = (await workspaceSnapshot(page)).workspaces[0]!;
    expect(edited.app).toEqual({ ...created.app, name: '修改后的工作板', revision: 1 });
    expect(edited.managedApp).toEqual(created.managedApp);
    await page.getByRole('button', { name: '管理 App', exact: true }).click();
    await page.getByRole('button', { name: '编辑 App', exact: true }).click();
    dialog = page.getByRole('dialog', { name: '编辑 App', exact: true });
    await expect(dialog.getByLabel('App 说明')).toHaveValue('用于验证名称和说明的持久化');
    await setWindowSize(app, 900, 700);
    await expect(dialog.getByRole('button', { name: '保存 App' })).toBeInViewport();
    await mkdir(screensDir, { recursive: true });
    await page.screenshot({ path: path.join(screensDir, 'space-app-editor-narrow.png') });
    await dialog.getByLabel('App 说明').fill('窄窗内保存的新说明');
    await dialog.getByRole('button', { name: '保存 App' }).click();
    await expect(dialog).not.toBeVisible();
    expect((await workspaceSnapshot(page)).workspaces[0]!.app!.description).toBe('窄窗内保存的新说明');
  } finally {
    await app.close();
  }
});

test('controlled UI transport fixture: successful App creation and edit, duplicate prevention and revision conflict', async () => {
  const { app, page } = await launchApp();
  try {
    await app.evaluate(({ ipcMain }) => {
      type Snapshot = WorkbenchSnapshot;
      type Command = WorkbenchCommand;
      type Handler = (event: Electron.IpcMainInvokeEvent, payload?: unknown) => Promise<unknown>;
      const handlers = (ipcMain as unknown as { _invokeHandlers: Map<string, Handler> })._invokeHandlers;
      const get = handlers.get('workbench:get-snapshot')!;
      const original = handlers.get('workbench:command')!;
      const host = globalThis as typeof globalThis & { spaceAppFixtureCreateRequests: number };
      host.spaceAppFixtureCreateRequests = 0;
      let description: SpaceApp | null = null;
      let seq = 10000;
      const project = (snapshot: Snapshot) => {
        const owner = snapshot.workspaces.find((w) => w.workspaceId === 'taskflow-demo')!;
        owner.app = description;
        if (description)
          owner.managedApp = {
            workspaceId: owner.workspaceId,
            projectId: description.projectId,
            environmentId: 'sandbox',
            appInstanceId: null,
            state: 'created',
            url: null,
            guestCwd: '/fixture/project',
            error: null,
            cleanupConfirmed: true,
          };
        return { ...snapshot, seq: ++seq };
      };
      ipcMain.removeHandler('workbench:get-snapshot');
      ipcMain.handle('workbench:get-snapshot', async (event) => project((await get(event)) as Snapshot));
      ipcMain.removeHandler('workbench:command');
      ipcMain.handle('workbench:command', async (event, command: Command) => {
        if (command.type === 'createApp') {
          host.spaceAppFixtureCreateRequests++;
          if (description) throw new Error('fixture duplicate create');
          await new Promise((resolve) => setTimeout(resolve, 200));
          description = {
            appId: '12345678-1234-4234-9234-123456789abc',
            projectId: '12345678-1234-4234-9234-123456789def',
            workspaceId: command.workspaceId,
            name: command.name ?? 'fixture',
            description: command.description ?? '',
            revision: 0,
          };
          return { ok: true, snapshot: project((await get(event)) as Snapshot) };
        }
        if (command.type === 'updateApp') {
          if (!description || description.revision !== command.expectedAppRevision)
            return {
              ok: false,
              error: { code: 'conflict', message: 'App 已有较新修改，请重新打开编辑' },
              snapshot: project((await get(event)) as Snapshot),
            };
          description = { ...description, name: command.name, description: command.description, revision: description.revision + 1 };
          return { ok: true, snapshot: project((await get(event)) as Snapshot) };
        }
        const result = (await original(event, command)) as WorkbenchResult;
        return { ...result, snapshot: project(result.snapshot) };
      });
    });
    await page.getByRole('button', { name: '新建 App', exact: true }).click();
    await page.getByRole('button', { name: '创建标准应用', exact: true }).click();
    let dialog = page.getByRole('dialog', { name: '创建 App', exact: true });
    await dialog.getByLabel('App 名称').fill('受控 fixture App');
    await dialog.getByLabel('App 说明').fill('受控成功路径；不代表沙箱创建');
    await dialog.getByRole('button', { name: '保存 App' }).evaluate((node) => {
      (node as HTMLButtonElement).click();
      (node as HTMLButtonElement).click();
    });
    await expect(dialog).not.toBeVisible();
    expect(
      await app.evaluate(() => (globalThis as typeof globalThis & { spaceAppFixtureCreateRequests: number }).spaceAppFixtureCreateRequests),
    ).toBe(1);
    await page.getByRole('button', { name: '管理 App', exact: true }).click();
    await expect(page.getByRole('dialog', { name: '空间 App' })).toContainText('受控 fixture App');
    await page.keyboard.press('Escape');
    await page.getByRole('button', { name: '管理 App', exact: true }).click();
    await page.getByRole('button', { name: '编辑 App', exact: true }).click();
    dialog = page.getByRole('dialog', { name: '编辑 App', exact: true });
    await dialog.getByLabel('App 名称').fill('fixture 修改成功');
    await dialog.getByRole('button', { name: '保存 App' }).click();
    await expect(dialog).not.toBeVisible();
    await page.getByRole('button', { name: '管理 App', exact: true }).click();
    await page.getByRole('button', { name: '编辑 App', exact: true }).click();
    await page.evaluate(async () => {
      const snapshot = await window.studio.workbench.getSnapshot();
      const owner = snapshot.workspaces.find((w) => w.workspaceId === 'taskflow-demo')!;
      await window.studio.workbench.command({
        type: 'updateApp',
        commandId: crypto.randomUUID(),
        workspaceId: owner.workspaceId,
        appId: owner.app!.appId,
        expectedAppRevision: owner.app!.revision,
        name: 'fixture 并发修改',
        description: '',
      });
    });
    await dialog.getByLabel('App 名称').fill('不应覆盖并发修改');
    for (let attempt = 0; attempt < 2; attempt++) {
      await dialog.getByRole('button', { name: '保存 App' }).click();
      await expect(dialog.getByRole('alert')).toContainText('已有较新修改');
    }
    expect((await workspaceSnapshot(page)).workspaces[0]!.app!.name).toBe('fixture 并发修改');
    await page.keyboard.press('Escape');
    await expect(dialog).not.toBeVisible();
    await mkdir(screensDir, { recursive: true });
    await page.screenshot({ path: path.join(screensDir, 'space-app-sidebar-fixture.png') });
  } finally {
    await app.close();
  }
});

test('App form preserves long Chinese input during IME confirmation and stays reachable in a dark narrow window', async () => {
  const { app, page } = await launchApp();
  try {
    await setWorkspaceTheme(page, 'dark');
    await page.getByRole('button', { name: '新建 App', exact: true }).click();
    await page.getByRole('button', { name: '创建标准应用', exact: true }).click();
    const dialog = page.getByRole('dialog', { name: '创建 App', exact: true });
    const name = '应用名称'.repeat(50);
    const description = '中文说明'.repeat(500);
    const input = dialog.getByLabel('App 名称');
    await input.fill(name);
    await dialog.getByLabel('App 说明').fill(description);
    await input.focus();
    await input.dispatchEvent('compositionstart', { data: '称' });
    await input.press('Enter');
    await expect(dialog).toBeVisible();
    expect((await workspaceSnapshot(page)).workspaces[0]!.app).toBeFalsy();
    await input.dispatchEvent('compositionend', { data: '称' });
    await expect(input).toHaveValue(name);
    await expect(dialog.getByLabel('App 说明')).toHaveValue(description);
    await setWindowSize(app, 900, 700);
    await expect(dialog.getByRole('button', { name: '保存 App' })).toBeInViewport();
    await expect(dialog.getByRole('button', { name: '取消', exact: true })).toBeInViewport();
    await expect(input).toHaveValue(name);
    await mkdir(screensDir, { recursive: true });
    await page.screenshot({ path: path.join(screensDir, 'space-app-editor-dark-long-ime.png') });
    await dialog.getByRole('button', { name: '取消', exact: true }).click();
    await expect(dialog).not.toBeVisible();
    expect((await workspaceSnapshot(page)).workspaces[0]!.app).toBeFalsy();
  } finally {
    await app.close();
  }
});
