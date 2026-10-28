import { expect, test } from '@playwright/test';
import { launchApp, workshopNavigate } from './helpers';

test('只有允许一次与始终拒绝：用户可拒绝本次请求，Agent 收到 cancelled', async () => {
  const { app, page } = await launchApp({
    sbxBin: new URL('./fixtures/sbx.mjs', import.meta.url).pathname,
    fixtureAcpScenario: 'ask-no-reject-once',
  });
  try {
    await expect
      .poll(
        async () =>
          (await page.evaluate(() => window.studio.chat.getStatus())).harnesses.find((h) => h.descriptor.harnessId === 'claude-code')
            ?.available,
      )
      .toBe(true);
    await page.evaluate(() => window.studio.chat.profiles.setDefault({ harnessId: 'claude-code', profileId: 'claude-code:default' }));
    await workshopNavigate(page, '首页');
    const region = page.getByRole('region', { name: '混合输入' });
    await region.getByRole('textbox').fill('拒绝本次获取');
    await region.getByRole('button', { name: '发送', exact: true }).click({ force: true });
    const card = region.getByRole('group', { name: '待决定的权限请求' });
    await expect(card).toContainText('获取 https://example.invalid/data');
    await expect(card.getByRole('button')).toHaveText(['允许一次', '拒绝']);
    const pending = await page.evaluate(() => window.studio.chat.get('conv-personal-default'));
    expect(pending.permissionRequests?.[0]?.options.map((option) => option.kind)).toEqual(['allow_once']);
    await page.screenshot({ path: test.info().outputPath('fallback-reject.png') });
    await card.getByRole('button', { name: '拒绝', exact: true }).click();
    await expect(region.locator('.message-agent').last().getByRole('paragraph')).toHaveText('决定：cancelled');
    await expect(card).toHaveCount(0);
    const done = await page.evaluate(() => window.studio.chat.get('conv-personal-default'));
    expect(done).toMatchObject({ state: 'idle', permissionRequests: [] });
    expect(done.messages.at(-1)?.text).toBe('决定：cancelled');
    expect(done.warnings).toContain('已拒绝 获取 https://example.invalid/data 的权限请求（用户）');
  } finally {
    await app.close();
  }
});
