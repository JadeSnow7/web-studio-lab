# Instructions

- Following Playwright test failed.
- Explain why, be concise, respect Playwright best practices.
- Provide a snippet of code with the fix, if possible.

# Test info

- Name: workspace-upgrade.spec.ts >> A02 / A11 真实UI新建空间与会话，草稿隔离，搜索定位与无结果不切换
- Location: e2e/workspace-upgrade.spec.ts:75:1

# Error details

```
Error: locator.click: Target page, context or browser has been closed
Browser logs:

<launching> /Users/huaodong/.codex/worktrees/bf64/web-studio-lab/node_modules/.pnpm/electron@44.5.1/node_modules/electron/dist/Electron.app/Contents/MacOS/Electron --inspect=0 --remote-debugging-port=0 /var/folders/87/gyhx13hs45351j7vwkdrr4sr0000gn/T/wsl-e2e-bootstrap-fzkmWi/main.cjs --user-data-dir=/var/folders/87/gyhx13hs45351j7vwkdrr4sr0000gn/T/wsl-e2e-AK9N0s
<launched> pid=45340
[pid=45340][err] Debugger listening on ws://127.0.0.1:57652/74bfb369-542e-4037-b695-d655e45b7eb1
[pid=45340][err] For help, see: https://nodejs.org/learn/getting-started/debugging
[pid=45340][err] Debugger attached.
[pid=45340][err] 
[pid=45340][err] DevTools listening on ws://127.0.0.1:57654/devtools/browser/2a7b70b0-8556-473b-a1d7-3f320d72f21e
[pid=45340][err] (node:45340) Warning: The 'NO_COLOR' env is ignored due to the 'FORCE_COLOR' env being set.
[pid=45340][err] (Use `Electron --trace-warnings ...` to show where the warning was created)
Call log:
  - waiting for getByRole('dialog', { name: '新建标签' }).getByRole('button', { name: '保存', exact: true })
    - locator resolved to <button type="submit" class="btn btn-primary">保存</button>
  - attempting click action
    - waiting for element to be visible, enabled and stable

```

# Test source

```ts
  1   | import { setWorkspaceTheme } from './helpers';
  2   | import { expect, test } from '@playwright/test';
  3   | import { launchApp, previewInfo, setWindowSize } from './helpers';
  4   | 
  5   | test('A01 / A12 空间切换器独立于侧栏，浮层使原生网页让位并恢复焦点', async () => {
  6   |   const { app, page } = await launchApp();
  7   |   try {
  8   |     const switcher = page.getByRole('button', { name: '切换空间', exact: true });
  9   |     await expect(switcher).toBeVisible();
  10  |     await switcher.click();
  11  |     await expect(page.getByRole('dialog', { name: '切换空间' })).toBeVisible();
  12  |     await expect.poll(async () => (await previewInfo(app)).visible).toBe(false);
  13  |     await page.getByLabel('搜索空间或标签').fill('不存在的空间');
  14  |     await expect(page.getByText('没有匹配的空间或标签')).toBeVisible();
  15  |     await page.keyboard.press('Escape');
  16  |     await expect(switcher).toBeFocused();
  17  |     await expect.poll(async () => (await previewInfo(app)).visible).toBe(true);
  18  |     await page.getByRole('button', { name: '显示或隐藏 Workshop（⌘B）', exact: true }).click();
  19  |     await expect(page.getByRole('navigation', { name: '空间标签' })).toHaveCount(0);
  20  |     await switcher.click();
  21  |     await expect(page.getByRole('dialog', { name: '切换空间' })).toBeVisible();
  22  |   } finally {
  23  |     await app.close();
  24  |   }
  25  | });
  26  | 
  27  | test('A03 / A04 / A05 统一标签与四窗格不重复创建网页实例，关闭窗格保留标签', async () => {
  28  |   const { app, page } = await launchApp();
  29  |   try {
  30  |     const tabs = page.getByRole('navigation', { name: '空间标签' });
  31  |     await expect(tabs).toBeVisible();
  32  |     for (const label of ['TaskFlow 预览', '开发终端', 'Agent 会话'])
  33  |       await expect(tabs.getByRole('button', { name: label, exact: true })).toBeVisible();
  34  |     const identity = (await previewInfo(app)).id;
  35  |     for (let count = 2; count <= 4; count++) {
  36  |       await page.getByRole('button', { name: '左右分屏', exact: true }).last().click();
  37  |       await expect(page.locator('[data-pane-id]')).toHaveCount(count);
  38  |     }
  39  |     await page.getByRole('button', { name: '左右分屏', exact: true }).last().click();
  40  |     await expect(page.getByRole('alert')).toContainText('最多四个窗格');
  41  |     await tabs.getByRole('button', { name: 'TaskFlow 预览', exact: true }).click();
  42  |     expect((await previewInfo(app)).id).toBe(identity);
  43  |     await page.getByRole('button', { name: '关闭窗格', exact: true }).last().click();
  44  |     await expect(page.locator('[data-pane-id]')).toHaveCount(3);
  45  |     await expect(tabs.getByRole('button', { name: 'TaskFlow 预览', exact: true })).toBeVisible();
  46  |   } finally {
  47  |     await app.close();
  48  |   }
  49  | });
  50  | 
  51  | test('A12 键盘、主题、窄窗和专注模式恢复原布局', async () => {
  52  |   const { app, page } = await launchApp();
  53  |   try {
  54  |     await page.getByRole('button', { name: '上下分屏', exact: true }).click();
  55  |     await expect(page.locator('[data-pane-id]')).toHaveCount(2);
  56  |     await page.getByRole('button', { name: '专注当前窗格', exact: true }).first().click();
  57  |     await expect(page.locator('[data-pane-id]:visible')).toHaveCount(1);
  58  |     await page.getByRole('button', { name: '恢复布局', exact: true }).click();
  59  |     await setWindowSize(app, 900, 700);
  60  |     await expect(page.locator('[data-pane-id]:visible')).toHaveCount(1);
  61  |     await setWindowSize(app, 1440, 900);
  62  |     await expect(page.locator('[data-pane-id]:visible')).toHaveCount(2);
  63  |     await setWorkspaceTheme(page, 'dark');
  64  |     await expect(page.locator('html')).toHaveAttribute('data-theme', 'dark');
  65  |     await setWorkspaceTheme(page, 'warm');
  66  |     await expect(page.locator('html')).toHaveAttribute('data-theme', 'warm');
  67  |     await page.getByRole('button', { name: '切换空间', exact: true }).focus();
  68  |     await page.keyboard.press('Enter');
  69  |     await expect(page.getByLabel('搜索空间或标签')).toBeFocused();
  70  |   } finally {
  71  |     await app.close();
  72  |   }
  73  | });
  74  | 
  75  | test('A02 / A11 真实UI新建空间与会话，草稿隔离，搜索定位与无结果不切换', async () => {
  76  |   const { app, page } = await launchApp();
  77  |   try {
  78  |     await page.getByRole('button', { name: '切换空间', exact: true }).click();
  79  |     const switcher = page.getByRole('dialog', { name: '切换空间' });
  80  |     await expect(switcher).toBeVisible();
  81  |     await switcher.getByRole('button', { name: '新建空间', exact: true }).click();
  82  |     const create = page.getByRole('dialog', { name: '新建空间' });
  83  |     await create.getByLabel('名称').fill('研究空间742');
  84  |     await create.getByRole('button', { name: '保存', exact: true }).evaluate((node) => {
  85  |       (node as HTMLButtonElement).click();
  86  |       (node as HTMLButtonElement).click();
  87  |     });
  88  |     await expect(create).not.toBeVisible();
  89  |     await expect(page.getByRole('button', { name: '切换空间', exact: true })).toContainText('研究空间742');
  90  |     await page.getByRole('button', { name: '新建标签', exact: true }).click();
  91  |     const tab = page.getByRole('dialog', { name: '新建标签' });
  92  |     await tab.getByLabel('标签类型').selectOption('session');
  93  |     await tab.getByLabel('名称').fill('整理研究资料742');
> 94  |     await tab.getByRole('button', { name: '保存', exact: true }).click();
      |                                                                ^ Error: locator.click: Target page, context or browser has been closed
  95  |     await expect(tab).not.toBeVisible();
  96  |     await page.getByRole('navigation', { name: '空间标签' }).getByRole('button', { name: '整理研究资料742', exact: true }).click();
  97  |     await page
  98  |       .getByRole('region', { name: 'Agent 会话内容' })
  99  |       .getByRole('textbox', { name: '会话消息', exact: true })
  100 |       .fill('研究空间独立草稿');
  101 |     await page.getByRole('button', { name: '切换空间', exact: true }).click();
  102 |     await expect(switcher).toBeVisible();
  103 |     await page.getByLabel('搜索空间或标签').fill('TaskFlow');
  104 |     await switcher.getByRole('button', { name: /TaskFlow.*个标签/ }).click();
  105 |     await page.getByRole('navigation', { name: '空间标签' }).getByRole('button', { name: 'Agent 会话', exact: true }).click();
  106 |     await expect(page.getByRole('region', { name: 'Agent 会话内容' }).getByRole('textbox', { name: '会话消息', exact: true })).toHaveValue(
  107 |       '',
  108 |     );
  109 |     await page.getByRole('button', { name: '切换空间', exact: true }).click();
  110 |     await expect(switcher).toBeVisible();
  111 |     await page.getByLabel('搜索空间或标签').fill('整理研究资料742');
  112 |     await switcher.getByRole('button', { name: /整理研究资料742/ }).click();
  113 |     await expect(page.getByRole('region', { name: 'Agent 会话内容' }).getByRole('textbox', { name: '会话消息', exact: true })).toHaveValue(
  114 |       '研究空间独立草稿',
  115 |     );
  116 |     await page.getByRole('button', { name: '切换空间', exact: true }).click();
  117 |     await expect(switcher).toBeVisible();
  118 |     await page.getByLabel('搜索空间或标签').fill('无匹配结果');
  119 |     await expect(page.getByText('没有匹配的空间或标签')).toBeVisible();
  120 |     await page.getByRole('button', { name: '清除搜索' }).click();
  121 |     await expect(page.getByLabel('搜索空间或标签')).toBeFocused();
  122 |     await page.keyboard.press('Escape');
  123 |     await expect(page.getByRole('button', { name: '切换空间', exact: true })).toContainText('研究空间742');
  124 |   } finally {
  125 |     await app.close();
  126 |   }
  127 | });
  128 | 
  129 | test('A12 三窗格活动PTY关闭切换器后不抢走触发器焦点', async () => {
  130 |   const { app, page } = await launchApp({ sbxBin: new URL('./fixtures/sbx.mjs', import.meta.url).pathname });
  131 |   try {
  132 |     await page.getByRole('button', { name: '左右分屏', exact: true }).click();
  133 |     await page.getByRole('navigation', { name: '空间标签' }).getByRole('button', { name: 'Agent 会话', exact: true }).click();
  134 |     await page.getByRole('button', { name: '聚焦窗格 · TaskFlow 预览' }).click();
  135 |     await page.getByRole('button', { name: '上下分屏', exact: true }).first().click();
  136 |     await page.getByRole('navigation', { name: '空间标签' }).getByRole('button', { name: '开发终端', exact: true }).click();
  137 |     await page.getByRole('region', { name: '资源终端' }).getByRole('button', { name: '连接终端', exact: true }).click();
  138 |     await expect(page.getByLabel('终端输入')).toBeFocused();
  139 |     const trigger = page.getByRole('button', { name: '切换空间', exact: true });
  140 |     await trigger.click();
  141 |     await expect(page.getByRole('dialog', { name: '切换空间' })).toBeVisible();
  142 |     await page.keyboard.press('Escape');
  143 |     await expect(trigger).toBeFocused();
  144 |     await expect(page.locator('[data-pane-id]:visible')).toHaveCount(3);
  145 |   } finally {
  146 |     await app.close();
  147 |   }
  148 | });
  149 | 
```