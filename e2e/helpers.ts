import type { StudioApi, StudioDebugApi } from '../packages/protocol/src';
declare global {
  interface Window {
    studio: StudioApi & { debug?: StudioDebugApi };
  }
}
import { mkdtemp, writeFile, readFile, mkdir, rm } from 'node:fs/promises';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import path from 'node:path';
import { tmpdir } from 'node:os';
import { fileURLToPath } from 'node:url';
import { _electron, expect, type ElectronApplication, type Locator, type Page } from '@playwright/test';
import { appControlInjection } from './fixtures/app-control-injection';
import { appControlCancelGate } from './fixtures/app-control-cancel-gate';
import { sourceSnapshotFixture } from './fixtures/source-snapshot-fixture';
import { sourceDispatchAudit } from './fixtures/source-dispatch-audit';
import { addressInitialLoadGate } from './fixtures/address-initial-load-gate';
import { addressNavigationObserver } from './fixtures/address-navigation-observer';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
export const fixtureSandbox =
  process.env['WSL_E2E_TARGET'] === 'packaged' ? 'wsl-competition-00000000-0000-4000-8000-000000000001' : 'fixture-sandbox';
const desktopDir = path.join(root, 'apps/desktop');
export const screensDir = path.join(root, 'test-results/screens', process.env['WSL_E2E_TARGET'] === 'packaged' ? 'packaged' : 'build');

/** WSL_E2E_TARGET=packaged 时启动 pnpm package 生成的 .app，否则启动 pnpm build 的产物。 */
export const target = process.env['WSL_E2E_TARGET'] === 'packaged' ? 'packaged' : 'build';

async function defaultWindowGeometry(app: ElectronApplication, page: Page) {
  const native = await app.evaluate(({ BrowserWindow, screen }, url) => {
    const window = BrowserWindow.getAllWindows().find((candidate) => candidate.webContents.getURL() === url);
    if (!window) throw new Error('E2E workbench window is unavailable');
    const bounds = window.getBounds();
    const display = screen.getDisplayMatching(bounds);
    return {
      windowId: window.id,
      visible: window.isVisible(),
      bounds,
      contentBounds: window.getContentBounds(),
      workArea: display.workArea,
      scaleFactor: display.scaleFactor,
    };
  }, page.url());
  const renderer = await page.evaluate(() => ({ width: innerWidth, height: innerHeight, devicePixelRatio }));
  return { ...native, renderer };
}

async function prepareDefaultWindow(app: ElectronApplication, page: Page) {
  const requested = { width: 1440, height: 900, minimumHeight: 640 };
  try {
    await expect
      .poll(async () => (await defaultWindowGeometry(app, page)).visible, {
        timeout: 10000,
        message: 'The E2E workbench window must be shown before its default size is established',
      })
      .toBe(true);
    console.info('[e2e-default-window]', JSON.stringify({ phase: 'before', requested, ...(await defaultWindowGeometry(app, page)) }));
    await app.evaluate(
      ({ BrowserWindow }, { url, width, height }) => {
        const window = BrowserWindow.getAllWindows().find((candidate) => candidate.webContents.getURL() === url);
        if (!window) throw new Error('E2E workbench window is unavailable');
        window.setContentSize(width, height);
      },
      { url: page.url(), width: requested.width, height: requested.height },
    );
    // macOS may cap the height to its work area. Default cases require the wide
    // layout; later explicit setWindowSize calls still exercise narrow layouts.
    await page.waitForFunction(({ width, minimumHeight }) => innerWidth === width && innerHeight >= minimumHeight, requested, {
      timeout: 10000,
    });
    const actual = await defaultWindowGeometry(app, page);
    console.info('[e2e-default-window]', JSON.stringify({ phase: 'ready', requested, ...actual }));
    assert.equal(actual.contentBounds.width, requested.width, 'Default E2E content width must be 1440');
    assert.ok(actual.contentBounds.height >= requested.minimumHeight, 'Default E2E content height must be at least 640');
  } catch (error) {
    try {
      console.error('[e2e-default-window]', JSON.stringify({ phase: 'failed', requested, ...(await defaultWindowGeometry(app, page)) }));
    } catch (diagnosticError) {
      console.error('[e2e-default-window] geometry unavailable', String(diagnosticError).slice(0, 2048));
    }
    throw error;
  }
}

/** Establish the owned native window prerequisite before modeling a user click. */
export async function ensureForeground(app: ElectronApplication, page: Page): Promise<void> {
  const state = () =>
    app.evaluate(({ app, BrowserWindow, webContents }, url) => {
      const window = BrowserWindow.getAllWindows().find((candidate) => candidate.webContents.getURL() === url);
      if (!window) throw new Error('E2E workbench window is unavailable');
      return {
        windowId: window.id,
        visible: window.isVisible(),
        focused: window.isFocused(),
        appHidden: process.platform === 'darwin' ? app.isHidden() : null,
        focusedWebContentsId: webContents.getFocusedWebContents()?.id ?? null,
      };
    }, page.url());
  try {
    console.info('[e2e-foreground]', JSON.stringify({ phase: 'before', ...(await state()) }));
    await app.evaluate(({ app, BrowserWindow }, url) => {
      const window = BrowserWindow.getAllWindows().find((candidate) => candidate.webContents.getURL() === url);
      if (!window) throw new Error('E2E workbench window is unavailable');
      if (process.platform === 'darwin') app.show();
      else window.show();
      app.focus({ steal: true });
      window.focus();
    }, page.url());
    await expect
      .poll(
        async () => {
          const actual = await state();
          return actual.visible && actual.focused;
        },
        { timeout: 10000, message: 'The owned E2E workbench window must be visible and natively focused' },
      )
      .toBe(true);
    console.info('[e2e-foreground]', JSON.stringify({ phase: 'ready', ...(await state()) }));
  } catch (error) {
    let timeout: ReturnType<typeof setTimeout> | undefined;
    try {
      const actual = await Promise.race([
        state(),
        new Promise<never>((_, reject) => {
          timeout = setTimeout(() => reject(new Error('Foreground diagnostic timed out')), 2000);
        }),
      ]);
      console.error('[e2e-foreground]', JSON.stringify({ phase: 'failed', ...actual }));
    } catch (diagnosticError) {
      console.error('[e2e-foreground] state unavailable', String(diagnosticError).slice(0, 2048));
    } finally {
      clearTimeout(timeout);
    }
    throw error;
  }
}

export async function launchApp(
  options: {
    observationRoot?: string;
    sshEnvironment?: { host: string; port: number; username: string; hostKeySha256: string; root: string; agent: string };
    controlledObservation?: boolean;
    /** 测试专用：在 Main↔service 边界代替 guest Codex 轮次以驱动控制面，不调用模型。 */
    appControlInjection?: boolean;
    /** Test-only: observe real app calls and delay one genuine reply across cancellation. */
    appControlCancelGate?: boolean;
    /** Test-only: synthetic source/model frames; retains real Main storage and patch IPC. */
    sourceSnapshotFixture?: boolean;
    /** Test-only: observe durable baseline before model dispatch without mutating requests. */
    sourceDispatchAudit?: boolean;
    /** Test-only: defer the first genuine preview load until the address has focus. */
    addressInitialLoadGate?: boolean;
    /** Test-only: observe settlement of original address navigation invokes in the preload. */
    addressNavigationObserver?: boolean;
    controlledTerminal?: boolean;
    codexBin?: string;
    sbxBin?: string;
    sandbox?: string;
    live?: boolean;
    userData?: string;
    startupError?: string;
    cleanInstall?: boolean;
    /** 写入 WSL_DEBUG_STATUS=1：启用诊断通道（build 产物默认关闭；packaged 清除所有 WSL_* 之后再写入）。 */
    debugStatus?: boolean;
    /** 写入 WSL_STATUS_LOG=<path>（需同时启用诊断通道才有效）。 */
    statusLog?: string;
    /** 测试专用（W4b）：fixture sbx 把 `claude-agent-acp` 映射到确定性的假 ACP Agent 并运行该场景；不调用模型。 */
    fixtureAcpScenario?: string;
    /**
     * 不安装原生菜单测试接缝，让 `Menu.popup()` 显示真实的系统菜单（只用于人工 / 系统级截图核对）。
     * 默认安装：Playwright 无法点击系统菜单，接缝在 Main 里记录菜单并由测试触发菜单项。
     */
    realNativeMenus?: boolean;
  } = {},
): Promise<{ app: ElectronApplication; page: Page; rendererErrors: string[] }> {
  // 默认回归不得消耗模型；真实模型仅在显式 live 模式使用已选 sbx。
  const env: NodeJS.ProcessEnv = {
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
    WSL_SBX_NAME: options.live ? (process.env['WSL_SBX_NAME'] ?? 'wsl-sbx-smoke-20261006') : (options.sandbox ?? fixtureSandbox),
    WSL_SBX_BIN: options.live
      ? (process.env['WSL_SBX_BIN'] ?? '/opt/homebrew/bin/sbx')
      : (options.sbxBin ?? (options.codexBin ? path.join(root, 'e2e/fixtures/sbx.mjs') : '/missing/wsl-e2e-sbx')),
    WSL_CODEX_BIN: '/missing/host-codex-must-not-run',
    ...(options.fixtureAcpScenario ? { WSL_FIXTURE_ACP_SCENARIO: options.fixtureAcpScenario } : {}),
  };
  // Each run owns a fresh profile; retain it in tmp for failure evidence.
  const userData = options.userData ?? (await mkdtemp(path.join(tmpdir(), 'wsl-e2e-')));
  if (options.cleanInstall) {
    for (const key of Object.keys(env)) if (key.startsWith('WSL_')) delete env[key as keyof typeof env];
    env['PATH'] = '/usr/bin:/bin:/usr/sbin:/sbin';
  } else if (target === 'packaged') {
    await mkdir(userData, { recursive: true });
    const file = path.join(userData, 'runtime.json');
    try {
      await readFile(file);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
      const ssh = options.sshEnvironment;
      await writeFile(
        file,
        JSON.stringify({
          schemaVersion: 1,
          stage: 'ready',
          busy: false,
          error: null,
          restartRequired: false,
          pendingLogin: null,
          modelCredentialsConfigured: true,
          modelConnectionVerified: false,
          config: {
            schemaVersion: 1,
            sbxBinary: env.WSL_SBX_BIN,
            sandbox: env.WSL_SBX_NAME,
            pythonBinary: '/bundled/runtime/python/bin/python3',
            localRoot: options.observationRoot || null,
            ssh: ssh ? { host: ssh.host, port: ssh.port, username: ssh.username, hostKeySha256: ssh.hostKeySha256, root: ssh.root } : null,
          },
        }),
      );
    }
    for (const key of Object.keys(env)) if (key.startsWith('WSL_')) delete env[key as keyof typeof env];
    if (options.live) env['PATH'] = '/usr/bin:/bin:/usr/sbin:/sbin';
  }
  // 诊断开关只由选项决定：先清除继承自外部环境的值，且在上面清除所有 WSL_* 的分支之后写入。
  delete env['WSL_DEBUG_STATUS'];
  delete env['WSL_STATUS_LOG'];
  if (options.debugStatus) env['WSL_DEBUG_STATUS'] = '1';
  if (options.debugStatus && options.statusLog) env['WSL_STATUS_LOG'] = options.statusLog;
  // The build bootstrap installs fixtures before the real entrypoint creates any renderer.
  const bootstrap = path.join(await mkdtemp(path.join(tmpdir(), 'wsl-e2e-bootstrap-')), 'main.cjs');
  // Keep each build launch's Main ledger after bootstrap cleanup, including profile-reuse tests.
  const mainErrorsFile = path.join(userData, `main-errors-${path.basename(path.dirname(bootstrap))}.jsonl`);
  const rendererErrorsFile = path.join(path.dirname(bootstrap), 'renderer-errors.jsonl');
  await writeFile(rendererErrorsFile, '');
  const addressPreload = path.join(path.dirname(bootstrap), 'address-navigation-observer.cjs');
  if (options.addressNavigationObserver) await writeFile(addressPreload, addressNavigationObserver);
  await writeFile(
    bootstrap,
    `
const { app } = require('electron');
app.setAppPath(${JSON.stringify(desktopDir)});
globalThis.__wslRendererErrors = [];
const rendererErrorFs = require('node:fs');
const rendererErrorsFile = ${JSON.stringify(rendererErrorsFile)};
${
  options.addressNavigationObserver
    ? `app.once('ready', () => {
  require('electron').session.defaultSession.registerPreloadScript({ type: 'frame', filePath: ${JSON.stringify(addressPreload)} });
});`
    : ''
}
${options.appControlInjection ? appControlInjection : ''}
${options.appControlCancelGate ? appControlCancelGate : ''}
${options.sourceSnapshotFixture ? sourceSnapshotFixture : ''}
${options.sourceDispatchAudit ? sourceDispatchAudit : ''}
${options.addressInitialLoadGate ? addressInitialLoadGate : ''}
${
  options.controlledObservation || options.controlledTerminal
    ? `
const { utilityProcess } = require('electron');
const originalFork = utilityProcess.fork.bind(utilityProcess);
globalThis.__wslObservationGate = { armed: false, deliveries: [], reads: 0 };
globalThis.__wslTerminalGate = { armed: ${JSON.stringify(options.controlledTerminal ?? false)}, deliveries: [] };
utilityProcess.fork = (...args) => {
  const child = originalFork(...args);
  const originalPost = child.postMessage.bind(child);
  child.postMessage = (message) => {
    const terminalGate = globalThis.__wslTerminalGate;
    if (terminalGate.armed && message.method === 'terminal.open') {
      terminalGate.deliveries.push(() => originalPost(message));
      return;
    }
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
      rendererErrorFs.appendFileSync(rendererErrorsFile, JSON.stringify(event.message) + '\\n');
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
const mainErrorsFile = ${JSON.stringify(mainErrorsFile)};
const uncaughtExceptionListenersBefore = process.listenerCount('uncaughtException');
process.on('uncaughtExceptionMonitor', (error, origin) => {
  rendererErrorFs.appendFileSync(mainErrorsFile, JSON.stringify({ kind: 'error', name: error.name, message: error.message, stack: error.stack, origin, pid: process.pid }) + '\\n');
});
rendererErrorFs.appendFileSync(mainErrorsFile, JSON.stringify({ kind: 'monitor-installed', pid: process.pid, uncaughtExceptionListenersBefore, uncaughtExceptionListenersAfter: process.listenerCount('uncaughtException') }) + '\\n');
require(${JSON.stringify(path.join(desktopDir, 'out/main/index.js'))});
`,
  );
  const app =
    target === 'packaged'
      ? await _electron.launch({
          env: Object.fromEntries(Object.entries(env).filter((entry): entry is [string, string] => entry[1] !== undefined)),
          args: [`--user-data-dir=${userData}`],
          executablePath: path.join(
            process.env['WSL_E2E_APP_PATH'] ?? path.join(desktopDir, 'release/mac-arm64/Web Studio Lab.app'),
            'Contents/MacOS/Web Studio Lab',
          ),
        })
      : await _electron.launch({
          env: Object.fromEntries(Object.entries(env).filter((entry): entry is [string, string] => entry[1] !== undefined)),
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
  const ownedProcess = app.process();
  const originalClose = app.close.bind(app);
  let closed = false;
  let transportClosed = false;
  app.on('close', () => {
    transportClosed = true;
  });
  app.close = async () => {
    if (closed) return;
    closed = true;
    const failures: unknown[] = [];
    try {
      const running = ownedProcess.exitCode === null && ownedProcess.signalCode === null;
      if (running && !transportClosed) await originalClose();
    } catch (error) {
      failures.push(error);
    }
    try {
      if (ownedProcess.exitCode === null && ownedProcess.signalCode === null) {
        await new Promise<void>((resolve, reject) => {
          const finished = () => {
            clearTimeout(timeout);
            resolve();
          };
          const timeout = setTimeout(() => {
            ownedProcess.removeListener('exit', finished);
            reject(new Error('Owned Electron process did not exit within 10 seconds after close'));
          }, 10000);
          ownedProcess.once('exit', finished);
        });
      }
    } catch (error) {
      failures.push(error);
    }
    const processExited = ownedProcess.exitCode !== null || ownedProcess.signalCode !== null;
    try {
      // The Main transport can close before ChildProcess publishes its exit. Read the launch-owned ledger, not that transport.
      if (processExited && target === 'build') {
        const lines = (await readFile(rendererErrorsFile, 'utf8')).split('\n').filter(Boolean);
        for (const line of lines) {
          const message: unknown = JSON.parse(line);
          if (typeof message !== 'string') throw new Error('Invalid renderer error ledger record');
          if (!rendererErrors.some((error) => error.includes(message))) rendererErrors.push(message);
        }
      }
    } catch (error) {
      failures.push(error);
    }
    try {
      // Packaged launches bypass this bootstrap; Main exception coverage here is build-only.
      if (target === 'build') {
        const lines = (await readFile(mainErrorsFile, 'utf8')).split('\n').filter(Boolean);
        const mainErrors: unknown[] = [];
        let receiptCount = 0;
        for (const line of lines) {
          const record: unknown = JSON.parse(line);
          assert.ok(
            typeof record === 'object' && record !== null && 'kind' in record && 'pid' in record,
            'Invalid Main error ledger record',
          );
          assert.equal(record.pid, ownedProcess.pid, 'Main error ledger must belong to this launch');
          if (record.kind === 'monitor-installed') {
            assert.ok(
              'uncaughtExceptionListenersBefore' in record && 'uncaughtExceptionListenersAfter' in record,
              'Missing Main monitor receipt',
            );
            assert.equal(record.uncaughtExceptionListenersBefore, 1, 'Main default exception handler must be the only handler');
            assert.equal(record.uncaughtExceptionListenersAfter, 1, 'Main default exception handler must remain the only handler');
            receiptCount += 1;
          } else if (record.kind === 'error') mainErrors.push(record);
          else throw new Error('Unknown Main error ledger record');
        }
        assert.equal(receiptCount, 1, 'Each build launch must install exactly one Main exception monitor');
        assert.deepEqual(mainErrors, [], `Main uncaught exceptions fail build E2E; ledger retained at ${mainErrorsFile}`);
      }
    } catch (error) {
      failures.push(error);
    }
    try {
      if (processExited) await rm(path.dirname(bootstrap), { recursive: true, force: true });
    } catch (error) {
      failures.push(error);
    }
    try {
      assert.deepEqual(rendererErrors, [], 'Workbench renderer exceptions/errors fail every E2E');
    } catch (error) {
      failures.push(error);
    }
    if (failures.length === 1) throw failures[0];
    if (failures.length > 1) throw new AggregateError(failures, failures.map(String).join('; '));
  };
  try {
    if (!options.realNativeMenus) await installNativeMenuSeam(app);
    if (target === 'packaged' && options.addressNavigationObserver) {
      // Packaged launches bypass the bootstrap; reload so the same session preload precedes the real preload.
      await app.evaluate(({ session }, filePath) => {
        session.defaultSession.registerPreloadScript({ type: 'frame', filePath });
      }, addressPreload);
      await page.reload();
    }
    await page.waitForSelector('div.app', { timeout: 10000 });
    await ensureForeground(app, page);
    await prepareDefaultWindow(app, page);
    if (!options.cleanInstall) await page.waitForSelector('[data-pane-id]', { state: 'attached', timeout: options.live ? 60000 : 10000 });
  } catch (error) {
    try {
      console.error('Renderer startup', rendererErrors, (await page.locator('body').innerText({ timeout: 2000 })).slice(0, 8192));
    } catch (diagnosticError) {
      console.error('Renderer startup diagnostics unavailable', String(diagnosticError).slice(0, 2048));
    }
    try {
      await app.close();
    } catch (cleanupError) {
      console.error('Renderer startup cleanup failed', cleanupError);
    }
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

/** 在应用菜单中按 label 找到菜单项并触发（等同用户点击或按其快捷键）；返回其 accelerator。找不到时抛错。 */
export function clickAppMenu(app: ElectronApplication, label: string): Promise<string | null> {
  return app.evaluate(({ Menu, BrowserWindow }, target) => {
    const find = (items: Electron.MenuItem[]): Electron.MenuItem | undefined => {
      for (const item of items) {
        if (item.label === target) return item;
        const nested = item.submenu ? find(item.submenu.items) : undefined;
        if (nested) return nested;
      }
      return undefined;
    };
    const item = find(Menu.getApplicationMenu()?.items ?? []);
    if (!item) throw new Error(`missing menu ${target}`);
    item.click(undefined, BrowserWindow.getAllWindows()[0], undefined as never);
    return item.accelerator ?? null;
  }, label);
}

/** 应用菜单中是否存在 label 包含 text 的菜单项（含子菜单）。 */
export function appMenuHas(app: ElectronApplication, text: string): Promise<boolean> {
  return app.evaluate(({ Menu }, target) => {
    const has = (items: Electron.MenuItem[]): boolean =>
      items.some((item) => item.label.includes(target) || (item.submenu ? has(item.submenu.items) : false));
    return has(Menu.getApplicationMenu()?.items ?? []);
  }, text);
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

export interface StatusShimAgentControl {
  state: 'idle' | 'active' | 'paused_by_user';
  runId: string | null;
  since: string | null;
  lastAction: string | null;
}

export async function installStatusShim(app: ElectronApplication) {
  await app.evaluate(({ ipcMain, BrowserWindow }) => {
    type Shim = {
      agentControl: StatusShimAgentControl | null;
      terminal: Record<string, Record<string, unknown> | null>;
      resource: Record<string, { environmentId?: string | null; unavailableReason?: string | null }>;
      browserActions: Array<{ action: string; workspaceId: string; resourceId: string }>;
    };
    const shim: Shim = ((globalThis as unknown as { __wslStatusShim: Shim }).__wslStatusShim = {
      agentControl: null,
      terminal: {},
      resource: {},
      browserActions: [],
    });
    type Resource = {
      resourceId: string;
      kind: string;
      environmentId?: string | null;
      unavailableReason?: string | null;
      preview?: { agentControl?: unknown } | null;
      terminal?: unknown;
    };
    type Snapshot = { workspaces: Array<{ resources: Resource[] }> };
    const transform = <T>(snapshot: T): T => {
      const next = structuredClone(snapshot) as T & Snapshot;
      for (const workspace of next.workspaces)
        for (const resource of workspace.resources) {
          const patch = shim.resource[resource.resourceId];
          if (patch) {
            if ('environmentId' in patch) resource.environmentId = patch.environmentId ?? null;
            if ('unavailableReason' in patch) resource.unavailableReason = patch.unavailableReason ?? null;
          }
          if (resource.kind === 'web' && resource.preview && shim.agentControl) resource.preview.agentControl = shim.agentControl;
          if (resource.resourceId in shim.terminal) resource.terminal = shim.terminal[resource.resourceId];
        }
      return next;
    };
    type Handler = (event: Electron.IpcMainInvokeEvent, request?: { type?: string }) => Promise<unknown>;
    const handlers = (ipcMain as unknown as { _invokeHandlers: Map<string, Handler> })._invokeHandlers;
    const get = handlers.get('workbench:get-snapshot')!;
    const command = handlers.get('workbench:command')!;
    ipcMain.removeHandler('workbench:get-snapshot');
    ipcMain.handle('workbench:get-snapshot', async (event) => transform((await get(event)) as Snapshot));
    ipcMain.removeHandler('workbench:command');
    ipcMain.handle('workbench:command', async (event, request) => {
      if (request?.type === 'browserAction') {
        const { action, workspaceId, resourceId } = request as { action: string; workspaceId: string; resourceId: string };
        shim.browserActions.push({ action, workspaceId, resourceId });
      }
      const result = (await command(event, request)) as { snapshot: Snapshot };
      return { ...result, snapshot: transform(result.snapshot) };
    });
    const contents = BrowserWindow.getAllWindows()[0]!.webContents;
    const send = contents.send.bind(contents);
    contents.send = ((channel: string, ...args: Array<{ snapshot?: Snapshot }>) => {
      const payload = args[0];
      if (channel === 'workbench:event' && payload?.snapshot) return send(channel, { ...payload, snapshot: transform(payload.snapshot) });
      return send(channel, ...args);
    }) as typeof contents.send;
  });
}

export const setStatusShim = (
  app: ElectronApplication,
  patch: {
    agentControl?: StatusShimAgentControl | null;
    terminal?: Record<string, Record<string, unknown> | null>;
    resource?: Record<string, { environmentId?: 'local' | 'sandbox' | 'ssh' | null; unavailableReason?: string | null }>;
  },
) =>
  app.evaluate((_electron, next) => {
    const shim = (globalThis as unknown as { __wslStatusShim: Record<string, unknown> }).__wslStatusShim;
    if ('agentControl' in next) shim.agentControl = next.agentControl ?? null;
    if (next.terminal) for (const [id, value] of Object.entries(next.terminal)) (shim.terminal as Record<string, unknown>)[id] = value;
    if (next.resource) for (const [id, value] of Object.entries(next.resource)) (shim.resource as Record<string, unknown>)[id] = value;
  }, patch);

export const statusShimBrowserActions = (app: ElectronApplication) =>
  app.evaluate(
    () =>
      (globalThis as unknown as { __wslStatusShim: { browserActions: Array<{ action: string; workspaceId: string; resourceId: string }> } })
        .__wslStatusShim.browserActions,
  );

export async function pushWorkbenchSnapshot(page: Page) {
  const snapshot = await workspaceSnapshot(page);
  const workspace = snapshot.workspaces.find((w) => w.workspaceId === snapshot.activeWorkspaceId)!;
  const result = await page.evaluate((command) => window.studio.workbench.command(command as never), {
    commandId: crypto.randomUUID(),
    type: 'focusPane',
    workspaceId: workspace.workspaceId,
    paneId: workspace.activePaneId,
  });
  if (!result?.ok) throw new Error(`focusPane 触发快照失败：${JSON.stringify(result)}`);
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
/* ---------- 原生菜单测试接缝（OPS-1 S5） ---------- */

type NativeMenuSeam = {
  menus: Array<{ menu: Electron.Menu; options: Electron.PopupOptions; closed: boolean; windowMatches: boolean; withinContent: boolean }>;
  /** 尚未返回给 renderer 的 `shell:show-menu` 请求数。 */
  pending: number;
};

/**
 * Playwright 点不到系统菜单。接缝只在测试进程经 `electronApp.evaluate` 安装：替换 Main 里的 `Menu.prototype.popup`，
 * 记录产品构建好的菜单与弹出选项，不显示系统菜单；测试再调用菜单项自己的 `click` 与关闭回调（可模拟“关闭回调早于 click”）。
 * 另外包一层既有的 `shell:show-menu` 处理函数（来源与输入校验照旧在原处理函数里），只计数尚未返回的请求，
 * 让测试在菜单关闭后等到结果已交还 renderer 再继续。产品代码没有为此增加任何路径或环境变量。
 */
export async function installNativeMenuSeam(app: ElectronApplication): Promise<void> {
  await app.evaluate(({ Menu, ipcMain, BrowserWindow }) => {
    type Seam = {
      menus: Array<{
        menu: Electron.Menu;
        options: Electron.PopupOptions;
        closed: boolean;
        windowMatches: boolean;
        withinContent: boolean;
      }>;
      pending: number;
    };
    const host = globalThis as unknown as { __wslNativeMenus?: Seam };
    if (host.__wslNativeMenus) return;
    const seam: Seam = (host.__wslNativeMenus = { menus: [], pending: 0 });
    Menu.prototype.popup = function popup(this: Electron.Menu, options?: Electron.PopupOptions) {
      const value = options ?? {};
      // 与真实弹出相同的前提：菜单弹在工作台窗口上；坐标（若有）是内容区内的整数。
      const window = BrowserWindow.getAllWindows()[0];
      const [width = 0, height = 0] = window?.getContentSize() ?? [];
      const inside = (coordinate: number | undefined, extent: number) =>
        coordinate === undefined || (Number.isInteger(coordinate) && coordinate >= 0 && coordinate < extent);
      seam.menus.push({
        menu: this,
        options: value,
        closed: false,
        windowMatches: !!window && value.window === window,
        withinContent: inside(value.x, width) && inside(value.y, height) && (value.x === undefined) === (value.y === undefined),
      });
    };
    type Handler = (event: Electron.IpcMainInvokeEvent, request: unknown) => Promise<unknown>;
    const handlers = (ipcMain as unknown as { _invokeHandlers: Map<string, Handler> })._invokeHandlers;
    const original = handlers.get('shell:show-menu');
    if (!original) throw new Error('shell:show-menu 尚未注册');
    ipcMain.removeHandler('shell:show-menu');
    ipcMain.handle('shell:show-menu', async (event, request) => {
      seam.pending++;
      try {
        return await original(event, request);
      } finally {
        seam.pending--;
      }
    });
  });
}

export interface NativeMenuItemInfo {
  label: string;
  enabled: boolean;
  /** 只有单选项（运行记录的当前视图）才有。 */
  checked?: boolean;
}
export interface NativeMenuInfo {
  /** 本次启动中第几个弹出的菜单（从 0 开始）。 */
  index: number;
  items: NativeMenuItemInfo[];
  /** 传给 `Menu.popup()` 的窗口坐标；未传时为 null（系统放在指针处）。 */
  x: number | null;
  y: number | null;
  closed: boolean;
  /** Menu.popup 是否传入了工作台窗口。 */
  windowMatches: boolean;
  /** 坐标（若有）是否为内容区内的整数。 */
  withinContent: boolean;
}

/** 断言原生菜单弹出位置在 (x, y) 处（取整与指针坐标的亚像素差异允许 1px）。 */
export function expectMenuAt(menu: NativeMenuInfo, x: number, y: number): void {
  expect(menu.x, '菜单应传入横坐标').not.toBeNull();
  expect(menu.y, '菜单应传入纵坐标').not.toBeNull();
  expect(Math.abs(menu.x! - x), `菜单横坐标 ${menu.x} 应接近 ${x}`).toBeLessThanOrEqual(1);
  expect(Math.abs(menu.y! - y), `菜单纵坐标 ${menu.y} 应接近 ${y}`).toBeLessThanOrEqual(1);
}

/** 已弹出的原生菜单数量（含已关闭的）。 */
export function nativeMenuCount(app: ElectronApplication): Promise<number> {
  return app.evaluate(() => (globalThis as unknown as { __wslNativeMenus: NativeMenuSeam }).__wslNativeMenus.menus.length);
}

/** 读取第 index 个（缺省为最后一个）弹出的原生菜单：条目文字、是否可用与弹出坐标。分隔线不列出。 */
export function nativeMenu(app: ElectronApplication, index?: number): Promise<NativeMenuInfo | null> {
  return app.evaluate((_electron, at) => {
    const { menus } = (globalThis as unknown as { __wslNativeMenus: NativeMenuSeam }).__wslNativeMenus;
    const position = at ?? menus.length - 1;
    const recorded = menus[position];
    if (!recorded) return null;
    return {
      index: position,
      items: recorded.menu.items
        .filter((item) => item.type !== 'separator')
        .map((item) => ({ label: item.label, enabled: item.enabled, ...(item.type === 'radio' ? { checked: item.checked } : {}) })),
      x: recorded.options.x ?? null,
      y: recorded.options.y ?? null,
      closed: recorded.closed,
      windowMatches: recorded.windowMatches,
      withinContent: recorded.withinContent,
    };
  }, index);
}

/** 等到每个已关闭菜单的结果都已由 Main 返回给 renderer（只剩仍打开的菜单在等待）。 */
async function nativeMenusSettled(app: ElectronApplication): Promise<void> {
  await expect
    .poll(
      () =>
        app.evaluate(() => {
          const seam = (globalThis as unknown as { __wslNativeMenus: NativeMenuSeam }).__wslNativeMenus;
          return seam.pending - seam.menus.filter((entry) => !entry.closed).length;
        }),
      { message: '原生菜单的结果应已返回 renderer' },
    )
    .toBeLessThanOrEqual(0);
}

/** 执行 open（点击触发器、按键等），等到 Main 弹出一个新的原生菜单并返回它。 */
export async function openNativeMenu(app: ElectronApplication, open: () => Promise<unknown>): Promise<NativeMenuInfo> {
  const before = await nativeMenuCount(app);
  await open();
  await expect.poll(() => nativeMenuCount(app), { message: '应弹出一个原生菜单' }).toBeGreaterThan(before);
  const menu = await nativeMenu(app, before);
  if (!menu) throw new Error('原生菜单未记录');
  expect(menu.windowMatches, 'Menu.popup 应传入工作台窗口').toBe(true);
  expect(menu.withinContent, 'Menu.popup 的坐标应为内容区内的整数').toBe(true);
  return menu;
}

/**
 * 打开原生菜单，直到 label 的可用状态等于 enabled（等价于对 HTML 菜单项 toBeEnabled / toBeDisabled 的自动重试）：
 * 菜单内容在打开时由 Main 快照决定，不符合时关闭后稍等再打开。返回仍打开的菜单。
 */
export async function openNativeMenuWhen(
  app: ElectronApplication,
  open: () => Promise<unknown>,
  label: string,
  enabled: boolean,
  timeout = 10_000,
): Promise<NativeMenuInfo> {
  const deadline = Date.now() + timeout;
  for (;;) {
    const menu = await openNativeMenu(app, open);
    const item = menu.items.find((entry) => entry.label === label);
    if (item && item.enabled === enabled) return menu;
    await dismissNativeMenu(app);
    if (Date.now() > deadline) throw new Error(`原生菜单项「${label}」未变为${enabled ? '可用' : '禁用'}：${JSON.stringify(menu.items)}`);
    await new Promise((resolve) => setTimeout(resolve, 200));
  }
}

/**
 * 在最近一个未关闭的原生菜单里选择 label 对应的菜单项。默认先 click 再触发关闭回调；
 * `closeFirst` 模拟 macOS 上关闭回调早于 click 到达（R3）。禁用项不可选择（与系统菜单一致），会抛错。
 * 返回前等到选择已交还 renderer。
 */
export async function chooseNativeMenuItem(app: ElectronApplication, label: string, options: { closeFirst?: boolean } = {}): Promise<void> {
  await app.evaluate(
    (_electron, { label, closeFirst }) => {
      const { menus } = (globalThis as unknown as { __wslNativeMenus: NativeMenuSeam }).__wslNativeMenus;
      const recorded = [...menus].reverse().find((entry) => !entry.closed);
      if (!recorded) throw new Error('没有打开的原生菜单');
      const item = recorded.menu.items.find((entry) => entry.type !== 'separator' && entry.label === label);
      if (!item) throw new Error(`原生菜单中没有「${label}」：${recorded.menu.items.map((entry) => entry.label).join(' / ')}`);
      if (!item.enabled) throw new Error(`原生菜单项「${label}」已禁用`);
      recorded.closed = true;
      const click = () => item.click(undefined as never, undefined as never, undefined as never);
      if (closeFirst) {
        recorded.options.callback?.();
        click();
      } else {
        click();
        recorded.options.callback?.();
      }
    },
    { label, closeFirst: options.closeFirst ?? false },
  );
  await nativeMenusSettled(app);
}

/** 不选择任何项就关闭最近一个未关闭的原生菜单（等同 Esc 或点击菜单外部）；返回前等到取消已交还 renderer。 */
export async function dismissNativeMenu(app: ElectronApplication): Promise<void> {
  await app.evaluate(() => {
    const { menus } = (globalThis as unknown as { __wslNativeMenus: NativeMenuSeam }).__wslNativeMenus;
    const recorded = [...menus].reverse().find((entry) => !entry.closed);
    if (!recorded) throw new Error('没有打开的原生菜单');
    recorded.closed = true;
    recorded.options.callback?.();
  });
  await nativeMenusSettled(app);
}

/** 点击触发器打开原生菜单并选择一项。 */
export async function pickNativeMenu(app: ElectronApplication, trigger: Locator, label: string): Promise<NativeMenuInfo> {
  // 菜单内容在打开时由 Main 快照决定：等到该项可用再选（与 HTML 菜单项点击前的可用等待等价，不绕过禁用）。
  const menu = await openNativeMenuWhen(app, () => trigger.click(), label, true);
  await chooseNativeMenuItem(app, label);
  return menu;
}

/**
 * 网页工具栏的原生菜单：「接收会话」（OPS-1 S1 接收者按钮，可访问名称为「接收会话：{会话}」；菜单：本空间会话 / 新建会话 / 打开接收会话，
 * 选择只设定之后采集的接收者，不开始采集）或「更多网页操作」（⋯）。
 * scope 用于多个网页窗格同时存在时限定在某个 .workspace-browser 内。选择 item 后返回菜单内容。
 */
export async function openBrowserMenu(
  app: ElectronApplication,
  page: Page,
  name: '接收会话' | '更多网页操作',
  item: string,
  scope: Page | Locator = page,
): Promise<NativeMenuInfo> {
  const trigger =
    name === '接收会话' ? scope.getByRole('button', { name: /^接收会话：/ }) : scope.getByRole('button', { name, exact: true });
  return pickNativeMenu(app, trigger, item);
}

/** 窗格头「窗格操作」（⋯）的触发器。index 为第几个可见窗格或 'last'（缺省为活动窗格）。 */
export function paneMenuButton(page: Page, index?: number | 'last'): Locator {
  const visible = page.locator('.workspace-pane:visible');
  const pane =
    index === undefined ? page.locator('.workspace-pane.pane-active:visible') : index === 'last' ? visible.last() : visible.nth(index);
  return pane.getByRole('button', { name: '窗格操作', exact: true });
}

/** 窗格头「窗格操作」（⋯）原生菜单：左右分屏、上下分屏、平均分割、关闭窗格（标签保留）。 */
export async function paneMenu(app: ElectronApplication, page: Page, item: string, index?: number | 'last'): Promise<NativeMenuInfo> {
  return pickNativeMenu(app, paneMenuButton(page, index), item);
}

/** 垂直标签「{标题}操作」（···）原生菜单。 */
export async function tabMenu(app: ElectronApplication, page: Page, title: string, item: string): Promise<NativeMenuInfo> {
  return pickNativeMenu(app, page.getByRole('button', { name: `${title}操作`, exact: true }), item);
}

/** 底部「新建标签」原生菜单：选择类型后打开预选该类型的创建表单，返回表单。 */
export async function openNewTabForm(app: ElectronApplication, page: Page, kind: '网页' | '终端' | 'Agent 会话' | '文件' | 'SSH') {
  await pickNativeMenu(app, page.getByRole('button', { name: '新建标签', exact: true }), kind);
  const dialog = page.getByRole('dialog', { name: '新建标签' });
  await dialog.waitFor({ state: 'visible' });
  return dialog;
}

export async function workshopNavigate(page: Page, label: string) {
  const navigation = page.getByRole('navigation', { name: 'Workshop 导航' });
  if (!(await navigation.isVisible())) await page.getByRole('button', { name: '展开 Workshop', exact: true }).click();
  await navigation.getByRole('button', { name: label, exact: true }).click();
}

export async function resourceCollection(page: Page) {
  const snapshot = await workspaceSnapshot(page);
  const catalog = snapshot.catalog;
  if (!catalog) throw new Error('account catalogue unavailable');
  const spaceId = snapshot.activeWorkspaceId;
  const resources = await page.evaluate(
    async ({ links, spaceId }) => {
      const resources = [];
      for (const link of links) {
        const snapshot = await window.studio.workbench.resourceRevision(link.resourceId, link.referenceVersion!);
        if (snapshot.evidence.kind === 'web')
          resources.push({ ...snapshot.evidence.snapshot, resourceId: snapshot.resourceId, version: snapshot.version, spaceId });
      }
      return resources;
    },
    {
      links: catalog.links
        .filter(
          (link) =>
            link.workspaceId === spaceId && catalog.resources.some((item) => item.resourceId === link.resourceId && item.latestVersion),
        )
        .map((link) => ({
          ...link,
          referenceVersion: link.referenceVersion ?? catalog.resources.find((item) => item.resourceId === link.resourceId)!.latestVersion,
        })),
      spaceId,
    },
  );
  return { spaceId, revision: catalog.revision, resources };
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
