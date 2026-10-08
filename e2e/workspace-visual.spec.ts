import { setWorkspaceTheme } from './helpers';
import { mkdir, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { expect, test, type ElectronApplication, type Page } from '@playwright/test';
import { launchApp, setWindowSize, workspaceSnapshot, screensDir } from './helpers';
async function capture(app: ElectronApplication, page: Page, name: string) {
  await page.screenshot({ path: path.join(screensDir, `${name}.renderer.png`) });
  const png = await app.evaluate(async ({ BrowserWindow }) =>
    (await BrowserWindow.getAllWindows()[0]!.capturePage()).toPNG().toString('base64'),
  );
  await writeFile(path.join(screensDir, `${name}.window.png`), Buffer.from(png, 'base64'));
}
test('A12 三窗格、切换器、暗暖主题与窄窗真实窗口截图', async () => {
  const { app, page } = await launchApp({ sbxBin: new URL('./fixtures/sbx.mjs', import.meta.url).pathname });
  try {
    await mkdir(screensDir, { recursive: true });
    await setWindowSize(app, 1440, 900);
    await page.getByRole('button', { name: '左右分屏', exact: true }).click();
    await page.getByRole('navigation', { name: '空间标签' }).getByRole('button', { name: 'Agent 会话', exact: true }).click();
    let snapshot = await workspaceSnapshot(page);
    let w = snapshot.workspaces[0]!;
    const first = w.layout.kind === 'split' && w.layout.first.kind === 'pane' ? w.layout.first.paneId : '';
    await page.evaluate(
      ({ workspaceId, paneId }) =>
        window.studio.workbench.command({ commandId: crypto.randomUUID(), workspaceId, type: 'setRatio', paneId, ratio: 0.69 }),
      { workspaceId: w.workspaceId, paneId: first },
    );
    await page.getByRole('button', { name: '聚焦窗格 · TaskFlow 预览' }).click();
    await page.getByRole('button', { name: '上下分屏', exact: true }).first().click();
    await page.getByRole('navigation', { name: '空间标签' }).getByRole('button', { name: '开发终端', exact: true }).click();
    snapshot = await workspaceSnapshot(page);
    w = snapshot.workspaces[0]!;
    await page.evaluate(
      ({ workspaceId, paneId }) =>
        window.studio.workbench.command({ commandId: crypto.randomUUID(), workspaceId, type: 'setRatio', paneId, ratio: 0.7 }),
      { workspaceId: w.workspaceId, paneId: w.activePaneId },
    );
    await page.getByRole('region', { name: '沙箱终端' }).getByRole('button', { name: '连接终端', exact: true }).click();
    await expect(page.getByRole('region', { name: '沙箱终端' })).toContainText('已连接');
    await page.getByRole('region', { name: 'Agent 会话内容' }).getByRole('textbox').fill('补充优先级字段，保存后刷新仍保留。');
    await setWorkspaceTheme(page, 'light');
    await capture(app, page, 'workspace-three-panes-light');
    await page.getByRole('button', { name: '切换空间', exact: true }).click();
    await expect(page.getByRole('dialog', { name: '切换空间' })).toBeVisible();
    await capture(app, page, 'workspace-switcher');
    await page.keyboard.press('Escape');
    await setWorkspaceTheme(page, 'dark');
    await capture(app, page, 'workspace-three-panes-dark');
    await setWorkspaceTheme(page, 'warm');
    await capture(app, page, 'workspace-three-panes-warm');
    await setWindowSize(app, 900, 700);
    await expect(page.locator('[data-pane-id]:visible')).toHaveCount(1);
    await capture(app, page, 'workspace-narrow');
    await setWindowSize(app, 1440, 900);
    await expect(page.locator('[data-pane-id]:visible')).toHaveCount(3);
    await setWorkspaceTheme(page, 'light');
    const profile = await app.evaluate(({ app: electronApp }) => electronApp.getPath('userData'));
    await writeFile('/private/tmp/wsl-ui-visual-profile.txt', profile);
  } finally {
    await app.close();
  }
});
