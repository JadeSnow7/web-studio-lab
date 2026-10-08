# Instructions

- Following Playwright test failed.
- Explain why, be concise, respect Playwright best practices.
- Provide a snippet of code with the fix, if possible.

# Test info

- Name: ssh-product.spec.ts >> 产品SSH_AUTH_SOCK认证、SFTP范围/续读/搜索与真实PTY同实例观察/重开/停止
- Location: e2e/ssh-product.spec.ts:32:1

# Error details

```
AggregateError: Product SSH scenario and cleanup failed
```

```
Error: electronApplication.evaluate: Target page, context or browser has been closed
Browser logs:

<launching> /Users/huaodong/.codex/worktrees/bf64/web-studio-lab/node_modules/.pnpm/electron@44.5.1/node_modules/electron/dist/Electron.app/Contents/MacOS/Electron --inspect=0 --remote-debugging-port=0 /var/folders/87/gyhx13hs45351j7vwkdrr4sr0000gn/T/wsl-e2e-bootstrap-krOXTM/main.cjs --user-data-dir=/var/folders/87/gyhx13hs45351j7vwkdrr4sr0000gn/T/wsl-e2e-iwWAbr
<launched> pid=64492
[pid=64492][err] Debugger listening on ws://127.0.0.1:51273/53020d6a-7a00-4f40-93de-8e26f706eb44
[pid=64492][err] For help, see: https://nodejs.org/learn/getting-started/debugging
[pid=64492][err] Debugger attached.
[pid=64492][err] 
[pid=64492][err] DevTools listening on ws://127.0.0.1:51275/devtools/browser/103ce8bb-5ec5-4169-84b3-88d434f4d419
[pid=64492][err] (node:64492) Warning: The 'NO_COLOR' env is ignored due to the 'FORCE_COLOR' env being set.
[pid=64492][err] (Use `Electron --trace-warnings ...` to show where the warning was created)
[pid=64492] <process did exit: exitCode=null, signal=SIGKILL>
[pid=64492] starting temporary directories cleanup
```

# Test source

```ts
  41  |           WSL_SSH_PORT: String(options.sshEnvironment.port),
  42  |           WSL_SSH_USER: options.sshEnvironment.username,
  43  |           WSL_SSH_HOST_KEY_SHA256: options.sshEnvironment.hostKeySha256,
  44  |           WSL_SSH_ROOT: options.sshEnvironment.root,
  45  |           SSH_AUTH_SOCK: options.sshEnvironment.agent,
  46  |         }
  47  |       : {}),
  48  |     ...(options.observationRoot === undefined ? {} : { WSL_OBSERVATION_ROOT: options.observationRoot }),
  49  |     WSL_SBX_NAME: options.live ? (process.env['WSL_SBX_NAME'] ?? 'wsl-sbx-smoke-20261006') : (options.sandbox ?? 'fixture-sandbox'),
  50  |     WSL_SBX_BIN: options.live
  51  |       ? (process.env['WSL_SBX_BIN'] ?? '/opt/homebrew/bin/sbx')
  52  |       : (options.sbxBin ?? (options.codexBin ? path.join(root, 'e2e/fixtures/sbx.mjs') : '/missing/wsl-e2e-sbx')),
  53  |     WSL_CODEX_BIN: '/missing/host-codex-must-not-run',
  54  |   };
  55  |   // Each run owns a fresh profile; retain it in tmp for failure evidence.
  56  |   const userData = options.userData ?? (await mkdtemp(path.join(tmpdir(), 'wsl-e2e-')));
  57  |   // Install the observer before the real entrypoint creates any renderer.
  58  |   const bootstrap = path.join(await mkdtemp(path.join(tmpdir(), 'wsl-e2e-bootstrap-')), 'main.cjs');
  59  |   await writeFile(
  60  |     bootstrap,
  61  |     `
  62  | const { app } = require('electron');
  63  | app.setAppPath(${JSON.stringify(desktopDir)});
  64  | globalThis.__wslRendererErrors = [];
  65  | ${
  66  |   options.controlledObservation
  67  |     ? `
  68  | const { utilityProcess } = require('electron');
  69  | const originalFork = utilityProcess.fork.bind(utilityProcess);
  70  | globalThis.__wslObservationGate = { armed: false, deliveries: [], reads: 0 };
  71  | utilityProcess.fork = (...args) => {
  72  |   const child = originalFork(...args);
  73  |   const originalPost = child.postMessage.bind(child);
  74  |   child.postMessage = (message) => {
  75  |     const gate = globalThis.__wslObservationGate;
  76  |     if (message.method === 'observation.read') gate.reads++;
  77  |     if (gate.armed && message.method === 'environments.list') {
  78  |       gate.deliveries.push(() => originalPost(message));
  79  |       return;
  80  |     }
  81  |     return originalPost(message);
  82  |   };
  83  |   return child;
  84  | };
  85  | `
  86  |     : ''
  87  | }
  88  | 
  89  | app.on('web-contents-created', (_event, contents) => {
  90  |   contents.on('console-message', (event) => {
  91  |     if (contents.getURL().endsWith('/renderer/index.html') && event.level === 'error') {
  92  |       globalThis.__wslRendererErrors.push(event.message);
  93  |     }
  94  |   });
  95  |   ${
  96  |     options.startupError
  97  |       ? `contents.once('dom-ready', () => {
  98  |     if (contents.getURL().endsWith('/renderer/index.html')) {
  99  |       void contents.executeJavaScript(${JSON.stringify(`setTimeout(() => { throw new Error(${JSON.stringify(options.startupError)}); }, 0)`)});
  100 |     }
  101 |   });`
  102 |       : ''
  103 |   }
  104 | });
  105 | require(${JSON.stringify(path.join(desktopDir, 'out/main/index.js'))});
  106 | `,
  107 |   );
  108 |   const app =
  109 |     target === 'packaged'
  110 |       ? await _electron.launch({
  111 |           env,
  112 |           args: [`--user-data-dir=${userData}`],
  113 |           executablePath: path.join(desktopDir, 'release/mac-arm64/Web Studio Lab.app/Contents/MacOS/Web Studio Lab'),
  114 |         })
  115 |       : await _electron.launch({
  116 |           env,
  117 |           executablePath: createRequire(path.join(desktopDir, 'package.json'))('electron') as unknown as string,
  118 |           args: [bootstrap, `--user-data-dir=${userData}`],
  119 |           cwd: desktopDir,
  120 |         });
  121 |   if (options.live) {
  122 |     console.log('LIVE_PROFILE', userData, 'ELECTRON_PID', app.process().pid);
  123 |     app.process().stderr?.on('data', (data: Buffer) => console.error('ELECTRON_STDERR', data.toString()));
  124 |   }
  125 |   // Browser 区的 WebContentsView 也会作为一个 Page 出现，这里按地址找工作台页面。
  126 |   const isWorkbench = (p: Page) => p.url().startsWith('file:') && p.url().endsWith('/renderer/index.html');
  127 |   const page = app.windows().find(isWorkbench) ?? (await app.waitForEvent('window', { predicate: isWorkbench }));
  128 |   const rendererErrors: string[] = [];
  129 |   page.on('pageerror', (error) => {
  130 |     rendererErrors.push(error.stack ?? error.message);
  131 |     console.error('RENDERER', error.stack ?? error.message);
  132 |   });
  133 |   const originalClose = app.close.bind(app);
  134 |   let closed = false;
  135 |   app.close = async () => {
  136 |     if (closed) return;
  137 |     closed = true;
  138 |     const running = app.process().exitCode === null;
  139 |     const early =
  140 |       target === 'build' && running
> 141 |         ? await app.evaluate(() => (globalThis as unknown as { __wslRendererErrors: string[] }).__wslRendererErrors)
      |                     ^ Error: electronApplication.evaluate: Target page, context or browser has been closed
  142 |         : [];
  143 |     rendererErrors.push(...early.filter((message) => !rendererErrors.some((error) => error.includes(message))));
  144 |     if (running) await originalClose();
  145 |     assert.deepEqual(rendererErrors, [], 'Workbench renderer exceptions/errors fail every E2E');
  146 |   };
  147 |   try {
  148 |     await page.waitForSelector('div.app', { timeout: 10000 });
  149 |     await page.waitForSelector('[data-pane-id]', { state: 'attached', timeout: options.live ? 60000 : 10000 });
  150 |   } catch (error) {
  151 |     console.error('Renderer startup', rendererErrors, await page.locator('body').innerText());
  152 |     await app.close();
  153 |     throw error;
  154 |   }
  155 |   return { app, page, rendererErrors };
  156 | }
  157 | 
  158 | export async function shot(page: Page, name: string): Promise<void> {
  159 |   await page.screenshot({ path: path.join(screensDir, `${name}.png`) });
  160 | }
  161 | 
  162 | /**
  163 |  * 分别保存工作台 renderer 与 Browser 区页面的截图。
  164 |  * 原生 WebContentsView 不在 renderer 截图里，完整窗口的视觉检查另用系统截图完成。
  165 |  */
  166 | export async function windowShots(app: ElectronApplication, page: Page, name: string): Promise<void> {
  167 |   await shot(page, name);
  168 |   const png = await app.evaluate(async ({ BrowserWindow }) => {
  169 |     const view = BrowserWindow.getAllWindows()[0]?.contentView.children[0] as Electron.WebContentsView | undefined;
  170 |     if (!view || !view.getVisible()) return null;
  171 |     return (await view.webContents.capturePage()).toPNG().toString('base64');
  172 |   });
  173 |   if (png) await writeFile(path.join(screensDir, `${name}.preview.png`), Buffer.from(png, 'base64'));
  174 | }
  175 | 
  176 | export interface PreviewInfo {
  177 |   url: string;
  178 |   visible: boolean;
  179 |   bounds: { x: number; y: number; width: number; height: number };
  180 |   id: number;
  181 | }
  182 | 
  183 | export function previewInfo(app: ElectronApplication): Promise<PreviewInfo> {
  184 |   return app.evaluate(({ BrowserWindow }) => {
  185 |     const window = BrowserWindow.getAllWindows()[0];
  186 |     const view = window?.contentView.children[0] as Electron.WebContentsView | undefined;
  187 |     if (!view) throw new Error('no preview view');
  188 |     return { url: view.webContents.getURL(), visible: view.getVisible(), bounds: view.getBounds(), id: view.webContents.id };
  189 |   });
  190 | }
  191 | 
  192 | /** 在 Browser 区页面上找元素中心点（只读查询，用于测试定位）。 */
  193 | export function previewElementCenter(app: ElectronApplication, selector: string): Promise<{ x: number; y: number }> {
  194 |   return app.evaluate(async ({ BrowserWindow }, sel) => {
  195 |     const view = BrowserWindow.getAllWindows()[0]?.contentView.children[0] as Electron.WebContentsView;
  196 |     const rect = (await view.webContents.executeJavaScript(
  197 |       `(() => { const r = document.querySelector(${JSON.stringify(sel)}).getBoundingClientRect(); return { x: r.x + r.width / 2, y: r.y + r.height / 2 }; })()`,
  198 |     )) as { x: number; y: number };
  199 |     return { x: Math.round(rect.x), y: Math.round(rect.y) };
  200 |   }, selector);
  201 | }
  202 | 
  203 | /** 向 Browser 区页面发送真实的鼠标输入事件（与用户点击走同一条输入路径）。 */
  204 | export function previewClick(app: ElectronApplication, point: { x: number; y: number }): Promise<void> {
  205 |   return app.evaluate(async ({ BrowserWindow }, p) => {
  206 |     const view = BrowserWindow.getAllWindows()[0]?.contentView.children[0] as Electron.WebContentsView;
  207 |     const wc = view.webContents;
  208 |     wc.sendInputEvent({ type: 'mouseMove', x: p.x, y: p.y });
  209 |     await new Promise((r) => setTimeout(r, 120));
  210 |     wc.sendInputEvent({ type: 'mouseDown', x: p.x, y: p.y, button: 'left', clickCount: 1 });
  211 |     wc.sendInputEvent({ type: 'mouseUp', x: p.x, y: p.y, button: 'left', clickCount: 1 });
  212 |   }, point);
  213 | }
  214 | 
  215 | export function setWindowSize(app: ElectronApplication, width: number, height: number): Promise<void> {
  216 |   return app.evaluate(
  217 |     ({ BrowserWindow }, size) => {
  218 |       BrowserWindow.getAllWindows()[0]?.setContentSize(size.width, size.height);
  219 |     },
  220 |     { width, height },
  221 |   );
  222 | }
  223 | 
  224 | export async function workspaceSnapshot(page: Page) {
  225 |   return page.evaluate(() => window.studio.workbench.getSnapshot());
  226 | }
  227 | export async function browserState(page: Page) {
  228 |   const snapshot = await workspaceSnapshot(page);
  229 |   const resource = snapshot.workspaces.find((w) => w.workspaceId === snapshot.activeWorkspaceId)?.resources.find((r) => r.kind === 'web');
  230 |   if (!resource?.preview) throw new Error('browser snapshot unavailable');
  231 |   return resource.preview;
  232 | }
  233 | export async function terminalSnapshot(page: Page) {
  234 |   const snapshot = await workspaceSnapshot(page);
  235 |   const resource = snapshot.workspaces
  236 |     .find((w) => w.workspaceId === snapshot.activeWorkspaceId)
  237 |     ?.resources.find((r) => r.kind === 'terminal');
  238 |   if (!resource?.terminal) throw new Error('terminal snapshot unavailable');
  239 |   return resource.terminal;
  240 | }
  241 | export async function workshopNavigate(page: Page, label: string) {
```