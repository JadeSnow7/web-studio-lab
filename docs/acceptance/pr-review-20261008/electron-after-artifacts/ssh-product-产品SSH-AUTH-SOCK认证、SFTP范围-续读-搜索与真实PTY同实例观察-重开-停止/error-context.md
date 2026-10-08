# Instructions

- Following Playwright test failed.
- Explain why, be concise, respect Playwright best practices.
- Provide a snippet of code with the fix, if possible.

# Test info

- Name: ssh-product.spec.ts >> 产品SSH_AUTH_SOCK认证、SFTP范围/续读/搜索与真实PTY同实例观察/重开/停止
- Location: e2e/ssh-product.spec.ts:39:1

# Error details

```
AggregateError: Product SSH scenario and cleanup failed
```

```
TypeError: Cannot read properties of undefined (reading '_object')
```

# Test source

```ts
  45  |           WSL_SSH_ROOT: options.sshEnvironment.root,
  46  |           SSH_AUTH_SOCK: options.sshEnvironment.agent,
  47  |         }
  48  |       : {}),
  49  |     ...(options.observationRoot === undefined ? {} : { WSL_OBSERVATION_ROOT: options.observationRoot }),
  50  |     WSL_SBX_NAME: options.live ? (process.env['WSL_SBX_NAME'] ?? 'wsl-sbx-smoke-20261006') : (options.sandbox ?? 'fixture-sandbox'),
  51  |     WSL_SBX_BIN: options.live
  52  |       ? (process.env['WSL_SBX_BIN'] ?? '/opt/homebrew/bin/sbx')
  53  |       : (options.sbxBin ?? (options.codexBin ? path.join(root, 'e2e/fixtures/sbx.mjs') : '/missing/wsl-e2e-sbx')),
  54  |     WSL_CODEX_BIN: '/missing/host-codex-must-not-run',
  55  |   };
  56  |   // Each run owns a fresh profile; retain it in tmp for failure evidence.
  57  |   const userData = options.userData ?? (await mkdtemp(path.join(tmpdir(), 'wsl-e2e-')));
  58  |   // Install the observer before the real entrypoint creates any renderer.
  59  |   const bootstrap = path.join(await mkdtemp(path.join(tmpdir(), 'wsl-e2e-bootstrap-')), 'main.cjs');
  60  |   await writeFile(
  61  |     bootstrap,
  62  |     `
  63  | const { app } = require('electron');
  64  | app.setAppPath(${JSON.stringify(desktopDir)});
  65  | globalThis.__wslRendererErrors = [];
  66  | ${
  67  |   options.controlledObservation || options.controlledTerminal
  68  |     ? `
  69  | const { utilityProcess } = require('electron');
  70  | const originalFork = utilityProcess.fork.bind(utilityProcess);
  71  | globalThis.__wslObservationGate = { armed: false, deliveries: [], reads: 0 };
  72  | globalThis.__wslTerminalGate = { armed: ${JSON.stringify(options.controlledTerminal ?? false)}, deliveries: [] };
  73  | utilityProcess.fork = (...args) => {
  74  |   const child = originalFork(...args);
  75  |   const originalPost = child.postMessage.bind(child);
  76  |   child.postMessage = (message) => {
  77  |     const terminalGate = globalThis.__wslTerminalGate;
  78  |     if (terminalGate.armed && message.method === 'terminal.open') {
  79  |       terminalGate.deliveries.push(() => originalPost(message));
  80  |       return;
  81  |     }
  82  |     const gate = globalThis.__wslObservationGate;
  83  |     if (message.method === 'observation.read') gate.reads++;
  84  |     if (gate.armed && message.method === 'environments.list') {
  85  |       gate.deliveries.push(() => originalPost(message));
  86  |       return;
  87  |     }
  88  |     return originalPost(message);
  89  |   };
  90  |   return child;
  91  | };
  92  | `
  93  |     : ''
  94  | }
  95  | 
  96  | app.on('web-contents-created', (_event, contents) => {
  97  |   contents.on('console-message', (event) => {
  98  |     if (contents.getURL().endsWith('/renderer/index.html') && event.level === 'error') {
  99  |       globalThis.__wslRendererErrors.push(event.message);
  100 |     }
  101 |   });
  102 |   ${
  103 |     options.startupError
  104 |       ? `contents.once('dom-ready', () => {
  105 |     if (contents.getURL().endsWith('/renderer/index.html')) {
  106 |       void contents.executeJavaScript(${JSON.stringify(`setTimeout(() => { throw new Error(${JSON.stringify(options.startupError)}); }, 0)`)});
  107 |     }
  108 |   });`
  109 |       : ''
  110 |   }
  111 | });
  112 | require(${JSON.stringify(path.join(desktopDir, 'out/main/index.js'))});
  113 | `,
  114 |   );
  115 |   const app =
  116 |     target === 'packaged'
  117 |       ? await _electron.launch({
  118 |           env,
  119 |           args: [`--user-data-dir=${userData}`],
  120 |           executablePath: path.join(desktopDir, 'release/mac-arm64/Web Studio Lab.app/Contents/MacOS/Web Studio Lab'),
  121 |         })
  122 |       : await _electron.launch({
  123 |           env,
  124 |           executablePath: createRequire(path.join(desktopDir, 'package.json'))('electron') as unknown as string,
  125 |           args: [bootstrap, `--user-data-dir=${userData}`],
  126 |           cwd: desktopDir,
  127 |         });
  128 |   if (options.live) {
  129 |     console.log('LIVE_PROFILE', userData, 'ELECTRON_PID', app.process().pid);
  130 |     app.process().stderr?.on('data', (data: Buffer) => console.error('ELECTRON_STDERR', data.toString()));
  131 |   }
  132 |   // Browser 区的 WebContentsView 也会作为一个 Page 出现，这里按地址找工作台页面。
  133 |   const isWorkbench = (p: Page) => p.url().startsWith('file:') && p.url().endsWith('/renderer/index.html');
  134 |   const page = app.windows().find(isWorkbench) ?? (await app.waitForEvent('window', { predicate: isWorkbench }));
  135 |   const rendererErrors: string[] = [];
  136 |   page.on('pageerror', (error) => {
  137 |     rendererErrors.push(error.stack ?? error.message);
  138 |     console.error('RENDERER', error.stack ?? error.message);
  139 |   });
  140 |   const originalClose = app.close.bind(app);
  141 |   let closed = false;
  142 |   app.close = async () => {
  143 |     if (closed) return;
  144 |     closed = true;
> 145 |     const running = app.process().exitCode === null && app.process().signalCode === null;
      |                         ^ TypeError: Cannot read properties of undefined (reading '_object')
  146 |     const early =
  147 |       target === 'build' && running
  148 |         ? await app.evaluate(() => (globalThis as unknown as { __wslRendererErrors: string[] }).__wslRendererErrors)
  149 |         : [];
  150 |     rendererErrors.push(...early.filter((message) => !rendererErrors.some((error) => error.includes(message))));
  151 |     if (running) await originalClose();
  152 |     await rm(path.dirname(bootstrap), { recursive: true, force: true });
  153 |     assert.deepEqual(rendererErrors, [], 'Workbench renderer exceptions/errors fail every E2E');
  154 |   };
  155 |   try {
  156 |     await page.waitForSelector('div.app', { timeout: 10000 });
  157 |     await page.waitForSelector('[data-pane-id]', { state: 'attached', timeout: options.live ? 60000 : 10000 });
  158 |   } catch (error) {
  159 |     console.error('Renderer startup', rendererErrors, await page.locator('body').innerText());
  160 |     await app.close();
  161 |     throw error;
  162 |   }
  163 |   return { app, page, rendererErrors };
  164 | }
  165 | 
  166 | export async function shot(page: Page, name: string): Promise<void> {
  167 |   await page.screenshot({ path: path.join(screensDir, `${name}.png`) });
  168 | }
  169 | 
  170 | /**
  171 |  * 分别保存工作台 renderer 与 Browser 区页面的截图。
  172 |  * 原生 WebContentsView 不在 renderer 截图里，完整窗口的视觉检查另用系统截图完成。
  173 |  */
  174 | export async function windowShots(app: ElectronApplication, page: Page, name: string): Promise<void> {
  175 |   await shot(page, name);
  176 |   const png = await app.evaluate(async ({ BrowserWindow }) => {
  177 |     const view = BrowserWindow.getAllWindows()[0]?.contentView.children[0] as Electron.WebContentsView | undefined;
  178 |     if (!view || !view.getVisible()) return null;
  179 |     return (await view.webContents.capturePage()).toPNG().toString('base64');
  180 |   });
  181 |   if (png) await writeFile(path.join(screensDir, `${name}.preview.png`), Buffer.from(png, 'base64'));
  182 | }
  183 | 
  184 | export interface PreviewInfo {
  185 |   url: string;
  186 |   visible: boolean;
  187 |   bounds: { x: number; y: number; width: number; height: number };
  188 |   id: number;
  189 | }
  190 | 
  191 | export function previewInfo(app: ElectronApplication): Promise<PreviewInfo> {
  192 |   return app.evaluate(({ BrowserWindow }) => {
  193 |     const window = BrowserWindow.getAllWindows()[0];
  194 |     const view = window?.contentView.children[0] as Electron.WebContentsView | undefined;
  195 |     if (!view) throw new Error('no preview view');
  196 |     return { url: view.webContents.getURL(), visible: view.getVisible(), bounds: view.getBounds(), id: view.webContents.id };
  197 |   });
  198 | }
  199 | 
  200 | /** 在 Browser 区页面上找元素中心点（只读查询，用于测试定位）。 */
  201 | export function previewElementCenter(app: ElectronApplication, selector: string): Promise<{ x: number; y: number }> {
  202 |   return app.evaluate(async ({ BrowserWindow }, sel) => {
  203 |     const view = BrowserWindow.getAllWindows()[0]?.contentView.children[0] as Electron.WebContentsView;
  204 |     const rect = (await view.webContents.executeJavaScript(
  205 |       `(() => { const r = document.querySelector(${JSON.stringify(sel)}).getBoundingClientRect(); return { x: r.x + r.width / 2, y: r.y + r.height / 2 }; })()`,
  206 |     )) as { x: number; y: number };
  207 |     return { x: Math.round(rect.x), y: Math.round(rect.y) };
  208 |   }, selector);
  209 | }
  210 | 
  211 | /** 向 Browser 区页面发送真实的鼠标输入事件（与用户点击走同一条输入路径）。 */
  212 | export function previewClick(app: ElectronApplication, point: { x: number; y: number }): Promise<void> {
  213 |   return app.evaluate(async ({ BrowserWindow }, p) => {
  214 |     const view = BrowserWindow.getAllWindows()[0]?.contentView.children[0] as Electron.WebContentsView;
  215 |     const wc = view.webContents;
  216 |     wc.sendInputEvent({ type: 'mouseMove', x: p.x, y: p.y });
  217 |     await new Promise((r) => setTimeout(r, 120));
  218 |     wc.sendInputEvent({ type: 'mouseDown', x: p.x, y: p.y, button: 'left', clickCount: 1 });
  219 |     wc.sendInputEvent({ type: 'mouseUp', x: p.x, y: p.y, button: 'left', clickCount: 1 });
  220 |   }, point);
  221 | }
  222 | 
  223 | export function setWindowSize(app: ElectronApplication, width: number, height: number): Promise<void> {
  224 |   return app.evaluate(
  225 |     ({ BrowserWindow }, size) => {
  226 |       BrowserWindow.getAllWindows()[0]?.setContentSize(size.width, size.height);
  227 |     },
  228 |     { width, height },
  229 |   );
  230 | }
  231 | 
  232 | export async function workspaceSnapshot(page: Page) {
  233 |   return page.evaluate(() => window.studio.workbench.getSnapshot());
  234 | }
  235 | export async function browserState(page: Page) {
  236 |   const snapshot = await workspaceSnapshot(page);
  237 |   const resource = snapshot.workspaces.find((w) => w.workspaceId === snapshot.activeWorkspaceId)?.resources.find((r) => r.kind === 'web');
  238 |   if (!resource?.preview) throw new Error('browser snapshot unavailable');
  239 |   return resource.preview;
  240 | }
  241 | export async function terminalSnapshot(page: Page) {
  242 |   const snapshot = await workspaceSnapshot(page);
  243 |   const resource = snapshot.workspaces
  244 |     .find((w) => w.workspaceId === snapshot.activeWorkspaceId)
  245 |     ?.resources.find((r) => r.kind === 'terminal');
```