import { fullBrowserServer } from './fixtures/full-browser-server';
import { mkdtemp, readFile, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { expect, test, type ElectronApplication, type Page } from '@playwright/test';
import { launchApp, workspaceSnapshot, ensureForeground, setWindowSize } from './helpers';
const required = <T>(value: T | undefined | null): T => {
  if (value == null) throw new Error('fixture value missing');
  return value;
};
const active = async (page: Page) => {
  const value = await workspaceSnapshot(page);
  return required(value.workspaces.find((space) => space.workspaceId === value.activeWorkspaceId));
};
const nav = (page: Page) => page.getByRole('navigation', { name: '空间标签' });
const rename = (page: Page) => page.getByRole('form', { name: '重命名标签' });
async function gateRename(app: ElectronApplication, reject = true, type: 'updateTab' | 'activateTab' = 'updateTab') {
  await app.evaluate(
    ({ ipcMain }, { reject, type }) => {
      type Handler = (event: Electron.IpcMainInvokeEvent, request?: Record<string, unknown>) => Promise<unknown>;
      const handlers = (ipcMain as unknown as { _invokeHandlers: Map<string, Handler> })._invokeHandlers;
      const original = handlers.get('workbench:command'),
        snapshot = handlers.get('workbench:get-snapshot');
      if (!original || !snapshot) throw new Error('missing command boundary');
      const gate = { calls: 0, release: null as (() => void) | null, fail: reject, hold: true };
      (globalThis as unknown as { __b5Rename: typeof gate }).__b5Rename = gate;
      ipcMain.removeHandler('workbench:command');
      ipcMain.handle('workbench:command', async (event, request?: Record<string, unknown>) => {
        if (request?.['type'] === type && (type !== 'updateTab' || request['title'] !== undefined)) {
          gate.calls++;
          if (gate.hold) {
            gate.hold = false;
            const saved = !gate.fail && type === 'updateTab' ? await original(event, request) : null;
            await new Promise<void>((resolve) => {
              gate.release = resolve;
            });
            gate.release = null;
            if (gate.fail)
              return {
                ok: false,
                error: { code: 'execution_failed', message: 'injected rename save failure' },
                snapshot: await snapshot(event),
              };
            if (type === 'updateTab') return saved;
          }
        }
        return original(event, request);
      });
    },
    { reject, type },
  );
}

test('B5 sidebar one-click creation filters capabilities, remembers defaults only after success and does not connect/send', async () => {
  const { app, page } = await launchApp({ observationRoot: await mkdtemp(path.join(tmpdir(), 'b5-local-')) });
  try {
    await ensureForeground(app, page);
    const before = await active(page);
    await page.getByRole('button', { name: '新建终端', exact: true }).click();
    await expect(page.getByRole('dialog', { name: '新建标签' })).not.toBeVisible();
    await expect.poll(async () => (await active(page)).tabs.length).toBe(before.tabs.length + 1);
    const created = required((await active(page)).tabs.at(-1));
    expect(created.title).toBe('终端 · 本设备');
    const resource = required((await active(page)).resources.find((item) => item.resourceId === created.targetRef.resourceId));
    expect(resource.environmentId).toBe('local');
    expect(resource.instanceId).toBeNull();
    await expect(page.getByRole('button', { name: '连接终端', exact: true })).toBeEnabled();
    expect(await page.evaluate(() => localStorage.getItem('wsl.default-environment:taskflow-demo:terminal'))).toBe('local');
    await page.getByRole('button', { name: '新建会话', exact: true }).click();
    await expect.poll(async () => (await active(page)).sessions.length).toBe(before.sessions.length + 1);
    expect((await active(page)).runs).toHaveLength(0);
    expect(required((await active(page)).sessions.at(-1)).title).toBe(`会话 ${before.sessions.length + 1}`);
    await page.evaluate(() => localStorage.setItem('wsl.default-environment:taskflow-demo:terminal', 'sandbox'));
    await page.getByRole('button', { name: '新建终端', exact: true }).click();
    const dialog = page.getByRole('dialog', { name: '新建标签' });
    await expect(dialog).toBeVisible();
    await expect(dialog.getByLabel('资源环境', { exact: true })).toHaveValue('');
    expect((await active(page)).tabs).toHaveLength(before.tabs.length + 2);
    await dialog.getByLabel('资源环境', { exact: true }).selectOption('local');
    await dialog.getByRole('button', { name: '保存', exact: true }).click();
    await expect(dialog).not.toBeVisible();
    expect(await page.evaluate(() => localStorage.getItem('wsl.default-environment:taskflow-demo:terminal'))).toBe('local');
  } finally {
    await app.close();
  }
});

test('B5 new web auto title follows preview only; F2/double click rename is IME safe, failed saves preserve names and restart keeps manual mode', async () => {
  const server = await fullBrowserServer();
  const userData = await mkdtemp(path.join(tmpdir(), 'b5-titles-'));
  let { app, page } = await launchApp({ userData });
  try {
    await ensureForeground(app, page);
    await page.getByRole('button', { name: '新建网页', exact: true }).click();
    await expect(page.locator('.workspace-browser:visible input[id^="address-"]')).toBeFocused();
    const tab = required((await active(page)).tabs.at(-1));
    const preview = async () =>
      required(required((await active(page)).resources.find((resource) => resource.resourceId === tab.targetRef.resourceId)).preview);
    await expect.poll(async () => (await preview()).loading).toBe(false);
    expect(tab.title).toBe('新网页');
    expect(tab.autoTitle).toBe(true);
    const automaticDisk = JSON.parse(await readFile(path.join(userData, 'workbench.json'), 'utf8')) as {
      snapshot: { workspaces: { tabs: { tabId: string; title: string; autoTitle: boolean }[] }[] };
    };
    expect(automaticDisk.snapshot.workspaces.flatMap((space) => space.tabs).find((item) => item.tabId === tab.tabId)).toMatchObject({
      title: '新网页',
      autoTitle: true,
    });
    await app.close();
    ({ app, page } = await launchApp({ userData }));
    await ensureForeground(app, page);
    await expect.poll(async () => (await preview()).loading).toBe(false);
    const button = page.locator(`#vertical-${tab.tabId}`);
    await expect(button).toHaveAttribute('aria-label', (await preview()).page.title);
    await app.evaluate(async ({ BrowserWindow }) => {
      const window = BrowserWindow.getAllWindows()[0];
      const view = (window?.contentView.children as Electron.WebContentsView[]).find((item) => item.webContents && item.getVisible());
      if (!view) throw new Error('missing native web');
      await view.webContents.executeJavaScript("document.title = '动态页面标题'");
    });
    await expect(button).toHaveAttribute('aria-label', '动态页面标题');
    await expect(page.locator('.pane-header .pane-title').filter({ hasText: '动态页面标题' })).toBeVisible();
    expect(required((await active(page)).tabs.find((item) => item.tabId === tab.tabId)).title).toBe('新网页');
    await button.focus();
    await page.keyboard.press('F2');
    await rename(page).getByLabel('标签名称').fill('取消名称');
    await page.keyboard.press('Escape');
    expect(required((await active(page)).tabs.find((item) => item.tabId === tab.tabId)).autoTitle).toBe(true);
    await button.dblclick();
    await expect(rename(page)).toBeVisible();
    const input = rename(page).getByLabel('标签名称');
    await input.fill('手动名称');
    await input.dispatchEvent('compositionstart');
    await input.press('Enter');
    expect(required((await active(page)).tabs.find((item) => item.tabId === tab.tabId)).title).toBe('新网页');
    await input.dispatchEvent('compositionend');
    await gateRename(app);
    await rename(page)
      .getByRole('button', { name: '保存', exact: true })
      .evaluate((node) => {
        (node as HTMLButtonElement).click();
        (node as HTMLButtonElement).click();
      });
    await expect
      .poll(() => app.evaluate(() => (globalThis as unknown as { __b5Rename: { calls: number; release: unknown } }).__b5Rename.calls))
      .toBe(1);
    await app.evaluate(() => {
      const gate = (globalThis as unknown as { __b5Rename: { release: (() => void) | null } }).__b5Rename;
      if (!gate.release) throw new Error('missing rename gate');
      gate.release();
    });
    await expect(rename(page).getByRole('alert')).toContainText('injected rename save failure');
    await expect(input).toHaveValue('手动名称');
    await expect(input).toBeFocused();
    expect(required((await active(page)).tabs.find((item) => item.tabId === tab.tabId))).toMatchObject({
      title: '新网页',
      autoTitle: true,
    });
    await input.press('Enter');
    await expect(rename(page)).not.toBeVisible();
    await expect(button).toHaveAttribute('aria-label', '手动名称');
    const address = page.locator('.workspace-browser:visible input[id^="address-"]');
    await address.fill(server.url + '/account');
    await address.press('Enter');
    await expect.poll(async () => (await preview()).page.url).toBe(server.url + '/account');
    await expect(button).toHaveAttribute('aria-label', '手动名称');
    const disk = JSON.parse(await readFile(path.join(userData, 'workbench.json'), 'utf8')) as {
      snapshot: { workspaces: { tabs: { tabId: string; title: string; autoTitle: boolean }[] }[] };
    };
    expect(disk.snapshot.workspaces.flatMap((space) => space.tabs).find((item) => item.tabId === tab.tabId)).toMatchObject({
      title: '手动名称',
      autoTitle: false,
    });
    await app.close();
    ({ app, page } = await launchApp({ userData }));
    await expect(page.locator(`#vertical-${tab.tabId}`)).toHaveAttribute('aria-label', '手动名称');
    expect(required((await active(page)).tabs.find((item) => item.tabId === tab.tabId)).autoTitle).toBe(false);
  } finally {
    await app.close();
    await server.close();
  }
});

test('B5 hover close retains native instance and does not activate a background tab; close is keyboard accessible', async () => {
  const { app, page } = await launchApp();
  const observations: unknown[] = [];
  let primaryFailure = false;
  let hoveredTabId: string | null = null;
  const observe = async (phase: string) => {
    const renderer = await page.evaluate((tabId) => {
      const row = tabId ? document.getElementById(`vertical-${tabId}`)?.closest('.vertical-tab') : null;
      const close = row?.querySelector('.tab-close');
      const events = (window as unknown as { __b5HoverEvents?: unknown[] }).__b5HoverEvents ?? [];
      const last = [...events].reverse().find((event) => (event as { x?: number }).x !== undefined) as
        { x?: number; y?: number } | undefined;
      return {
        documentFocused: document.hasFocus(),
        active: document.activeElement?.outerHTML,
        rowHover: row?.matches(':hover'),
        rowFocusWithin: row?.matches(':focus-within'),
        rowBounds: row?.getBoundingClientRect().toJSON(),
        closeOpacity: close ? getComputedStyle(close).opacity : null,
        pointerHit: last?.x !== undefined && last.y !== undefined ? document.elementFromPoint(last.x, last.y)?.outerHTML : null,
        events,
        truncated: (window as unknown as { __b5HoverTruncated?: boolean }).__b5HoverTruncated ?? false,
      };
    }, hoveredTabId);
    const native = await app.evaluate(({ BrowserWindow, webContents }) => {
      const window = BrowserWindow.getAllWindows()[0];
      return {
        windowFocused: window?.isFocused(),
        bounds: window?.getContentBounds(),
        focusedContents: webContents.getFocusedWebContents()?.id ?? null,
        views: window?.contentView.children
          .filter((child) => 'webContents' in child)
          .map((child) => {
            const view = child as Electron.WebContentsView;
            return { id: view.webContents.id, visible: view.getVisible(), bounds: view.getBounds() };
          }),
      };
    });
    observations.push({ phase, time: Date.now(), renderer, native });
  };
  const finishAudit = async () => {
    try {
      await observe('finally');
      await writeFile(test.info().outputPath('hover-audit.json'), JSON.stringify(observations, null, 2));
      await page.screenshot({ path: test.info().outputPath('hover.renderer.png') });
    } catch (error) {
      if (!primaryFailure) throw error;
      console.error('Hover diagnostics failed after the original assertion:', error);
    }
  };
  try {
    await page.evaluate(() => {
      const events: unknown[] = [];
      (window as unknown as { __b5HoverEvents: unknown[] }).__b5HoverEvents = events;
      for (const type of ['pointermove', 'pointerover', 'pointerout', 'focusin', 'focusout'])
        document.addEventListener(
          type,
          (event) => {
            if (events.length >= 100) {
              (window as unknown as { __b5HoverTruncated: boolean }).__b5HoverTruncated = true;
              return;
            }
            const pointer = event instanceof PointerEvent ? event : null;
            events.push({
              time: Date.now(),
              type,
              x: pointer?.clientX,
              y: pointer?.clientY,
              target: event.target instanceof Element ? event.target.outerHTML : null,
              documentFocused: document.hasFocus(),
            });
          },
          true,
        );
    });
    await ensureForeground(app, page);
    const before = await active(page),
      web = required(before.tabs.find((tab) => tab.targetRef.kind === 'web'));
    await expect
      .poll(async () => required((await active(page)).resources.find((item) => item.resourceId === web.targetRef.resourceId)).instanceId)
      .not.toBeNull();
    hoveredTabId = web.tabId;
    const resource = required((await active(page)).resources.find((item) => item.resourceId === web.targetRef.resourceId));
    await nav(page).getByRole('button', { name: 'Agent 会话', exact: true }).click();
    const pane = (await active(page)).layout;
    const close = page.getByRole('button', { name: '关闭标签 · TaskFlow 预览', exact: true });
    await expect(close).toHaveCSS('opacity', '0');
    await observe('before-hover');
    await page.locator(`#vertical-${web.tabId}`).hover();
    await observe('after-hover');
    await expect(close).toHaveCSS('opacity', '1');
    await close.click();
    await expect(page.locator(`#vertical-${web.tabId}`)).toHaveCount(0);
    expect((await active(page)).layout).toEqual(pane);
    expect(required((await active(page)).resources.find((item) => item.resourceId === resource.resourceId)).instanceId).toBe(
      resource.instanceId,
    );
    const terminalClose = page.getByRole('button', { name: '关闭标签 · 开发终端', exact: true });
    await terminalClose.focus();
    await expect(terminalClose).toHaveCSS('opacity', '1');
    await terminalClose.press('Enter');
    await expect(nav(page).getByRole('button', { name: '开发终端', exact: true })).toHaveCount(0);
    expect((await active(page)).resources.some((item) => item.kind === 'terminal')).toBe(true);
  } catch (error) {
    primaryFailure = true;
    throw error;
  } finally {
    try {
      await finishAudit();
    } finally {
      await app.close();
    }
  }
});

test('B5 narrow sidebar supports double-click and F2 editing while ordinary pointer and keyboard activation close peek', async () => {
  const { app, page } = await launchApp();
  try {
    await ensureForeground(app, page);
    await setWindowSize(app, 900, 700);
    const expand = page.getByRole('button', { name: '展开 Workshop', exact: true });
    await expand.click();
    const session = nav(page).getByRole('button', { name: 'Agent 会话', exact: true });
    await session.dblclick();
    await expect(rename(page)).toBeVisible();
    await expect(rename(page).getByLabel('标签名称')).toBeFocused();
    await page.screenshot({ path: test.info().outputPath('narrow-rename.png') });
    await rename(page).getByRole('button', { name: '取消', exact: true }).click();
    await expect(session).toBeFocused();
    await session.press('F2');
    await expect(rename(page)).toBeVisible();
    await page.keyboard.press('Escape');
    await session.click();
    await expect(nav(page)).not.toBeVisible();
    await expand.click();
    await session.focus();
    await session.press('Enter');
    await expect(nav(page)).not.toBeVisible();
  } finally {
    await app.close();
  }
});

test('B5 multiple eligible environments require an initial choice then reuse the last successful terminal environment', async () => {
  const { app, page } = await launchApp({
    observationRoot: await mkdtemp(path.join(tmpdir(), 'b5-multiple-')),
    sbxBin: new URL('./fixtures/sbx.mjs', import.meta.url).pathname,
  });
  try {
    await ensureForeground(app, page);
    await expect
      .poll(() =>
        page.evaluate(
          async () =>
            (await window.studio.workbench.environments()).filter(
              (environment) => environment.state === 'configured' && environment.capabilities.terminal,
            ).length,
        ),
      )
      .toBe(2);
    const before = await active(page);
    await page.getByRole('button', { name: '新建终端', exact: true }).click();
    const dialog = page.getByRole('dialog', { name: '新建标签' });
    await expect(dialog).toBeVisible();
    await expect(dialog.getByLabel('资源环境', { exact: true })).toHaveValue('');
    await dialog.getByLabel('资源环境', { exact: true }).selectOption('sandbox');
    await dialog.getByRole('button', { name: '保存', exact: true }).click();
    await expect(dialog).not.toBeVisible();
    await page.getByRole('button', { name: '新建终端', exact: true }).click();
    await expect.poll(async () => (await active(page)).tabs.length).toBe(before.tabs.length + 2);
    await expect(dialog).not.toBeVisible();
    const last = required((await active(page)).tabs.at(-1)),
      resource = required((await active(page)).resources.find((item) => item.resourceId === last.targetRef.resourceId));
    expect(resource.environmentId).toBe('sandbox');
    expect(resource.instanceId).toBeNull();
    expect(last.title).toBe('终端 · fixture-sandbox');
    expect(await page.evaluate(() => localStorage.getItem('wsl.default-environment:taskflow-demo:terminal'))).toBe('sandbox');
  } finally {
    await app.close();
  }
});

async function releaseTabGate(app: ElectronApplication) {
  await app.evaluate(() => {
    const gate = (globalThis as unknown as { __b5Rename: { release: (() => void) | null } }).__b5Rename;
    if (!gate.release) throw new Error('missing tab gate');
    gate.release();
  });
}
async function tabGateHeld(app: ElectronApplication) {
  await expect
    .poll(() => app.evaluate(() => typeof (globalThis as unknown as { __b5Rename: { release: unknown } }).__b5Rename.release))
    .toBe('function');
}
for (const reject of [false, true]) {
  for (const leave of ['composer', 'tab'] as const) {
    test(`B5 delayed rename ${reject ? 'failure' : 'success'} preserves later ${leave} focus`, async () => {
      const { app, page } = await launchApp();
      try {
        await ensureForeground(app, page);
        if (leave === 'tab') {
          const workspace = await active(page);
          const created = await page.evaluate(
            (workspaceId) =>
              window.studio.workbench.command({
                type: 'createTab',
                workspaceId,
                commandId: crypto.randomUUID(),
                kind: 'session',
                title: '焦点目标会话',
              }),
            workspace.workspaceId,
          );
          expect(created.ok).toBe(true);
          await expect(nav(page).getByRole('button', { name: '焦点目标会话', exact: true })).toBeVisible();
        }
        const session = nav(page).getByRole('button', { name: 'Agent 会话', exact: true });
        const originalTabId = await session.getAttribute('id');
        await session.click();
        await expect(session).toHaveAttribute('aria-current', 'page');
        await session.press('F2');
        await rename(page).getByLabel('标签名称').fill('延迟保存后的名称');
        await gateRename(app, reject);
        await rename(page).getByRole('button', { name: '保存', exact: true }).click();
        await tabGateHeld(app);
        const destination =
          leave === 'composer'
            ? page.getByRole('textbox', { name: '会话消息', exact: true })
            : nav(page).getByRole('button', { name: '焦点目标会话', exact: true });
        if (leave === 'composer') await destination.fill('保留当前焦点草稿');
        else await destination.click();
        await expect(destination).toBeFocused();
        await releaseTabGate(app);
        if (reject) await expect(rename(page).getByRole('alert')).toContainText('injected rename save failure');
        else await expect(rename(page)).not.toBeVisible();
        await page.evaluate(() => new Promise<void>((resolve) => requestAnimationFrame(() => requestAnimationFrame(() => resolve()))));
        // Test-only negative control reproduces the former unconditional restore without replacing shared product sources.
        if (leave === 'tab' && process.env['WSL_B5_FOCUS_NEGATIVE'] === '1')
          await page.evaluate(
            ({ originalTabId, reject }) => {
              const previous = reject
                ? document.querySelector<HTMLElement>('form[aria-label="重命名标签"] input')
                : originalTabId
                  ? document.getElementById(originalTabId)
                  : null;
              if (!previous) throw new Error('missing negative-control focus target');
              previous.focus();
            },
            { originalTabId, reject },
          );
        await expect(destination).toBeFocused();
        expect((await active(page)).tabs.some((tab) => tab.title === '延迟保存后的名称')).toBe(!reject);
        if (reject) await expect(rename(page).getByLabel('标签名称')).toHaveValue('延迟保存后的名称');
        if (leave === 'composer') await expect(destination).toHaveValue('保留当前焦点草稿');
      } finally {
        await app.close();
      }
    });
  }
}
test('B5 delayed double-click activation cannot open an editor after the user focuses the visible session', async () => {
  const { app, page } = await launchApp();
  try {
    await ensureForeground(app, page);
    await nav(page).getByRole('button', { name: 'Agent 会话', exact: true }).click();
    await gateRename(app, false, 'activateTab');
    await nav(page).getByRole('button', { name: 'TaskFlow 预览', exact: true }).dblclick();
    await tabGateHeld(app);
    const composer = page.getByRole('textbox', { name: '会话消息', exact: true });
    await composer.fill('新交互取消迟到编辑');
    await releaseTabGate(app);
    await expect
      .poll(async () => {
        const workspace = await active(page);
        return workspace.tabs.find((tab) => workspace.layout.kind === 'pane' && tab.tabId === workspace.layout.tabId)?.targetRef.kind;
      })
      .toBe('web');
    await expect(rename(page)).not.toBeVisible();
    expect(await page.evaluate(() => document.activeElement?.getAttribute('aria-label'))).not.toBe('标签名称');
  } finally {
    await app.close();
  }
});

test('B5 rename checks ownership again inside the deferred focus frame after its successful receipt', async () => {
  const { app, page } = await launchApp();
  try {
    await ensureForeground(app, page);
    const session = nav(page).getByRole('button', { name: 'Agent 会话', exact: true });
    await session.click();
    await expect(session).toHaveAttribute('aria-current', 'page');
    await session.press('F2');
    await rename(page).getByLabel('标签名称').fill('帧前成功保存名称');
    await gateRename(app, false);
    await rename(page).getByRole('button', { name: '保存', exact: true }).click();
    await tabGateHeld(app);
    await page.evaluate(() => {
      const original = window.requestAnimationFrame.bind(window);
      const gate = { armed: true, callbacks: [] as FrameRequestCallback[] };
      (window as unknown as { __b5FrameGate: typeof gate }).__b5FrameGate = gate;
      window.requestAnimationFrame = (callback) => {
        if (!gate.armed) return original(callback);
        gate.callbacks.push(callback);
        return -gate.callbacks.length;
      };
    });
    await releaseTabGate(app);
    await expect.poll(() => page.evaluate(() => document.querySelector('form[aria-label="重命名标签"]') === null)).toBe(true);
    const composer = page.getByRole('textbox', { name: '会话消息', exact: true });
    await composer.focus();
    await page.evaluate(() => {
      const gate = (window as unknown as { __b5FrameGate: { armed: boolean; callbacks: FrameRequestCallback[] } }).__b5FrameGate;
      gate.armed = false;
      for (const callback of gate.callbacks.splice(0)) callback(performance.now());
    });
    await expect(composer).toBeFocused();
    expect((await active(page)).tabs.some((tab) => tab.title === '帧前成功保存名称')).toBe(true);
  } finally {
    await app.close();
  }
});
