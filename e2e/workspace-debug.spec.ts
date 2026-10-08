import { expect, test } from '@playwright/test';
import { launchApp } from './helpers';
test('工作台启动：窄preload接口与真实导航控件', async () => {
  const { app, page } = await launchApp();
  try {
    await expect(page.getByRole('button', { name: '切换空间', exact: true })).toBeVisible();
    expect(await page.evaluate(() => Object.keys(window.studio))).toEqual(['workbench', 'chat', 'app', 'execution', 'shell']);
    expect(await page.evaluate(() => typeof (window as Window & { require?: unknown }).require)).toBe('undefined');
  } finally {
    await app.close();
  }
});
