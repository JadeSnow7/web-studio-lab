import { test, expect, type Page, type TestInfo } from '@playwright/test';
import { createHash, randomUUID } from 'node:crypto';
import { appendFileSync } from 'node:fs';
import { mkdir, mkdtemp, readFile, realpath, rm, stat, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { createInterface } from 'node:readline';
import {
  MOTA_REQUIRED_FILES,
  type MotaEditorBridge,
  type MotaEditorProjection,
  type MotaEditorReadInput,
  type MotaEditorReadResult,
  type MotaEditorSaveInput,
} from '../packages/protocol/src';
import { chooseImportSource, sourceTreeDigest } from './edu-import-fixture';
import { launchApp, target, workspaceSnapshot } from './helpers';

const workspaceId = 'taskflow-demo';
const floorFile = 'project/floors/MT1.js';
const configFile = '_server/config.json';
const editorUrl = 'wsl-editor://mota/index.html';
const hash = (bytes: Buffer | string) => createHash('sha256').update(bytes).digest('hex');
const floor = (title: string, tile = 0) =>
  'main.floors.MT1 = ' +
  JSON.stringify({
    floorId: 'MT1',
    map: [
      [tile, 1],
      [2, 3],
    ],
    title,
    extension: { 文本: '保留😀' },
  }) +
  ';\n';
type Audit = {
  at: string;
  event: string;
  pid?: number;
  appInstanceId?: string;
  code?: number;
  signal?: string | null;
  serverHash?: string;
  data?: Record<string, unknown>;
};
type NativeNavigationObservation = {
  event: string;
  url?: string;
  isMainFrame?: boolean;
  isCurrentMainFrame?: boolean;
  defaultPrevented?: boolean;
};
const bridge = (page: Page) =>
  page.evaluate(() =>
    (window as unknown as { motaEditor: MotaEditorBridge }).motaEditor.status({ sessionIndex: null, requestId: crypto.randomUUID() }),
  );

function phaseLog(phase: string, event: string, detail?: unknown) {
  console.info('[r6-editor-phase]', JSON.stringify({ at: new Date().toISOString(), phase, event, detail }));
}

async function phase<T>(name: string, action: () => Promise<T>): Promise<T> {
  phaseLog(name, 'start');
  try {
    const result = await action();
    phaseLog(name, 'end');
    return result;
  } catch (error) {
    phaseLog(name, 'error', String(error));
    throw error;
  }
}

async function attachPrimaryError(info: TestInfo, error: unknown, editorObservation: string | null = null) {
  const body = JSON.stringify({
    at: new Date().toISOString(),
    error: error instanceof Error ? error.stack : String(error),
    editorObservation,
  });
  // Emit before attachment/cleanup so a stuck close cannot hide the original failure.
  phaseLog('primary-error-before-cleanup', 'error', body);
  try {
    await info.attach('r6-primary-error-before-cleanup', { body, contentType: 'application/json' });
  } catch (attachmentError) {
    phaseLog('primary-error-attachment', 'error', String(attachmentError));
  }
}

async function readFloorBaseline(page: Page) {
  const projection = await bridge(page);
  expect(projection.state).toBe('active');
  expect(projection.sessionIndex).not.toBeNull();
  const request: MotaEditorReadInput = { sessionIndex: projection.sessionIndex!, requestId: randomUUID(), file: floorFile };
  const baseline = await page.evaluate((input) => (window as unknown as { motaEditor: MotaEditorBridge }).motaEditor.read(input), request);
  expect(baseline.sessionIndex).toBe(projection.sessionIndex);
  expect(baseline.content).not.toBeNull();
  expect(baseline.contentHash).toBe(hash(baseline.content!));
  expect((await bridge(page)).state).toBe('active');
  return baseline;
}

async function expectRevokedSave(page: Page, baseline: MotaEditorReadResult, content: string, audit: () => Promise<Audit[]>) {
  const request: MotaEditorSaveInput = {
    sessionIndex: baseline.sessionIndex,
    requestId: randomUUID(),
    file: floorFile,
    expectedHash: baseline.contentHash,
    content,
  };
  const stages = (records: Audit[]) => records.filter((item) => item.event === 'server-input' && item.data?.method === 'editor.stage');
  const before = stages(await audit());
  // Await this exact save IPC before inspecting transport; neither a busy
  // operation nor a missing read baseline is evidence of authorization denial.
  const denied = await page.evaluate(async (input) => {
    let rejection: string | null = null;
    try {
      await (window as unknown as { motaEditor: MotaEditorBridge }).motaEditor.save(input);
    } catch (error) {
      rejection = String(error);
    }
    return rejection;
  }, request);
  const after = stages(await audit());
  expect(after).toEqual(before);
  expect(after.filter((item) => item.data?.requestId === request.requestId)).toHaveLength(0);
  expect(denied).toMatch(/^Error: (?:Error invoking remote method 'mota-editor:save': Error: )?(?:denied|revoked):/);
  expect(denied).not.toMatch(/\b(?:busy|source_changed):/);
  return { request, denied, stageFramesBefore: before.length, stageFramesAfter: after.length };
}

async function replaceText(page: Page, text: string) {
  await page.getByLabel(/^文件内容/).click();
  await page.keyboard.press('ControlOrMeta+A');
  await page.keyboard.insertText(text);
  await expect(page.getByLabel(/^文件内容/)).toHaveValue(text);
}

async function setup(info: TestInfo) {
  // These tests deliberately have no packaged/remote/live fallback or ready profile.
  expect(target, 'controlled local fixture supports the default build only').toBe('build');
  const root = await realpath(await mkdtemp(path.join(tmpdir(), 'wsl-mota-editor-')));
  const source = path.join(root, 'source');
  await mkdir(source);
  const files = new Map(MOTA_REQUIRED_FILES.map((name) => [name, '// controlled synthetic source\n']));
  files.set(
    'index.html',
    '<!doctype html><meta charset="utf-8"><title>Controlled Mota game</title><script src="/main.js"></script><script src="/project/floors/MT1.js"></script><pre id="readback"></pre>',
  );
  // Game readback executes the actual saved assignment; it is not the full Mota game.
  files.set(
    'main.js',
    'window.main={floors:{}};document.addEventListener("DOMContentLoaded",()=>{document.querySelector("#readback").textContent=JSON.stringify(window.main.floors.MT1);});',
  );
  files.set('project/floors/MT1.js', floor('初始地图'));
  files.set('editor.html', '<!doctype html><title>Untrusted imported editor</title><p>Imported source, no product bridge</p>');
  files.set('project/floors/MT2.js', 'protected second floor\n');
  for (const [name, bytes] of files) {
    await mkdir(path.dirname(path.join(source, name)), { recursive: true });
    await writeFile(path.join(source, name), bytes, { flag: 'wx', mode: 0o600 });
  }
  await writeFile(path.join(root, 'outside-sentinel'), 'outside remains unchanged\n');
  const sourceBefore = await sourceTreeDigest(source);
  const binary = path.join(root, 'sbx-fixture.mjs');
  await writeFile(
    binary,
    `#!${process.execPath}\nprocess.env.WSL_MOTA_FIXTURE_ROOT=${JSON.stringify(root)};\nawait import(${JSON.stringify(new URL('./fixtures/sbx-mota-app.mjs', import.meta.url).href)});\n`,
    { flag: 'wx', mode: 0o700 },
  );
  const { app, page } = await launchApp({ sbxBin: binary, sandbox: 'fixture-mota-editor', userData: path.join(root, 'profile') });
  const child = app.process();
  const exit = new Promise((resolve) =>
    child.once('exit', (code, signal) => {
      phaseLog('owned Electron process', 'exit', { code, signal });
      resolve({ code, signal });
    }),
  );
  child.once('close', (code, signal) => phaseLog('owned Electron stdio', 'close', { code, signal }));
  const state = async () => (await workspaceSnapshot(page)).workspaces.find((item) => item.workspaceId === workspaceId)!;
  const audit = async (): Promise<Audit[]> =>
    (await readFile(path.join(root, 'transport.jsonl'), 'utf8'))
      .trim()
      .split('\n')
      .map((line) => JSON.parse(line) as Audit);
  let projectId: string | undefined;
  const bytes = async (file: string): Promise<Buffer | null> => {
    if (!projectId) throw new Error('owned project is not imported');
    try {
      return await readFile(path.join(root, 'copy', projectId, file));
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') return null;
      throw error;
    }
  };
  const open = async (entry: 'game' | 'editor') => {
    await page.getByRole('button', { name: '管理 App', exact: true }).click();
    await page.getByRole('button', { name: entry === 'game' ? '游戏页面' : '地图编辑器', exact: true }).click();
    await expect(page.getByRole('dialog', { name: '空间 App' })).not.toBeVisible();
    const url = entry === 'editor' ? editorUrl : (await state()).managedApp!.url + '/index.html';
    await expect.poll(() => app.windows().some((candidate) => candidate.url() === url)).toBe(true);
    const view = app.windows().find((candidate) => candidate.url() === url)!;
    // Read native geometry, never replace layout/facts or add a privilege.
    await expect
      .poll(() =>
        app.evaluate(({ BrowserWindow }, expected) => {
          const native = BrowserWindow.getAllWindows()[0]!.contentView.children.find(
            (item) => (item as Electron.WebContentsView).webContents.getURL() === expected,
          ) as Electron.WebContentsView | undefined;
          return !!native && native.getVisible() && native.getBounds().width > 100 && native.getBounds().height > 100;
        }, url),
      )
      .toBe(true);
    return view;
  };
  const read = async (editor: Page, file = floorFile) => {
    const select = editor.getByLabel('文件', { exact: true });
    // Supported form automation exercises the product change handler, not OS popup keyboard behavior.
    await phase(`${file}: select.selectOption`, () => select.selectOption(file));
    await phase(`${file}: selected-value assertion`, () => expect(select).toHaveValue(file));
    await phase(`${file}: read.click`, () => editor.getByRole('button', { name: '读取当前版本', exact: true }).click());
    await phase(`${file}: read-status assertion`, () => expect(editor.getByRole('status')).toHaveText('已读取当前版本。'));
  };
  const cleanup = async () => {
    phaseLog('cleanup', 'start');
    try {
      const current = (await phase('cleanup: initial workspace snapshot', state)).managedApp;
      if (current && !current.cleanupConfirmed) {
        expect(
          await phase('cleanup: stopApp', () =>
            page.evaluate(() =>
              window.studio.workbench.command({ type: 'stopApp', workspaceId: 'taskflow-demo', commandId: crypto.randomUUID() }),
            ),
          ),
        ).toMatchObject({ ok: true });
      }
      phaseLog('cleanup: integrity and attachments', 'start');
      if (projectId) {
        expect((await phase('cleanup: confirmation workspace snapshot', state)).managedApp?.cleanupConfirmed).toBe(true);
        expect(JSON.parse(await readFile(path.join(root, 'ports.json'), 'utf8'))).toEqual([]);
        const records = await audit();
        const starts = records.filter((item) => item.event === 'server-start');
        expect(starts.length).toBeGreaterThan(0);
        for (const start of starts) {
          expect(records.find((item) => item.event === 'server-exit' && item.pid === start.pid)).toMatchObject({ code: 0, signal: null });
          expect(() => process.kill(start.pid!, 0)).toThrow();
        }
        for (const [file, original] of files)
          if (file !== floorFile && file !== configFile) expect((await bytes(file))?.equals(Buffer.from(original)), file).toBe(true);
      }
      expect(await sourceTreeDigest(source)).toBe(sourceBefore);
      expect(await readFile(path.join(root, 'outside-sentinel'), 'utf8')).toBe('outside remains unchanged\n');
      await info.attach('local-transport-audit', {
        body: await readFile(path.join(root, 'transport.jsonl')),
        contentType: 'application/x-ndjson',
      });
      await info.attach('fixture-scope', {
        body: JSON.stringify({
          root,
          sourceBefore,
          setup: 'controlled local import/guest startup/host-port mapping; fresh profile; real product server and private save pipeline',
          realGuest: 'not_run',
          fullMotaGame: 'not_run',
        }),
        contentType: 'application/json',
      });
      phaseLog('cleanup: integrity and attachments', 'end');
    } catch (error) {
      phaseLog('cleanup: checks', 'error', String(error));
      throw error;
    } finally {
      const observationPath = info.outputPath('r6-native-exit-dialog.jsonl');
      const observationTag = '[r6-native-exit-dialog] ';
      app.once('close', () => phaseLog('Electron application transport', 'close'));
      app.context().once('close', () => phaseLog('Electron browser context', 'close'));
      for (const candidate of app.windows()) {
        const url = candidate.url();
        candidate.once('close', () => phaseLog('Electron page transport', 'close', { url }));
      }
      const observations = createInterface({ input: child.stderr! });
      let observationCount = 0;
      let synchronousDialogCount = 0;
      observations.on('line', (line) => {
        const tagged = line.startsWith(observationTag);
        const synchronousDialog = line.startsWith(observationTag + '{"synchronousDialog":true,');
        const cleanupFailure =
          /退出对话框失败|退出前音轨核验失败|工作台状态不可读；guest清理已确认|停止应用的 Browser 清理未确认|应用接管拒绝后的 Browser 清理未确认|隐藏窗口时录音清理失败/.test(
            line,
          );
        if (synchronousDialog) {
          if (synchronousDialogCount++ >= 16) return;
        } else {
          if ((!tagged && !cleanupFailure) || observationCount >= 128) return;
          observationCount++;
        }
        const record = tagged
          ? line.slice(observationTag.length, observationTag.length + (synchronousDialog ? 262144 : 8192))
          : JSON.stringify({ at: new Date().toISOString(), event: 'owned-process-stderr', pid: child.pid, line: line.slice(0, 8192) });
        console.error(observationTag + record);
        try {
          appendFileSync(observationPath, record + '\n');
        } catch (error) {
          phaseLog('cleanup: native exit dialog observation write', 'error', String(error));
        }
      });
      try {
        await phase('cleanup: observe native exit dialog', () =>
          app.evaluate(
            ({ app, BrowserWindow, webContents, dialog }, { tag, pid }) => {
              const original = dialog.showMessageBox;
              const originalErrorBox = dialog.showErrorBox;
              const originalMessageBoxSync = dialog.showMessageBoxSync;
              let count = 0;
              const record = (data: Record<string, unknown>) => {
                if (count++ >= 128) return;
                console.error(tag + JSON.stringify({ at: new Date().toISOString(), pid, ...data }));
              };
              let synchronousCount = 0;
              const recordSynchronousDialog = (data: Record<string, unknown>) => {
                // Reserve bounded capacity for the native call even if other exit events exhaust their allowance.
                if (synchronousCount++ >= 16) return;
                console.error(tag + JSON.stringify({ synchronousDialog: true, at: new Date().toISOString(), pid, ...data }));
              };
              const windowIds = new Set<number>();
              const webContentsIds = new Set<number>();
              const observeWebContents = (contents: Electron.WebContents) => {
                if (webContentsIds.has(contents.id)) return;
                const id = contents.id;
                const type = contents.getType();
                const url = contents.getURL().slice(0, 1024);
                webContentsIds.add(id);
                record({ event: 'webContents observed', webContentsId: id, type, url });
                contents.on('will-prevent-unload', (event) =>
                  record({ event: 'webContents will-prevent-unload', webContentsId: id, defaultPrevented: event.defaultPrevented }),
                );
                contents.on('render-process-gone', (_event, details) =>
                  record({ event: 'webContents render-process-gone', webContentsId: id, details }),
                );
                contents.on('destroyed', () => record({ event: 'webContents destroyed', webContentsId: id, type, url }));
              };
              const observeWindow = (window: Electron.BrowserWindow) => {
                if (windowIds.has(window.id)) return;
                const id = window.id;
                const webContentsId = window.webContents.id;
                windowIds.add(id);
                observeWebContents(window.webContents);
                record({ event: 'window observed', windowId: id, webContentsId });
                window.on('close', (event) =>
                  record({ event: 'window close', windowId: id, webContentsId, defaultPrevented: event.defaultPrevented }),
                );
                window.on('closed', () => record({ event: 'window closed', windowId: id, webContentsId }));
              };
              // Observe at listener invocation; later listeners may still change defaultPrevented.
              app.on('before-quit', (event) => record({ event: 'app before-quit', defaultPrevented: event.defaultPrevented }));
              app.on('will-quit', (event) => record({ event: 'app will-quit', defaultPrevented: event.defaultPrevented }));
              app.on('quit', (event, exitCode) => record({ event: 'app quit', defaultPrevented: event.defaultPrevented, exitCode }));
              app.on('browser-window-created', (_event, window) => observeWindow(window));
              app.on('web-contents-created', (_event, contents) => observeWebContents(contents));
              const existingContents = webContents.getAllWebContents();
              for (const contents of existingContents) observeWebContents(contents);
              for (const window of BrowserWindow.getAllWindows()) observeWindow(window);
              dialog.showMessageBox = (...args: unknown[]) => {
                const options = args.at(-1) as Electron.MessageBoxOptions;
                record({
                  event: 'showMessageBox',
                  windowId: args.length > 1 ? (args[0] as Electron.BrowserWindow).id : null,
                  title: options.title?.slice(0, 256),
                  message: options.message.slice(0, 1024),
                  detail: options.detail?.slice(0, 2048),
                });
                // Preserve the native call and its exact Promise; never choose a response or manufacture cleanup success.
                try {
                  return Reflect.apply(original, dialog, args) as Promise<Electron.MessageBoxReturnValue>;
                } catch (error) {
                  record({ event: 'showMessageBox threw', error: String(error).slice(0, 2048) });
                  throw error;
                }
              };
              dialog.showErrorBox = function (this: typeof dialog, ...args: Parameters<typeof originalErrorBox>) {
                recordSynchronousDialog({
                  event: 'showErrorBox called',
                  title: args[0].slice(0, 512),
                  content: args[1].slice(0, 8192),
                  stack: new Error('showErrorBox observation').stack?.slice(0, 8192),
                });
                // Log before entering the native modal loop; preserve receiver, arguments, result and thrown errors.
                const result = Reflect.apply(originalErrorBox, this, args) as void;
                recordSynchronousDialog({ event: 'showErrorBox returned' });
                return result;
              };
              dialog.showMessageBoxSync = function (this: typeof dialog, ...args: unknown[]) {
                const options = args.at(-1) as Electron.MessageBoxSyncOptions;
                recordSynchronousDialog({
                  event: 'showMessageBoxSync called',
                  title: options.title?.slice(0, 512),
                  message: options.message.slice(0, 8192),
                  detail: options.detail?.slice(0, 8192),
                  stack: new Error('showMessageBoxSync observation').stack?.slice(0, 8192),
                });
                const result = Reflect.apply(originalMessageBoxSync, this, args) as number;
                recordSynchronousDialog({ event: 'showMessageBoxSync returned', result });
                return result;
              };
              record({ event: 'installed', windowIds: [...windowIds], webContentsIds: [...webContentsIds] });
            },
            { tag: observationTag, pid: child.pid },
          ),
        );
        phaseLog('cleanup: native exit dialog observation', 'path', observationPath);
      } finally {
        try {
          await phase('cleanup: app.close', () => app.close());
          expect(await phase('cleanup: child exit', () => exit)).toEqual({ code: 0, signal: null });
          phaseLog('cleanup', 'end');
        } finally {
          observations.close();
        }
      }
    }
  };
  try {
    await page.getByRole('button', { name: '新建 App', exact: true }).click();
    await chooseImportSource(app, source);
    await page.getByRole('button', { name: '导入已有工程', exact: true }).click();
    await expect.poll(async () => (await state()).appImport?.phase).toBe('ready');
    await page.getByRole('button', { name: '确认导入并启动', exact: true }).click();
    await expect.poll(async () => (await state()).managedApp?.state).toBe('running');
    await expect(page.getByRole('dialog', { name: '空间 App' })).not.toBeVisible();
    projectId = (await state()).managedApp!.projectId;
    expect((await state()).managedApp!.profile?.projectKind).toBe('mota-web');
    expect((await audit()).find((item) => item.event === 'server-start')?.serverHash).toBe(
      hash(await readFile(path.resolve('apps/service/src/mota-server.cjs'))),
    );
    expect(await bytes(configFile)).toBeNull();
    return { root, app, page, state, audit, bytes, open, read, cleanup, projectId };
  } catch (error) {
    await attachPrimaryError(info, error);
    await cleanup();
    throw error;
  }
}

test('R6 default trusted UI saves MT1 and absent/present config with real receipts and game readback', async ({
  playwright: _playwright,
}, info) => {
  const f = await phase('normal: setup', () => setup(info));
  let editorObservation: string | null = null;
  try {
    const before = await f.bytes(floorFile);
    expect(before?.toString()).toBe(floor('初始地图'));
    const editor = await phase('normal: open editor', () => f.open('editor'));
    editor.on('console', (message) => {
      if (message.type() !== 'info' || !message.text().startsWith('[r6-editor-ui] ')) return;
      editorObservation = message.text().slice(0, 2048);
      phaseLog('normal: editor observation', 'snapshot', editorObservation);
    });
    expect(editor.url()).toBe(editorUrl);
    expect(
      await editor.evaluate(() => {
        let session: { state: string; sessionIndex: number | null; operations: string[] } | null = null;
        const observe = () =>
          console.info(
            '[r6-editor-ui]',
            JSON.stringify({
              at: new Date().toISOString(),
              status: document.getElementById('state')?.textContent?.slice(0, 256),
              selected: (document.getElementById('file') as HTMLSelectElement).value,
              session,
            }),
          );
        // Observe DOM and pushed projections only; diagnostics never call read/status/save IPC.
        new MutationObserver(observe).observe(document.getElementById('state')!, {
          childList: true,
          characterData: true,
          subtree: true,
        });
        document.getElementById('file')!.addEventListener('change', observe);
        (window as unknown as { motaEditor: MotaEditorBridge }).motaEditor.onState((projection) => {
          session = {
            state: projection.state,
            sessionIndex: projection.sessionIndex,
            operations: projection.operations.slice(-3).map((entry) => entry.operation.status),
          };
          observe();
        });
        observe();
        return { node: typeof process, studio: typeof window.studio, bridge: typeof Reflect.get(window, 'motaEditor') };
      }),
    ).toEqual({ node: 'undefined', studio: 'undefined', bridge: 'object' });
    await f.read(editor);
    const edited = floor('中文扩展😀', 31);
    const expectedWrites = [{ file: floorFile, before, after: Buffer.from(edited) }];
    await phase('MT1: replace text', () => replaceText(editor, edited));
    await phase('MT1: save shortcut', () => editor.keyboard.press('ControlOrMeta+S'));
    await phase('MT1: save-status assertion', () => expect(editor.getByRole('status')).toHaveText('已保存到副本。可刷新游戏查看。'));
    phaseLog('MT1: file assertions', 'start');
    expect((await f.bytes(floorFile))?.equals(Buffer.from(edited))).toBe(true);
    expect(hash((await f.bytes(floorFile))!)).not.toBe(hash(before!));
    expect(await f.bytes(configFile)).toBeNull();
    phaseLog('MT1: file assertions', 'end');
    for (const content of ['{"扩展":{"标签":"中文😀"},"enabled":true}', '{"扩展":{"标签":"第二次🧭"},"enabled":false}']) {
      const configBefore = await f.bytes(configFile);
      const floorBefore = await f.bytes(floorFile);
      await f.read(editor, configFile);
      await phase('config: replace text', () => replaceText(editor, content));
      await phase('config: save.click', () => editor.getByRole('button', { name: '保存到副本', exact: true }).click());
      await phase('config: save-status assertion', () => expect(editor.getByRole('status')).toHaveText('已保存到副本。可刷新游戏查看。'));
      expect((await f.bytes(configFile))?.equals(Buffer.from(content))).toBe(true);
      expect(configBefore === null ? null : hash(configBefore)).not.toBe(hash(content));
      expect((await f.bytes(floorFile))?.equals(floorBefore!)).toBe(true);
      expectedWrites.push({ file: configFile, before: configBefore, after: Buffer.from(content) });
    }
    phaseLog('normal: receipts and game readback', 'start');
    await editor.getByRole('button', { name: '核对保存状态', exact: true }).click();
    const projection = await bridge(editor);
    const commits = projection.operations.filter((entry) => entry.operation.status === 'committed');
    expect(commits).toHaveLength(3);
    const current = (await f.state()).managedApp!;
    const records = await f.audit();
    const journal = JSON.parse(await readFile(path.join(f.root, 'profile/mota-editor-operations.json'), 'utf8')) as {
      schemaVersion: number;
      records: { binding: { appInstanceId: string }; operation: { requestId: string; receipt: unknown } }[];
    };
    expect(journal.schemaVersion).toBe(1);
    expect(journal.records).toHaveLength(3);
    for (const [index, entry] of commits.entries()) {
      const receipt = entry.operation.receipt!;
      const expected = expectedWrites[index]!;
      expect(receipt).toMatchObject({
        file: expected.file,
        expectedHash: expected.before === null ? null : hash(expected.before),
        afterHash: hash(expected.after),
        contentHash: hash(expected.after),
        contentLength: expected.after.length,
      });
      expect(receipt.requestId).toBe(entry.operation.requestId);
      expect(receipt.afterHash).toBe(receipt.contentHash);
      expect(
        records.find(
          (item) => item.event === 'server-reply' && item.data?.method === 'editor.commit' && item.data?.requestId === receipt.requestId,
        )?.data,
      ).toMatchObject({ ok: true, data: { status: 'committed', receipt } });
      const open = records.find(
        (item) =>
          item.event === 'server-input' && item.data?.method === 'editor.open' && item.data?.editorSessionId === receipt.editorSessionId,
      );
      expect(open?.data?.input).toMatchObject({ workspaceId, projectId: f.projectId, appInstanceId: current.appInstanceId });
      expect(journal.records.find((item) => item.operation.requestId === receipt.requestId)).toMatchObject({
        binding: { appInstanceId: current.appInstanceId },
        operation: { receipt },
      });
    }
    await info.attach('trusted-editor-saved', { body: await editor.screenshot(), contentType: 'image/png' });
    await f.page.getByRole('button', { name: '刷新游戏', exact: true }).click();
    const game = await f.open('game');
    await expect(game.locator('#readback')).toHaveText(
      JSON.stringify(JSON.parse(edited.replace(/^main.floors.MT1 = /, '').replace(/;\n$/, ''))),
    );
    expect(await game.evaluate(() => ({ editor: typeof Reflect.get(window, 'motaEditor'), studio: typeof window.studio }))).toEqual({
      editor: 'undefined',
      studio: 'undefined',
    });
    phaseLog('normal: receipts and game readback', 'end');
  } catch (error) {
    await attachPrimaryError(info, error, editorObservation);
    throw error;
  } finally {
    await f.cleanup();
  }
});

test('R6 default untrusted game/imported editor HTTP and postMessage attacks cannot write either target', async ({
  playwright: _playwright,
}, info) => {
  const f = await setup(info);
  try {
    const editor = await f.open('editor');
    await f.read(editor);
    await replaceText(editor, floor('positive control', 31));
    await editor.getByRole('button', { name: '保存到副本', exact: true }).click();
    await expect(editor.getByRole('status')).toContainText('已保存到副本');
    const before = await f.bytes(floorFile);
    const game = await f.open('game');
    const result = await game.evaluate(async () => {
      const old = await fetch('/editor.html');
      const html = await old.text();
      const disclosed = /data-wsl-editor-session="([a-f0-9]{48})"/.exec(html)?.[1];
      const statuses = [];
      for (const file of ['project/floors/MT1.js', '_server/config.json']) {
        const body = new URLSearchParams({
          name: file,
          value: btoa(file.endsWith('.js') ? 'main.floors.MT1 = {"floorId":"MT1","map":[[9]]};\n' : '{}'),
          type: 'base64',
        });
        const response = await fetch('/writeFile', {
          method: 'POST',
          headers: { 'content-type': 'application/x-www-form-urlencoded', 'X-WSL-Editor-Session': disclosed ?? 'a'.repeat(48) },
          body,
        });
        statuses.push({ file, status: response.status });
      }
      window.postMessage({ type: 'mota-editor:save', file: '_server/config.json', content: '{}' }, '*');
      return {
        oldStatus: old.status,
        nonceDisclosed: !!disclosed,
        statuses,
        editor: typeof Reflect.get(window, 'motaEditor'),
        studio: typeof window.studio,
      };
    });
    expect(result).toMatchObject({
      oldStatus: 200,
      nonceDisclosed: false,
      editor: 'undefined',
      studio: 'undefined',
      statuses: [
        { file: floorFile, status: 403 },
        { file: configFile, status: 403 },
      ],
    });
    await game.goto((await f.state()).managedApp!.url + '/editor.html');
    expect(await game.evaluate(() => ({ editor: typeof Reflect.get(window, 'motaEditor'), studio: typeof window.studio }))).toEqual({
      editor: 'undefined',
      studio: 'undefined',
    });
    const importedAttempts = await game.evaluate(async () => {
      window.postMessage({ type: 'mota-editor:save', file: '_server/config.json', content: '{}' }, '*');
      const statuses = [];
      for (const name of ['project/floors/MT1.js', '_server/config.json']) {
        const response = await fetch('/writeFile', {
          method: 'POST',
          headers: { 'content-type': 'application/x-www-form-urlencoded', 'X-WSL-Editor-Session': 'b'.repeat(48) },
          body: new URLSearchParams({
            name,
            type: 'base64',
            value: btoa(name.endsWith('.js') ? 'main.floors.MT1 = {"floorId":"MT1","map":[[8]]};\n' : '{}'),
          }),
        });
        statuses.push(response.status);
      }
      return statuses;
    });
    expect(importedAttempts).toEqual([403, 403]);
    expect((await f.bytes(floorFile))?.equals(before!)).toBe(true);
    expect(await f.bytes(configFile)).toBeNull();
    expect((await f.audit()).filter((item) => item.event === 'server-input' && item.data?.method === 'editor.commit')).toHaveLength(1);
    await info.attach('actual-http-denials', { body: JSON.stringify(result), contentType: 'application/json' });
  } finally {
    await f.cleanup();
  }
});

test('R6 default actual CSP child denial and failed native navigation revoke trusted-page saving', async ({
  playwright: _playwright,
}, info) => {
  const f = await setup(info);
  try {
    const editor = await f.open('editor');
    await f.read(editor);
    await replaceText(editor, floor('native positive', 31));
    await editor.getByRole('button', { name: '保存到副本', exact: true }).click();
    await expect(editor.getByRole('status')).toContainText('已保存到副本');
    const childSession = await bridge(editor);
    await editor.evaluate(() => {
      const violations: string[] = [];
      (globalThis as unknown as { r6CspViolations: string[] }).r6CspViolations = violations;
      document.addEventListener('securitypolicyviolation', (event) => {
        if (violations.length < 16) violations.push(event.violatedDirective);
      });
      for (const src of ['wsl-editor://mota/index.html', 'about:blank']) {
        const frame = document.createElement('iframe');
        frame.src = src;
        document.body.append(frame);
      }
      const frame = document.createElement('iframe');
      frame.srcdoc = '<script>parent.postMessage("child-script-ran", "*")</script>';
      document.body.append(frame);
    });
    // CSP violations arrive as tasks; animation frames do not establish delivery.
    await expect
      .poll(() => editor.evaluate(() => (globalThis as unknown as { r6CspViolations: string[] }).r6CspViolations))
      .toContainEqual(expect.stringMatching(/^frame-src/));
    const csp = await editor.evaluate(() => {
      return {
        violations: (globalThis as unknown as { r6CspViolations: string[] }).r6CspViolations,
        children: [...document.querySelectorAll('iframe')].map((item) => {
          try {
            return { url: item.contentWindow?.location.href, editor: typeof Reflect.get(item.contentWindow!, 'motaEditor') };
          } catch {
            return { url: 'inaccessible', editor: 'inaccessible' };
          }
        }),
      };
    });
    expect(csp.violations.some((item) => item.startsWith('frame-src'))).toBe(true);
    expect(csp.children.every((item) => item.editor !== 'object')).toBe(true);
    // Child attempts can revoke the preceding session. Reopen through the UI
    // and prove a new admission can save before testing native navigation.
    await f.open('game');
    expect(await f.open('editor')).toBe(editor);
    await f.read(editor);
    const fresh = await bridge(editor);
    expect(fresh.state).toBe('active');
    expect(fresh.sessionIndex).not.toBe(childSession.sessionIndex);
    const positive = floor('independent native positive', 9);
    await replaceText(editor, positive);
    await editor.getByRole('button', { name: '保存到副本', exact: true }).click();
    await expect(editor.getByRole('status')).toContainText('已保存到副本');
    expect((await f.bytes(floorFile))?.equals(Buffer.from(positive))).toBe(true);
    expect((await bridge(editor)).operations.findLast((item) => item.operation.status === 'committed')).toMatchObject({
      sessionIndex: fresh.sessionIndex,
      operation: { receipt: { file: floorFile, afterHash: hash(positive) } },
    });
    await f.read(editor);
    const baseline = await readFloorBaseline(editor);
    expect(baseline.sessionIndex).toBe(fresh.sessionIndex);
    const before = await f.bytes(floorFile);
    expect(baseline.contentHash).toBe(hash(before!));
    await editor.evaluate(() => {
      const observations = globalThis as unknown as { r6Projections: MotaEditorProjection[] };
      observations.r6Projections = [];
      (window as unknown as { motaEditor: MotaEditorBridge }).motaEditor.onState((projection) =>
        observations.r6Projections.push(projection),
      );
    });
    const guards = await f.app.evaluate(({ webContents }, expected) => {
      const contents = webContents.getAllWebContents().find((item) => item.getURL() === expected)!;
      const guards = { frame: contents.listenerCount('will-frame-navigate'), main: contents.listenerCount('will-navigate') };
      const events: NativeNavigationObservation[] = [];
      contents.on('did-start-navigation', (event) =>
        events.push({
          event: 'did-start-navigation',
          url: event.url,
          isMainFrame: event.isMainFrame,
        }),
      );
      contents.on('did-fail-load', () => events.push({ event: 'did-fail-load' }));
      contents.on('will-navigate', (event) =>
        events.push({
          event: 'will-navigate',
          url: event.url,
          isMainFrame: event.isMainFrame,
          defaultPrevented: event.defaultPrevented,
        }),
      );
      // Bracket the sole production frame guard; neither observer cancels or emits an event.
      const observeFrame = (phase: string, event: Electron.Event<Electron.WebContentsWillFrameNavigateEventParams>) =>
        events.push({
          event: 'will-frame-navigate:' + phase,
          url: event.url,
          isMainFrame: event.isMainFrame,
          isCurrentMainFrame: event.frame === contents.mainFrame,
          defaultPrevented: event.defaultPrevented,
        });
      contents.prependOnceListener('will-frame-navigate', (event) => observeFrame('before-guard', event));
      contents.once('will-frame-navigate', (event) => observeFrame('after-guard', event));
      (globalThis as unknown as { r6NativeEvents: NativeNavigationObservation[] }).r6NativeEvents = events;
      return guards;
    }, editorUrl);
    expect(guards).toEqual({ frame: 1, main: 1 });
    await editor.evaluate(() => location.assign('wsl-editor://mota/forbidden.html'));
    await expect
      .poll(() => f.app.evaluate(() => (globalThis as unknown as { r6NativeEvents: NativeNavigationObservation[] }).r6NativeEvents))
      .toEqual([
        { event: 'did-start-navigation', url: 'wsl-editor://mota/forbidden.html', isMainFrame: true },
        {
          event: 'will-frame-navigate:before-guard',
          url: 'wsl-editor://mota/forbidden.html',
          isMainFrame: true,
          isCurrentMainFrame: true,
          defaultPrevented: false,
        },
        {
          event: 'will-frame-navigate:after-guard',
          url: 'wsl-editor://mota/forbidden.html',
          isMainFrame: true,
          isCurrentMainFrame: true,
          defaultPrevented: true,
        },
      ]);
    expect(editor.url()).toBe(editorUrl);
    await expect
      .poll(() => editor.evaluate(() => (globalThis as unknown as { r6Projections: MotaEditorProjection[] }).r6Projections))
      .toContainEqual(expect.objectContaining({ state: 'revoked', sessionIndex: baseline.sessionIndex }));
    // The native event is cancelled by production. The original document still
    // has its bridge, so this is a real IPC denial, not a missing-bridge shortcut.
    const denied = await expectRevokedSave(editor, baseline, floor('navigation denied', 53), f.audit);
    await f.app.evaluate(async ({ webContents }, expected) => {
      const contents = webContents.getAllWebContents().find((item) => item.getURL() === expected)!;
      try {
        await contents.loadURL('http://127.0.0.1:54321/r6-blocked');
        throw new Error('native load unexpectedly succeeded');
      } catch (error) {
        if (!String(error).includes('ERR_BLOCKED_BY_CLIENT')) throw error;
      }
    }, editorUrl);
    const events = await f.app.evaluate(() => (globalThis as unknown as { r6NativeEvents: NativeNavigationObservation[] }).r6NativeEvents);
    expect(events).toContainEqual({ event: 'did-start-navigation', url: 'http://127.0.0.1:54321/r6-blocked', isMainFrame: true });
    expect(events).toContainEqual({ event: 'did-fail-load' });
    expect((await f.bytes(floorFile))?.equals(before!)).toBe(true);
    expect(await f.bytes(configFile)).toBeNull();
    expect((await f.audit()).filter((item) => item.event === 'server-input' && item.data?.method === 'editor.commit')).toHaveLength(2);
    await info.attach('native-boundary-observations', {
      body: JSON.stringify({ csp, guards, events, denied }),
      contentType: 'application/json',
    });
  } finally {
    await f.cleanup();
  }
});

test('R6 default close during real stage invalidates old session and retains draft until fresh read', async ({
  playwright: _playwright,
}, info) => {
  const f = await setup(info);
  try {
    const editor = await f.open('editor');
    await f.read(editor);
    const old = await bridge(editor);
    const baseline = await readFloorBaseline(editor);
    expect(baseline.sessionIndex).toBe(old.sessionIndex);
    const before = await f.bytes(floorFile);
    expect(baseline.contentHash).toBe(hash(before!));
    const draft = floor('关闭时的草稿😀', 31);
    await replaceText(editor, draft);
    await writeFile(path.join(f.root, 'hold-reply'), 'editor.stage:end', { flag: 'wx' });
    await editor.getByRole('button', { name: '保存到副本', exact: true }).click();
    await expect
      .poll(async () =>
        stat(path.join(f.root, 'reply-held')).then(
          () => true,
          (error: NodeJS.ErrnoException) => {
            if (error.code === 'ENOENT') return false;
            throw error;
          },
        ),
      )
      .toBe(true);
    await editor.getByRole('button', { name: '关闭视图', exact: true }).click();
    await expect.poll(async () => (await bridge(editor)).state).toBe('revoked');
    const closedDenial = await expectRevokedSave(editor, baseline, draft, f.audit);
    await rm(path.join(f.root, 'hold-reply'));
    await expect
      .poll(async () => (await f.audit()).some((item) => item.event === 'server-reply' && item.data?.method === 'editor.revoke'))
      .toBe(true);
    expect((await f.bytes(floorFile))?.equals(before!)).toBe(true);
    expect(await f.bytes(configFile)).toBeNull();
    expect((await f.state()).managedApp?.state).toBe('running');
    const reopened = await f.open('editor');
    expect(reopened).toBe(editor);
    await expect(reopened.getByLabel(/^文件内容/)).toHaveValue(draft);
    await expect(reopened.getByRole('button', { name: '保存到副本', exact: true })).toBeDisabled();
    await f.read(reopened);
    expect((await bridge(reopened)).sessionIndex).not.toBe(old.sessionIndex);
    await expect(reopened.getByLabel(/^文件内容/)).toHaveValue(draft);
    const stale = await expectRevokedSave(reopened, baseline, draft, f.audit);
    await reopened.getByRole('button', { name: '保存到副本', exact: true }).click();
    await expect(reopened.getByRole('status')).toContainText('已保存到副本');
    expect((await f.bytes(floorFile))?.equals(Buffer.from(draft))).toBe(true);
    expect((await f.audit()).filter((item) => item.event === 'server-input' && item.data?.method === 'editor.commit')).toHaveLength(1);
    await info.attach('close-save-denials', { body: JSON.stringify({ closedDenial, stale }), contentType: 'application/json' });
  } finally {
    await rm(path.join(f.root, 'hold-reply'), { force: true });
    await f.cleanup();
  }
});

test('R6 default commit-winning late receipt survives hide, duplicate is inert and restart retains conflict draft', async ({
  playwright: _playwright,
}, info) => {
  const f = await setup(info);
  try {
    const editor = await f.open('editor');
    await f.read(editor);
    const old = await bridge(editor);
    const before = await f.bytes(floorFile);
    const committed = floor('commit 先完成😀', 31);
    await replaceText(editor, committed);
    await writeFile(path.join(f.root, 'hold-reply'), 'editor.commit:single', { flag: 'wx' });
    await editor.getByRole('button', { name: '保存到副本', exact: true }).click();
    await expect
      .poll(async () =>
        stat(path.join(f.root, 'reply-held')).then(
          () => true,
          (error: NodeJS.ErrnoException) => {
            if (error.code === 'ENOENT') return false;
            throw error;
          },
        ),
      )
      .toBe(true);
    expect((await f.bytes(floorFile))?.equals(Buffer.from(committed))).toBe(true);
    const held = JSON.parse(await readFile(path.join(f.root, 'reply-held'), 'utf8')) as {
      requestId: string;
      data: { receipt: { afterHash: string } };
    };
    expect(held.data.receipt.afterHash).toBe(hash(committed));
    await f.open('game');
    expect((await bridge(editor)).state).toBe('revoked');
    await rm(path.join(f.root, 'hold-reply'));
    await expect
      .poll(async () => (await bridge(editor)).operations.find((item) => item.operation.requestId === held.requestId)?.operation.status)
      .toBe('committed');
    await expect(editor.getByRole('status')).toHaveText('授权已撤销。重新打开后读取当前版本，草稿仍保留。');
    await expect(editor.locator('#operation-state')).toHaveText('本次保存：已保存到副本。可刷新游戏查看。');
    await expect(editor.locator('#operation-state')).toHaveAttribute('data-session-index', String(old.sessionIndex));
    await expect(editor.locator('#operation-state')).toHaveAttribute('data-request-id', held.requestId);
    await expect(editor.getByRole('button', { name: '保存到副本', exact: true })).toBeDisabled();
    await f.open('editor');
    await expect(editor.getByLabel(/^文件内容/)).toHaveValue(committed);
    await f.read(editor);
    const request: MotaEditorSaveInput = {
      sessionIndex: old.sessionIndex!,
      requestId: held.requestId,
      file: floorFile,
      expectedHash: hash(before!),
      content: committed,
    };
    // Deliberate duplicate probe uses the REAL bridge/IPC and original request.
    const duplicateBefore = await stat(path.join(f.root, 'copy', f.projectId, floorFile));
    const duplicate = await editor.evaluate(
      (input) => (window as unknown as { motaEditor: MotaEditorBridge }).motaEditor.save(input),
      request,
    );
    expect(duplicate.operation.status).toBe('committed');
    expect(duplicate.operation.receipt?.afterHash).toBe(hash(committed));
    const conflictingDuplicate = await editor.evaluate(async (input) => {
      try {
        await (window as unknown as { motaEditor: MotaEditorBridge }).motaEditor.save({ ...input, content: input.content + ' ' });
        return null;
      } catch (error) {
        return String(error);
      }
    }, request);
    expect(conflictingDuplicate).toContain('operation_conflict');
    const duplicateAfter = await stat(path.join(f.root, 'copy', f.projectId, floorFile));
    expect({ inode: duplicateAfter.ino, mtime: duplicateAfter.mtimeMs, ctime: duplicateAfter.ctimeMs }).toEqual({
      inode: duplicateBefore.ino,
      mtime: duplicateBefore.mtimeMs,
      ctime: duplicateBefore.ctimeMs,
    });
    expect((await f.audit()).filter((item) => item.event === 'server-input' && item.data?.method === 'editor.commit')).toHaveLength(1);
    const restartBaseline = await readFloorBaseline(editor);
    expect(restartBaseline.contentHash).toBe(hash(committed));
    const draft = floor('重启仍保留草稿🧭', 9);
    await replaceText(editor, draft);
    const firstInstance = (await f.state()).managedApp!.appInstanceId;
    expect(
      await f.page.evaluate(() =>
        window.studio.workbench.command({ type: 'stopApp', workspaceId: 'taskflow-demo', commandId: crypto.randomUUID() }),
      ),
    ).toMatchObject({ ok: true });
    expect((await f.state()).managedApp?.cleanupConfirmed).toBe(true);
    // Controlled external change while the owned server is stopped. This is an
    // actual disk conflict, not a fabricated save receipt or changed UI baseline.
    const external = floor('停机期间的外部版本', 53);
    await writeFile(path.join(f.root, 'copy', f.projectId, floorFile), external);
    await f.page.getByRole('button', { name: '管理 App', exact: true }).click();
    await f.page.getByRole('button', { name: '启动应用', exact: true }).click();
    await expect.poll(async () => (await f.state()).managedApp?.state).toBe('running');
    await f.page.getByRole('dialog', { name: '空间 App' }).press('Escape');
    expect((await f.state()).managedApp!.appInstanceId).not.toBe(firstInstance);
    expect(await f.open('editor')).toBe(editor);
    await expect(editor.getByLabel(/^文件内容/)).toHaveValue(draft);
    await editor.getByRole('button', { name: '读取当前版本', exact: true }).click();
    await expect(editor.getByRole('region', { name: '版本冲突核对' })).toBeVisible();
    await expect(editor.getByRole('status')).toHaveText('版本已变化，草稿保留。请比较原始与当前内容。');
    await expect(editor.getByLabel('草稿原始版本', { exact: true })).toHaveValue(committed);
    await expect(editor.getByLabel('副本当前版本', { exact: true })).toHaveValue(external);
    await expect(editor.getByRole('button', { name: '保存到副本', exact: true })).toBeDisabled();
    const oldOwnerAttempt = await expectRevokedSave(editor, restartBaseline, draft, f.audit);
    expect((await f.bytes(floorFile))?.equals(Buffer.from(external))).toBe(true);
    expect(await f.bytes(configFile)).toBeNull();
    await info.attach('commit-won-before-revoke', {
      body: JSON.stringify({
        request,
        receipt: duplicate.operation.receipt,
        firstInstance,
        currentInstance: (await f.state()).managedApp!.appInstanceId,
        oldOwnerAttempt,
      }),
      contentType: 'application/json',
    });
  } finally {
    await rm(path.join(f.root, 'hold-reply'), { force: true });
    await f.cleanup();
  }
});

test('R6 default workspace switch revokes a held real stage before another save can dispatch', async ({
  playwright: _playwright,
}, info) => {
  const f = await setup(info);
  try {
    expect(
      await f.page.evaluate(() =>
        window.studio.workbench.command({
          type: 'createWorkspace',
          workspaceId: 'r6-other-space',
          commandId: crypto.randomUUID(),
          name: 'R6 另一空间',
        }),
      ),
    ).toMatchObject({ ok: true });
    expect(
      await f.page.evaluate(() =>
        window.studio.workbench.command({ type: 'switchWorkspace', workspaceId: 'taskflow-demo', commandId: crypto.randomUUID() }),
      ),
    ).toMatchObject({ ok: true });
    const editor = await f.open('editor');
    await f.read(editor);
    const old = await bridge(editor);
    const baseline = await readFloorBaseline(editor);
    expect(baseline.sessionIndex).toBe(old.sessionIndex);
    const before = await f.bytes(floorFile);
    expect(baseline.contentHash).toBe(hash(before!));
    const draft = floor('切换空间保留😀', 31);
    await replaceText(editor, draft);
    await writeFile(path.join(f.root, 'hold-reply'), 'editor.stage:end', { flag: 'wx' });
    await editor.getByRole('button', { name: '保存到副本', exact: true }).click();
    await expect
      .poll(async () =>
        stat(path.join(f.root, 'reply-held')).then(
          () => true,
          (error: NodeJS.ErrnoException) => {
            if (error.code === 'ENOENT') return false;
            throw error;
          },
        ),
      )
      .toBe(true);
    expect(
      await f.page.evaluate(() =>
        window.studio.workbench.command({ type: 'switchWorkspace', workspaceId: 'r6-other-space', commandId: crypto.randomUUID() }),
      ),
    ).toMatchObject({ ok: true });
    expect((await workspaceSnapshot(f.page)).activeWorkspaceId).toBe('r6-other-space');
    expect((await bridge(editor)).state).toBe('revoked');
    const denial = await expectRevokedSave(editor, baseline, draft, f.audit);
    await rm(path.join(f.root, 'hold-reply'));
    await expect
      .poll(async () => (await f.audit()).some((item) => item.event === 'server-reply' && item.data?.method === 'editor.revoke'))
      .toBe(true);
    expect((await f.bytes(floorFile))?.equals(before!)).toBe(true);
    expect(await f.bytes(configFile)).toBeNull();
    expect((await f.audit()).filter((item) => item.event === 'server-input' && item.data?.method === 'editor.commit')).toHaveLength(0);
    expect((await f.state()).managedApp?.state).toBe('running');
    expect(
      await f.page.evaluate(() =>
        window.studio.workbench.command({ type: 'switchWorkspace', workspaceId: 'taskflow-demo', commandId: crypto.randomUUID() }),
      ),
    ).toMatchObject({ ok: true });
    const reopened = await f.open('editor');
    await expect(reopened.getByLabel(/^文件内容/)).toHaveValue(draft);
    await expect(reopened.getByRole('button', { name: '保存到副本', exact: true })).toBeDisabled();
    await f.read(reopened);
    await reopened.getByRole('button', { name: '保存到副本', exact: true }).click();
    await expect(reopened.getByRole('status')).toContainText('已保存到副本');
    expect((await f.bytes(floorFile))?.equals(Buffer.from(draft))).toBe(true);
    await info.attach('workspace-save-denial', { body: JSON.stringify(denial), contentType: 'application/json' });
  } finally {
    await rm(path.join(f.root, 'hold-reply'), { force: true });
    await f.cleanup();
  }
});
