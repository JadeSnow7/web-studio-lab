import { execFile } from 'node:child_process';
import { createHash } from 'node:crypto';
import { lstat, mkdir, mkdtemp, readFile, readdir, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { promisify } from 'node:util';
import type { ElectronApplication } from '@playwright/test';
import type { AppImportRequest, ManagedApp } from '../packages/protocol/src';
import { EDU_REQUIRED_FILES, EDU_ROOT_FILES, isEduExcludedName, isEduSourcePath } from '../packages/protocol/src';

const exec = promisify(execFile);

/** Synthetic source. Production Main performs Git inspection and source collection. */
export async function createEduImportFixture() {
  const root = await mkdtemp(path.join(tmpdir(), 'wsl-import-source-'));
  const files = new Map(EDU_REQUIRED_FILES.map((name) => [name, '# static import fixture\n']));
  files.set(
    'admin/package.json',
    JSON.stringify({
      name: 'synthetic-edu-import-fixture',
      scripts: {
        build: "node -e \"require('fs').writeFileSync('../HOST_EXECUTED', 'unexpected')\"",
        typecheck: 'node -e "throw new Error(\'must not run during preview\')"',
      },
    }),
  );
  files.set('admin/package-lock.json', JSON.stringify({ name: 'synthetic-edu-import-fixture', lockfileVersion: 3, packages: {} }));
  files.set('admin/src/App.tsx', 'export const App = () => <main>Synthetic import fixture</main>;\n');
  files.set('README.md', 'Synthetic edu import fixture. No real accounts or data.\n');
  files.set('.env', 'SYNTHETIC_SECRET=must-never-appear-in-preview\n');
  files.set('server/.data/edu.db', 'synthetic excluded data\n');
  for (const [name, content] of files) {
    await mkdir(path.dirname(path.join(root, name)), { recursive: true });
    await writeFile(path.join(root, name), content);
  }
  const git = (...args: string[]) =>
    exec('/usr/bin/git', ['-C', root, '-c', 'core.hooksPath=/dev/null', ...args], {
      env: { PATH: '/usr/bin:/bin', GIT_CONFIG_NOSYSTEM: '1', GIT_CONFIG_GLOBAL: '/dev/null' },
    });
  await git('init', '--quiet');
  await git('add', '.');
  await git(
    '-c',
    'user.name=Import Fixture',
    '-c',
    'user.email=fixture@example.invalid',
    'commit',
    '--quiet',
    '-m',
    'Synthetic import fixture',
  );
  return root;
}

/** Includes excluded data and Git bytes to detect writes to the selected checkout. */
export async function sourceTreeDigest(root: string, sourceOnly = false): Promise<string> {
  const entries: Array<{ path: string; mode: number; sha256: string }> = [];
  const walk = async (relative: string) => {
    if (sourceOnly && relative && isEduExcludedName(path.basename(relative))) return;
    const full = path.join(root, relative);
    const info = await lstat(full);
    if (info.isSymbolicLink()) throw new Error('source audit requires a regular isolated checkout');
    if (info.isDirectory()) {
      for (const child of (await readdir(full)).sort()) {
        if (sourceOnly && !relative && ![...EDU_ROOT_FILES, 'admin', 'server', 'docs'].includes(child)) continue;
        if (sourceOnly && relative === 'docs' && child !== 'development') continue;
        if (sourceOnly && relative === 'docs/development' && child !== 'webstudiolab.md') continue;
        await walk(path.join(relative, child));
      }
    } else if (info.isFile() && (!sourceOnly || isEduSourcePath(relative)))
      entries.push({
        path: relative,
        mode: info.mode,
        sha256: createHash('sha256')
          .update(await readFile(full))
          .digest('hex'),
      });
  };
  await walk('');
  return createHash('sha256').update(JSON.stringify(entries)).digest('hex');
}

export async function chooseImportSource(app: ElectronApplication, root: string | null) {
  await app.evaluate(({ dialog }, sourceRoot) => {
    const original = dialog.showOpenDialog;
    dialog.showOpenDialog = async () => {
      dialog.showOpenDialog = original;
      return { canceled: sourceRoot === null, filePaths: sourceRoot === null ? [] : [sourceRoot] };
    };
  }, root);
}

export async function deferImportPicker(app: ElectronApplication) {
  await app.evaluate(({ dialog }) => {
    const original = dialog.showOpenDialog;
    dialog.showOpenDialog = () => {
      dialog.showOpenDialog = original;
      return new Promise<Electron.OpenDialogReturnValue>((resolve) => {
        (globalThis as typeof globalThis & { importPickerResolve?: typeof resolve }).importPickerResolve = resolve;
      });
    };
  });
}

export async function resolveImportPicker(app: ElectronApplication, root: string) {
  await app.evaluate((_electron, sourceRoot) => {
    const scope = globalThis as typeof globalThis & { importPickerResolve?: (selection: Electron.OpenDialogReturnValue) => void };
    if (!scope.importPickerResolve) throw new Error('native picker is not pending');
    scope.importPickerResolve({ canceled: false, filePaths: [sourceRoot] });
    delete scope.importPickerResolve;
  }, root);
}

/** Observe real commands without replacing application behavior. */
export async function observeImportCommands(app: ElectronApplication) {
  await app.evaluate(({ ipcMain }) => {
    type Handler = (event: Electron.IpcMainInvokeEvent, request: unknown) => Promise<unknown>;
    const handler = (ipcMain as unknown as { _invokeHandlers: Map<string, Handler> })._invokeHandlers.get('workbench:command');
    if (!handler) throw new Error('workbench command handler unavailable');
    const scope = globalThis as typeof globalThis & { importCommands: string[] };
    scope.importCommands = [];
    ipcMain.removeHandler('workbench:command');
    ipcMain.handle('workbench:command', async (event, request: unknown) => {
      if (typeof request === 'object' && request !== null && 'type' in request && typeof request.type === 'string')
        scope.importCommands.push(request.type);
      return handler(event, request);
    });
  });
}

export const importCommands = (app: ElectronApplication) =>
  app.evaluate(() => (globalThis as typeof globalThis & { importCommands: string[] }).importCommands);

/** Only for late-success UI tests. The collector and Main use case remain real; no guest is started. */
export async function installDelayedImportService(app: ElectronApplication, origin: string) {
  await app.evaluate((_electron, fixtureOrigin) => {
    type Import = AppImportRequest;
    type Managed = ManagedApp;
    type Message = { id: string; method: string; payload?: Import };
    type Gate = { release: (() => void) | null; methods: string[] };
    const scope = globalThis as typeof globalThis & {
      __wslAppControlLive?: { child: Electron.UtilityProcess };
      __wslImportServiceGate?: Gate;
    };
    const child = scope.__wslAppControlLive?.child;
    if (!child) throw new Error('test bootstrap did not expose the service boundary');
    const gate: Gate = { release: null, methods: [] };
    scope.__wslImportServiceGate = gate;
    const original = child.postMessage.bind(child);
    let current: Managed | null = null;
    const answer = (id: string, result: unknown) => setTimeout(() => child.emit('message', { type: 'response', id, result }), 0);
    child.postMessage = (raw: unknown) => {
      // Main has already validated these messages through the production protocol.
      const message = raw as Message;
      gate.methods.push(message.method);
      if (message.method === 'app.importSource' && message.payload) {
        const payload = message.payload;
        // This fixture accepts only the edu-only import request.
        if ('profile' in payload) throw new Error('synthetic edu import fixture accepts only edu-web');
        current = {
          workspaceId: payload.workspaceId,
          projectId: payload.projectId,
          environmentId: 'sandbox',
          profile: { projectKind: 'edu-web', profileVersion: 1, source: payload.source },
          sourceSha256: payload.source.sourceSha256,
          appInstanceId: null,
          state: 'created',
          url: null,
          guestCwd: '/synthetic-ui-fixture/' + payload.projectId,
          cleanupConfirmed: true,
          error: null,
        };
        answer(message.id, { app: current, outcome: 'imported', retryable: false, errorCode: null });
        return;
      }
      if (current && message.payload?.projectId === current.projectId) {
        if (message.method === 'app.start') {
          gate.release = () => {
            if (!current) throw new Error('synthetic import disappeared');
            current = { ...current, state: 'running', appInstanceId: crypto.randomUUID(), url: fixtureOrigin, cleanupConfirmed: false };
            answer(message.id, current);
            gate.release = null;
          };
          return;
        }
        if (message.method === 'app.stop') {
          current = { ...current, state: 'stopped', url: null, cleanupConfirmed: true };
          answer(message.id, current);
          return;
        }
        if (message.method === 'app.get') {
          answer(message.id, current);
          return;
        }
      }
      original(raw);
    };
  }, origin);
}

export async function releaseDelayedImportService(app: ElectronApplication) {
  await app.evaluate(() => {
    const gate = (globalThis as typeof globalThis & { __wslImportServiceGate?: { release: (() => void) | null } }).__wslImportServiceGate;
    if (!gate?.release) throw new Error('synthetic start reply is not pending');
    gate.release();
  });
}
