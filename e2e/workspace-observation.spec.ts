import { expect, test, type ElectronApplication, type Page } from '@playwright/test';
import { mkdtemp, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { tmpdir } from 'node:os';
import { launchApp, workspaceSnapshot, target, workshopNavigate, setWindowSize } from './helpers';

const fixture = new URL('./fixtures/sbx.mjs', import.meta.url).pathname;

async function useNarrowWindow(app: ElectronApplication, page: Page) {
  await setWindowSize(app, 1000, 720);
  await expect.poll(() => page.evaluate(() => window.innerWidth)).toBeLessThan(1080);
  await expect(page.getByRole('navigation', { name: 'Workshop 导航' })).not.toBeVisible();
}

async function showSpaceNavigation(page: Page) {
  const sidebar = page.getByRole('region', { name: '空间导航', exact: true });
  if (!(await sidebar.isVisible())) {
    await workshopNavigate(page, '空间');
    // Selecting a route closes a narrow-window overlay; reopen it for tab actions.
    if (!(await sidebar.isVisible())) await page.getByRole('button', { name: '展开 Workshop', exact: true }).click();
  }
  await expect(sidebar).toBeVisible();
}

test('本地文件明确绑定、只读读取、续读、后台重开及会话观察归属', async () => {
  const root = await mkdtemp(path.join(tmpdir(), 'wsl-ui-files-'));
  await writeFile(path.join(root, 'nonce.txt'), 'FILE_UI_NONCE_742\n' + '中'.repeat(12000));
  await writeFile(
    path.join(root, 'pixel.png'),
    Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+j5l8AAAAASUVORK5CYII=', 'base64'),
  );
  const { app, page } = await launchApp({ sbxBin: fixture, observationRoot: root });
  try {
    await useNarrowWindow(app, page);
    await showSpaceNavigation(page);
    await page.getByRole('button', { name: '新建标签', exact: true }).click();
    const editor = page.getByRole('dialog', { name: '新建标签' });
    await editor.getByLabel('标签类型').selectOption('file');
    await editor.getByLabel('名称', { exact: true }).fill('本地文件742');
    await expect(editor.getByRole('button', { name: '保存', exact: true })).toBeDisabled();
    await editor.getByLabel('资源环境').selectOption('local');
    await editor.getByRole('button', { name: '保存', exact: true }).click();
    const files = page.getByRole('region', { name: '只读文件浏览' });
    await files.getByRole('button', { name: '列出目录', exact: true }).click();
    await files.getByRole('button', { name: 'nonce.txt · file', exact: true }).click();
    await expect(files.getByRole('region', { name: '当前文件结果' })).toContainText('FILE_UI_NONCE_742');
    await expect(files.getByRole('region', { name: '当前文件结果' })).toContainText('版本 / 散列');
    await expect(files.getByRole('button', { name: '继续读取', exact: true })).toBeVisible();
    await files.getByRole('button', { name: '继续读取', exact: true }).click();
    await expect(files.getByRole('region', { name: '当前文件结果' })).toContainText('startByte');
    await files.getByLabel('文件路径').fill('pixel.png');
    await files.getByRole('button', { name: '读取文件', exact: true }).click();
    const current = files.getByRole('region', { name: '当前文件结果' });
    await expect(current.getByRole('img', { name: '只读文件图像' })).toBeVisible();
    expect(await current.getByRole('img').evaluate((image) => (image as HTMLImageElement).naturalWidth)).toBe(1);
    await current.getByText('结果详情', { exact: true }).click();
    await expect(current.locator('pre')).not.toContainText('iVBOR');
    await files.getByLabel('文件路径').fill('.');
    await files.getByLabel('文件搜索').fill('FILE_UI_NONCE_742');
    await files.getByRole('button', { name: '搜索文件', exact: true }).click();
    await files
      .getByRole('list', { name: '文件搜索结果' })
      .getByRole('button', { name: /nonce.txt:1/ })
      .click();
    await expect(current).toContainText('FILE_UI_NONCE_742');
    const before = await workspaceSnapshot(page);
    const workspace = before.workspaces.find((workspace) => workspace.workspaceId === before.activeWorkspaceId)!;
    const resource = workspace.resources.find((resource) => resource.title === '本地文件742')!;
    expect(resource.environmentId).toBe('local');
    expect(workspace.observations.every((record) => record.request.sessionId === null && record.request.runId === null)).toBe(true);
    await showSpaceNavigation(page);
    await page.getByRole('button', { name: '本地文件742操作', exact: true }).click();
    await page.getByRole('menuitem', { name: '关闭标签（保留后台执行）' }).click();
    await showSpaceNavigation(page);
    await page.getByText('后台资源 / 已关闭标签', { exact: true }).click();
    await page.getByRole('button', { name: '本地文件742 · 重新打开', exact: true }).click();
    expect(
      (await workspaceSnapshot(page)).workspaces
        .find((workspace) => workspace.workspaceId === before.activeWorkspaceId)!
        .resources.find((item) => item.title === '本地文件742')!.resourceId,
    ).toBe(resource.resourceId);
    await showSpaceNavigation(page);
    await page.getByRole('navigation', { name: '空间标签' }).getByRole('button', { name: 'Agent 会话', exact: true }).click();
    const session = page.getByRole('region', { name: 'Agent 会话内容' });
    await session.getByRole('button', { name: '上下文', exact: true }).click();
    const observation = session.getByRole('region', { name: '会话统一观察' });
    await observation.getByLabel('观察来源').selectOption(resource.resourceId);
    await observation.getByLabel('读取动作').selectOption('files.read');
    await observation.getByLabel('观察路径').fill('nonce.txt');
    await observation.getByRole('button', { name: '读取观察', exact: true }).click();
    await expect(observation.getByRole('region', { name: '当前观察结果' })).toContainText('FILE_UI_NONCE_742');
    const after = await workspaceSnapshot(page);
    const own = after.workspaces.find((workspace) => workspace.workspaceId === before.activeWorkspaceId)!;
    const record = own.sessions.find((session) => session.title === 'Agent 会话')!.observations.at(-1)!;
    expect(record.request.workspaceId).toBe(own.workspaceId);
    expect(record.request.sessionId).toBe(own.sessions.find((session) => session.title === 'Agent 会话')!.sessionId);
    expect(record.request.target!.resourceId).toBe(resource.resourceId);
    expect(record.request.runId).toBeNull();
    expect(own.runs).toHaveLength(0);
  } finally {
    await app.close();
  }
});

test('未配置环境明确禁用能力，不创建未授权文件标签', async () => {
  const { app, page } = await launchApp({ observationRoot: '' });
  try {
    await useNarrowWindow(app, page);
    await showSpaceNavigation(page);
    await page.getByRole('button', { name: '新建标签', exact: true }).click();
    const editor = page.getByRole('dialog', { name: '新建标签' });
    await editor.getByLabel('标签类型').selectOption('file');
    await editor.getByLabel('名称', { exact: true }).fill('不可用文件');
    await expect(editor).toContainText('未授权本地目录');
    await expect(editor.getByLabel('资源环境').locator('option[value="local"]')).toHaveAttribute('disabled', '');
    await expect(editor.getByRole('button', { name: '保存', exact: true })).toBeDisabled();
    await editor.getByRole('button', { name: '取消', exact: true }).click();
    expect((await workspaceSnapshot(page)).workspaces[0]!.resources.some((resource) => resource.title === '不可用文件')).toBe(false);
  } finally {
    await app.close();
  }
});

test('历史版本与运行选择联动，对话内容来自同一执行', async () => {
  const { app, page } = await launchApp({ sbxBin: fixture });
  try {
    await showSpaceNavigation(page);
    await page.getByRole('navigation', { name: '空间标签' }).getByRole('button', { name: 'Agent 会话', exact: true }).click();
    const session = page.getByRole('region', { name: 'Agent 会话内容' });
    for (const text of ['OLD_HISTORY_742', 'NEW_HISTORY_742']) {
      await session.getByRole('textbox', { name: '会话消息', exact: true }).fill(text);
      await session.getByRole('button', { name: '发送', exact: true }).click();
      await expect.poll(async () => (await workspaceSnapshot(page)).workspaces[0]!.runs.at(-1)?.state).toBe('completed');
    }
    const workspace = (await workspaceSnapshot(page)).workspaces[0]!;
    const first = workspace.runs[0]!;
    await session.getByRole('button', { name: '检查', exact: true }).click();
    await session.getByLabel('执行记录').selectOption(first.runId);
    await session.getByRole('button', { name: '任务', exact: true }).click();
    await expect(session.getByLabel('任务版本')).toHaveValue(first.taskVersionId);
    await session.getByLabel('任务版本').selectOption(workspace.runs[1]!.taskVersionId);
    await session.getByRole('button', { name: '对话', exact: true }).click();
    await expect(session.getByRole('log', { name: 'Codex 对话消息' })).toContainText('NEW_HISTORY_742');
    await expect(session.getByRole('log', { name: 'Codex 对话消息' })).not.toContainText('OLD_HISTORY_742');
    await session.getByRole('button', { name: '任务', exact: true }).click();
    await session.getByLabel('修改目标').fill('UNRUN_HISTORY_742');
    await session.getByRole('button', { name: '确认任务（生成新版本）', exact: true }).click();
    const unrun = (await workspaceSnapshot(page)).workspaces[0]!.sessions[0]!.taskVersions.at(-1)!;
    await session.getByLabel('任务版本').selectOption(unrun.taskVersionId);
    await session.getByRole('button', { name: '对话', exact: true }).click();
    await expect(session.getByRole('log', { name: 'Codex 对话消息' })).toContainText('此版本尚未运行');
    await expect(session.getByRole('log', { name: 'Codex 对话消息' })).not.toContainText('NEW_HISTORY_742');
  } finally {
    await app.close();
  }
});

test('环境目录失败保留新建表单和显式错误，不使用默认环境', async () => {
  const { app, page } = await launchApp();
  try {
    await app.evaluate(({ ipcMain }) => {
      const handlers = (ipcMain as unknown as { _invokeHandlers: Map<string, (...args: unknown[]) => unknown> })._invokeHandlers;
      const original = handlers.get('workbench:environments')!;
      let failed = false;
      ipcMain.removeHandler('workbench:environments');
      ipcMain.handle('workbench:environments', (...args) => {
        if (!failed) {
          failed = true;
          throw new Error('ENV_DIRECTORY_FAILED_742');
        }
        return original(...args);
      });
    });
    await showSpaceNavigation(page);
    await page.getByRole('button', { name: '新建标签', exact: true }).click();
    const editor = page.getByRole('dialog', { name: '新建标签' });
    await editor.getByLabel('名称', { exact: true }).fill('保留环境失败表单742');
    await editor.getByLabel('标签类型').selectOption('file');
    await expect(editor.getByRole('alert')).toContainText('ENV_DIRECTORY_FAILED_742');
    await expect(editor.getByLabel('名称', { exact: true })).toHaveValue('保留环境失败表单742');
    await expect(editor.getByLabel('资源环境')).toHaveValue('');
    await expect(editor.getByRole('button', { name: '保存', exact: true })).toBeDisabled();
    await editor.getByRole('button', { name: '重新加载环境', exact: true }).click();
    await expect(editor.getByRole('alert')).toHaveCount(0);
    await expect(editor.getByLabel('名称', { exact: true })).toHaveValue('保留环境失败表单742');
    await expect(editor.getByLabel('标签类型')).toHaveValue('file');
  } finally {
    await app.close();
  }
});

test('标签自落点不改变顺序，正常拖放保持排序入口', async () => {
  const { app, page } = await launchApp();
  try {
    await showSpaceNavigation(page);
    const before = (await workspaceSnapshot(page)).workspaces[0]!.tabs.map((tab) => tab.tabId);
    const rows = page.locator('.vertical-tab');
    await rows.first().dispatchEvent('dragstart');
    await rows.first().dispatchEvent('drop');
    expect((await workspaceSnapshot(page)).workspaces[0]!.tabs.map((tab) => tab.tabId)).toEqual(before);
    await rows.last().dispatchEvent('dragstart');
    await rows.first().dispatchEvent('drop');
    await expect
      .poll(async () => (await workspaceSnapshot(page)).workspaces[0]!.tabs.map((tab) => tab.tabId))
      .toEqual([before.at(-1), ...before.slice(0, -1)]);
  } finally {
    await app.close();
  }
});

test('本地同一PTY重复输出与保留窗口滚动仍更新终端显示', async () => {
  const root = await mkdtemp(path.join(tmpdir(), 'wsl-ui-terminal-'));
  const { app, page } = await launchApp({ observationRoot: root });
  try {
    await useNarrowWindow(app, page);
    await showSpaceNavigation(page);
    await page.getByRole('button', { name: '新建标签', exact: true }).click();
    const editor = page.getByRole('dialog', { name: '新建标签' });
    await editor.getByLabel('标签类型').selectOption('terminal');
    await editor.getByLabel('资源环境').selectOption('local');
    await editor.getByLabel('名称', { exact: true }).fill('本地增量终端742');
    await editor.getByRole('button', { name: '保存', exact: true }).click();
    const panel = page.getByRole('region', { name: '资源终端' });
    await panel.getByRole('button', { name: '连接终端', exact: true }).click();
    await expect(panel).toContainText('已连接');
    const input = panel.getByLabel('终端输入');
    await input.pressSequentially('printf "REPEATED_742\\nREPEATED_742\\n"');
    await input.press('Enter');
    await expect
      .poll(async () => panel.locator('.xterm-accessibility-tree').innerText())
      .toMatch(/(?:^|\n)REPEATED_742\nREPEATED_742(?:\n|$)/);
    await input.pressSequentially('printf "INCREMENTAL_743\\n"');
    await input.press('Enter');
    await expect.poll(async () => panel.locator('.xterm-accessibility-tree').innerText()).toMatch(/(?:^|\n)INCREMENTAL_743(?:\n|$)/);
    const workspaceId = (await workspaceSnapshot(page)).activeWorkspaceId;
    const resource = (await workspaceSnapshot(page)).workspaces
      .find((workspace) => workspace.workspaceId === workspaceId)!
      .resources.find((resource) => resource.title === '本地增量终端742')!;
    const instanceId = resource.instanceId;
    await input.pressSequentially("python3 -c \"print('x'*270000);print('AFTER_WINDOW_742')\"");
    await input.press('Enter');
    await expect
      .poll(
        async () =>
          (await workspaceSnapshot(page)).workspaces
            .find((workspace) => workspace.workspaceId === workspaceId)!
            .resources.find((item) => item.resourceId === resource.resourceId)!.terminal!.outputOffset,
      )
      .toBeGreaterThan(0);
    await expect(panel.locator('.xterm-accessibility-tree')).toContainText('AFTER_WINDOW_742');
    expect(
      (await workspaceSnapshot(page)).workspaces
        .find((workspace) => workspace.workspaceId === workspaceId)!
        .resources.find((item) => item.resourceId === resource.resourceId)!.instanceId,
    ).toBe(instanceId);
    await panel.getByRole('button', { name: '关闭终端', exact: true }).click();
    await expect(panel).toContainText('已关闭，所属进程已确认退出');
  } finally {
    await app.close();
  }
});

test('受控环境延迟：UI取消不启动Provider，换空间后的迟到观察仍归原会话', async () => {
  test.skip(target !== 'build', '此受控传输用例仅依赖build bootstrap；正常文件/观察用例仍覆盖packaged产品');
  const root = await mkdtemp(path.join(tmpdir(), 'wsl-ui-cancel-'));
  await writeFile(path.join(root, 'nonce.txt'), 'FROZEN_SPACE_NONCE_742');
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
    await showSpaceNavigation(page);
    await page.getByRole('button', { name: '新建标签', exact: true }).click();
    const editor = page.getByRole('dialog', { name: '新建标签' });
    await editor.getByLabel('标签类型').selectOption('file');
    await editor.getByLabel('资源环境').selectOption('local');
    await editor.getByLabel('名称', { exact: true }).fill('归属文件742');
    await editor.getByRole('button', { name: '保存', exact: true }).click();
    const initial = (await workspaceSnapshot(page)).workspaces[0]!;
    const resource = initial.resources.find((resource) => resource.title === '归属文件742')!;
    const owner = initial.sessions[0]!;
    await showSpaceNavigation(page);
    await page.getByRole('navigation', { name: '空间标签' }).getByRole('button', { name: 'Agent 会话', exact: true }).click();
    const session = page.getByRole('region', { name: 'Agent 会话内容' });
    await session.getByRole('button', { name: '上下文', exact: true }).click();
    const observation = session.getByRole('region', { name: '会话统一观察' });
    await observation.getByLabel('观察来源').selectOption(resource.resourceId);
    await observation.getByLabel('读取动作').selectOption('files.read');
    await observation.getByLabel('观察路径').fill('nonce.txt');
    await arm();
    await observation.getByRole('button', { name: '读取观察', exact: true }).click();
    await expect.poll(async () => (await workspaceSnapshot(page)).workspaces[0]!.sessions[0]!.observations.at(-1)?.state).toBe('pending');
    await observation.getByRole('button', { name: '取消观察', exact: true }).click();
    await expect(observation.getByRole('alert')).toContainText('已取消');
    await release();
    expect(
      await app.evaluate(() => (globalThis as unknown as { __wslObservationGate: { reads: number } }).__wslObservationGate.reads),
    ).toBe(0);
    await arm();
    await observation.getByRole('button', { name: '读取观察', exact: true }).click();
    await expect.poll(async () => (await workspaceSnapshot(page)).workspaces[0]!.sessions[0]!.observations.at(-1)?.state).toBe('pending');
    await page.getByRole('button', { name: '切换空间', exact: true }).click();
    await page.getByRole('dialog', { name: '切换空间' }).getByRole('button', { name: '新建空间', exact: true }).click();
    const create = page.getByRole('dialog', { name: '新建空间' });
    await create.getByLabel('名称', { exact: true }).fill('隔离目标空间742');
    await create.getByRole('button', { name: '保存', exact: true }).click();
    await expect(create).not.toBeVisible();
    await release();
    await expect
      .poll(
        async () =>
          (await workspaceSnapshot(page)).workspaces
            .find((workspace) => workspace.workspaceId === initial.workspaceId)!
            .sessions.find((session) => session.sessionId === owner.sessionId)!
            .observations.at(-1)?.state,
      )
      .toBe('completed');
    const after = await workspaceSnapshot(page);
    const target = after.workspaces.find((workspace) => workspace.workspaceId === after.activeWorkspaceId)!;
    expect(target.name).toBe('隔离目标空间742');
    expect(target.observations).toEqual([]);
    expect(target.sessions.flatMap((session) => session.observations)).toEqual([]);
    const record = after.workspaces
      .find((workspace) => workspace.workspaceId === initial.workspaceId)!
      .sessions.find((session) => session.sessionId === owner.sessionId)!
      .observations.at(-1)!;
    expect(record.request.workspaceId).toBe(initial.workspaceId);
    expect(record.request.sessionId).toBe(owner.sessionId);
    expect(record.request.target!.resourceId).toBe(resource.resourceId);
    expect(record.request.runId).toBeNull();
  } finally {
    await release();
    await app.close();
  }
});

test('程序IME确认不提交名称、文件路径或观察表单', async () => {
  const root = await mkdtemp(path.join(tmpdir(), 'wsl-ui-ime-'));
  const { app, page } = await launchApp({ observationRoot: root });
  try {
    await showSpaceNavigation(page);
    await page.getByRole('button', { name: '新建标签', exact: true }).click();
    const editor = page.getByRole('dialog', { name: '新建标签' });
    const name = editor.getByLabel('名称', { exact: true });
    await name.fill('中文文件742');
    await name.dispatchEvent('compositionstart');
    await name.press('Enter');
    await expect(editor).toBeVisible();
    await expect(name).toHaveValue('中文文件742');
    await name.dispatchEvent('compositionend');
    await editor.getByLabel('标签类型').selectOption('file');
    await editor.getByLabel('资源环境').selectOption('local');
    await editor.getByRole('button', { name: '保存', exact: true }).click();
    await expect(editor).not.toBeVisible();
    const files = page.getByRole('region', { name: '只读文件浏览' });
    const before = (await workspaceSnapshot(page)).workspaces[0]!.observations.length;
    const input = files.getByLabel('文件路径');
    // Start composition only after the dialog has restored focus and the user selects the input.
    await input.click();
    await expect(input).toBeFocused();
    await input.dispatchEvent('compositionstart');
    await input.press('Enter');
    expect((await workspaceSnapshot(page)).workspaces[0]!.observations).toHaveLength(before);
    await input.dispatchEvent('compositionend');
    await showSpaceNavigation(page);
    await page.getByRole('navigation', { name: '空间标签' }).getByRole('button', { name: 'Agent 会话', exact: true }).click();
    const session = page.getByRole('region', { name: 'Agent 会话内容' });
    await session.getByRole('button', { name: '上下文', exact: true }).click();
    const observation = session.getByRole('region', { name: '会话统一观察' });
    await observation
      .getByLabel('观察来源')
      .selectOption(
        (await workspaceSnapshot(page)).workspaces[0]!.resources.find((resource) => resource.title === '中文文件742')!.resourceId,
      );
    const query = observation.getByLabel('观察路径');
    await query.click();
    await expect(query).toBeFocused();
    await query.dispatchEvent('compositionstart');
    await query.press('Enter');
    expect((await workspaceSnapshot(page)).workspaces[0]!.sessions[0]!.observations).toEqual([]);
    await query.dispatchEvent('compositionend');
  } finally {
    await app.close();
  }
});
