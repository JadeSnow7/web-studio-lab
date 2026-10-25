import { mkdir, writeFile } from 'node:fs/promises';
import type { WorkbenchSnapshot, WorkbenchResult, WorkbenchEvent, ShellCommandEvent } from '../packages/protocol/src';
import { expect, test, type ElectronApplication, type Page } from '@playwright/test';
import { launchApp, workspaceSnapshot, ensureForeground, browserState, openNewTabForm } from './helpers';

/** Integration seam invokes the installed menu item; real macOS accelerators are verified separately with CUA.
 * Electron sendInputEvent does not enter NSMenu accelerator routing (initial red evidence is retained).
 */
async function menuCommand(app: ElectronApplication, accelerator: string) {
  await app.evaluate(async ({ Menu, BrowserWindow, webContents }, accelerator) => {
    const walk = (menu: Electron.Menu): Electron.MenuItem[] =>
      menu.items.flatMap((item) => [item, ...(item.submenu ? walk(item.submenu) : [])]);
    const menu = Menu.getApplicationMenu();
    const item = menu && walk(menu).find((item) => item.accelerator === accelerator);
    if (!item) throw new Error(`missing accelerator ${accelerator}`);
    const audit = (
      globalThis as unknown as {
        __b5ShortcutAudit?: { records: unknown[]; gap: { enabled: boolean; armed: boolean; holdEvents: boolean } };
      }
    ).__b5ShortcutAudit;
    if (audit) {
      const window = BrowserWindow.getAllWindows()[0];
      audit.records.push({
        phase: 'menu-before',
        time: Date.now(),
        accelerator,
        focusedWindow: BrowserWindow.getFocusedWindow()?.id ?? null,
        windowId: window?.id,
        windowFocused: window?.isFocused(),
        focusedContents: webContents.getFocusedWebContents()?.id ?? null,
        views: (window?.contentView.children as Electron.WebContentsView[]).map((view) => ({
          id: view.webContents?.id,
          visible: view.getVisible(),
          focused: view.webContents?.isFocused(),
        })),
      });
    }
    if (audit?.gap.enabled && accelerator === 'CmdOrCtrl+9') audit.gap.armed = true;
    if (audit?.gap.enabled && (accelerator === 'CmdOrCtrl+1' || accelerator === 'CmdOrCtrl+E' || accelerator === 'CmdOrCtrl+T')) {
      const window = BrowserWindow.getAllWindows()[0];
      const view = (window?.contentView.children as Electron.WebContentsView[]).find(
        (view) => view.webContents && view.getVisible() && view.webContents.isFocused(),
      );
      if (!view) throw new Error('projection-gap fixture needs the still-focused native page');
      audit.gap.holdEvents = true;
      const changed = new Promise<void>((resolve, reject) => {
        const timeout = setTimeout(() => reject(new Error('projection-gap fixture did not navigate')), 5000);
        view.webContents.once('did-navigate-in-page', () => {
          clearTimeout(timeout);
          resolve();
        });
      });
      await view.webContents.executeJavaScript(
        accelerator === 'CmdOrCtrl+1'
          ? "location.hash = 'b5-projection-gap'"
          : accelerator === 'CmdOrCtrl+E'
            ? "location.hash = 'b5-projection-gap-capture'"
            : "location.hash = 'b5-projection-gap-new-web'",
      );
      await changed;
      audit.records.push({ phase: 'projection-gap-ready', nativeContents: view.webContents.id, focused: view.webContents.isFocused() });
    }
    item.click();
  }, accelerator);
}
async function focusNative(app: ElectronApplication) {
  await app.evaluate(({ BrowserWindow }) => {
    const window = BrowserWindow.getAllWindows()[0];
    const view = (window?.contentView.children as Electron.WebContentsView[]).find((item) => item.webContents && item.getVisible());
    if (!view) throw new Error('missing visible native page');
    view.webContents.focus();
  });
}

/** Test-side observation only: original menu, IPC and event ordering remain intact. */
async function installShortcutAudit(app: ElectronApplication, page: Page, projectionGap = false, force = false) {
  if (process.env['WSL_B5_SHORTCUT_AUDIT'] !== '1' && !projectionGap && !force) return;
  await app.evaluate(({ BrowserWindow, ipcMain }, gapEnabled) => {
    const window = BrowserWindow.getAllWindows()[0];
    if (!window) throw new Error('missing workbench');
    const audit = {
      records: [] as unknown[],
      gap: { enabled: gapEnabled, armed: false, holdEvents: false, releases: [] as (() => void)[] },
    };
    (globalThis as unknown as { __b5ShortcutAudit: typeof audit }).__b5ShortcutAudit = audit;
    const summary = (snapshot: WorkbenchSnapshot) => ({
      seq: snapshot.seq,
      activeWorkspaceId: snapshot.activeWorkspaceId,
      workspaces: snapshot.workspaces.map((space) => ({
        workspaceId: space.workspaceId,
        revision: space.revision,
        activePaneId: space.activePaneId,
        layout: space.layout,
        previews: space.resources
          .filter((resource) => resource.kind === 'web')
          .map((resource) => ({
            resourceId: resource.resourceId,
            instanceId: resource.instanceId,
            generation: resource.generation,
            page: resource.preview?.page,
            loading: resource.preview?.loading,
          })),
      })),
    });
    const send = window.webContents.send.bind(window.webContents);
    window.webContents.send = (channel, ...args: unknown[]) => {
      if (channel === 'shell:command') audit.records.push({ phase: 'send-command', time: Date.now(), event: args[0] });
      if (channel === 'workbench:event') audit.records.push({ phase: 'publish', snapshot: summary((args[0] as WorkbenchEvent).snapshot) });
      if (channel === 'workbench:event' && audit.gap.holdEvents) {
        audit.records.push({ phase: 'held-publish' });
        return;
      }
      send(channel, ...args);
    };
    type Handler = (event: Electron.IpcMainInvokeEvent, request?: Record<string, unknown>) => Promise<unknown>;
    const handlers = (ipcMain as unknown as { _invokeHandlers: Map<string, Handler> })._invokeHandlers;
    const original = handlers.get('workbench:command');
    if (!original) throw new Error('missing command handler');
    ipcMain.removeHandler('workbench:command');
    ipcMain.handle('workbench:command', async (event, request?: Record<string, unknown>) => {
      if (['createTab', 'activateTab', 'browserLayout', 'captureContext', 'cancelCapture'].includes(String(request?.['type'])))
        audit.records.push({ phase: 'invoke', time: Date.now(), request });
      if (
        audit.gap.enabled &&
        audit.gap.armed &&
        request?.['type'] === 'browserLayout' &&
        (request['layout'] as { visible: boolean }).visible === false
      ) {
        audit.records.push({ phase: 'held-hide', request });
        await new Promise<void>((resolve) => audit.gap.releases.push(resolve));
      }
      const result = (await original(event, request)) as WorkbenchResult;
      if (['createTab', 'activateTab', 'browserLayout', 'captureContext', 'cancelCapture'].includes(String(request?.['type'])))
        audit.records.push({
          phase: 'result',
          time: Date.now(),
          commandId: request?.['commandId'],
          ok: result.ok,
          error: result.ok ? null : result.error,
          snapshot: summary(result.snapshot),
        });
      return result;
    });
  }, projectionGap);
  await page.evaluate(async () => {
    const records: unknown[] = [];
    let snapshot = await window.studio.workbench.getSnapshot();
    window.studio.workbench.onEvent((event) => {
      snapshot = event.snapshot;
    });
    window.studio.shell.onCommand((event: ShellCommandEvent) => {
      records.push({
        time: Date.now(),
        event,
        snapshot,
        documentFocused: document.hasFocus(),
        activeElement: document.activeElement?.outerHTML,
        modal: document.querySelector('dialog[open]')?.getAttribute('aria-label'),
      });
    });
    (window as unknown as { __b5ShortcutAudit: unknown[] }).__b5ShortcutAudit = records;
  });
}
async function saveShortcutAudit(app: ElectronApplication, page: Page, required = false) {
  if (process.env['WSL_B5_SHORTCUT_AUDIT'] !== '1' && !required) return;
  const main = await app.evaluate(
    () => (globalThis as unknown as { __b5ShortcutAudit?: { records: unknown[] } }).__b5ShortcutAudit?.records ?? null,
  );
  if (main === null) return;
  const renderer = await page.evaluate(() => (window as unknown as { __b5ShortcutAudit?: unknown[] }).__b5ShortcutAudit ?? null);
  await mkdir(test.info().outputDir, { recursive: true });
  await writeFile(test.info().outputPath('shortcut-audit.json'), JSON.stringify({ main, renderer }, null, 2));
  await app.evaluate(() => {
    const audit = (globalThis as unknown as { __b5ShortcutAudit: { gap: { armed: boolean; releases: (() => void)[] } } }).__b5ShortcutAudit;
    audit.gap.armed = false;
    for (const release of audit.gap.releases.splice(0)) release();
  });
}

test('B5 installed menu integration: command palette restores native focus; new web, tab selection and close preserve instances', async () => {
  const { app, page } = await launchApp();
  try {
    await ensureForeground(app, page);
    await expect.poll(async () => (await browserState(page)).loading).toBe(false);
    await focusNative(app);
    const original = await page.evaluate(() => window.studio.shell.nativeFocus());
    expect(
      original &&
        (await page.evaluate(
          (focus) => window.studio.shell.restoreBrowserFocus({ ...focus, webContentsId: focus.webContentsId + 1000 }),
          original,
        )),
    ).toBe(false);
    expect(original).not.toBeNull();
    await menuCommand(app, 'CmdOrCtrl+K');
    const palette = page.getByRole('dialog', { name: '切换空间', exact: true });
    await expect(palette).toBeVisible();
    const search = palette.getByLabel('搜索空间或标签');
    await expect(search).toBeFocused();
    await search.fill('打开设置');
    await expect(palette.getByRole('button', { name: /打开设置/ })).toBeVisible();
    await page.keyboard.press('Escape');
    await expect(palette).not.toBeVisible();
    await expect.poll(() => page.evaluate(() => window.studio.shell.nativeFocus())).toEqual(original);
    await menuCommand(app, 'CmdOrCtrl+K');
    await palette.getByRole('button', { name: '新建空间', exact: true }).click();
    const createSpace = page.getByRole('dialog', { name: '新建空间', exact: true });
    await expect(createSpace).toBeVisible();
    await page.keyboard.press('Escape');
    await expect(createSpace).not.toBeVisible();
    await expect.poll(() => page.evaluate(() => window.studio.shell.nativeFocus())).toEqual(original);

    const before = await workspaceSnapshot(page);
    await menuCommand(app, 'CmdOrCtrl+T');
    await expect
      .poll(async () => (await workspaceSnapshot(page)).workspaces[0]?.tabs.length)
      .toBe((before.workspaces[0]?.tabs.length ?? 0) + 1);
    await expect(page.locator('.workspace-browser:visible input[id^="address-"]')).toBeFocused();
    await menuCommand(app, 'CmdOrCtrl+W');
    await expect.poll(async () => (await workspaceSnapshot(page)).workspaces[0]?.tabs.length).toBe(before.workspaces[0]?.tabs.length);
    expect(await app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows().length)).toBe(1);
    const after = await workspaceSnapshot(page);
    expect(after.workspaces[0]?.resources.length).toBe((before.workspaces[0]?.resources.length ?? 0) + 1);
  } finally {
    await app.close();
  }
});

const active = async (page: Page) => {
  const snapshot = await workspaceSnapshot(page);
  const space = snapshot.workspaces.find((item) => item.workspaceId === snapshot.activeWorkspaceId);
  if (!space) throw new Error('missing active space');
  return space;
};
async function setupCommand(page: Page, data: Record<string, unknown>) {
  const { WorkbenchCommandSchema } = await import('../packages/protocol/src');
  const space = await active(page);
  return page.evaluate(
    (command) => window.studio.workbench.command(command),
    WorkbenchCommandSchema.parse({ commandId: crypto.randomUUID(), workspaceId: space.workspaceId, ...data }),
  );
}

test('B5 menu integration: capture toggle deduplicates and cancels the unused automatic receiver', async () => {
  const { app, page } = await launchApp();
  try {
    await ensureForeground(app, page);
    const before = await active(page);
    // Remove session tabs and resources through a separate empty workspace, leaving the product to create its receiver.
    const result = await setupCommand(page, { type: 'createWorkspace', workspaceId: crypto.randomUUID(), name: '快捷键采集' });
    expect(result.ok).toBe(true);
    const snapshot = await workspaceSnapshot(page);
    const created = snapshot.workspaces.find((item) => item.workspaceId !== before.workspaceId);
    if (!created) throw new Error('missing new workspace');
    // Switch by the UI so selectedId and Main agree.
    await page.getByRole('button', { name: '切换空间', exact: true }).click();
    await page.getByLabel('搜索空间或标签').fill('快捷键采集');
    await page
      .getByRole('dialog', { name: '切换空间' })
      .getByRole('button', { name: /快捷键采集.*个标签/ })
      .click();
    await expect(page.getByRole('button', { name: '切换空间', exact: true })).toContainText('快捷键采集');
    await expect.poll(async () => (await active(page)).workspaceId).toBe(created.workspaceId);
    await menuCommand(app, 'CmdOrCtrl+T');
    await expect.poll(async () => (await active(page)).resources.find((item) => item.kind === 'web')?.preview?.loading).toBe(false);
    await focusNative(app);
    await app.evaluate(({ Menu }) => {
      const item = Menu.getApplicationMenu()
        ?.items.flatMap((item) => item.submenu?.items ?? [])
        .find((item) => item.accelerator === 'CmdOrCtrl+E');
      if (!item) throw new Error('missing capture shortcut');
      item.click();
      item.click();
    });
    await expect.poll(async () => (await active(page)).resources.find((item) => item.kind === 'web')?.preview?.picking).toBe(true);
    expect((await active(page)).sessions).toHaveLength(1);
    await menuCommand(app, 'CmdOrCtrl+E');
    await expect.poll(async () => (await active(page)).sessions[0]?.captureRequest?.state).toBe('cancelled');
    await expect.poll(async () => (await active(page)).tabs.filter((item) => item.targetRef.kind === 'session').length).toBe(0);
    expect((await active(page)).sessions[0]?.context).toBeNull();
  } finally {
    await app.close();
  }
});

test('B5 renderer keyboard: CmdEnter belongs to focused session settings, respects IME and modal layers', async () => {
  const { app, page } = await launchApp({ sbxBin: new URL('./fixtures/sbx.mjs', import.meta.url).pathname });
  try {
    await ensureForeground(app, page);
    const initial = await active(page);
    const firstSessionTab = initial.tabs.find((tab) => tab.targetRef.kind === 'session');
    if (!firstSessionTab) throw new Error('missing original session tab');
    await setupCommand(page, { type: 'splitPane', paneId: initial.activePaneId, direction: 'horizontal' });
    await setupCommand(page, { type: 'createTab', kind: 'session', title: '第二会话' });
    await setupCommand(page, { type: 'focusPane', paneId: initial.activePaneId });
    await setupCommand(page, { type: 'activateTab', tabId: firstSessionTab.tabId });
    await page.getByRole('navigation', { name: '空间标签' }).getByRole('button', { name: '第二会话', exact: true }).click();
    const region = page
      .getByRole('region', { name: 'Agent 会话内容', exact: true })
      .filter({ has: page.getByRole('heading', { name: '第二会话', exact: true }) });
    const draft = region.getByRole('textbox', { name: '会话消息', exact: true });
    await draft.fill('第二会话目标');
    await draft.dispatchEvent('compositionstart');
    await draft.press('Meta+Enter');
    expect((await active(page)).runs).toHaveLength(0);
    await draft.dispatchEvent('compositionend');
    await region.getByRole('button', { name: /^任务设置/ }).click();
    const criteria = region.getByRole('group', { name: '任务设置' }).locator('textarea').first();
    await criteria.focus();
    await criteria.press('Meta+Enter');
    await expect.poll(async () => (await active(page)).runs.length).toBe(1);
    const state = await active(page);
    const owner = state.sessions.find((item) => item.title === '第二会话');
    expect(state.runs[0]?.sessionId).toBe(owner?.sessionId);
    expect(state.sessions.find((item) => item.title === 'Agent 会话')?.taskVersions).toHaveLength(0);
    await expect.poll(async () => (await active(page)).runs[0]?.state).toBe('completed');
    await draft.fill('模态期间保留');
    await menuCommand(app, 'CmdOrCtrl+K');
    await expect(page.getByRole('dialog', { name: '切换空间' })).toBeVisible();
    // Synthetic delivery to the underlying owned textarea must still respect the modal guard.
    await draft.dispatchEvent('keydown', { key: 'Enter', metaKey: true, bubbles: true });
    expect((await active(page)).runs).toHaveLength(1);
    await page.keyboard.press('Escape');
    await expect(draft).toBeFocused();
    await expect(draft).toHaveValue('模态期间保留');
  } finally {
    await app.close();
  }
});

test('B5 installed menu: tab numbers, four-pane refusal, empty CmdW and background window isolation', async () => {
  const { app, page } = await launchApp();
  try {
    await installShortcutAudit(app, page);
    await ensureForeground(app, page);
    const initial = await active(page);
    await menuCommand(app, 'CmdOrCtrl+9');
    await expect
      .poll(async () => {
        const space = await active(page);
        const find = (layout: typeof space.layout): string | null =>
          layout.kind === 'pane'
            ? layout.paneId === space.activePaneId
              ? layout.tabId
              : null
            : (find(layout.first) ?? find(layout.second));
        return find(space.layout);
      })
      .toBe(initial.tabs.at(-1)?.tabId);
    await menuCommand(app, 'CmdOrCtrl+1');
    await expect
      .poll(async () => {
        const space = await active(page);
        return space.layout.kind === 'pane' ? space.layout.tabId : null;
      })
      .toBe(initial.tabs[0]?.tabId);
    for (let i = 0; i < 3; i++) {
      await menuCommand(app, 'CmdOrCtrl+\\');
      await expect
        .poll(async () => {
          const count = (layout: typeof initial.layout): number =>
            layout.kind === 'pane' ? 1 : count(layout.first) + count(layout.second);
          return count((await active(page)).layout);
        })
        .toBe(i + 2);
    }
    const full = await active(page);
    await menuCommand(app, 'CmdOrCtrl+\\');
    await expect(page.getByRole('alert').filter({ hasText: '最多四个窗格' })).toBeVisible();
    expect((await active(page)).layout).toEqual(full.layout);
    await app.evaluate(({ BrowserWindow }) => {
      const other = new BrowserWindow({ show: true });
      other.focus();
    });
    const before = (await active(page)).tabs.length;
    await menuCommand(app, 'CmdOrCtrl+T');
    expect((await active(page)).tabs).toHaveLength(before);
    await app.evaluate(({ BrowserWindow }) =>
      BrowserWindow.getAllWindows()
        .find((item) => item.webContents.getURL() === '')
        ?.close(),
    );
    await ensureForeground(app, page);
    for (const tab of (await active(page)).tabs) await setupCommand(page, { type: 'closeTab', tabId: tab.tabId });
    await menuCommand(app, 'CmdOrCtrl+W');
    expect(await app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows().length)).toBe(1);
    await saveShortcutAudit(app, page);
    const closed = page.waitForEvent('close');
    await menuCommand(app, 'CmdOrCtrl+Shift+W');
    await closed;
  } finally {
    if (!page.isClosed()) await saveShortcutAudit(app, page);
    await app.close();
  }
});

test('B5 layered Escape and terminal palette search: no input navigation, clear refocuses, run result locates frozen run', async () => {
  const { app, page } = await launchApp({ sbxBin: new URL('./fixtures/sbx.mjs', import.meta.url).pathname });
  try {
    await ensureForeground(app, page);
    const editor = await openNewTabForm(app, page, '网页');
    const name = editor.getByLabel('名称');
    await name.fill('尚未保存的标签');
    await name.focus();
    await menuCommand(app, 'CmdOrCtrl+K');
    const palette = page.getByRole('dialog', { name: '切换空间' });
    await expect(palette).toBeVisible();
    await page.keyboard.press('Escape');
    await expect(palette).not.toBeVisible();
    await expect(editor).toBeVisible();
    await expect(name).toBeFocused();
    await expect(name).toHaveValue('尚未保存的标签');
    await page.keyboard.press('Escape');
    await expect(editor).not.toBeVisible();
    await page.getByRole('navigation', { name: '空间标签' }).getByRole('button', { name: 'Agent 会话', exact: true }).click();
    const region = page.getByRole('region', { name: 'Agent 会话内容', exact: true });
    await region.getByRole('textbox', { name: '会话消息', exact: true }).fill('可搜索运行目标');
    await region.getByRole('button', { name: '发送', exact: true }).click();
    await expect.poll(async () => (await active(page)).runs[0]?.state).toBe('completed');
    const run = (await active(page)).runs[0];
    if (!run) throw new Error('missing first searchable run');
    await region.getByRole('textbox', { name: '会话消息', exact: true }).fill('另一条最新运行内容');
    await region.getByRole('button', { name: '发送', exact: true }).click();
    await expect.poll(async () => (await active(page)).runs[1]?.state).toBe('completed');
    await page.getByRole('navigation', { name: '空间标签' }).getByRole('button', { name: '开发终端', exact: true }).click();
    await menuCommand(app, 'CmdOrCtrl+K');
    const search = palette.getByLabel('搜索空间或标签');
    await search.fill('无匹配结果');
    await expect(palette.getByText(/没有匹配/)).toBeVisible();
    expect((await active(page)).runs[0]?.runId).toBe(run?.runId);
    await palette.getByRole('button', { name: '清除搜索' }).click();
    await expect(search).toBeFocused();
    await search.fill('可搜索运行目标');
    await expect(palette.getByRole('button', { name: /可搜索运行目标.*运行记录/ })).toBeVisible();
    // Typing only filters: the terminal remains the active pane until Enter.
    await expect(page.locator('.terminal-panel:visible')).toHaveCount(1);
    await app.evaluate(({ ipcMain }) => {
      type Handler = (event: Electron.IpcMainInvokeEvent, request?: Record<string, unknown>) => Promise<unknown>;
      const handlers = (ipcMain as unknown as { _invokeHandlers: Map<string, Handler> })._invokeHandlers;
      const original = handlers.get('workbench:command');
      if (!original) throw new Error('missing command handler');
      const audit: Record<string, unknown>[] = [];
      (globalThis as typeof globalThis & { __b5PaletteLocates?: Record<string, unknown>[] }).__b5PaletteLocates = audit;
      handlers.set('workbench:command', async (event, request) => {
        if (request?.['type'] === 'locateSession') audit.push(structuredClone(request));
        return original(event, request);
      });
    });
    await search.press('Enter');
    await expect(palette).not.toBeVisible();
    await expect(region).toBeVisible();
    const details = region.getByRole('region', { name: '运行详情', exact: true });
    await expect(details).toBeVisible();
    await expect(details.getByRole('log', { name: '运行消息', exact: true })).toContainText('可搜索运行目标');
    await expect(details.getByRole('log', { name: '运行消息', exact: true })).not.toContainText('另一条最新运行内容');
    const locates = await app.evaluate(
      () => (globalThis as typeof globalThis & { __b5PaletteLocates?: Record<string, unknown>[] }).__b5PaletteLocates,
    );
    expect(locates).toEqual([
      expect.objectContaining({ type: 'locateSession', runId: run.runId, sessionId: run.sessionId, taskVersionId: run.taskVersionId }),
    ]);
  } finally {
    await app.close();
  }
});

test('B5 CmdEnter retains draft and creates no run after task target persistence failure', async () => {
  const { app, page } = await launchApp({ sbxBin: new URL('./fixtures/sbx.mjs', import.meta.url).pathname });
  try {
    await ensureForeground(app, page);
    await app.evaluate(({ ipcMain }) => {
      type Handler = (event: Electron.IpcMainInvokeEvent, request?: Record<string, unknown>) => Promise<unknown>;
      const handlers = (ipcMain as unknown as { _invokeHandlers: Map<string, Handler> })._invokeHandlers;
      const original = handlers.get('workbench:command');
      if (!original) throw new Error('missing command handler');
      handlers.set('workbench:command', async (event, request) => {
        if (request?.['type'] === 'saveTaskTarget') {
          const snapshot = await handlers.get('workbench:get-snapshot')?.(event, undefined);
          return { ok: false, error: { code: 'execution_failed', message: '注入目标保存失败' }, snapshot };
        }
        return original(event, request);
      });
    });
    await page.getByRole('navigation', { name: '空间标签' }).getByRole('button', { name: 'Agent 会话', exact: true }).click();
    const region = page.getByRole('region', { name: 'Agent 会话内容', exact: true });
    const draft = region.getByRole('textbox', { name: '会话消息', exact: true });
    await draft.fill('保存失败保持草稿');
    await region.getByRole('button', { name: /^任务设置/ }).click();
    const resource = (await active(page)).resources.find((item) => item.kind === 'terminal');
    if (!resource) throw new Error('missing terminal target');
    await region.getByLabel('附加目标（文件 / 终端 / SSH）').selectOption(resource.resourceId);
    await expect(page.getByRole('alert').filter({ hasText: '注入目标保存失败' })).toBeVisible();
    await draft.press('Meta+Enter');
    await expect(page.getByRole('alert').filter({ hasText: '任务目标未保存' })).toBeVisible();
    expect((await active(page)).runs).toHaveLength(0);
    expect((await active(page)).sessions[0]?.taskVersions).toHaveLength(0);
    await expect(draft).toHaveValue('保存失败保持草稿');
  } finally {
    await app.close();
  }
});

test('B5 Cmd. cancels only its session run, never guesses an adjacent run and ignores hidden workspace focus', async () => {
  const { app, page } = await launchApp({ sbxBin: new URL('./fixtures/sbx.mjs', import.meta.url).pathname, fixtureAcpScenario: 'cancel' });
  try {
    await ensureForeground(app, page);
    await expect
      .poll(
        async () =>
          (await page.evaluate(() => window.studio.chat.getStatus())).harnesses.find((item) => item.descriptor.harnessId === 'claude-code')
            ?.available,
      )
      .toBe(true);
    const initial = await active(page);
    const first = initial.sessions[0];
    const firstTab = initial.tabs.find((tab) => tab.targetRef.kind === 'session');
    if (!first || !firstTab) throw new Error('missing original session');
    await setupCommand(page, { type: 'activateTab', tabId: firstTab.tabId });
    await setupCommand(page, { type: 'splitPane', paneId: initial.activePaneId, direction: 'horizontal' });
    await setupCommand(page, { type: 'createTab', kind: 'session', title: '相邻执行会话' });
    const second = (await active(page)).sessions.find((session) => session.title === '相邻执行会话');
    if (!second) throw new Error('missing adjacent session');
    await setupCommand(page, {
      type: 'setSessionHarness',
      sessionId: second.sessionId,
      selection: { harnessId: 'claude-code', profileId: 'claude-code:default' },
    });
    const firstInput = page.locator(`#draft-${first.sessionId}`);
    const secondInput = page.locator(`#draft-${second.sessionId}`);
    await firstInput.fill('[slow] 第一个执行');
    await firstInput.press('Meta+Enter');
    await expect.poll(async () => (await active(page)).runs.find((run) => run.sessionId === first.sessionId)?.state).toBe('running');
    await secondInput.fill('[slow] 相邻执行');
    // The product owns one sandbox writer. An idle adjacent session must not guess the running session's run.
    await menuCommand(app, 'CmdOrCtrl+.');
    await page.evaluate(() => new Promise<void>((resolve) => requestAnimationFrame(() => resolve())));
    expect((await active(page)).runs.find((run) => run.sessionId === first.sessionId)?.state).toBe('running');
    expect((await active(page)).runs.some((run) => run.sessionId === second.sessionId)).toBe(false);
    await firstInput.focus();
    await menuCommand(app, 'CmdOrCtrl+.');
    await expect.poll(async () => (await active(page)).runs.find((run) => run.sessionId === first.sessionId)?.state).toBe('cancelled');
    await secondInput.press('Meta+Enter');
    await expect.poll(async () => (await active(page)).runs.find((run) => run.sessionId === second.sessionId)?.state).toBe('running');
    await firstInput.focus();
    await menuCommand(app, 'CmdOrCtrl+.');
    await page.evaluate(() => new Promise<void>((resolve) => requestAnimationFrame(() => resolve())));
    expect((await active(page)).runs.find((run) => run.sessionId === second.sessionId)?.state).toBe('running');
    await menuCommand(app, 'CmdOrCtrl+,');
    await expect(page.getByRole('heading', { name: '应用设置', exact: true })).toBeVisible();
    await menuCommand(app, 'CmdOrCtrl+.');
    await menuCommand(app, 'CmdOrCtrl+E');
    await page.evaluate(() => new Promise<void>((resolve) => requestAnimationFrame(() => resolve())));
    expect((await active(page)).runs.find((run) => run.sessionId === second.sessionId)?.state).toBe('running');
    expect((await active(page)).sessions.every((session) => !session.captureRequest)).toBe(true);
    await menuCommand(app, 'CmdOrCtrl+9');
    await expect(secondInput).toBeVisible();
    await secondInput.focus();
    await menuCommand(app, 'CmdOrCtrl+.');
    await expect.poll(async () => (await active(page)).runs.find((run) => run.sessionId === second.sessionId)?.state).toBe('cancelled');
  } finally {
    await app.close();
  }
});

test('B5 delayed native layout: new web address owns the real keyboard focus after the view is created', async () => {
  const { app, page } = await launchApp();
  try {
    await installShortcutAudit(app, page, false, true);
    await ensureForeground(app, page);
    await focusNative(app);
    const before = await active(page);
    await app.evaluate(
      ({ ipcMain }, known) => {
        type Handler = (event: Electron.IpcMainInvokeEvent, request?: Record<string, unknown>) => Promise<unknown>;
        const handlers = (ipcMain as unknown as { _invokeHandlers: Map<string, Handler> })._invokeHandlers;
        const original = handlers.get('workbench:command');
        if (!original) throw new Error('missing command handler');
        const gate = { held: 0, releases: [] as Array<() => void>, released: false };
        (globalThis as typeof globalThis & { __b5NewWebLayout?: typeof gate }).__b5NewWebLayout = gate;
        handlers.set('workbench:command', async (event, request) => {
          if (!gate.released && request?.['type'] === 'browserLayout' && !known.includes(String(request['resourceId']))) {
            gate.held++;
            await new Promise<void>((resolve) => gate.releases.push(resolve));
          }
          return original(event, request);
        });
      },
      before.resources.map((resource) => resource.resourceId),
    );
    await menuCommand(app, 'CmdOrCtrl+T');
    await expect.poll(async () => (await active(page)).tabs.length).toBe(before.tabs.length + 1);
    await expect
      .poll(() => app.evaluate(() => (globalThis as typeof globalThis & { __b5NewWebLayout?: { held: number } }).__b5NewWebLayout?.held))
      .toBeGreaterThan(0);
    const created = (await active(page)).resources.find(
      (resource) => !before.resources.some((known) => known.resourceId === resource.resourceId),
    );
    if (!created) throw new Error('missing created web resource');
    await app.evaluate(() => {
      const gate = (globalThis as typeof globalThis & { __b5NewWebLayout?: { released: boolean; releases: Array<() => void> } })
        .__b5NewWebLayout;
      if (!gate) throw new Error('missing layout gate');
      gate.released = true;
      gate.releases.splice(0).forEach((release) => release());
    });
    await expect
      .poll(async () => (await active(page)).resources.find((resource) => resource.resourceId === created.resourceId)?.preview?.loading)
      .toBe(false);
    const address = page.locator(`#address-${created.resourceId}`);
    await expect(address).toBeFocused();
    await expect
      .poll(() =>
        app.evaluate(({ BrowserWindow, webContents }, url) => {
          const workbench = BrowserWindow.getAllWindows().find((window) => window.webContents.getURL() === url);
          return !!workbench && workbench.webContents.isFocused() && webContents.getFocusedWebContents() === workbench.webContents;
        }, page.url()),
      )
      .toBe(true);
    await page.evaluate(() => new Promise<void>((resolve) => requestAnimationFrame(() => requestAnimationFrame(() => resolve()))));
    expect(await page.evaluate(() => window.studio.shell.nativeFocus())).toBeNull();
    await expect(address).toBeFocused();
  } finally {
    try {
      await saveShortcutAudit(app, page, true);
    } finally {
      try {
        await app.evaluate(() => {
          const gate = (globalThis as typeof globalThis & { __b5NewWebLayout?: { released: boolean; releases: Array<() => void> } })
            .__b5NewWebLayout;
          if (gate) {
            gate.released = true;
            gate.releases.splice(0).forEach((release) => release());
          }
        });
      } finally {
        await app.close();
      }
    }
  }
});

test('B5 tab navigation tolerates a real document projection gap while capture rejects the stale document', async () => {
  const { app, page } = await launchApp();
  try {
    await ensureForeground(app, page);
    await expect.poll(async () => (await browserState(page)).loading).toBe(false);
    await expect.poll(async () => (await browserState(page)).page.documentGeneration).toBeGreaterThan(0);
    await focusNative(app);
    await installShortcutAudit(app, page, true);
    const initial = await active(page);
    await menuCommand(app, 'CmdOrCtrl+9');
    await expect
      .poll(async () => {
        const workspace = await active(page);
        return workspace.layout.kind === 'pane' ? workspace.layout.tabId : null;
      })
      .toBe(initial.tabs.at(-1)?.tabId);
    await menuCommand(app, 'CmdOrCtrl+1');
    await expect
      .poll(async () => {
        const workspace = await active(page);
        return workspace.layout.kind === 'pane' ? workspace.layout.tabId : null;
      })
      .toBe(initial.tabs[0]?.tabId);
    await menuCommand(app, 'CmdOrCtrl+E');
    await expect
      .poll(() =>
        page.evaluate(
          () =>
            (window as unknown as { __b5ShortcutAudit: { event: ShellCommandEvent }[] }).__b5ShortcutAudit.filter(
              (record) => record.event.command === 'toggle-capture',
            ).length,
        ),
      )
      .toBe(1);
    const commands = await page.evaluate(() =>
      (window as unknown as { __b5ShortcutAudit: { event: ShellCommandEvent; snapshot: WorkbenchSnapshot }[] }).__b5ShortcutAudit.map(
        (record) => {
          const native = record.event.nativeBrowser;
          const projected = record.snapshot.workspaces
            .find((space) => space.workspaceId === native?.workspaceId)
            ?.resources.find((resource) => resource.resourceId === native?.resourceId)?.preview?.page.documentGeneration;
          return { command: record.event.command, nativeGeneration: native?.documentGeneration, projectedGeneration: projected };
        },
      ),
    );
    for (const command of ['activate-tab-1', 'toggle-capture']) {
      const received = commands.find((record) => record.command === command);
      if (!received || received.nativeGeneration === undefined || received.projectedGeneration === undefined)
        throw new Error('missing document gap observation');
      expect(received.nativeGeneration).toBeGreaterThan(received.projectedGeneration);
    }
    const captureCalls = await app.evaluate(
      () =>
        (
          globalThis as unknown as { __b5ShortcutAudit: { records: { phase: string; request?: { type: string } }[] } }
        ).__b5ShortcutAudit.records.filter((record) => record.phase === 'invoke' && record.request?.type === 'captureContext').length,
    );
    expect(captureCalls).toBe(0);
    expect((await active(page)).resources.find((resource) => resource.kind === 'web')?.preview?.picking).toBe(false);
    expect((await active(page)).sessions.map((session) => session.captureRequest)).toEqual(
      initial.sessions.map((session) => session.captureRequest),
    );
  } finally {
    await saveShortcutAudit(app, page, true);
    await app.close();
  }
});

test('B5 CmdT creates a new tab across a real document projection gap while stale capture remains refused', async () => {
  const { app, page } = await launchApp();
  try {
    await ensureForeground(app, page);
    await expect.poll(async () => (await browserState(page)).loading).toBe(false);
    await expect.poll(async () => (await browserState(page)).page.documentGeneration).toBeGreaterThan(0);
    await focusNative(app);
    await installShortcutAudit(app, page, true);
    const before = await active(page);
    const browser = before.resources.find((resource) => resource.kind === 'web');
    if (!browser?.preview) throw new Error('missing original browser');
    // Each menu invocation advances the real native document while its publications are held.
    // Capture reads document content and must reject; CmdT creates a separate resource.
    await menuCommand(app, 'CmdOrCtrl+E');
    await page.evaluate(() => new Promise<void>((resolve) => requestAnimationFrame(() => resolve())));
    expect((await active(page)).sessions.every((session) => !session.captureRequest)).toBe(true);
    expect(
      await app.evaluate(() => {
        const audit = (globalThis as unknown as { __b5ShortcutAudit: { records: Array<{ phase: string; request?: { type: string } }> } })
          .__b5ShortcutAudit;
        return audit.records.some((row) => row.phase === 'invoke' && row.request?.type === 'captureContext');
      }),
    ).toBe(false);
    await menuCommand(app, 'CmdOrCtrl+T');
    const command = await app.evaluate(() => {
      const audit = (globalThis as unknown as { __b5ShortcutAudit: { records: Array<{ phase: string; event?: ShellCommandEvent }> } })
        .__b5ShortcutAudit;
      return audit.records.find((row) => row.phase === 'send-command' && row.event?.command === 'new-web-tab')?.event;
    });
    expect(command?.nativeBrowser).toMatchObject({
      workspaceId: before.workspaceId,
      resourceId: browser.resourceId,
      webContentsId: browser.preview.page.webContentsId,
    });
    expect(command?.nativeBrowser?.documentGeneration).toBeGreaterThan(browser.preview.page.documentGeneration);
    await expect.poll(async () => (await active(page)).tabs.length).toBe(before.tabs.length + 1);
    const created = (await active(page)).tabs.find((tab) => !before.tabs.some((existing) => existing.tabId === tab.tabId));
    expect(created?.targetRef.kind).toBe('web');
    expect((await active(page)).sessions.every((session) => !session.captureRequest)).toBe(true);
  } finally {
    try {
      await saveShortcutAudit(app, page, true);
    } finally {
      await app.close();
    }
  }
});
