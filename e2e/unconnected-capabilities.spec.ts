import { mkdtemp, readFile, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { expect, test, type Page } from '@playwright/test';
import { launchApp, shot, target, workshopNavigate, workspaceSnapshot } from './helpers';

/*
 * OPS-1 B4（S3、S4）：未接入的能力不显示为故障，未接入的演示入口只在诊断模式出现。
 * O06 / O06a / O07。全部使用确定性 fixture，不调用模型；“检查通过”只来自预置的 workbench.json（SPEC §9.4）。
 */

const sbxBin = path.resolve('e2e/fixtures/sbx.mjs');
const STUDIO_KEYS = ['setup', 'workbench', 'chat', 'app', 'execution', 'workflow', 'shell'];
const CHECKER_NOTE = /产品检查器尚未接入/;
const ACCEPT_WITHOUT_CHECKER = '产品检查器尚未接入：接受需要独立检查通过且适用于当前版本，目前不能接受结果。';
const ACCEPT_REQUIRES_VALIDATION = '固定验收通过且仍适用于当前版本后，才能接受结果。';
const DEMO_FEED = '历史演示动态（只读）';

const sessionRegion = (page: Page) => page.getByRole('region', { name: 'Agent 会话内容', exact: true });
const sessionSlotItems = (page: Page) => sessionRegion(page).locator('.status-slot .status-item');
const homeRegion = (page: Page) => page.getByRole('region', { name: '混合输入', exact: true });

async function openSessionTab(page: Page) {
  await page.getByRole('navigation', { name: '空间标签' }).getByRole('button', { name: 'Agent 会话', exact: true }).click();
}

/** 用 sbx 夹具跑完一次会话运行（不调用模型）。 */
async function completeSessionRun(page: Page, text: string) {
  await openSessionTab(page);
  await sessionRegion(page).getByRole('textbox', { name: '会话消息', exact: true }).fill(text);
  await sessionRegion(page).getByRole('button', { name: '发送', exact: true }).click();
  await expect.poll(async () => (await workspaceSnapshot(page)).workspaces[0]!.runs.at(-1)?.state).toBe('completed');
}

/**
 * renderer 已读到 Main 的 AppInfo：设置页「关于 · 版本」由 environmentStore.appInfo 渲染。
 * 演示入口的“不存在”断言放在它之后，避免在 AppInfo 读取前误判通过。
 */
async function expectAppInfoLoaded(page: Page) {
  await workshopNavigate(page, '设置');
  await expect(page.getByRole('region', { name: '应用设置', exact: true })).toContainText(
    target === 'packaged' ? '（打包）' : '（开发模式）',
  );
}

/** 设置页的 W4 配置入口（Harness 可用性与 Profile 列表）在任何构建中都保留。 */
async function expectHarnessSettings(page: Page) {
  await workshopNavigate(page, '设置');
  await expect(page.getByRole('heading', { name: '连接与 Harness', exact: true })).toBeVisible();
  await expect(page.getByRole('table', { name: 'Harness 可用性' })).toBeVisible();
  await expect(page.getByRole('table', { name: 'Profile 列表' })).toBeVisible();
}

/** 真实条目在两种模式下都保留：任务历史中的真实运行、Agent 会话列表、设置页 Harness / Profile、会话「任务设置」中的执行 Agent（OPS-1 S2 从「任务」视图移入）。 */
async function expectRealEntries(page: Page) {
  await workshopNavigate(page, '任务');
  const tasks = page.getByRole('navigation', { name: '任务与运行记录', exact: true });
  await expect(tasks.getByRole('heading', { name: '任务历史', exact: true })).toBeVisible();
  await expect(tasks.getByRole('button', { name: /^任务 v1 · / })).toBeVisible();
  await expect(tasks.getByRole('button', { name: /^运行 · / })).toBeVisible();
  await workshopNavigate(page, '会话');
  await expect(page.getByRole('navigation', { name: '会话列表', exact: true }).locator('button.conv-row').first()).toBeVisible();
  await expectHarnessSettings(page);
  await workshopNavigate(page, '空间');
  await openSessionTab(page);
  await sessionRegion(page)
    .getByRole('button', { name: /^任务设置/ })
    .click();
  await expect(sessionRegion(page).getByLabel('执行 Agent', { exact: true })).toBeVisible();
}

const openNotifications = async (page: Page) => {
  await page.getByRole('button', { name: /^通知 · / }).click();
  const panel = page.getByRole('region', { name: '通知', exact: true });
  await expect(panel.locator('[data-run-id]').first()).toBeVisible();
  return panel;
};

test('O07 正式构建：首页只有对话与近期空间，会话页没有联系人演示，任务页没有演示记录，通知没有历史演示；真实条目与 W4 配置入口保留', async () => {
  const { app, page } = await launchApp({ sbxBin });
  try {
    expect(await page.evaluate(() => Object.keys(window.studio))).toEqual(STUDIO_KEYS);
    expect(await page.evaluate(() => window.studio.app.getInfo())).toMatchObject({ packaged: target === 'packaged', diagnostics: false });
    await expectAppInfoLoaded(page);

    await workshopNavigate(page, '首页');
    const home = homeRegion(page);
    await expect(home.getByRole('textbox')).toBeVisible();
    await expect(home.getByRole('radiogroup', { name: '输入模式' })).toHaveCount(0);
    for (const name of ['对话', '搜索', '打开']) await expect(home.getByRole('radio', { name, exact: true })).toHaveCount(0);
    await expect(home).not.toContainText('搜索尚未接入');
    await expect(page.getByRole('region', { name: '近期空间', exact: true })).toBeVisible();

    await workshopNavigate(page, '会话');
    const conversations = page.getByRole('navigation', { name: '会话列表', exact: true });
    await expect(conversations.locator('button.conv-row').first()).toBeVisible();
    await expect(conversations.getByRole('tab', { name: '联系人与群聊' })).toHaveCount(0);
    await expect(page.getByText('人际消息不在本轮范围，以下是演示条目。')).toHaveCount(0);

    await workshopNavigate(page, '空间');
    await completeSessionRun(page, '正式构建任务历史');
    await workshopNavigate(page, '任务');
    const tasks = page.getByRole('navigation', { name: '任务与运行记录', exact: true });
    await expect(tasks.getByRole('button', { name: /^运行 · / })).toBeVisible();
    await expect(tasks.getByText('演示记录（独立，只读）')).toHaveCount(0);
    await expect(tasks.getByRole('button', { name: / · 演示记录$/ })).toHaveCount(0);

    const notifications = await openNotifications(page);
    await expect(notifications.getByText(DEMO_FEED)).toHaveCount(0);
    await page.getByRole('button', { name: /^通知 · / }).click();

    await expectRealEntries(page);
  } finally {
    await app.close();
  }
});

test('O07 诊断启用（WSL_DEBUG_STATUS=1）：五处未接入的演示入口可见，真实条目与 W4 配置入口照常', async () => {
  const { app, page } = await launchApp({ sbxBin, debugStatus: true });
  try {
    expect(await page.evaluate(() => window.studio.app.getInfo())).toMatchObject({ packaged: target === 'packaged', diagnostics: true });
    await expectAppInfoLoaded(page);

    await workshopNavigate(page, '首页');
    const home = homeRegion(page);
    const modes = home.getByRole('radiogroup', { name: '输入模式' });
    await expect(modes.getByRole('radio')).toHaveText(['对话', '搜索', '打开']);
    await modes.getByRole('radio', { name: '打开', exact: true }).click();
    await expect(home).toContainText('从首页打开地址需要临时空间，尚未接入');
    await modes.getByRole('radio', { name: '对话', exact: true }).click();

    await workshopNavigate(page, '空间');
    await completeSessionRun(page, '诊断模式任务历史');

    await workshopNavigate(page, '会话');
    const conversations = page.getByRole('navigation', { name: '会话列表', exact: true });
    await expect(conversations.locator('button.conv-row').first()).toBeVisible();
    await conversations.getByRole('tab', { name: '联系人与群聊', exact: true }).click();
    await expect(page.getByText('人际消息不在本轮范围，以下是演示条目。')).toBeVisible();
    await conversations.getByRole('tab', { name: 'Agent 工作', exact: true }).click();

    await workshopNavigate(page, '任务');
    const tasks = page.getByRole('navigation', { name: '任务与运行记录', exact: true });
    // 真实运行已存在时，演示记录与真实历史并列且可打开。
    await expect(tasks.getByRole('button', { name: /^运行 · / })).toBeVisible();
    await tasks.getByText('演示记录（独立，只读）', { exact: true }).click();
    await tasks
      .getByRole('button', { name: / · 演示记录$/ })
      .first()
      .click();
    await expect(page.getByText(/演示记录 · .* · 不是真实运行结果/)).toBeVisible();

    const notifications = await openNotifications(page);
    await expect(notifications.getByText(DEMO_FEED, { exact: true })).toBeVisible();
    await page.getByRole('button', { name: /^通知 · / }).click();

    await expectRealEntries(page);
  } finally {
    await app.close();
  }
});

test('O06 检查器未接入：中性「检查器未接入」，没有「运行检查」与问题级「检查无法执行」，接受禁用并说明原因；设置页有说明', async () => {
  const { app, page } = await launchApp({ sbxBin });
  try {
    expect((await page.evaluate(() => window.studio.execution.getStatus())).checker).toEqual({
      connected: false,
      reason: 'not_integrated',
    });
    await completeSessionRun(page, '检查器未接入用例');
    const region = sessionRegion(page);
    await region.getByRole('button', { name: '检查', exact: true }).click();
    const validation = region.locator('[data-status-key$=":state"][data-status^="validation:"]');
    await expect(validation).toHaveText('检查器未接入');
    await expect(validation).toHaveAttribute('data-status', 'validation:idle');
    // 中性形状（方块）+ 不在问题通道。
    await expect(validation.locator('.shape-square')).toHaveCount(1);
    await expect(validation).toHaveAttribute('data-status-channel', 'ambient');
    // 从未检查过：不显示警告色的「检查适用性未知」。
    await expect(region.locator('[data-status-key$=":applicability"]')).toHaveCount(0);
    await expect(region.getByText('检查适用性未知')).toHaveCount(0);
    await expect(region.getByText('产品检查器尚未接入，无法在此运行检查。', { exact: true })).toBeVisible();
    await expect(region.getByRole('button', { name: '运行检查' })).toHaveCount(0);
    const accept = region.getByRole('button', { name: '接受结果', exact: true });
    await expect(accept).toBeVisible();
    await expect(accept).toBeDisabled();
    // 禁用原因既可见，也是按钮的可访问描述。
    await expect(region.getByText(ACCEPT_WITHOUT_CHECKER, { exact: true })).toBeVisible();
    await expect(accept).toHaveAccessibleDescription(ACCEPT_WITHOUT_CHECKER);
    await expect(region.getByRole('button', { name: '要求修改', exact: true })).toBeEnabled();
    // 不是故障：状态槽为空，没有 alert，页面里没有「检查无法执行」。
    await expect(sessionSlotItems(page)).toHaveCount(0);
    await expect(region.getByRole('alert')).toHaveCount(0);
    await expect(page.getByText('检查无法执行')).toHaveCount(0);
    await shot(page, 'unconnected-capabilities/session-checks-not-connected');
    const run = (await workspaceSnapshot(page)).workspaces[0]!.runs.at(-1)!;
    expect(run.validation).toEqual({ state: 'not_run', applicability: 'unknown', reason: null });
    expect(run.review).toBeNull();

    // 通知同样不报故障。
    await page.getByRole('button', { name: /^通知 · / }).click();
    await expect(page.getByRole('region', { name: '通知' }).locator(`[data-run-id="${run.runId}"]`)).toContainText(
      '检查器未接入 · 尚未审阅',
    );

    await workshopNavigate(page, '设置');
    await expect(page.getByRole('region', { name: '应用设置' }).getByText(CHECKER_NOTE)).toBeVisible();
  } finally {
    await app.close();
  }
});

test('O06b renderer 按 Main 发布的能力呈现：测试侧把 execution:get-status 换成已接入，界面随之提供「运行检查」、去掉未接入说明', async () => {
  const { app, page } = await launchApp({ sbxBin });
  try {
    // 只在测试侧替换 Main 的 IPC 处理器（不经产品代码路径或环境变量），然后重新加载 renderer 让它重新读取。
    await app.evaluate(({ ipcMain }) => {
      ipcMain.removeHandler('execution:get-status');
      ipcMain.handle('execution:get-status', () => ({
        available: false,
        reason: '测试替换的执行状态：检查器已接入',
        harness: { harnessId: 'codex', name: 'Codex CLI', state: 'integrated', version: null, model: null },
        checker: { connected: true },
      }));
    });
    await page.reload();
    expect((await page.evaluate(() => window.studio.execution.getStatus())).checker).toEqual({ connected: true });
    // renderer 已读到替换后的能力：设置页显示这次返回的 reason。
    await workshopNavigate(page, '设置');
    const settings = page.getByRole('region', { name: '应用设置', exact: true });
    await expect(settings).toContainText('测试替换的执行状态：检查器已接入');
    await expect(settings.getByText(CHECKER_NOTE)).toHaveCount(0);

    await workshopNavigate(page, '空间');
    await completeSessionRun(page, '检查器已接入（测试替换）');
    const region = sessionRegion(page);
    await region.getByRole('button', { name: '检查', exact: true }).click();
    await expect(region.locator('[data-status-key$=":state"][data-status^="validation:"]')).toHaveText('尚未检查');
    await expect(region.getByRole('button', { name: '运行检查', exact: true })).toBeVisible();
    await expect(region.getByText('检查器未接入')).toHaveCount(0);
    await expect(region.getByText(CHECKER_NOTE)).toHaveCount(0);
    // 已接入时 not_run 的适用性事实照旧。
    await expect(region.locator('[data-status-key$=":applicability"]')).toHaveText('检查适用性未知');
    const accept = region.getByRole('button', { name: '接受结果', exact: true });
    await expect(accept).toBeDisabled();
    await expect(region.getByText(ACCEPT_REQUIRES_VALIDATION, { exact: true })).toBeVisible();
    await expect(accept).toHaveAccessibleDescription(ACCEPT_REQUIRES_VALIDATION);
  } finally {
    await app.close();
  }
});

test('O06a 预置 passed + current 的检查记录仍能接受；检查器未接入不改变门槛', async () => {
  const userData = await mkdtemp(path.join(tmpdir(), 'wsl-e2e-acceptance-'));
  let { app, page } = await launchApp({ sbxBin, userData });
  let runId = '';
  try {
    await completeSessionRun(page, '预置检查通过用例');
    runId = (await workspaceSnapshot(page)).workspaces[0]!.runs.at(-1)!.runId;
  } finally {
    await app.close();
  }
  // 确定性 fixture：只改写这条运行的检查记录。应用写出 schema 5（OPS-1 R1）；预置文件按 schema 4 形状写回
  // （去掉 schema 5 新增的 taskProject / taskProjectDecided / autoTitle），重启时同时经过 4 → 5 迁移，检查记录与历史保持原义（O05g）。
  const file = path.join(userData, 'workbench.json');
  const stored = JSON.parse(await readFile(file, 'utf8')) as {
    schemaVersion: number;
    snapshot: {
      workspaces: Array<{
        runs: Array<{ runId: string; validation: unknown }>;
        tabs: Array<Record<string, unknown>>;
        sessions: Array<Record<string, unknown>>;
      }>;
    };
  };
  expect(stored.schemaVersion).toBe(5);
  const record = stored.snapshot.workspaces.flatMap((w) => w.runs).find((r) => r.runId === runId)!;
  record.validation = { state: 'passed', applicability: 'current', reason: null };
  stored.schemaVersion = 4;
  for (const workspace of stored.snapshot.workspaces) {
    for (const tab of workspace.tabs) delete tab['autoTitle'];
    for (const session of workspace.sessions) {
      delete session['taskProject'];
      delete session['taskProjectDecided'];
    }
  }
  const preset = JSON.stringify(stored);
  await writeFile(file, preset);

  ({ app, page } = await launchApp({ sbxBin, userData }));
  try {
    await openSessionTab(page);
    const region = sessionRegion(page);
    await region.getByRole('button', { name: '检查', exact: true }).click();
    await expect(region.locator('[data-status="validation:ok"]')).toHaveText('检查通过');
    // 能力仍是未接入：不提供运行检查，说明仍在；但接受只看检查记录。
    await expect(region.getByRole('button', { name: '运行检查' })).toHaveCount(0);
    await expect(region.getByText(CHECKER_NOTE).first()).toBeVisible();
    const accept = region.getByRole('button', { name: '接受结果', exact: true });
    await expect(accept).toBeEnabled();
    await accept.click();
    await expect(region.locator('[data-status="review:ok"]')).toHaveText('已接受');
    const run = (await workspaceSnapshot(page)).workspaces[0]!.runs.find((r) => r.runId === runId)!;
    expect(run.review).toMatchObject({ decision: 'accepted', candidateId: run.candidateId });
    // 迁移：原始 schema 4 字节另存为备份，工作台已原子替换为 schema 5。
    expect(await readFile(file + '.legacy-schema-4.json', 'utf8')).toBe(preset);
    expect((JSON.parse(await readFile(file, 'utf8')) as { schemaVersion: number }).schemaVersion).toBe(5);
  } finally {
    await app.close();
  }
});
