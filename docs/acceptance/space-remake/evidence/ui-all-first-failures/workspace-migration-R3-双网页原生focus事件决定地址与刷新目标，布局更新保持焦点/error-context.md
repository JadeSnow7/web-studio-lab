# Instructions

- Following Playwright test failed.
- Explain why, be concise, respect Playwright best practices.
- Provide a snippet of code with the fix, if possible.

# Test info

- Name: workspace-migration.spec.ts >> R3 双网页原生focus事件决定地址与刷新目标，布局更新保持焦点
- Location: e2e/workspace-migration.spec.ts:146:1

# Error details

```
Error: expect(received).toBe(expected) // Object.is equality

Expected: true
Received: false
```

# Test source

```ts
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
  135 |     await app.evaluate(({ webContents }, id) => {
  136 |       const contents = webContents.fromId(id)!;
  137 |       contents.sendInputEvent({ type: 'mouseDown', x: 120, y: 120, button: 'left', clickCount: 1 });
  138 |       contents.sendInputEvent({ type: 'mouseUp', x: 120, y: 120, button: 'left', clickCount: 1 });
  139 |     }, web.preview!.page.webContentsId);
  140 |     await expect.poll(async () => (await workspaceSnapshot(page)).workspaces[0]!.sessions[0]!.context).not.toBeNull();
  141 |   } finally {
  142 |     await app.close();
  143 |   }
  144 | });
  145 | 
  146 | test('R3 双网页原生focus事件决定地址与刷新目标，布局更新保持焦点', async () => {
  147 |   const { app, page } = await launchApp();
  148 |   try {
  149 |     await page.getByRole('button', { name: '左右分屏', exact: true }).click();
  150 |     await page.getByRole('button', { name: '新建标签', exact: true }).click();
  151 |     const dialog = page.getByRole('dialog', { name: '新建标签' });
  152 |     await dialog.getByLabel('名称').fill('第二网页742');
  153 |     await dialog.getByRole('button', { name: '保存', exact: true }).click();
  154 |     await expect(dialog).not.toBeVisible();
  155 |     const secondResource = (await workspaceSnapshot(page)).workspaces[0]!.resources.find((r) => r.title === '第二网页742')!;
  156 |     await page.locator(`#address-${secondResource.resourceId}`).fill('wsl-demo://taskflow/members.html');
  157 |     await page.locator(`#address-${secondResource.resourceId}`).press('Enter');
  158 |     const snapshot = await workspaceSnapshot(page);
  159 |     const workspace = snapshot.workspaces[0]!;
  160 |     const web = workspace.resources.find((r) => r.title === 'TaskFlow 预览')!;
  161 |     await app.evaluate(({ webContents }, id) => {
  162 |       const contents = webContents.fromId(id)!;
  163 |       contents.focus();
  164 |       contents.sendInputEvent({ type: 'mouseDown', x: 80, y: 80, button: 'left', clickCount: 1 });
  165 |       contents.sendInputEvent({ type: 'mouseUp', x: 80, y: 80, button: 'left', clickCount: 1 });
  166 |     }, web.preview!.page.webContentsId);
  167 |     const first = page.locator('[data-pane-id]').filter({ has: page.getByRole('button', { name: '聚焦窗格 · TaskFlow 预览' }) });
  168 |     await expect
  169 |       .poll(async () => (await workspaceSnapshot(page)).workspaces[0]!.activePaneId)
  170 |       .toBe(await first.getAttribute('data-pane-id'));
  171 |     await setWindowSize(app, 1400, 880);
  172 |     expect(await app.evaluate(({ webContents }, id) => webContents.fromId(id)!.isFocused(), web.preview!.page.webContentsId)).toBe(true);
  173 |     await menu(app, '编辑地址');
  174 |     await expect(page.locator(`#address-${web.resourceId}`)).toBeFocused();
  175 |     await menu(app, '重新加载 Browser 区页面');
  176 |     await expect
  177 |       .poll(
  178 |         async () =>
  179 |           (await workspaceSnapshot(page)).workspaces[0]!.resources.find((r) => r.resourceId === web.resourceId)!.preview!.page
  180 |             .documentGeneration,
  181 |       )
  182 |       .toBeGreaterThan(web.preview!.page.documentGeneration);
  183 |     await menu(app, '打开 Browser 区页面 DevTools');
> 184 |     expect(await app.evaluate(({ webContents }, id) => webContents.fromId(id)!.isDevToolsOpened(), web.preview!.page.webContentsId)).toBe(
      |                                                                                                                                      ^ Error: expect(received).toBe(expected) // Object.is equality
  185 |       true,
  186 |     );
  187 |   } finally {
  188 |     await app.close();
  189 |   }
  190 | });
  191 | 
  192 | test('E2E 异常门槛负控：启动阶段异常必须失败', async () => {
  193 |   const { app } = await launchApp({ startupError: 'WSL_STARTUP_NEGATIVE_CONTROL' });
  194 |   await expect(app.close()).rejects.toThrow('Workbench renderer exceptions/errors');
  195 | });
  196 | 
  197 | test('E2E 异常门槛负控：运行期异常必须失败', async () => {
  198 |   const { app, page } = await launchApp();
  199 |   await page.evaluate(() => {
  200 |     setTimeout(() => {
  201 |       throw new Error('WSL_LATE_NEGATIVE_CONTROL');
  202 |     }, 0);
  203 |   });
  204 |   await expect
  205 |     .poll(async () => app.evaluate(() => (globalThis as unknown as { __wslRendererErrors: string[] }).__wslRendererErrors.length))
  206 |     .toBeGreaterThan(0);
  207 |   await expect(app.close()).rejects.toThrow('Workbench renderer exceptions/errors');
  208 | });
  209 | 
```