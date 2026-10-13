import { expect, test } from '@playwright/test';
import { mkdtemp, mkdir, readFile, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { launchApp, target, fixtureSandbox } from './helpers';

test.skip(target !== 'build', 'Uses an isolated bootstrap and intercepted native dialog; packaged UI is validated separately.');

for (const [name, original] of [
  ['invalid JSON', '{broken'],
  ['null sandbox', JSON.stringify({ version: 1, sandbox: null, apps: [] })],
  ['future version', JSON.stringify({ version: 2, sandbox: fixtureSandbox, apps: [] })],
] as const) {
  test(`exit preserves ${name}, supports cancel and successful retry after repair`, async () => {
    const userData = await mkdtemp(path.join(tmpdir(), 'wsl-shutdown-'));
    const registry = path.join(userData, 'chat/app-registry.json');
    await mkdir(path.dirname(registry), { recursive: true });
    await writeFile(registry, original);
    const { app, page } = await launchApp({ userData, codexBin: 'fixture' });
    try {
      await app.evaluate(({ dialog }) => {
        const state = { dialogs: [] as Electron.MessageBoxOptions[], response: 1 as number | null, resolve: (_response: number) => {} };
        Object.assign(globalThis, { shutdownTest: state });
        dialog.showMessageBox = async (...args: unknown[]) => {
          state.dialogs.push(args.at(-1) as Electron.MessageBoxOptions);
          const response =
            state.response ??
            (await new Promise<number>((resolve) => {
              state.resolve = resolve;
            }));
          return { response, checkboxChecked: false };
        };
      });
      await app.evaluate(({ app, BrowserWindow }, quit) => {
        if (quit) app.quit();
        else BrowserWindow.getAllWindows()[0]?.close();
      }, name === 'null sandbox');
      await expect.poll(() => app.evaluate(() => Reflect.get(globalThis, 'shutdownTest').dialogs.length)).toBe(1);
      expect(page.isClosed()).toBe(false);
      const options = await app.evaluate(() => Reflect.get(globalThis, 'shutdownTest').dialogs[0] as Electron.MessageBoxOptions);
      expect(options.message).toContain('清理未确认');
      expect(options.detail).toContain('app-registry.json');
      expect(options.detail).toContain('进程可能继续运行');
      expect(options.defaultId).toBe(1);
      expect(await readFile(registry, 'utf8')).toBe(original);
      await app.evaluate(() => {
        Reflect.get(globalThis, 'shutdownTest').response = null;
      });
      await app.evaluate(({ app, BrowserWindow }, quit) => {
        if (quit) app.quit();
        else BrowserWindow.getAllWindows()[0]?.close();
      }, name === 'null sandbox');
      await expect.poll(() => app.evaluate(() => Reflect.get(globalThis, 'shutdownTest').dialogs.length)).toBe(2);
      await writeFile(registry, JSON.stringify({ version: 1, sandbox: fixtureSandbox, apps: [] }));
      const ownedProcess = app.process();
      const exited = new Promise<void>((resolve) => ownedProcess.once('exit', () => resolve()));
      const closed = app.waitForEvent('close');
      await app.evaluate(() => {
        Reflect.get(globalThis, 'shutdownTest').resolve(0);
      });
      await Promise.all([closed, exited]);
      expect(ownedProcess.exitCode).toBe(0);
    } finally {
      await app.close();
    }
  });
}

test('explicit still-exit closes without rewriting invalid historical registry', async () => {
  const userData = await mkdtemp(path.join(tmpdir(), 'wsl-shutdown-force-'));
  const registry = path.join(userData, 'chat/app-registry.json');
  const original = JSON.stringify({
    version: 1,
    sandbox: null,
    apps: [{ workspaceId: 'w', projectId: 'p', state: 'running', cleanupConfirmed: false }],
  });
  await mkdir(path.dirname(registry), { recursive: true });
  await writeFile(registry, original);
  const { app } = await launchApp({ userData, codexBin: 'fixture' });
  try {
    await app.evaluate(({ dialog }) => {
      dialog.showMessageBox = async () => ({ response: 2, checkboxChecked: false });
    });
    const ownedProcess = app.process();
    const exited = new Promise<void>((resolve) => ownedProcess.once('exit', () => resolve()));
    const closed = app.waitForEvent('close');
    await app.evaluate(({ BrowserWindow }) => {
      BrowserWindow.getAllWindows()[0]?.close();
    });
    await Promise.all([closed, exited]);
    expect(ownedProcess.exitCode).toBe(0);
    expect(await readFile(registry, 'utf8')).toBe(original);
  } finally {
    await app.close();
  }
});

test('normal window close exits without a failure dialog', async () => {
  const { app } = await launchApp({ codexBin: 'fixture' });
  try {
    await app.evaluate(({ dialog }) => {
      dialog.showMessageBox = async () => {
        throw new Error('Unexpected cleanup failure dialog');
      };
    });
    const ownedProcess = app.process();
    const exited = new Promise<void>((resolve) => ownedProcess.once('exit', () => resolve()));
    const closed = app.waitForEvent('close');
    await app.evaluate(({ BrowserWindow }) => {
      BrowserWindow.getAllWindows()[0]?.close();
    });
    await Promise.all([closed, exited]);
    expect(ownedProcess.exitCode).toBe(0);
  } finally {
    await app.close();
  }
});
