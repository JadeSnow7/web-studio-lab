import path from 'node:path';
import { expect, test, type ElectronApplication, type Page } from '@playwright/test';
import {
  chooseNativeMenuItem,
  dismissNativeMenu,
  expectMenuAt,
  launchApp,
  nativeMenuCount,
  openNativeMenu,
  paneMenu,
  paneMenuButton,
  previewInfo,
  setWindowSize,
  tabMenu,
  browserState,
  workspaceSnapshot,
} from './helpers';

/*
 * OPS-1 S5（O08 / O08a / O08b / O08c）：六类菜单改为 Main 原生菜单（`window.studio.shell.showMenu`）。
 * Playwright 点不到系统菜单：launchApp 默认经 electronApp.evaluate 安装测试接缝（helpers.ts installNativeMenuSeam），
 * 记录 Main 构建的菜单并触发菜单项自己的 click 与关闭回调。菜单打开期间断言原生网页仍可见；
 * 真实窗口中的系统菜单外观与网页可见性另由系统级截图核对，不由本文件代替。
 */

const sbxBin = path.resolve('e2e/fixtures/sbx.mjs');
const TAB_ITEMS = [
  '置顶标签',
  '重命名',
  '设置分组',
  '移出分组',
  '向上移动',
  '向下移动',
  '在右侧打开',
  '在下方打开',
  '关闭标签（保留后台执行）',
];

let app: ElectronApplication;
let page: Page;
test.afterEach(async () => {
  await app?.close();
});

async function launch(options: { sbxBin?: string } = {}) {
  ({ app, page } = await launchApp(options));
  await setWindowSize(app, 1440, 900);
  await expect.poll(() => page.evaluate(() => window.innerWidth)).toBe(1440);
}
const tabs = () => page.getByRole('navigation', { name: '空间标签', exact: true });
const active = async () => {
  const snapshot = await workspaceSnapshot(page);
  return snapshot.workspaces.find((w) => w.workspaceId === snapshot.activeWorkspaceId)!;
};
const paneCount = async () => {
  const count = (layout: Awaited<ReturnType<typeof active>>['layout']): number =>
    layout.kind === 'pane' ? 1 : count(layout.first) + count(layout.second);
  return count((await active()).layout);
};
/** 原生网页可见：renderer 的占位标记与 Main 里 WebContentsView 的真实可见性都要对上。 */
async function expectNativePage(visible: boolean) {
  await expect(page.locator('.preview-host:visible').first()).toHaveAttribute('data-native', visible ? 'visible' : 'hidden');
  await expect.poll(async () => (await previewInfo(app)).visible).toBe(visible);
}
const sessionRegion = () => page.getByRole('region', { name: 'Agent 会话内容', exact: true });
const runRecordTrigger = () =>
  sessionRegion().getByRole('navigation', { name: '会话视图', exact: true }).getByRole('button', { name: '运行记录', exact: true });

test('O08：六类菜单都以原生菜单打开，打开期间原生网页保持可见，页面里没有 HTML 弹出菜单', async () => {
  await launch({ sbxBin });
  // 网页留在左侧窗格，会话放进右侧窗格：运行记录菜单打开时网页就在旁边。
  await paneMenu(app, page, '左右分屏');
  await tabs().getByRole('button', { name: 'Agent 会话', exact: true }).click();
  await sessionRegion().getByRole('textbox', { name: '会话消息', exact: true }).fill('原生菜单用例');
  await sessionRegion().getByRole('button', { name: '发送', exact: true }).click();
  await expect.poll(async () => (await active()).runs.at(-1)?.state).toBe('completed');
  await expectNativePage(true);

  const browser = page.locator('.workspace-browser:visible');
  const menus = [
    ['tab', () => page.getByRole('button', { name: '开发终端操作', exact: true }).click(), TAB_ITEMS],
    [
      'pane',
      () => page.locator('.workspace-pane:visible').first().getByRole('button', { name: '窗格操作', exact: true }).click(),
      ['左右分屏', '上下分屏', '平均分割', '关闭窗格（标签保留）'],
    ],
    ['run-records', () => runRecordTrigger().click(), ['日志', 'diff', '报告']],
    [
      'web-more',
      () => browser.getByRole('button', { name: '更多网页操作', exact: true }).click(),
      ['收藏到资源', '保存正文快照', '查看空间资源'],
    ],
    // 接收者按钮（OPS-1 S1）显示默认接收会话：同屏且刚发送过的 Agent 会话，菜单因此带「打开接收会话」。
    ['capture-receiver', () => browser.getByRole('button', { name: /^接收会话：/ }).click(), ['Agent 会话', '新建会话', '打开接收会话']],
    ['new-tab', () => page.getByRole('button', { name: '新建标签', exact: true }).click(), ['网页', '终端', 'Agent 会话', '文件', 'SSH']],
  ] as const;
  for (const [name, open, labels] of menus) {
    const menu = await openNativeMenu(app, open);
    expect(
      menu.items.map((item) => item.label),
      name,
    ).toEqual(labels);
    // 菜单仍打开（结果未决）时：原生网页可见，没有 HTML menu / 遮挡占位。
    await expectNativePage(true);
    await expect(page.getByRole('menu')).toHaveCount(0);
    await expect(page.getByText('浮层打开期间网页已让位，关闭后恢复')).toHaveCount(0);
    await dismissNativeMenu(app);
  }
  // 取消不产生任何动作。
  expect(await paneCount()).toBe(2);
  await expect(page.getByRole('dialog')).toHaveCount(0);
});

test('O08 标签菜单：条目来自 Main 快照；向下移动、在右侧打开、关闭标签（保留实例）与原行为一致', async () => {
  await launch();
  const terminalTrigger = page.getByRole('button', { name: '开发终端操作', exact: true });
  await expect(terminalTrigger).toHaveAttribute('aria-expanded', 'false');
  const menu = await openNativeMenu(app, () => terminalTrigger.click());
  await expect(terminalTrigger).toHaveAttribute('aria-expanded', 'true');
  // 开发终端：未分组（不能移出分组）、未在窗格中显示（可在旁边打开）、位于中间（可上移下移）。
  expect(menu.items).toEqual(TAB_ITEMS.map((label) => ({ label, enabled: label !== '移出分组' })));
  await chooseNativeMenuItem(app, '向下移动');
  await expect(terminalTrigger).toHaveAttribute('aria-expanded', 'false');
  await expect.poll(async () => (await active()).tabs.map((t) => t.title)).toEqual(['TaskFlow 预览', 'Agent 会话', '开发终端']);

  // 末个标签不能再下移；首个不能上移；正在显示的网页标签不能再在旁边打开。
  const last = await openNativeMenu(app, () => page.getByRole('button', { name: '开发终端操作', exact: true }).click());
  expect(last.items.find((item) => item.label === '向下移动')?.enabled).toBe(false);
  await dismissNativeMenu(app);
  const first = await openNativeMenu(app, () => page.getByRole('button', { name: 'TaskFlow 预览操作', exact: true }).click());
  expect(Object.fromEntries(first.items.map((item) => [item.label, item.enabled]))).toMatchObject({
    向上移动: false,
    在右侧打开: false,
    在下方打开: false,
  });
  await dismissNativeMenu(app);

  await tabMenu(app, page, 'Agent 会话', '在右侧打开');
  await expect.poll(paneCount).toBe(2);
  const w = await active();
  const session = w.tabs.find((t) => t.title === 'Agent 会话')!;
  expect(w.layout).toMatchObject({ kind: 'split', direction: 'horizontal', second: { tabId: session.tabId } });

  // 键盘打开并关闭标签：触发器随标签消失，焦点移到相邻标签（开发终端是最后一个，回到上一个），不落在 body。
  await page.getByRole('button', { name: '开发终端操作', exact: true }).focus();
  await openNativeMenu(app, () => page.keyboard.press('Enter'));
  await chooseNativeMenuItem(app, '关闭标签（保留后台执行）');
  await expect(tabs().getByRole('button', { name: '开发终端', exact: true })).toHaveCount(0);
  await expect(tabs().getByRole('button', { name: 'Agent 会话', exact: true })).toBeFocused();
  await expect(page.getByText('后台资源 / 已关闭标签')).toBeVisible();
  expect((await active()).resources.some((r) => r.title === '开发终端')).toBe(true);

  await tabMenu(app, page, 'Agent 会话', '置顶标签');
  await expect.poll(async () => (await active()).tabs.find((t) => t.title === 'Agent 会话')?.pinned).toBe(true);
  const pinned = await openNativeMenu(app, () => page.getByRole('button', { name: 'Agent 会话操作', exact: true }).click());
  expect(pinned.items[0]?.label).toBe('取消置顶');
  await dismissNativeMenu(app);

  // 菜单与 F2 / 双击共享侧栏就地编辑。
  await tabMenu(app, page, 'Agent 会话', '重命名');
  const editor = page.getByRole('form', { name: '重命名标签', exact: true });
  await expect(editor).toBeVisible();
  await expect(editor.getByLabel('标签名称')).toHaveValue('Agent 会话');
  await editor.getByRole('button', { name: '取消', exact: true }).click();
});

test('O08 标签菜单：右键垂直标签在指针处打开；键盘（Enter / 空格）打开时位于触发器下方（R3）', async () => {
  await launch();
  const tab = tabs().getByRole('button', { name: '开发终端', exact: true });
  const box = (await tab.boundingBox())!;
  const right = await openNativeMenu(app, () => tab.click({ button: 'right', position: { x: 24, y: 9 } }));
  expect(right.items.map((item) => item.label)).toEqual(TAB_ITEMS);
  expectMenuAt(right, box.x + 24, box.y + 9);
  await chooseNativeMenuItem(app, '置顶标签');
  await expect.poll(async () => (await active()).tabs.find((t) => t.title === '开发终端')?.pinned).toBe(true);

  const trigger = page.getByRole('button', { name: 'Agent 会话操作', exact: true });
  await trigger.focus();
  const rect = (await trigger.boundingBox())!;
  for (const key of ['Enter', ' ']) {
    const keyboard = await openNativeMenu(app, () => page.keyboard.press(key));
    expectMenuAt(keyboard, rect.x, rect.y + rect.height);
    await dismissNativeMenu(app);
    // Esc / 点外部：没有动作，焦点仍在触发器。
    await expect(trigger).toBeFocused();
  }
  expect((await active()).tabs.map((t) => t.title)).toEqual(['TaskFlow 预览', '开发终端', 'Agent 会话']);
});

test('O08 窗格菜单：窗格头只剩标题、专注、窗格操作；分屏、平均分割、关闭窗格在菜单里，四窗格时分屏禁用', async () => {
  await launch();
  const header = page.locator('.workspace-pane:visible').first().locator('.pane-header');
  await expect(header.getByRole('button')).toHaveText([/TaskFlow 预览/, '⤢', '···']);
  for (const name of ['左右分屏', '上下分屏', '关闭窗格']) await expect(page.getByRole('button', { name, exact: true })).toHaveCount(0);
  const single = await openNativeMenu(app, () => header.getByRole('button', { name: '窗格操作', exact: true }).click());
  expect(single.items).toEqual([
    { label: '左右分屏', enabled: true },
    { label: '上下分屏', enabled: true },
    { label: '平均分割', enabled: false },
    { label: '关闭窗格（标签保留）', enabled: false },
  ]);
  await chooseNativeMenuItem(app, '左右分屏');
  await expect.poll(paneCount).toBe(2);
  await paneMenu(app, page, '上下分屏');
  await expect.poll(paneCount).toBe(3);
  await paneMenu(app, page, '左右分屏');
  await expect.poll(paneCount).toBe(4);
  const full = await openNativeMenu(app, () => paneMenuButton(page).click());
  await expect(paneMenuButton(page)).toHaveAttribute('aria-expanded', 'true');
  expect(full.items.slice(0, 2)).toEqual([
    { label: '左右分屏', enabled: false },
    { label: '上下分屏', enabled: false },
  ]);
  await dismissNativeMenu(app);
  await expect(paneMenuButton(page)).toHaveAttribute('aria-expanded', 'false');
  // 标签菜单的「在右侧 / 下方打开」同样受四窗格上限约束（开发终端未显示，但已没有可新增的窗格）。
  const tabAtCap = await openNativeMenu(app, () => page.getByRole('button', { name: '开发终端操作', exact: true }).click());
  expect(Object.fromEntries(tabAtCap.items.map((item) => [item.label, item.enabled]))).toMatchObject({
    在右侧打开: false,
    在下方打开: false,
  });
  await dismissNativeMenu(app);

  // 平均分割：把所在分割的比例恢复为 0.5。
  const before = await active();
  await page.evaluate((command) => window.studio.workbench.command({ ...command, commandId: crypto.randomUUID() } as never), {
    type: 'setRatio',
    workspaceId: before.workspaceId,
    paneId: before.activePaneId,
    ratio: 0.3,
  });
  const ratioOf = async () => {
    const w = await active();
    const find = (layout: typeof w.layout): number | null =>
      layout.kind === 'pane'
        ? null
        : [layout.first, layout.second].some((child) => child.kind === 'pane' && child.paneId === w.activePaneId)
          ? layout.ratio
          : (find(layout.first) ?? find(layout.second));
    return find(w.layout);
  };
  await expect.poll(ratioOf).toBe(0.3);
  await paneMenu(app, page, '平均分割');
  await expect.poll(ratioOf).toBe(0.5);

  await paneMenu(app, page, '关闭窗格（标签保留）');
  await expect.poll(paneCount).toBe(3);
  expect((await active()).tabs).toHaveLength(3);
});

test('O08 运行记录 / ⋯ / 新建标签：选择后执行原有动作；关闭回调早于 click 时仍执行（R3），取消不执行', async () => {
  await launch({ sbxBin });
  await paneMenu(app, page, '左右分屏');
  await tabs().getByRole('button', { name: 'Agent 会话', exact: true }).click();
  await sessionRegion().getByRole('textbox', { name: '会话消息', exact: true }).fill('运行记录原生菜单');
  await sessionRegion().getByRole('button', { name: '发送', exact: true }).click();
  await expect.poll(async () => (await active()).runs.at(-1)?.state).toBe('completed');

  await expect(runRecordTrigger()).toHaveAttribute('aria-haspopup', 'menu');
  await openNativeMenu(app, () => runRecordTrigger().click());
  await expect(runRecordTrigger()).toHaveAttribute('aria-expanded', 'true');
  await chooseNativeMenuItem(app, 'diff', { closeFirst: true });
  const details = sessionRegion().getByRole('region', { name: '运行详情' });
  await expect(details).toContainText('源码差异不可用');
  await expect(runRecordTrigger()).toHaveAttribute('aria-expanded', 'false');
  // 再次打开：Main 以单选项标出当前视图（原 HTML 菜单的 aria-current）。
  const marked = await openNativeMenu(app, () => runRecordTrigger().click());
  expect(marked.items).toEqual([
    { label: '日志', enabled: true, checked: false },
    { label: 'diff', enabled: true, checked: true },
    { label: '报告', enabled: true, checked: false },
  ]);
  await chooseNativeMenuItem(app, '日志');
  await expect(details).not.toContainText('源码差异不可用');
  await expect(runRecordTrigger()).toHaveClass(/btn-active/);

  const browser = page.locator('.workspace-browser:visible');
  await openNativeMenu(app, () => browser.getByRole('button', { name: '更多网页操作', exact: true }).click());
  await chooseNativeMenuItem(app, '查看空间资源');
  await expect(page.locator('#space-resources-summary')).toBeFocused();

  const newTab = page.getByRole('button', { name: '新建标签', exact: true });
  await openNativeMenu(app, () => newTab.click());
  await expect(newTab).toHaveAttribute('aria-expanded', 'true');
  await dismissNativeMenu(app);
  await expect(newTab).toHaveAttribute('aria-expanded', 'false');
  await expect(page.getByRole('dialog', { name: '新建标签' })).toHaveCount(0);
  for (const [label, kind] of [
    ['文件', 'file'],
    ['网页', 'web'],
  ] as const) {
    await openNativeMenu(app, () => page.getByRole('button', { name: '新建标签', exact: true }).click());
    await chooseNativeMenuItem(app, label, { closeFirst: kind === 'web' });
    const dialog = page.getByRole('dialog', { name: '新建标签' });
    await expect(dialog).toBeVisible();
    await expect(dialog.getByLabel('标签类型')).toHaveValue(kind);
    // 表单仍是对话框：进入遮挡集合（O08c）。
    await expectNativePage(false);
    await dialog.getByRole('button', { name: '取消', exact: true }).click();
    await expect(dialog).toHaveCount(0);
  }
});

test('O08 采集接收者菜单（OPS-1 S1）：选择会话或新建会话只设定之后采集的接收者，不开始采集；「选择元素」按它发起；可打开接收会话', async () => {
  await launch();
  const browser = page.locator('.workspace-browser:visible');
  const trigger = browser.getByRole('button', { name: /^接收会话：/ });
  await expect(trigger).toHaveAttribute('aria-haspopup', 'menu');
  const picking = page.getByRole('button', { name: '选择中 · Esc 取消', exact: true });
  const web = (await active()).resources.find((r) => r.kind === 'web')!;
  const sessionOf = async (title: string) => (await active()).sessions.find((s) => s.title === title);
  await expect.poll(async () => (await browserState(page)).loading).toBe(false);

  // 没有同屏会话、也没有活动记录：默认将自动新建，菜单没有「打开接收会话」。
  await expect(trigger).toHaveAccessibleName('接收会话：将自动新建「TaskFlow 预览 · 会话」');
  const menu = await openNativeMenu(app, () => trigger.click());
  expect(menu.items).toEqual([
    { label: 'Agent 会话', enabled: true, checked: false },
    { label: '新建会话', enabled: true },
  ]);
  await chooseNativeMenuItem(app, 'Agent 会话');
  await expect(trigger).toHaveAccessibleName('接收会话：Agent 会话');
  // 选择本身不开始采集。
  await expect(picking).toHaveCount(0);
  expect((await sessionOf('Agent 会话'))?.captureRequest ?? null).toBeNull();
  await browser.getByRole('button', { name: '选择元素', exact: true }).click();
  await expect(picking).toBeVisible();
  await expect
    .poll(async () => (await sessionOf('Agent 会话'))?.captureRequest)
    .toMatchObject({
      resourceId: web.resourceId,
      state: 'pending',
    });
  await expectNativePage(true);
  await picking.click();
  await expect.poll(async () => (await active()).resources.find((r) => r.kind === 'web')?.preview?.picking).toBe(false);

  // 「新建会话」：新建不占用窗格的会话并设为接收者，不开始采集。
  const associated = await openNativeMenu(app, () => trigger.click());
  expect(associated.items.map((item) => item.label)).toEqual(['Agent 会话', '新建会话', '打开接收会话']);
  await chooseNativeMenuItem(app, '新建会话');
  await expect(trigger).toHaveAccessibleName('接收会话：TaskFlow 预览 · 会话');
  expect((await sessionOf('TaskFlow 预览 · 会话'))?.captureRequest ?? null).toBeNull();
  await expect(picking).toHaveCount(0);
  expect(await paneCount()).toBe(1);

  const reopened = await openNativeMenu(app, () => trigger.click());
  expect(reopened.items.map((item) => item.label)).toEqual(['Agent 会话', 'TaskFlow 预览 · 会话', '新建会话', '打开接收会话']);
  await chooseNativeMenuItem(app, '打开接收会话');
  await expect(sessionRegion().filter({ has: page.getByRole('heading', { name: 'TaskFlow 预览 · 会话' }) })).toBeVisible();
});

test('O08b 迟到选择：菜单打开期间切换空间，业务动作仍作用于原空间，只影响展示的动作被丢弃', async () => {
  await launch();
  const origin = (await active()).workspaceId;
  const createSpace = async (name: string) => {
    await page.getByRole('button', { name: '切换空间', exact: true }).click();
    await page.getByRole('button', { name: '新建空间', exact: true }).click();
    const dialog = page.getByRole('dialog', { name: '新建空间', exact: true });
    await dialog.getByLabel('名称').fill(name);
    await dialog.getByRole('button', { name: '保存', exact: true }).click();
    await expect.poll(async () => (await active()).name).toBe(name);
    // renderer 也已选中新空间（标题栏切换器显示其名称）。
    await expect(page.getByRole('button', { name: '切换空间', exact: true })).toContainText(name);
  };

  await openNativeMenu(app, () => page.getByRole('button', { name: '开发终端操作', exact: true }).click());
  await createSpace('迟到空间一');
  const late = (await active()).workspaceId;
  await chooseNativeMenuItem(app, '关闭标签（保留后台执行）');
  await expect
    .poll(async () => (await workspaceSnapshot(page)).workspaces.find((w) => w.workspaceId === origin)?.tabs.map((t) => t.title))
    .toEqual(['TaskFlow 预览', 'Agent 会话']);
  const after = await workspaceSnapshot(page);
  expect(after.activeWorkspaceId).toBe(late);
  expect(after.workspaces.find((w) => w.workspaceId === late)?.tabs).toEqual([]);

  // 回到原空间，打开「重命名」后再切走：迟到的展示动作不打开编辑表单。
  await page.getByRole('button', { name: '切换空间', exact: true }).click();
  await page
    .getByRole('dialog', { name: '切换空间' })
    .getByRole('button', { name: /TaskFlow/ })
    .first()
    .click();
  await expect.poll(async () => (await active()).workspaceId).toBe(origin);
  await expect(page.getByRole('button', { name: '切换空间', exact: true })).toContainText('TaskFlow');
  await openNativeMenu(app, () => page.getByRole('button', { name: 'Agent 会话操作', exact: true }).click());
  await createSpace('迟到空间二');
  await chooseNativeMenuItem(app, '重命名');
  // 否定断言：给 renderer 足够时间处理迟到的选择，再确认没有打开编辑表单（同一空间时会打开，见 O08c 用例）。
  await page.waitForTimeout(500);
  await expect(page.getByRole('dialog', { name: '编辑名称' })).toHaveCount(0);
});

test('O08b 非法菜单请求：他空间、未知身份、伪造字段被拒绝，不显示菜单；window.studio 顶层仍为七个键', async () => {
  await launch();
  expect(await page.evaluate(() => Object.keys(window.studio))).toEqual([
    'setup',
    'workbench',
    'chat',
    'app',
    'execution',
    'workflow',
    'shell',
  ]);
  // OPS-1 R9/B5 在 shell 下提供具名焦点交接与恢复；顶层仍为七个键。
  expect(await page.evaluate(() => Object.keys(window.studio.shell))).toEqual([
    'onCommand',
    'showMenu',
    'focusWorkbench',
    'nativeFocus',
    'restoreBrowserFocus',
  ]);
  const origin = await active();
  const before = await nativeMenuCount(app);
  const attempt = (request: { menuId: string; context: Record<string, unknown> }) =>
    page.evaluate(
      (value) =>
        window.studio.shell.showMenu(value.menuId as never, value.context as never).then(
          () => 'resolved',
          (error: Error) => error.message,
        ),
      request,
    );
  expect(await attempt({ menuId: 'tab', context: { workspaceId: origin.workspaceId, tabId: 'tab-that-does-not-exist' } })).toMatch(
    /not_found/,
  );
  expect(await attempt({ menuId: 'pane', context: { workspaceId: 'workspace-that-does-not-exist', paneId: origin.activePaneId } })).toMatch(
    /not_found/,
  );
  expect(
    await attempt({ menuId: 'tab', context: { workspaceId: origin.workspaceId, tabId: origin.tabs[0]!.tabId, label: '伪造' } }),
  ).not.toBe('resolved');
  expect(await attempt({ menuId: 'delete-everything', context: { workspaceId: origin.workspaceId } })).not.toBe('resolved');

  // 他空间：新建一个后台空间，用它的窗格冒充当前空间。
  const other = crypto.randomUUID();
  const created = await page.evaluate(
    (workspaceId) =>
      window.studio.workbench.command({ type: 'createWorkspace', workspaceId, name: '他空间', commandId: crypto.randomUUID() } as never),
    other,
  );
  expect(created.ok).toBe(true);
  const otherPane = created.snapshot.workspaces.find((w) => w.workspaceId === other)!.activePaneId;
  await page.evaluate(
    (workspaceId) => window.studio.workbench.command({ type: 'switchWorkspace', workspaceId, commandId: crypto.randomUUID() } as never),
    origin.workspaceId,
  );
  expect(await attempt({ menuId: 'pane', context: { workspaceId: origin.workspaceId, paneId: otherPane } })).toMatch(/denied/);
  expect(await attempt({ menuId: 'new-tab', context: { workspaceId: other } })).toMatch(/denied/);
  expect(await nativeMenuCount(app)).toBe(before);
});

test('O08c 遮挡边界：原生菜单不进入遮挡集合；空间切换器与对话框仍让原生网页让位', async () => {
  await launch();
  await expectNativePage(true);
  await openNativeMenu(app, () => page.getByRole('button', { name: '新建标签', exact: true }).click());
  await expectNativePage(true);
  await dismissNativeMenu(app);
  await page.getByRole('button', { name: '切换空间', exact: true }).click();
  await expect(page.getByRole('dialog', { name: '切换空间' })).toBeVisible();
  await expectNativePage(false);
  await page.keyboard.press('Escape');
  await expectNativePage(true);
  await tabMenu(app, page, 'Agent 会话', '设置分组');
  await expect(page.getByRole('dialog', { name: '编辑名称' })).toBeVisible();
  await expectNativePage(false);
  await page.getByRole('dialog', { name: '编辑名称' }).getByRole('button', { name: '取消', exact: true }).click();
  await expectNativePage(true);
});

/** 测试侧在 Main 里包一层既有的 workbench:command 处理函数（来源与输入校验照旧在原处理函数里）。 */
async function shimWorkbenchCommand(mode: 'drop-browser-layout' | 'strip-split-revision' | 'off') {
  await app.evaluate(({ ipcMain }, next) => {
    type Handler = (event: Electron.IpcMainInvokeEvent, request?: Record<string, unknown>) => Promise<unknown>;
    const host = globalThis as unknown as { __wslCommandShim?: { mode: string } };
    const handlers = (ipcMain as unknown as { _invokeHandlers: Map<string, Handler> })._invokeHandlers;
    if (!host.__wslCommandShim) {
      const original = handlers.get('workbench:command')!;
      const snapshot = handlers.get('workbench:get-snapshot')!;
      const shim = (host.__wslCommandShim = { mode: next });
      ipcMain.removeHandler('workbench:command');
      ipcMain.handle('workbench:command', async (event, request?: Record<string, unknown>) => {
        // 网页实例停掉后，renderer 的布局同步不再重建实例（只用于制造“没有网页实例”的状态）。
        if (shim.mode === 'drop-browser-layout' && request?.['type'] === 'browserLayout')
          return { ok: true, snapshot: await snapshot(event) };
        // 模拟不带版本的分屏请求（如 B5 的快捷键），让 Main 自己的四窗格上限给出 pane_limit。
        if (shim.mode === 'strip-split-revision' && request?.['type'] === 'splitPane') {
          const rest = { ...request };
          delete rest['expectedRevision'];
          return original(event, rest);
        }
        return original(event, request);
      });
    }
    host.__wslCommandShim!.mode = next;
  }, mode);
}

test('O08b 菜单打开期间布局已变：依赖布局的选择以版本冲突拒绝，布局不被改写', async () => {
  await launch();
  const menu = await openNativeMenu(app, () => paneMenuButton(page).click());
  expect(menu.items[0]).toEqual({ label: '左右分屏', enabled: true });
  const w = await active();
  const changed = await page.evaluate(
    (command) => window.studio.workbench.command({ ...command, commandId: crypto.randomUUID() } as never),
    { type: 'splitPane', workspaceId: w.workspaceId, paneId: w.activePaneId, direction: 'vertical' },
  );
  expect(changed.ok).toBe(true);
  await expect.poll(paneCount).toBe(2);
  await chooseNativeMenuItem(app, '左右分屏');
  await expect(page.locator('.toasts .workspace-error')).toContainText('空间已有较新修改');
  expect(await paneCount()).toBe(2);
});

test('O08 采集接收者菜单：没有网页实例时「选择元素」禁用而接收者条目仍可用（选择不开始采集）；连点触发器只弹出一个菜单', async () => {
  await launch();
  await expect.poll(async () => (await browserState(page)).loading).toBe(false);
  const browser = page.locator('.workspace-browser:visible');
  const trigger = browser.getByRole('button', { name: /^接收会话：/ });

  // 连点：renderer 只发出一次请求，没有「打开菜单失败」提示，也没有第二个菜单。
  const before = await nativeMenuCount(app);
  await trigger.dblclick();
  await expect.poll(() => nativeMenuCount(app)).toBe(before + 1);
  await page.waitForTimeout(300);
  expect(await nativeMenuCount(app)).toBe(before + 1);
  await expect(page.getByText('打开菜单失败')).toHaveCount(0);
  await dismissNativeMenu(app);

  // 制造“网页标签在窗格中、但没有网页实例”：关闭标签（保留实例）→ 停止网页实例 → 重新打开标签；
  // 期间测试侧丢弃 renderer 的布局同步，Main 不会立即重建实例。
  const w = await active();
  const web = w.resources.find((r) => r.kind === 'web')!;
  const tab = w.tabs.find((t) => t.targetRef.resourceId === web.resourceId)!;
  const run = (command: Record<string, unknown>) =>
    page.evaluate((value) => window.studio.workbench.command({ ...value, commandId: crypto.randomUUID() } as never), {
      workspaceId: w.workspaceId,
      ...command,
    });
  await shimWorkbenchCommand('drop-browser-layout');
  expect((await run({ type: 'closeTab', tabId: tab.tabId })).ok).toBe(true);
  expect((await run({ type: 'stopInstance', resourceId: web.resourceId, instanceId: web.instanceId })).ok).toBe(true);
  expect((await run({ type: 'openTab', resourceId: web.resourceId })).ok).toBe(true);
  await expect(trigger).toBeVisible();
  expect((await active()).resources.find((r) => r.kind === 'web')?.instanceId).toBeNull();
  // OPS-1 S1：开始采集的入口是「选择元素」，没有网页实例时它禁用；接收者菜单只设定接收者，条目不随网页状态禁用。
  await expect(browser.getByRole('button', { name: '选择元素', exact: true })).toBeDisabled();
  await expect(browser.getByRole('button', { name: '选择元素', exact: true })).toHaveAttribute('title', '网页未在运行');
  const menu = await openNativeMenu(app, () => trigger.click());
  expect(menu.items).toEqual([
    { label: 'Agent 会话', enabled: true, checked: false },
    { label: '新建会话', enabled: true },
  ]);
  await dismissNativeMenu(app);
  await shimWorkbenchCommand('off');
});

test('O08 pane_limit 提示：过时菜单里的分屏到达四窗格上限时，Main 的 pane_limit 显示为「最多四个窗格」提示', async () => {
  await launch();
  await paneMenu(app, page, '左右分屏');
  await paneMenu(app, page, '上下分屏');
  await expect.poll(paneCount).toBe(3);
  await shimWorkbenchCommand('strip-split-revision');
  const stale = await openNativeMenu(app, () => paneMenuButton(page).click());
  expect(stale.items[0]).toEqual({ label: '左右分屏', enabled: true });
  const w = await active();
  await page.evaluate((command) => window.studio.workbench.command({ ...command, commandId: crypto.randomUUID() } as never), {
    type: 'splitPane',
    workspaceId: w.workspaceId,
    paneId: w.activePaneId,
    direction: 'horizontal',
  });
  await expect.poll(paneCount).toBe(4);
  await chooseNativeMenuItem(app, '左右分屏');
  await expect(page.locator('.toasts .workspace-error')).toContainText('最多四个窗格；请先关闭一个窗格。');
  expect(await paneCount()).toBe(4);
  await shimWorkbenchCommand('off');
});

test('O08 真实系统菜单（不装接缝）：Main 以 closePopup(工作台窗口) 关闭后结果为 null，触发器不卡住，可再次打开', async () => {
  ({ app, page } = await launchApp({ realNativeMenus: true }));
  await setWindowSize(app, 1440, 900);
  // 只记录真实弹出的菜单（仍调用原 popup，系统菜单照常显示与跟踪），用于确认它弹在工作台窗口上并从 Main 关闭它。
  await app.evaluate(({ Menu, BrowserWindow }) => {
    type Real = { menu: Electron.Menu; windowMatches: boolean; shown: number; closed: number };
    const host = globalThis as unknown as { __wslRealMenus: Real[] };
    host.__wslRealMenus = [];
    const original = Menu.prototype.popup;
    Menu.prototype.popup = function popup(this: Electron.Menu, options?: Electron.PopupOptions) {
      const entry: Real = { menu: this, windowMatches: options?.window === BrowserWindow.getAllWindows()[0], shown: 0, closed: 0 };
      host.__wslRealMenus.push(entry);
      this.on('menu-will-show', () => entry.shown++);
      this.on('menu-will-close', () => entry.closed++);
      return original.call(this, options);
    };
  });
  type RealState = { windowMatches: boolean; shown: number; closed: number };
  const realMenus = () =>
    app.evaluate(() =>
      (globalThis as unknown as { __wslRealMenus: RealState[] }).__wslRealMenus.map(({ windowMatches, shown, closed }) => ({
        windowMatches,
        shown,
        closed,
      })),
    );
  const more = page.getByRole('button', { name: '更多网页操作', exact: true });
  await more.click();
  // 等系统菜单真正显示（menu-will-show）后再关闭；打开期间原生网页可见。
  await expect.poll(async () => (await realMenus())[0]?.shown ?? 0).toBeGreaterThan(0);
  expect((await realMenus())[0]?.windowMatches).toBe(true);
  await expect(more).toHaveAttribute('aria-expanded', 'true');
  await expectNativePage(true);
  await app.evaluate(({ BrowserWindow }) => {
    const menus = (globalThis as unknown as { __wslRealMenus: Array<{ menu: Electron.Menu }> }).__wslRealMenus;
    menus.at(-1)!.menu.closePopup(BrowserWindow.getAllWindows()[0]);
  });
  await expect.poll(async () => (await realMenus())[0]?.closed ?? 0).toBeGreaterThan(0);
  await expect(more).toHaveAttribute('aria-expanded', 'false');
  // 不卡住：renderer 的进行中标记已清除、Main 也已结束上一个菜单，再次点击会再发出请求并弹出新菜单（不是 conflict）。
  // 自动化环境没有真实鼠标事件，系统可能要等下一次输入才退出上一个菜单的跟踪循环，所以这里只断言请求再次到达 Main 并弹出。
  await more.click();
  await expect.poll(async () => (await realMenus()).length).toBe(2);
  expect((await realMenus())[1]?.windowMatches).toBe(true);
  await expect(more).toHaveAttribute('aria-expanded', 'true');
  await expect(page.getByText('打开菜单失败')).toHaveCount(0);
  await app.evaluate(({ BrowserWindow }) => {
    const menus = (globalThis as unknown as { __wslRealMenus: Array<{ menu: Electron.Menu }> }).__wslRealMenus;
    menus.at(-1)!.menu.closePopup(BrowserWindow.getAllWindows()[0]);
  });
  // 取消没有执行任何菜单动作：空间资源区没有被展开。
  await expect(page.locator('#space-resources-summary')).not.toBeFocused();
});
