import { expect, test, type ElectronApplication } from '@playwright/test';
import { launchApp, setWindowSize, workspaceSnapshot, workshopNavigate } from './helpers';

const fixture = new URL('./fixtures/sbx.mjs', import.meta.url).pathname;

async function menu(app: ElectronApplication, label: string) {
  return app.evaluate(({ Menu, BrowserWindow }, label) => {
    const find = (items: Electron.MenuItem[]): Electron.MenuItem | undefined => {
      for (const item of items) {
        if (item.label === label) return item;
        const child = item.submenu && find(item.submenu.items);
        if (child) return child;
      }
      return undefined;
    };
    const item = find(Menu.getApplicationMenu()?.items ?? []);
    if (!item) throw new Error(`Missing menu: ${label}`);
    item.click(undefined, BrowserWindow.getAllWindows()[0], undefined as never);
    return item.accelerator;
  }, label);
}

test('R1 可见导航进入真实任务历史，查看日志/diff/报告不执行', async () => {
  const { app, page } = await launchApp({ sbxBin: fixture });
  try {
    await page.getByRole('navigation', { name: '空间标签' }).getByRole('button', { name: 'Agent 会话', exact: true }).click();
    const session = page.getByRole('region', { name: 'Agent 会话内容' });
    await session.getByRole('textbox').fill('migration-history-742');
    await session.getByRole('button', { name: '发送', exact: true }).click();
    await expect.poll(async () => (await workspaceSnapshot(page)).workspaces[0]!.runs.at(-1)?.state).toBe('completed');
    const before = await workspaceSnapshot(page);
    await workshopNavigate(page, '任务');
    await expect(page.getByRole('navigation', { name: '任务与运行记录' })).toBeVisible();
    await page.getByRole('button', { name: /^运行 · migration-history-742/ }).click();
    for (const label of ['日志', 'diff', '报告']) {
      await page.getByRole('button', { name: label, exact: true }).click();
      await expect(page.getByRole('region', { name: '运行详情' })).toBeVisible();
    }
    const after = await workspaceSnapshot(page);
    expect(after.workspaces[0]!.runs).toEqual(before.workspaces[0]!.runs);
    await expect(page.getByText(/真实检查报告.*未/)).toBeVisible();
  } finally {
    await app.close();
  }
});

test('R2 通信栏菜单控制通知，独立专注入口控制布局', async () => {
  const { app, page } = await launchApp();
  try {
    await page.getByRole('button', { name: '左右分屏', exact: true }).click();
    expect(await menu(app, '显示或隐藏通知')).toBe('CmdOrCtrl+Alt+B');
    await expect(page.getByRole('region', { name: '通知' })).toBeVisible();
    await expect(page.locator('[data-pane-id]:visible')).toHaveCount(2);
    await menu(app, '显示或隐藏通知');
    await expect(page.getByRole('region', { name: '通知' })).not.toBeVisible();
    await menu(app, '专注模式');
    await expect(page.locator('[data-pane-id]:visible')).toHaveCount(1);
    await page.getByRole('button', { name: '恢复布局', exact: true }).click();
    await expect(page.locator('[data-pane-id]:visible')).toHaveCount(2);
  } finally {
    await app.close();
  }
});

test('R1 通知定位后台同一运行，打开与已读分离且重启保持回执', async () => {
  let { app, page } = await launchApp({ sbxBin: fixture });
  const profile = await app.evaluate(({ app }) => app.getPath('userData'));
  try {
    await page.getByRole('navigation', { name: '空间标签' }).getByRole('button', { name: 'Agent 会话', exact: true }).click();
    const session = page.getByRole('region', { name: 'Agent 会话内容' });
    await session.getByRole('textbox').fill('[delayed-complete] notification-owner-742');
    await session.getByRole('button', { name: '发送', exact: true }).click();
    await expect(session.getByRole('button', { name: '取消回复' })).toBeVisible();
    await page.getByRole('button', { name: 'Agent 会话操作' }).click();
    await page.getByRole('menuitem', { name: '关闭标签（保留后台执行）' }).click();
    await workshopNavigate(page, '首页');
    await expect.poll(async () => (await workspaceSnapshot(page)).workspaces[0]!.runs.at(-1)?.state).toBe('completed');
    const before = (await workspaceSnapshot(page)).workspaces[0]!.runs;
    const run = before.at(-1)!;
    await page.getByRole('button', { name: /^通知 · / }).click();
    const item = page.getByRole('region', { name: '通知' }).locator(`[data-run-id="${run.runId}"]`);
    await expect(item).toContainText('未读');
    await item.getByRole('button', { name: '打开运行', exact: true }).click();
    await expect(page.getByRole('region', { name: 'Agent 会话内容' })).toContainText(run.runId);
    expect((await workspaceSnapshot(page)).workspaces[0]!.runs).toEqual(before);
    await page.getByRole('button', { name: /^通知 · / }).click();
    await expect(item).toContainText('未读');
    await item.getByRole('button', { name: '标记已读', exact: true }).click();
    await expect(item).toContainText('已读');
    await app.close();
    ({ app, page } = await launchApp({ sbxBin: fixture, userData: profile }));
    await page.getByRole('button', { name: /^通知 · / }).click();
    await expect(page.getByRole('region', { name: '通知' }).locator(`[data-run-id="${run.runId}"]`)).toContainText('已读');
    expect((await workspaceSnapshot(page)).workspaces[0]!.runs.map((r) => r.runId)).toEqual(before.map((r) => r.runId));
  } finally {
    await app.close();
  }
});

test('R7 首页空间卡片由当前快照生成，按稳定身份切换', async () => {
  const { app, page } = await launchApp();
  try {
    await page.getByRole('button', { name: '切换空间', exact: true }).click();
    await page.getByRole('dialog', { name: '切换空间' }).getByRole('button', { name: '新建空间', exact: true }).click();
    const dialog = page.getByRole('dialog', { name: '新建空间' });
    await dialog.getByLabel('名称').fill('首页真实空间742');
    await dialog.getByRole('button', { name: '保存', exact: true }).click();
    await expect(dialog).not.toBeVisible();
    const id = (await workspaceSnapshot(page)).activeWorkspaceId;
    await workshopNavigate(page, '首页');
    const cards = page.getByRole('region', { name: '近期空间' });
    for (const workspace of (await workspaceSnapshot(page)).workspaces) {
      const card = cards.getByRole('button', { name: new RegExp(workspace.name) });
      await expect(card).toBeVisible();
      await expect(card).toContainText(`任务版本数 ${workspace.sessions.reduce((n, s) => n + s.taskVersions.length, 0)}`);
      await expect(card).toContainText(`运行 ${workspace.runs.length}`);
    }
    await cards.getByRole('button', { name: /首页真实空间742/ }).click();
    expect((await workspaceSnapshot(page)).activeWorkspaceId).toBe(id);
  } finally {
    await app.close();
  }
});

test('R4 单窗格窄窗从网页关联会话并采集', async () => {
  const { app, page } = await launchApp();
  try {
    await setWindowSize(app, 900, 700);
    await expect(page.locator('[data-pane-id]:visible')).toHaveCount(1);
    await page.getByLabel('关联会话').selectOption({ label: 'Agent 会话' });
    await page.getByRole('button', { name: '采集到关联会话', exact: true }).click();
    await expect(page.getByRole('button', { name: '选择中 · Esc 取消' })).toBeVisible();
    // Native contents receive input, rather than clicking the renderer placeholder.
    const web = (await workspaceSnapshot(page)).workspaces[0]!.resources.find((r) => r.kind === 'web')!;
    await app.evaluate(async ({ webContents }, id) => {
      const contents = webContents.fromId(id)!;
      const point = await contents.executeJavaScript(
        `(() => { const r = document.querySelector('[data-testid="due-1"]').getBoundingClientRect(); return { x: Math.round(r.x+r.width/2), y: Math.round(r.y+r.height/2) }; })()`,
      );
      contents.sendInputEvent({ type: 'mouseMove', ...point });
      await new Promise((resolve) => setTimeout(resolve, 120));
      contents.sendInputEvent({ type: 'mouseDown', ...point, button: 'left', clickCount: 1 });
      contents.sendInputEvent({ type: 'mouseUp', ...point, button: 'left', clickCount: 1 });
    }, web.preview!.page.webContentsId);
    await expect.poll(async () => (await workspaceSnapshot(page)).workspaces[0]!.sessions[0]!.context).not.toBeNull();
  } finally {
    await app.close();
  }
});

test('R3 双网页原生focus事件决定地址与刷新目标，布局更新保持焦点', async () => {
  const { app, page } = await launchApp();
  try {
    await page.getByRole('button', { name: '左右分屏', exact: true }).click();
    await page.getByRole('button', { name: '新建标签', exact: true }).click();
    const dialog = page.getByRole('dialog', { name: '新建标签' });
    await dialog.getByLabel('名称').fill('第二网页742');
    await dialog.getByRole('button', { name: '保存', exact: true }).click();
    await expect(dialog).not.toBeVisible();
    const secondResource = (await workspaceSnapshot(page)).workspaces[0]!.resources.find((r) => r.title === '第二网页742')!;
    await page.locator(`#address-${secondResource.resourceId}`).fill('wsl-demo://taskflow/members.html');
    await page.locator(`#address-${secondResource.resourceId}`).press('Enter');
    const snapshot = await workspaceSnapshot(page);
    const workspace = snapshot.workspaces[0]!;
    const web = workspace.resources.find((r) => r.title === 'TaskFlow 预览')!;
    await app.evaluate(({ webContents, BrowserWindow }, id) => {
      BrowserWindow.getAllWindows()[0]!.focus();
      const contents = webContents.fromId(id)!;
      contents.focus();
      contents.sendInputEvent({ type: 'mouseDown', x: 80, y: 80, button: 'left', clickCount: 1 });
      contents.sendInputEvent({ type: 'mouseUp', x: 80, y: 80, button: 'left', clickCount: 1 });
    }, web.preview!.page.webContentsId);
    const first = page.locator('[data-pane-id]').filter({ has: page.getByRole('button', { name: '聚焦窗格 · TaskFlow 预览' }) });
    await expect
      .poll(async () => (await workspaceSnapshot(page)).workspaces[0]!.activePaneId)
      .toBe(await first.getAttribute('data-pane-id'));
    await expect
      .poll(() => app.evaluate(({ webContents }, id) => webContents.fromId(id)!.isFocused(), web.preview!.page.webContentsId))
      .toBe(true);
    await setWindowSize(app, 1400, 880);
    await expect
      .poll(() => app.evaluate(({ webContents }, id) => webContents.fromId(id)!.isFocused(), web.preview!.page.webContentsId))
      .toBe(true);
    await menu(app, '编辑地址');
    await expect(page.locator(`#address-${web.resourceId}`)).toBeFocused();
    await menu(app, '重新加载 Browser 区页面');
    await expect
      .poll(
        async () =>
          (await workspaceSnapshot(page)).workspaces[0]!.resources.find((r) => r.resourceId === web.resourceId)!.preview!.page
            .documentGeneration,
      )
      .toBeGreaterThan(web.preview!.page.documentGeneration);
    await expect
      .poll(
        async () => (await workspaceSnapshot(page)).workspaces[0]!.resources.find((r) => r.resourceId === web.resourceId)!.preview!.loading,
      )
      .toBe(false);
    const ownedFrontend = () =>
      app.evaluate(async ({ BrowserWindow, webContents }, id) => {
        const tools = webContents.fromId(id)!.devToolsWebContents;
        if (!tools || tools.isDestroyed()) return null;
        const window = BrowserWindow.fromWebContents(tools);
        return {
          id: tools.id,
          visible: window?.isVisible() ?? false,
          url: tools.getURL(),
          ready: await tools.executeJavaScript("document.readyState === 'complete' && !!document.querySelector('.root-view')"),
        };
      }, web.preview!.page.webContentsId);
    await menu(app, '打开 Browser 区页面 DevTools');
    await expect
      .poll(async () => {
        const f = await ownedFrontend();
        return !!f?.visible && f.ready && f.url.startsWith('devtools://devtools/bundled/devtools_app.html');
      })
      .toBe(true);
    expect(
      await app.evaluate(
        ({ webContents }, id) => webContents.fromId(id)!.devToolsWebContents?.id ?? null,
        secondResource.preview!.page.webContentsId,
      ),
    ).toBeNull();
    const oldDevToolsId = (await ownedFrontend())!.id;
    await app.evaluate(
      ({ BrowserWindow, webContents }, id) => BrowserWindow.fromWebContents(webContents.fromId(id)!)!.close(),
      oldDevToolsId,
    );
    await expect.poll(() => app.evaluate(({ webContents }, id) => webContents.fromId(id)?.isDestroyed() ?? true, oldDevToolsId)).toBe(true);
    await menu(app, '打开 Browser 区页面 DevTools');
    await expect
      .poll(async () => {
        const f = await ownedFrontend();
        return !!f?.visible && f.ready && f.id !== oldDevToolsId && f.url.startsWith('devtools://devtools/bundled/devtools_app.html');
      })
      .toBe(true);
    expect(
      await app.evaluate(
        ({ webContents }, id) => webContents.fromId(id)!.devToolsWebContents?.id ?? null,
        secondResource.preview!.page.webContentsId,
      ),
    ).toBeNull();
  } finally {
    await app.close();
  }
});

test('E2E 异常门槛负控：启动阶段异常必须失败', async () => {
  const { app } = await launchApp({ startupError: 'WSL_STARTUP_NEGATIVE_CONTROL' });
  await expect(app.close()).rejects.toThrow('Workbench renderer exceptions/errors');
});

test('E2E 异常门槛负控：运行期异常必须失败', async () => {
  const { app, page } = await launchApp();
  await page.evaluate(() => {
    setTimeout(() => {
      throw new Error('WSL_LATE_NEGATIVE_CONTROL');
    }, 0);
  });
  await expect
    .poll(async () => app.evaluate(() => (globalThis as unknown as { __wslRendererErrors: string[] }).__wslRendererErrors.length))
    .toBeGreaterThan(0);
  await expect(app.close()).rejects.toThrow('Workbench renderer exceptions/errors');
});
