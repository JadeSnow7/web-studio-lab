# Instructions

- Following Playwright test failed.
- Explain why, be concise, respect Playwright best practices.
- Provide a snippet of code with the fix, if possible.

# Test info

- Name: sbx.spec.ts >> fixture：活动终端直接关闭应用需确认 Electron 进程退出
- Location: e2e/sbx.spec.ts:115:1

# Error details

```
Error: electronApplication.evaluate: Target page, context or browser has been closed
```

# Test source

```ts
  1   | import type { StudioApi } from '../packages/protocol/src';
  2   | declare global {
  3   |   interface Window {
  4   |     studio: StudioApi;
  5   |   }
  6   | }
  7   | import { mkdtemp, writeFile } from 'node:fs/promises';
  8   | import assert from 'node:assert/strict';
  9   | import { createRequire } from 'node:module';
  10  | import path from 'node:path';
  11  | import { tmpdir } from 'node:os';
  12  | import { fileURLToPath } from 'node:url';
  13  | import { _electron, type ElectronApplication, type Page } from '@playwright/test';
  14  | 
  15  | const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
  16  | const desktopDir = path.join(root, 'apps/desktop');
  17  | export const screensDir = path.join(root, 'test-results/screens', process.env['WSL_E2E_TARGET'] === 'packaged' ? 'packaged' : 'build');
  18  | 
  19  | /** WSL_E2E_TARGET=packaged 时启动 pnpm package 生成的 .app，否则启动 pnpm build 的产物。 */
  20  | export const target = process.env['WSL_E2E_TARGET'] === 'packaged' ? 'packaged' : 'build';
  21  | 
  22  | export async function launchApp(
  23  |   options: { codexBin?: string; sbxBin?: string; sandbox?: string; live?: boolean; userData?: string; startupError?: string } = {},
  24  | ): Promise<{ app: ElectronApplication; page: Page; rendererErrors: string[] }> {
  25  |   // 默认回归不得消耗模型；真实模型仅在显式 live 模式使用已选 sbx。
  26  |   const env = {
  27  |     ...process.env,
  28  |     WSL_SBX_NAME: options.live ? (process.env['WSL_SBX_NAME'] ?? 'wsl-sbx-smoke-20261006') : (options.sandbox ?? 'fixture-sandbox'),
  29  |     WSL_SBX_BIN: options.live
  30  |       ? (process.env['WSL_SBX_BIN'] ?? '/opt/homebrew/bin/sbx')
  31  |       : (options.sbxBin ?? (options.codexBin ? path.join(root, 'e2e/fixtures/sbx.mjs') : '/missing/wsl-e2e-sbx')),
  32  |     WSL_CODEX_BIN: '/missing/host-codex-must-not-run',
  33  |   };
  34  |   // Each run owns a fresh profile; retain it in tmp for failure evidence.
  35  |   const userData = options.userData ?? (await mkdtemp(path.join(tmpdir(), 'wsl-e2e-')));
  36  |   // Install the observer before the real entrypoint creates any renderer.
  37  |   const bootstrap = path.join(await mkdtemp(path.join(tmpdir(), 'wsl-e2e-bootstrap-')), 'main.cjs');
  38  |   await writeFile(
  39  |     bootstrap,
  40  |     `
  41  | const { app } = require('electron');
  42  | app.setAppPath(${JSON.stringify(desktopDir)});
  43  | globalThis.__wslRendererErrors = [];
  44  | app.on('web-contents-created', (_event, contents) => {
  45  |   contents.on('console-message', (event) => {
  46  |     if (contents.getURL().endsWith('/renderer/index.html') && event.level === 'error') {
  47  |       globalThis.__wslRendererErrors.push(event.message);
  48  |     }
  49  |   });
  50  |   ${
  51  |     options.startupError
  52  |       ? `contents.once('dom-ready', () => {
  53  |     if (contents.getURL().endsWith('/renderer/index.html')) {
  54  |       void contents.executeJavaScript(${JSON.stringify(`setTimeout(() => { throw new Error(${JSON.stringify(options.startupError)}); }, 0)`)});
  55  |     }
  56  |   });`
  57  |       : ''
  58  |   }
  59  | });
  60  | require(${JSON.stringify(path.join(desktopDir, 'out/main/index.js'))});
  61  | `,
  62  |   );
  63  |   const app =
  64  |     target === 'packaged'
  65  |       ? await _electron.launch({
  66  |           env,
  67  |           args: [`--user-data-dir=${userData}`],
  68  |           executablePath: path.join(desktopDir, 'release/mac-arm64/Web Studio Lab.app/Contents/MacOS/Web Studio Lab'),
  69  |         })
  70  |       : await _electron.launch({
  71  |           env,
  72  |           executablePath: createRequire(path.join(desktopDir, 'package.json'))('electron') as unknown as string,
  73  |           args: [bootstrap, `--user-data-dir=${userData}`],
  74  |           cwd: desktopDir,
  75  |         });
  76  |   if (options.live) {
  77  |     console.log('LIVE_PROFILE', userData, 'ELECTRON_PID', app.process().pid);
  78  |     app.process().stderr?.on('data', (data: Buffer) => console.error('ELECTRON_STDERR', data.toString()));
  79  |   }
  80  |   // Browser 区的 WebContentsView 也会作为一个 Page 出现，这里按地址找工作台页面。
  81  |   const isWorkbench = (p: Page) => p.url().startsWith('file:') && p.url().endsWith('/renderer/index.html');
  82  |   const page = app.windows().find(isWorkbench) ?? (await app.waitForEvent('window', { predicate: isWorkbench }));
  83  |   const rendererErrors: string[] = [];
  84  |   page.on('pageerror', (error) => {
  85  |     rendererErrors.push(error.stack ?? error.message);
  86  |     console.error('RENDERER', error.stack ?? error.message);
  87  |   });
  88  |   const originalClose = app.close.bind(app);
  89  |   app.close = async () => {
  90  |     const early =
> 91  |       target === 'build' ? await app.evaluate(() => (globalThis as unknown as { __wslRendererErrors: string[] }).__wslRendererErrors) : [];
      |                                      ^ Error: electronApplication.evaluate: Target page, context or browser has been closed
  92  |     rendererErrors.push(...early.filter((message) => !rendererErrors.some((error) => error.includes(message))));
  93  |     await originalClose();
  94  |     assert.deepEqual(rendererErrors, [], 'Workbench renderer exceptions/errors fail every E2E');
  95  |   };
  96  |   try {
  97  |     await page.waitForSelector('div.app', { timeout: 10000 });
  98  |     await page.waitForSelector('[data-pane-id]', { state: 'attached', timeout: options.live ? 60000 : 10000 });
  99  |   } catch (error) {
  100 |     console.error('Renderer startup', rendererErrors, await page.locator('body').innerText());
  101 |     await app.close();
  102 |     throw error;
  103 |   }
  104 |   return { app, page, rendererErrors };
  105 | }
  106 | 
  107 | export async function shot(page: Page, name: string): Promise<void> {
  108 |   await page.screenshot({ path: path.join(screensDir, `${name}.png`) });
  109 | }
  110 | 
  111 | /**
  112 |  * 分别保存工作台 renderer 与 Browser 区页面的截图。
  113 |  * 原生 WebContentsView 不在 renderer 截图里，完整窗口的视觉检查另用系统截图完成。
  114 |  */
  115 | export async function windowShots(app: ElectronApplication, page: Page, name: string): Promise<void> {
  116 |   await shot(page, name);
  117 |   const png = await app.evaluate(async ({ BrowserWindow }) => {
  118 |     const view = BrowserWindow.getAllWindows()[0]?.contentView.children[0] as Electron.WebContentsView | undefined;
  119 |     if (!view || !view.getVisible()) return null;
  120 |     return (await view.webContents.capturePage()).toPNG().toString('base64');
  121 |   });
  122 |   if (png) await writeFile(path.join(screensDir, `${name}.preview.png`), Buffer.from(png, 'base64'));
  123 | }
  124 | 
  125 | export interface PreviewInfo {
  126 |   url: string;
  127 |   visible: boolean;
  128 |   bounds: { x: number; y: number; width: number; height: number };
  129 |   id: number;
  130 | }
  131 | 
  132 | export function previewInfo(app: ElectronApplication): Promise<PreviewInfo> {
  133 |   return app.evaluate(({ BrowserWindow }) => {
  134 |     const window = BrowserWindow.getAllWindows()[0];
  135 |     const view = window?.contentView.children[0] as Electron.WebContentsView | undefined;
  136 |     if (!view) throw new Error('no preview view');
  137 |     return { url: view.webContents.getURL(), visible: view.getVisible(), bounds: view.getBounds(), id: view.webContents.id };
  138 |   });
  139 | }
  140 | 
  141 | /** 在 Browser 区页面上找元素中心点（只读查询，用于测试定位）。 */
  142 | export function previewElementCenter(app: ElectronApplication, selector: string): Promise<{ x: number; y: number }> {
  143 |   return app.evaluate(async ({ BrowserWindow }, sel) => {
  144 |     const view = BrowserWindow.getAllWindows()[0]?.contentView.children[0] as Electron.WebContentsView;
  145 |     const rect = (await view.webContents.executeJavaScript(
  146 |       `(() => { const r = document.querySelector(${JSON.stringify(sel)}).getBoundingClientRect(); return { x: r.x + r.width / 2, y: r.y + r.height / 2 }; })()`,
  147 |     )) as { x: number; y: number };
  148 |     return { x: Math.round(rect.x), y: Math.round(rect.y) };
  149 |   }, selector);
  150 | }
  151 | 
  152 | /** 向 Browser 区页面发送真实的鼠标输入事件（与用户点击走同一条输入路径）。 */
  153 | export function previewClick(app: ElectronApplication, point: { x: number; y: number }): Promise<void> {
  154 |   return app.evaluate(async ({ BrowserWindow }, p) => {
  155 |     const view = BrowserWindow.getAllWindows()[0]?.contentView.children[0] as Electron.WebContentsView;
  156 |     const wc = view.webContents;
  157 |     wc.sendInputEvent({ type: 'mouseMove', x: p.x, y: p.y });
  158 |     await new Promise((r) => setTimeout(r, 120));
  159 |     wc.sendInputEvent({ type: 'mouseDown', x: p.x, y: p.y, button: 'left', clickCount: 1 });
  160 |     wc.sendInputEvent({ type: 'mouseUp', x: p.x, y: p.y, button: 'left', clickCount: 1 });
  161 |   }, point);
  162 | }
  163 | 
  164 | export function setWindowSize(app: ElectronApplication, width: number, height: number): Promise<void> {
  165 |   return app.evaluate(
  166 |     ({ BrowserWindow }, size) => {
  167 |       BrowserWindow.getAllWindows()[0]?.setContentSize(size.width, size.height);
  168 |     },
  169 |     { width, height },
  170 |   );
  171 | }
  172 | 
  173 | export async function workspaceSnapshot(page: Page) {
  174 |   return page.evaluate(() => window.studio.workbench.getSnapshot());
  175 | }
  176 | export async function browserState(page: Page) {
  177 |   const snapshot = await workspaceSnapshot(page);
  178 |   const resource = snapshot.workspaces.find((w) => w.workspaceId === snapshot.activeWorkspaceId)?.resources.find((r) => r.kind === 'web');
  179 |   if (!resource?.preview) throw new Error('browser snapshot unavailable');
  180 |   return resource.preview;
  181 | }
  182 | export async function terminalSnapshot(page: Page) {
  183 |   const snapshot = await workspaceSnapshot(page);
  184 |   const resource = snapshot.workspaces
  185 |     .find((w) => w.workspaceId === snapshot.activeWorkspaceId)
  186 |     ?.resources.find((r) => r.kind === 'terminal');
  187 |   if (!resource?.terminal) throw new Error('terminal snapshot unavailable');
  188 |   return resource.terminal;
  189 | }
  190 | export async function workshopNavigate(page: Page, label: string) {
  191 |   const navigation = page.getByRole('navigation', { name: 'Workshop 导航' });
```