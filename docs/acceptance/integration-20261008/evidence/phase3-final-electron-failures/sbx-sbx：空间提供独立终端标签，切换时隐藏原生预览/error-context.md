# Instructions

- Following Playwright test failed.
- Explain why, be concise, respect Playwright best practices.
- Provide a snippet of code with the fix, if possible.

# Test info

- Name: sbx.spec.ts >> sbx：空间提供独立终端标签，切换时隐藏原生预览
- Location: e2e/sbx.spec.ts:40:1

# Error details

```
Error: terminal snapshot unavailable
```

# Page snapshot

```yaml
- generic [ref=e3]:
  - banner [ref=e4]:
    - button "显示或隐藏 Workshop（⌘B）" [ref=e5] [cursor=pointer]
    - button "切换空间" [ref=e8]:
      - generic [ref=e9]: ▦
      - strong [ref=e10]: TaskFlow
      - generic [ref=e11]: ⌄
    - button "Codex CLI · 对话不可用" [ref=e13] [cursor=pointer]
  - generic [ref=e15]:
    - complementary "Workshop" [ref=e16]:
      - navigation "Workshop 导航" [ref=e17]:
        - button "首页" [ref=e18] [cursor=pointer]
        - button "空间" [ref=e21] [cursor=pointer]
        - button "资源" [ref=e27] [cursor=pointer]
        - button "会话" [ref=e30] [cursor=pointer]
        - button "任务" [ref=e33] [cursor=pointer]
        - button "取消固定 Workshop" [pressed] [ref=e37] [cursor=pointer]
        - button "设置" [ref=e40] [cursor=pointer]
      - region "空间导航" [ref=e44]:
        - generic [ref=e45]:
          - strong [ref=e46]: TaskFlow
          - generic [ref=e47]: 空间标签
        - navigation "空间标签" [ref=e48]:
          - generic [ref=e49]:
            - button "TaskFlow 预览" [ref=e50]
            - button "TaskFlow 预览操作" [ref=e56] [cursor=pointer]: ···
          - generic [ref=e57]:
            - button "开发终端" [ref=e58]
            - button "开发终端操作" [ref=e64] [cursor=pointer]: ···
          - generic [ref=e65]:
            - button "Agent 会话" [ref=e66]
            - button "Agent 会话操作" [ref=e71] [cursor=pointer]: ···
          - group [ref=e72]:
            - generic "后台资源 / 已关闭标签" [ref=e73]
        - button "新建标签" [ref=e74] [cursor=pointer]
        - generic [ref=e77]:
          - button "搜索空间或标签" [ref=e78] [cursor=pointer]
          - generic [ref=e79]: 关闭窗格保留标签 · 隐藏继续运行
    - main [ref=e80]:
      - region "TaskFlow工作现场" [ref=e83]:
        - generic [ref=e85]:
          - button "聚焦窗格 · 开发终端" [ref=e86]:
            - generic [ref=e90]: 开发终端
          - generic [ref=e91]:
            - button "左右分屏" [ref=e92] [cursor=pointer]: ◫
            - button "上下分屏" [ref=e93] [cursor=pointer]: ⬒
            - button "专注当前窗格" [ref=e94] [cursor=pointer]: ⤢
            - button "窗格操作" [ref=e95] [cursor=pointer]: ···
        - region "资源终端" [ref=e96]:
          - generic [ref=e97]:
            - status [ref=e98]: sandbox · 工作目录未读取 · 尚未连接
            - button "连接终端" [disabled] [ref=e99]
          - status [ref=e100]: sbx 不可用：sbx 不可执行：/missing/wsl-e2e-sbx
          - generic [ref=e102]:
            - generic:
              - list:
                - listitem
                - listitem
                - listitem
                - listitem
                - listitem
                - listitem
                - listitem
                - listitem
                - listitem
                - listitem
                - listitem
                - listitem
                - listitem
                - listitem
                - listitem
                - listitem
                - listitem
                - listitem
                - listitem
                - listitem
                - listitem
                - listitem
                - listitem
                - listitem
                - listitem
                - listitem
                - listitem
                - listitem
                - listitem
                - listitem
                - listitem
                - listitem
                - listitem
                - listitem
                - listitem
                - listitem
                - listitem
                - listitem
                - listitem
                - listitem
                - listitem
                - listitem
                - listitem
            - generic [ref=e104]:
              - generic:
                - textbox "终端输入" [active]
          - paragraph [ref=e107]: 输出最多保留 256 Ki 字符 · 隐藏窗格继续运行
    - button "通知 · 0 条未读" [ref=e108] [cursor=pointer]:
      - generic [ref=e111]: "0"
```

# Test source

```ts
  127 |     const running = app.process().exitCode === null;
  128 |     const early =
  129 |       target === 'build' && running
  130 |         ? await app.evaluate(() => (globalThis as unknown as { __wslRendererErrors: string[] }).__wslRendererErrors)
  131 |         : [];
  132 |     rendererErrors.push(...early.filter((message) => !rendererErrors.some((error) => error.includes(message))));
  133 |     if (running) await originalClose();
  134 |     assert.deepEqual(rendererErrors, [], 'Workbench renderer exceptions/errors fail every E2E');
  135 |   };
  136 |   try {
  137 |     await page.waitForSelector('div.app', { timeout: 10000 });
  138 |     await page.waitForSelector('[data-pane-id]', { state: 'attached', timeout: options.live ? 60000 : 10000 });
  139 |   } catch (error) {
  140 |     console.error('Renderer startup', rendererErrors, await page.locator('body').innerText());
  141 |     await app.close();
  142 |     throw error;
  143 |   }
  144 |   return { app, page, rendererErrors };
  145 | }
  146 | 
  147 | export async function shot(page: Page, name: string): Promise<void> {
  148 |   await page.screenshot({ path: path.join(screensDir, `${name}.png`) });
  149 | }
  150 | 
  151 | /**
  152 |  * 分别保存工作台 renderer 与 Browser 区页面的截图。
  153 |  * 原生 WebContentsView 不在 renderer 截图里，完整窗口的视觉检查另用系统截图完成。
  154 |  */
  155 | export async function windowShots(app: ElectronApplication, page: Page, name: string): Promise<void> {
  156 |   await shot(page, name);
  157 |   const png = await app.evaluate(async ({ BrowserWindow }) => {
  158 |     const view = BrowserWindow.getAllWindows()[0]?.contentView.children[0] as Electron.WebContentsView | undefined;
  159 |     if (!view || !view.getVisible()) return null;
  160 |     return (await view.webContents.capturePage()).toPNG().toString('base64');
  161 |   });
  162 |   if (png) await writeFile(path.join(screensDir, `${name}.preview.png`), Buffer.from(png, 'base64'));
  163 | }
  164 | 
  165 | export interface PreviewInfo {
  166 |   url: string;
  167 |   visible: boolean;
  168 |   bounds: { x: number; y: number; width: number; height: number };
  169 |   id: number;
  170 | }
  171 | 
  172 | export function previewInfo(app: ElectronApplication): Promise<PreviewInfo> {
  173 |   return app.evaluate(({ BrowserWindow }) => {
  174 |     const window = BrowserWindow.getAllWindows()[0];
  175 |     const view = window?.contentView.children[0] as Electron.WebContentsView | undefined;
  176 |     if (!view) throw new Error('no preview view');
  177 |     return { url: view.webContents.getURL(), visible: view.getVisible(), bounds: view.getBounds(), id: view.webContents.id };
  178 |   });
  179 | }
  180 | 
  181 | /** 在 Browser 区页面上找元素中心点（只读查询，用于测试定位）。 */
  182 | export function previewElementCenter(app: ElectronApplication, selector: string): Promise<{ x: number; y: number }> {
  183 |   return app.evaluate(async ({ BrowserWindow }, sel) => {
  184 |     const view = BrowserWindow.getAllWindows()[0]?.contentView.children[0] as Electron.WebContentsView;
  185 |     const rect = (await view.webContents.executeJavaScript(
  186 |       `(() => { const r = document.querySelector(${JSON.stringify(sel)}).getBoundingClientRect(); return { x: r.x + r.width / 2, y: r.y + r.height / 2 }; })()`,
  187 |     )) as { x: number; y: number };
  188 |     return { x: Math.round(rect.x), y: Math.round(rect.y) };
  189 |   }, selector);
  190 | }
  191 | 
  192 | /** 向 Browser 区页面发送真实的鼠标输入事件（与用户点击走同一条输入路径）。 */
  193 | export function previewClick(app: ElectronApplication, point: { x: number; y: number }): Promise<void> {
  194 |   return app.evaluate(async ({ BrowserWindow }, p) => {
  195 |     const view = BrowserWindow.getAllWindows()[0]?.contentView.children[0] as Electron.WebContentsView;
  196 |     const wc = view.webContents;
  197 |     wc.sendInputEvent({ type: 'mouseMove', x: p.x, y: p.y });
  198 |     await new Promise((r) => setTimeout(r, 120));
  199 |     wc.sendInputEvent({ type: 'mouseDown', x: p.x, y: p.y, button: 'left', clickCount: 1 });
  200 |     wc.sendInputEvent({ type: 'mouseUp', x: p.x, y: p.y, button: 'left', clickCount: 1 });
  201 |   }, point);
  202 | }
  203 | 
  204 | export function setWindowSize(app: ElectronApplication, width: number, height: number): Promise<void> {
  205 |   return app.evaluate(
  206 |     ({ BrowserWindow }, size) => {
  207 |       BrowserWindow.getAllWindows()[0]?.setContentSize(size.width, size.height);
  208 |     },
  209 |     { width, height },
  210 |   );
  211 | }
  212 | 
  213 | export async function workspaceSnapshot(page: Page) {
  214 |   return page.evaluate(() => window.studio.workbench.getSnapshot());
  215 | }
  216 | export async function browserState(page: Page) {
  217 |   const snapshot = await workspaceSnapshot(page);
  218 |   const resource = snapshot.workspaces.find((w) => w.workspaceId === snapshot.activeWorkspaceId)?.resources.find((r) => r.kind === 'web');
  219 |   if (!resource?.preview) throw new Error('browser snapshot unavailable');
  220 |   return resource.preview;
  221 | }
  222 | export async function terminalSnapshot(page: Page) {
  223 |   const snapshot = await workspaceSnapshot(page);
  224 |   const resource = snapshot.workspaces
  225 |     .find((w) => w.workspaceId === snapshot.activeWorkspaceId)
  226 |     ?.resources.find((r) => r.kind === 'terminal');
> 227 |   if (!resource?.terminal) throw new Error('terminal snapshot unavailable');
      |                                  ^ Error: terminal snapshot unavailable
  228 |   return resource.terminal;
  229 | }
  230 | export async function workshopNavigate(page: Page, label: string) {
  231 |   const navigation = page.getByRole('navigation', { name: 'Workshop 导航' });
  232 |   if (!(await navigation.isVisible())) await page.getByRole('button', { name: '展开 Workshop', exact: true }).click();
  233 |   await navigation.getByRole('button', { name: label, exact: true }).click();
  234 | }
  235 | 
  236 | export async function resourceCollection(page: Page) {
  237 |   const snapshot = await workspaceSnapshot(page);
  238 |   const collection = snapshot.workspaces.find((w) => w.workspaceId === snapshot.activeWorkspaceId)?.publicResources;
  239 |   if (!collection) throw new Error('public resource collection unavailable');
  240 |   return collection;
  241 | }
  242 | 
  243 | export async function setWorkspaceTheme(page: Page, theme: string) {
  244 |   await workshopNavigate(page, '设置');
  245 |   await page.getByLabel(/^空间主题 · /).selectOption(theme);
  246 |   await expectTheme(page, theme);
  247 |   await workshopNavigate(page, '空间');
  248 | }
  249 | async function expectTheme(page: Page, theme: string) {
  250 |   const snapshot = await workspaceSnapshot(page);
  251 |   assert.equal(snapshot.workspaces.find((w) => w.workspaceId === snapshot.activeWorkspaceId)?.theme, theme);
  252 | }
  253 | 
```