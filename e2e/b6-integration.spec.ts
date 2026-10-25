import { mkdtemp, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { expect, test, type ElectronApplication, type Page, type TestInfo } from '@playwright/test';
import {
  browserState,
  chooseNativeMenuItem,
  dismissNativeMenu,
  launchApp,
  openNativeMenuWhen,
  openNewTabForm,
  paneMenu,
  pickNativeMenu,
  resourceCollection,
  setWindowSize,
  setWorkspaceTheme,
  workshopNavigate,
  workspaceSnapshot,
} from './helpers';
import { fullBrowserServer } from './fixtures/full-browser-server';

const sbxBin = new URL('./fixtures/sbx.mjs', import.meta.url).pathname;
const required = <T>(value: T | null | undefined): T => {
  if (value == null) throw new Error('缺少 B6 夹具数据');
  return value;
};
const tabs = (page: Page) => page.getByRole('navigation', { name: '空间标签' });
const sessionRegion = (page: Page) => page.getByRole('region', { name: 'Agent 会话内容', exact: true });
async function active(page: Page) {
  const snapshot = await workspaceSnapshot(page);
  return required(snapshot.workspaces.find((space) => space.workspaceId === snapshot.activeWorkspaceId));
}
async function showTabs(page: Page) {
  if (!(await tabs(page).isVisible())) await page.getByRole('button', { name: '展开 Workshop', exact: true }).click();
}
async function openSession(page: Page, title = 'Agent 会话') {
  await showTabs(page);
  const target = tabs(page).getByRole('button', { name: title, exact: true });
  await target.focus();
  await page.keyboard.press('Enter');
  await expect(sessionRegion(page)).toBeVisible();
}
async function captureElement(app: ElectronApplication, page: Page, selecting?: () => Promise<void>) {
  await pickNativeMenu(app, page.getByRole('button', { name: /^接收会话：/ }), 'Agent 会话');
  await page.getByRole('button', { name: '选择元素', exact: true }).click();
  await expect.poll(async () => (await browserState(page))?.picking).toBe(true);
  await selecting?.();
  await app.evaluate(async ({ BrowserWindow }) => {
    const view = BrowserWindow.getAllWindows()
      .flatMap((window) => window.contentView.children)
      .find((candidate) => 'webContents' in candidate && candidate.getVisible()) as Electron.WebContentsView | undefined;
    if (!view) throw new Error('没有可见的原生网页');
    const point: { x: number; y: number } = await view.webContents.executeJavaScript(
      `(() => { const r = document.querySelector('[data-testid="new-task"]').getBoundingClientRect(); return {x: Math.round(r.x+r.width/2), y: Math.round(r.y+r.height/2)}; })()`,
    );
    view.webContents.sendInputEvent({ type: 'mouseMove', ...point });
    view.webContents.sendInputEvent({ type: 'mouseDown', ...point, button: 'left', clickCount: 1 });
    view.webContents.sendInputEvent({ type: 'mouseUp', ...point, button: 'left', clickCount: 1 });
  });
  await expect
    .poll(async () => required((await active(page)).sessions.find((item) => item.title === 'Agent 会话')).captureRequest?.state)
    .toBe('completed');
  await openSession(page);
  await expect(sessionRegion(page).getByRole('group', { name: '页面引用', exact: true })).toContainText('新建任务');
}
async function screenshot(app: ElectronApplication, page: Page, info: TestInfo, name: string) {
  await page.screenshot({ path: info.outputPath(`${name}.renderer.png`) });
  const captured = await app.evaluate(async ({ BrowserWindow }) => {
    const window = BrowserWindow.getAllWindows()[0];
    if (!window) throw new Error('没有工作台窗口');
    const native = [];
    for (const child of window.contentView.children) {
      if (!('webContents' in child)) continue;
      const view = child as Electron.WebContentsView;
      const visible = view.getVisible();
      native.push({
        webContentsId: view.webContents.id,
        bounds: view.getBounds(),
        visible,
        png: visible ? (await view.webContents.capturePage()).toPNG().toString('base64') : null,
      });
    }
    return { png: (await window.capturePage()).toPNG().toString('base64'), native };
  });
  await writeFile(info.outputPath(`${name}.window.png`), Buffer.from(captured.png, 'base64'));
  await writeFile(
    info.outputPath(`${name}.native.json`),
    JSON.stringify(
      captured.native.map(({ png, ...metadata }) => ({ ...metadata, captured: png !== null })),
      null,
      2,
    ),
  );
  for (const view of captured.native)
    if (view.png) await writeFile(info.outputPath(`${name}.native-${view.webContentsId}.png`), Buffer.from(view.png, 'base64'));
}

test('B6 统一网页和本地终端观察：历史与重启保留证据，不发送、不改引用或草稿', async () => {
  const userData = await mkdtemp(path.join(tmpdir(), 'wsl-b6-history-'));
  const root = await mkdtemp(path.join(tmpdir(), 'wsl-b6-terminal-'));
  let running = await launchApp({ sbxBin, userData, observationRoot: root });
  try {
    let { app, page } = running;
    const form = await openNewTabForm(app, page, '终端');
    await form.getByLabel('名称', { exact: true }).fill('B6 本地终端');
    await form.getByLabel('资源环境').selectOption('local');
    await form.getByRole('button', { name: '保存', exact: true }).click();
    const terminal = page.getByRole('region', { name: '资源终端' });
    await terminal.getByRole('button', { name: '连接终端', exact: true }).click();
    await expect(terminal).toContainText('已连接');
    await terminal.getByLabel('终端输入').pressSequentially('printf "B6_HISTORY_NONCE\\n"');
    await terminal.getByLabel('终端输入').press('Enter');
    await expect(terminal.locator('.xterm-accessibility-tree')).toContainText('B6_HISTORY_NONCE');
    const space = await active(page);
    const terminalResource = required(space.resources.find((item) => item.title === 'B6 本地终端'));
    const web = required(space.resources.find((item) => item.kind === 'web'));
    await tabs(page).getByRole('button', { name: 'TaskFlow 预览', exact: true }).click();
    await captureElement(app, page);
    const composer = sessionRegion(page).getByRole('textbox', { name: '会话消息', exact: true });
    await composer.fill('B6 未发送草稿');
    await expect.poll(async () => required((await active(page)).sessions[0]).draft).toBe('B6 未发送草稿');
    const before = required((await active(page)).sessions[0]);
    await sessionRegion(page).getByRole('button', { name: '上下文', exact: true }).click();
    const observation = sessionRegion(page).getByRole('region', { name: '会话统一观察', exact: true });
    for (const [resourceId, tool] of [
      [web.resourceId, 'browser.snapshot'],
      [terminalResource.resourceId, 'terminal.read_output'],
    ]) {
      await observation.getByRole('combobox', { name: '观察来源', exact: true }).selectOption(required(resourceId));
      await observation.getByRole('combobox', { name: '读取动作', exact: true }).selectOption(required(tool));
      await observation.getByRole('button', { name: '读取观察', exact: true }).click();
      await expect
        .poll(async () => required((await active(page)).sessions[0]).observations.length)
        .toBe(tool === 'browser.snapshot' ? 1 : 2);
      await expect(observation.getByRole('region', { name: '当前观察结果', exact: true })).toContainText(
        tool === 'browser.snapshot' ? 'TaskFlow' : 'B6_HISTORY_NONCE',
      );
    }
    const records = required((await active(page)).sessions[0]).observations;
    expect(records.map((record) => record.state)).toEqual(['completed', 'completed']);
    for (const record of records) {
      expect(record.request).toMatchObject({ workspaceId: space.workspaceId, sessionId: before.sessionId, runId: null });
      expect(record.request.target?.instanceId).toBeTruthy();
    }
    const verify = async () => {
      const current = required((await active(page)).sessions.find((item) => item.sessionId === before.sessionId));
      expect(current.observations).toEqual(records);
      expect(current.draft).toBe(before.draft);
      expect(current.context).toEqual(before.context);
      expect(current.taskTargetRef).toEqual(before.taskTargetRef);
      expect((await active(page)).runs).toEqual(space.runs);
      const history = sessionRegion(page).locator('.observation-history');
      await history.locator(':scope > summary').click();
      const entries = history.locator(':scope > details');
      await expect(entries).toHaveCount(2);
      await entries.nth(0).locator(':scope > summary').click();
      await expect(entries.nth(0)).toContainText('B6_HISTORY_NONCE');
      await entries.nth(1).locator(':scope > summary').click();
      await expect(entries.nth(1)).toContainText('TaskFlow');
    };
    await verify();
    await app.close();
    running = await launchApp({ sbxBin, userData, observationRoot: root });
    ({ app, page } = running);
    await openSession(page);
    await sessionRegion(page).getByRole('button', { name: '上下文', exact: true }).click();
    await verify();
  } finally {
    await running.app.close();
  }
});

test('B6 任务设置冻结所选 Profile：活动执行隔离选择变化，写许可并发拒绝保留草稿，逐项允许和拒绝', async () => {
  const { app, page } = await launchApp({ sbxBin, fixtureAcpScenario: 'ask' });
  try {
    await expect
      .poll(
        async () =>
          (await page.evaluate(() => window.studio.chat.getStatus())).harnesses.find((item) => item.descriptor.harnessId === 'claude-code')
            ?.available,
      )
      .toBe(true);
    await workshopNavigate(page, '设置');
    await page.getByPlaceholder('标签，例如：工作账号').fill('B6 第二账号');
    await page.getByRole('button', { name: '新建', exact: true }).click();
    const profileRow = page.getByRole('table', { name: 'Profile 列表' }).getByRole('row').filter({ hasText: 'B6 第二账号' });
    await expect(profileRow).toContainText('已登录');
    const secondProfile = required(await profileRow.getAttribute('data-profile-id'));
    const profiles = await page.evaluate(() => window.studio.chat.profiles.get());
    expect(required(profiles.profiles.find((item) => item.profileId === secondProfile)).harnessId).toBe('claude-code');
    await workshopNavigate(page, '空间');
    await openSession(page);
    const firstId = required((await active(page)).sessions[0]).sessionId;
    const settings = () => sessionRegion(page).getByRole('group', { name: '任务设置', exact: true });
    await sessionRegion(page)
      .getByRole('button', { name: /^任务设置/ })
      .click();
    await settings().getByRole('combobox', { name: '执行 Agent', exact: true }).selectOption('claude-code|claude-code:default');
    const send = async (message: string) => {
      await sessionRegion(page).getByRole('textbox', { name: '会话消息', exact: true }).fill(message);
      await sessionRegion(page).getByRole('button', { name: '发送', exact: true }).click();
    };
    await send('B6 冻结账号');
    const permission = () => sessionRegion(page).getByRole('group', { name: '待决定的权限请求', exact: true });
    await expect(permission()).toContainText('获取 https://example.invalid/data');
    const frozen = required((await active(page)).runs.at(-1));
    expect(frozen.harness?.profileId).toBe('claude-code:default');
    await settings().getByRole('combobox', { name: '执行 Agent', exact: true }).selectOption(`claude-code|${secondProfile}`);
    await expect
      .poll(async () => required((await active(page)).sessions.find((item) => item.sessionId === firstId)).harnessSelection?.profileId)
      .toBe(secondProfile);
    expect(required((await active(page)).runs.find((run) => run.runId === frozen.runId)).harness).toEqual(frozen.harness);
    const sessionCount = (await active(page)).sessions.length;
    await page.getByRole('button', { name: '新建会话', exact: true }).click();
    await expect.poll(async () => (await active(page)).sessions.length).toBe(sessionCount + 1);
    const newSession = required((await active(page)).sessions.at(-1));
    await expect(sessionRegion(page).getByRole('heading', { name: newSession.title, exact: true })).toHaveCount(1);
    await sessionRegion(page).getByRole('button', { name: '对话', exact: true }).click();
    const newSettings = sessionRegion(page).getByRole('button', { name: /^任务设置/ });
    if ((await newSettings.getAttribute('aria-expanded')) !== 'true') await newSettings.click();
    await settings().getByRole('combobox', { name: '执行 Agent', exact: true }).selectOption('claude-code|claude-code:default');
    // Shared sandbox write ownership rejects before the per-Profile guard; application.test.ts covers that later guard.
    await send('B6 并发草稿');
    await expect(page.getByRole('alert').filter({ hasText: 'conflict: sandbox 工作区正被会话 「Agent 会话」' })).toBeVisible();
    expect((await active(page)).runs.map((run) => run.runId)).toEqual([frozen.runId]);
    await expect(sessionRegion(page).getByRole('textbox', { name: '会话消息', exact: true })).toHaveValue('B6 并发草稿');
    await openSession(page);
    await expect(permission().getByRole('button')).toHaveText(['允许一次', '拒绝']);
    await permission().getByRole('button', { name: '允许一次', exact: true }).click();
    await expect.poll(async () => required((await active(page)).runs.find((run) => run.runId === frozen.runId)).state).toBe('completed');
    expect(required((await active(page)).runs.find((run) => run.runId === frozen.runId)).conversation?.messages.at(-1)?.text).toBe(
      '决定：yes',
    );
    await send('B6 第二账号拒绝');
    await expect(permission()).toBeVisible();
    const deniedId = required((await active(page)).runs.at(-1)).runId;
    expect(required((await active(page)).runs.at(-1)).harness?.profileId).toBe(secondProfile);
    await permission().getByRole('button', { name: '拒绝', exact: true }).click();
    await expect.poll(async () => required((await active(page)).runs.find((run) => run.runId === deniedId)).state).toBe('completed');
    expect(required((await active(page)).runs.find((run) => run.runId === deniedId)).conversation?.messages.at(-1)?.text).toBe('决定：no');
  } finally {
    await app.close();
  }
});

for (const theme of ['light', 'dark', 'warm'] as const) {
  for (const width of [960, 1440]) {
    test(`B6 ${theme} ${width}：新增控件中文名称、实际 Tab 顺序和窗口截图`, async ({ browserName }, info) => {
      expect(browserName).toBe('chromium');
      const { app, page } = await launchApp({ sbxBin, sourceSnapshotFixture: true });
      try {
        await tabs(page).getByRole('button', { name: 'TaskFlow 预览', exact: true }).click();
        await paneMenu(app, page, '左右分屏');
        await openSession(page);
        const workspaceId = (await active(page)).workspaceId;
        const created = await page.evaluate(
          (workspaceId) => window.studio.workbench.command({ commandId: crypto.randomUUID(), workspaceId, type: 'createApp' }),
          workspaceId,
        );
        expect(created.ok).toBe(true);
        await setWorkspaceTheme(page, theme);
        if (width === 960) await page.getByRole('button', { name: '聚焦窗格 · TaskFlow 预览', exact: true }).click();
        await setWindowSize(app, width, 900);
        await expect(page.getByRole('button', { name: '选择元素', exact: true })).toBeVisible();
        await captureElement(app, page, () => screenshot(app, page, info, 'capture-selecting'));
        const region = sessionRegion(page);
        await region.getByRole('button', { name: /^任务设置/ }).click();
        const settings = region.getByRole('group', { name: '任务设置', exact: true });
        const scopes = settings.getByLabel('允许修改范围（每行一条）', { exact: true });
        await scopes.focus();
        for (const next of [
          settings.getByLabel('验收条件（每行一条）', { exact: true }),
          settings.getByRole('combobox', { name: '附加目标（文件 / 终端 / SSH）', exact: true }),
          settings.getByRole('combobox', { name: '执行 Agent', exact: true }),
        ]) {
          await page.keyboard.press('Tab');
          await expect(next).toBeFocused();
        }
        await screenshot(app, page, info, 'task-settings');
        await region.getByRole('button', { name: /^任务设置/ }).click();
        const reference = region.getByRole('group', { name: '页面引用', exact: true });
        await reference.getByTitle('查看引用详情', { exact: true }).click();
        await expect(reference.getByRole('img', { name: '引用元素截图', exact: true })).toBeVisible();
        await expect(region.getByRole('group', { name: '工程绑定', exact: true })).toBeVisible();
        await reference.getByTitle('查看引用详情', { exact: true }).focus();
        await page.keyboard.press('Tab');
        await expect(reference.getByRole('button', { name: /^移除引用：/ })).toBeFocused();
        const project = region.getByRole('group', { name: '工程绑定', exact: true });
        const appRecord = required((await active(page)).app);
        await page.keyboard.press('Tab');
        const enable = project.getByRole('button', { name: `开启工程：${appRecord.name}`, exact: true });
        await expect(enable).toBeFocused();
        await screenshot(app, page, info, 'reference-project-off');
        await enable.click();
        const remove = project.getByRole('button', { name: `移除工程：${appRecord.name}`, exact: true });
        await expect(remove).toBeVisible();
        await remove.focus();
        await page.keyboard.press('Tab');
        await expect(region.getByRole('textbox', { name: '会话消息', exact: true })).toBeFocused();
        await screenshot(app, page, info, 'reference-project-on');
        await remove.click();
        await expect(enable).toBeVisible();
        await reference.getByTitle('查看引用详情', { exact: true }).click();
        if (!(await tabs(page).isVisible())) await page.getByRole('button', { name: '展开 Workshop', exact: true }).click();
        const newWeb = page.getByRole('button', { name: '新建网页', exact: true });
        await newWeb.focus();
        for (const name of ['新建终端', '新建会话']) {
          await page.keyboard.press('Tab');
          await expect(page.getByRole('button', { name, exact: true })).toBeFocused();
        }
        const row = tabs(page).getByRole('button', { name: 'Agent 会话', exact: true });
        await row.focus();
        await row.press('F2');
        const rename = page.getByRole('form', { name: '重命名标签', exact: true });
        const input = rename.getByRole('textbox', { name: '标签名称', exact: true });
        await expect(input).toBeFocused();
        await page.keyboard.press('Tab');
        await expect(rename.getByRole('button', { name: '保存', exact: true })).toBeFocused();
        await page.keyboard.press('Tab');
        await expect(rename.getByRole('button', { name: '取消', exact: true })).toBeFocused();
        await screenshot(app, page, info, 'inline-rename');
        await page.keyboard.press('Escape');
        await row.hover();
        const close = tabs(page).getByRole('button', { name: '关闭标签 · Agent 会话', exact: true });
        await expect(close).toHaveCSS('opacity', '1');
        await row.focus();
        await page.keyboard.press('Tab');
        await expect(tabs(page).getByRole('button', { name: 'Agent 会话操作', exact: true })).toBeFocused();
        await page.keyboard.press('Tab');
        await expect(close).toBeFocused();
        await screenshot(app, page, info, 'hover-close');
        await page.getByRole('button', { name: '切换空间', exact: true }).click();
        const palette = page.getByRole('dialog', { name: '切换空间', exact: true });
        await expect(palette.getByRole('textbox', { name: '搜索空间或标签', exact: true })).toBeFocused();
        await expect(palette.getByRole('button', { name: '关闭空间切换器', exact: true })).toBeVisible();
        await screenshot(app, page, info, 'command-palette');
        await page.keyboard.press('Escape');
        expect((await active(page)).runs).toHaveLength(0);
      } finally {
        await app.close();
      }
    });
  }
}

test('B6 网页导航失败禁用正文快照，直接目录命令也拒绝且完整资源集合不变', async () => {
  const server = await fullBrowserServer();
  const { app, page } = await launchApp({ sbxBin });
  try {
    const navigate = async (url: string) => {
      const address = page.locator('input[id^="address-"]:visible');
      await address.fill(url);
      await address.press('Enter');
      await expect.poll(async () => (await browserState(page))?.loading).toBe(false);
    };
    await navigate(`${server.url}/`);
    await expect.poll(async () => (await browserState(page))?.page.url).toBe(`${server.url}/`);
    const more = () => page.getByRole('button', { name: '更多网页操作', exact: true }).click();
    await openNativeMenuWhen(app, more, '保存正文快照', true);
    await chooseNativeMenuItem(app, '保存正文快照');
    await expect.poll(async () => (await resourceCollection(page)).resources.length).toBe(1);
    const before = await resourceCollection(page);
    const catalogBefore = (await workspaceSnapshot(page)).catalog;
    await navigate(`${server.url}/disconnect`);
    await expect.poll(async () => (await browserState(page))?.loadError).toBeTruthy();
    await openNativeMenuWhen(app, more, '保存正文快照', false);
    await dismissNativeMenu(app);
    const space = await active(page);
    const resource = required(space.resources.find((item) => item.kind === 'web'));
    await expect(
      page.evaluate(
        ({ workspaceId, runtimeResourceId, catalogRevision }) =>
          window.studio.workbench.catalogCommand({
            commandId: crypto.randomUUID(),
            expectedCatalogRevision: catalogRevision,
            type: 'captureResourceRevision',
            workspaceId,
            runtimeResourceId,
          }),
        { workspaceId: space.workspaceId, runtimeResourceId: resource.resourceId, catalogRevision: required(catalogBefore).revision },
      ),
    ).rejects.toThrow('请等待网页成功加载后再保存正文快照');
    expect(await resourceCollection(page)).toEqual(before);
    expect((await workspaceSnapshot(page)).catalog).toEqual(catalogBefore);
  } finally {
    await app.close();
    await server.close();
  }
});
