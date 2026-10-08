import { mkdir } from 'node:fs/promises';
import { expect, test, type ElectronApplication, type Page } from '@playwright/test';
import { launchApp, previewClick, previewElementCenter, previewInfo, screensDir, setWindowSize, shot, windowShots } from './helpers';

let app: ElectronApplication;
let page: Page;

test.describe.configure({ mode: 'serial' });

test.beforeAll(async () => {
  await mkdir(screensDir, { recursive: true });
  ({ app, page } = await launchApp());
  await setWindowSize(app, 1440, 900);
});

test.afterAll(async () => {
  await app?.close();
});

const workshop = () => page.getByRole('complementary', { name: 'Workshop', exact: true });

test('启动：窗口、安全边界与 Browser 区真实加载', async () => {
  await expect(page.getByRole('tab', { name: /任务 · TaskFlow 演示/ })).toBeVisible();
  // 工作台 renderer 没有 Node 能力，只有 preload 暴露的 window.studio。
  const rendererCaps = await page.evaluate(() => ({
    require: typeof (window as unknown as { require?: unknown }).require,
    process: typeof (window as unknown as { process?: unknown }).process,
    studio: Object.keys((window as unknown as { studio: object }).studio),
  }));
  expect(rendererCaps).toEqual({
    require: 'undefined',
    process: 'undefined',
    studio: ['resources', 'chat', 'terminal', 'preview', 'app', 'execution', 'shell'],
  });

  const info = await previewInfo(app);
  expect(info.url).toBe('wsl-demo://taskflow/index.html');
  expect(info.visible).toBe(true);
  // Browser 区页面没有 preload：既没有 window.studio，也没有 Node。
  const previewCaps = await app.evaluate(async ({ BrowserWindow }) => {
    const view = BrowserWindow.getAllWindows()[0]?.contentView.children[0] as Electron.WebContentsView;
    return view.webContents.executeJavaScript(
      '({ studio: typeof window.studio, require: typeof window.require, process: typeof window.process })',
    );
  });
  expect(previewCaps).toEqual({ studio: 'undefined', require: 'undefined', process: 'undefined' });

  // 原生视图与占位元素位置一致。
  const host = await page.locator('.preview-host').boundingBox();
  expect(host).not.toBeNull();
  expect(Math.abs((host?.x ?? 0) - info.bounds.x)).toBeLessThanOrEqual(1);
  expect(Math.abs((host?.width ?? 0) - info.bounds.width)).toBeLessThanOrEqual(1);
  await windowShots(app, page, '01-workbench-initial');
});

test('点选：开启选择模式，点击页面元素后采集摘要、截图与页面身份', async () => {
  await workshop().getByRole('button', { name: '选择元素' }).click();
  await expect(page.getByRole('button', { name: /选择中 · Esc 取消/ })).toBeVisible();
  const point = await previewElementCenter(app, '[data-testid="due-1"]');
  await previewClick(app, point);
  const card = page.locator('.capture-card');
  await expect(card).toBeVisible();
  await expect(card).toContainText('td');
  await expect(card).toContainText('未设置');
  await expect(card).toContainText('wsl-demo://taskflow/index.html');
  const info = await previewInfo(app);
  await expect(card).toContainText(`webContents #${info.id}`);
  await expect(page.locator('.freshness')).toHaveText('有效');
  // 演示页面故意读取错误字段 deadline，console.error 进入现场。
  await expect(card).toContainText('运行错误');
  await expect(card.locator('img')).toHaveCount(2);
  await windowShots(app, page, '02-capture');
});

test('任务确认：中文目标、允许项目、验收与预算，确认后生成 v1', async () => {
  await workshop().getByRole('radio', { name: /C3/ }).click();
  const goal = workshop().getByLabel('修改目标');
  await goal.fill('');
  await goal.focus();
  await page.keyboard.insertText('把任务列表的截止日期改为读取 dueDate，修复“未设置”。');
  await expect(goal).toHaveValue('把任务列表的截止日期改为读取 dueDate，修复“未设置”。');
  await expect(workshop()).toContainText('Codex CLI · 尚未接入/验证');
  await expect(workshop().getByRole('spinbutton').first()).toHaveValue('3');
  await expect(workshop().getByRole('spinbutton').nth(1)).toHaveValue('15');
  await workshop()
    .getByRole('button', { name: /确认任务（生成 v1）/ })
    .click();
  await expect(workshop().locator('.version-card')).toContainText('任务 v1 · C3 修复前后端字段不一致');
  await expect(workshop().getByRole('button', { name: /开始运行/ })).toBeDisabled();
  await expect(workshop()).toContainText('执行服务（T04）与 Codex CLI 通路（T02）尚未接入');
  await shot(page, '03-task-confirmed');
});

test('导航：页面跳转后旧现场失效，需要重新采集', async () => {
  const link = await previewElementCenter(app, 'a[href="task.html?id=1"]');
  await previewClick(app, link);
  await expect.poll(async () => (await previewInfo(app)).url).toContain('task.html?id=1');
  await expect(page.locator('.freshness')).toHaveText('已失效');
  await expect(page.locator('.capture-card')).toContainText('旧现场与元素引用失效');
  await workshop()
    .getByRole('button', { name: /修改任务/ })
    .click();
  await expect(workshop().getByText('页面已导航，旧现场失效，需要重新采集')).toBeVisible();
  await windowShots(app, page, '04-capture-stale');
  // 重新采集后可以确认 v2。
  await workshop().getByRole('button', { name: '重新选择元素' }).click();
  await previewClick(app, await previewElementCenter(app, '[data-testid="edit-task"]'));
  await expect(page.locator('.freshness')).toHaveText('有效');
  await workshop()
    .getByRole('button', { name: /确认任务（生成 v2）/ })
    .click();
  await expect(workshop().locator('.version-card')).toContainText('任务 v2');
  await page.getByRole('button', { name: '后退' }).click();
  await expect.poll(async () => (await previewInfo(app)).url).toBe('wsl-demo://taskflow/index.html');
});

test('选择模式中导航：退出选择模式，之后的页面点击正常生效', async () => {
  await workshop().getByRole('button', { name: '重新选择元素' }).click();
  await expect(page.getByRole('button', { name: /选择中 · Esc 取消/ })).toBeVisible();
  const address = page.getByLabel('页面地址');
  await address.fill('wsl-demo://taskflow/members.html');
  await address.press('Enter');
  await expect.poll(async () => (await previewInfo(app)).url).toBe('wsl-demo://taskflow/members.html');
  await expect(workshop()).toContainText('页面已导航，点选已取消');
  // 回归：选择模式残留时，这次点击会被拦截，页面不会跳转。
  await previewClick(app, await previewElementCenter(app, 'header a[href="index.html"]'));
  await expect.poll(async () => (await previewInfo(app)).url).toBe('wsl-demo://taskflow/index.html');
  await expect(page.locator('.freshness')).toHaveText('已失效');
});

test('Tab 与演示状态：日志 / diff / 报告切换，审阅只作用于演示记录', async () => {
  await page.getByRole('tab', { name: '运行日志' }).click();
  await expect(page.getByText('还没有可显示的运行记录')).toBeVisible();
  expect((await previewInfo(app)).visible).toBe(false);

  await workshop()
    .getByRole('button', { name: /演示状态检查/ })
    .click();
  await workshop().getByRole('option', { name: '成功待审阅' }).click();
  await expect(page.getByRole('log', { name: '运行事件' })).toContainText('run.finished');
  await page.getByRole('tab', { name: '源码 diff' }).click();
  await expect(page.getByRole('tabpanel', { name: '源码 diff' }).locator('pre.diff')).toContainText("priority: text('priority'");
  await page.getByRole('tab', { name: '验收报告' }).click();
  await expect(page.getByRole('heading', { name: '固定验收报告' })).toBeVisible();
  await expect(page.locator('.view-banner')).toContainText('不是真实运行结果');
  await shot(page, '05-report-demo');

  await workshop().getByRole('button', { name: '接受结果' }).click();
  await expect(workshop()).toContainText('已接受 · 绑定任务 v1 · 源码快照 sha256:demo-7d41e0');

  await workshop().getByRole('option', { name: '无法判断' }).click();
  await expect(page.locator('.result-error')).toHaveText('无法判断（工具故障）');
  await expect(workshop()).toContainText('不是业务验收失败');
  await workshop().getByRole('option', { name: '取消中' }).click();
  await expect(workshop()).toContainText('已发 SIGTERM，等待退出');
  await shot(page, '06-demo-cancelling');

  await page.getByRole('tab', { name: /任务 · TaskFlow 演示/ }).click();
  await expect.poll(async () => (await previewInfo(app)).visible).toBe(true);
});

test('导航与草稿：首页个人作用域不能向空间发送，草稿按会话保留', async () => {
  const spaceComposer = page.getByRole('complementary', { name: '通信栏' }).getByRole('textbox');
  await spaceComposer.focus();
  await page.keyboard.insertText('空间草稿：先看列表页');
  await page.getByRole('navigation', { name: 'Workshop 导航' }).getByRole('button', { name: '首页' }).click();
  await expect(page.getByRole('heading', { name: '今天从哪里开始？' })).toBeVisible();
  expect((await previewInfo(app)).visible).toBe(false);
  await expect(page.getByRole('complementary', { name: '通信栏' })).toContainText('选择空间后对话');
  const homeInput = page.getByRole('region', { name: '混合输入' }).getByRole('textbox');
  await expect(homeInput).toHaveValue('');
  await homeInput.focus();
  await page.keyboard.insertText('个人草稿');
  await page.keyboard.press('Enter');
  await expect(page.getByRole('region', { name: '混合输入' })).toContainText('未发送');
  await shot(page, '07-home');

  await page.getByRole('navigation', { name: 'Workshop 导航' }).getByRole('button', { name: '会话' }).click();
  await expect(page.getByRole('region', { name: '会话详情' }).getByRole('textbox')).toHaveValue('空间草稿：先看列表页');
  for (const name of ['资源', '任务', '设置'] as const) {
    await page.getByRole('navigation', { name: 'Workshop 导航' }).getByRole('button', { name }).click();
  }
  await expect(page.getByRole('region', { name: '应用设置' })).toContainText('Electron');
  await shot(page, '08-settings');
  await page.getByRole('navigation', { name: 'Workshop 导航' }).getByRole('button', { name: '空间' }).click();
  await expect(spaceComposer).toHaveValue('空间草稿：先看列表页');
  await expect(page.locator('.version-card')).toContainText('任务 v2');
  await expect.poll(async () => (await previewInfo(app)).visible).toBe(true);
});

test('Workshop：隐藏、悬停展开（页面以快照让位）、固定', async () => {
  await page.getByRole('button', { name: '显示或隐藏 Workshop（⌘B）' }).click();
  await expect(workshop()).toHaveCount(0);
  await page.getByRole('button', { name: '显示或隐藏 Workshop（⌘B）' }).click();
  await expect(workshop()).toBeVisible();

  await page.getByRole('button', { name: '取消固定 Workshop' }).click();
  await expect(workshop()).toHaveCount(0);
  await page.getByRole('button', { name: '展开 Workshop' }).click();
  const overlay = page.getByRole('complementary', { name: 'Workshop（临时展开）' });
  await expect(overlay).toBeVisible();
  await expect.poll(async () => (await previewInfo(app)).visible).toBe(false);
  await expect(page.locator('.preview-frozen')).toBeVisible();
  await shot(page, '09-workshop-overlay');
  await overlay.getByRole('button', { name: '固定 Workshop' }).click();
  await expect(workshop()).toBeVisible();
  await expect.poll(async () => (await previewInfo(app)).visible).toBe(true);
});

test('菜单快捷键：⌘B 与 ⌘L 通过应用菜单生效', async () => {
  const clickMenu = (label: string) =>
    app.evaluate(({ Menu, BrowserWindow }, target) => {
      const find = (items: Electron.MenuItem[]): Electron.MenuItem | undefined => {
        for (const item of items) {
          if (item.label === target) return item;
          const nested = item.submenu ? find(item.submenu.items) : undefined;
          if (nested) return nested;
        }
        return undefined;
      };
      const item = find(Menu.getApplicationMenu()?.items ?? []);
      if (!item) throw new Error(`menu item not found: ${target}`);
      item.click(undefined, BrowserWindow.getAllWindows()[0], undefined as never);
      return item.accelerator ?? null;
    }, label);
  expect(await clickMenu('显示或隐藏 Workshop')).toBe('CmdOrCtrl+B');
  await expect(workshop()).toHaveCount(0);
  await clickMenu('显示或隐藏 Workshop');
  await expect(workshop()).toBeVisible();
  expect(await clickMenu('编辑地址')).toBe('CmdOrCtrl+L');
  await expect(page.getByLabel('页面地址')).toBeFocused();
  await page.keyboard.press('Escape');
});

test('较窄窗口：右栏改为覆盖层，Browser 区让位并保持可点击', async () => {
  await setWindowSize(app, 1024, 720);
  await expect(page.getByRole('complementary', { name: '通信栏' })).toHaveClass(/right-panel-overlay/);
  await expect.poll(async () => (await previewInfo(app)).visible).toBe(false);
  await shot(page, '10-narrow-overlay');
  await page.getByRole('button', { name: '收起通信栏', exact: true }).click();
  await expect.poll(async () => (await previewInfo(app)).visible).toBe(true);
  const info = await previewInfo(app);
  const host = await page.locator('.preview-host').boundingBox();
  expect(Math.abs((host?.width ?? 0) - info.bounds.width)).toBeLessThanOrEqual(1);
  expect(info.bounds.width).toBeGreaterThan(300);
  await expect(workshop().getByRole('button', { name: '重新选择元素' })).toBeVisible();
  await windowShots(app, page, '11-narrow');
  await setWindowSize(app, 1440, 900);
});
