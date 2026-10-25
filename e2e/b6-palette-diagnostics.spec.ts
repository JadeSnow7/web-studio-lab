import { writeFile } from 'node:fs/promises';
import { expect, test, type ElectronApplication, type Page, type TestInfo } from '@playwright/test';
import { ensureForeground, launchApp, paneMenu } from './helpers';

type Row = Record<string, unknown>;
type MainAudit = { rows: Row[]; truncated: boolean; gate: { armed: boolean; reached: boolean; release: (() => void) | null } };
declare global {
  var __wslPaletteAudit: MainAudit;
  interface Window {
    __wslPaletteDom: { rows: Row[]; truncated: boolean };
  }
}
const fixture = new URL('./fixtures/sbx.mjs', import.meta.url).pathname;
const trigger = (page: Page) => page.getByRole('button', { name: '切换空间', exact: true });
const palette = (page: Page) => page.getByRole('dialog', { name: '切换空间', exact: true });

// Test-local observation: preserve the original trusted IPC handlers and their results.
// A gate holds only the real successful hide reply, after Main has already hidden its views.
async function installAudit(app: ElectronApplication, page: Page) {
  await app.evaluate(({ BrowserWindow, ipcMain, webContents }, url) => {
    const window = BrowserWindow.getAllWindows().find((candidate) => candidate.webContents.getURL() === url);
    if (!window) throw new Error('missing owned workbench');
    const audit: MainAudit = (globalThis.__wslPaletteAudit = {
      rows: [],
      truncated: false,
      gate: { armed: false, reached: false, release: null },
    });
    const record = (row: Row) => {
      if (audit.rows.length >= 200) {
        audit.truncated = true;
        return;
      }
      audit.rows.push({
        time: Date.now(),
        ...row,
        windowFocused: window.isFocused(),
        focusedWebContentsId: webContents.getFocusedWebContents()?.id ?? null,
        views: window.contentView.children
          .filter((child) => 'webContents' in child)
          .map((child) => {
            const view = child as Electron.WebContentsView;
            return { id: view.webContents.id, visible: view.getVisible(), bounds: view.getBounds() };
          }),
      });
    };
    window.on('focus', () => record({ phase: 'window-focus' }));
    window.on('blur', () => record({ phase: 'window-blur' }));
    type Handler = (event: Electron.IpcMainInvokeEvent, request?: Record<string, unknown>) => unknown;
    const handlers = (ipcMain as unknown as { _invokeHandlers: Map<string, Handler> })._invokeHandlers;
    for (const channel of ['shell:native-focus', 'shell:focus-workbench', 'workbench:command']) {
      const original = handlers.get(channel);
      if (!original) throw new Error(`missing real handler: ${channel}`);
      ipcMain.removeHandler(channel);
      ipcMain.handle(channel, async (event, request?: Record<string, unknown>) => {
        const observed = channel !== 'workbench:command' || request?.['type'] === 'hideBrowsers';
        if (!observed) return original(event, request);
        const id = `${channel}:${audit.rows.length}`;
        record({ phase: 'enter', id, channel, commandType: request?.['type'] });
        try {
          const result = await original(event, request);
          const summary = channel === 'workbench:command' ? { ok: (result as { ok: boolean }).ok } : result;
          record({ phase: 'complete', id, channel, result: summary });
          if (channel === 'workbench:command' && audit.gate.armed) {
            audit.gate.armed = false;
            audit.gate.reached = true;
            await new Promise<void>((resolve) => {
              audit.gate.release = resolve;
            });
          }
          record({ phase: 'return', id, channel, result: summary });
          return result;
        } catch (error) {
          record({ phase: 'throw', id, channel, message: String(error) });
          throw error;
        }
      });
    }
  }, page.url());
  await page.evaluate(() => {
    const audit: Window['__wslPaletteDom'] = (window.__wslPaletteDom = { rows: [], truncated: false });
    const record = (row: Row) => {
      if (audit.rows.length >= 200) {
        audit.truncated = true;
        return;
      }
      const active = document.activeElement;
      audit.rows.push({
        time: Date.now(),
        ...row,
        documentFocused: document.hasFocus(),
        active: active?.getAttribute('aria-label') ?? active?.tagName,
        dialogOpen: document.querySelector<HTMLDialogElement>('dialog.space-switcher')?.open ?? false,
      });
    };
    for (const type of ['pointerdown', 'pointerup', 'click', 'cancel', 'close', 'keydown']) {
      document.addEventListener(
        type,
        (event) => {
          const element = event.target instanceof Element ? event.target : null;
          const key = event instanceof KeyboardEvent ? event.key : null;
          if (type === 'keydown' && key !== 'Escape' && key !== 'Tab') return;
          record({ phase: type, key, trusted: event.isTrusted, target: element?.getAttribute('aria-label') ?? element?.tagName });
        },
        true,
      );
    }
    new MutationObserver((changes) => {
      for (const change of changes)
        if (change.target instanceof HTMLDialogElement && change.target.matches('.space-switcher'))
          record({ phase: 'dialog-open-change', open: change.target.open });
    }).observe(document.documentElement, { subtree: true, attributes: true, attributeFilter: ['open'] });
    record({ phase: 'installed' });
  });
}
async function saveAudit(app: ElectronApplication, page: Page, info: TestInfo) {
  // Always release an unfinished gate before teardown, including failed assertions.
  const main = await app.evaluate(() => {
    globalThis.__wslPaletteAudit.gate.release?.();
    return { rows: globalThis.__wslPaletteAudit.rows, truncated: globalThis.__wslPaletteAudit.truncated };
  });
  const renderer = await page.evaluate(() => window.__wslPaletteDom);
  await writeFile(info.outputPath('palette-audit.json'), JSON.stringify({ main, renderer }, null, 2));
  expect(main.truncated).toBe(false);
  expect(renderer.truncated).toBe(false);
}
async function setup() {
  const running = await launchApp({ sbxBin: fixture });
  await installAudit(running.app, running.page);
  await paneMenu(running.app, running.page, '左右分屏');
  await running.page.getByRole('navigation', { name: '空间标签' }).getByRole('button', { name: 'Agent 会话', exact: true }).click();
  await expect(running.page.getByRole('region', { name: 'Agent 会话内容', exact: true })).toBeVisible();
  return running;
}
async function pictures(app: ElectronApplication, page: Page, info: TestInfo, name: string) {
  await page.screenshot({ path: info.outputPath(`${name}.renderer.png`) });
  const captures = await app.evaluate(async ({ BrowserWindow }) => {
    const window = BrowserWindow.getAllWindows()[0];
    if (!window) throw new Error('missing window');
    const native = [];
    for (const child of window.contentView.children) {
      if (!('webContents' in child) || !child.getVisible()) continue;
      const view = child as Electron.WebContentsView;
      native.push({ id: view.webContents.id, png: (await view.webContents.capturePage()).toPNG().toString('base64') });
    }
    return { window: (await window.capturePage()).toPNG().toString('base64'), native };
  });
  await writeFile(info.outputPath(`${name}.window.png`), Buffer.from(captures.window, 'base64'));
  for (const view of captures.native) await writeFile(info.outputPath(`${name}.native-${view.id}.png`), Buffer.from(view.png, 'base64'));
}

test('B6 palette natural light1440 rename-cancel-hover sequence: observe real IPC without renewing foreground', async ({
  browserName,
}, info) => {
  expect(browserName).toBe('chromium');
  const { app, page } = await setup();
  try {
    const tabs = page.getByRole('navigation', { name: '空间标签' });
    const row = tabs.getByRole('button', { name: 'Agent 会话', exact: true });
    await row.focus();
    await row.press('F2');
    const rename = page.getByRole('form', { name: '重命名标签', exact: true });
    await expect(rename.getByRole('textbox', { name: '标签名称', exact: true })).toBeFocused();
    await page.keyboard.press('Tab');
    await expect(rename.getByRole('button', { name: '保存', exact: true })).toBeFocused();
    await page.keyboard.press('Tab');
    await expect(rename.getByRole('button', { name: '取消', exact: true })).toBeFocused();
    await pictures(app, page, info, 'rename');
    await page.keyboard.press('Escape');
    await row.hover();
    await row.focus();
    await page.keyboard.press('Tab');
    await expect(tabs.getByRole('button', { name: 'Agent 会话操作', exact: true })).toBeFocused();
    await page.keyboard.press('Tab');
    await expect(tabs.getByRole('button', { name: '关闭标签 · Agent 会话', exact: true })).toBeFocused();
    await pictures(app, page, info, 'hover-close');
    await trigger(page).click();
    await expect(palette(page).getByRole('textbox', { name: '搜索空间或标签', exact: true })).toBeFocused();
  } finally {
    try {
      await saveAudit(app, page, info);
    } finally {
      await app.close();
    }
  }
});

for (const blur of [false, true]) {
  test(`B6 palette delayed genuine hide reply: ${blur ? 'injected native blur refuses then refocus recovers' : 'foreground opens only after acknowledgement'}`, async ({
    browserName,
  }, info) => {
    expect(browserName).toBe('chromium');
    const { app, page } = await setup();
    try {
      await ensureForeground(app, page);
      await app.evaluate(() => {
        globalThis.__wslPaletteAudit.gate.armed = true;
      });
      await trigger(page).click();
      await expect.poll(() => app.evaluate(() => globalThis.__wslPaletteAudit.gate.reached)).toBe(true);
      await expect(palette(page)).not.toBeVisible();
      expect(
        await app.evaluate(
          () =>
            globalThis.__wslPaletteAudit.rows
              .filter((row) => row['phase'] === 'complete' && row['channel'] === 'workbench:command')
              .at(-1)?.['result'],
        ),
      ).toEqual({ ok: true });
      if (blur) {
        await app.evaluate(({ BrowserWindow }) => {
          BrowserWindow.getAllWindows()[0]?.blur();
        });
        await expect.poll(() => app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0]?.isFocused())).toBe(false);
      }
      await app.evaluate(() => {
        globalThis.__wslPaletteAudit.gate.release?.();
      });
      await expect
        .poll(() =>
          app.evaluate(
            () =>
              globalThis.__wslPaletteAudit.rows
                .filter((row) => row['phase'] === 'return' && row['channel'] === 'shell:focus-workbench')
                .at(-1)?.['result'],
          ),
        )
        .toBe(!blur);
      if (blur) {
        await expect(palette(page)).not.toBeVisible();
        await ensureForeground(app, page);
        await trigger(page).click();
      }
      await expect(palette(page).getByRole('textbox', { name: '搜索空间或标签', exact: true })).toBeFocused();
      expect(await app.evaluate(() => globalThis.__wslPaletteAudit.truncated)).toBe(false);
    } finally {
      try {
        await saveAudit(app, page, info);
      } finally {
        await app.close();
      }
    }
  });
}
