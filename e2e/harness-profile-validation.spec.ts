import { expect, test, type ElectronApplication, type Locator, type Page } from '@playwright/test';
import { launchApp, workshopNavigate } from './helpers';

// Real Renderer form and original Main handler; only the isolated fixture request timing/failure is controlled.
type ProfileFormProbe = {
  calls: number;
  release: () => void;
  restore: () => Promise<void>;
};
let app: ElectronApplication | undefined;
let page: Page;
let input: Locator;
let form: Locator;
let create: Locator;

test.beforeEach(async () => {
  ({ app, page } = await launchApp({ sbxBin: new URL('./fixtures/sbx.mjs', import.meta.url).pathname }));
  await workshopNavigate(page, '设置');
  await expect(page.getByRole('table', { name: 'Profile 列表' })).toBeVisible();
  input = page.getByPlaceholder('标签，例如：工作账号');
  form = page.locator('form').filter({ has: input });
  create = form.getByRole('button', { name: '新建', exact: true });
});
test.afterEach(async () => {
  if (!app) return;
  try {
    await app.evaluate(async () => {
      const probe = Reflect.get(globalThis, '__wslProfileFormProbe') as ProfileFormProbe | undefined;
      await probe?.restore();
    });
  } finally {
    await app.close();
    app = undefined;
  }
});

async function probeRequests(mode: 'normal' | 'fail-once' | 'hold' = 'normal') {
  if (!app) throw new Error('Profile form test has no Electron instance');
  await app.evaluate(({ ipcMain }, requestedMode) => {
    type Handler = Parameters<typeof ipcMain.handle>[1];
    // Electron exposes no public handler getter; preserve the exact installed handler as sibling E2E probes do.
    const handlers = Reflect.get(ipcMain, '_invokeHandlers') as Map<string, Handler>;
    const original = handlers.get('chat:profiles-create');
    if (!original) throw new Error('Missing real Profile create handler');
    const pending: Promise<unknown>[] = [];
    let release = () => {};
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    const probe: ProfileFormProbe = {
      calls: 0,
      release,
      restore: async () => {
        release();
        await Promise.allSettled(pending);
        ipcMain.removeHandler('chat:profiles-create');
        ipcMain.handle('chat:profiles-create', original);
        Reflect.deleteProperty(globalThis, '__wslProfileFormProbe');
      },
    };
    Reflect.set(globalThis, '__wslProfileFormProbe', probe);
    ipcMain.removeHandler('chat:profiles-create');
    ipcMain.handle('chat:profiles-create', (event, payload: unknown) => {
      probe.calls += 1;
      const call = probe.calls;
      const result = (async () => {
        if (requestedMode === 'hold') await gate;
        if (requestedMode === 'fail-once' && call === 1) throw new Error('Profile fixture: 保存失败，请重试');
        return original(event, payload);
      })();
      pending.push(result);
      return result;
    });
  }, mode);
}
async function requestCount() {
  if (!app) throw new Error('Profile form test has no Electron instance');
  return app.evaluate(() => (Reflect.get(globalThis, '__wslProfileFormProbe') as ProfileFormProbe).calls);
}
async function setProgrammaticValue(value: string) {
  // Exercise the schema beyond the browser maxlength affordance without calling the product action directly.
  await input.evaluate((element, next) => {
    if (!(element instanceof HTMLInputElement)) throw new Error('Expected Profile label input');
    const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')?.set;
    if (!setter) throw new Error('Missing native input setter');
    setter.call(element, next);
    element.dispatchEvent(new Event('input', { bubbles: true }));
  }, value);
  await expect(input).toHaveValue(value);
}

for (const [name, value] of [
  ['空白', '   '],
  ['超过60字符', '界'.repeat(61)],
] as const) {
  test(`Profile 表单：${name}由应用校验、关联字段并聚焦，不发送创建请求`, async ({ browserName: _browserName }, testInfo) => {
    await probeRequests();
    if (!app) throw new Error('Profile form test has no Electron instance');
    await app.evaluate(({ BrowserWindow }, url) => {
      const windows = BrowserWindow.getAllWindows().filter((window) => window.webContents.getURL() === url);
      if (windows.length !== 1) throw new Error('Profile form test cannot identify its owning window');
      windows[0]?.setContentSize(800, 700);
    }, page.url());
    await setProgrammaticValue(value);
    await expect(form).toHaveAttribute('novalidate', '');
    await create.click();
    await expect(input).toHaveAttribute('aria-invalid', 'true');
    const description = await input.getAttribute('aria-describedby');
    expect(description).toBeTruthy();
    const fieldError = page.locator(`[id="${description}"]`);
    await expect(fieldError).toHaveAttribute('role', 'alert');
    await expect(fieldError).toContainText('1–60');
    await expect(input).toBeFocused();
    await expect(input).toHaveValue(value);
    expect(await requestCount()).toBe(0);
    await page.screenshot({ path: testInfo.outputPath('profile-invalid.png') });
  });
}

test('Profile 表单：trim后1与60字符均可创建，保存后才清空', async () => {
  await probeRequests();
  const list = page.getByRole('table', { name: 'Profile 列表' });
  for (const label of ['单', '边'.repeat(60)]) {
    await setProgrammaticValue(`  ${label}  `);
    await create.click();
    await expect(list.getByRole('row').filter({ hasText: ` · ${label} · ` })).toHaveCount(1);
    await expect(input).toHaveValue('');
  }
  expect(await requestCount()).toBe(2);
});

test('Profile 表单：保存失败保留原输入并可重试成功', async ({ browserName: _browserName }, testInfo) => {
  await probeRequests('fail-once');
  const label = '  保留草稿  ';
  await input.fill(label);
  await create.click();
  await expect(page.getByText('Profile fixture: 保存失败，请重试', { exact: false })).toBeVisible();
  await expect(input).toHaveValue(label);
  await expect(create).toBeEnabled();
  expect(await requestCount()).toBe(1);
  await page.screenshot({ path: testInfo.outputPath('profile-save-failed.png') });
  await create.click();
  await expect(page.getByRole('table', { name: 'Profile 列表' }).getByRole('cell', { name: ' · 保留草稿 · ', exact: false })).toBeVisible();
  await expect(input).toHaveValue('');
  expect(await requestCount()).toBe(2);
});

test('Profile 表单：同轮重复提交只创建一次，待决时保护草稿且按钮尺寸不变', async ({ browserName: _browserName }, testInfo) => {
  await probeRequests('hold');
  await input.fill('待决草稿');
  const before = await create.boundingBox();
  await form.evaluate((element) => {
    element.dispatchEvent(new Event('submit', { bubbles: true, cancelable: true }));
    element.dispatchEvent(new Event('submit', { bubbles: true, cancelable: true }));
  });
  await expect.poll(requestCount).toBeGreaterThan(0);
  await expect(create).toBeDisabled();
  await expect(create).toHaveAttribute('aria-busy', 'true');
  await expect(input).toBeDisabled();
  await expect(input).toHaveValue('待决草稿');
  const after = await create.boundingBox();
  expect(before).not.toBeNull();
  expect(after).not.toBeNull();
  expect(after?.width).toBe(before?.width);
  expect(after?.height).toBe(before?.height);
  expect(await requestCount()).toBe(1);
  await page.screenshot({ path: testInfo.outputPath('profile-create-pending.png') });
  if (!app) throw new Error('Profile form test has no Electron instance');
  await app.evaluate(() => (Reflect.get(globalThis, '__wslProfileFormProbe') as ProfileFormProbe).release());
  await expect(page.getByRole('table', { name: 'Profile 列表' }).getByRole('cell', { name: ' · 待决草稿 · ', exact: false })).toHaveCount(
    1,
  );
  await expect(input).toHaveValue('');
  await expect(input).toBeEnabled();
  expect(await requestCount()).toBe(1);
});

test('Profile 表单：IME确认不创建，结束组合输入后显式提交才创建', async () => {
  await probeRequests();
  await input.fill('输入法草稿');
  const prevented = await input.evaluate((element) => {
    element.dispatchEvent(new CompositionEvent('compositionstart', { bubbles: true }));
    const enter = new KeyboardEvent('keydown', { key: 'Enter', isComposing: true, bubbles: true, cancelable: true });
    element.dispatchEvent(enter);
    const owner = element.closest('form');
    if (!owner) throw new Error('Profile label has no form');
    owner.dispatchEvent(new Event('submit', { bubbles: true, cancelable: true }));
    return enter.defaultPrevented;
  });
  expect(prevented).toBe(true);
  expect(await requestCount()).toBe(0);
  await expect(input).toHaveValue('输入法草稿');
  await input.dispatchEvent('compositionend');
  await create.click();
  await expect(
    page.getByRole('table', { name: 'Profile 列表' }).getByRole('cell', { name: ' · 输入法草稿 · ', exact: false }),
  ).toBeVisible();
  expect(await requestCount()).toBe(1);
});
