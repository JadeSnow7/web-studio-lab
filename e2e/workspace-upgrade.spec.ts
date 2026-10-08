import { setWorkspaceTheme } from './helpers';
import { expect, test } from '@playwright/test';
import { launchApp, previewInfo, setWindowSize } from './helpers';

test('A01 / A12 空间切换器独立于侧栏，浮层使原生网页让位并恢复焦点', async () => {
  const { app, page } = await launchApp();
  try {
    const switcher = page.getByRole('button', { name: '切换空间', exact: true });
    await expect(switcher).toBeVisible();
    await switcher.click();
    await expect(page.getByRole('dialog', { name: '切换空间' })).toBeVisible();
    await expect.poll(async () => (await previewInfo(app)).visible).toBe(false);
    await page.getByLabel('搜索空间或标签').fill('不存在的空间');
    await expect(page.getByText('没有匹配的空间或标签')).toBeVisible();
    await page.keyboard.press('Escape');
    await expect(switcher).toBeFocused();
    await expect.poll(async () => (await previewInfo(app)).visible).toBe(true);
    await page.getByRole('button', { name: '显示或隐藏 Workshop（⌘B）', exact: true }).click();
    await expect(page.getByRole('navigation', { name: '空间标签' })).toHaveCount(0);
    await switcher.click();
    await expect(page.getByRole('dialog', { name: '切换空间' })).toBeVisible();
  } finally {
    await app.close();
  }
});

test('A03 / A04 / A05 统一标签与四窗格不重复创建网页实例，关闭窗格保留标签', async () => {
  const { app, page } = await launchApp();
  try {
    const tabs = page.getByRole('navigation', { name: '空间标签' });
    await expect(tabs).toBeVisible();
    for (const label of ['TaskFlow 预览', '开发终端', 'Agent 会话'])
      await expect(tabs.getByRole('button', { name: label, exact: true })).toBeVisible();
    const identity = (await previewInfo(app)).id;
    for (let count = 2; count <= 4; count++) {
      await page.getByRole('button', { name: '左右分屏', exact: true }).last().click();
      await expect(page.locator('[data-pane-id]')).toHaveCount(count);
    }
    await page.getByRole('button', { name: '左右分屏', exact: true }).last().click();
    await expect(page.getByRole('alert')).toContainText('最多四个窗格');
    await tabs.getByRole('button', { name: 'TaskFlow 预览', exact: true }).click();
    expect((await previewInfo(app)).id).toBe(identity);
    await page.getByRole('button', { name: '关闭窗格', exact: true }).last().click();
    await expect(page.locator('[data-pane-id]')).toHaveCount(3);
    await expect(tabs.getByRole('button', { name: 'TaskFlow 预览', exact: true })).toBeVisible();
  } finally {
    await app.close();
  }
});

test('A12 键盘、主题、窄窗和专注模式恢复原布局', async () => {
  const { app, page } = await launchApp();
  try {
    await page.getByRole('button', { name: '上下分屏', exact: true }).click();
    await expect(page.locator('[data-pane-id]')).toHaveCount(2);
    await page.getByRole('button', { name: '专注当前窗格', exact: true }).first().click();
    await expect(page.locator('[data-pane-id]:visible')).toHaveCount(1);
    await page.getByRole('button', { name: '恢复布局', exact: true }).click();
    await setWindowSize(app, 900, 700);
    await expect(page.locator('[data-pane-id]:visible')).toHaveCount(1);
    await setWindowSize(app, 1440, 900);
    await expect(page.locator('[data-pane-id]:visible')).toHaveCount(2);
    await setWorkspaceTheme(page, 'dark');
    await expect(page.locator('html')).toHaveAttribute('data-theme', 'dark');
    await setWorkspaceTheme(page, 'warm');
    await expect(page.locator('html')).toHaveAttribute('data-theme', 'warm');
    await page.getByRole('button', { name: '切换空间', exact: true }).focus();
    await page.keyboard.press('Enter');
    await expect(page.getByLabel('搜索空间或标签')).toBeFocused();
  } finally {
    await app.close();
  }
});

test('A02 / A11 真实UI新建空间与会话，草稿隔离，搜索定位与无结果不切换', async () => {
  const { app, page } = await launchApp();
  try {
    await page.getByRole('button', { name: '切换空间', exact: true }).click();
    const switcher = page.getByRole('dialog', { name: '切换空间' });
    await expect(switcher).toBeVisible();
    await switcher.getByRole('button', { name: '新建空间', exact: true }).click();
    const create = page.getByRole('dialog', { name: '新建空间' });
    await create.getByLabel('名称').fill('研究空间742');
    await create.getByRole('button', { name: '保存', exact: true }).evaluate((node) => {
      (node as HTMLButtonElement).click();
      (node as HTMLButtonElement).click();
    });
    await expect(create).not.toBeVisible();
    await expect(page.getByRole('button', { name: '切换空间', exact: true })).toContainText('研究空间742');
    await page.getByRole('button', { name: '新建标签', exact: true }).click();
    const tab = page.getByRole('dialog', { name: '新建标签' });
    await tab.getByLabel('标签类型').selectOption('session');
    await tab.getByLabel('名称').fill('整理研究资料742');
    await tab.getByRole('button', { name: '保存', exact: true }).click();
    await expect(tab).not.toBeVisible();
    await page.getByRole('navigation', { name: '空间标签' }).getByRole('button', { name: '整理研究资料742', exact: true }).click();
    await page
      .getByRole('region', { name: 'Agent 会话内容' })
      .getByRole('textbox', { name: '会话消息', exact: true })
      .fill('研究空间独立草稿');
    await page.getByRole('button', { name: '切换空间', exact: true }).click();
    await expect(switcher).toBeVisible();
    await page.getByLabel('搜索空间或标签').fill('TaskFlow');
    await switcher.getByRole('button', { name: /TaskFlow.*个标签/ }).click();
    await page.getByRole('navigation', { name: '空间标签' }).getByRole('button', { name: 'Agent 会话', exact: true }).click();
    await expect(page.getByRole('region', { name: 'Agent 会话内容' }).getByRole('textbox', { name: '会话消息', exact: true })).toHaveValue(
      '',
    );
    await page.getByRole('button', { name: '切换空间', exact: true }).click();
    await expect(switcher).toBeVisible();
    await page.getByLabel('搜索空间或标签').fill('整理研究资料742');
    await switcher.getByRole('button', { name: /整理研究资料742/ }).click();
    await expect(page.getByRole('region', { name: 'Agent 会话内容' }).getByRole('textbox', { name: '会话消息', exact: true })).toHaveValue(
      '研究空间独立草稿',
    );
    await page.getByRole('button', { name: '切换空间', exact: true }).click();
    await expect(switcher).toBeVisible();
    await page.getByLabel('搜索空间或标签').fill('无匹配结果');
    await expect(page.getByText('没有匹配的空间或标签')).toBeVisible();
    await page.getByRole('button', { name: '清除搜索' }).click();
    await expect(page.getByLabel('搜索空间或标签')).toBeFocused();
    await page.keyboard.press('Escape');
    await expect(page.getByRole('button', { name: '切换空间', exact: true })).toContainText('研究空间742');
  } finally {
    await app.close();
  }
});

test('A12 三窗格活动PTY关闭切换器后不抢走触发器焦点', async () => {
  const { app, page } = await launchApp({ sbxBin: new URL('./fixtures/sbx.mjs', import.meta.url).pathname });
  try {
    await page.getByRole('button', { name: '左右分屏', exact: true }).click();
    await page.getByRole('navigation', { name: '空间标签' }).getByRole('button', { name: 'Agent 会话', exact: true }).click();
    await page.getByRole('button', { name: '聚焦窗格 · TaskFlow 预览' }).click();
    await page.getByRole('button', { name: '上下分屏', exact: true }).first().click();
    await page.getByRole('navigation', { name: '空间标签' }).getByRole('button', { name: '开发终端', exact: true }).click();
    await page.getByRole('region', { name: '资源终端' }).getByRole('button', { name: '连接终端', exact: true }).click();
    await expect(page.getByLabel('终端输入')).toBeFocused();
    const trigger = page.getByRole('button', { name: '切换空间', exact: true });
    await trigger.click();
    await expect(page.getByRole('dialog', { name: '切换空间' })).toBeVisible();
    await page.keyboard.press('Escape');
    await expect(trigger).toBeFocused();
    await expect(page.locator('[data-pane-id]:visible')).toHaveCount(3);
  } finally {
    await app.close();
  }
});
