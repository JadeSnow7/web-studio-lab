# Instructions

- Following Playwright test failed.
- Explain why, be concise, respect Playwright best practices.
- Provide a snippet of code with the fix, if possible.

# Test info

- Name: workspace-migration.spec.ts >> R3 双网页原生focus事件决定地址与刷新目标，布局更新保持焦点
- Location: e2e/workspace-migration.spec.ts:151:1

# Error details

```
Error: expect(received).toBe(expected) // Object.is equality

Expected: "ebcab30f-4dd0-45cd-8740-f12b830edd73"
Received: "0c691753-4da5-4d6f-ae97-81a07c6af425"

Call Log:
- Timeout 5000ms exceeded while waiting on the predicate
```

# Test source

```ts
  76  |     await workshopNavigate(page, '首页');
  77  |     await expect.poll(async () => (await workspaceSnapshot(page)).workspaces[0]!.runs.at(-1)?.state).toBe('completed');
  78  |     const before = (await workspaceSnapshot(page)).workspaces[0]!.runs;
  79  |     const run = before.at(-1)!;
  80  |     await page.getByRole('button', { name: /^通知 · / }).click();
  81  |     const item = page.getByRole('region', { name: '通知' }).locator(`[data-run-id="${run.runId}"]`);
  82  |     await expect(item).toContainText('未读');
  83  |     await item.getByRole('button', { name: '打开运行', exact: true }).click();
  84  |     await expect(page.getByRole('region', { name: 'Agent 会话内容' })).toContainText(run.runId);
  85  |     expect((await workspaceSnapshot(page)).workspaces[0]!.runs).toEqual(before);
  86  |     await page.getByRole('button', { name: /^通知 · / }).click();
  87  |     await expect(item).toContainText('未读');
  88  |     await item.getByRole('button', { name: '标记已读', exact: true }).click();
  89  |     await expect(item).toContainText('已读');
  90  |     await app.close();
  91  |     ({ app, page } = await launchApp({ sbxBin: fixture, userData: profile }));
  92  |     await page.getByRole('button', { name: /^通知 · / }).click();
  93  |     await expect(page.getByRole('region', { name: '通知' }).locator(`[data-run-id="${run.runId}"]`)).toContainText('已读');
  94  |     expect((await workspaceSnapshot(page)).workspaces[0]!.runs.map((r) => r.runId)).toEqual(before.map((r) => r.runId));
  95  |   } finally {
  96  |     await app.close();
  97  |   }
  98  | });
  99  | 
  100 | test('R7 首页空间卡片由当前快照生成，按稳定身份切换', async () => {
  101 |   const { app, page } = await launchApp();
  102 |   try {
  103 |     await page.getByRole('button', { name: '切换空间', exact: true }).click();
  104 |     await page.getByRole('dialog', { name: '切换空间' }).getByRole('button', { name: '新建空间', exact: true }).click();
  105 |     const dialog = page.getByRole('dialog', { name: '新建空间' });
  106 |     await dialog.getByLabel('名称').fill('首页真实空间742');
  107 |     await dialog.getByRole('button', { name: '保存', exact: true }).click();
  108 |     await expect(dialog).not.toBeVisible();
  109 |     const id = (await workspaceSnapshot(page)).activeWorkspaceId;
  110 |     await workshopNavigate(page, '首页');
  111 |     const cards = page.getByRole('region', { name: '近期空间' });
  112 |     for (const workspace of (await workspaceSnapshot(page)).workspaces) {
  113 |       const card = cards.getByRole('button', { name: new RegExp(workspace.name) });
  114 |       await expect(card).toBeVisible();
  115 |       await expect(card).toContainText(`任务版本数 ${workspace.sessions.reduce((n, s) => n + s.taskVersions.length, 0)}`);
  116 |       await expect(card).toContainText(`运行 ${workspace.runs.length}`);
  117 |     }
  118 |     await cards.getByRole('button', { name: /首页真实空间742/ }).click();
  119 |     expect((await workspaceSnapshot(page)).activeWorkspaceId).toBe(id);
  120 |   } finally {
  121 |     await app.close();
  122 |   }
  123 | });
  124 | 
  125 | test('R4 单窗格窄窗从网页关联会话并采集', async () => {
  126 |   const { app, page } = await launchApp();
  127 |   try {
  128 |     await setWindowSize(app, 900, 700);
  129 |     await expect(page.locator('[data-pane-id]:visible')).toHaveCount(1);
  130 |     await page.getByLabel('关联会话').selectOption({ label: 'Agent 会话' });
  131 |     await page.getByRole('button', { name: '采集到关联会话', exact: true }).click();
  132 |     await expect(page.getByRole('button', { name: '选择中 · Esc 取消' })).toBeVisible();
  133 |     // Native contents receive input, rather than clicking the renderer placeholder.
  134 |     const web = (await workspaceSnapshot(page)).workspaces[0]!.resources.find((r) => r.kind === 'web')!;
  135 |     await app.evaluate(async ({ webContents }, id) => {
  136 |       const contents = webContents.fromId(id)!;
  137 |       const point = await contents.executeJavaScript(
  138 |         `(() => { const r = document.querySelector('[data-testid="due-1"]').getBoundingClientRect(); return { x: Math.round(r.x+r.width/2), y: Math.round(r.y+r.height/2) }; })()`,
  139 |       );
  140 |       contents.sendInputEvent({ type: 'mouseMove', ...point });
  141 |       await new Promise((resolve) => setTimeout(resolve, 120));
  142 |       contents.sendInputEvent({ type: 'mouseDown', ...point, button: 'left', clickCount: 1 });
  143 |       contents.sendInputEvent({ type: 'mouseUp', ...point, button: 'left', clickCount: 1 });
  144 |     }, web.preview!.page.webContentsId);
  145 |     await expect.poll(async () => (await workspaceSnapshot(page)).workspaces[0]!.sessions[0]!.context).not.toBeNull();
  146 |   } finally {
  147 |     await app.close();
  148 |   }
  149 | });
  150 | 
  151 | test('R3 双网页原生focus事件决定地址与刷新目标，布局更新保持焦点', async () => {
  152 |   const { app, page } = await launchApp();
  153 |   try {
  154 |     await page.getByRole('button', { name: '左右分屏', exact: true }).click();
  155 |     await page.getByRole('button', { name: '新建标签', exact: true }).click();
  156 |     const dialog = page.getByRole('dialog', { name: '新建标签' });
  157 |     await dialog.getByLabel('名称').fill('第二网页742');
  158 |     await dialog.getByRole('button', { name: '保存', exact: true }).click();
  159 |     await expect(dialog).not.toBeVisible();
  160 |     const secondResource = (await workspaceSnapshot(page)).workspaces[0]!.resources.find((r) => r.title === '第二网页742')!;
  161 |     await page.locator(`#address-${secondResource.resourceId}`).fill('wsl-demo://taskflow/members.html');
  162 |     await page.locator(`#address-${secondResource.resourceId}`).press('Enter');
  163 |     const snapshot = await workspaceSnapshot(page);
  164 |     const workspace = snapshot.workspaces[0]!;
  165 |     const web = workspace.resources.find((r) => r.title === 'TaskFlow 预览')!;
  166 |     await app.evaluate(({ webContents, BrowserWindow }, id) => {
  167 |       BrowserWindow.getAllWindows()[0]!.focus();
  168 |       const contents = webContents.fromId(id)!;
  169 |       contents.focus();
  170 |       contents.sendInputEvent({ type: 'mouseDown', x: 80, y: 80, button: 'left', clickCount: 1 });
  171 |       contents.sendInputEvent({ type: 'mouseUp', x: 80, y: 80, button: 'left', clickCount: 1 });
  172 |     }, web.preview!.page.webContentsId);
  173 |     const first = page.locator('[data-pane-id]').filter({ has: page.getByRole('button', { name: '聚焦窗格 · TaskFlow 预览' }) });
  174 |     await expect
  175 |       .poll(async () => (await workspaceSnapshot(page)).workspaces[0]!.activePaneId)
> 176 |       .toBe(await first.getAttribute('data-pane-id'));
      |        ^ Error: expect(received).toBe(expected) // Object.is equality
  177 |     await expect
  178 |       .poll(() => app.evaluate(({ webContents }, id) => webContents.fromId(id)!.isFocused(), web.preview!.page.webContentsId))
  179 |       .toBe(true);
  180 |     await setWindowSize(app, 1400, 880);
  181 |     await expect
  182 |       .poll(() => app.evaluate(({ webContents }, id) => webContents.fromId(id)!.isFocused(), web.preview!.page.webContentsId))
  183 |       .toBe(true);
  184 |     await menu(app, '编辑地址');
  185 |     await expect(page.locator(`#address-${web.resourceId}`)).toBeFocused();
  186 |     await menu(app, '重新加载 Browser 区页面');
  187 |     await expect
  188 |       .poll(
  189 |         async () =>
  190 |           (await workspaceSnapshot(page)).workspaces[0]!.resources.find((r) => r.resourceId === web.resourceId)!.preview!.page
  191 |             .documentGeneration,
  192 |       )
  193 |       .toBeGreaterThan(web.preview!.page.documentGeneration);
  194 |     await expect
  195 |       .poll(
  196 |         async () => (await workspaceSnapshot(page)).workspaces[0]!.resources.find((r) => r.resourceId === web.resourceId)!.preview!.loading,
  197 |       )
  198 |       .toBe(false);
  199 |     const ownedFrontend = () =>
  200 |       app.evaluate(async ({ BrowserWindow, webContents }, id) => {
  201 |         const tools = webContents.fromId(id)!.devToolsWebContents;
  202 |         if (!tools || tools.isDestroyed()) return null;
  203 |         const window = BrowserWindow.fromWebContents(tools);
  204 |         return {
  205 |           id: tools.id,
  206 |           visible: window?.isVisible() ?? false,
  207 |           url: tools.getURL(),
  208 |           ready: await tools.executeJavaScript("document.readyState === 'complete' && !!document.querySelector('.root-view')"),
  209 |         };
  210 |       }, web.preview!.page.webContentsId);
  211 |     await menu(app, '打开 Browser 区页面 DevTools');
  212 |     await expect
  213 |       .poll(async () => {
  214 |         const f = await ownedFrontend();
  215 |         return !!f?.visible && f.ready && f.url.startsWith('devtools://devtools/bundled/devtools_app.html');
  216 |       })
  217 |       .toBe(true);
  218 |     expect(
  219 |       await app.evaluate(
  220 |         ({ webContents }, id) => webContents.fromId(id)!.devToolsWebContents?.id ?? null,
  221 |         secondResource.preview!.page.webContentsId,
  222 |       ),
  223 |     ).toBeNull();
  224 |     const oldDevToolsId = (await ownedFrontend())!.id;
  225 |     await app.evaluate(
  226 |       ({ BrowserWindow, webContents }, id) => BrowserWindow.fromWebContents(webContents.fromId(id)!)!.close(),
  227 |       oldDevToolsId,
  228 |     );
  229 |     await expect.poll(() => app.evaluate(({ webContents }, id) => webContents.fromId(id)?.isDestroyed() ?? true, oldDevToolsId)).toBe(true);
  230 |     await menu(app, '打开 Browser 区页面 DevTools');
  231 |     await expect
  232 |       .poll(async () => {
  233 |         const f = await ownedFrontend();
  234 |         return !!f?.visible && f.ready && f.id !== oldDevToolsId && f.url.startsWith('devtools://devtools/bundled/devtools_app.html');
  235 |       })
  236 |       .toBe(true);
  237 |     expect(
  238 |       await app.evaluate(
  239 |         ({ webContents }, id) => webContents.fromId(id)!.devToolsWebContents?.id ?? null,
  240 |         secondResource.preview!.page.webContentsId,
  241 |       ),
  242 |     ).toBeNull();
  243 |   } finally {
  244 |     await app.close();
  245 |   }
  246 | });
  247 | 
  248 | test('E2E 异常门槛负控：启动阶段异常必须失败', async () => {
  249 |   const { app } = await launchApp({ startupError: 'WSL_STARTUP_NEGATIVE_CONTROL' });
  250 |   await expect(app.close()).rejects.toThrow('Workbench renderer exceptions/errors');
  251 | });
  252 | 
  253 | test('E2E 异常门槛负控：运行期异常必须失败', async () => {
  254 |   const { app, page } = await launchApp();
  255 |   await page.evaluate(() => {
  256 |     setTimeout(() => {
  257 |       throw new Error('WSL_LATE_NEGATIVE_CONTROL');
  258 |     }, 0);
  259 |   });
  260 |   await expect
  261 |     .poll(async () => app.evaluate(() => (globalThis as unknown as { __wslRendererErrors: string[] }).__wslRendererErrors.length))
  262 |     .toBeGreaterThan(0);
  263 |   await expect(app.close()).rejects.toThrow('Workbench renderer exceptions/errors');
  264 | });
  265 | 
```