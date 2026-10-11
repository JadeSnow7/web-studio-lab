import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { expect, test, type ElectronApplication, type Page } from '@playwright/test';
import { launchApp, setWindowSize, windowShots, workshopNavigate } from './helpers';

let app: ElectronApplication;
let page: Page;
test.afterEach(async () => {
  if (app) await app.close();
});
async function home() {
  await workshopNavigate(page, '首页');
  return page.getByRole('region', { name: '混合输入' });
}
async function send(text: string) {
  const region = page.getByRole('region', { name: '混合输入' });
  await region.getByRole('textbox').fill(text);
  await region.getByRole('button', { name: '发送', exact: true }).click({ force: true });
}

test('fixture：续聊、新对话隔离、共享消息、IME、重复提交和取消', async () => {
  ({ app, page } = await launchApp({ codexBin: path.resolve('e2e/fixtures/codex.mjs') }));
  const region = await home();
  await expect(region).toContainText('codex-cli fixture');
  const input = region.getByRole('textbox');
  await input.fill('记住晴川742');
  await input.evaluate((node) => node.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true, isComposing: true })));
  await expect(input).toHaveValue('记住晴川742');
  await expect(region.locator('.message-user')).toHaveCount(0);
  await input.press('Shift+Enter');
  await expect(input).toHaveValue('记住晴川742\n');
  await input.fill('记住晴川742');
  await input.press('Enter');
  await expect(region.locator('.message-agent')).toHaveText(/fixture 回复：记住晴川742/);
  await expect(input).toBeFocused();
  await send('回忆');
  await expect(region.locator('.message-agent').last()).toContainText('记住晴川742');
  await workshopNavigate(page, '会话');
  await page.getByRole('button', { name: /首页对话/ }).click();
  await expect(page.getByRole('region', { name: '会话详情' })).toContainText('记住晴川742');
  await home();
  await region.getByRole('button', { name: '开始新对话' }).click();
  await expect(region.locator('.message-user')).toHaveCount(0);
  await send('回忆');
  await expect(region.locator('.message-agent')).toContainText('没有之前内容');
  await send('[slow]');
  await region.getByRole('button', { name: '发送', exact: true }).click({ force: true });
  await expect(region.locator('.message-user')).toHaveCount(2);
  await region.getByRole('button', { name: '取消回复' }).click();
  await expect(region).toContainText('回复已取消，进程已退出');
  await region.getByRole('button', { name: '开始新对话' }).click();
  await send('新消息');
  await expect(region.locator('.message-agent')).toContainText('fixture 回复：新消息');
  await expect(region).not.toContainText('迟到回复');
  await setWindowSize(app, 1024, 768);
  // 窄窗仅改变工作台可见布局，个人对话仍能通过真实按钮操作。
  await region.getByRole('button', { name: '开始新对话' }).click();
  await expect(region.locator('.message-user')).toHaveCount(0);
  await input.fill('窄窗口按钮发送');
  await region.getByRole('button', { name: '发送', exact: true }).click();
  await expect(region.locator('.message-agent')).toContainText('fixture 回复：窄窗口按钮发送');
  await expect(input).toBeFocused();
  await windowShots(app, page, 'chat-fixture');
});

test('fixture：非零退出、坏 JSON、缺完成事件显示失败并可继续', async () => {
  ({ app, page } = await launchApp({ codexBin: path.resolve('e2e/fixtures/codex.mjs') }));
  const region = await home();
  await expect(region).toContainText('codex-cli fixture');
  for (const prompt of ['[exit]', '[bad-json]', '[no-completion]']) {
    await send(prompt);
    await expect(region.getByRole('alert')).toBeVisible();
    await expect(region).not.toContainText('正在等待 Codex 回复');
    await expect(region.locator('.message-user').last()).toContainText(prompt);
    await region.getByRole('button', { name: '开始新对话' }).click();
  }
  await send('恢复');
  await expect(region.locator('.message-agent')).toContainText('fixture 回复：恢复');
});

test('CLI 不存在时明确不可用并保留草稿', async () => {
  ({ app, page } = await launchApp());
  const region = await home();
  await expect(region).toContainText('sbx');
  await send('不能丢失的草稿');
  await expect(region.getByRole('textbox')).toHaveValue('不能丢失的草稿');
  await expect(region).toContainText('未发送');
  await expect(region.locator('.message-user')).toHaveCount(0);
});

test('live：中文对话、上下文续聊、新会话隔离', async () => {
  test.skip(process.env['WSL_LIVE_CODEX'] !== '1', '真实沙箱模型须显式启用 WSL_LIVE_CODEX=1');
  test.setTimeout(240000);
  ({ app, page } = await launchApp({ live: true }));
  const region = await home();
  await expect(region).toContainText('codex-cli 0.', { timeout: 20000 });
  const marker = `晴川${randomUUID().slice(0, 8)}`;
  await send(`请记住本轮校验词 ${marker}。只回复该校验词，不使用任何工具。`);
  await expect(region.locator('.message-agent')).toContainText(marker, { timeout: 90000 });
  await expect(region).not.toContainText('正在等待 Codex 回复', { timeout: 90000 });
  await send('上一轮我提供的校验词是什么？只回复校验词，不使用任何工具。');
  await expect(region.locator('.message-agent')).toHaveCount(2, { timeout: 90000 });
  await expect(region.locator('.message-agent').last()).toContainText(marker);
  await expect(region).not.toContainText('正在等待 Codex 回复', { timeout: 90000 });
  await windowShots(app, page, 'chat-live-multiturn');
  await region.getByRole('button', { name: '开始新对话' }).click();
  await expect(region.locator('.message-user')).toHaveCount(0);
  await send('此前我是否给过你一个校验词？如果没有，请仅回复“没有”。不使用任何工具。');
  await expect(region.locator('.message-agent')).toHaveCount(1, { timeout: 90000 });
  await expect(region.locator('.message-agent')).not.toContainText(marker);
  await expect(region.locator('.message-agent')).toContainText('没有');
  await expect(region).not.toContainText('正在等待 Codex 回复', { timeout: 90000 });
  await windowShots(app, page, 'chat-live-new');
});
