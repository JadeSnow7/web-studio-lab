import { mkdtemp, writeFile } from 'node:fs/promises';
import { createRequire } from 'node:module';
import path from 'node:path';
import { tmpdir } from 'node:os';
import { fileURLToPath } from 'node:url';
import { _electron, type ElectronApplication, type Page } from '@playwright/test';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const desktopDir = path.join(root, 'apps/desktop');
export const screensDir = path.join(root, 'test-results/screens', process.env['WSL_E2E_TARGET'] === 'packaged' ? 'packaged' : 'build');

/** WSL_E2E_TARGET=packaged 时启动 pnpm package 生成的 .app，否则启动 pnpm build 的产物。 */
export const target = process.env['WSL_E2E_TARGET'] === 'packaged' ? 'packaged' : 'build';

export async function launchApp(
  options: { codexBin?: string; sbxBin?: string; sandbox?: string; live?: boolean } = {},
): Promise<{ app: ElectronApplication; page: Page }> {
  // 默认回归不得消耗模型；真实模型仅在显式 live 模式使用已选 sbx。
  const env = {
    ...process.env,
    WSL_SBX_NAME: options.live ? (process.env['WSL_SBX_NAME'] ?? 'wsl-sbx-smoke-20261006') : (options.sandbox ?? 'fixture-sandbox'),
    WSL_SBX_BIN: options.live
      ? (process.env['WSL_SBX_BIN'] ?? '/opt/homebrew/bin/sbx')
      : (options.sbxBin ?? (options.codexBin ? path.join(root, 'e2e/fixtures/sbx.mjs') : '/missing/wsl-e2e-sbx')),
    WSL_CODEX_BIN: '/missing/host-codex-must-not-run',
  };
  // Each run owns a fresh profile; retain it in tmp for failure evidence.
  const userData = await mkdtemp(path.join(tmpdir(), 'wsl-e2e-'));
  const app =
    target === 'packaged'
      ? await _electron.launch({
          env,
          args: [`--user-data-dir=${userData}`],
          executablePath: path.join(desktopDir, 'release/mac-arm64/Web Studio Lab.app/Contents/MacOS/Web Studio Lab'),
        })
      : await _electron.launch({
          env,
          executablePath: createRequire(path.join(desktopDir, 'package.json'))('electron') as unknown as string,
          args: [desktopDir, `--user-data-dir=${userData}`],
          cwd: desktopDir,
        });
  // Browser 区的 WebContentsView 也会作为一个 Page 出现，这里按地址找工作台页面。
  const isWorkbench = (p: Page) => p.url().startsWith('file:') && p.url().endsWith('/renderer/index.html');
  const page = app.windows().find(isWorkbench) ?? (await app.waitForEvent('window', { predicate: isWorkbench }));
  await page.waitForSelector('div.app');
  return { app, page };
}

export async function shot(page: Page, name: string): Promise<void> {
  await page.screenshot({ path: path.join(screensDir, `${name}.png`) });
}

/**
 * 分别保存工作台 renderer 与 Browser 区页面的截图。
 * 原生 WebContentsView 不在 renderer 截图里，完整窗口的视觉检查另用系统截图完成。
 */
export async function windowShots(app: ElectronApplication, page: Page, name: string): Promise<void> {
  await shot(page, name);
  const png = await app.evaluate(async ({ BrowserWindow }) => {
    const view = BrowserWindow.getAllWindows()[0]?.contentView.children[0] as Electron.WebContentsView | undefined;
    if (!view || !view.getVisible()) return null;
    return (await view.webContents.capturePage()).toPNG().toString('base64');
  });
  if (png) await writeFile(path.join(screensDir, `${name}.preview.png`), Buffer.from(png, 'base64'));
}

export interface PreviewInfo {
  url: string;
  visible: boolean;
  bounds: { x: number; y: number; width: number; height: number };
  id: number;
}

export function previewInfo(app: ElectronApplication): Promise<PreviewInfo> {
  return app.evaluate(({ BrowserWindow }) => {
    const window = BrowserWindow.getAllWindows()[0];
    const view = window?.contentView.children[0] as Electron.WebContentsView | undefined;
    if (!view) throw new Error('no preview view');
    return { url: view.webContents.getURL(), visible: view.getVisible(), bounds: view.getBounds(), id: view.webContents.id };
  });
}

/** 在 Browser 区页面上找元素中心点（只读查询，用于测试定位）。 */
export function previewElementCenter(app: ElectronApplication, selector: string): Promise<{ x: number; y: number }> {
  return app.evaluate(async ({ BrowserWindow }, sel) => {
    const view = BrowserWindow.getAllWindows()[0]?.contentView.children[0] as Electron.WebContentsView;
    const rect = (await view.webContents.executeJavaScript(
      `(() => { const r = document.querySelector(${JSON.stringify(sel)}).getBoundingClientRect(); return { x: r.x + r.width / 2, y: r.y + r.height / 2 }; })()`,
    )) as { x: number; y: number };
    return { x: Math.round(rect.x), y: Math.round(rect.y) };
  }, selector);
}

/** 向 Browser 区页面发送真实的鼠标输入事件（与用户点击走同一条输入路径）。 */
export function previewClick(app: ElectronApplication, point: { x: number; y: number }): Promise<void> {
  return app.evaluate(async ({ BrowserWindow }, p) => {
    const view = BrowserWindow.getAllWindows()[0]?.contentView.children[0] as Electron.WebContentsView;
    const wc = view.webContents;
    wc.sendInputEvent({ type: 'mouseMove', x: p.x, y: p.y });
    await new Promise((r) => setTimeout(r, 120));
    wc.sendInputEvent({ type: 'mouseDown', x: p.x, y: p.y, button: 'left', clickCount: 1 });
    wc.sendInputEvent({ type: 'mouseUp', x: p.x, y: p.y, button: 'left', clickCount: 1 });
  }, point);
}

export function setWindowSize(app: ElectronApplication, width: number, height: number): Promise<void> {
  return app.evaluate(
    ({ BrowserWindow }, size) => {
      BrowserWindow.getAllWindows()[0]?.setContentSize(size.width, size.height);
    },
    { width, height },
  );
}
