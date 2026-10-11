import { execFile } from 'node:child_process';
import { mkdir, mkdtemp } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { promisify } from 'node:util';
import { expect, test, type ElectronApplication, type Page } from '@playwright/test';
import {
  fixtureSandbox,
  launchApp,
  openBrowserMenu,
  previewInfo,
  screensDir,
  setWindowSize,
  setWorkspaceTheme,
  shot,
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
  // 让数据目录只读，使下一次持久化失败，Main 发布 storageError。
  const userData = await mkdtemp(path.join(tmpdir(), 'wsl-status-storage-'));
  const { app, page } = await launchApp({ userData });
  try {
    await run('chmod', ['-R', 'a-w', userData]);
    // 持久化失败的同时，这条命令会以失败返回，工作区错误也出现。
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

    // 用户引起的聚焦同样确认：再来一个新实例，关闭后 Playwright 的真实 focus 事件。
    await connectButton(page).click();
    await expect(terminalPanel(page)).toContainText('已连接');
    await closeButton(page).click();
    await expect(notice).toBeVisible();
    await connectButton(page).focus();
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
    // 点击窗格、按键之后仍然可见。工具栏的「连接终端」保持可点：重连由 Main 明确拒绝并给出「清理未确认」（ssh-product.spec 覆盖）。
    await terminalPanel(page).locator('.terminal-surface').click();
    await page.keyboard.press('Shift+Tab');
    await expect(unresolved).toBeVisible();
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
