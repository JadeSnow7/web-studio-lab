# Instructions

- Following Playwright test failed.
- Explain why, be concise, respect Playwright best practices.
- Provide a snippet of code with the fix, if possible.

# Test info

- Name: workspace-upgrade.spec.ts >> A02 / A11 真实UI新建空间与会话，草稿隔离，搜索定位与无结果不切换
- Location: e2e/workspace-upgrade.spec.ts:75:1

# Error details

```
TimeoutError: locator.selectOption: Timeout 30000ms exceeded.
Call log:
  - waiting for getByRole('dialog', { name: '新建标签' }).getByLabel('内容类型')

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
> 92  |     await tab.getByLabel('内容类型').selectOption('session');
      |                                  ^ TimeoutError: locator.selectOption: Timeout 30000ms exceeded.
  93  |     await tab.getByLabel('名称').fill('整理研究资料742');
  94  |     await tab.getByRole('button', { name: '保存', exact: true }).click();
  95  |     await expect(tab).not.toBeVisible();
  96  |     await page.getByRole('navigation', { name: '空间标签' }).getByRole('button', { name: '整理研究资料742', exact: true }).click();
  97  |     await page.getByRole('region', { name: 'Agent 会话内容' }).getByRole('textbox').fill('研究空间独立草稿');
  98  |     await page.getByRole('button', { name: '切换空间', exact: true }).click();
  99  |     await expect(switcher).toBeVisible();
  100 |     await page.getByLabel('搜索空间或标签').fill('TaskFlow');
  101 |     await switcher.getByRole('button', { name: /TaskFlow.*个标签/ }).click();
  102 |     await page.getByRole('navigation', { name: '空间标签' }).getByRole('button', { name: 'Agent 会话', exact: true }).click();
  103 |     await expect(page.getByRole('region', { name: 'Agent 会话内容' }).getByRole('textbox')).toHaveValue('');
  104 |     await page.getByRole('button', { name: '切换空间', exact: true }).click();
  105 |     await expect(switcher).toBeVisible();
  106 |     await page.getByLabel('搜索空间或标签').fill('整理研究资料742');
  107 |     await switcher.getByRole('button', { name: /整理研究资料742/ }).click();
  108 |     await expect(page.getByRole('region', { name: 'Agent 会话内容' }).getByRole('textbox')).toHaveValue('研究空间独立草稿');
  109 |     await page.getByRole('button', { name: '切换空间', exact: true }).click();
  110 |     await expect(switcher).toBeVisible();
  111 |     await page.getByLabel('搜索空间或标签').fill('无匹配结果');
  112 |     await expect(page.getByText('没有匹配的空间或标签')).toBeVisible();
  113 |     await page.getByRole('button', { name: '清除搜索' }).click();
  114 |     await expect(page.getByLabel('搜索空间或标签')).toBeFocused();
  115 |     await page.keyboard.press('Escape');
  116 |     await expect(page.getByRole('button', { name: '切换空间', exact: true })).toContainText('研究空间742');
  117 |   } finally {
  118 |     await app.close();
  119 |   }
  120 | });
  121 | 
  122 | test('A12 三窗格活动PTY关闭切换器后不抢走触发器焦点', async () => {
  123 |   const { app, page } = await launchApp({ sbxBin: new URL('./fixtures/sbx.mjs', import.meta.url).pathname });
  124 |   try {
  125 |     await page.getByRole('button', { name: '左右分屏', exact: true }).click();
  126 |     await page.getByRole('navigation', { name: '空间标签' }).getByRole('button', { name: 'Agent 会话', exact: true }).click();
  127 |     await page.getByRole('button', { name: '聚焦窗格 · TaskFlow 预览' }).click();
  128 |     await page.getByRole('button', { name: '上下分屏', exact: true }).first().click();
  129 |     await page.getByRole('navigation', { name: '空间标签' }).getByRole('button', { name: '开发终端', exact: true }).click();
  130 |     await page.getByRole('region', { name: '沙箱终端' }).getByRole('button', { name: '连接终端', exact: true }).click();
  131 |     await expect(page.getByLabel('沙箱终端输入')).toBeFocused();
  132 |     const trigger = page.getByRole('button', { name: '切换空间', exact: true });
  133 |     await trigger.click();
  134 |     await expect(page.getByRole('dialog', { name: '切换空间' })).toBeVisible();
  135 |     await page.keyboard.press('Escape');
  136 |     await expect(trigger).toBeFocused();
  137 |     await expect(page.locator('[data-pane-id]:visible')).toHaveCount(3);
  138 |   } finally {
  139 |     await app.close();
  140 |   }
  141 | });
  142 | 
```