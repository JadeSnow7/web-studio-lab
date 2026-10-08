import { expect, test, type ElectronApplication, type Page } from '@playwright/test';
import {
  launchApp,
  previewClick,
  previewElementCenter,
  previewInfo,
  setWindowSize,
  workspaceSnapshot,
  windowShots,
  workshopNavigate,
} from './helpers';
let app: ElectronApplication, page: Page;
test.describe.configure({ mode: 'serial' });
test.beforeAll(async () => {
  ({ app, page } = await launchApp({ sbxBin: new URL('./fixtures/sbx.mjs', import.meta.url).pathname }));
  await setWindowSize(app, 1440, 900);
});
test.afterAll(async () => {
  await app?.close();
});
const session = () => page.getByRole('region', { name: 'Agent 会话内容' });

test('启动：窗口、安全边界与 Browser 区真实加载', async () => {
  await expect(page.getByRole('button', { name: 'TaskFlow 预览', exact: true })).toBeVisible();
  expect(
    await page.evaluate(() => ({
      require: typeof (window as Window & { require?: unknown }).require,
      process: typeof (window as Window & { process?: unknown }).process,
      studio: Object.keys(window.studio),
    })),
  ).toEqual({
    require: 'undefined',
    process: 'undefined',
    studio: ['workbench', 'chat', 'app', 'execution', 'shell'],
  });
  await expect.poll(async () => (await previewInfo(app)).url).toBe('wsl-demo://taskflow/index.html');
  const info = await previewInfo(app);
  expect(info.url).toBe('wsl-demo://taskflow/index.html');
  expect(info.visible).toBe(true);
  expect(
    await app.evaluate(async ({ BrowserWindow }) => {
      const view = BrowserWindow.getAllWindows()[0]!.contentView.children[0] as Electron.WebContentsView;
      return view.webContents.executeJavaScript(
        '({studio:typeof window.studio,require:typeof window.require,process:typeof window.process})',
      );
    }),
  ).toEqual({ studio: 'undefined', require: 'undefined', process: 'undefined' });
  const host = await page.locator('.preview-host:visible').boundingBox();
  expect(host).not.toBeNull();
  expect(Math.abs(host!.x - info.bounds.x)).toBeLessThanOrEqual(1);
  expect(Math.abs(host!.width - info.bounds.width)).toBeLessThanOrEqual(1);
  await windowShots(app, page, 'workbench-start');
});

test('点选：明确目标后采集摘要、截图与页面身份，先采集后确认不会崩溃', async () => {
  await page.getByRole('button', { name: '选择元素', exact: true }).click();
  await expect(page.getByRole('status')).toContainText('关联会话');
  expect((await workspaceSnapshot(page)).workspaces[0]!.resources.find((r) => r.kind === 'web')!.preview!.picking).toBe(false);
  await page.getByRole('button', { name: '左右分屏', exact: true }).click();
  await page.getByRole('button', { name: 'Agent 会话', exact: true }).click();
  await session().getByRole('button', { name: '任务', exact: true }).click();
  await session().getByLabel('附加目标（明确选择）').selectOption({ label: 'TaskFlow 预览' });
  await session().getByRole('button', { name: '采集目标元素' }).click();
  await expect(page.getByRole('button', { name: '选择中 · Esc 取消' })).toBeVisible();
  await previewClick(app, await previewElementCenter(app, '[data-testid="due-1"]'));
  await expect(session()).toContainText('现场适用性：有效');
  await expect(session().locator('img.context-image')).toHaveCount(2);
  await session().getByText('诊断详情').click();
  await expect(session().locator('pre')).toContainText('webContentsId');
  await expect(session().locator('pre')).toContainText('未设置');
  const s = await workspaceSnapshot(page);
  expect(s.workspaces[0]?.sessions[0]?.taskVersions).toHaveLength(0);
  await windowShots(app, page, 'workbench-context-before-confirm');
});

test('任务确认：中文目标生成权威不可变版本，重复点击不生成双版本', async () => {
  await session().getByRole('button', { name: '任务', exact: true }).click();
  await session().getByLabel('修改目标').fill('修复截止日期字段，保存之后刷新仍保留。');
  await session().getByLabel('允许修改范围（每行一条）').fill('src/task.ts');
  await session().getByLabel('验收条件（每行一条）').fill('保存刷新后保留\nAPI字段一致');
  const confirm = session().getByRole('button', { name: '确认任务（生成新版本）' });
  await confirm.evaluate((node) => {
    (node as HTMLButtonElement).click();
    (node as HTMLButtonElement).click();
  });
  await expect(session()).toContainText('任务 v1');
  const s = await workspaceSnapshot(page),
    versions = s.workspaces[0]!.sessions[0]!.taskVersions;
  expect(versions).toHaveLength(1);
  expect(versions[0]?.capture?.element.text).toContain('未设置');
  expect(versions[0]?.goal).toBe('修复截止日期字段，保存之后刷新仍保留。');
  expect(versions[0]?.allowedScopes).toEqual(['src/task.ts']);
  expect(versions[0]?.acceptance).toEqual(['保存刷新后保留', 'API字段一致']);
});

test('导航：页面跳转后旧现场失效，历史版本仍保留原目标', async () => {
  await previewClick(app, await previewElementCenter(app, 'a[href="task.html?id=1"]'));
  await expect.poll(async () => (await previewInfo(app)).url).toContain('task.html?id=1');
  await session().getByRole('button', { name: '上下文', exact: true }).click();
  await expect(session()).toContainText('现场适用性：已失效');
  const s = await workspaceSnapshot(page);
  expect(s.workspaces[0]!.sessions[0]!.taskVersions[0]?.capture?.page.url).toBe('wsl-demo://taskflow/index.html');
  await session().getByRole('button', { name: '重新选择元素' }).click();
  await expect
    .poll(async () => (await workspaceSnapshot(page)).workspaces[0]!.resources.find((r) => r.kind === 'web')!.preview!.picking)
    .toBe(true);
  await previewClick(app, await previewElementCenter(app, '[data-testid="edit-task"]'));
  await expect(session()).toContainText('现场适用性：有效');
});

test('选择模式中导航：退出选择模式，之后页面点击正常生效', async () => {
  await session().getByRole('button', { name: '重新选择元素' }).click();
  await expect
    .poll(async () => (await workspaceSnapshot(page)).workspaces[0]!.resources.find((r) => r.kind === 'web')!.preview!.picking)
    .toBe(true);
  const address = page.getByLabel('页面地址');
  await address.fill('wsl-demo://taskflow/members.html');
  await address.press('Enter');
  await expect.poll(async () => (await previewInfo(app)).url).toBe('wsl-demo://taskflow/members.html');
  await expect(page.getByRole('button', { name: '选择中 · Esc 取消' })).toHaveCount(0);
  await previewClick(app, await previewElementCenter(app, 'header a[href="index.html"]'));
  await expect.poll(async () => (await previewInfo(app)).url).toBe('wsl-demo://taskflow/index.html');
});

test('运行、检查、审阅分别记录；没有独立检查器不会显示通过', async () => {
  await session().getByRole('button', { name: '任务', exact: true }).click();
  await session().getByLabel('附加目标（明确选择）').selectOption('');
  await session().getByLabel('修改目标').fill('只回复中文标记工作台742，不执行任何工具。');
  await session().getByRole('button', { name: '确认任务（生成新版本）' }).click();
  await expect(session()).toContainText('任务 v2');
  await session().getByRole('button', { name: '开始运行' }).click();
  await expect(session()).toContainText('执行：completed');
  await session().getByRole('button', { name: '检查', exact: true }).click();
  await expect(session()).toContainText('检查：not_run');
  await session().getByRole('button', { name: '运行检查' }).click();
  await expect(session()).toContainText('检查：blocked');
  await expect(session()).not.toContainText('检查：passed');
  await expect(session()).toContainText('审阅：尚未审阅');
  await expect(session().getByRole('button', { name: '接受结果' })).toBeDisabled();
  await expect(session()).toContainText('审阅：尚未审阅');
  const s = await workspaceSnapshot(page),
    run = s.workspaces[0]!.runs.at(-1)!;
  expect(run.review).toBeNull();
  expect(run.validation.state).toBe('blocked');
});

test('导航与草稿：个人作用域不沿用空间输入，回空间恢复草稿', async () => {
  await session().getByRole('textbox').last().fill('空间未发送草稿');
  await workshopNavigate(page, '首页');
  const personal = page.getByRole('region', { name: '混合输入' }).getByRole('textbox');
  await expect(personal).toHaveValue('');
  await personal.fill('个人未发送草稿');
  expect((await previewInfo(app)).visible).toBe(false);
  await workshopNavigate(page, '空间');
  await expect(session().getByRole('textbox').last()).toHaveValue('空间未发送草稿');
  await expect.poll(async () => (await previewInfo(app)).visible).toBe(true);
});

test('侧栏：隐藏和临时展开使网页让位，按钮路径可固定恢复', async () => {
  await page.getByRole('button', { name: '显示或隐藏 Workshop（⌘B）', exact: true }).click();
  await expect(page.getByRole('navigation', { name: '空间标签' })).toHaveCount(0);
  const edge = page.getByRole('button', { name: '展开 Workshop', exact: true });
  await edge.click();
  await expect(page.getByRole('navigation', { name: '空间标签' })).toBeVisible();
  await expect.poll(async () => (await previewInfo(app)).visible).toBe(false);
  await expect(page.getByRole('button', { name: '取消固定 Workshop', exact: true })).toHaveAttribute('aria-pressed', 'true');
  await page.getByRole('button', { name: '取消固定 Workshop', exact: true }).click();
  await expect(page.getByRole('navigation', { name: '空间标签' })).toHaveCount(0);
  await edge.click();
  await page.getByRole('button', { name: '固定 Workshop', exact: true }).click();
  await expect(page.getByRole('button', { name: '取消固定 Workshop', exact: true })).toHaveAttribute('aria-pressed', 'true');
  await expect.poll(async () => (await previewInfo(app)).visible).toBe(true);
});

test('菜单快捷键：应用菜单⌘B与⌘L仍走明确导航路径', async () => {
  await page.getByRole('navigation', { name: '空间标签' }).getByRole('button', { name: 'TaskFlow 预览', exact: true }).click();
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
      if (!item) throw new Error(`missing menu ${target}`);
      item.click(undefined, BrowserWindow.getAllWindows()[0], undefined as never);
      return item.accelerator;
    }, label);
  expect(await clickMenu('编辑地址')).toBe('CmdOrCtrl+L');
  await expect(page.getByLabel('页面地址')).toBeFocused();
  await page.keyboard.press('Escape');
  expect(await clickMenu('显示或隐藏 Workshop')).toBe('CmdOrCtrl+B');
});

test('窄窗口：活动窗格保留原生bounds，扩大恢复多窗格', async () => {
  const original = (await workspaceSnapshot(page)).workspaces[0]!.layout;
  if (!(await page.getByRole('navigation', { name: '空间标签' }).isVisible()))
    await page.getByRole('button', { name: '展开 Workshop', exact: true }).click();
  await page.getByRole('button', { name: 'TaskFlow 预览', exact: true }).click();
  await setWindowSize(app, 900, 700);
  await expect(page.locator('[data-pane-id]:visible')).toHaveCount(1);
  await expect.poll(async () => (await previewInfo(app)).visible).toBe(true);
  const info = await previewInfo(app),
    host = await page.locator('.preview-host:visible').boundingBox();
  expect(info.bounds.width).toBeGreaterThan(600);
  expect(Math.abs(info.bounds.width - host!.width)).toBeLessThanOrEqual(1);
  await setWindowSize(app, 1440, 900);
  await expect(page.locator('[data-pane-id]:visible')).toHaveCount(2);
  expect((await workspaceSnapshot(page)).workspaces[0]!.layout).toEqual(original);
});
