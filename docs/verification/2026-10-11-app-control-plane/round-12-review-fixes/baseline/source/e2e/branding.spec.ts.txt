import { expect, test } from '@playwright/test';
import { launchApp, setWindowSize, setWorkspaceTheme, windowShots, workshopNavigate } from './helpers';

test('品牌资产：本地加载、三主题与窄窗保持可见且不改变导航', async () => {
  const { app, page } = await launchApp({ sbxBin: new URL('./fixtures/sbx.mjs', import.meta.url).pathname });
  try {
    const nativeIcon = await app.evaluate(({ app, nativeImage }) => {
      const image = nativeImage.createFromPath(`${app.getAppPath()}/resources/branding/icon.png`);
      return { empty: image.isEmpty(), size: image.getSize() };
    });
    expect(nativeIcon).toEqual({ empty: false, size: { width: 1024, height: 1024 } });

    await workshopNavigate(page, '首页');
    const logos = page.locator('.brand-logo');
    await expect(logos).toHaveCount(2);
    await expect
      .poll(() =>
        logos.evaluateAll((images) =>
          images.every((image) => (image as HTMLImageElement).complete && (image as HTMLImageElement).naturalWidth > 0),
        ),
      )
      .toBe(true);
    const faviconLoaded = await page.evaluate(async () => {
      const link = document.querySelector<HTMLLinkElement>('link[rel="icon"]');
      if (!link) throw new Error('favicon missing');
      const image = new Image();
      image.src = link.href;
      await image.decode();
      return image.naturalWidth > 0;
    });
    expect(faviconLoaded).toBe(true);
    expect(await page.locator('.titlebar').evaluate((element) => getComputedStyle(element).getPropertyValue('-webkit-app-region'))).toBe(
      'drag',
    );
    await expect(page.getByRole('img')).toHaveCount(0);

    for (const theme of ['light', 'dark', 'warm']) {
      await setWorkspaceTheme(page, theme);
      await workshopNavigate(page, '首页');
      await expect(page.getByRole('heading', { name: '今天从哪里开始？', exact: true })).toBeVisible();
      for (const [width, height] of [
        [1440, 900],
        [960, 640],
      ] as const) {
        await setWindowSize(app, width, height);
        await expect
          .poll(() =>
            logos.evaluateAll((images) =>
              images.every((image) => {
                const rect = image.getBoundingClientRect();
                return rect.left >= 0 && rect.top >= 0 && rect.right <= innerWidth && rect.bottom <= innerHeight;
              }),
            ),
          )
          .toBe(true);
        expect(await page.locator('.home').evaluate((element) => element.scrollWidth <= element.clientWidth)).toBe(true);
        await windowShots(app, page, `branding-home-${theme}-${width}`);
      }
    }
    await page.locator('#left-panel-trigger').click();
    await expect(page.locator('#left-panel-trigger')).toHaveAttribute('aria-expanded', 'true');
    await workshopNavigate(page, '空间');
    await page.getByRole('button', { name: '切换空间', exact: true }).click();
    await expect(page.getByRole('dialog')).toBeVisible();
    await page.keyboard.press('Escape');
    await expect(page.getByRole('dialog')).not.toBeVisible();
  } finally {
    await app.close();
  }
});
