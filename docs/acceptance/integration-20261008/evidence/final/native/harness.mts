import { mkdtemp, mkdir, writeFile } from 'node:fs/promises';
import { createInterface } from 'node:readline';
import path from 'node:path';
import { once } from 'node:events';

const repo = '/Users/huaodong/.codex/worktrees/bf64/web-studio-lab';
const evidenceRoot = path.join(repo, 'docs/acceptance/integration-20261008/evidence/final/native');
process.env.WSL_E2E_TARGET = 'packaged';
const { launchApp, workspaceSnapshot } = await import(path.join(repo, 'e2e/helpers.ts'));
await mkdir(evidenceRoot, { recursive: true });
const owned = await mkdtemp('/private/tmp/wsl-native-session-');
const profile = path.join(owned, 'profile');
const executablePath = path.join(repo, 'apps/desktop/release/mac-arm64/Web Studio Lab.app/Contents/MacOS/Web Studio Lab');
const { app, page, rendererErrors } = await launchApp({ userData: profile, codexBin: path.join(repo, 'e2e/fixtures/codex.mjs'), live: false });
const child = app.process();
const identity = { pid: child.pid, profile, executablePath, appPath: path.dirname(path.dirname(path.dirname(executablePath))), live: false };
console.log(JSON.stringify({ event: 'ready', ...identity }));
async function snapshot(name: string) {
  if (!/^[a-zA-Z0-9_-]+$/.test(name)) throw new Error('snapshot name must be a simple filename');
  const native = await app.evaluate(({ BrowserWindow, webContents }) => ({
    focusedWebContentsId: webContents.getFocusedWebContents()?.id ?? null,
    windows: BrowserWindow.getAllWindows().map((window) => ({
      id: window.id, bounds: window.getBounds(), focused: window.isFocused(), visible: window.isVisible(), minimized: window.isMinimized(),
      renderer: { id: window.webContents.id, focused: window.webContents.isFocused() },
      views: window.contentView.children.map((view) => {
        const contents = (view as Electron.WebContentsView).webContents;
        return { bounds: view.getBounds(), visible: view.getVisible(), webContentsId: contents?.id ?? null, focused: contents?.isFocused() ?? false, url: contents?.getURL() ?? null };
      }),
    })),
  }));
  const renderer = await page.evaluate(() => {
    const active = document.activeElement as HTMLElement | null;
    return { activeElement: active ? { tag: active.tagName, label: active.getAttribute('aria-label'), role: active.getAttribute('role'), text: active.textContent, value: 'value' in active ? (active as HTMLInputElement).value : null } : null };
  });
  const data = { at: new Date().toISOString(), identity, workspace: await workspaceSnapshot(page), native, renderer, rendererErrors: [...rendererErrors] };
  const output = path.join(evidenceRoot, `${name}.json`);
  await writeFile(output, JSON.stringify(data, null, 2) + '\n');
  console.log(JSON.stringify({ event: 'snapshot', output }));
}
let closed = false;
async function close(reason: string) {
  if (closed) return;
  closed = true;
  const errors: unknown[] = [];
  try { await snapshot('before-close'); } catch (error) { errors.push(error); }
  try { await app.close(); } catch (error) { errors.push(error); }
  if (child.exitCode === null && child.signalCode === null) await once(child, 'exit');
  const output = path.join(evidenceRoot, 'session-cleanup.json');
  const data = { at: new Date().toISOString(), identity, reason, applicationExited: child.exitCode !== null || child.signalCode !== null, exitCode: child.exitCode, signalCode: child.signalCode, rendererErrors: [...rendererErrors], errors: errors.map((error) => error instanceof Error ? { message: error.message, stack: error.stack } : String(error)), profileRetained: true };
  await writeFile(output, JSON.stringify(data, null, 2) + '\n');
  console.log(JSON.stringify({ event: 'closed', output, ...data }));
  if (errors.length) process.exitCode = 1;
}
const input = createInterface({ input: process.stdin, crlfDelay: Infinity });
try {
  for await (const line of input) {
    try {
      const command = JSON.parse(line);
      if (command.command === 'snapshot') await snapshot(command.name ?? 'snapshot');
      else if (command.command === 'close') { await close('stdin-close'); break; }
      else throw new Error('Only snapshot and close commands are supported');
    } catch (error) {
      console.error(JSON.stringify({ event: 'command-error', message: error instanceof Error ? error.message : String(error) }));
      process.exitCode = 1;
    }
  }
} finally {
  input.close();
  await close('stdin-eof');
}
