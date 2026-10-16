import { expect, test } from '@playwright/test';
import type { ElectronApplication } from '@playwright/test';
import type { ChildProcess } from 'node:child_process';
import { mkdtemp, mkdir, readFile, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { launchApp, target, fixtureSandbox } from './helpers';

test.skip(target !== 'build', 'Uses an isolated bootstrap and intercepted native dialog; packaged UI is validated separately.');

async function bounded<T>(operation: Promise<T>, label: string, timeoutMs = 5_000): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([
      operation,
      new Promise<never>((_, reject) => {
        timer = setTimeout(() => reject(new Error(`${label} timed out`)), timeoutMs);
      }),
    ]);
  } finally {
    clearTimeout(timer);
  }
}

async function closeShutdownFixture(app: ElectronApplication, ownedProcess: ChildProcess, primaryFailed: boolean): Promise<void> {
  const running = () => ownedProcess.exitCode === null && ownedProcess.signalCode === null;
  const failures: unknown[] = [];
  const attempt = async (operation: () => Promise<unknown>) => {
    try {
      await operation();
    } catch (error) {
      failures.push(error);
    }
  };
  if (running()) {
    await attempt(() =>
      bounded(
        app.evaluate(({ dialog }) => {
          // Disposal must not repeat the test's cancel or leave its pending prompt unresolved.
          dialog.showMessageBox = async () => ({ response: 2, checkboxChecked: false });
          const state: unknown = Reflect.get(globalThis, 'shutdownTest');
          if (state !== null && typeof state === 'object') {
            Reflect.set(state, 'response', 2);
            const resolve: unknown = Reflect.get(state, 'resolve');
            if (typeof resolve === 'function') resolve(2);
          }
        }),
        'Prepare fixture still-exit',
      ),
    );
  }
  await attempt(() => bounded(app.close(), 'Close shutdown fixture', 10_000));
  for (const signal of ['SIGTERM', 'SIGKILL'] as const) {
    if (!running()) break;
    // Only this launch's child handle may be signalled; no process-name or global cleanup.
    failures.push(new Error(`Fixture required ${signal}`));
    await attempt(async () => {
      let onExit: () => void = () => {};
      const exited = new Promise<void>((resolve) => {
        onExit = resolve;
        ownedProcess.once('exit', onExit);
      });
      try {
        if (!ownedProcess.kill(signal)) throw new Error(`Could not send ${signal} to fixture`);
        await bounded(exited, `Wait for fixture after ${signal}`);
      } finally {
        ownedProcess.removeListener('exit', onExit);
      }
    });
  }
  console.info('shutdown-fixture-cleanup', {
    pid: ownedProcess.pid ?? null,
    exitCode: ownedProcess.exitCode,
    signalCode: ownedProcess.signalCode,
    stillRunning: running(),
    cleanupFailureCount: failures.length,
  });
  if (failures.length > 0) {
    const error = new AggregateError(failures, `Shutdown fixture cleanup failed (PID ${ownedProcess.pid})`);
    if (!primaryFailed) throw error;
    // Keep the assertion as the test failure; cleanup diagnostics remain visible separately.
    console.error(error);
  }
}

for (const [name, original] of [
  ['invalid JSON', '{broken'],
  ['null sandbox', JSON.stringify({ version: 1, sandbox: null, apps: [] })],
  // Keep this version unsupported: v2 and v3 are valid historical/current registries.
  ['future version', JSON.stringify({ version: 999, sandbox: fixtureSandbox, apps: [] })],
] as const) {
  test(`exit preserves ${name}, supports cancel and successful retry after repair`, async () => {
    const userData = await mkdtemp(path.join(tmpdir(), 'wsl-shutdown-'));
    const registry = path.join(userData, 'chat/app-registry.json');
    await mkdir(path.dirname(registry), { recursive: true });
    await writeFile(registry, original);
    const { app, page } = await launchApp({ userData, codexBin: 'fixture' });
    const ownedProcess = app.process();
    let primaryFailed = false;
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
      const exited = new Promise<void>((resolve) => ownedProcess.once('exit', () => resolve()));
      const closed = app.waitForEvent('close');
      await app.evaluate(() => {
        Reflect.get(globalThis, 'shutdownTest').resolve(0);
      });
      await Promise.all([closed, exited]);
      expect(ownedProcess.exitCode).toBe(0);
    } catch (error) {
      primaryFailed = true;
      throw error;
    } finally {
      await closeShutdownFixture(app, ownedProcess, primaryFailed);
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
  const ownedProcess = app.process();
  let primaryFailed = false;
  try {
    await app.evaluate(({ dialog }) => {
      dialog.showMessageBox = async () => ({ response: 2, checkboxChecked: false });
    });
    const exited = new Promise<void>((resolve) => ownedProcess.once('exit', () => resolve()));
    const closed = app.waitForEvent('close');
    await app.evaluate(({ BrowserWindow }) => {
      BrowserWindow.getAllWindows()[0]?.close();
    });
    await Promise.all([closed, exited]);
    expect(ownedProcess.exitCode).toBe(0);
    expect(await readFile(registry, 'utf8')).toBe(original);
  } catch (error) {
    primaryFailed = true;
    throw error;
  } finally {
    await closeShutdownFixture(app, ownedProcess, primaryFailed);
  }
});

test('normal window close exits without a failure dialog', async () => {
  const { app } = await launchApp({ codexBin: 'fixture' });
  const ownedProcess = app.process();
  let primaryFailed = false;
  try {
    await app.evaluate(({ dialog }) => {
      dialog.showMessageBox = async () => {
        throw new Error('Unexpected cleanup failure dialog');
      };
    });
    const exited = new Promise<void>((resolve) => ownedProcess.once('exit', () => resolve()));
    const closed = app.waitForEvent('close');
    await app.evaluate(({ BrowserWindow }) => {
      BrowserWindow.getAllWindows()[0]?.close();
    });
    await Promise.all([closed, exited]);
    expect(ownedProcess.exitCode).toBe(0);
  } catch (error) {
    primaryFailed = true;
    throw error;
  } finally {
    await closeShutdownFixture(app, ownedProcess, primaryFailed);
  }
});
