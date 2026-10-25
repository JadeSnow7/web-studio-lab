import { mkdtemp } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { expect, test, type ElectronApplication, type Page } from '@playwright/test';
import {
  dismissNativeMenu,
  launchApp,
  openNativeMenu,
  openNewTabForm,
  paneMenu,
  previewInfo,
  setWindowSize,
  workspaceSnapshot,
  workshopNavigate,
  windowShots,
} from './helpers';
let app: ElectronApplication;
let page: Page;
test.afterEach(async () => {
  await app?.close();
});
const tabs = () => page.getByRole('navigation', { name: '空间标签', exact: true });
const notifications = () => page.getByRole('button', { name: /^通知 · \d+ 条未读$/ });
const nativeVisible = () => previewInfo(app).then((p) => p.visible);
async function launch(sbxBin?: string) {
  ({ app, page } = await launchApp({ sbxBin }));
  await setWindowSize(app, 1440, 900);
  await expect(tabs()).toBeVisible();
  await expect.poll(nativeVisible).toBe(true);
}

test('SR01/02/07/09：六个入口、空间专属标签、设置主题、草稿与原实例保持', async () => {
  await launch();
  await expect(page.getByRole('tablist', { name: /TaskFlow.*标签/ })).toHaveCount(0);
  await expect(page.getByRole('button', { name: '工作坊', exact: true })).toHaveCount(0);
  const before = await previewInfo(app);
  await tabs().getByRole('button', { name: 'Agent 会话', exact: true }).click();
  await page.getByRole('navigation', { name: '会话视图' }).getByRole('button', { name: '任务', exact: true }).click();
  // OPS-1 S2：「任务」视图不再有重复的目标输入框；草稿在唯一的会话输入框中。
  await page.getByRole('textbox', { name: '会话消息', exact: true }).fill('保留跨页中文草稿742');
  for (const name of ['首页', '资源', '会话', '任务', '设置']) {
    await workshopNavigate(page, name);
    await expect(tabs()).toHaveCount(0);
    await expect.poll(nativeVisible).toBe(false);
  }
  const theme = page.getByLabel('空间主题 · TaskFlow');
  await expect(theme).toBeVisible();
  for (const value of ['dark', 'warm', 'light', 'system']) {
    await theme.selectOption(value);
    await expect.poll(async () => (await workspaceSnapshot(page)).workspaces[0]?.theme).toBe(value);
    if (value !== 'system') await expect(page.locator('html')).toHaveAttribute('data-theme', value);
  }
  await workshopNavigate(page, '空间');
  await expect(page.getByRole('textbox', { name: '会话消息', exact: true })).toHaveValue('保留跨页中文草稿742');
  await tabs().getByRole('button', { name: 'TaskFlow 预览', exact: true }).click();
  await expect.poll(nativeVisible).toBe(true);
  expect((await previewInfo(app)).id).toBe(before.id);
  await windowShots(app, page, 'remake-six-sections');
});

test('SR03/04/06/10：标题栏左右入口、原生遮挡集合、通知不自动固定、关闭恢复焦点', async () => {
  await launch();
  await page.getByRole('button', { name: '取消固定 Workshop', exact: true }).click();
  await expect(tabs()).toHaveCount(0);
  await page.getByRole('button', { name: '展开 Workshop', exact: true }).click();
  await expect(page.getByRole('complementary', { name: 'Workshop（临时展开）' })).toBeVisible();
  await expect.poll(nativeVisible).toBe(false);
  await page.getByRole('button', { name: '固定 Workshop', exact: true }).focus();
  await notifications().evaluate((button) => (button as HTMLButtonElement).click());
  await expect(page.getByRole('complementary', { name: '通知栏' })).toHaveClass(/right-panel-overlay/);
  await expect(page.getByRole('button', { name: '固定通知', exact: true })).toHaveAttribute('aria-pressed', 'false');
  await expect(page.getByRole('complementary', { name: '通知栏' }).getByRole('textbox')).toHaveCount(0);
  await page.getByRole('button', { name: '收起通知栏', exact: true }).evaluate((button) => (button as HTMLButtonElement).click());
  await expect(page.getByRole('complementary', { name: 'Workshop（临时展开）' })).toBeVisible();
  await expect.poll(nativeVisible).toBe(false);
  await page.getByRole('complementary', { name: 'Workshop（临时展开）' }).press('Escape');
  await expect.poll(nativeVisible).toBe(true);
  await expect(page.getByRole('button', { name: '展开 Workshop', exact: true })).toBeFocused();
  const native = (await previewInfo(app)).bounds;
  for (const trigger of [page.getByRole('button', { name: '展开 Workshop', exact: true }), notifications()]) {
    const bounds = await trigger.boundingBox();
    if (!bounds) throw new Error('missing trigger');
    expect(
      bounds.x + bounds.width <= native.x ||
        bounds.x >= native.x + native.width ||
        bounds.y + bounds.height <= native.y ||
        bounds.y >= native.y + native.height,
    ).toBe(true);
  }
  await windowShots(app, page, 'remake-floating-panels');
});

test('SR10：通知与窗格菜单共存、switcher交接editor、快速开关resize不复活原生网页', async () => {
  await launch();
  await paneMenu(app, page, '左右分屏');
  await notifications().click();
  // 窗格菜单是 Main 原生菜单（OPS-1 S5），不进入遮挡集合：通知栏收起后，即使菜单仍打开，原生网页也恢复。
  const paneMenuButton = () => page.getByRole('button', { name: '窗格操作', exact: true }).first();
  await openNativeMenu(app, () => paneMenuButton().click());
  await expect.poll(nativeVisible).toBe(false);
  await page.getByRole('button', { name: '收起通知栏', exact: true }).click();
  await expect.poll(nativeVisible).toBe(true);
  await dismissNativeMenu(app);
  await expect.poll(nativeVisible).toBe(true);
  await notifications().click();
  await openNativeMenu(app, () => paneMenuButton().click());
  // 菜单的 Esc / 点外部只关闭菜单本身，不误关底层通知栏；通知栏仍让原生网页让位。
  await dismissNativeMenu(app);
  await expect(page.getByRole('complementary', { name: '通知栏' })).toBeVisible();
  await expect.poll(nativeVisible).toBe(false);
  await page.keyboard.press('Escape');
  await expect(page.getByRole('complementary', { name: '通知栏' })).toHaveCount(0);
  await expect(notifications()).toBeFocused();
  await expect.poll(nativeVisible).toBe(true);
  await page.getByRole('button', { name: '切换空间', exact: true }).click();
  await expect.poll(nativeVisible).toBe(false);
  await page.getByRole('button', { name: '新建空间', exact: true }).click();
  await expect(page.getByRole('dialog', { name: '新建空间', exact: true })).toBeVisible();
  await expect.poll(nativeVisible).toBe(false);
  await page.getByRole('button', { name: '取消', exact: true }).click();
  await expect.poll(nativeVisible).toBe(true);
  await expect(page.getByRole('button', { name: '切换空间', exact: true })).toBeFocused();
  for (let index = 0; index < 3; index++) {
    await notifications().click();
    await setWindowSize(app, 1420 + index * 5, 900);
    await expect.poll(nativeVisible).toBe(false);
    await notifications().click();
    await expect.poll(nativeVisible).toBe(true);
  }
});

test('SR05/11：独立固定偏好、窄窗投影不改分割树、重启只恢复pin', async () => {
  const userData = await mkdtemp(path.join(tmpdir(), 'wsl-remake-restart-'));
  ({ app, page } = await launchApp({ userData }));
  await setWindowSize(app, 1440, 900);
  await expect(tabs()).toBeVisible();
  await paneMenu(app, page, '左右分屏');
  const snapshot = await workspaceSnapshot(page),
    layout = snapshot.workspaces[0]?.layout;
  await notifications().click();
  await page.getByRole('button', { name: '固定通知', exact: true }).click();
  await expect(page.getByRole('complementary', { name: '通知栏' })).not.toHaveClass(/right-panel-overlay/);
  await page.getByRole('button', { name: '收起通知栏', exact: true }).click();
  const pinned = await page.evaluate(() => localStorage.getItem('wsl-shell-panels-v1'));
  expect(JSON.parse(pinned ?? '{}')).toEqual({ leftPinned: true, rightPinned: true });
  await notifications().click();
  await setWindowSize(app, 1024, 720);
  await expect(tabs()).toHaveCount(0);
  expect((await workspaceSnapshot(page)).workspaces[0]?.layout).toEqual(layout);
  await notifications().click();
  await expect.poll(nativeVisible).toBe(false);
  await page.getByRole('button', { name: '收起通知栏', exact: true }).click();
  await setWindowSize(app, 1440, 900);
  await expect(tabs()).toBeVisible();
  expect((await workspaceSnapshot(page)).workspaces[0]?.layout).toEqual(layout);
  await app.close();
  ({ app, page } = await launchApp({ userData }));
  await setWindowSize(app, 1440, 900);
  await expect(tabs()).toBeVisible();
  expect((await workspaceSnapshot(page)).workspaces[0]?.layout).toEqual(layout);
  await expect(page.getByRole('complementary', { name: '通知栏' })).not.toHaveClass(/right-panel-overlay/);
  await page.getByRole('button', { name: '取消固定通知', exact: true }).click();
  await expect(page.getByRole('complementary', { name: '通知栏' })).toHaveCount(0);
});

test('SR01/09：首页新建对话框取消回原入口，主题同步实际终端与系统', async () => {
  await launch(new URL('./fixtures/sbx.mjs', import.meta.url).pathname);
  await page.getByRole('button', { name: '切换空间', exact: true }).click();
  await page.getByRole('button', { name: '管理空间', exact: true }).click();
  await page.getByRole('button', { name: '取消', exact: true }).click();
  await workshopNavigate(page, '首页');
  const create = page.getByRole('button', { name: '新建空间', exact: true });
  await create.click();
  await expect(page.getByRole('dialog', { name: '新建空间', exact: true })).toBeVisible();
  await page.getByRole('button', { name: '取消', exact: true }).click();
  await expect(create).toBeFocused();
  await expect(page.getByRole('heading', { name: '今天从哪里开始？' })).toBeVisible();
  await create.click();
  await page.getByRole('dialog', { name: '新建空间', exact: true }).getByLabel('名称').fill('首页新空间742');
  await page.getByRole('button', { name: '保存', exact: true }).click();
  await expect(page.getByRole('button', { name: '切换空间', exact: true })).toContainText('首页新空间742');
  await expect(tabs()).toBeVisible();
  await openNewTabForm(app, page, '终端');
  await page.getByLabel('名称', { exact: true }).fill('主题终端742');
  await expect(page.getByLabel('标签类型')).toHaveValue('terminal');
  await page.getByLabel('资源环境').selectOption('sandbox');
  await page.getByRole('button', { name: '保存', exact: true }).click();
  await tabs().getByRole('button', { name: '主题终端742', exact: true }).click();
  await workshopNavigate(page, '设置');
  const theme = page.getByLabel('空间主题 · 首页新空间742');
  for (const value of ['light', 'dark', 'warm']) {
    await theme.selectOption(value);
    await expect(page.locator('html')).toHaveAttribute('data-theme', value);
    await workshopNavigate(page, '空间');
    await expect
      .poll(() =>
        page
          .locator('.xterm-scrollable-element')
          .last()
          .evaluate((element) => {
            const swatch = document.createElement('span');
            swatch.style.backgroundColor = getComputedStyle(document.documentElement).getPropertyValue('--content');
            document.body.append(swatch);
            const expected = getComputedStyle(swatch).backgroundColor;
            swatch.remove();
            return getComputedStyle(element).backgroundColor === expected;
          }),
      )
      .toBe(true);
    const terminalBounds = await page.locator('.terminal-panel:visible').boundingBox();
    if (!terminalBounds) throw new Error('missing visible terminal');
    expect(terminalBounds.height).toBeGreaterThan(500);
    const surfaceBounds = await page.locator('.terminal-surface:visible').boundingBox();
    if (!surfaceBounds) throw new Error('missing terminal surface');
    expect(surfaceBounds.height).toBeGreaterThan(terminalBounds.height - 180);
    await windowShots(app, page, `remake-terminal-${value}`);
    await workshopNavigate(page, '设置');
  }
  await theme.selectOption('system');
  await page.emulateMedia({ colorScheme: 'dark' });
  await expect(page.locator('html')).toHaveAttribute('data-theme', 'dark');
  await page.emulateMedia({ colorScheme: 'light' });
  await expect(page.locator('html')).toHaveAttribute('data-theme', 'light');
});

test('SR10/11：窄窗展开后放宽再缩窄不会留下无屏障浮层', async () => {
  await launch();
  await notifications().click();
  await page.getByRole('button', { name: '固定通知', exact: true }).click();
  await setWindowSize(app, 1024, 720);
  await page.getByRole('button', { name: '展开 Workshop', exact: true }).click();
  await expect.poll(nativeVisible).toBe(false);
  await setWindowSize(app, 1440, 900);
  await expect(tabs()).toBeVisible();
  await expect.poll(nativeVisible).toBe(true);
  await setWindowSize(app, 1024, 720);
  await expect(page.getByRole('complementary', { name: 'Workshop（临时展开）' })).toHaveCount(0);
  await expect.poll(nativeVisible).toBe(true);
  await notifications().click();
  await expect.poll(nativeVisible).toBe(false);
  await setWindowSize(app, 1440, 900);
  await expect.poll(nativeVisible).toBe(true);
  await setWindowSize(app, 1024, 720);
  await expect(page.getByRole('complementary', { name: '通知栏' })).toHaveCount(0);
  await expect.poll(nativeVisible).toBe(true);
  expect(JSON.parse((await page.evaluate(() => localStorage.getItem('wsl-shell-panels-v1'))) ?? '{}')).toEqual({
    leftPinned: true,
    rightPinned: true,
  });
});

test('SR03：标题栏点击展开，悬停与移出不切换，外部点击与Escape收起', async () => {
  await launch();
  await page.getByRole('button', { name: '取消固定 Workshop', exact: true }).click();
  const trigger = page.locator('#left-panel-trigger');
  await expect(trigger).toHaveAccessibleName('展开 Workshop');
  await expect(trigger).toHaveAttribute('title', '展开 Workshop（⌘B）');
  await expect(page.locator('.workshop-edge, .notification-edge')).toHaveCount(0);
  const body = await page.locator('.app-body').boundingBox();
  const content = await page.locator('main.content').boundingBox();
  expect(content).toEqual(body);
  await trigger.hover();
  await page.waitForTimeout(250);
  const floating = page.getByRole('complementary', { name: 'Workshop（临时展开）' });
  await expect(floating).toHaveCount(0);
  await expect.poll(nativeVisible).toBe(true);
  await trigger.click();
  await expect(floating).toBeVisible();
  await expect(trigger).toHaveAccessibleName('收起 Workshop');
  await expect.poll(nativeVisible).toBe(false);
  await floating.hover();
  await page.mouse.move(700, 24);
  await page.waitForTimeout(400);
  await expect(floating).toBeVisible();
  await page.locator('.content').click({ position: { x: 650, y: 20 } });
  await expect(floating).toHaveCount(0);
  await expect.poll(nativeVisible).toBe(true);
  await trigger.click();
  await floating.getByRole('button', { name: '固定 Workshop', exact: true }).focus();
  await page.keyboard.press('Escape');
  await expect(floating).toHaveCount(0);
  await expect(trigger).toBeFocused();
  await expect.poll(nativeVisible).toBe(true);
  await workshopNavigate(page, '首页');
  await trigger.click();
  const input = page.getByRole('region', { name: '混合输入' }).getByRole('textbox');
  await input.click();
  await expect(floating).toHaveCount(0);
  await expect(input).toBeFocused();
  await windowShots(app, page, 'titlebar-panels-collapsed');
});

test('标题栏触发器在专注模式下恢复可见侧栏，未读0不显示角标', async () => {
  await launch();
  await expect(notifications()).toHaveAccessibleName('通知 · 0 条未读');
  await expect(notifications().locator('.notification-badge')).toHaveCount(0);
  const toggleFocus = () =>
    app.evaluate(({ Menu }) => {
      function find(items: Electron.MenuItem[]): Electron.MenuItem | undefined {
        for (const item of items) {
          if (item.accelerator === 'CmdOrCtrl+Shift+F' || item.label === '专注模式') return item;
          const nested = item.submenu && find(item.submenu.items);
          if (nested) return nested;
        }
        return undefined;
      }
      const item = find(Menu.getApplicationMenu()?.items ?? []);
      if (!item) throw new Error('missing focus menu command');
      item.click();
    });
  await toggleFocus();
  await expect(page.getByRole('button', { name: '恢复布局', exact: true })).toBeVisible();
  await page.locator('#left-panel-trigger').click();
  await expect(page.getByRole('button', { name: '恢复布局', exact: true })).toHaveCount(0);
  await expect(tabs()).toBeVisible();
  await expect.poll(nativeVisible).toBe(true);
  await toggleFocus();
  await notifications().click();
  await expect(page.getByRole('button', { name: '恢复布局', exact: true })).toHaveCount(0);
  await expect(page.getByRole('complementary', { name: '通知栏' })).toBeVisible();
  await expect.poll(nativeVisible).toBe(false);
  await page.keyboard.press('Escape');
  await expect(notifications()).toBeFocused();
  await expect.poll(nativeVisible).toBe(true);
});
