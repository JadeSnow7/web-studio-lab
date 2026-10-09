import { test, expect } from '@playwright/test';
import { cp, mkdir, appendFile, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { launchApp, workspaceSnapshot } from './helpers';

test('packaged template archive hash rejection is visible and disables all sandbox capability', async () => {
  test.skip(process.env['WSL_APP_HASH_REJECTION'] !== '1', 'explicit packaged-copy validation');
  test.setTimeout(180000);
  const original = process.env['WSL_E2E_APP_PATH'];
  if (!original || process.env['WSL_E2E_TARGET'] !== 'packaged') throw new Error('Select the built packaged App explicitly');
  const output = path.resolve(process.env['WSL_APP_EVIDENCE'] ?? `test-results/hash-rejection-${randomUUID()}`);
  await mkdir(output, { recursive: true });
  const copy = path.join(output, 'Corrupted Template.app');
  await cp(original, copy, { recursive: true, verbatimSymlinks: true, errorOnExist: true, force: false });
  await appendFile(path.join(copy, 'Contents/Resources/runtime/template-dependencies.tar.gz'), 'corrupt');
  process.env['WSL_E2E_APP_PATH'] = copy;
  try {
    const { app, page } = await launchApp({ live: true, userData: path.join(output, 'profile') });
    try {
      await expect(page.getByText('标准模板依赖归档校验失败', { exact: true })).toBeVisible();
      const setup = await page.evaluate(() => window.studio.setup.status());
      expect(setup.error?.code).toBe('payload-corrupt');
      const snapshot = await workspaceSnapshot(page);
      expect(snapshot.workspaces.every((workspace) => !workspace.managedApp)).toBe(true);
      const environment = await app.evaluate(() => ({
        path: process.env.PATH,
        injected: Object.keys(process.env).filter((key) => key.startsWith('WSL_')),
      }));
      expect(environment).toEqual({ path: '/usr/bin:/bin:/usr/sbin:/sbin', injected: [] });
      await page.screenshot({ path: path.join(output, 'hash-rejected.png') });
      await writeFile(path.join(output, 'hash-rejection.json'), JSON.stringify({ original, copy, setup, snapshot, environment }, null, 2));
    } finally {
      await app.close();
    }
  } finally {
    process.env['WSL_E2E_APP_PATH'] = original;
  }
});
