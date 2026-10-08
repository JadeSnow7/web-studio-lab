# Instructions

- Following Playwright test failed.
- Explain why, be concise, respect Playwright best practices.
- Provide a snippet of code with the fix, if possible.

# Test info

- Name: resources.spec.ts >> resource refresh retries Main after a transient list failure and receives the new revision
- Location: e2e/resources.spec.ts:178:1

# Error details

```
Error: expect(received).toBe(expected) // Object.is equality

Expected: 1
Received: 0

Call Log:
- Timeout 5000ms exceeded while waiting on the predicate
```

# Page snapshot

```yaml
- generic [ref=e3]:
  - banner [ref=e4]:
    - button "显示或隐藏 Workshop（⌘B）" [ref=e5] [cursor=pointer]
    - generic [ref=e8]:
      - strong [ref=e9]: 资源
      - generic [ref=e10]: 空间现场在后台保留
    - button "Codex CLI · 对话不可用" [ref=e12] [cursor=pointer]
  - generic [ref=e14]:
    - complementary "Workshop" [ref=e15]:
      - navigation "Workshop 导航" [ref=e16]:
        - button "首页" [ref=e17] [cursor=pointer]
        - button "空间" [ref=e20] [cursor=pointer]
        - button "资源" [ref=e26] [cursor=pointer]
        - button "会话" [ref=e29] [cursor=pointer]
        - button "任务" [ref=e32] [cursor=pointer]
        - button "取消固定 Workshop" [pressed] [ref=e36] [cursor=pointer]
        - button "设置" [ref=e39] [cursor=pointer]
    - main [ref=e43]:
      - region "空间网页资源" [ref=e45]:
        - generic [ref=e46]:
          - generic [ref=e47]:
            - heading "空间资源" [level=1] [ref=e48]
            - paragraph [ref=e49]: TaskFlow
          - button "打开空间页面" [ref=e50] [cursor=pointer]
        - note [ref=e51]:
          - generic [ref=e54]: 这里是你加入当前空间的真实网页快照。每空间最多 16 条；正文作为非可信参考资料，只通过只读资源工具提供给下一轮空间会话。
        - generic [ref=e55]:
          - status [ref=e56]: 共 0 条 · 集合版本 0
          - button "刷新列表" [active] [ref=e57] [cursor=pointer]
        - alert [ref=e58]: "公开资源刷新失败：fixture: transient list failure"
        - paragraph [ref=e60]: 当前空间还没有网页资源。在空间页面打开公开 HTTPS 网页，再点击“加入空间”。
    - button "通知 · 0 条未读" [ref=e61] [cursor=pointer]:
      - generic [ref=e64]: "0"
```

# Test source

```ts
  106 |   await page.getByRole('button', { name: '切换空间', exact: true }).click();
  107 |   await expect(page.getByRole('dialog', { name: '切换空间' })).toBeVisible();
  108 |   await page.keyboard.press('Escape');
  109 |   await expect(page.getByRole('dialog', { name: '切换空间' })).not.toBeVisible();
  110 |   // Reading the authoritative transport publishes the controlled fixture DTO to the renderer.
  111 |   await workshopNavigate(page, '资源');
  112 |   await page.getByRole('button', { name: '刷新列表', exact: true }).click();
  113 |   await workshopNavigate(page, '空间');
  114 | }
  115 | 
  116 | test('fixture UI：公开快照保存、重复、更新、失败恢复、移除确认、个人隔离与窄窗键盘', async () => {
  117 |   // Controlled DTO transport exercises UI only; real protocol/store coverage is public-document.spec.ts.
  118 |   await fixture();
  119 |   const capture = page.getByRole('button', { name: '加入空间', exact: true });
  120 |   await capture.click();
  121 |   await expect(capture).toBeDisabled();
  122 |   await expect(capture).toBeEnabled();
  123 |   expect(
  124 |     await app.evaluate(() => ({
  125 |       captures: (globalThis as FixtureGlobal).resourceUiFixture.captures,
  126 |       resourceId: (globalThis as FixtureGlobal).resourceUiFixture.lastResource,
  127 |     })),
  128 |   ).toMatchObject({ captures: 1 });
  129 |   await capture.click();
  130 |   await expect(capture).toBeEnabled();
  131 |   expect(await app.evaluate(() => (globalThis as FixtureGlobal).resourceUiFixture.collection.resources)).toHaveLength(1);
  132 |   await page.getByRole('button', { name: '查看空间资源', exact: true }).click();
  133 |   const resources = page.getByRole('region', { name: '空间网页资源' }),
  134 |     detail = resources.getByRole('region', { name: '资源详情' });
  135 |   await expect(resources.getByRole('table').getByRole('row')).toHaveCount(2);
  136 |   await expect(detail).toContainText('https://example.com/');
  137 |   await expect(detail).toContainText('12345678-1234-4234-9234-123456789abc');
  138 |   await expect(detail.locator('pre')).toContainText('<script>');
  139 |   expect(await page.evaluate(() => (window as Window & { __resourceExecuted?: boolean }).__resourceExecuted)).toBeUndefined();
  140 |   await app.evaluate(() => {
  141 |     (globalThis as FixtureGlobal).resourceUiFixture.text = 'Fixture updated body. 第二版内容。';
  142 |   });
  143 |   await resources.getByRole('button', { name: '用当前页面更新' }).click();
  144 |   await expect(detail).toContainText('第二版内容');
  145 |   await expect(detail).toContainText('v2');
  146 |   await app.evaluate(() => {
  147 |     (globalThis as FixtureGlobal).resourceUiFixture.failRemove = true;
  148 |   });
  149 |   await resources.getByRole('button', { name: '移除资源' }).click();
  150 |   const confirm = page.getByRole('dialog', { name: '从空间移除网页' });
  151 |   await expect(confirm.getByRole('button', { name: '取消', exact: true })).toBeFocused();
  152 |   await confirm.getByRole('button', { name: '移除网页', exact: true }).click();
  153 |   await expect(confirm).toBeVisible();
  154 |   await expect(confirm).toContainText('未移除资源');
  155 |   await app.evaluate(() => {
  156 |     (globalThis as FixtureGlobal).resourceUiFixture.failRemove = false;
  157 |   });
  158 |   await confirm.getByRole('button', { name: '移除网页', exact: true }).click();
  159 |   await expect(confirm).not.toBeVisible();
  160 |   await expect(resources.getByRole('heading', { name: '空间资源', exact: true })).toBeFocused();
  161 |   await expect(resources).toContainText('当前空间还没有网页资源');
  162 |   await app.evaluate(() => {
  163 |     (globalThis as FixtureGlobal).resourceUiFixture.failRead = true;
  164 |   });
  165 |   await resources.getByRole('button', { name: '刷新列表' }).click();
  166 |   await expect(page.getByRole('alert').last()).toContainText('list temporarily unavailable');
  167 |   await app.evaluate(() => {
  168 |     (globalThis as FixtureGlobal).resourceUiFixture.failRead = false;
  169 |   });
  170 |   await resources.getByRole('button', { name: '刷新列表' }).click();
  171 |   await workshopNavigate(page, '首页');
  172 |   await expect(page.getByRole('region', { name: '混合输入' })).toContainText('不读取其他空间');
  173 |   await setWindowSize(app, 900, 700);
  174 |   await expect(page.getByRole('region', { name: '混合输入' }).getByRole('textbox')).toBeVisible();
  175 |   await shot(page, 'resources-fixture-narrow');
  176 | });
  177 | 
  178 | test('resource refresh retries Main after a transient list failure and receives the new revision', async () => {
  179 |   ({ app, page } = await launchApp());
  180 |   await app.evaluate(({ ipcMain }) => {
  181 |     type Host = typeof globalThis & { refreshAttempts: number };
  182 |     const host = globalThis as Host;
  183 |     host.refreshAttempts = 0;
  184 |     type Handler = (event: Electron.IpcMainInvokeEvent) => Promise<WorkbenchSnapshot>;
  185 |     const handlers = (ipcMain as unknown as { _invokeHandlers: Map<string, Handler> })._invokeHandlers;
  186 |     const get = handlers.get('workbench:get-snapshot');
  187 |     if (!get) throw new Error('snapshot handler missing');
  188 |     const snapshot = async (event: Electron.IpcMainInvokeEvent) => {
  189 |       const state = await get(event);
  190 |       const workspace = state.workspaces.find((workspace) => workspace.workspaceId === 'taskflow-demo');
  191 |       if (!workspace) throw new Error('fixture workspace missing');
  192 |       workspace.publicResources = { spaceId: workspace.workspaceId, revision: host.refreshAttempts ? 7 : 0, resources: [] };
  193 |       workspace.publicResourcesError = host.refreshAttempts ? null : 'fixture: transient list failure';
  194 |       state.seq += 10000 + host.refreshAttempts;
  195 |       return state;
  196 |     };
  197 |     ipcMain.removeHandler('workbench:get-snapshot');
  198 |     ipcMain.handle('workbench:get-snapshot', snapshot);
  199 |     ipcMain.removeHandler('workbench:reload');
  200 |     ipcMain.handle('workbench:reload', async (event) => { host.refreshAttempts++; return snapshot(event); });
  201 |   });
  202 |   await workshopNavigate(page, '资源');
  203 |   // Force the initial projection from the fault fixture without activating the retry entrypoint.
  204 |   await page.evaluate(async () => { await window.studio.workbench.command({ type: 'hideBrowsers', commandId: crypto.randomUUID(), workspaceId: 'taskflow-demo' }); });
  205 |   await page.getByRole('button', { name: '刷新列表', exact: true }).click();
> 206 |   await expect.poll(() => app.evaluate(() => (globalThis as unknown as { refreshAttempts: number }).refreshAttempts)).toBe(1);
      |                                                                                                                       ^ Error: expect(received).toBe(expected) // Object.is equality
  207 |   await expect(page.getByRole('status').filter({ hasText: '集合版本' })).toContainText('集合版本 7');
  208 |   await expect(page.getByRole('alert').filter({ hasText: 'transient list failure' })).toHaveCount(0);
  209 | });
  210 | 
```