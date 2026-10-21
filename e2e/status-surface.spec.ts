import { execFile } from 'node:child_process';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { promisify } from 'node:util';
import { expect, test, type ElectronApplication, type Locator, type Page } from '@playwright/test';
import {
  fixtureSandbox,
  browserState,
  installStatusShim,
  launchApp,
  openBrowserMenu,
  previewInfo,
  pushWorkbenchSnapshot,
  screensDir,
  setStatusShim,
  setWindowSize,
  setWorkspaceTheme,
  shot,
  statusShimBrowserActions,
  target,
  workshopNavigate,
  workspaceSnapshot,
} from './helpers';
import { sshLoopback } from './fixtures/ssh-loopback';
import { controlledResourceNetwork } from './resource-network-fixture';

const run = promisify(execFile);

/*
 * 统一状态接口（docs/design/2026-10-11-status-surface）的可见性 / 键盘 / 截图用例。
 * 各区域改造后继续在此追加。截图保存在 test-results/screens/<target>/status-surface/ 下。
 */

const codexBin = path.resolve('e2e/fixtures/codex.mjs');
const sbxBin = path.resolve('e2e/fixtures/sbx.mjs');

const titlebarChat = (page: Page) => page.getByRole('button', { name: /^Codex CLI · / });
const bell = (page: Page) => page.getByRole('button', { name: /^通知 · \d+ 条未读$/ });

async function resize(app: ElectronApplication, page: Page, width: number, height: number) {
  await setWindowSize(app, width, height);
  await expect.poll(() => page.evaluate(() => window.innerWidth)).toBe(width);
}

test('对话不可用：标题栏按钮可见，键盘 Tab 可达，Enter 进入设置页', async () => {
  const { app, page } = await launchApp();
  try {
    // 依赖 E2E 默认环境：sbx 缺失，对话不可用。
    const button = page.getByRole('button', { name: 'Codex CLI · 对话不可用', exact: true });
    await expect(button).toBeVisible();
    // 名称只含可见文本；完整 label + detail 在按钮外的描述节点里。
    await expect(button).toHaveAccessibleDescription(/^对话不可用 · .+/);
    // 从左上角的 Workshop 触发器开始，用 Tab 走到标题栏按钮。
    await page.locator('#left-panel-trigger').focus();
    let reached = false;
    for (let i = 0; i < 12 && !reached; i++) {
      await page.keyboard.press('Tab');
      reached = await button.evaluate((node) => node === document.activeElement);
    }
    expect(reached).toBe(true);
    await expect(button).toBeFocused();
    await page.keyboard.press('Enter');
    await expect(page.getByRole('region', { name: '应用设置', exact: true })).toBeVisible();
    // 通知铃铛保持原样：可访问名称含未读数。
    await expect(bell(page)).toBeVisible();
  } finally {
    await app.close();
  }
});

test('对话可用：标题栏没有 Codex CLI 按钮，也没有对话类 Toast', async () => {
  const { app, page } = await launchApp({ codexBin });
  try {
    await expect(bell(page)).toBeVisible();
    // 正向信号：renderer 已收到 available:true（设置页显示对话已连接），之后再断言按钮不存在。
    await workshopNavigate(page, '设置');
    await expect(page.getByRole('region', { name: '应用设置', exact: true })).toContainText('Codex CLI · 对话已连接');
    await expect(titlebarChat(page)).toHaveCount(0);
    const header = page.locator('header.titlebar');
    await expect(header).not.toContainText('对话已连接');
    await expect(header).not.toContainText('读取对话状态');
    await expect(page.locator('.toasts [data-status-key^="chat:"]')).toHaveCount(0);
  } finally {
    await app.close();
  }
});

test('环境按钮：默认环境下可见、Tab 可达、Enter 进入设置页；全局 problem 不出现为 Toast', async () => {
  // 依赖 E2E 默认环境：安装阶段未就绪（setup.stage !== 'ready'），因此一定有环境按钮。
  const { app, page } = await launchApp();
  try {
    const button = page.getByRole('button', { name: '环境 · 比赛环境未就绪', exact: true });
    await expect(button).toBeVisible();
    await expect(button).toHaveAttribute('data-status-key', /^setup:global:/);
    // 按钮是普通按钮：不带 live region。
    await expect(button).not.toHaveAttribute('role', /.+/);
    await expect(page.locator('header.titlebar [role="alert"], header.titlebar [role="status"]')).toHaveCount(0);
    // 全局 problem 是持续条件，只在标题栏；页面上没有对应 Toast，也没有多余的 alert。
    await expect(page.locator('.toasts [data-status-key^="setup:"]')).toHaveCount(0);
    await expect(page.locator('.toasts [data-status-key^="chat:"]')).toHaveCount(0);
    await expect(page.getByRole('alert')).toHaveCount(0);
    // 完整 label 在 title 与视觉隐藏的描述中。
    await expect(button).toHaveAttribute('title', /比赛环境未就绪/);
    await expect(button).toHaveAccessibleDescription(/^比赛环境未就绪/);
    await page.locator('#left-panel-trigger').focus();
    let reached = false;
    for (let i = 0; i < 12 && !reached; i++) {
      await page.keyboard.press('Tab');
      reached = await button.evaluate((node) => node === document.activeElement);
    }
    expect(reached).toBe(true);
    await page.keyboard.press('Enter');
    await expect(page.getByRole('region', { name: '应用设置', exact: true })).toBeVisible();
  } finally {
    await app.close();
  }
});

test('960 宽：两个标题栏按钮与铃铛都在视口内且互不重叠', async () => {
  // 依赖 E2E 默认环境：对话不可用 + 安装阶段未就绪，两个按钮同时出现。
  const { app, page } = await launchApp();
  try {
    await resize(app, page, 960, 700);
    const names = [
      page.getByRole('button', { name: 'Codex CLI · 对话不可用', exact: true }),
      page.getByRole('button', { name: '环境 · 比赛环境未就绪', exact: true }),
      bell(page),
    ];
    const boxes = [];
    for (const locator of names) {
      await expect(locator).toBeVisible();
      const box = await locator.boundingBox();
      expect(box).not.toBeNull();
      boxes.push(box!);
    }
    const viewport = await page.evaluate(() => ({ width: window.innerWidth, height: window.innerHeight }));
    for (const box of boxes) {
      expect(box.x).toBeGreaterThanOrEqual(0);
      expect(box.y).toBeGreaterThanOrEqual(0);
      expect(box.x + box.width).toBeLessThanOrEqual(viewport.width);
      expect(box.y + box.height).toBeLessThanOrEqual(viewport.height);
    }
    for (let i = 0; i < boxes.length; i++)
      for (let j = i + 1; j < boxes.length; j++) {
        const a = boxes[i]!;
        const b = boxes[j]!;
        const overlap = a.x < b.x + b.width && b.x < a.x + a.width && a.y < b.y + b.height && b.y < a.y + a.height;
        expect(overlap, `按钮 ${i} 与 ${j} 重叠`).toBe(false);
      }
  } finally {
    await app.close();
  }
});

test('存储横幅与工作区错误 Toast 叠放：同时可见、互不遮挡，Toast 的关闭按钮可点击', async () => {
  const userData = await mkdtemp(path.join(tmpdir(), 'wsl-status-storage-'));
  const { app, page } = await launchApp({ userData });
  try {
    // 先确认初始网页加载完成，避免依赖启动时偶然迟到的 runtime 事件。
    await expect.poll(async () => (await previewInfo(app)).url).toBe('wsl-demo://taskflow/index.html');
    await expect.poll(async () => (await browserState(page)).loading).toBe(false);
    const generation = (await browserState(page)).page.documentGeneration;
    await run('chmod', ['-R', 'a-w', userData]);
    // 真实刷新产生不可回滚的网页状态；保存失败后 Main 保留内存状态并发布 storageError。
    await page.getByRole('button', { name: '刷新页面', exact: true }).click();
    await expect.poll(async () => (await browserState(page)).page.documentGeneration).toBeGreaterThan(generation);
    await expect.poll(async () => (await browserState(page)).loading).toBe(false);
    await expect.poll(async () => (await workspaceSnapshot(page)).storageError).toContain('工作现场保存失败');
    // 分屏命令的持久化失败会回滚布局，并单独产生工作区错误 Toast。
    await page.getByRole('button', { name: '左右分屏', exact: true }).last().click();
    const banner = page.getByRole('alert').filter({ hasText: '持久化失败' });
    const toast = page.locator('.toasts .workspace-error');
    await expect(banner).toBeVisible();
    await expect(banner).toContainText('当前状态仅保留在内存中。');
    await expect(toast).toBeVisible();
    const [bannerBox, toastBox] = [await banner.boundingBox(), await toast.boundingBox()];
    expect(bannerBox && toastBox).toBeTruthy();
    // Toast 整体在横幅之上，两者不相交。
    expect(toastBox!.y + toastBox!.height).toBeLessThanOrEqual(bannerBox!.y);
    await page.screenshot({ path: path.join(screensDir, 'status-surface-storage-banner-with-toast.png') });
    // 关闭按钮真实可点（不被横幅遮挡）。
    await toast.getByRole('button', { name: '关闭错误提示', exact: true }).click();
    await expect(toast).toHaveCount(0);
    await expect(banner).toBeVisible();
  } finally {
    await run('chmod', ['-R', 'u+w', userData]);
    await app.close();
  }
});

test('标题栏截图：白 / 暗 / 暖 × 1440 / 960，正常与对话不可用', async () => {
  test.setTimeout(120000);
  const dir = path.join(screensDir, 'status-surface');
  await mkdir(dir, { recursive: true });
  for (const [state, options] of [
    ['normal', { codexBin }],
    ['unavailable', {}],
  ] as const) {
    const { app, page } = await launchApp(options);
    try {
      await resize(app, page, 1440, 900);
      if (state === 'normal') {
        await workshopNavigate(page, '设置');
        await expect(page.getByRole('region', { name: '应用设置', exact: true })).toContainText('Codex CLI · 对话已连接');
        await workshopNavigate(page, '空间');
      }
      for (const [theme, label] of [
        ['light', 'light'],
        ['dark', 'dark'],
        ['warm', 'warm'],
      ] as const) {
        await resize(app, page, 1440, 900);
        // 从窄窗回到宽窗后等 Workshop 导航稳定出现，再经 UI 切换主题。
        await expect(page.getByRole('navigation', { name: 'Workshop 导航' })).toBeVisible();
        await setWorkspaceTheme(page, theme);
        // 两种状态都有环境按钮（E2E 环境安装 stage 非 ready）；对话按钮只在不可用时出现。
        await expect(page.getByRole('button', { name: /^环境 · / })).toBeVisible();
        if (state === 'unavailable') await expect(titlebarChat(page)).toBeVisible();
        else await expect(titlebarChat(page)).toHaveCount(0);
        await expect(bell(page)).toBeVisible();
        for (const width of [1440, 960]) {
          await resize(app, page, width, width === 1440 ? 900 : 700);
          await shot(page, `status-surface/titlebar-${state}-${label}-${width}`);
        }
      }
    } finally {
      await app.close();
    }
  }
});

/* ---------- 侧栏 ---------- */

const sidebarOf = (page: Page) => page.getByRole('region', { name: '空间导航', exact: true });
const tabRow = (page: Page, title: string) =>
  sidebarOf(page)
    .locator('.vertical-tab')
    .filter({ has: page.getByRole('button', { name: title, exact: true }) });

/** 宽窗口里侧栏常驻；窄窗口里经「展开 Workshop」临时展开。 */
async function showSidebar(page: Page, whileVisible?: () => Promise<void>) {
  const navigation = page.getByRole('navigation', { name: 'Workshop 导航' });
  // 主题 / 宽度切换后可能处于收起、临时展开或非空间路由的中间态：每轮重新判断，补齐缺失的一步。
  await expect(async () => {
    if (!(await sidebarOf(page).isVisible())) {
      if (!(await navigation.isVisible())) {
        await page.getByRole('button', { name: '展开 Workshop', exact: true }).click({ timeout: 2000 });
        await expect(navigation).toBeVisible({ timeout: 2000 });
      }
      const space = navigation.getByRole('button', { name: '空间', exact: true });
      if ((await space.getAttribute('aria-current')) !== 'page') await space.click({ timeout: 2000 });
    }
    await expect(sidebarOf(page)).toBeVisible({ timeout: 2000 });
    // 窗口宽度变化后布局模式可能稍后才切换并收起临时展开；需要侧栏在场的断言与截图放进同一轮重试。
    await whileVisible?.();
  }).toPass({ timeout: 20000 });
}

async function connectTerminal(page: Page) {
  await page.getByRole('navigation', { name: '空间标签' }).getByRole('button', { name: '开发终端', exact: true }).click();
  const panel = page.getByRole('region', { name: '资源终端' });
  await panel.getByRole('button', { name: '连接终端', exact: true }).click();
  await expect(panel).toContainText('已连接');
}

async function failSessionRun(page: Page) {
  await page.getByRole('navigation', { name: '空间标签' }).getByRole('button', { name: 'Agent 会话', exact: true }).click();
  const region = page.getByRole('region', { name: 'Agent 会话内容' });
  await region.getByRole('textbox', { name: '会话消息', exact: true }).fill('执行器不可用时记录失败运行');
  await region.getByRole('button', { name: '发送', exact: true }).click();
  await expect.poll(async () => (await workspaceSnapshot(page)).workspaces[0]!.runs.at(-1)?.state).toBe('failed');
}

test('侧栏：终端连接后行尾出现成功色实心点；没有「已显示」与页脚说明；方向键导航不变', async () => {
  const { app, page } = await launchApp({ sbxBin });
  try {
    const sidebar = sidebarOf(page);
    await showSidebar(page);
    const row = tabRow(page, '开发终端');
    // 尚未连接：不画点（空闲状态不是噪声）。
    await expect(row).toBeVisible();
    await expect(row.locator('[data-status]')).toHaveCount(0);
    await connectTerminal(page);

    const dot = row.locator('[data-status="terminal:ok"]');
    await expect(dot).toBeVisible();
    await expect(dot).toHaveText('已连接');
    await expect(dot).toHaveAttribute('data-status-key', /^terminal:.+:state$/);
    // 实心点，颜色是成功色而不是中性灰。
    await expect(dot.locator('.shape-dot')).toBeVisible();
    const colors = await dot.evaluate((node) => {
      const probe = document.createElement('span');
      probe.style.color = 'var(--ok)';
      document.body.append(probe);
      const ok = getComputedStyle(probe).color;
      probe.remove();
      return { dot: getComputedStyle(node).color, ok };
    });
    expect(colors.dot).toBe(colors.ok);
    // 标签按钮的名称不变，状态文字走描述。
    const main = row.getByRole('button', { name: '开发终端', exact: true });
    await expect(main).toHaveAccessibleDescription('已连接');
    // 其他标签（网页、会话）没有被误加点。
    await expect(sidebar.locator('.vertical-tab [data-status]')).toHaveCount(1);

    await expect(sidebar).not.toContainText('已显示');
    await expect(sidebar).not.toContainText('执行中');
    await expect(sidebar).not.toContainText('关闭窗格保留标签');
    await expect(sidebar).not.toContainText('隐藏继续运行');
    await expect(sidebar.locator('.sidebar-footer')).toContainText('搜索空间或标签');

    // 方向键移动焦点的行为不变。
    const mains = sidebar.locator('.vertical-tab-main');
    const count = await mains.count();
    expect(count).toBeGreaterThan(2);
    await mains.first().focus();
    await page.keyboard.press('ArrowDown');
    await expect(mains.nth(1)).toBeFocused();
    await page.keyboard.press('End');
    await expect(mains.nth(count - 1)).toBeFocused();
    await page.keyboard.press('ArrowDown');
    await expect(mains.first()).toBeFocused();
    await page.keyboard.press('ArrowUp');
    await expect(mains.nth(count - 1)).toBeFocused();
    await page.keyboard.press('Home');
    await expect(mains.first()).toBeFocused();
  } finally {
    await app.close();
  }
});

test('侧栏：「后台资源 / 已关闭标签」没有内容时不出现，有内容时摘要保留原文并附计数', async () => {
  const { app, page } = await launchApp({ sbxBin });
  try {
    await showSidebar(page);
    const background = sidebarOf(page).locator('details.background-resources');
    await expect(background).toHaveCount(0);

    await page.getByRole('navigation', { name: '空间标签' }).getByRole('button', { name: '开发终端', exact: true }).click();
    await page.getByRole('button', { name: '开发终端操作', exact: true }).click();
    await page.getByRole('menuitem', { name: '关闭标签（保留后台执行）', exact: true }).click();
    await showSidebar(page);
    await expect(background).toHaveCount(1);
    // 原文在独立元素里（精确匹配仍命中），计数在另一个元素里，口径与列出的条目一致。
    const label = sidebarOf(page).getByText('后台资源 / 已关闭标签', { exact: true });
    await expect(label).toHaveCount(1);
    await expect(background.locator('summary')).toContainText('后台资源 / 已关闭标签');
    await expect(background.locator('summary .count')).toHaveText('· 1');
    await label.click();
    await expect(background.locator('.stack-8')).toHaveCount(1);
    await expect(background.locator('.stack-8')).toContainText('开发终端');

    await background.getByRole('button', { name: '开发终端 · 重新打开', exact: true }).click();
    await showSidebar(page);
    await expect(background).toHaveCount(0);
  } finally {
    await app.close();
  }
});

test('侧栏：会话执行失败时行尾是失败三角，状态文字进入标签描述', async () => {
  const { app, page } = await launchApp();
  try {
    await showSidebar(page);
    const row = tabRow(page, 'Agent 会话');
    await expect(row.locator('[data-status]')).toHaveCount(0);
    await failSessionRun(page);
    await showSidebar(page);
    const dot = row.locator('[data-status="run:failed"]');
    await expect(dot).toBeVisible();
    await expect(dot).toHaveText('执行失败');
    await expect(dot.locator('.shape-triangle')).toBeVisible();
    await expect(row.getByRole('button', { name: 'Agent 会话', exact: true })).toHaveAccessibleDescription('执行失败');
  } finally {
    await app.close();
  }
});

test('侧栏截图：白 / 暗 / 暖 × 1440 / 960，正常（终端已连接）与异常（会话执行失败）', async () => {
  test.setTimeout(180000);
  const dir = path.join(screensDir, 'status-surface');
  await mkdir(dir, { recursive: true });
  for (const [state, options] of [
    ['normal', { sbxBin }],
    ['abnormal', {}],
  ] as const) {
    const { app, page } = await launchApp(options);
    try {
      await resize(app, page, 1440, 900);
      if (state === 'normal') await connectTerminal(page);
      else await failSessionRun(page);
      for (const theme of ['light', 'dark', 'warm'] as const) {
        await resize(app, page, 1440, 900);
        await expect(page.getByRole('navigation', { name: 'Workshop 导航' })).toBeVisible();
        await setWorkspaceTheme(page, theme);
        for (const width of [1440, 960]) {
          await resize(app, page, width, width === 1440 ? 900 : 700);
          await showSidebar(page, async () => {
            const dot = sidebarOf(page).locator(state === 'normal' ? '[data-status="terminal:ok"]' : '[data-status="run:failed"]');
            await expect(dot).toBeVisible({ timeout: 2000 });
            await shot(page, `status-surface/sidebar-${state}-${theme}-${width}`);
          });
        }
      }
    } finally {
      await app.close();
    }
  }
});

/* ---------- 终端 ---------- */

const terminalPanel = (page: Page) => page.getByRole('region', { name: '资源终端' });
const terminalSlotItems = (page: Page) => terminalPanel(page).locator('.status-slot .status-item');
const capsuleOf = (page: Page) => terminalPanel(page).locator('.terminal-capsule');
const connectButton = (page: Page) => terminalPanel(page).getByRole('button', { name: '连接终端', exact: true });
const interruptButton = (page: Page) => terminalPanel(page).getByRole('button', { name: '中断（Ctrl-C）', exact: true });
const closeButton = (page: Page) => terminalPanel(page).getByRole('button', { name: '关闭终端', exact: true });

/** 不经过面板内的任何交互，直接用命令关闭当前终端实例（焦点保持不动）。 */
async function stopTerminalByCommand(page: Page) {
  const snapshot = await workspaceSnapshot(page);
  const resource = snapshot.workspaces
    .find((workspace) => workspace.workspaceId === snapshot.activeWorkspaceId)!
    .resources.find((item) => item.kind === 'terminal' && item.terminal?.state === 'running')!;
  await page.evaluate((command) => window.studio.workbench.command({ ...command, commandId: crypto.randomUUID() } as never), {
    type: 'stopInstance',
    workspaceId: snapshot.activeWorkspaceId,
    resourceId: resource.resourceId,
    instanceId: resource.instanceId!,
  });
}

async function createSshTab(page: Page, title: string) {
  await page.getByRole('button', { name: '新建标签', exact: true }).click();
  const editor = page.getByRole('dialog', { name: '新建标签' });
  await editor.getByLabel('标签类型').selectOption('ssh');
  await editor.getByLabel('名称', { exact: true }).fill(title);
  await editor.getByLabel('资源环境').selectOption('ssh');
  await editor.getByRole('button', { name: '保存', exact: true }).click();
}

test('终端已连接：胶囊与成功色实心点可见，悬停含沙箱全名与绝对 cwd；中断与关闭是图标按钮且名称不变、Tab 可达', async () => {
  const { app, page } = await launchApp({ sbxBin });
  try {
    await connectTerminal(page);
    const capsule = capsuleOf(page);
    await expect(capsule).toBeVisible();
    await expect(capsule.locator('.terminal-capsule-text')).toHaveText('sandbox · workspace');
    const dot = capsule.locator('[data-status="terminal:ok"]');
    await expect(dot).toBeVisible();
    await expect(dot.locator('.shape-dot')).toBeVisible();
    await expect(dot).toHaveText('已连接');
    await capsule.hover();
    await expect(capsule).toHaveAttribute('title', new RegExp(`${fixtureSandbox} · /home/agent/workspace`));
    await expect(dot).toHaveAttribute('title', new RegExp(`已连接（${fixtureSandbox} · /home/agent/workspace）`));

    // 原整串「环境 / 沙箱全名 · 绝对 cwd · 状态」、英文枚举与页脚说明都不再外露。
    await expect(terminalPanel(page).locator('[role="status"]:visible')).toHaveCount(0);
    await expect(terminalPanel(page)).not.toContainText('输出最多保留');
    await expect(terminalPanel(page)).not.toContainText('隐藏窗格继续运行');
    await expect(terminalSlotItems(page)).toHaveCount(0);

    // 图标按钮：可见、名称不变、没有文字；Tab 可达，顺序为中断 → 关闭。
    for (const button of [interruptButton(page), closeButton(page)]) {
      await expect(button).toBeVisible();
      await expect(button).toHaveClass(/icon-btn/);
      await expect(button.locator('svg')).toBeVisible();
      await expect(button).toHaveText('');
    }
    await expect(interruptButton(page)).toHaveAttribute('title', '中断（Ctrl-C）');
    await expect(closeButton(page)).toHaveAttribute('title', '关闭终端');
    await interruptButton(page).focus();
    await expect(interruptButton(page)).toBeFocused();
    await page.keyboard.press('Tab');
    await expect(closeButton(page)).toBeFocused();
    await page.keyboard.press('Shift+Tab');
    await expect(interruptButton(page)).toBeFocused();
  } finally {
    await app.close();
  }
});

test('终端已关闭：提示可见；与窗格交互后视觉消失而圆点文字仍在；重新连接再关闭后再次可见', async () => {
  const { app, page } = await launchApp({ sbxBin });
  try {
    const closedText = '已关闭，所属进程已确认退出';
    const notice = terminalSlotItems(page).filter({ hasText: closedText });
    await connectTerminal(page);
    await expect(notice).toHaveCount(0);
    await closeButton(page).click();
    await expect(notice).toBeVisible();
    await expect(notice.getByRole('button', { name: '知道了', exact: true })).toBeVisible();
    // 连接动作只在工具栏出现一次。
    await expect(connectButton(page)).toHaveCount(1);
    await expect(capsuleOf(page).locator('[data-status="terminal:idle"]')).toContainText(closedText);

    // pointerdown 路径：点击胶囊文字（不可聚焦，不产生 focus 事件），提示视觉消失，但环境级圆点仍携带同一文字。
    await capsuleOf(page).locator('.terminal-capsule-text').click();
    await expect(notice).not.toBeVisible();
    await expect(terminalSlotItems(page)).toHaveCount(0);
    const dot = capsuleOf(page).locator('[data-status="terminal:idle"]');
    await expect(dot).toHaveCount(1);
    await expect(dot).toContainText(closedText);
    await expect(terminalPanel(page)).toContainText(closedText);

    // keydown 路径：焦点先放在终端输入框里（此时没有提示，不产生确认），不经面板内的点击或聚焦，
    // 直接通过命令关闭终端使提示（新实例，instanceToken 变化）出现，再发一次纯按键。
    await connectButton(page).click();
    await expect(terminalPanel(page)).toContainText('已连接');
    const input = terminalPanel(page).getByLabel('终端输入');
    await input.focus();
    await expect(input).toBeFocused();
    await stopTerminalByCommand(page);
    await expect(notice).toBeVisible();
    await expect(input).toBeFocused();
    await page.keyboard.press('Shift');
    await expect(notice).not.toBeVisible();
    await expect(capsuleOf(page).locator('[data-status="terminal:idle"]')).toContainText(closedText);

    // 用户引起的聚焦同样确认：再来一个新实例，关闭后用键盘 Tab 进入窗格。
    await connectButton(page).click();
    await expect(terminalPanel(page)).toContainText('已连接');
    await closeButton(page).click();
    await expect(notice).toBeVisible();
    // 键盘 Tab 进入窗格（keydown 发生在窗格之外）：焦点进入即确认。鼠标点按钮引起的焦点不算，在 click 里确认。
    await page.locator('[data-pane-id]:visible .pane-title').focus();
    let reached = false;
    for (let i = 0; i < 12 && !reached; i++) {
      await page.keyboard.press('Tab');
      reached = await connectButton(page).evaluate((node) => node === document.activeElement);
    }
    expect(reached).toBe(true);
    await expect(notice).not.toBeVisible();
  } finally {
    await app.close();
  }
});

test('终端已关闭：切换标签再切回（程序性聚焦）不确认提示；随后点击终端区域才消失', async () => {
  const { app, page } = await launchApp({ sbxBin });
  try {
    const closedText = '已关闭，所属进程已确认退出';
    const notice = terminalSlotItems(page).filter({ hasText: closedText });
    const tabs = page.getByRole('navigation', { name: '空间标签' });
    await connectTerminal(page);
    await closeButton(page).click();
    await expect(notice).toBeVisible();
    await tabs.getByRole('button', { name: 'Agent 会话', exact: true }).click();
    await expect(page.getByRole('region', { name: 'Agent 会话内容' })).toBeVisible();
    await tabs.getByRole('button', { name: '开发终端', exact: true }).click();
    await expect(terminalPanel(page)).toBeVisible();
    // 重新激活时终端被程序性聚焦，但这不是用户与窗格交互：提示仍在。
    await expect(terminalPanel(page).getByLabel('终端输入')).toBeFocused();
    await expect(notice).toBeVisible();
    await terminalPanel(page).locator('.terminal-surface').click();
    await expect(notice).not.toBeVisible();
  } finally {
    await app.close();
  }
});

test('终端不可用：问题通道条目可见，连接按钮禁用', async () => {
  const { app, page } = await launchApp();
  try {
    // 依赖 E2E 默认环境：sbx 缺失，环境没有终端能力。
    await page.getByRole('navigation', { name: '空间标签' }).getByRole('button', { name: '开发终端', exact: true }).click();
    const item = terminalSlotItems(page).locator('xpath=self::*[@data-status="terminal:degraded"]');
    await expect(item).toBeVisible();
    await expect(item).toHaveAttribute('data-status-channel', 'problem');
    await expect(item.getByRole('alert')).toBeVisible();
    expect(((await item.textContent()) ?? '').trim().length).toBeGreaterThan(0);
    await expect(connectButton(page)).toBeDisabled();
    await expect(terminalPanel(page)).not.toContainText('undefined');
  } finally {
    await app.close();
  }
});

test('终端连接失败：问题通道显示失败与可见的 detail；工具栏连接按钮可 Tab 到达', async () => {
  const fixture = await sshLoopback();
  let app: Awaited<ReturnType<typeof launchApp>>['app'] | undefined;
  try {
    const launched = await launchApp({
      sshEnvironment: { ...fixture.environment, hostKeySha256: '0'.repeat(64) },
      userData: fixture.profile,
    });
    app = launched.app;
    const page = launched.page;
    await createSshTab(page, '错误pin');
    await connectButton(page).click();
    const item = terminalSlotItems(page).locator('xpath=self::*[@data-status="terminal:failed"]');
    await expect(item).toBeVisible();
    await expect(item).toHaveAttribute('data-status-channel', 'problem');
    await expect(item.getByRole('alert')).toContainText('连接失败');
    await expect(item.locator('.status-detail')).toBeVisible();
    expect(((await item.locator('.status-detail').textContent()) ?? '').trim().length).toBeGreaterThan(0);
    await expect(capsuleOf(page).locator('[data-status="terminal:failed"]')).toBeVisible();
    // 槽里不重复渲染连接按钮；工具栏的按钮可用并可由键盘到达。
    await expect(connectButton(page)).toHaveCount(1);
    await expect(connectButton(page)).toBeEnabled();
    await connectButton(page).focus();
    await expect(connectButton(page)).toBeFocused();
    // 失败是问题，不因交互降级。
    await terminalPanel(page).locator('.terminal-surface').click();
    await expect(item).toBeVisible();
  } finally {
    await app?.close();
    await fixture.stop();
  }
});

test('SSH 断线后进程未确认：交互后提示仍可见（unresolved 不降级）', async () => {
  test.setTimeout(180000);
  const fixture = await sshLoopback();
  let app: Awaited<ReturnType<typeof launchApp>>['app'] | undefined;
  try {
    const launched = await launchApp({ sshEnvironment: fixture.environment, userData: fixture.profile });
    app = launched.app;
    const page = launched.page;
    await createSshTab(page, '断线SSH');
    await connectButton(page).click();
    await expect(terminalPanel(page)).toContainText('已连接');
    fixture.disconnect();
    const unresolved = terminalSlotItems(page).filter({ hasText: '所属进程退出未确认' });
    await expect(unresolved).toBeVisible();
    await expect(unresolved).toHaveAttribute('data-status-channel', 'persistent');
    // 点击窗格、按键之后仍然可见。工具栏的「连接终端」保持可见但禁用：清理未确认时重连由 Main 明确拒绝（ssh-product.spec 经命令通道核对）。
    await expect(connectButton(page)).toBeVisible();
    await expect(connectButton(page)).toBeDisabled();
    await terminalPanel(page).locator('.terminal-surface').click();
    await page.keyboard.press('Shift+Tab');
    await expect(unresolved).toBeVisible();
    await expect(connectButton(page)).toBeDisabled();
    await expect(capsuleOf(page).locator('[data-status="terminal:failed"]')).toBeVisible();
  } finally {
    // 产品有意拒绝在远端清理未确认时正常关闭窗口（同 ssh-product.spec）：fixture 独立确认其 PTY 已退出后强制结束本测试拥有的进程。
    if (app && app.process().exitCode === null) {
      const exited = new Promise<void>((resolve) => app!.process().once('exit', () => resolve()));
      app.process().kill('SIGKILL');
      await exited;
    }
    await fixture.stop();
  }
});

test('修复复验：终端清理未确认时连接按钮禁用（failed/closed/idle 均成立），消除后恢复，starting/closing 仍禁用，中断名称保留', async () => {
  const { app, page } = await launchApp({ sbxBin });
  try {
    await mkdir(path.join(screensDir, 'status-surface'), { recursive: true });
    await resize(app, page, 1440, 900);
    await page.getByRole('navigation', { name: '空间标签' }).getByRole('button', { name: '开发终端', exact: true }).click();
    const connect = connectButton(page);
    const unresolved = terminalSlotItems(page).filter({ hasText: '所属进程退出未确认' });
    const resourceId = (await workspaceSnapshot(page)).workspaces[0]!.resources.find((r) => r.kind === 'terminal')!.resourceId;
    await installStatusShim(app);
    const terminal = (over: Record<string, unknown>) => ({
      seq: 0,
      sessionId: 'shim-session',
      sandbox: 'fixture-sandbox',
      cwd: '/home/agent/workspace',
      output: '',
      outputOffset: 0,
      error: null,
      ...over,
    });
    for (const state of ['failed', 'closed', 'idle'] as const) {
      await setStatusShim(app, {
        terminal: { [resourceId]: terminal({ state, cleanupPending: true, error: state === 'failed' ? 'fixture 断线' : null }) },
      });
      await pushWorkbenchSnapshot(page);
      await expect(unresolved).toBeVisible();
      await expect(connect).toBeVisible();
      await expect(connect).toBeDisabled();
    }
    await shot(page, 'status-surface/terminal-cleanup-pending-disabled-1440');
    await setStatusShim(app, { terminal: { [resourceId]: terminal({ state: 'idle', cleanupPending: false }) } });
    await pushWorkbenchSnapshot(page);
    await expect(unresolved).toHaveCount(0);
    await expect(connect).toBeEnabled();
    for (const state of ['starting', 'closing'] as const) {
      await setStatusShim(app, { terminal: { [resourceId]: terminal({ state, cleanupPending: true }) } });
      await pushWorkbenchSnapshot(page);
      await expect(connect).toBeDisabled();
    }
    await setStatusShim(app, { terminal: { [resourceId]: terminal({ state: 'running', cleanupPending: true }) } });
    await pushWorkbenchSnapshot(page);
    await expect(connect).toHaveCount(0);
    await expect(interruptButton(page)).toBeVisible();
    await expect(closeButton(page)).toBeVisible();
  } finally {
    await app.close();
  }
});

test('终端截图：白 / 暗 / 暖 × 1440 / 960，正常（已连接）与异常（连接失败）', async () => {
  test.setTimeout(240000);
  const dir = path.join(screensDir, 'status-surface');
  await mkdir(dir, { recursive: true });
  const fixture = await sshLoopback();
  const cases = [
    { state: 'normal', launch: () => launchApp({ sbxBin }) },
    {
      state: 'abnormal',
      launch: () => launchApp({ sshEnvironment: { ...fixture.environment, hostKeySha256: '0'.repeat(64) }, userData: fixture.profile }),
    },
  ] as const;
  try {
    for (const { state, launch } of cases) {
      const { app, page } = await launch();
      try {
        await resize(app, page, 1440, 900);
        if (state === 'normal') await connectTerminal(page);
        else {
          await createSshTab(page, '错误pin');
          await connectButton(page).click();
        }
        for (const theme of ['light', 'dark', 'warm'] as const) {
          await resize(app, page, 1440, 900);
          await expect(page.getByRole('navigation', { name: 'Workshop 导航' })).toBeVisible();
          await setWorkspaceTheme(page, theme);
          for (const width of [1440, 960]) {
            await resize(app, page, width, width === 1440 ? 900 : 700);
            await expect(terminalPanel(page)).toBeVisible();
            if (state === 'normal') await expect(capsuleOf(page).locator('[data-status="terminal:ok"]')).toBeVisible();
            else await expect(terminalSlotItems(page).locator('xpath=self::*[@data-status="terminal:failed"]')).toBeVisible();
            await shot(page, `status-surface/terminal-${state}-${theme}-${width}`);
          }
        }
      } finally {
        await app.close();
      }
    }
  } finally {
    await fixture.stop();
  }
});

/* ---------- 网页 ---------- */

const browserRoot = (page: Page) => page.locator('.workspace-browser:visible');
const browserSlotItems = (page: Page) => browserRoot(page).locator('.status-slot .status-item');
const captureTrigger = (page: Page) => page.getByRole('button', { name: '采集到会话', exact: true });
const moreTrigger = (page: Page) => page.getByRole('button', { name: '更多网页操作', exact: true });
const captureDialog = (page: Page) => page.getByRole('dialog', { name: '采集到会话', exact: true });
const moreMenu = (page: Page) => page.getByRole('menu', { name: '更多网页操作', exact: true });
const GUIDANCE = '请在此网页的“关联会话”中明确选择会话，再点击“采集到关联会话”。';

/** 原生网页让位 / 恢复：renderer 的占位标记与 Main 里 WebContentsView 的真实可见性都要对上。 */
async function expectNativePage(app: ElectronApplication, page: Page, visible: boolean) {
  await expect(page.locator('.preview-host:visible')).toHaveAttribute('data-native', visible ? 'visible' : 'hidden');
  await expect.poll(async () => (await previewInfo(app)).visible).toBe(visible);
}

async function activeWebResource(page: Page) {
  const snapshot = await workspaceSnapshot(page);
  const workspace = snapshot.workspaces.find((item) => item.workspaceId === snapshot.activeWorkspaceId)!;
  return { workspaceId: workspace.workspaceId, resource: workspace.resources.find((item) => item.kind === 'web')! };
}

/** 不经过界面，直接下发网页动作。 */
async function browserActionByCommand(page: Page, action: 'reattach') {
  const { workspaceId, resource } = await activeWebResource(page);
  await page.evaluate((command) => window.studio.workbench.command({ ...command, commandId: crypto.randomUUID() } as never), {
    type: 'browserAction',
    workspaceId,
    resourceId: resource.resourceId,
    action,
  });
}

/** 取到 Main 里的预览网页（第一个 contentView 子视图）并执行回调；只用于制造页面级故障。 */
async function onPreview(app: ElectronApplication, fault: 'detach-cdp' | 'block-navigation') {
  await app.evaluate(({ BrowserWindow }, kind) => {
    const wc = (BrowserWindow.getAllWindows()[0]!.contentView.children[0] as Electron.WebContentsView).webContents;
    // 真实的调试器断开 / 真实的 will-navigate 路径（受保护导航由 PreviewController.guardNavigation 拦截）。
    if (kind === 'detach-cdp') wc.debugger.detach();
    else wc.emit('will-navigate', { url: 'http://blocked.example/path?token=secret', preventDefault() {} } as never);
  }, fault);
}

async function failPageLoad(app: ElectronApplication, page: Page) {
  await controlledResourceNetwork(app);
  const address = page.getByLabel('页面地址');
  // Initial readiness belongs to this business setup; address races have separate controlled regressions.
  await expect.poll(async () => (await previewInfo(app)).url).toBe('wsl-demo://taskflow/index.html');
  await expect.poll(async () => (await browserState(page)).loading).toBe(false);
  await expect(address).toHaveValue('wsl-demo://taskflow/index.html');
  await address.fill('https://example.com/missing');
  await address.press('Enter');
  await expect(browserSlotItems(page).filter({ hasText: '页面加载失败' })).toBeVisible();
}

test('网页：工具栏收为「选择元素 / 采集到会话 ⌄ / ⋯」，两整行动作区与规则说明不再外露', async () => {
  const { app, page } = await launchApp();
  try {
    await expect(browserRoot(page)).toBeVisible();
    for (const locator of [
      page.getByRole('button', { name: '后退', exact: true }),
      page.getByRole('button', { name: '前进', exact: true }),
      page.getByRole('button', { name: '刷新页面', exact: true }),
      page.getByLabel('页面地址'),
      page.getByRole('button', { name: '选择元素', exact: true }),
      captureTrigger(page),
      moreTrigger(page),
    ])
      await expect(locator).toBeVisible();
    await expect(captureTrigger(page)).toHaveAttribute('aria-haspopup', 'dialog');
    await expect(moreTrigger(page)).toHaveAttribute('aria-haspopup', 'menu');
    // 弹出层收起时，里面的控件不在页面上；规则说明与「沙箱应用」行也不存在。
    await expect(page.getByLabel('关联会话')).toHaveCount(0);
    await expect(page.getByRole('button', { name: '保存正文快照', exact: true })).toHaveCount(0);
    await expect(browserRoot(page)).not.toContainText('收藏地址与正文快照分别保存');
    await expect(browserRoot(page)).not.toContainText('沙箱应用 ·');
    await expect(browserSlotItems(page)).toHaveCount(0);
    await expectNativePage(app, page, true);
  } finally {
    await app.close();
  }
});

test('网页「采集到会话 ⌄」：Tab 到触发器、Enter 打开，方向键在控件间移动，Esc 关闭并回到触发器，原生网页让位后恢复', async () => {
  const { app, page } = await launchApp();
  try {
    await expectNativePage(app, page, true);
    await page.getByRole('button', { name: '选择元素', exact: true }).focus();
    await page.keyboard.press('Tab');
    await expect(captureTrigger(page)).toBeFocused();
    await expect(captureTrigger(page)).toHaveAttribute('aria-expanded', 'false');
    await page.keyboard.press('Enter');
    const dialog = captureDialog(page);
    await expect(dialog).toBeVisible();
    await expect(captureTrigger(page)).toHaveAttribute('aria-expanded', 'true');
    await expectNativePage(app, page, false);
    // 没有选会话时，「采集到关联会话」「打开关联会话」禁用；选择后可用。
    await expect(dialog.getByRole('button', { name: '采集到关联会话', exact: true })).toBeDisabled();
    await expect(dialog.getByRole('button', { name: '打开关联会话', exact: true })).toBeDisabled();
    await expect(dialog.getByRole('button', { name: '新建关联会话', exact: true })).toBeEnabled();
    const select = dialog.getByLabel('关联会话');
    await expect(select).toBeFocused();
    await select.selectOption({ label: 'Agent 会话' });
    await expect(dialog.getByRole('button', { name: '采集到关联会话', exact: true })).toBeEnabled();
    // select 自己使用方向键；Tab 进入按钮后，方向键在按钮间移动并循环。
    await select.focus();
    await page.keyboard.press('Tab');
    await expect(dialog.getByRole('button', { name: '新建关联会话', exact: true })).toBeFocused();
    await page.keyboard.press('ArrowDown');
    await expect(dialog.getByRole('button', { name: '采集到关联会话', exact: true })).toBeFocused();
    await page.keyboard.press('End');
    await expect(dialog.getByRole('button', { name: '打开关联会话', exact: true })).toBeFocused();
    await page.keyboard.press('ArrowDown');
    await expect(select).toBeFocused();
    await page.keyboard.press('Tab');
    await page.keyboard.press('ArrowUp');
    await expect(select).toBeFocused();
    await page.keyboard.press('Escape');
    await expect(dialog).toHaveCount(0);
    await expect(captureTrigger(page)).toBeFocused();
    await expect(captureTrigger(page)).toHaveAttribute('aria-expanded', 'false');
    await expectNativePage(app, page, true);

    // 点击外部同样关闭并恢复原生网页。
    await captureTrigger(page).click();
    await expect(dialog).toBeVisible();
    await expectNativePage(app, page, false);
    await page.getByLabel('页面地址').click();
    await expect(dialog).toHaveCount(0);
    await expectNativePage(app, page, true);

    // 再按一次触发器是开关。
    await captureTrigger(page).click();
    await expect(dialog).toBeVisible();
    await captureTrigger(page).click();
    await expect(dialog).toHaveCount(0);
    await expectNativePage(app, page, true);
  } finally {
    await app.close();
  }
});

test('网页「⋯」菜单：Tab 到触发器、Enter 打开，方向键 / Home / End 移动，Esc 关闭并回到触发器；菜单项名称与原按钮一致', async () => {
  const { app, page } = await launchApp();
  try {
    await expect(page.getByLabel('页面地址')).toHaveValue(/taskflow/);
    await captureTrigger(page).focus();
    await page.keyboard.press('Tab');
    await expect(moreTrigger(page)).toBeFocused();
    await page.keyboard.press('Enter');
    const menu = moreMenu(page);
    await expect(menu).toBeVisible();
    await expectNativePage(app, page, false);
    const items = menu.getByRole('menuitem');
    await expect(items).toHaveText(['收藏到资源', '保存正文快照', '查看空间资源']);
    await expect(menu.getByRole('menuitem', { name: '保存正文快照', exact: true })).toBeEnabled();
    await expect(menu.getByRole('menuitem', { name: '收藏到资源', exact: true })).toBeFocused();
    await page.keyboard.press('ArrowDown');
    await expect(menu.getByRole('menuitem', { name: '保存正文快照', exact: true })).toBeFocused();
    await page.keyboard.press('ArrowDown');
    await expect(menu.getByRole('menuitem', { name: '查看空间资源', exact: true })).toBeFocused();
    await page.keyboard.press('ArrowDown');
    await expect(menu.getByRole('menuitem', { name: '收藏到资源', exact: true })).toBeFocused();
    await page.keyboard.press('ArrowUp');
    await expect(menu.getByRole('menuitem', { name: '查看空间资源', exact: true })).toBeFocused();
    await page.keyboard.press('Home');
    await expect(menu.getByRole('menuitem', { name: '收藏到资源', exact: true })).toBeFocused();
    await page.keyboard.press('End');
    await expect(menu.getByRole('menuitem', { name: '查看空间资源', exact: true })).toBeFocused();
    await page.keyboard.press('Escape');
    await expect(menu).toHaveCount(0);
    await expect(moreTrigger(page)).toBeFocused();
    await expectNativePage(app, page, true);

    // 执行菜单项后菜单关闭；ArrowDown 也能从触发器打开菜单。
    await page.keyboard.press('ArrowDown');
    await expect(menu).toBeVisible();
    await menu.getByRole('menuitem', { name: '查看空间资源', exact: true }).press('Enter');
    await expect(menu).toHaveCount(0);
    await expect(page.locator('#space-resources-summary')).toBeFocused();
    await expectNativePage(app, page, true);
  } finally {
    await app.close();
  }
});

test('网页：「收藏到资源」结果是提示通道的 hint，点「知道了」或与窗格交互后消失', async () => {
  const { app, page } = await launchApp();
  try {
    await controlledResourceNetwork(app);
    const address = page.getByLabel('页面地址');
    await address.fill('https://example.com/');
    await address.press('Enter');
    await expect.poll(async () => (await previewInfo(app)).url).toBe('https://example.com/');
    await openBrowserMenu(page, '更多网页操作');
    await expect(page.getByRole('menuitem', { name: '保存正文快照', exact: true })).toBeEnabled();
    await page.getByRole('menuitem', { name: '收藏到资源', exact: true }).click();
    const bookmarked = browserSlotItems(page).filter({ hasText: '已收藏到我的资源。' });
    await expect(bookmarked).toBeVisible();
    await expect(bookmarked).toHaveAttribute('data-status-channel', 'notice');
    await expect(bookmarked.getByRole('status')).toBeVisible();
    await expect(moreMenu(page)).toHaveCount(0);
    await bookmarked.getByRole('button', { name: '知道了', exact: true }).click();
    await expect(bookmarked).toHaveCount(0);

    await openBrowserMenu(page, '更多网页操作');
    await page.getByRole('menuitem', { name: '保存正文快照', exact: true }).click();
    const snapshot = browserSlotItems(page).filter({ hasText: '正文快照已保存' });
    await expect(snapshot).toBeVisible();
    await expect(snapshot).toContainText('请在空间资源中明确选择参考版本');
    // 与窗格交互（聚焦地址栏）后消失。
    await address.click();
    await expect(snapshot).toHaveCount(0);
  } finally {
    await app.close();
  }
});

test('网页：采集指引是 hint（role=status，文案不变）；点「知道了」或与窗格交互后消失', async () => {
  const { app, page } = await launchApp();
  try {
    const guidance = browserSlotItems(page).filter({ hasText: GUIDANCE });
    await expect(guidance).toHaveCount(0);
    await page.getByRole('button', { name: '选择元素', exact: true }).click();
    await expect(guidance).toBeVisible();
    await expect(guidance).toHaveAttribute('data-status-channel', 'notice');
    // 页面上只有这一个 role=status（workbench.spec 按此严格定位）。
    await expect(page.getByRole('status')).toHaveCount(1);
    await expect(page.getByRole('status')).toContainText('关联会话');
    await guidance.getByRole('button', { name: '知道了', exact: true }).click();
    await expect(guidance).toHaveCount(0);
    // 再次出现；打开「采集到会话」（与窗格交互）后消失。
    await page.getByRole('button', { name: '选择元素', exact: true }).click();
    await expect(guidance).toBeVisible();
    await captureTrigger(page).click();
    await expect(guidance).toHaveCount(0);
    await page.keyboard.press('Escape');
    // 键盘路径：再次出现后，窗格内任意按键都视为交互。
    await page.getByRole('button', { name: '选择元素', exact: true }).click();
    await expect(guidance).toBeVisible();
    await page.keyboard.press('Shift');
    await expect(guidance).toHaveCount(0);
  } finally {
    await app.close();
  }
});

test('网页：加载失败 + 已拦截导航——加载失败在问题通道可见，「另有 1 项」展开看到拦截导航；槽高度变化后原生网页位置随之更新', async () => {
  const { app, page } = await launchApp();
  try {
    await expect(browserSlotItems(page)).toHaveCount(0);
    await failPageLoad(app, page);
    const loadError = browserSlotItems(page).filter({ hasText: '页面加载失败' });
    await expect(loadError).toHaveAttribute('data-status-channel', 'problem');
    await expect(loadError.getByRole('alert')).toBeVisible();
    await expect(loadError.getByRole('button', { name: '重新加载', exact: true })).toBeVisible();
    await onPreview(app, 'block-navigation');
    const more = browserSlotItems(page).getByRole('button', { name: '另有 1 项', exact: true });
    await expect(more).toBeVisible();
    // 拦截导航在折叠项里，不是第二条外露行；URL 的查询串不出现。
    await expect(browserSlotItems(page)).toHaveCount(1);
    await expect(browserRoot(page)).not.toContainText('token=secret');
    await more.focus();
    await page.keyboard.press('Enter');
    const menu = page.getByRole('menu', { name: '其他问题', exact: true });
    await expect(menu).toBeVisible();
    await expect(menu.getByRole('menuitem')).toContainText('已拦截导航：http://blocked.example/path');
    await expectNativePage(app, page, false);
    await page.keyboard.press('Escape');
    await expect(menu).toHaveCount(0);
    await expect(more).toBeFocused();
    await expectNativePage(app, page, true);

    // 槽里的行出现 / 消失改变 .preview-host 尺寸：原生视图的 bounds 跟着对齐。
    const aligned = async () => {
      const host = await page.locator('.preview-host:visible').boundingBox();
      const bounds = (await previewInfo(app)).bounds;
      return (
        !!host &&
        [host.x - bounds.x, host.y - bounds.y, host.width - bounds.width, host.height - bounds.height].every((d) => Math.abs(d) <= 1)
      );
    };
    await expect.poll(aligned).toBe(true);
    const withSlot = (await page.locator('.preview-host:visible').boundingBox())!;
    await page.getByLabel('页面地址').fill('wsl-demo://taskflow/index.html');
    await page.getByLabel('页面地址').press('Enter');
    await expect(browserSlotItems(page)).toHaveCount(0);
    await expect.poll(aligned).toBe(true);
    expect((await page.locator('.preview-host:visible').boundingBox())!.height).toBeGreaterThan(withSlot.height);
  } finally {
    await app.close();
  }
});

test('网页：页面控制断开——「重新附着」可见，Tab 可达，Enter 触发后问题消失', async () => {
  const { app, page } = await launchApp();
  try {
    await expect.poll(async () => (await previewInfo(app)).url).toBe('wsl-demo://taskflow/index.html');
    await browserActionByCommand(page, 'reattach');
    await onPreview(app, 'detach-cdp');
    const item = browserSlotItems(page).filter({ hasText: '页面控制已断开' });
    await expect(item).toBeVisible();
    await expect(item).toHaveAttribute('data-status-channel', 'problem');
    const reattach = item.getByRole('button', { name: '重新附着', exact: true });
    await expect(reattach).toBeVisible();
    // 槽在工具栏之后、内容之前：从「更多网页操作」Tab 一次即到。
    await moreTrigger(page).focus();
    await page.keyboard.press('Tab');
    await expect(reattach).toBeFocused();
    await page.keyboard.press('Enter');
    await expect(item).toHaveCount(0);
  } finally {
    await app.close();
  }
});

test('网页：选择中两个弹出层触发器禁用（不会因让位而取消点选）；取消选择后恢复可用', async () => {
  const { app, page } = await launchApp();
  try {
    await openBrowserMenu(page, '采集到会话');
    await captureDialog(page).getByLabel('关联会话').selectOption({ label: 'Agent 会话' });
    await captureDialog(page).getByRole('button', { name: '采集到关联会话', exact: true }).click();
    const picking = page.getByRole('button', { name: '选择中 · Esc 取消', exact: true });
    await expect(picking).toBeVisible();
    await expect(captureDialog(page)).toHaveCount(0);
    const item = browserSlotItems(page).filter({ hasText: '选择中 · Esc 取消' });
    await expect(item).toBeVisible();
    await expect(item).toHaveAttribute('data-status-channel', 'persistent');
    for (const trigger of [captureTrigger(page), moreTrigger(page)]) {
      await expect(trigger).toBeDisabled();
      await expect(trigger).toHaveAttribute('title', '选择中，先取消选择');
      await trigger.click({ force: true });
    }
    await expect(captureDialog(page)).toHaveCount(0);
    await expect(moreMenu(page)).toHaveCount(0);
    // 点选没有被取消：仍在选择中，原生网页仍可见。
    await expect(item).toBeVisible();
    expect((await activeWebResource(page)).resource.preview!.picking).toBe(true);
    await expectNativePage(app, page, true);

    await picking.click();
    await expect.poll(async () => (await activeWebResource(page)).resource.preview!.picking).toBe(false);
    await expect(item).toHaveCount(0);
    await expect(captureTrigger(page)).toBeEnabled();
    await expect(moreTrigger(page)).toBeEnabled();
    await expect(moreTrigger(page)).toHaveAttribute('title', '更多网页操作');
  } finally {
    await app.close();
  }
});

test('网页：「新建关联会话」不关闭弹出层，完成后 select 指向新会话且焦点留在弹出层内', async () => {
  const { app, page } = await launchApp();
  try {
    await openBrowserMenu(page, '采集到会话');
    const dialog = captureDialog(page);
    const select = dialog.getByLabel('关联会话');
    const before = await select.locator('option').count();
    await dialog.getByRole('button', { name: '新建关联会话', exact: true }).click();
    await expect(select.locator('option')).toHaveCount(before + 1);
    await expect(dialog).toBeVisible();
    await expect(select).not.toHaveValue('');
    await expect(select).toBeFocused();
    await expect(dialog.getByRole('button', { name: '采集到关联会话', exact: true })).toBeEnabled();
  } finally {
    await app.close();
  }
});

test('网页截图：白 / 暗 / 暖 × 1440 / 960，正常与异常（加载失败 + 已拦截导航）；两个弹出层展开态', async () => {
  test.setTimeout(240000);
  const dir = path.join(screensDir, 'status-surface');
  await mkdir(dir, { recursive: true });
  for (const state of ['normal', 'abnormal'] as const) {
    const { app, page } = await launchApp();
    try {
      await resize(app, page, 1440, 900);
      if (state === 'abnormal') {
        await failPageLoad(app, page);
        await onPreview(app, 'block-navigation');
        await expect(browserSlotItems(page).getByRole('button', { name: '另有 1 项', exact: true })).toBeVisible();
      }
      for (const theme of ['light', 'dark', 'warm'] as const) {
        await resize(app, page, 1440, 900);
        await expect(page.getByRole('navigation', { name: 'Workshop 导航' })).toBeVisible();
        await setWorkspaceTheme(page, theme);
        for (const width of [1440, 960]) {
          await resize(app, page, width, width === 1440 ? 900 : 700);
          await expect(browserRoot(page)).toBeVisible();
          if (state === 'abnormal') await expect(browserSlotItems(page).filter({ hasText: '页面加载失败' })).toBeVisible();
          else await expect(browserSlotItems(page)).toHaveCount(0);
          await shot(page, `status-surface/browser-${state}-${theme}-${width}`);
          if (state === 'normal' && theme === 'light') {
            for (const [name, trigger, popup] of [
              ['capture', '采集到会话', captureDialog(page)],
              ['more', '更多网页操作', moreMenu(page)],
            ] as const) {
              await openBrowserMenu(page, trigger);
              await expect(popup).toBeVisible();
              await shot(page, `status-surface/browser-popup-${name}-${theme}-${width}`);
              await page.keyboard.press('Escape');
              await expect(popup).toHaveCount(0);
            }
          }
        }
      }
    } finally {
      await app.close();
    }
  }
});

/* ---------- 修复复验：组合可见性 ---------- */

test('修复复验：AI 操控中 + 页面加载失败 + 已拦截导航同时成立——控制提示与失败文本同时可见，另有 1 项展开看到拦截导航', async () => {
  const { app, page } = await launchApp();
  try {
    await mkdir(path.join(screensDir, 'status-surface'), { recursive: true });
    await resize(app, page, 1440, 900);
    await expect.poll(async () => (await previewInfo(app)).url).toBe('wsl-demo://taskflow/index.html');
    await installStatusShim(app);
    await setStatusShim(app, {
      agentControl: { state: 'active', runId: 'run-status-combo-active', since: '2026-10-12T01:00:00.000Z', lastAction: '点击提交按钮' },
    });
    await failPageLoad(app, page);
    await onPreview(app, 'block-navigation');
    const control = browserSlotItems(page).filter({ hasText: 'AI 正在操控此页面' });
    const failure = browserSlotItems(page).filter({ hasText: '页面加载失败' });
    await expect(control).toBeVisible();
    await expect(control).toHaveAttribute('data-status-channel', 'persistent');
    await expect(control).toHaveAttribute('data-testid', 'agent-control-active');
    await expect(control).toContainText('点击提交按钮');
    await expect(failure).toBeVisible();
    await expect(failure).toHaveAttribute('data-status-channel', 'problem');
    const more = browserSlotItems(page).getByRole('button', { name: '另有 1 项', exact: true });
    await expect(more).toBeVisible();
    await more.focus();
    await page.keyboard.press('Enter');
    const menu = page.getByRole('menu', { name: '其他问题', exact: true });
    await expect(menu).toBeVisible();
    await expect(menu.getByRole('menuitem')).toContainText('已拦截导航：http://blocked.example/path');
    await shot(page, 'status-surface/combo-ai-loaderror-blockednav-1440');
    await page.keyboard.press('Escape');
    await expect(menu).toHaveCount(0);
    await resize(app, page, 960, 700);
    await expect(control).toBeVisible();
    await expect(failure).toBeVisible();
    await expect(more).toBeVisible();
    await shot(page, 'status-surface/combo-ai-loaderror-blockednav-960');
  } finally {
    await app.close();
  }
});

test('修复复验：已暂停 AI + 页面控制断开——「允许 AI 继续」与「重新附着」同时可见、真实 Tab 各到达、Enter 下发既有命令', async () => {
  const { app, page } = await launchApp();
  try {
    await mkdir(path.join(screensDir, 'status-surface'), { recursive: true });
    await resize(app, page, 1440, 900);
    await expect.poll(async () => (await previewInfo(app)).url).toBe('wsl-demo://taskflow/index.html');
    await browserActionByCommand(page, 'reattach');
    const { workspaceId, resource } = await activeWebResource(page);
    await installStatusShim(app);
    await setStatusShim(app, {
      agentControl: {
        state: 'paused_by_user',
        runId: 'run-status-combo-paused',
        since: '2026-10-12T01:05:00.000Z',
        lastAction: '填写表单',
      },
    });
    await onPreview(app, 'detach-cdp');
    const paused = browserSlotItems(page).filter({ hasText: '已暂停 AI 操控' });
    const detached = browserSlotItems(page).filter({ hasText: '页面控制已断开' });
    await expect(paused).toBeVisible();
    await expect(paused).toHaveAttribute('data-status-channel', 'persistent');
    await expect(paused).toHaveAttribute('data-testid', 'agent-control-paused');
    await expect(detached).toBeVisible();
    await expect(detached).toHaveAttribute('data-status-channel', 'problem');
    const resume = paused.getByRole('button', { name: '允许 AI 继续', exact: true });
    const reattach = detached.getByRole('button', { name: '重新附着', exact: true });
    await expect(resume).toBeVisible();
    await expect(reattach).toBeVisible();
    await shot(page, 'status-surface/combo-paused-detached-1440');
    await resize(app, page, 960, 700);
    await expect(paused).toBeVisible();
    await expect(detached).toBeVisible();
    await shot(page, 'status-surface/combo-paused-detached-960');
    await resize(app, page, 1440, 900);
    await moreTrigger(page).focus();
    await page.keyboard.press('Tab');
    await expect(resume).toBeFocused();
    await page.keyboard.press('Enter');
    await page.keyboard.press('Tab');
    await expect(reattach).toBeFocused();
    await page.keyboard.press('Enter');
    await expect(detached).toHaveCount(0);
    expect(await statusShimBrowserActions(app)).toEqual([
      { action: 'resumeAgent', workspaceId, resourceId: resource.resourceId },
      { action: 'reattach', workspaceId, resourceId: resource.resourceId },
    ]);
    await setStatusShim(app, { agentControl: null });
    await pushWorkbenchSnapshot(page);
    await expect(browserSlotItems(page)).toHaveCount(0);
  } finally {
    await app.close();
  }
});

test('修复复验：问题通道另有 2 项——真实键盘展开菜单、方向键移动、Esc 回焦触发器、原生网页让位恢复', async () => {
  const { app, page } = await launchApp();
  try {
    await mkdir(path.join(screensDir, 'status-surface'), { recursive: true });
    await resize(app, page, 1440, 900);
    await expect(browserSlotItems(page)).toHaveCount(0);
    await failPageLoad(app, page);
    await onPreview(app, 'block-navigation');
    await browserActionByCommand(page, 'reattach');
    await onPreview(app, 'detach-cdp');
    const failure = browserSlotItems(page).filter({ hasText: '页面加载失败' });
    await expect(failure).toBeVisible();
    const more = browserSlotItems(page).getByRole('button', { name: '另有 2 项', exact: true });
    await expect(more).toBeVisible();
    await moreTrigger(page).focus();
    await page.keyboard.press('Tab');
    await expect(failure.getByRole('button', { name: '重新加载', exact: true })).toBeFocused();
    await page.keyboard.press('Tab');
    await expect(more).toBeFocused();
    await page.keyboard.press('Enter');
    const menu = page.getByRole('menu', { name: '其他问题', exact: true });
    await expect(menu).toBeVisible();
    const items = menu.getByRole('menuitem');
    await expect(items).toHaveCount(2);
    await expect(items.nth(0)).toContainText('页面控制已断开');
    await expect(items.nth(1)).toContainText('已拦截导航：http://blocked.example/path');
    await expect(items.nth(0)).toBeFocused();
    await expectNativePage(app, page, false);
    await page.keyboard.press('ArrowDown');
    await expect(items.nth(1)).toBeFocused();
    await page.keyboard.press('ArrowUp');
    await expect(items.nth(0)).toBeFocused();
    await shot(page, 'status-surface/combo-problem-more-1440');
    await page.keyboard.press('Escape');
    await expect(menu).toHaveCount(0);
    await expect(more).toBeFocused();
    await expectNativePage(app, page, true);
    await resize(app, page, 960, 700);
    await expect(failure).toBeVisible();
    await expect(more).toBeVisible();
    await shot(page, 'status-surface/combo-problem-more-960');
  } finally {
    await app.close();
  }
});

/* ---------- 会话 ---------- */

const sessionRegion = (page: Page) => page.getByRole('region', { name: 'Agent 会话内容', exact: true });
const sessionViews = (page: Page) => sessionRegion(page).getByRole('navigation', { name: '会话视图', exact: true });
const runRecordTrigger = (page: Page) => sessionViews(page).getByRole('button', { name: '运行记录', exact: true });
const runRecordMenu = (page: Page) => sessionRegion(page).getByRole('menu', { name: '运行记录', exact: true });
const sessionSlotItems = (page: Page) => sessionRegion(page).locator('.status-slot .status-item');
const sessionMessageBox = (page: Page) => sessionRegion(page).getByRole('textbox', { name: '会话消息', exact: true });
const RESTORED = '历史已恢复；新执行不会自动延续旧模型上下文。';

async function openSessionTab(page: Page) {
  await page.getByRole('navigation', { name: '空间标签' }).getByRole('button', { name: 'Agent 会话', exact: true }).click();
}

/** 用 sbx 夹具跑完一次会话运行（不调用模型）。 */
async function completeSessionRun(page: Page, text: string) {
  await openSessionTab(page);
  await sessionMessageBox(page).fill(text);
  await sessionRegion(page).getByRole('button', { name: '发送', exact: true }).click();
  await expect.poll(async () => (await workspaceSnapshot(page)).workspaces[0]!.runs.at(-1)?.state).toBe('completed');
}

/**
 * 夹具无法制造真实的「取消中 + App 数据操作待确认」（需要 live 的数据网关，见 app-control-data-cancel-live.spec.ts）。
 * 这里在 Main 的 IPC 出口把最新一条 run 的快照改写成该状态，只用来验证会话状态条的呈现与键盘；
 * 取消 / 清理的业务判定不在本用例范围。reconcileRunCleanup 被拦截计数，不进入真实 Main。
 */
async function installCleanupShim(app: ElectronApplication) {
  await app.evaluate(({ ipcMain, BrowserWindow }) => {
    const host = globalThis as unknown as { cleanupShim: Shim };
    type Shim = { active: boolean; reconciling: boolean; reconciles: number; reconcileRunIds: string[] };
    const shim: Shim = (host.cleanupShim = {
      active: false,
      reconciling: false,
      reconciles: 0,
      reconcileRunIds: [],
    });
    type Snapshot = { workspaces: Array<{ runs: Array<Record<string, unknown>> }> };
    const transform = <T extends Snapshot>(snapshot: T): T => {
      if (!shim.active) return snapshot;
      const next = structuredClone(snapshot);
      for (const workspace of next.workspaces) {
        const run = workspace.runs.at(-1);
        if (run)
          Object.assign(run, {
            state: 'cancelling',
            endedAt: null,
            cleanupPending: true,
            appCleanupPending: true,
            cleanupRetryAvailable: true,
            cleanupReconciling: shim.reconciling,
            executorState: { state: 'idle', cleanupPending: false },
          });
      }
      return next;
    };
    type Handler = (event: Electron.IpcMainInvokeEvent, request?: { type?: string }) => Promise<unknown>;
    const handlers = (ipcMain as unknown as { _invokeHandlers: Map<string, Handler> })._invokeHandlers;
    const get = handlers.get('workbench:get-snapshot')!;
    const command = handlers.get('workbench:command')!;
    ipcMain.removeHandler('workbench:get-snapshot');
    ipcMain.handle('workbench:get-snapshot', async (event) => transform((await get(event)) as Snapshot));
    ipcMain.removeHandler('workbench:command');
    ipcMain.handle('workbench:command', async (event, request) => {
      if (request?.type === 'reconcileRunCleanup') {
        shim.reconciles++;
        shim.reconcileRunIds.push((request as unknown as { runId: string }).runId);
        shim.reconciling = true;
        return { ok: true, snapshot: transform((await get(event)) as Snapshot) };
      }
      const result = (await command(event, request)) as { snapshot: Snapshot };
      return { ...result, snapshot: transform(result.snapshot) };
    });
    const contents = BrowserWindow.getAllWindows()[0]!.webContents;
    const send = contents.send.bind(contents);
    contents.send = ((channel: string, ...args: Array<{ snapshot?: Snapshot }>) => {
      const payload = args[0];
      if (channel === 'workbench:event' && payload?.snapshot) return send(channel, { ...payload, snapshot: transform(payload.snapshot) });
      return send(channel, ...args);
    }) as typeof contents.send;
  });
}
const setCleanupShim = (app: ElectronApplication, state: { active?: boolean; reconciling?: boolean }) =>
  app.evaluate((_electron, next) => {
    const host = globalThis as unknown as { cleanupShim: { active: boolean; reconciling: boolean } };
    Object.assign(host.cleanupShim, next);
  }, state);

test('会话「运行记录 ⌄」：视图收为五项，Tab 到触发器、Enter 打开，方向键 / Home / End 移动，Esc 回到触发器；原生网页让位后恢复', async () => {
  const { app, page } = await launchApp({ sbxBin });
  try {
    await resize(app, page, 1440, 900);
    // 分屏后网页窗格留在旁边：菜单展开期间原生网页必须让位。
    await page.getByRole('button', { name: '左右分屏', exact: true }).click();
    await completeSessionRun(page, '运行记录菜单用例');
    await expectNativePage(app, page, true);

    await expect(sessionViews(page).getByRole('button')).toHaveText(['对话', '任务', '上下文', '检查', '运行记录 ⌄']);
    for (const name of ['日志', 'diff', '报告']) await expect(sessionViews(page).getByRole('button', { name, exact: true })).toHaveCount(0);

    const trigger = runRecordTrigger(page);
    await sessionViews(page).getByRole('button', { name: '检查', exact: true }).focus();
    await page.keyboard.press('Tab');
    await expect(trigger).toBeFocused();
    await expect(trigger).toHaveAttribute('aria-expanded', 'false');
    await expect(trigger).toHaveAttribute('aria-haspopup', 'menu');
    await page.keyboard.press('Enter');
    const menu = runRecordMenu(page);
    await expect(menu).toBeVisible();
    await expect(trigger).toHaveAttribute('aria-expanded', 'true');
    await expect(menu.getByRole('menuitem')).toHaveText(['日志', 'diff', '报告']);
    await expectNativePage(app, page, false);

    const item = (name: string) => menu.getByRole('menuitem', { name, exact: true });
    await expect(item('日志')).toBeFocused();
    await page.keyboard.press('ArrowDown');
    await expect(item('diff')).toBeFocused();
    await page.keyboard.press('End');
    await expect(item('报告')).toBeFocused();
    await page.keyboard.press('ArrowDown');
    await expect(item('日志')).toBeFocused();
    await page.keyboard.press('ArrowUp');
    await expect(item('报告')).toBeFocused();
    await page.keyboard.press('Home');
    await expect(item('日志')).toBeFocused();
    await shot(page, 'status-surface/session-menu-open');

    await page.keyboard.press('Escape');
    await expect(menu).toHaveCount(0);
    await expect(trigger).toBeFocused();
    await expect(trigger).toHaveAttribute('aria-expanded', 'false');
    await expectNativePage(app, page, true);

    // 触发器上按 ArrowDown 同样展开；选择菜单项后菜单关闭、焦点回到触发器、所选视图显示。
    await page.keyboard.press('ArrowDown');
    await expect(menu).toBeVisible();
    await page.keyboard.press('ArrowDown');
    await expect(item('diff')).toBeFocused();
    await page.keyboard.press('Enter');
    await expect(menu).toHaveCount(0);
    await expect(trigger).toBeFocused();
    await expect(sessionRegion(page).getByRole('region', { name: '运行详情' })).toContainText('真实 diff 尚未记录');
    await expectNativePage(app, page, true);
    // 再次展开时从当前项开始，并标出当前项。
    await page.keyboard.press('Enter');
    await expect(menu).toBeVisible();
    await expect(item('diff')).toBeFocused();
    await expect(item('diff')).toHaveAttribute('aria-current', 'true');
    // 点击外部同样关闭并让原生网页恢复。
    await sessionViews(page).getByRole('button', { name: '对话', exact: true }).click();
    await expect(menu).toHaveCount(0);
    await expectNativePage(app, page, true);
  } finally {
    await app.close();
  }
});

test('会话检查页：执行 / 检查 / 审阅是中文 label + StatusDot，「检查无法执行」在问题通道可见，没有英文原始枚举', async () => {
  const { app, page } = await launchApp({ sbxBin });
  try {
    await resize(app, page, 1440, 900);
    await completeSessionRun(page, '检查页状态用例');
    const region = sessionRegion(page);
    await region.getByRole('button', { name: '检查', exact: true }).click();
    const runState = region.locator('[data-status-key$=":state"][data-status="run:ok"]');
    await expect(runState).toBeVisible();
    await expect(runState).toHaveText('执行完成');
    await expect(runState.locator('.shape-dot')).toBeVisible();
    const notChecked = region.locator('[data-status="validation:idle"]');
    await expect(notChecked).toBeVisible();
    await expect(notChecked).toHaveText('尚未检查');
    await expect(region.locator('[data-status="review:idle"]')).toHaveText('尚未审阅');
    // 无问题时状态槽高度为 0。
    await expect(sessionSlotItems(page)).toHaveCount(0);

    await region.getByRole('button', { name: '运行检查', exact: true }).click();
    const problem = sessionSlotItems(page).filter({ hasText: '检查无法执行' });
    await expect(problem).toBeVisible();
    await expect(problem).toHaveAttribute('data-status-channel', 'problem');
    await expect(problem.getByRole('alert')).toBeVisible();
    // 原因是可见的 detail，不只在悬停里。
    await expect(problem).toContainText('独立检查适配器尚未接入');
    // 页内是记录：原因在检查卡片里同样无条件可见（与槽里的告警各一处）。
    await expect(region.locator('.version-card').getByText('独立检查适配器尚未接入；Agent 文本不能作为检查结果')).toBeVisible();
    await expect(region.locator('[data-status="validation:ok"]')).toHaveCount(0);
    await expect(region.getByRole('button', { name: '接受结果', exact: true })).toBeDisabled();
    // 检查页的页面文字不含英文原始枚举。
    await expect(region).not.toContainText(/\b(not_run|blocked|completed|passed|cancelled|running|failed|unknown|stale)\b/);
    // 任务历史页复用同一组件：检查无法执行的原因同样可见。
    await workshopNavigate(page, '任务');
    await page.getByRole('button', { name: /^运行 · / }).click();
    await page.getByRole('button', { name: '报告', exact: true }).click();
    const details = page.getByRole('region', { name: '运行详情' });
    await expect(details.getByText('独立检查适配器尚未接入；Agent 文本不能作为检查结果')).toBeVisible();
    await expect(details.locator('[data-status="validation:degraded"]')).toHaveText('检查无法执行');
  } finally {
    await app.close();
  }
});

test('会话输入区：可访问名称仍是「会话消息」，「发送到 · …」是描述，快捷键说明在发送按钮 title', async () => {
  const { app, page } = await launchApp({ sbxBin });
  try {
    await openSessionTab(page);
    const region = sessionRegion(page);
    await expect(sessionMessageBox(page)).toBeVisible();
    await expect(region.getByLabel('会话消息')).toHaveCount(1);
    await expect(sessionMessageBox(page)).toHaveAccessibleDescription(/^发送到 · TaskFlow \/ Agent 会话 \/ Codex CLI$/);
    await expect(region.locator('.workspace-composer label')).toHaveCount(0);
    const send = region.getByRole('button', { name: '发送', exact: true });
    await expect(send).toHaveAttribute('title', 'Enter 发送 · Shift+Enter 换行 · 草稿按会话保存');
    // 不再常驻的两行说明：沙箱 / 状态行与快捷键文字。
    await expect(region.getByText(/沙箱由服务决定/)).toHaveCount(0);
    await expect(region.getByText('Enter 发送 · Shift+Enter 换行 · 草稿按会话保存')).toHaveCount(0);
  } finally {
    await app.close();
  }
});

test('会话历史选择：执行记录用中文状态；选择历史后现场适用性显示「历史采集」，回到最新后恢复', async () => {
  const { app, page } = await launchApp({ sbxBin });
  try {
    await completeSessionRun(page, '历史选择用例');
    const region = sessionRegion(page);
    await region.getByRole('button', { name: '上下文', exact: true }).click();
    await expect(region).toContainText('现场适用性：未知');
    await region.getByRole('button', { name: '检查', exact: true }).click();
    const select = region.getByLabel('执行记录');
    await expect(select.locator('option')).toHaveCount(2);
    await expect(select.locator('option').nth(1)).toContainText('执行完成');
    await expect(select).not.toContainText(/completed/);
    await select.selectOption({ index: 1 });
    await region.getByRole('button', { name: '上下文', exact: true }).click();
    await expect(region.locator('[data-status-key$=":applicability"]')).toHaveText('现场适用性：历史采集（不表示当前现场）');
    await region.getByRole('button', { name: '检查', exact: true }).click();
    await select.selectOption({ index: 0 });
    await region.getByRole('button', { name: '上下文', exact: true }).click();
    await expect(region.locator('[data-status-key$=":applicability"]')).toHaveText('现场适用性：未知');
    await expect(region).not.toContainText('历史采集');
  } finally {
    await app.close();
  }
});

test('会话「历史已恢复」：重启后在提示通道可见（带句号），与会话交互后消失', async () => {
  let { app, page } = await launchApp({ sbxBin });
  const profile = await app.evaluate(({ app: electronApp }) => electronApp.getPath('userData'));
  try {
    await completeSessionRun(page, '重启历史用例');
    await app.close();
    ({ app, page } = await launchApp({ sbxBin, userData: profile }));
    await openSessionTab(page);
    const notice = sessionSlotItems(page).filter({ hasText: RESTORED });
    await expect(notice).toBeVisible();
    await expect(page.getByText(RESTORED)).toBeVisible();
    await expect(notice).toHaveAttribute('data-status-channel', 'notice');
    await expect(notice.getByRole('button', { name: '知道了', exact: true })).toBeVisible();
    await sessionMessageBox(page).click();
    await expect(notice).toHaveCount(0);
  } finally {
    await app.close();
  }
});

test('会话状态条：取消中与「App 数据操作仍待确认」同时可见；「重新核对」Tab 可达、核对中禁用；状态变化不抢焦点', async () => {
  const { app, page } = await launchApp({ sbxBin });
  try {
    await resize(app, page, 1440, 900);
    await completeSessionRun(page, '清理待确认用例');
    await installCleanupShim(app);
    const box = sessionMessageBox(page);
    await box.click();
    await expect(sessionSlotItems(page)).toHaveCount(0);
    await setCleanupShim(app, { active: true });
    await box.fill('触发一次快照下发');

    const cancelling = sessionSlotItems(page).filter({ hasText: '正在取消并核实退出…' });
    const pending = sessionSlotItems(page).filter({ hasText: '模型已停止，App 数据操作仍待确认' });
    await expect(cancelling).toBeVisible();
    await expect(pending).toBeVisible();
    await expect(cancelling).toHaveAttribute('data-status-channel', 'persistent');
    await expect(pending).toHaveAttribute('data-status-channel', 'persistent');
    // 状态变化不抢走输入框的焦点；取消已在进行，不再提供「取消回复」。
    await expect(box).toBeFocused();
    await expect(sessionRegion(page).getByRole('button', { name: '取消回复', exact: true })).toHaveCount(0);
    await shot(page, 'status-surface/session-cancelling-pending');

    // 状态槽在输入区之前：Shift+Tab 从输入框回到「重新核对」。
    const retry = sessionRegion(page).getByRole('button', { name: '重新核对', exact: true });
    await expect(retry).toBeVisible();
    await expect(retry).toBeEnabled();
    await page.keyboard.press('Shift+Tab');
    await expect(retry).toBeFocused();
    await page.keyboard.press('Enter');
    await expect(retry).toBeDisabled();
    // 核对中两条都保持可见；禁用的按钮再按键不会重复下发。
    await expect(cancelling).toBeVisible();
    await expect(pending).toBeVisible();
    await page.keyboard.press('Enter');
    expect(await app.evaluate(() => (globalThis as unknown as { cleanupShim: { reconciles: number } }).cleanupShim.reconciles)).toBe(1);
    // 拦截到的命令确实针对最新一条运行。
    const latestRunId = (await workspaceSnapshot(page)).workspaces[0]!.runs.at(-1)!.runId;
    expect(
      await app.evaluate(() => (globalThis as unknown as { cleanupShim: { reconcileRunIds: string[] } }).cleanupShim.reconcileRunIds),
    ).toEqual([latestRunId]);

    // 事实消失（核对完成）后两条一起消失。
    await setCleanupShim(app, { active: false, reconciling: false });
    await box.fill('核对完成');
    await expect(sessionSlotItems(page)).toHaveCount(0);
  } finally {
    await app.close();
  }
});

test('会话截图：白 / 暗 / 暖 × 1440 / 960，正常（执行完成）与异常（检查无法执行）', async () => {
  test.setTimeout(240000);
  const dir = path.join(screensDir, 'status-surface');
  await mkdir(dir, { recursive: true });
  for (const state of ['normal', 'abnormal'] as const) {
    const { app, page } = await launchApp({ sbxBin });
    try {
      await resize(app, page, 1440, 900);
      await completeSessionRun(page, '截图用例');
      await sessionRegion(page).getByRole('button', { name: '检查', exact: true }).click();
      if (state === 'abnormal') {
        await sessionRegion(page).getByRole('button', { name: '运行检查', exact: true }).click();
        await expect(sessionSlotItems(page).filter({ hasText: '检查无法执行' })).toBeVisible();
      }
      for (const theme of ['light', 'dark', 'warm'] as const) {
        await resize(app, page, 1440, 900);
        await expect(page.getByRole('navigation', { name: 'Workshop 导航' })).toBeVisible();
        await setWorkspaceTheme(page, theme);
        for (const width of [1440, 960]) {
          await resize(app, page, width, width === 1440 ? 900 : 700);
          await expect(sessionRegion(page)).toBeVisible();
          await sessionRegion(page).getByRole('button', { name: '检查', exact: true }).click();
          if (state === 'abnormal') await expect(sessionSlotItems(page).filter({ hasText: '检查无法执行' })).toBeVisible();
          else {
            await expect(sessionRegion(page).locator('[data-status="run:ok"]')).toBeVisible();
            await expect(sessionSlotItems(page)).toHaveCount(0);
          }
          await shot(page, `status-surface/session-${state}-${theme}-${width}`);
        }
      }
    } finally {
      await app.close();
    }
  }
});

test('会话对话视图：状态点的悬停含对话的沙箱 · cwd（不新增可见文字）', async () => {
  const { app, page } = await launchApp({ sbxBin });
  try {
    await completeSessionRun(page, '对话悬停用例');
    await sessionRegion(page).getByRole('button', { name: '对话', exact: true }).click();
    const dot = sessionRegion(page).locator('.session-run-state [data-status]');
    await expect(dot).toBeVisible();
    await expect(dot).toHaveAttribute('title', new RegExp(`Codex CLI · .*${fixtureSandbox}`));
    await expect(dot).toHaveText('执行完成');
    await expect(sessionRegion(page).getByText(new RegExp(fixtureSandbox))).toHaveCount(0);
  } finally {
    await app.close();
  }
});

test('会话状态槽「取消采集」：采集进行中可见，点击后采集取消、条目消失', async () => {
  const { app, page } = await launchApp();
  try {
    await resize(app, page, 1440, 900);
    await page.getByRole('button', { name: '左右分屏', exact: true }).click();
    await openSessionTab(page);
    const region = sessionRegion(page);
    await region.getByRole('button', { name: '任务', exact: true }).click();
    await region.getByLabel('附加目标（明确选择）').selectOption({ label: 'TaskFlow 预览' });
    await region.getByRole('button', { name: '采集目标元素', exact: true }).click();
    const item = sessionSlotItems(page).filter({ hasText: '正在采集…' });
    await expect(item).toBeVisible();
    const cancel = item.getByRole('button', { name: '取消采集', exact: true });
    await expect(cancel).toBeVisible();
    await cancel.click();
    await expect.poll(async () => (await workspaceSnapshot(page)).workspaces[0]!.sessions[0]!.captureRequest?.state).toBe('cancelled');
    await expect(item).toHaveCount(0);
  } finally {
    await app.close();
  }
});

test('会话：执行中点「取消回复」后焦点交给输入框，不落到 body', async () => {
  const { app, page } = await launchApp({ sbxBin });
  try {
    await openSessionTab(page);
    // 让 fixture 持续执行直到取消，避免自然完成在点击前卸载「取消回复」按钮。
    await sessionMessageBox(page).fill('[slow] 取消焦点用例');
    await sessionRegion(page).getByRole('button', { name: '发送', exact: true }).click();
    const cancel = sessionRegion(page).getByRole('button', { name: '取消回复', exact: true });
    await expect(cancel).toBeVisible();
    await cancel.click();
    await expect(cancel).toHaveCount(0);
    await expect(sessionMessageBox(page)).toBeFocused();
    expect(await page.evaluate(() => document.activeElement?.tagName)).not.toBe('BODY');
  } finally {
    await app.close();
  }
});

test('会话：「历史已恢复」提示在场时，一次点击「重新核对」即生效（确认不吞首次点击）', async () => {
  let { app, page } = await launchApp({ sbxBin });
  const profile = await app.evaluate(({ app: electronApp }) => electronApp.getPath('userData'));
  try {
    await completeSessionRun(page, '提示在场点击用例');
    await app.close();
    ({ app, page } = await launchApp({ sbxBin, userData: profile }));
    await openSessionTab(page);
    const notice = sessionSlotItems(page).filter({ hasText: RESTORED });
    await expect(notice).toBeVisible();
    await installCleanupShim(app);
    await setCleanupShim(app, { active: true });
    // fill 只聚焦输入框、不点击，不会确认提示；它触发一次快照下发。
    await sessionMessageBox(page).fill('触发一次快照下发');
    const retry = sessionRegion(page).getByRole('button', { name: '重新核对', exact: true });
    await expect(retry).toBeVisible();
    await expect(notice).toBeVisible();
    await retry.click();
    // 提示消失（槽高度变化）不影响这一次点击：命令已下发，按钮进入核对中。
    await expect(notice).toHaveCount(0);
    await expect(retry).toBeDisabled();
    expect(await app.evaluate(() => (globalThis as unknown as { cleanupShim: { reconciles: number } }).cleanupShim.reconciles)).toBe(1);
  } finally {
    await app.close();
  }
});

/* ---------- 输入区（Composer）与首页 ---------- */

const homeRegion = (page: Page) => page.getByRole('region', { name: '混合输入', exact: true });
const HOME_TEXTBOX = '发送到 · 个人 · 默认 Agent / 首页对话 / 默认 Agent';
const HOME_NOTES = ['不读取其他空间', '可从个人收藏中选择明确的正文版本作为参考。'];
const SHORTCUTS = 'Enter 发送 · Shift+Enter 换行 · 草稿按会话保存';

/** sr-only 文本在 DOM 中存在、盒子不超过 1px：对用户不可见，对读屏可用。 */
async function expectVisuallyHidden(locator: Locator) {
  await expect(locator).toHaveCount(1);
  const box = await locator.boundingBox();
  expect(box === null || (box.width <= 1 && box.height <= 1)).toBe(true);
}

async function blockHomeSend(page: Page, text: string) {
  const region = homeRegion(page);
  await region.getByRole('radio', { name: '搜索', exact: true }).click();
  // 搜索模式下名称末段随 Harness 变为「搜索」（改动前如此），这里只有一个输入框。
  const input = region.getByRole('textbox');
  await input.fill(text);
  await input.press('Enter');
  await expect(region.locator('.composer-notice')).toBeVisible();
}

test('首页输入区：可访问名称不变；两条说明与快捷键说明不再常驻，改为描述与发送按钮 title', async () => {
  const { app, page } = await launchApp({ codexBin });
  try {
    await workshopNavigate(page, '首页');
    const region = homeRegion(page);
    const input = region.getByRole('textbox', { name: HOME_TEXTBOX, exact: true });
    await expect(input).toBeVisible();
    // 「发送到 · …」label 保留（视觉隐藏），名称与改前一致。
    await expectVisuallyHidden(region.locator('label', { hasText: '发送到 · ' }));
    // 两条说明：不可见，但在输入框的可访问描述里（原文），并作为悬停 title。
    for (const note of HOME_NOTES) {
      await expectVisuallyHidden(region.getByText(note, { exact: true }));
      await expect(input).toHaveAccessibleDescription(new RegExp(note.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')));
    }
    await expect(input).toHaveAttribute('title', HOME_NOTES.join(' '));
    await expect(region.locator('.chip', { hasText: '个人 · 默认 Agent' })).toHaveAttribute('title', HOME_NOTES[0]!);
    // 快捷键说明不在页面文字里，在发送按钮 title；按钮名称仍是「发送」。
    await expect(region.getByText(SHORTCUTS)).toHaveCount(0);
    await expect(region.locator('.composer-hint')).toHaveCount(0);
    const send = region.getByRole('button', { name: '发送', exact: true });
    await expect(send).toBeVisible();
    await expect(send).toHaveAttribute('title', SHORTCUTS);
    // 没有被阻止时没有 notice。
    await expect(region.locator('.composer-notice')).toHaveCount(0);
    // 键盘：Enter 发送，Shift+Enter 换行。
    await input.fill('键盘发送');
    await input.press('Shift+Enter');
    await expect(input).toHaveValue('键盘发送\n');
    await input.press('Backspace');
    await input.press('Enter');
    await expect(region.locator('.message-agent')).toContainText('fixture 回复：键盘发送');
  } finally {
    await app.close();
  }
});

test('首页输入区：发送被阻止时原因显式可见，按钮 title 为阻止原因；改动草稿后提示消失', async () => {
  const { app, page } = await launchApp({ codexBin });
  try {
    await workshopNavigate(page, '首页');
    const region = homeRegion(page);
    await blockHomeSend(page, '被阻止的草稿');
    await expect(region.locator('.composer-notice')).toHaveText('未发送：搜索尚未接入');
    const send = region.getByRole('button', { name: '发送', exact: true });
    await expect(send).toHaveAttribute('title', '搜索尚未接入');
    // 草稿保留；继续输入后提示消失。
    const input = region.getByRole('textbox', { name: '发送到 · 个人 · 默认 Agent / 首页对话 / 搜索', exact: true });
    await expect(input).toHaveValue('被阻止的草稿');
    await input.press('x');
    await expect(region.locator('.composer-notice')).toHaveCount(0);
  } finally {
    await app.close();
  }
});

test('首页空间卡片：有进行中的任务时标题旁出现状态点（文字视觉隐藏），计数文字不变；结束后消失', async () => {
  const { app, page } = await launchApp({ sbxBin });
  try {
    await openSessionTab(page);
    await sessionMessageBox(page).fill('[slow] 首页状态点用例');
    await sessionRegion(page).getByRole('button', { name: '发送', exact: true }).click();
    await expect(sessionRegion(page).getByRole('button', { name: '取消回复', exact: true })).toBeVisible();
    await workshopNavigate(page, '首页');
    const card = page.getByRole('region', { name: '近期空间', exact: true }).locator('.space-card').first();
    const dot = card.locator('.status-dot');
    await expect(dot).toBeVisible();
    await expect(dot.locator('.shape')).toBeVisible();
    await expect(dot).toHaveAttribute('data-status-key', /^run:.+:state$/);
    await expect(dot).toHaveAttribute('data-status-channel', 'persistent');
    await expectVisuallyHidden(dot.locator('.sr-only'));
    await expect(dot.locator('.sr-only')).toHaveText(/正在(启动|执行)…/);
    // 计数文字不变（workspace-migration.spec.ts 依赖）。
    const workspace = (await workspaceSnapshot(page)).workspaces[0]!;
    await expect(card).toContainText(`任务版本数 ${workspace.sessions.reduce((n, s) => n + s.taskVersions.length, 0)}`);
    await expect(card).toContainText(`运行 ${workspace.runs.length}`);
    // 键盘可达：卡片是按钮，名称仍含空间名。
    await card.focus();
    await expect(card).toBeFocused();
    // 取消并核实退出后状态点消失（已取消不是进行中）。
    await workshopNavigate(page, '空间');
    await openSessionTab(page);
    await sessionRegion(page).getByRole('button', { name: '取消回复', exact: true }).click();
    await expect.poll(async () => (await workspaceSnapshot(page)).workspaces[0]!.runs.at(-1)?.state).toBe('cancelled');
    await workshopNavigate(page, '首页');
    await expect(card).toBeVisible();
    await expect(card.locator('.status-dot')).toHaveCount(0);
  } finally {
    await app.close();
  }
});

test('通知与任务历史：检查 / 审阅用中文 label，运行按钮不含英文状态，runId 在 title', async () => {
  const { app, page } = await launchApp({ sbxBin });
  try {
    await completeSessionRun(page, '通知中文状态用例');
    // 检查无法执行（夹具没有独立检查适配器）。
    await sessionRegion(page).getByRole('button', { name: '检查', exact: true }).click();
    await sessionRegion(page).getByRole('button', { name: '运行检查', exact: true }).click();
    await expect(sessionSlotItems(page).filter({ hasText: '检查无法执行' })).toBeVisible();
    const runId = (await workspaceSnapshot(page)).workspaces[0]!.runs.at(-1)!.runId;

    await page.getByRole('button', { name: /^通知 · / }).click();
    const item = page.getByRole('region', { name: '通知' }).locator(`[data-run-id="${runId}"]`);
    await expect(item).toBeVisible();
    await expect(item).toContainText('未读');
    await expect(item).toContainText('检查无法执行 · 尚未审阅');
    await expect(item).not.toContainText(/\b(not_run|passed|blocked|running|failed|completed|accepted|changes_requested)\b/);

    await workshopNavigate(page, '任务');
    const runButton = page.getByRole('button', { name: /^运行 · / });
    await expect(runButton).toBeVisible();
    await expect(runButton).toHaveAttribute('title', runId);
    await expect(runButton).toHaveAccessibleName(/^运行 · .+ 执行完成$/);
    await expect(runButton).not.toContainText(runId);
    await expect(runButton).not.toContainText(/\b(completed|running|failed)\b/);
    await expect(runButton.locator('[data-status="run:ok"]')).toHaveCount(1);
  } finally {
    await app.close();
  }
});

test('首页截图：白 / 暗 / 暖 × 1440 / 960，正常与异常（发送被阻止）', async () => {
  test.setTimeout(240000);
  const dir = path.join(screensDir, 'status-surface');
  await mkdir(dir, { recursive: true });
  for (const state of ['normal', 'abnormal'] as const) {
    const { app, page } = await launchApp({ codexBin });
    try {
      await resize(app, page, 1440, 900);
      for (const theme of ['light', 'dark', 'warm'] as const) {
        await resize(app, page, 1440, 900);
        await setWorkspaceTheme(page, theme);
        for (const width of [1440, 960]) {
          await resize(app, page, width, width === 1440 ? 900 : 700);
          // innerWidth 已变化不代表 React 已切换布局；先确认本轮导航使用的实际模式。
          if (width === 1440) await expect(page.locator('.workshop-docked')).toBeVisible();
          else {
            await expect(page.locator('.workshop-docked')).toHaveCount(0);
            await expect(page.locator('#left-panel-trigger')).toHaveAttribute('aria-expanded', 'false');
          }
          await workshopNavigate(page, '首页');
          const region = homeRegion(page);
          if (state === 'abnormal') await blockHomeSend(page, '被阻止的草稿');
          else {
            await expect(region.getByRole('textbox', { name: HOME_TEXTBOX, exact: true })).toBeVisible();
            await expect(region.locator('.composer-notice')).toHaveCount(0);
          }
          await shot(page, `status-surface/home-${state}-${theme}-${width}`);
        }
      }
    } finally {
      await app.close();
    }
  }
});

/* ---------- 观察与文件 ---------- */

const filesPanel = (page: Page) => page.getByRole('region', { name: '只读文件浏览', exact: true });
const filesSlot = (page: Page) => filesPanel(page).locator('.status-slot');
const filesSlotItems = (page: Page) => filesSlot(page).locator('.status-item');
const filesResult = (page: Page) => filesPanel(page).getByRole('region', { name: '当前文件结果', exact: true });
const FIRST_USE = '仅访问已授权根内的文件，浏览不加入 Agent 会话。';

async function fileRoot() {
  const root = await mkdtemp(path.join(tmpdir(), 'wsl-status-files-'));
  // 大文件：单次读取只覆盖一部分（coverage partial，带续读游标）；小文件：完整覆盖。
  await writeFile(path.join(root, 'big.txt'), 'FILE_STATUS_NONCE_901\n' + '中'.repeat(12000));
  await writeFile(path.join(root, 'small.txt'), 'SMALL_FILE_OK\n');
  return root;
}

async function createFileTab(page: Page, title: string) {
  await page.getByRole('button', { name: '新建标签', exact: true }).click();
  const editor = page.getByRole('dialog', { name: '新建标签' });
  await editor.getByLabel('标签类型').selectOption('file');
  await editor.getByLabel('名称', { exact: true }).fill(title);
  await editor.getByLabel('资源环境').selectOption('local');
  await editor.getByRole('button', { name: '保存', exact: true }).click();
  await expect(filesPanel(page)).toBeVisible();
}

/** 首次说明已关闭后：说明文字不再出现在可见内容里，只剩标题区视觉隐藏的描述（悬停 title / aria-describedby）。 */
async function expectNotesOnlyDescribed(page: Page) {
  await expect(filesPanel(page).getByText('变化提示只覆盖已观察目录')).toHaveClass(/sr-only/);
  await expect(filesPanel(page).getByText('SFTP 不提供 watch')).toHaveCount(0);
  await expect(filesSlotItems(page)).toHaveCount(0);
}

async function readFile(page: Page, name: string) {
  await filesPanel(page).getByLabel('文件路径').fill(name);
  await filesPanel(page).getByRole('button', { name: '读取文件', exact: true }).click();
}

test('文件：首次打开说明是提示通道的 hint，「知道了」（键盘）或窗格交互后消失，重新打开同一标签不再出现', async () => {
  const root = await fileRoot();
  const { app, page } = await launchApp({ observationRoot: root });
  try {
    await resize(app, page, 1440, 900);
    await createFileTab(page, '首次说明文件');
    const panel = filesPanel(page);
    const hint = filesSlotItems(page).filter({ hasText: FIRST_USE });
    await expect(hint).toBeVisible();
    await expect(hint).toHaveAttribute('data-status-channel', 'notice');
    await expect(hint.getByRole('status')).toBeVisible();
    // 变化提示的覆盖范围说明也是同一条 hint 的一部分，不再另起一行常驻。
    await expect(hint).toContainText('变化提示只覆盖已观察目录，未提示不代表内容未变。');
    // 环境名只是标题元数据，不是状态文字。
    await expect(panel.locator('.file-panel-header')).toContainText('本设备');
    // 键盘：Tab 到「知道了」，Enter 关闭。
    const ack = hint.getByRole('button', { name: '知道了', exact: true });
    await ack.focus();
    await expect(ack).toBeFocused();
    await page.keyboard.press('Enter');
    await expect(hint).toHaveCount(0);
    await expectNotesOnlyDescribed(page);
    // 关闭标签（保留后台执行）后重新打开同一标签：说明不再出现。
    const resourceId = (await workspaceSnapshot(page)).workspaces[0]!.resources.find((item) => item.title === '首次说明文件')!.resourceId;
    await page.getByRole('button', { name: '首次说明文件操作', exact: true }).click();
    await page.getByRole('menuitem', { name: '关闭标签（保留后台执行）' }).click();
    await page.getByText('后台资源 / 已关闭标签', { exact: true }).click();
    await page.getByRole('button', { name: '首次说明文件 · 重新打开', exact: true }).click();
    await expect(panel).toBeVisible();
    await expect(page.locator(`[data-status-key="ui:${resourceId}:first-use"]`)).toHaveCount(0);
    await expect(filesSlotItems(page)).toHaveCount(0);
    await expectNotesOnlyDescribed(page);

    // 另一个标签：不点「知道了」，与窗格交互（点击「列出目录」）后同样消失。
    await createFileTab(page, '交互消除文件');
    const second = filesSlotItems(page).filter({ hasText: FIRST_USE });
    await expect(second).toBeVisible();
    await filesPanel(page).getByRole('button', { name: '列出目录', exact: true }).click();
    await expect(second).toHaveCount(0);
    await expect(filesResult(page)).toContainText('small.txt');
  } finally {
    await app.close();
    await rm(root, { recursive: true, force: true });
  }
});

test('文件：从窗格外真实 Tab 进入，首次说明仍在且「知道了」获得焦点；Enter 关闭后焦点落在路径输入框；说明常在描述中可得', async () => {
  const root = await fileRoot();
  const { app, page } = await launchApp({ observationRoot: root });
  try {
    await resize(app, page, 1440, 900);
    await createFileTab(page, '键盘确认文件');
    const hint = filesSlotItems(page).filter({ hasText: FIRST_USE });
    await expect(hint).toBeVisible();
    // 从窗格外（窗格标题栏的最后一个控件）按 Tab 进入：槽内的焦点不算与窗格交互，说明必须仍在。
    await page.getByRole('button', { name: '窗格操作', exact: true }).focus();
    await page.keyboard.press('Tab');
    const ack = hint.getByRole('button', { name: '知道了', exact: true });
    await expect(ack).toBeFocused();
    await expect(hint).toBeVisible();
    // Enter 关闭后焦点落到可预期位置（路径输入框），不落 body。
    await page.keyboard.press('Enter');
    await expect(hint).toHaveCount(0);
    await expect(filesPanel(page).getByLabel('文件路径')).toBeFocused();
    // 同一次 Enter 不会顺势提交路径表单（没有产生任何观察）。
    expect((await workspaceSnapshot(page)).workspaces[0]!.observations).toHaveLength(0);
    // 不变量说明不再常驻，但始终可得：环境名元数据的悬停 title 与 aria-describedby。
    await expectNotesOnlyDescribed(page);
    const env = filesPanel(page).locator('.file-panel-header [aria-describedby]');
    await expect(env).toHaveAttribute('title', /变化提示只覆盖已观察目录，未提示不代表内容未变。/);
    await expect(env).toHaveAccessibleDescription(/仅访问已授权根内的文件，浏览不加入 Agent 会话。.*变化提示只覆盖已观察目录/);
    // SSH 分支（「SFTP 不提供 watch」）与本地分支走同一代码路径（firstUseLabel），只是文案不同；SSH 回环 fixture 成本高，这里不重复建。
  } finally {
    await app.close();
    await rm(root, { recursive: true, force: true });
  }
});

test('文件观察结果：来源折叠区默认收起，Enter / 空格可展开，展开后版本 / 散列可见；覆盖完整只有形状 + 视觉隐藏文字', async () => {
  const root = await fileRoot();
  const { app, page } = await launchApp({ observationRoot: root });
  try {
    await resize(app, page, 1440, 900);
    await createFileTab(page, '来源折叠文件');
    await filesPanel(page).getByRole('button', { name: '列出目录', exact: true }).click();
    await filesPanel(page).getByRole('button', { name: 'small.txt · file', exact: true }).click();
    const current = filesResult(page);
    await expect(current).toContainText('SMALL_FILE_OK');
    // 合同：版本 / 散列可见——折叠区内的文字仍在结果内（textContent），展开即可见。
    await expect(current).toContainText('版本 / 散列');
    const source = current.locator('details.observation-source');
    await expect(source).toBeVisible();
    await expect(source).not.toHaveAttribute('open', '');
    await expect(current.getByText('版本 / 散列')).toBeHidden();
    // 覆盖完整：形状可见，文字只在视觉隐藏文本与悬停里。
    const dot = current.locator('[data-status="observation:ok"]');
    await expect(dot).toBeVisible();
    await expect(dot).toHaveAttribute('title', '覆盖完整');
    await expect(dot.locator('.sr-only')).toHaveText('覆盖完整');
    await expect(current.locator('.status-label')).toHaveCount(0);
    // 稳态不占状态槽：槽里没有这一条（首次说明已被前面的点击确认）。
    await expect(filesSlotItems(page)).toHaveCount(0);
    // 键盘展开 / 收起。
    const summary = source.locator('summary');
    await expect(summary).toHaveText('来源');
    await summary.focus();
    await page.keyboard.press('Enter');
    await expect(source).toHaveAttribute('open', '');
    await expect(current.getByText('版本 / 散列')).toBeVisible();
    await expect(source).toContainText('本地文件');
    await expect(source).toContainText('环境 本设备');
    await page.keyboard.press('Space');
    await expect(source).not.toHaveAttribute('open', '');
    await expect(current.getByText('版本 / 散列')).toBeHidden();
    await page.keyboard.press('Space');
    await expect(source).toHaveAttribute('open', '');
    await expect(current.getByText('版本 / 散列')).toBeVisible();
  } finally {
    await app.close();
    await rm(root, { recursive: true, force: true });
  }
});

test('文件观察结果：覆盖不完整在问题通道可见（含 reasons detail），「来源」展开后可见读取范围', async () => {
  const root = await fileRoot();
  const { app, page } = await launchApp({ observationRoot: root });
  try {
    await resize(app, page, 1440, 900);
    await createFileTab(page, '覆盖不完整文件');
    await readFile(page, 'big.txt');
    const current = filesResult(page);
    await expect(current).toContainText('FILE_STATUS_NONCE_901');
    await expect(filesPanel(page).getByRole('button', { name: '继续读取', exact: true })).toBeVisible();
    const problem = filesSlot(page).locator('.status-item[data-status="observation:degraded"]');
    await expect(problem).toBeVisible();
    await expect(problem).toHaveAttribute('data-status-channel', 'problem');
    await expect(problem.getByRole('alert')).toContainText('覆盖不完整');
    // reasons 作为 detail 可见（不只在悬停里）。
    await expect(problem.locator('.status-detail')).toBeVisible();
    await expect(problem.locator('.status-detail')).not.toHaveText('');
    // 结果内不再自拼「覆盖 部分」；范围在「来源」折叠区。
    await expect(current.getByText(/^覆盖/)).toBeHidden();
    await current.getByText('来源', { exact: true }).click();
    await expect(current.getByText(/^范围 \{/)).toBeVisible();
    await expect(current.getByText('版本 / 散列')).toBeVisible();
  } finally {
    await app.close();
    await rm(root, { recursive: true, force: true });
  }
});

test('文件观察：读取失败在问题通道 alert 可见（错误标签 + message），结果区只留一行说明且不重复播报', async () => {
  const root = await fileRoot();
  const { app, page } = await launchApp({ observationRoot: root });
  try {
    await resize(app, page, 1440, 900);
    await createFileTab(page, '读取失败文件');
    await readFile(page, '../outside.txt');
    const failure = filesSlot(page).locator('.status-item[data-status="observation:failed"]');
    await expect(failure).toBeVisible();
    await expect(failure).toHaveAttribute('data-status-channel', 'problem');
    await expect(failure.getByRole('alert')).toContainText('读取失败：未获授权');
    // message 可见（detail 外露）。
    await expect(failure.locator('.status-detail')).toBeVisible();
    await expect(failure.locator('.status-detail')).not.toHaveText('');
    // 结果区保留错误行（合同：当前文件结果含「未获授权」），但不再是第二个 alert。
    await expect(filesResult(page)).toContainText('未获授权');
    await expect(filesResult(page).getByRole('alert')).toHaveCount(0);
    // 读取结束后焦点不落 body：仍停在触发读取的按钮上，或（丢失时）交给路径输入框。
    await expect.poll(() => page.evaluate(() => document.activeElement !== document.body)).toBe(true);
    await expect(filesPanel(page).locator(':focus')).toHaveCount(1);
    // 再次成功读取后，失败条目消失。
    await readFile(page, 'small.txt');
    await expect(filesResult(page)).toContainText('SMALL_FILE_OK');
    await expect(filesSlot(page).locator('.status-item[data-status="observation:failed"]')).toHaveCount(0);
  } finally {
    await app.close();
    await rm(root, { recursive: true, force: true });
  }
});

test('文件可能变化：观察过的目录里出现变化后，问题通道显示中文变化标签，原始枚举不外露', async () => {
  const root = await fileRoot();
  const { app, page } = await launchApp({ observationRoot: root });
  try {
    await resize(app, page, 1440, 900);
    await createFileTab(page, '文件变化提示');
    await filesPanel(page).getByRole('button', { name: '列出目录', exact: true }).click();
    await expect(filesResult(page)).toContainText('small.txt');
    // 变化提示来自真实的目录监视（只覆盖已观察目录）：在已列出的目录里新增文件。
    await expect
      .poll(async () => {
        await writeFile(path.join(root, `changed-${Date.now()}.txt`), 'changed\n');
        return (await workspaceSnapshot(page)).workspaces[0]!.fileHints.length;
      })
      .toBeGreaterThan(0);
    const hint = filesSlot(page).locator('.status-item[data-status-key^="file:"]');
    await expect(hint).toBeVisible();
    await expect(hint).toHaveAttribute('data-status-channel', 'problem');
    await expect(hint.getByRole('alert')).toContainText(/^文件可能变化 · .+；请重新读取$/);
    for (const raw of ['rename', 'change', 'unknown']) await expect(hint).not.toContainText(raw);
    // 旧的常驻行不存在。
    await expect(filesPanel(page)).not.toContainText('续读可能失效');
    // 窗格交互不会让问题消失（只有事实消失才消失）。
    await filesPanel(page).getByRole('button', { name: '列出目录', exact: true }).click();
    await expect(hint).toBeVisible();
  } finally {
    await app.close();
    await rm(root, { recursive: true, force: true });
  }
});

test('会话观察：进行中在会话状态槽常驻通道可见，「取消读取」可 Tab 到达并用 Enter 取消；已取消的结果行仍是区域内唯一的 alert', async () => {
  test.skip(target !== 'build', '此受控传输用例仅依赖 build bootstrap');
  const root = await mkdtemp(path.join(tmpdir(), 'wsl-status-observe-'));
  await writeFile(path.join(root, 'nonce.txt'), 'STATUS_OBSERVE_NONCE');
  const { app, page } = await launchApp({ observationRoot: root, controlledObservation: true });
  const arm = () =>
    app.evaluate(() => {
      (globalThis as unknown as { __wslObservationGate: { armed: boolean } }).__wslObservationGate.armed = true;
    });
  const release = () =>
    app.evaluate(() => {
      const gate = (globalThis as unknown as { __wslObservationGate: { armed: boolean; deliveries: Array<() => void> } })
        .__wslObservationGate;
      gate.armed = false;
      for (const send of gate.deliveries.splice(0)) send();
    });
  try {
    await resize(app, page, 1440, 900);
    await createFileTab(page, '会话观察文件');
    const resourceId = (await workspaceSnapshot(page)).workspaces[0]!.resources.find((item) => item.title === '会话观察文件')!.resourceId;
    await openSessionTab(page);
    await sessionViews(page).getByRole('button', { name: '上下文', exact: true }).click();
    const observation = sessionRegion(page).getByRole('region', { name: '会话统一观察', exact: true });
    await observation.getByLabel('观察来源').selectOption(resourceId);
    await observation.getByLabel('读取动作').selectOption('files.read');
    await observation.getByLabel('观察路径').fill('nonce.txt');
    await arm();
    await observation.getByRole('button', { name: '读取观察', exact: true }).click();
    // 状态槽（面板之外）显示进行中与「取消读取」；面板内不再另拼「正在读取，归属已冻结…」。
    const progress = sessionSlotItems(page).filter({ hasText: '正在读取…' });
    await expect(progress).toBeVisible();
    await expect(progress).toHaveAttribute('data-status-channel', 'persistent');
    await expect(observation).not.toContainText('归属已冻结');
    const cancel = progress.getByRole('button', { name: '取消读取', exact: true });
    await expect(cancel).toBeVisible();
    await expect(cancel).toBeEnabled();
    // 键盘：从面板内的「取消观察」出发，真实 Tab 走到槽内的「取消读取」，Enter 取消。
    await observation.getByRole('button', { name: '取消观察', exact: true }).focus();
    let reached = false;
    for (let i = 0; i < 15 && !reached; i++) {
      await page.keyboard.press('Tab');
      reached = await cancel.evaluate((node) => node === document.activeElement);
    }
    expect(reached).toBe(true);
    await expect(cancel).toBeFocused();
    await page.keyboard.press('Enter');
    await expect(progress).toHaveCount(0);
    // 按钮随状态卸载：焦点交给会话输入框，不落 body。
    await expect(sessionMessageBox(page)).toBeFocused();
    await expect.poll(async () => (await workspaceSnapshot(page)).workspaces[0]!.sessions[0]!.observations.at(-1)?.state).toBe('cancelled');
    // 已取消不产出事实：结果行是区域内唯一的 alert（原有合同）。
    await expect(observation.getByRole('alert')).toContainText('已取消');
    await expect(observation.getByRole('alert')).toHaveCount(1);
    await release();
  } finally {
    // 释放闸门失败不能掩盖用例本身的错误。
    await release().catch(() => undefined);
    await app.close();
    await rm(root, { recursive: true, force: true });
  }
});

test('会话观察：读取失败与覆盖不完整进入会话状态槽的问题通道，观察面板只留结果', async () => {
  const root = await fileRoot();
  const { app, page } = await launchApp({ observationRoot: root });
  try {
    await resize(app, page, 1440, 900);
    await createFileTab(page, '会话问题文件');
    const resourceId = (await workspaceSnapshot(page)).workspaces[0]!.resources.find((item) => item.title === '会话问题文件')!.resourceId;
    await openSessionTab(page);
    await sessionViews(page).getByRole('button', { name: '上下文', exact: true }).click();
    const observation = sessionRegion(page).getByRole('region', { name: '会话统一观察', exact: true });
    await observation.getByLabel('观察来源').selectOption(resourceId);
    await observation.getByLabel('读取动作').selectOption('files.read');
    await observation.getByLabel('观察路径').fill('../outside.txt');
    await observation.getByRole('button', { name: '读取观察', exact: true }).click();
    const failure = sessionSlotItems(page).filter({ hasText: '读取失败：未获授权' });
    await expect(failure).toBeVisible();
    await expect(failure.getByRole('alert')).toBeVisible();
    await expect(observation.getByRole('region', { name: '当前观察结果' })).toContainText('未获授权');
    await expect(observation.getByRole('alert')).toHaveCount(0);
    // 新的读取（大文件，覆盖不完整）取代旧的失败。
    await observation.getByLabel('观察路径').fill('big.txt');
    await observation.getByRole('button', { name: '读取观察', exact: true }).click();
    const partial = sessionSlotItems(page).filter({ hasText: '覆盖不完整' });
    await expect(partial).toBeVisible();
    await expect(sessionSlotItems(page).filter({ hasText: '读取失败' })).toHaveCount(0);
    const result = observation.getByRole('region', { name: '当前观察结果' });
    await expect(result).toContainText('FILE_STATUS_NONCE_901');
    await expect(result.getByText(/^覆盖/)).toBeHidden();
    await expect(result.getByText('来源', { exact: true })).toBeVisible();
  } finally {
    await app.close();
    await rm(root, { recursive: true, force: true });
  }
});

test('文件：进行中在资源槽常驻通道可见，「取消读取」真实 Tab 可达，Enter 取消后焦点回到路径输入框', async () => {
  test.skip(target !== 'build', '此受控传输用例仅依赖 build bootstrap');
  const root = await fileRoot();
  const { app, page } = await launchApp({ observationRoot: root, controlledObservation: true });
  const gate = (armed: boolean) =>
    app.evaluate((_electron, value) => {
      const g = (globalThis as unknown as { __wslObservationGate: { armed: boolean; deliveries: Array<() => void> } }).__wslObservationGate;
      g.armed = value;
      if (!value) for (const send of g.deliveries.splice(0)) send();
    }, armed);
  try {
    await resize(app, page, 1440, 900);
    await createFileTab(page, '文件取消读取');
    // 先确认首次说明，避免它影响 Tab 顺序。
    await filesSlotItems(page).getByRole('button', { name: '知道了', exact: true }).click();
    await gate(true);
    await filesPanel(page).getByRole('button', { name: '读取文件', exact: true }).click();
    await expect.poll(async () => (await workspaceSnapshot(page)).workspaces[0]!.observations.at(-1)?.state).toBe('pending');
    const progress = filesSlotItems(page).filter({ hasText: '正在读取…' });
    await expect(progress).toBeVisible();
    await expect(progress).toHaveAttribute('data-status-channel', 'persistent');
    const cancel = progress.getByRole('button', { name: '取消读取', exact: true });
    await expect(cancel).toBeEnabled();
    // 读取期间窗格内没有第二处进行中文字。
    await expect(filesPanel(page).getByText('正在读取…')).toHaveCount(1);
    // 真实 Tab：从窗格标题栏进入，槽内按钮先于表单控件。
    await page.getByRole('button', { name: '窗格操作', exact: true }).focus();
    let reached = false;
    for (let i = 0; i < 6 && !reached; i++) {
      await page.keyboard.press('Tab');
      reached = await cancel.evaluate((node) => node === document.activeElement);
    }
    expect(reached).toBe(true);
    await page.keyboard.press('Enter');
    await expect(progress).toHaveCount(0);
    await expect(filesResult(page)).toContainText('已取消');
    await expect(filesPanel(page).getByLabel('文件路径')).toBeFocused();
  } finally {
    await gate(false).catch(() => undefined);
    await app.close();
    await rm(root, { recursive: true, force: true });
  }
});

test('会话最新执行失败时读取越权路径：执行失败仍可见，读取失败恰有一个 alert（折叠在「另有 1 项」时由结果行播报）', async () => {
  const root = await fileRoot();
  const { app, page } = await launchApp({ observationRoot: root });
  try {
    await resize(app, page, 1440, 900);
    await createFileTab(page, '失败叠加文件');
    const resourceId = (await workspaceSnapshot(page)).workspaces[0]!.resources.find((item) => item.title === '失败叠加文件')!.resourceId;
    await failSessionRun(page);
    await sessionViews(page).getByRole('button', { name: '上下文', exact: true }).click();
    const observation = sessionRegion(page).getByRole('region', { name: '会话统一观察', exact: true });
    await observation.getByLabel('观察来源').selectOption(resourceId);
    await observation.getByLabel('读取动作').selectOption('files.read');
    await observation.getByLabel('观察路径').fill('../outside.txt');
    await observation.getByRole('button', { name: '读取观察', exact: true }).click();
    const result = observation.getByRole('region', { name: '当前观察结果' });
    await expect(result).toContainText('未获授权');
    // 执行失败（优先级更高）占住槽里唯一可见的问题位，仍可见；读取失败折叠进「另有 1 项」。
    await expect(sessionSlotItems(page).filter({ hasText: '执行失败' })).toBeVisible();
    await expect(sessionRegion(page).getByRole('button', { name: '另有 1 项', exact: true })).toBeVisible();
    // 读取失败只被播报一次：折叠时由结果行播报，不能因折叠而完全没有 alert，也不能有两个。
    const readFailure = sessionRegion(page).getByRole('alert').filter({ hasText: '未获授权' });
    await expect(readFailure).toHaveCount(1);
    await expect(observation.getByRole('alert')).toHaveCount(1);
    // 执行失败本身的 alert 仍在槽里。
    await expect(sessionSlotItems(page).filter({ hasText: '执行失败' }).getByRole('alert')).toBeVisible();
  } finally {
    await app.close();
    await rm(root, { recursive: true, force: true });
  }
});

test('文件截图：白 / 暗 / 暖 × 1440 / 960，正常（小文件读取完成）与异常（读取失败）', async () => {
  test.setTimeout(240000);
  const dir = path.join(screensDir, 'status-surface');
  await mkdir(dir, { recursive: true });
  for (const state of ['normal', 'abnormal'] as const) {
    const root = await fileRoot();
    const { app, page } = await launchApp({ observationRoot: root });
    try {
      await resize(app, page, 1440, 900);
      await createFileTab(page, '截图文件');
      for (const theme of ['light', 'dark', 'warm'] as const) {
        await resize(app, page, 1440, 900);
        await expect(page.getByRole('navigation', { name: 'Workshop 导航' })).toBeVisible();
        await setWorkspaceTheme(page, theme);
        await page.getByRole('navigation', { name: '空间标签' }).getByRole('button', { name: '截图文件', exact: true }).click();
        for (const width of [1440, 960]) {
          await resize(app, page, width, width === 1440 ? 900 : 700);
          await expect(filesPanel(page)).toBeVisible();
          // 读取结果是窗格的本地状态，换主题时会随页面重建，这里每次重新读取。
          if (state === 'normal') {
            await filesPanel(page).getByLabel('文件路径').fill('.');
            await filesPanel(page).getByRole('button', { name: '列出目录', exact: true }).click();
            await filesPanel(page).getByRole('button', { name: 'small.txt · file', exact: true }).click();
            await expect(filesResult(page)).toContainText('SMALL_FILE_OK');
            await expect(filesResult(page).locator('[data-status="observation:ok"]')).toBeVisible();
            const source = filesResult(page).locator('details.observation-source');
            if (!(await source.getAttribute('open'))) await source.locator('summary').click();
            await expect(filesResult(page).getByText('版本 / 散列')).toBeVisible();
          } else {
            await readFile(page, '../outside.txt');
            await expect(filesSlot(page).locator('.status-item[data-status="observation:failed"]')).toBeVisible();
          }
          await shot(page, `status-surface/files-${state}-${theme}-${width}`);
        }
      }
    } finally {
      await app.close();
      await rm(root, { recursive: true, force: true });
    }
  }
});

test('修复复验：文件资源不可用进唯一状态槽——缺环境与不可用原因两条件，body 无重复、表单禁用、恢复可用', async () => {
  const root = await fileRoot();
  const { app, page } = await launchApp({ observationRoot: root });
  try {
    await mkdir(path.join(screensDir, 'status-surface'), { recursive: true });
    await resize(app, page, 1440, 900);
    await createFileTab(page, '不可用文件');
    await filesSlotItems(page).getByRole('button', { name: '知道了', exact: true }).click();
    const resourceId = (await workspaceSnapshot(page)).workspaces[0]!.resources.find((item) => item.title === '不可用文件')!.resourceId;
    const unavailable = () => filesSlot(page).locator(`.status-item[data-status-key="file:${resourceId}:unavailable"]`);
    await installStatusShim(app);

    await setStatusShim(app, { resource: { [resourceId]: { environmentId: null } } });
    await pushWorkbenchSnapshot(page);
    await expect(unavailable()).toBeVisible();
    await expect(unavailable()).toHaveAttribute('data-status-channel', 'problem');
    await expect(unavailable().getByRole('alert')).toContainText('此资源没有授权环境，请新建标签并明确选择已配置环境。');
    await expect(filesPanel(page).locator('.file-panel-body').getByText('此资源没有授权环境', { exact: false })).toHaveCount(0);
    await expect(filesPanel(page).locator('p[role="status"]')).toHaveCount(0);
    for (const name of ['列出目录', '读取文件', '搜索文件'])
      await expect(filesPanel(page).getByRole('button', { name, exact: true })).toBeDisabled();
    await shot(page, 'status-surface/files-unavailable-no-env-1440');

    await setStatusShim(app, { resource: { [resourceId]: { environmentId: 'local', unavailableReason: '授权环境已下线' } } });
    await pushWorkbenchSnapshot(page);
    await expect(unavailable()).toBeVisible();
    await expect(unavailable().getByRole('alert')).toContainText('授权环境已下线');
    await expect(filesPanel(page).locator('.file-panel-body').getByText('授权环境已下线')).toHaveCount(0);
    await expect(filesPanel(page).getByRole('button', { name: '列出目录', exact: true })).toBeDisabled();
    await shot(page, 'status-surface/files-unavailable-reason-1440');

    await setStatusShim(app, { resource: { [resourceId]: { environmentId: 'local', unavailableReason: null } } });
    await pushWorkbenchSnapshot(page);
    await expect(unavailable()).toHaveCount(0);
    const list = filesPanel(page).getByRole('button', { name: '列出目录', exact: true });
    await expect(list).toBeEnabled();
    await list.click();
    await expect(filesResult(page)).toContainText('small.txt');
  } finally {
    await app.close();
    await rm(root, { recursive: true, force: true });
  }
});

test('修复复验：观察历史错误与当前结果分离——旧失败不占当前槽、不增加另有项；历史内失败摘要与未获授权可见且不播报', async () => {
  const root = await fileRoot();
  const { app, page } = await launchApp({ observationRoot: root });
  try {
    await mkdir(path.join(screensDir, 'status-surface'), { recursive: true });
    await resize(app, page, 1440, 900);
    await createFileTab(page, '历史分离文件');
    await filesSlotItems(page).getByRole('button', { name: '知道了', exact: true }).click();
    await readFile(page, '../outside.txt');
    await expect(filesSlot(page).locator('.status-item[data-status="observation:failed"]')).toBeVisible();
    await readFile(page, 'small.txt');
    const current = filesResult(page);
    await expect(current).toContainText('SMALL_FILE_OK');
    await expect(current.locator('[data-status="observation:ok"]')).toBeVisible();
    await expect(filesSlot(page).locator('.status-item[data-status="observation:failed"]')).toHaveCount(0);
    await expect(filesSlot(page).getByRole('button', { name: /^另有 \d+ 项$/ })).toHaveCount(0);
    await expect(filesSlotItems(page)).toHaveCount(0);
    const history = filesPanel(page).locator('details.observation-history');
    await history.locator('summary').first().click();
    const failedEntry = history.locator('details').filter({ hasText: '读取文件 · 失败' });
    await expect(failedEntry).toHaveCount(1);
    await failedEntry.locator('summary').click();
    await expect(failedEntry.getByText('未获授权', { exact: false })).toBeVisible();
    await expect(failedEntry.getByRole('alert')).toHaveCount(0);
    await shot(page, 'status-surface/files-observation-history-1440');
  } finally {
    await app.close();
    await rm(root, { recursive: true, force: true });
  }
});

/* ---------- App 对话框 ---------- */

const appSbxBin = path.resolve('e2e/fixtures/sbx-app-actions.mjs');
const APP_WORKSPACE = 'taskflow-demo';
const appStateKey = `app:${APP_WORKSPACE}:state`;
const appDialog = (page: Page) => page.getByRole('dialog', { name: '空间 App' });
const appState = (page: Page) => appDialog(page).locator(`[data-status-key="${appStateKey}"]`);

/** 创建标准 App（说明留空），回到空间页。 */
async function createManagedApp(page: Page, name: string) {
  await page.getByRole('button', { name: '新建 App', exact: true }).click();
  await appDialog(page).getByRole('button', { name: '创建标准应用', exact: true }).click();
  const form = page.getByRole('dialog', { name: '创建 App', exact: true });
  await form.getByLabel('App 名称').fill(name);
  await form.getByRole('button', { name: '保存 App' }).click();
  await expect(form).not.toBeVisible();
  await expect(page.getByRole('button', { name: '管理 App', exact: true })).toBeVisible();
}

const openAppDialog = async (page: Page) => {
  await page.getByRole('button', { name: '管理 App', exact: true }).click();
  await expect(appDialog(page).getByRole('button', { name: '关闭', exact: true })).toBeFocused();
};

/** 启动应用直到 fixture 拒绝启动，状态落在 failed。 */
async function failAppStart(page: Page) {
  await appDialog(page).getByRole('button', { name: '启动应用', exact: true }).click();
  await expect
    .poll(async () => (await workspaceSnapshot(page)).workspaces.find((w) => w.workspaceId === APP_WORKSPACE)?.managedApp?.state)
    .toBe('failed');
}

test('App 对话框：标题是 App 名称，说明为空不显示占位；服务状态是 StatusDot + 可见 label；空间 / 工程类型说明改为描述', async () => {
  const { app, page } = await launchApp({ sbxBin: appSbxBin });
  try {
    await createManagedApp(page, 'Workshop 状态应用');
    await openAppDialog(page);
    const dialog = appDialog(page);
    await expect(dialog.getByRole('heading', { name: '管理 App', exact: true })).toBeVisible();
    await expect(dialog.getByText('Workshop 状态应用', { exact: true })).toBeVisible();
    // 说明为空：不出现占位。
    await expect(dialog.getByText('暂无 App 说明')).toHaveCount(0);
    // 服务状态：形状 + 可见 label，第一个 status 区域只含 label。
    const state = appState(page);
    await expect(state).toBeVisible();
    await expect(state).toHaveAttribute('data-status', 'app:idle');
    await expect(state).toHaveAttribute('data-status-channel', 'ambient');
    await expect(state.locator('.shape')).toHaveAttribute('aria-hidden', 'true');
    await expect(state.locator('.status-label')).toBeVisible();
    await expect(state.locator('.status-label')).toHaveText('已创建');
    await expect(dialog.getByRole('status').first()).toHaveText('已创建');
    // 稳态没有常驻 / 问题条目，状态槽不渲染。
    await expect(dialog.locator('.status-slot')).toHaveCount(0);
    // 「空间 · 沙箱 React 全栈工程」与沙箱目录不再常驻外露，仍在描述 / 视觉隐藏文本里。
    await expect(dialog).toHaveAccessibleDescription(/沙箱 React 全栈工程/);
    await expectVisuallyHidden(dialog.locator('span.sr-only', { hasText: '沙箱 React 全栈工程' }));
    await expect(state).toHaveAttribute('title', /^已创建（.+）$/);
    // 动作按钮保持原名称。
    for (const name of ['编辑 App', '启动应用', '导出源码']) await expect(dialog.getByRole('button', { name, exact: true })).toBeVisible();
  } finally {
    await app.close();
  }
});

test('App 对话框：启动中在常驻通道可见且不重复动作；取消启动后为已停止；再次启动失败时问题条目与 detail 可见；Tab 顺序与 Esc 回焦不变', async () => {
  const { app, page } = await launchApp({ sbxBin: appSbxBin });
  try {
    await createManagedApp(page, 'Workshop 状态应用');
    await openAppDialog(page);
    const dialog = appDialog(page);
    await dialog.getByRole('button', { name: '启动应用', exact: true }).click();
    // 启动中：状态槽常驻通道，文案来自事实层。fixture 的启动窗口约 1.2 秒：先断言条目可见，
    // 随后用一次同步 DOM 快照核对细节，再立刻用键盘取消启动，不在窗口内做多步异步断言。
    const starting = dialog.locator(`.status-slot .status-item[data-status-key="${appStateKey}"]`);
    await expect(starting).toBeVisible();
    const snapshot = await dialog.evaluate((node, key) => {
      const item = node.querySelector(`.status-slot .status-item[data-status-key="${key}"]`);
      return {
        channel: item?.getAttribute('data-status-channel'),
        liveText: item?.querySelector('[role="status"]')?.textContent?.trim(),
        slotButtons: node.querySelectorAll('.status-slot button').length,
        occurrences: (node.textContent?.match(/正在启动应用…/g) ?? []).length,
        ambientRows: node.querySelectorAll(`[data-status-channel="ambient"][data-status-key="${key}"]`).length,
      };
    }, appStateKey);
    // 常驻通道、文案只出现一次（不再另画一行服务状态），槽里不重复「启动应用 / 管理 App」。
    expect(snapshot).toEqual({ channel: 'persistent', liveText: '正在启动应用…', slotButtons: 0, occurrences: 1, ambientRows: 0 });
    const cancel = dialog.getByRole('button', { name: '取消启动', exact: true });
    await expect(cancel).toBeEnabled();
    await cancel.focus();
    await page.keyboard.press('Enter');
    await expect
      .poll(async () => (await workspaceSnapshot(page)).workspaces.find((w) => w.workspaceId === APP_WORKSPACE)?.managedApp?.state)
      .toBe('stopped');
    await expect(appState(page)).toHaveAttribute('data-status', 'app:idle');
    await expect(appState(page).locator('.status-label')).toHaveText('已停止');
    await expect(dialog.getByRole('button', { name: '启动应用', exact: true })).toBeEnabled();
    // 再次启动：fixture 拒绝启动，进入失败。
    await failAppStart(page);
    const failed = dialog.locator(`.status-slot .status-item[data-status-key="${appStateKey}"]`);
    await expect(failed).toBeVisible();
    await expect(failed).toHaveAttribute('data-status-channel', 'problem');
    await expect(failed.getByRole('alert')).toContainText('应用运行失败');
    await expect(failed.locator('.status-detail')).toBeVisible();
    await expect(failed.locator('.status-detail')).not.toHaveText('');
    await expect(dialog.getByRole('alert').first()).toBeVisible();
    // 完整错误是结果内容：「错误详情」折叠区默认收起，Enter 展开后完整 app.error 可见；它不是 alert / status。
    const fullError = (await workspaceSnapshot(page)).workspaces.find((w) => w.workspaceId === APP_WORKSPACE)!.managedApp!.error!;
    const details = dialog.locator('details.managed-app-error');
    await expect(details).toBeVisible();
    await expect(details).not.toHaveAttribute('open', '');
    await expect(details.getByText('错误详情', { exact: true })).toBeVisible();
    await expect(details.locator('pre')).toBeHidden();
    await expect(details.locator('[role="alert"], [role="status"]')).toHaveCount(0);
    // 不再由组件直接渲染 app.error；服务状态不重复画一行。
    await expect(dialog.locator('p[role="alert"]')).toHaveCount(0);
    await expect(appState(page)).toHaveCount(1);
    await expect(dialog.locator('.status-slot button')).toHaveCount(0);
    // Tab 顺序：关闭 → 编辑 App → 启动应用 → 停止应用 → 导出源码（状态槽没有按钮，不插入新的 Tab 停靠点），Esc 回到触发器。
    await dialog.getByRole('button', { name: '关闭', exact: true }).focus();
    for (const name of ['编辑 App', '启动应用', '停止应用', '导出源码']) {
      await page.keyboard.press('Tab');
      await expect(dialog.getByRole('button', { name, exact: true })).toBeFocused();
    }
    await page.keyboard.press('Tab');
    await expect(details.locator('summary')).toBeFocused();
    await page.keyboard.press('Enter');
    await expect(details).toHaveAttribute('open', '');
    await expect(details.locator('pre')).toBeVisible();
    await expect(details.locator('pre')).toHaveText(fullError);
    await expect(details.locator('pre')).toContainText('fixture: startup intentionally rejected');
    await page.keyboard.press('Escape');
    await expect(page.getByRole('button', { name: '管理 App', exact: true })).toBeFocused();
  } finally {
    await app.close();
  }
});

test('App 对话框截图：白 / 暗 / 暖 × 1440 / 960，正常（已创建）与异常（运行失败）', async () => {
  test.setTimeout(240000);
  const dir = path.join(screensDir, 'status-surface');
  await mkdir(dir, { recursive: true });
  const { app, page } = await launchApp({ sbxBin: appSbxBin });
  try {
    await resize(app, page, 1440, 900);
    await createManagedApp(page, 'Workshop 状态应用');
    for (const state of ['normal', 'abnormal'] as const) {
      if (state === 'abnormal') {
        await resize(app, page, 1440, 900);
        await openAppDialog(page);
        await failAppStart(page);
        await page.keyboard.press('Escape');
      }
      for (const theme of ['light', 'dark', 'warm'] as const) {
        await resize(app, page, 1440, 900);
        await expect(page.getByRole('navigation', { name: 'Workshop 导航' })).toBeVisible();
        await setWorkspaceTheme(page, theme);
        // 窄窗口里侧栏收起、触发器不在场：在 1440 下打开对话框，再缩窄窗口截图。
        await openAppDialog(page);
        for (const width of [1440, 960]) {
          await resize(app, page, width, width === 1440 ? 900 : 700);
          if (state === 'normal') await expect(appState(page)).toHaveAttribute('data-status', 'app:idle');
          else await expect(appDialog(page).locator('.status-item[data-status="app:failed"]')).toBeVisible();
          await shot(page, `status-surface/app-dialog-${state === 'normal' ? 'created' : 'failed'}-${theme}-${width}`);
        }
        await page.keyboard.press('Escape');
        await expect(appDialog(page)).not.toBeVisible();
      }
    }
  } finally {
    await app.close();
  }
});

test('App 对话框：启动中强制结束应用后重启，恢复为 failed + 清理未确认时，「应用进程清理未确认」常驻可见，交互后不消失；启动被禁用', async () => {
  const profile = await mkdtemp(path.join(tmpdir(), 'wsl-app-recovery-'));
  const options = { userData: profile, sbxBin: appSbxBin };
  let launched = await launchApp(options);
  try {
    await createManagedApp(launched.page, 'Workshop 状态应用');
    await openAppDialog(launched.page);
    await appDialog(launched.page).getByRole('button', { name: '启动应用', exact: true }).click();
    await expect(
      appDialog(launched.page).locator(`.status-slot .status-item[data-status-key="${appStateKey}"][data-status-channel="persistent"]`),
    ).toBeVisible();
    // 启动窗口内强制结束应用（starting 已持久化）；重启后 Main 核对恢复，核对不了则记为 failed + cleanupConfirmed:false。
    const exited = new Promise<void>((resolve) => launched.app.process().once('exit', () => resolve()));
    launched.app.process().kill('SIGKILL');
    await exited;
    launched = await launchApp(options);
    const { page } = launched;
    await expect
      .poll(
        async () => (await workspaceSnapshot(page)).workspaces.find((w) => w.workspaceId === APP_WORKSPACE)?.managedApp?.cleanupConfirmed,
      )
      .toBe(false);
    await openAppDialog(page);
    const dialog = appDialog(page);
    const unresolved = dialog.locator(`.status-slot .status-item[data-status-key="app:${APP_WORKSPACE}:cleanup"]`);
    await expect(unresolved).toBeVisible();
    await expect(unresolved).toHaveAttribute('data-status-channel', 'persistent');
    await expect(unresolved.getByRole('status')).toHaveText('应用进程清理未确认');
    // 问题通道的失败条目同时可见；清理未确认时不能再次启动。
    await expect(
      dialog.locator(`.status-slot .status-item[data-status-key="${appStateKey}"][data-status-channel="problem"]`),
    ).toBeVisible();
    await expect(dialog.getByRole('button', { name: '启动应用', exact: true })).toBeDisabled();
    // 点击与按键之后仍然可见（unresolved 不降级）。
    await dialog.getByRole('heading', { name: '管理 App', exact: true }).click();
    await page.keyboard.press('Shift+Tab');
    await expect(unresolved).toBeVisible();
    await expect(dialog.getByRole('alert').first()).toBeVisible();
  } finally {
    // 清理未确认时产品有意拒绝正常关闭（同 SSH 断线用例）：沙箱进程由 fixture 模拟，直接强制结束本测试拥有的应用进程。
    if (launched.app.process().exitCode === null) {
      const exited = new Promise<void>((resolve) => launched.app.process().once('exit', () => resolve()));
      launched.app.process().kill('SIGKILL');
      await exited;
    }
    await rm(profile, { recursive: true, force: true });
  }
});
