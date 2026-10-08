# Instructions

- Following Playwright test failed.
- Explain why, be concise, respect Playwright best practices.
- Provide a snippet of code with the fix, if possible.

# Test info

- Name: workbench.spec.ts >> 窄窗口：活动窗格保留原生bounds，扩大恢复多窗格
- Location: e2e/workbench.spec.ts:198:1

# Error details

```
Error: expect(received).toBeLessThanOrEqual(expected)

Expected: <= 1
Received:    196
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
    - button "Codex CLI · 对话已连接" [ref=e13] [cursor=pointer]
  - generic [ref=e15]:
    - button "展开 Workshop" [active] [ref=e17] [cursor=pointer]: ☰
    - main [ref=e18]:
      - region "TaskFlow工作现场" [ref=e21]:
        - generic [ref=e23]:
          - button "聚焦窗格 · TaskFlow 预览" [ref=e24]:
            - generic [ref=e28]: TaskFlow 预览
          - generic [ref=e29]:
            - button "左右分屏" [ref=e30] [cursor=pointer]: ◫
            - button "上下分屏" [ref=e31] [cursor=pointer]: ⬒
            - button "专注当前窗格" [ref=e32] [cursor=pointer]: ⤢
            - button "窗格操作" [ref=e33] [cursor=pointer]: ···
            - button "关闭窗格" [ref=e34] [cursor=pointer]: ×
        - generic [ref=e35]:
          - generic [ref=e36]:
            - button "后退" [ref=e37] [cursor=pointer]
            - button "前进" [disabled] [ref=e40]
            - button "刷新页面" [ref=e43] [cursor=pointer]
            - generic [ref=e47]:
              - generic [ref=e48]: 页面地址
              - textbox "页面地址" [ref=e49]: wsl-demo://taskflow/index.html
            - button "选择元素" [ref=e50] [cursor=pointer]
          - generic [ref=e51]:
            - generic [ref=e52]:
              - text: 关联会话
              - combobox "关联会话" [ref=e53]:
                - option "明确选择会话" [selected]
                - option "Agent 会话"
            - button "新建关联会话" [ref=e54] [cursor=pointer]
            - button "采集到关联会话" [disabled] [ref=e55]
            - button "打开关联会话" [disabled] [ref=e56]
          - status [ref=e57]: 请在此网页的“关联会话”中明确选择会话，再点击“采集到关联会话”。没有会话时可新建关联会话；采集结果保存在所选会话。
          - generic [ref=e58]:
            - generic [ref=e59]: 公开 HTTPS 网页 · 只读参考资源
            - button "加入空间" [disabled] [ref=e60]
            - button "查看空间资源" [ref=e61] [cursor=pointer]
    - button "通知 · 1 条未读" [ref=e63] [cursor=pointer]:
      - generic [ref=e66]: "1"
```

# Test source

```ts
  109 | });
  110 | 
  111 | test('选择模式中导航：退出选择模式，之后页面点击正常生效', async () => {
  112 |   await session().getByRole('button', { name: '重新选择元素' }).click();
  113 |   await expect
  114 |     .poll(async () => (await workspaceSnapshot(page)).workspaces[0]!.resources.find((r) => r.kind === 'web')!.preview!.picking)
  115 |     .toBe(true);
  116 |   const address = page.getByLabel('页面地址');
  117 |   await address.fill('wsl-demo://taskflow/members.html');
  118 |   await address.press('Enter');
  119 |   await expect.poll(async () => (await previewInfo(app)).url).toBe('wsl-demo://taskflow/members.html');
  120 |   await expect(page.getByRole('button', { name: '选择中 · Esc 取消' })).toHaveCount(0);
  121 |   await previewClick(app, await previewElementCenter(app, 'header a[href="index.html"]'));
  122 |   await expect.poll(async () => (await previewInfo(app)).url).toBe('wsl-demo://taskflow/index.html');
  123 | });
  124 | 
  125 | test('运行、检查、审阅分别记录；没有独立检查器不会显示通过', async () => {
  126 |   await session().getByRole('button', { name: '任务', exact: true }).click();
  127 |   await session().getByLabel('附加目标（明确选择）').selectOption('');
  128 |   await session().getByLabel('修改目标').fill('只回复中文标记工作台742，不执行任何工具。');
  129 |   await session().getByRole('button', { name: '确认任务（生成新版本）' }).click();
  130 |   await expect(session()).toContainText('任务 v2');
  131 |   await session().getByRole('button', { name: '开始运行' }).click();
  132 |   await expect(session()).toContainText('执行：completed');
  133 |   await session().getByRole('button', { name: '检查', exact: true }).click();
  134 |   await expect(session()).toContainText('检查：not_run');
  135 |   await session().getByRole('button', { name: '运行检查' }).click();
  136 |   await expect(session()).toContainText('检查：blocked');
  137 |   await expect(session()).not.toContainText('检查：passed');
  138 |   await expect(session()).toContainText('审阅：尚未审阅');
  139 |   await expect(session().getByRole('button', { name: '接受结果' })).toBeDisabled();
  140 |   await expect(session()).toContainText('审阅：尚未审阅');
  141 |   const s = await workspaceSnapshot(page),
  142 |     run = s.workspaces[0]!.runs.at(-1)!;
  143 |   expect(run.review).toBeNull();
  144 |   expect(run.validation.state).toBe('blocked');
  145 | });
  146 | 
  147 | test('导航与草稿：个人作用域不沿用空间输入，回空间恢复草稿', async () => {
  148 |   await session().getByRole('textbox').last().fill('空间未发送草稿');
  149 |   await workshopNavigate(page, '首页');
  150 |   const personal = page.getByRole('region', { name: '混合输入' }).getByRole('textbox');
  151 |   await expect(personal).toHaveValue('');
  152 |   await personal.fill('个人未发送草稿');
  153 |   expect((await previewInfo(app)).visible).toBe(false);
  154 |   await workshopNavigate(page, '空间');
  155 |   await expect(session().getByRole('textbox').last()).toHaveValue('空间未发送草稿');
  156 |   await expect.poll(async () => (await previewInfo(app)).visible).toBe(true);
  157 | });
  158 | 
  159 | test('侧栏：隐藏和临时展开使网页让位，按钮路径可固定恢复', async () => {
  160 |   await page.getByRole('button', { name: '显示或隐藏 Workshop（⌘B）', exact: true }).click();
  161 |   await expect(page.getByRole('navigation', { name: '空间标签' })).toHaveCount(0);
  162 |   const edge = page.getByRole('button', { name: '展开 Workshop', exact: true });
  163 |   await edge.click();
  164 |   await expect(page.getByRole('navigation', { name: '空间标签' })).toBeVisible();
  165 |   await expect.poll(async () => (await previewInfo(app)).visible).toBe(false);
  166 |   await expect(page.getByRole('button', { name: '取消固定 Workshop', exact: true })).toHaveAttribute('aria-pressed', 'true');
  167 |   await page.getByRole('button', { name: '取消固定 Workshop', exact: true }).click();
  168 |   await expect(page.getByRole('navigation', { name: '空间标签' })).toHaveCount(0);
  169 |   await edge.click();
  170 |   await page.getByRole('button', { name: '固定 Workshop', exact: true }).click();
  171 |   await expect(page.getByRole('button', { name: '取消固定 Workshop', exact: true })).toHaveAttribute('aria-pressed', 'true');
  172 |   await expect.poll(async () => (await previewInfo(app)).visible).toBe(true);
  173 | });
  174 | 
  175 | test('菜单快捷键：应用菜单⌘B与⌘L仍走明确导航路径', async () => {
  176 |   await page.getByRole('navigation', { name: '空间标签' }).getByRole('button', { name: 'TaskFlow 预览', exact: true }).click();
  177 |   const clickMenu = (label: string) =>
  178 |     app.evaluate(({ Menu, BrowserWindow }, target) => {
  179 |       const find = (items: Electron.MenuItem[]): Electron.MenuItem | undefined => {
  180 |         for (const item of items) {
  181 |           if (item.label === target) return item;
  182 |           const nested = item.submenu ? find(item.submenu.items) : undefined;
  183 |           if (nested) return nested;
  184 |         }
  185 |         return undefined;
  186 |       };
  187 |       const item = find(Menu.getApplicationMenu()?.items ?? []);
  188 |       if (!item) throw new Error(`missing menu ${target}`);
  189 |       item.click(undefined, BrowserWindow.getAllWindows()[0], undefined as never);
  190 |       return item.accelerator;
  191 |     }, label);
  192 |   expect(await clickMenu('编辑地址')).toBe('CmdOrCtrl+L');
  193 |   await expect(page.getByLabel('页面地址')).toBeFocused();
  194 |   await page.keyboard.press('Escape');
  195 |   expect(await clickMenu('显示或隐藏 Workshop')).toBe('CmdOrCtrl+B');
  196 | });
  197 | 
  198 | test('窄窗口：活动窗格保留原生bounds，扩大恢复多窗格', async () => {
  199 |   const original = (await workspaceSnapshot(page)).workspaces[0]!.layout;
  200 |   if (!(await page.getByRole('navigation', { name: '空间标签' }).isVisible()))
  201 |     await page.getByRole('button', { name: '展开 Workshop', exact: true }).click();
  202 |   await page.getByRole('button', { name: 'TaskFlow 预览', exact: true }).click();
  203 |   await setWindowSize(app, 900, 700);
  204 |   await expect(page.locator('[data-pane-id]:visible')).toHaveCount(1);
  205 |   await expect.poll(async () => (await previewInfo(app)).visible).toBe(true);
  206 |   const info = await previewInfo(app),
  207 |     host = await page.locator('.preview-host:visible').boundingBox();
  208 |   expect(info.bounds.width).toBeGreaterThan(600);
> 209 |   expect(Math.abs(info.bounds.width - host!.width)).toBeLessThanOrEqual(1);
      |                                                     ^ Error: expect(received).toBeLessThanOrEqual(expected)
  210 |   await setWindowSize(app, 1440, 900);
  211 |   await expect(page.locator('[data-pane-id]:visible')).toHaveCount(2);
  212 |   expect((await workspaceSnapshot(page)).workspaces[0]!.layout).toEqual(original);
  213 | });
  214 | 
```