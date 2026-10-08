# Instructions

- Following Playwright test failed.
- Explain why, be concise, respect Playwright best practices.
- Provide a snippet of code with the fix, if possible.

# Test info

- Name: workspace-visual.spec.ts >> A12 三窗格、切换器、暗暖主题与窄窗真实窗口截图
- Location: e2e/workspace-visual.spec.ts:13:1

# Error details

```
TimeoutError: locator.click: Timeout 30000ms exceeded.
Call log:
  - waiting for getByRole('region', { name: '资源终端' }).getByRole('button', { name: '连接终端', exact: true })
    - locator resolved to <button disabled class="btn" type="button">连接终端</button>
  - attempting click action
    2 × waiting for element to be visible, enabled and stable
      - element is not enabled
    - retrying click action
    - waiting 20ms
    2 × waiting for element to be visible, enabled and stable
      - element is not enabled
    - retrying click action
      - waiting 100ms
    56 × waiting for element to be visible, enabled and stable
       - element is not enabled
     - retrying click action
       - waiting 500ms

```

# Test source

```ts
  1  | import { setWorkspaceTheme } from './helpers';
  2  | import { mkdir, writeFile } from 'node:fs/promises';
  3  | import path from 'node:path';
  4  | import { expect, test, type ElectronApplication, type Page } from '@playwright/test';
  5  | import { launchApp, setWindowSize, workspaceSnapshot, screensDir } from './helpers';
  6  | async function capture(app: ElectronApplication, page: Page, name: string) {
  7  |   await page.screenshot({ path: path.join(screensDir, `${name}.renderer.png`) });
  8  |   const png = await app.evaluate(async ({ BrowserWindow }) =>
  9  |     (await BrowserWindow.getAllWindows()[0]!.capturePage()).toPNG().toString('base64'),
  10 |   );
  11 |   await writeFile(path.join(screensDir, `${name}.window.png`), Buffer.from(png, 'base64'));
  12 | }
  13 | test('A12 三窗格、切换器、暗暖主题与窄窗真实窗口截图', async () => {
  14 |   const { app, page } = await launchApp({ sbxBin: new URL('./fixtures/sbx.mjs', import.meta.url).pathname });
  15 |   try {
  16 |     await mkdir(screensDir, { recursive: true });
  17 |     await setWindowSize(app, 1440, 900);
  18 |     await page.getByRole('button', { name: '左右分屏', exact: true }).click();
  19 |     await page.getByRole('navigation', { name: '空间标签' }).getByRole('button', { name: 'Agent 会话', exact: true }).click();
  20 |     let snapshot = await workspaceSnapshot(page);
  21 |     let w = snapshot.workspaces[0]!;
  22 |     const first = w.layout.kind === 'split' && w.layout.first.kind === 'pane' ? w.layout.first.paneId : '';
  23 |     await page.evaluate(
  24 |       ({ workspaceId, paneId }) =>
  25 |         window.studio.workbench.command({ commandId: crypto.randomUUID(), workspaceId, type: 'setRatio', paneId, ratio: 0.69 }),
  26 |       { workspaceId: w.workspaceId, paneId: first },
  27 |     );
  28 |     await page.getByRole('button', { name: '聚焦窗格 · TaskFlow 预览' }).click();
  29 |     await page.getByRole('button', { name: '上下分屏', exact: true }).first().click();
  30 |     await page.getByRole('navigation', { name: '空间标签' }).getByRole('button', { name: '开发终端', exact: true }).click();
  31 |     snapshot = await workspaceSnapshot(page);
  32 |     w = snapshot.workspaces[0]!;
  33 |     await page.evaluate(
  34 |       ({ workspaceId, paneId }) =>
  35 |         window.studio.workbench.command({ commandId: crypto.randomUUID(), workspaceId, type: 'setRatio', paneId, ratio: 0.7 }),
  36 |       { workspaceId: w.workspaceId, paneId: w.activePaneId },
  37 |     );
> 38 |     await page.getByRole('region', { name: '资源终端' }).getByRole('button', { name: '连接终端', exact: true }).click();
     |                                                                                                         ^ TimeoutError: locator.click: Timeout 30000ms exceeded.
  39 |     await expect(page.getByRole('region', { name: '资源终端' })).toContainText('已连接');
  40 |     await page
  41 |       .getByRole('region', { name: 'Agent 会话内容' })
  42 |       .getByRole('textbox', { name: '会话消息', exact: true })
  43 |       .fill('补充优先级字段，保存后刷新仍保留。');
  44 |     await setWorkspaceTheme(page, 'light');
  45 |     await capture(app, page, 'workspace-three-panes-light');
  46 |     await page.getByRole('button', { name: '切换空间', exact: true }).click();
  47 |     await expect(page.getByRole('dialog', { name: '切换空间' })).toBeVisible();
  48 |     await capture(app, page, 'workspace-switcher');
  49 |     await page.keyboard.press('Escape');
  50 |     await setWorkspaceTheme(page, 'dark');
  51 |     await capture(app, page, 'workspace-three-panes-dark');
  52 |     await setWorkspaceTheme(page, 'warm');
  53 |     await capture(app, page, 'workspace-three-panes-warm');
  54 |     await setWindowSize(app, 900, 700);
  55 |     await expect(page.locator('[data-pane-id]:visible')).toHaveCount(1);
  56 |     await capture(app, page, 'workspace-narrow');
  57 |     await setWindowSize(app, 1440, 900);
  58 |     await expect(page.locator('[data-pane-id]:visible')).toHaveCount(3);
  59 |     await setWorkspaceTheme(page, 'light');
  60 |     const profile = await app.evaluate(({ app: electronApp }) => electronApp.getPath('userData'));
  61 |     await writeFile('/private/tmp/wsl-ui-visual-profile.txt', profile);
  62 |   } finally {
  63 |     await app.close();
  64 |   }
  65 | });
  66 | 
```