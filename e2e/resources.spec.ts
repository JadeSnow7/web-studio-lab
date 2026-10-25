import { createHash } from 'node:crypto';
import { mkdtemp, readFile, mkdir, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { expect, test, type ElectronApplication, type Page } from '@playwright/test';
import {
  chooseNativeMenuItem,
  dismissNativeMenu,
  launchApp,
  openBrowserMenu,
  openNativeMenuWhen,
  openNewTabForm,
  tabMenu,
  workshopNavigate,
  workspaceSnapshot,
  setWindowSize,
  windowShots,
} from './helpers';
import { controlledResourceNetwork } from './resource-network-fixture';
let app: ElectronApplication, page: Page;
test.afterEach(async () => {
  if (app) await app.close();
});
async function favorite(title: string, url = 'https://example.com') {
  await page.getByLabel('资源名称', { exact: true }).fill(title);
  await page.getByLabel('网页链接', { exact: true }).fill(url);
  await page.getByRole('button', { name: '收藏链接', exact: true }).click();
  await expect(page.getByLabel('资源名称', { exact: true })).toHaveValue('');
}

/** 网页工具栏「⋯ 更多网页操作」（Main 原生菜单，OPS-1 S5）。 */
const moreWebActions = () => page.getByRole('button', { name: '更多网页操作', exact: true }).click();

async function resourceSection() {
  const section = page.locator('.space-resource-section');
  if (!(await section.evaluate((node) => (node as HTMLDetailsElement).open))) await section.locator('summary').click();
  return section;
}
async function createSpace(name: string) {
  await workshopNavigate(page, '首页');
  await page.getByRole('button', { name: '新建空间', exact: true }).click();
  await page.getByLabel('名称', { exact: true }).fill(name);
  await page.getByRole('button', { name: '保存', exact: true }).click();
}
test('account favorite→A/B connections→explicit frozen personal reference→restart, using real Main', async () => {
  const userData = await mkdtemp(path.join(os.tmpdir(), 'wsl-resource-ui-'));
  ({ app, page } = await launchApp({ userData, codexBin: path.resolve('e2e/fixtures/codex.mjs') }));
  await controlledResourceNetwork(app);
  await workshopNavigate(page, '资源');
  await expect(page.getByRole('heading', { name: '我的资源', exact: true })).toBeVisible();
  await favorite('跨空间资料');
  let state = await workspaceSnapshot(page);
  const id = state.catalog!.library[0]!.resourceId;
  expect(state.catalog!.links.some((link) => link.resourceId === id)).toBe(false);
  expect(state.catalog!.resources.find((item) => item.resourceId === id)!.descriptor).toEqual({ kind: 'web', url: 'https://example.com/' });
  expect(
    await app.evaluate(() => (globalThis as typeof globalThis & { resourceNetwork: { requests: string[] } }).resourceNetwork.requests),
  ).toEqual([]);
  await page.getByRole('button', { name: '跨空间资料', exact: true }).click();
  await page.getByLabel('目标空间').selectOption('taskflow-demo');
  await page.getByRole('button', { name: '连接到空间', exact: true }).click();
  state = await workspaceSnapshot(page);
  expect(state.workspaces[0]!.resources.some((item) => item.catalogResourceId === id)).toBe(false);
  expect(state.catalog!.links.find((link) => link.resourceId === id)!.referenceVersion).toBeNull();
  await page.getByRole('button', { name: '在空间打开', exact: true }).click();
  await expect(page.getByLabel('页面地址').filter({ visible: true })).toHaveValue('https://example.com/');
  await openNativeMenuWhen(app, moreWebActions, '保存正文快照', true);
  await chooseNativeMenuItem(app, '保存正文快照');
  await expect
    .poll(async () => (await workspaceSnapshot(page)).catalog!.resources.find((item) => item.resourceId === id)!.versions)
    .toEqual([1]);
  expect(
    await app.evaluate(async ({ BrowserWindow }) => {
      const view = (BrowserWindow.getAllWindows()[0]!.contentView.children as Electron.WebContentsView[]).find(
        (candidate) => candidate.getVisible() && candidate.webContents.getURL() === 'https://example.com/',
      );
      if (!view) throw new Error('controlled resource page is not visible');
      return view.webContents.executeJavaScript(
        '({ executed: window.untrustedExecuted, require: typeof require, process: typeof process, studio: typeof window.studio })',
      );
    }),
  ).toEqual({ executed: true, require: 'undefined', process: 'undefined', studio: 'undefined' });
  await openBrowserMenu(app, page, '更多网页操作', '查看空间资源');
  const section = await resourceSection();
  await expect(section).toHaveAttribute('open', '');
  await section.getByLabel('跨空间资料会话参考').selectOption('1');
  await section.getByLabel('跨空间资料会话参考').scrollIntoViewIfNeeded();
  await windowShots(app, page, 'resource-ownership-space-connections');
  const a = (await workspaceSnapshot(page)).workspaces[0]!.resources.find((item) => item.catalogResourceId === id)!;
  await createSpace('空间B');
  await workshopNavigate(page, '资源');
  await page.getByRole('button', { name: '跨空间资料', exact: true }).click();
  const b = (await workspaceSnapshot(page)).workspaces.find((workspace) => workspace.name === '空间B')!;
  await page.getByLabel('目标空间').selectOption(b.workspaceId);
  await page.getByRole('button', { name: '连接到空间', exact: true }).click();
  await page.getByRole('button', { name: '在空间打开', exact: true }).click();
  await openNativeMenuWhen(app, moreWebActions, '保存正文快照', true);
  await dismissNativeMenu(app);
  state = await workspaceSnapshot(page);
  const bindingB = state.workspaces
    .find((workspace) => workspace.workspaceId === b.workspaceId)!
    .resources.find((item) => item.catalogResourceId === id)!;
  expect(bindingB.resourceId).not.toBe(a.resourceId);
  expect(bindingB.instanceId).not.toBe(a.instanceId);
  await workshopNavigate(page, '会话');
  await page.locator('.personal-references:visible summary').click();
  await page.getByLabel('收藏参考', { exact: true }).filter({ visible: true }).selectOption(id);
  await page.getByLabel('个人参考版本', { exact: true }).filter({ visible: true }).selectOption('1');
  await page.getByRole('button', { name: '加入本轮参考', exact: true }).click();
  await expect(page.locator('.personal-references:visible')).toContainText('跨空间资料 · v1');
  await windowShots(app, page, 'resource-ownership-personal-reference');
  await workshopNavigate(page, '空间');
  await app.evaluate(() => {
    (globalThis as typeof globalThis & { resourceNetwork: { body: string } }).resourceNetwork.body = 'RESOURCE BODY V2';
  });
  await page.getByRole('button', { name: '刷新页面', exact: true }).click();
  await openNativeMenuWhen(app, moreWebActions, '保存正文快照', true);
  await chooseNativeMenuItem(app, '保存正文快照');
  await expect
    .poll(async () => (await workspaceSnapshot(page)).catalog!.resources.find((item) => item.resourceId === id)!.versions)
    .toEqual([1, 2]);
  await workshopNavigate(page, '会话');
  await expect(page.locator('.personal-references:visible')).toContainText('跨空间资料 · v1');
  await app.evaluate(({ ipcMain }) => {
    type H = (...args: unknown[]) => unknown;
    const original = (ipcMain as unknown as { _invokeHandlers: Map<string, H> })._invokeHandlers.get('chat:send')!;
    ipcMain.removeHandler('chat:send');
    ipcMain.handle('chat:send', (...args) => {
      (globalThis as typeof globalThis & { sentReferences: unknown }).sentReferences = (args[1] as { references: unknown }).references;
      return original(...args);
    });
  });
  await page.locator('textarea:visible').fill('验证收藏参考');
  await page.getByRole('button', { name: '发送', exact: true }).filter({ visible: true }).click();
  await expect
    .poll(() => app.evaluate(() => (globalThis as typeof globalThis & { sentReferences: unknown }).sentReferences))
    .toEqual([{ resourceId: id, version: 1 }]);

  await workshopNavigate(page, '资源');
  await page.getByRole('button', { name: '跨空间资料', exact: true }).click();
  await page.getByLabel('正文版本', { exact: true }).selectOption('1');
  await page.getByRole('button', { name: '读取正文', exact: true }).click();
  await expect(page.locator('.resource-body')).toContainText('RESOURCE BODY V1');
  await windowShots(app, page, 'resource-ownership-my-resources');
  await page.getByRole('button', { name: '删除资源', exact: true }).click();
  await page.getByRole('dialog').getByRole('button', { name: '删除资源', exact: true }).click();
  await expect(page.getByRole('dialog')).toBeVisible();
  await expect(page.getByRole('dialog').getByRole('alert')).toBeVisible();
  await page.getByRole('dialog').getByRole('button', { name: '取消', exact: true }).click();
  await page.getByRole('button', { name: '取消收藏', exact: true }).click();
  await expect(page.getByRole('heading', { name: '我的资源', exact: true })).toBeFocused();
  state = await workspaceSnapshot(page);
  expect(state.catalog!.library).toHaveLength(0);
  expect(state.catalog!.links.filter((link) => link.resourceId === id)).toHaveLength(2);
  await workshopNavigate(page, '空间');
  await tabMenu(app, page, '跨空间资料', '关闭标签（保留后台执行）');
  const oldHandles = state.workspaces
    .flatMap((workspace) => workspace.resources)
    .flatMap((item) => (item.instanceId ? [item.instanceId] : []));
  const oldRunIds = state.workspaces.flatMap((workspace) => workspace.runs).map((run) => run.runId);
  await app.close();
  const persisted = JSON.parse(await readFile(path.join(userData, 'workbench.json'), 'utf8'));
  expect(
    persisted.snapshot.workspaces
      .flatMap((workspace: { resources: { instanceId: string | null }[] }) => workspace.resources)
      .every((item: { instanceId: string | null }) => item.instanceId === null),
  ).toBe(true);
  ({ app, page } = await launchApp({ userData }));
  state = await workspaceSnapshot(page);
  expect(state.catalog!.resources.find((item) => item.resourceId === id)!.versions).toEqual([1, 2]);
  expect(
    state.workspaces
      .flatMap((workspace) => workspace.resources)
      .filter((item) => item.instanceId)
      .every((item) => item.kind === 'web' && !oldHandles.includes(item.instanceId!)),
  ).toBe(true);
  expect(state.workspaces.flatMap((workspace) => workspace.runs).map((run) => run.runId)).toEqual(oldRunIds);
  expect(state.catalog!.links.filter((link) => link.resourceId === id)).toHaveLength(2);
  await workshopNavigate(page, '空间');
  const reopened = await resourceSection();
  const row = reopened.locator('article').filter({ hasText: '跨空间资料' });
  await controlledResourceNetwork(app);
  await row.getByRole('button', { name: '打开', exact: true }).click();
  await openNativeMenuWhen(app, moreWebActions, '保存正文快照', true);
  await dismissNativeMenu(app);
  const restored = (await workspaceSnapshot(page)).workspaces
    .find((workspace) => workspace.workspaceId === b.workspaceId)!
    .resources.find((resource) => resource.catalogResourceId === id)!;
  expect(restored.instanceId).not.toBe(bindingB.instanceId);
  expect(restored.generation).toBeGreaterThan(bindingB.generation);
  await row.getByRole('button', { name: '解除连接', exact: true }).click();
  await expect(reopened.getByRole('alert')).toBeVisible();
  await tabMenu(app, page, '跨空间资料', '关闭标签（保留后台执行）');
  await page.getByText('后台资源 / 已关闭标签', { exact: true }).click();
  const background = page.locator('.background-resources .stack-8').filter({ hasText: '跨空间资料' });
  await background.getByRole('button', { name: '关闭网页实例', exact: true }).click();
  await expect(background).toContainText('无运行实例');
  await row.getByRole('button', { name: '解除连接', exact: true }).click();
  await expect(row).toHaveCount(0);
  state = await workspaceSnapshot(page);
  expect(state.catalog!.links.filter((link) => link.resourceId === id)).toHaveLength(1);
  expect(
    state.workspaces
      .find((workspace) => workspace.workspaceId === 'taskflow-demo')!
      .resources.some((resource) => resource.catalogResourceId === id),
  ).toBe(true);
});
test('collection search, paging, IME, deletion recovery, focus and narrow dark UI', async () => {
  ({ app, page } = await launchApp());
  await workshopNavigate(page, '资源');
  await expect(page.getByText('还没有收藏资源。', { exact: false })).toBeVisible();
  await page.getByRole('button', { name: '收藏链接', exact: true }).click();
  await expect(page.getByLabel('资源名称', { exact: true })).toBeFocused();
  await page.getByLabel('资源名称', { exact: true }).fill('IME保留');
  await page.getByLabel('网页链接', { exact: true }).fill('https://example.com/ime');
  await page.getByLabel('资源名称', { exact: true }).dispatchEvent('compositionstart');
  await page.getByLabel('资源名称', { exact: true }).press('Enter');
  expect((await workspaceSnapshot(page)).catalog!.library).toHaveLength(0);
  await page.getByLabel('资源名称', { exact: true }).dispatchEvent('compositionend');
  for (let i = 0; i < 11; i++) await favorite('收藏' + i, 'https://example.com/' + i);
  await page.getByRole('button', { name: '下一页', exact: true }).click();
  await expect(page.getByRole('button', { name: '收藏10', exact: true })).toBeVisible();
  await page.getByLabel('搜索收藏').fill('不存在');
  await expect(page.getByText('没有符合条件的收藏。', { exact: false })).toBeVisible();
  await page.getByRole('button', { name: '清除搜索', exact: true }).click();
  await expect(page.getByLabel('搜索收藏')).toBeFocused();
  await page.getByLabel('资源分类').selectOption('development');
  await expect(page.getByText('没有符合条件的收藏。', { exact: false })).toBeVisible();
  await page.getByLabel('资源分类').selectOption('all');
  await page.getByRole('button', { name: '收藏0', exact: true }).click();
  await page.getByLabel('修改资源名称').fill('长标题'.repeat(100));
  await page.getByRole('button', { name: '保存名称', exact: true }).click();
  await expect(page.getByRole('heading', { name: '长标题'.repeat(100), exact: true })).toBeVisible();
  await setWindowSize(app, 760, 700);
  await page.evaluate(() => (document.documentElement.dataset.theme = 'dark'));
  await expect(page.getByRole('heading', { name: '我的资源', exact: true })).toBeVisible();
  await page.getByRole('heading', { name: '我的资源', exact: true }).scrollIntoViewIfNeeded();
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBe(true);
  await windowShots(app, page, 'resource-ownership-narrow-dark-top');
  await page.getByRole('heading', { name: '长标题'.repeat(100), exact: true }).scrollIntoViewIfNeeded();
  await windowShots(app, page, 'resource-ownership-narrow-dark-detail');
  await page.getByRole('button', { name: '删除资源', exact: true }).click();
  await expect(page.getByRole('dialog').getByRole('button', { name: '取消', exact: true })).toBeFocused();
  await page.keyboard.press('Escape');
  await expect(page.getByRole('dialog')).toHaveCount(0);
  await expect(page.getByRole('button', { name: '删除资源', exact: true })).toBeFocused();
  await page.getByRole('button', { name: '删除资源', exact: true }).click();
  await page.getByRole('dialog').getByRole('button', { name: '删除资源', exact: true }).click();
  await expect(page.getByRole('dialog')).toHaveCount(0);
  await expect(page.getByRole('heading', { name: '我的资源', exact: true })).toBeFocused();
});
test('file and development entries can be explicitly favorited, classified and reopened in their authorized environment', async () => {
  ({ app, page } = await launchApp({
    sbxBin: path.resolve('e2e/fixtures/sbx.mjs'),
    observationRoot: await mkdtemp(path.join(os.tmpdir(), 'wsl-entry-root-')),
  }));
  await workshopNavigate(page, '空间');
  for (const [kind, title, environment] of [
    ['file', '我的文件入口', 'local'],
    ['terminal', '我的开发入口', 'local'],
  ] as const) {
    const editor = await openNewTabForm(app, page, kind === 'file' ? '文件' : '终端');
    await expect(editor.getByLabel('标签类型')).toHaveValue(kind);
    await editor.getByLabel('名称', { exact: true }).fill(title);
    await editor.getByLabel('资源环境').selectOption(environment);
    await editor.getByRole('button', { name: '保存', exact: true }).click();
    const section = await resourceSection();
    await section.locator('article').filter({ hasText: title }).getByRole('button', { name: '收藏', exact: true }).click();
  }
  await page.getByRole('navigation', { name: '空间标签' }).getByRole('button', { name: '我的文件入口', exact: true }).click();
  await page.getByRole('button', { name: '列出目录', exact: true }).click();
  await expect(page.getByRole('region', { name: '当前文件结果' })).toContainText('版本 / 散列');
  await tabMenu(app, page, '我的文件入口', '关闭标签（保留后台执行）');
  await page.getByText('后台资源 / 已关闭标签', { exact: true }).click();
  const stoppedFile = page.locator('.background-resources .stack-8').filter({ hasText: '我的文件入口' });
  await stoppedFile.getByRole('button', { name: '关闭文件观察', exact: true }).click();
  await expect(stoppedFile).toContainText('无运行实例');
  await workshopNavigate(page, '资源');
  await page.getByLabel('资源分类').selectOption('document');
  await expect(page.getByRole('button', { name: '我的文件入口', exact: true })).toBeVisible();
  await expect(page.getByRole('button', { name: '我的开发入口', exact: true })).toHaveCount(0);
  await page.getByRole('button', { name: '我的文件入口', exact: true }).click();
  await expect(page.getByText('此资源保存入口描述，可在已授权环境中重新打开。', { exact: true })).toBeVisible();
  await page.getByLabel('目标空间').selectOption('taskflow-demo');
  await page.getByRole('button', { name: '在空间打开', exact: true }).click();
  await expect(page.getByLabel('文件路径', { exact: true })).toHaveValue('.');
  await workshopNavigate(page, '资源');
  await page.getByLabel('资源分类').selectOption('development');
  await expect(page.getByRole('button', { name: '我的开发入口', exact: true })).toBeVisible();
  await page.getByRole('button', { name: '我的开发入口', exact: true }).click();
  await page.getByLabel('目标空间').selectOption('taskflow-demo');
  await page.getByRole('button', { name: '在空间打开', exact: true }).click();
  const state = await workspaceSnapshot(page);
  const entry = state.workspaces[0]!.resources.find((resource) => resource.title === '我的开发入口')!;
  expect(entry.environmentId).toBe('local');
  expect(entry.terminal?.state).not.toBe('running');
});

test('a delayed space switch after opening a favorite cannot steal a newer route', async () => {
  ({ app, page } = await launchApp());
  await workshopNavigate(page, '资源');
  await favorite('迟到打开');
  await page.getByRole('button', { name: '迟到打开', exact: true }).click();
  await page.getByLabel('目标空间').selectOption('taskflow-demo');
  await page.getByRole('button', { name: '连接到空间', exact: true }).click();
  await app.evaluate(({ ipcMain }) => {
    type H = (...args: unknown[]) => unknown;
    const original = (ipcMain as unknown as { _invokeHandlers: Map<string, H> })._invokeHandlers.get('workbench:command')!;
    ipcMain.removeHandler('workbench:command');
    ipcMain.handle('workbench:command', async (...args) => {
      const result = await original(...args);
      if ((args[1] as { type: string }).type === 'switchWorkspace')
        await new Promise<void>((resolve) => {
          (globalThis as typeof globalThis & { releaseResourceSwitch: () => void }).releaseResourceSwitch = resolve;
        });
      return result;
    });
  });
  await page.getByRole('button', { name: '在空间打开', exact: true }).click();
  await expect
    .poll(() => app.evaluate(() => typeof (globalThis as typeof globalThis & { releaseResourceSwitch?: () => void }).releaseResourceSwitch))
    .toBe('function');
  await workshopNavigate(page, '任务');
  await app.evaluate(() => (globalThis as typeof globalThis & { releaseResourceSwitch: () => void }).releaseResourceSwitch());
  await expect(page.getByRole('navigation', { name: 'Workshop 导航' }).getByRole('button', { name: '任务', exact: true })).toHaveAttribute(
    'aria-current',
    'page',
  );
});

test('legacy sparse v4 is the only selectable body version after import', async () => {
  const userData = await mkdtemp(path.join(os.tmpdir(), 'wsl-sparse-version-'));
  await mkdir(path.join(userData, 'chat'));
  const text = 'LEGACY V4';
  const hash = createHash('sha256').update(text).digest('hex');
  const resourceId = '10000000-0000-4000-8000-000000000004';
  await writeFile(
    path.join(userData, 'chat', 'space-resources.json'),
    JSON.stringify({
      schemaVersion: 1,
      collections: [
        {
          spaceId: 'taskflow-demo',
          revision: 4,
          resources: [
            {
              spaceId: 'taskflow-demo',
              resourceId,
              version: 4,
              requestedUrl: 'https://example.com/doc',
              url: 'https://example.com/doc',
              title: '历史正文4',
              text,
              capturedAt: '2026-10-10T00:00:00.000Z',
              sourceSha256: hash,
              contentSha256: hash,
              truncated: false,
              extractionVersion: 'html-text-v1',
              page: { webContentsId: 1, documentGeneration: 1, url: 'https://example.com/doc', title: '历史正文4', partition: 'fixture' },
            },
          ],
        },
      ],
    }),
  );
  ({ app, page } = await launchApp({ userData, codexBin: path.resolve('e2e/fixtures/codex.mjs') }));
  await workshopNavigate(page, '空间');
  const section = await resourceSection();
  const row = section.locator('article').filter({ hasText: '历史正文4' });
  expect(await row.getByRole('combobox').locator('option').allTextContents()).toEqual(['不作为参考', 'v4']);
  await row.getByRole('button', { name: '收藏', exact: true }).click();
  await workshopNavigate(page, '资源');
  await page.getByRole('button', { name: '历史正文4', exact: true }).click();
  expect(await page.getByLabel('正文版本', { exact: true }).locator('option').allTextContents()).toEqual(['v4']);
  await page.getByRole('button', { name: '读取正文', exact: true }).click();
  await expect(page.locator('.resource-body')).toContainText(text);
  await workshopNavigate(page, '会话');
  await page.locator('.personal-references:visible summary').click();
  await page.getByLabel('收藏参考', { exact: true }).filter({ visible: true }).selectOption(resourceId);
  expect(await page.getByLabel('个人参考版本', { exact: true }).filter({ visible: true }).locator('option').allTextContents()).toEqual([
    '选择明确版本',
    'v4',
  ]);
});
