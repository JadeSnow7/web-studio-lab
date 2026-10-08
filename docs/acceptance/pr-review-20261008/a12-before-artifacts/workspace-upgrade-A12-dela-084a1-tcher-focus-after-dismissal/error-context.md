# Instructions

- Following Playwright test failed.
- Explain why, be concise, respect Playwright best practices.
- Provide a snippet of code with the fix, if possible.

# Test info

- Name: workspace-upgrade.spec.ts >> A12 delayed PTY ready preserves switcher focus after dismissal
- Location: e2e/workspace-upgrade.spec.ts:150:1

# Error details

```
Error: expect(locator).toBeFocused() failed

Locator:  getByRole('button', { name: '切换空间', exact: true })
Expected: focused
Received: inactive
Timeout:  5000ms

Call log:
  - Expect "toBeFocused" getByRole('button', { name: '切换空间', exact: true }) with timeout 5000ms
  - waiting for getByRole('button', { name: '切换空间', exact: true })
    14 × locator resolved to <button type="button" aria-label="切换空间" class="space-switch-button no-drag">…</button>
       - unexpected value "inactive"

```

```yaml
- button "切换空间":
  - text: ▦
  - strong: TaskFlow
  - text: ⌄
```

# Test source

```ts
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
  94  |     await tab.getByRole('button', { name: '保存', exact: true }).click();
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
  150 | test('A12 delayed PTY ready preserves switcher focus after dismissal', async ({}, info) => {
  151 |   const { app, page } = await launchApp({ sbxBin: new URL('./fixtures/sbx.mjs', import.meta.url).pathname, controlledTerminal: true });
  152 |   const timeline: unknown[] = [];
  153 |   const capture = async (label: string) => timeline.push(await page.evaluate((label) => ({
  154 |     label, at: performance.now(), active: document.activeElement?.getAttribute('aria-label') ?? document.activeElement?.textContent,
  155 |   }), label));
  156 |   try {
  157 |     await page.getByRole('navigation', { name: '空间标签' }).getByRole('button', { name: '开发终端', exact: true }).click();
  158 |     await page.getByRole('button', { name: '连接终端', exact: true }).click();
  159 |     await expect(page.getByLabel('终端输入')).toBeFocused();
  160 |     await expect.poll(() => app.evaluate(() => (globalThis as unknown as { __wslTerminalGate: { deliveries: unknown[] } }).__wslTerminalGate.deliveries.length)).toBe(1);
  161 |     await capture('starting');
  162 |     const trigger = page.getByRole('button', { name: '切换空间', exact: true });
  163 |     await trigger.click();
  164 |     await expect(page.getByRole('dialog', { name: '切换空间' })).toBeVisible();
  165 |     await page.keyboard.press('Escape');
  166 |     await expect(trigger).toBeFocused();
  167 |     await capture('switcher-dismissed');
  168 |     await app.evaluate(() => {
  169 |       const gate = (globalThis as unknown as { __wslTerminalGate: { armed: boolean; deliveries: (() => void)[] } }).__wslTerminalGate;
  170 |       gate.armed = false;
  171 |       for (const deliver of gate.deliveries.splice(0)) deliver();
  172 |     });
  173 |     await expect(page.getByRole('button', { name: '关闭终端', exact: true })).toBeVisible();
  174 |     await capture('running');
> 175 |     await expect(trigger).toBeFocused();
      |                           ^ Error: expect(locator).toBeFocused() failed
  176 |   } finally {
  177 |     await info.attach('focus-timeline', { body: JSON.stringify(timeline, null, 2), contentType: 'application/json' });
  178 |     await app.close();
  179 |   }
  180 | });
  181 | 
```