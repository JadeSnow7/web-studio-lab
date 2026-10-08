import type { StudioApi } from '../packages/protocol/src';
declare global {
  interface Window {
    studio: StudioApi;
  }
}
import { mkdtemp, writeFile, rm } from 'node:fs/promises';
import assert from 'node:assert/strict';
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
  options: {
    observationRoot?: string;
    sshEnvironment?: { host: string; port: number; username: string; hostKeySha256: string; root: string; agent: string };
    controlledObservation?: boolean;
    codexBin?: string;
    sbxBin?: string;
    sandbox?: string;
    live?: boolean;
    userData?: string;
    startupError?: string;
  } = {},
): Promise<{ app: ElectronApplication; page: Page; rendererErrors: string[] }> {
  // 默认回归不得消耗模型；真实模型仅在显式 live 模式使用已选 sbx。
  const env = {
    ...process.env,
    ...(options.sshEnvironment
      ? {
          WSL_SSH_HOST: options.sshEnvironment.host,
          WSL_SSH_PORT: String(options.sshEnvironment.port),
          WSL_SSH_USER: options.sshEnvironment.username,
          WSL_SSH_HOST_KEY_SHA256: options.sshEnvironment.hostKeySha256,
          WSL_SSH_ROOT: options.sshEnvironment.root,
          SSH_AUTH_SOCK: options.sshEnvironment.agent,
        }
      : {}),
    ...(options.observationRoot === undefined ? {} : { WSL_OBSERVATION_ROOT: options.observationRoot }),
    WSL_SBX_NAME: options.live ? (process.env['WSL_SBX_NAME'] ?? 'wsl-sbx-smoke-20261006') : (options.sandbox ?? 'fixture-sandbox'),
    WSL_SBX_BIN: options.live
      ? (process.env['WSL_SBX_BIN'] ?? '/opt/homebrew/bin/sbx')
      : (options.sbxBin ?? (options.codexBin ? path.join(root, 'e2e/fixtures/sbx.mjs') : '/missing/wsl-e2e-sbx')),
    WSL_CODEX_BIN: '/missing/host-codex-must-not-run',
  };
  // Each run owns a fresh profile; retain it in tmp for failure evidence.
  const userData = options.userData ?? (await mkdtemp(path.join(tmpdir(), 'wsl-e2e-')));
  // Install the observer before the real entrypoint creates any renderer.
  const bootstrap = path.join(await mkdtemp(path.join(tmpdir(), 'wsl-e2e-bootstrap-')), 'main.cjs');
  await writeFile(
    bootstrap,
    `
const { app } = require('electron');
app.setAppPath(${JSON.stringify(desktopDir)});
globalThis.__wslRendererErrors = [];
${
  options.controlledObservation
    ? `
const { utilityProcess } = require('electron');
const originalFork = utilityProcess.fork.bind(utilityProcess);
globalThis.__wslObservationGate = { armed: false, deliveries: [], reads: 0 };
utilityProcess.fork = (...args) => {
  const child = originalFork(...args);
  const originalPost = child.postMessage.bind(child);
  child.postMessage = (message) => {
    const gate = globalThis.__wslObservationGate;
    if (message.method === 'observation.read') gate.reads++;
    if (gate.armed && message.method === 'environments.list') {
      gate.deliveries.push(() => originalPost(message));
      return;
    }
    return originalPost(message);
  };
  return child;
};
`
    : ''
}

app.on('web-contents-created', (_event, contents) => {
  contents.on('console-message', (event) => {
    if (contents.getURL().endsWith('/renderer/index.html') && event.level === 'error') {
      globalThis.__wslRendererErrors.push(event.message);
    }
  });
  ${
    options.startupError
      ? `contents.once('dom-ready', () => {
    if (contents.getURL().endsWith('/renderer/index.html')) {
      void contents.executeJavaScript(${JSON.stringify(`setTimeout(() => { throw new Error(${JSON.stringify(options.startupError)}); }, 0)`)});
    }
  });`
      : ''
  }
});
require(${JSON.stringify(path.join(desktopDir, 'out/main/index.js'))});
`,
  );
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
          args: [bootstrap, `--user-data-dir=${userData}`],
          cwd: desktopDir,
        });
  if (options.live) {
    console.log('LIVE_PROFILE', userData, 'ELECTRON_PID', app.process().pid);
    app.process().stderr?.on('data', (data: Buffer) => console.error('ELECTRON_STDERR', data.toString()));
  }
  // Browser 区的 WebContentsView 也会作为一个 Page 出现，这里按地址找工作台页面。
  const isWorkbench = (p: Page) => p.url().startsWith('file:') && p.url().endsWith('/renderer/index.html');
  const page = app.windows().find(isWorkbench) ?? (await app.waitForEvent('window', { predicate: isWorkbench }));
  const rendererErrors: string[] = [];
  page.on('pageerror', (error) => {
    rendererErrors.push(error.stack ?? error.message);
    console.error('RENDERER', error.stack ?? error.message);
  });
  const originalClose = app.close.bind(app);
  let closed = false;
  app.close = async () => {
    if (closed) return;
    closed = true;
    const running = app.process().exitCode === null && app.process().signalCode === null;
    const early =
      target === 'build' && running
        ? await app.evaluate(() => (globalThis as unknown as { __wslRendererErrors: string[] }).__wslRendererErrors)
        : [];
    rendererErrors.push(...early.filter((message) => !rendererErrors.some((error) => error.includes(message))));
    if (running) await originalClose();
    await rm(path.dirname(bootstrap), { recursive: true, force: true });
    assert.deepEqual(rendererErrors, [], 'Workbench renderer exceptions/errors fail every E2E');
  };
  try {
    await page.waitForSelector('div.app', { timeout: 10000 });
    await page.waitForSelector('[data-pane-id]', { state: 'attached', timeout: options.live ? 60000 : 10000 });
  } catch (error) {
    console.error('Renderer startup', rendererErrors, await page.locator('body').innerText());
    await app.close();
    throw error;
  }
  return { app, page, rendererErrors };
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

export async function workspaceSnapshot(page: Page) {
  return page.evaluate(() => window.studio.workbench.getSnapshot());
}
export async function browserState(page: Page) {
  const snapshot = await workspaceSnapshot(page);
  const resource = snapshot.workspaces.find((w) => w.workspaceId === snapshot.activeWorkspaceId)?.resources.find((r) => r.kind === 'web');
  if (!resource?.preview) throw new Error('browser snapshot unavailable');
  return resource.preview;
}
export async function terminalSnapshot(page: Page) {
  const snapshot = await workspaceSnapshot(page);
  const resource = snapshot.workspaces
    .find((w) => w.workspaceId === snapshot.activeWorkspaceId)
    ?.resources.find((r) => r.kind === 'terminal');
  if (!resource?.terminal) throw new Error('terminal snapshot unavailable');
  return resource.terminal;
}
export async function workshopNavigate(page: Page, label: string) {
  const navigation = page.getByRole('navigation', { name: 'Workshop 导航' });
  if (!(await navigation.isVisible())) await page.getByRole('button', { name: '展开 Workshop', exact: true }).click();
  await navigation.getByRole('button', { name: label, exact: true }).click();
}

export async function resourceCollection(page: Page) {
  const snapshot = await workspaceSnapshot(page);
  const collection = snapshot.workspaces.find((w) => w.workspaceId === snapshot.activeWorkspaceId)?.publicResources;
  if (!collection) throw new Error('public resource collection unavailable');
  return collection;
}

export async function setWorkspaceTheme(page: Page, theme: string) {
  await workshopNavigate(page, '设置');
  await page.getByLabel(/^空间主题 · /).selectOption(theme);
  await expectTheme(page, theme);
  await workshopNavigate(page, '空间');
}
async function expectTheme(page: Page, theme: string) {
  const snapshot = await workspaceSnapshot(page);
  assert.equal(snapshot.workspaces.find((w) => w.workspaceId === snapshot.activeWorkspaceId)?.theme, theme);
}
