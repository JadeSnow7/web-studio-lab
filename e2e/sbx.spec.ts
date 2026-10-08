import type { StudioApi } from '../packages/protocol/src';
import path from 'node:path';
import { tmpdir } from 'node:os';
import { mkdtemp, writeFile, rm, mkdir } from 'node:fs/promises';
import { randomUUID } from 'node:crypto';
import { stripVTControlCharacters, promisify } from 'node:util';
import { execFile } from 'node:child_process';
import { expect, test, type ElectronApplication, type Page } from '@playwright/test';
import {
  launchApp,
  previewInfo,
  setWindowSize,
  windowShots,
  screensDir,
  terminalSnapshot,
  workshopNavigate,
  workspaceSnapshot,
} from './helpers';

// PTY 可发 CRLF 后额外 CR；仅规范化测试读取，服务快照保留原始字节。
function ptyText(raw: string): string {
  return stripVTControlCharacters(raw).replace(/\r/g, '');
}

let app: ElectronApplication;
let page: Page;
test.afterEach(async () => {
  if (app) await app.close();
});

test('PTY 文本：规范化控制字符后只匹配完整输出行', () => {
  const raw = 'bash$ if test -e path; then echo CANARY_ACCESSIBLE; else echo CANARY_ABSENT; fi\r\n\r\x1b[32mCANARY_ABSENT\x1b[0m\r\n';
  expect(ptyText(raw)).toMatch(/^CANARY_ABSENT$/m);
  expect(ptyText('bash$ echo CANARY_ABSENT\r\n')).not.toMatch(/^CANARY_ABSENT$/m);
  expect(ptyText('bash$ echo FG_EXITED\r\n')).not.toMatch(/^FG_EXITED$/m);
  expect(ptyText('bash$ printf "NONCE=11111111-1111-1111-1111-111111111111"\r\n')).not.toMatch(/^NONCE=[0-9a-f-]{36}$/m);
  expect(ptyText('\r\n\rFG_PID=321\r\n')).toMatch(/^FG_PID=321$/m);
  expect(ptyText('\r\n\r24 80\r\n').match(/^\d+ \d+$/gm)).toEqual(['24 80']);
});

test('sbx：空间提供独立终端标签，切换时隐藏原生预览', async () => {
  ({ app, page } = await launchApp());
  const terminalTab = page.getByRole('button', { name: '开发终端', exact: true });
  await expect(terminalTab).toBeVisible({ timeout: 3000 });
  await terminalTab.click();
  await expect(terminalTab).toHaveAttribute('aria-current', 'page');
  await expect(page.getByRole('region', { name: '资源终端' })).toBeVisible();
  expect((await previewInfo(app)).visible).toBe(false);
  const panel = page.getByRole('region', { name: '资源终端' });
  await expect(panel).toContainText('sbx');
  await expect(panel.getByRole('button', { name: '连接终端', exact: true })).toBeDisabled();
  const snapshot = await workspaceSnapshot(page);
  expect(snapshot.workspaces[0]!.resources.find((resource) => resource.kind === 'terminal')!.terminal).toBeNull();
});

test('sbx：对话显示执行来源，连接失败不允许发送', async () => {
  ({ app, page } = await launchApp());
  await workshopNavigate(page, '首页');
  const region = page.getByRole('region', { name: '混合输入' });
  await expect(region.getByLabel('对话执行环境')).toBeVisible({ timeout: 3000 });
  await expect(region.getByLabel('对话执行环境')).toContainText('sbx');
  await region.getByRole('textbox').fill('连接不可用时保留草稿');
  await region.getByRole('button', { name: '发送', exact: true }).click({ force: true });
  await expect(region.getByRole('textbox')).toHaveValue('连接不可用时保留草稿');
  await expect(region.locator('.message-user')).toHaveCount(0);
});

test('空间会话：执行器不可用时保留草稿并记录失败运行', async () => {
  ({ app, page } = await launchApp());
  await page.getByRole('navigation', { name: '空间标签' }).getByRole('button', { name: 'Agent 会话', exact: true }).click();
  const region = page.getByRole('region', { name: 'Agent 会话内容' });
  await region.getByRole('textbox', { name: '会话消息', exact: true }).fill('执行器不可用时不能清空这份空间草稿');
  await region.getByRole('button', { name: '发送', exact: true }).click();
  await expect.poll(async () => (await workspaceSnapshot(page)).workspaces[0]!.runs.at(-1)?.state).toBe('failed');
  await expect(region.getByRole('textbox', { name: '会话消息', exact: true })).toHaveValue('执行器不可用时不能清空这份空间草稿');
  expect((await workspaceSnapshot(page)).workspaces[0]!.sessions[0]!.draft).toBe('执行器不可用时不能清空这份空间草稿');
});

test('fixture：终端持久 cwd、Ctrl-C、resize、切标签保留与确认关闭', async () => {
  ({ app, page } = await launchApp({ sbxBin: new URL('./fixtures/sbx.mjs', import.meta.url).pathname }));
  await page.getByRole('button', { name: '开发终端', exact: true }).click();
  const panel = page.getByRole('region', { name: '资源终端' });
  await panel.getByRole('button', { name: '连接终端', exact: true }).click();
  await expect(panel).toContainText('fixture-sandbox');
  await expect(panel).toContainText('已连接');
  const input = panel.getByLabel('终端输入');
  await input.focus();
  await input.pressSequentially('cd /tmp');
  await input.press('Enter');
  await input.pressSequentially('pwd');
  await input.press('Enter');
  await expect(panel.locator('.xterm')).toContainText('/tmp');
  await input.pressSequentially('printf marker');
  await input.press('Enter');
  await expect(panel.locator('.xterm')).toContainText('TERMINAL_MARKER');
  await page.getByRole('button', { name: 'TaskFlow 预览', exact: true }).click();
  await page.getByRole('button', { name: '开发终端', exact: true }).click();
  await expect(panel.locator('.xterm')).toContainText('TERMINAL_MARKER');
  await input.focus();
  await input.pressSequentially('sleep 60');
  await input.press('Enter');
  await input.press('Control+c');
  await expect(panel.locator('.xterm')).toContainText('^C');
  await setWindowSize(app, 1024, 768);

  await input.focus();
  await input.pressSequentially('stty size');
  await input.press('Enter');
  const snapshot = await terminalSnapshot(page);
  expect(ptyText(snapshot.output)).toMatch(/^\d+ \d+$/m);
  await windowShots(app, page, 'sbx-terminal-fixture-narrow');
  await panel.getByRole('button', { name: '关闭终端', exact: true }).click();
  await expect(panel).toContainText('已关闭，所属进程已确认退出');
  expect((await terminalSnapshot(page)).state).toBe('closed');
});

test('fixture：活动终端直接关闭应用需确认 Electron 进程退出', async () => {
  test.setTimeout(30000);
  const { app: closingApp, page: closingPage } = await launchApp({ sbxBin: new URL('./fixtures/sbx.mjs', import.meta.url).pathname });
  const child = closingApp.process();
  let exited = false;
  const processExit = new Promise<{ code: number | null; signal: NodeJS.Signals | null }>((resolve) => {
    child.once('exit', (code, signal) => {
      exited = true;
      resolve({ code, signal });
    });
  });
  let stderr = '';
  child.stderr?.on('data', (chunk: Buffer) => {
    stderr = (stderr + chunk.toString()).slice(-12000);
  });
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    await closingPage.getByRole('button', { name: '开发终端', exact: true }).click();
    const panel = closingPage.getByRole('region', { name: '资源终端' });
    await panel.getByRole('button', { name: '连接终端', exact: true }).click();
    await expect(panel).toContainText('已连接');
    const terminal = await terminalSnapshot(closingPage);
    expect(terminal.state).toBe('running');
    expect(terminal.cleanupPending).toBe(true);
    // 不预先关闭 PTY：直接覆盖应用关闭时的远端清理路径。
    const outcome = await Promise.race([
      closingApp.close().then(() => processExit),
      new Promise<never>((_, reject) => {
        timer = setTimeout(() => reject(new Error(`活动终端 app.close 在 12 秒内未完成；Electron stderr:\n${stderr}`)), 12000);
      }),
    ]);
    expect(outcome.signal).toBeNull();
    expect(outcome.code).toBe(0);
  } finally {
    if (timer) clearTimeout(timer);
    if (!exited) {
      console.error('失败收尾：仅强制结束本用例创建的 Electron 主进程；此操作不作为关闭成功证据。', stderr);
      child.kill('SIGKILL');
    }
  }
});

test('live：应用终端与 Codex 共享 guest 文件并确认交互与清理', async () => {
  test.skip(process.env['WSL_LIVE_SBX'] !== '1', '真实 sbx 与模型须显式启用 WSL_LIVE_SBX=1');
  test.setTimeout(240000);
  const canaryDir = await mkdtemp(path.join(tmpdir(), 'wsl-sbx-ui-canary-'));
  const canary = path.join(canaryDir, 'host-only.txt');
  await writeFile(canary, 'host-only test canary');
  const guestDir = `/home/agent/workspace/wsl-ui-${randomUUID()}`;
  let guestDirectoryMayExist = false;
  let liveApp: ElectronApplication | null = null;
  let nonce: string | null = null;
  const failures: unknown[] = [];
  try {
    ({ app, page } = await launchApp({ live: true }));
    liveApp = app;
    async function selectTab(name: string) {
      const tabs = page.getByRole('navigation', { name: '空间标签' });
      if (!(await tabs.isVisible())) await page.getByRole('button', { name: '展开 Workshop', exact: true }).click();
      await tabs.getByRole('button', { name, exact: true }).click();
    }
    await selectTab('开发终端');
    const panel = page.getByRole('region', { name: '资源终端' });
    const connect = panel.getByRole('button', { name: '连接终端', exact: true });
    await expect(connect).toBeEnabled({ timeout: 30000 });
    await connect.click();
    await expect
      .poll(
        async () => {
          const snapshot = await workspaceSnapshot(page);
          return snapshot.workspaces
            .find((workspace) => workspace.workspaceId === snapshot.activeWorkspaceId)!
            .resources.find((resource) => resource.kind === 'terminal')!.terminal?.state;
        },
        { timeout: 30000 },
      )
      .toBe('running');
    await expect(panel).toContainText('已连接');
    await expect(panel).toContainText('wsl-sbx-smoke-20261006');
    await expect(panel).toContainText('/home/agent/workspace');
    const connected = await terminalSnapshot(page);
    expect(connected.sandbox).toBe('wsl-sbx-smoke-20261006');
    expect(connected.cwd).toBe('/home/agent/workspace');
    const connectedSnapshot = await workspaceSnapshot(page);
    expect(
      connectedSnapshot.workspaces
        .find((workspace) => workspace.workspaceId === connectedSnapshot.activeWorkspaceId)!
        .resources.find((resource) => resource.kind === 'terminal')!.environmentId,
    ).toBe('sandbox');
    const input = panel.getByLabel('终端输入');
    async function command(text: string) {
      await input.focus();
      // xterm screenReaderMode 使用 keypress 路径；insertText 仅发 input 事件，不能模拟实际键入。
      await input.pressSequentially(text);
      await input.press('Enter');
    }
    const output = async () => ptyText((await terminalSnapshot(page)).output);
    await command('uname -s; node --version; codex --version; pwd');
    await expect.poll(output).toMatch(/^Linux$[\s\S]*^v24\.[^\n]*$[\s\S]*^codex-cli 0\.[^\n]*$[\s\S]*^\/home\/agent\/workspace$/m);
    const guestFile = `${guestDir}/nonce.txt`;
    guestDirectoryMayExist = true;
    await command(
      `mkdir -p '${guestDir}'; cd '${guestDir}'; node -e 'const fs=require("node:fs");const nonce=require("node:crypto").randomUUID();fs.writeFileSync("nonce.txt",nonce);console.log("NONCE="+nonce)'`,
    );
    await expect.poll(output).toMatch(/^NONCE=[0-9a-f-]{36}$/m);
    const capturedNonce = (await output()).match(/^NONCE=([0-9a-f-]{36})$/m)![1]!;
    nonce = capturedNonce;
    await command('pwd');
    await expect.poll(async () => (await output()).split('\n')).toContain(guestDir);
    await command(`if test -e '${canary}'; then echo CANARY_ACCESSIBLE; else echo CANARY_ABSENT; fi`);
    await expect.poll(output).toMatch(/^CANARY_ABSENT$/m);
    await command('stty size');
    await expect.poll(output).toMatch(/^\d+ \d+$/m);
    const initialSize = (await output()).match(/^\d+ \d+$/gm)!.at(-1)!;
    await windowShots(app, page, 'sbx-terminal-live-wide');
    await setWindowSize(app, 1024, 768);

    await command('stty size');
    await expect.poll(async () => (await output()).match(/^\d+ \d+$/gm)?.at(-1)).not.toBe(initialSize);
    await command(`python3 -c 'import os,time;print("FG_PID="+str(os.getpid()),flush=True);time.sleep(60)'`);
    await expect.poll(output).toMatch(/^FG_PID=\d+$/m);
    const foregroundPid = (await output()).match(/^FG_PID=(\d+)$/m)![1]!;
    await input.press('Control+c');
    await command('echo INTERRUPT_OK');
    await expect.poll(output).toMatch(/^INTERRUPT_OK$/m);
    await command(`if kill -0 ${foregroundPid} 2>/dev/null; then echo FG_STILL_RUNNING; else echo FG_EXITED; fi`);
    await expect.poll(output).toMatch(/^FG_EXITED$/m);
    await selectTab('TaskFlow 预览');
    await selectTab('开发终端');
    expect(await output()).toContain(nonce);
    await windowShots(app, page, 'sbx-terminal-live-narrow');
    await workshopNavigate(page, '首页');
    const region = page.getByRole('region', { name: '混合输入' });
    await expect(region.getByLabel('对话执行环境')).toContainText('/home/agent/workspace');
    await region.getByRole('textbox').fill(`使用工具读取文件 ${guestFile}，仅回复文件的完整内容。`);
    await region.getByRole('button', { name: '发送', exact: true }).click();
    await expect(region.locator('.message-agent').last()).toContainText(nonce, { timeout: 120000 });
    await expect(region).not.toContainText('正在等待 Codex 回复', { timeout: 30000 });
    const conversation = await page.evaluate(() => (window as unknown as { studio: StudioApi }).studio.chat.get('conv-personal-default'));
    expect(conversation.state).toBe('idle');
    expect(conversation.error).toBeNull();
    expect(conversation.cleanupPending).toBe(false);
    expect(
      conversation.messages
        .filter((message) => message.role === 'assistant')
        .at(-1)
        ?.text.trim(),
    ).toBe(nonce);
    expect(
      conversation.toolExecutions.some(
        (tool) => tool.command.includes(guestFile) && tool.output.includes(capturedNonce) && tool.exitCode === 0,
      ),
    ).toBe(true);
    await writeFile(path.join(screensDir, 'sbx-live-conversation.json'), JSON.stringify(conversation, null, 2));
    await windowShots(app, page, 'sbx-chat-live-read');
    await workshopNavigate(page, '空间');
    await panel.getByRole('button', { name: '关闭终端', exact: true }).click();
    await expect(panel).toContainText('已关闭，所属进程已确认退出', { timeout: 30000 });
    const terminal = await terminalSnapshot(page);
    expect(terminal.state).toBe('closed');
    expect(terminal.cleanupPending).toBe(false);
    await writeFile(path.join(screensDir, 'sbx-live-terminal.json'), JSON.stringify(terminal, null, 2));
  } catch (error) {
    failures.push(error);
  } finally {
    const closed = await Promise.allSettled(liveApp ? [liveApp.close()] : []);
    const recorded = await Promise.allSettled([
      mkdir(screensDir, { recursive: true }).then(() =>
        writeFile(
          path.join(screensDir, 'sbx-live-owned-cleanup.json'),
          JSON.stringify({
            guestDir,
            nonce,
            guestDirectoryMayExist,
            processCleanupConfirmed: closed.every((result) => result.status === 'fulfilled'),
          }),
        ),
      ),
    ]);
    const clean = `import pathlib,re,shutil,sys
p=pathlib.Path(sys.argv[1])
if p.parent != pathlib.Path('/home/agent/workspace') or not re.fullmatch(r'wsl-ui-[0-9a-f]{8}(?:-[0-9a-f]{4}){3}-[0-9a-f]{12}',p.name): raise ValueError('Unowned cleanup path')
if p.is_symlink(): p.unlink()
elif p.exists(): shutil.rmtree(p)
`;
    const cleaned = await Promise.allSettled([
      rm(canaryDir, { recursive: true, force: true }),
      ...(guestDirectoryMayExist && closed.every((result) => result.status === 'fulfilled')
        ? [
            promisify(execFile)(
              process.env['WSL_SBX_BIN'] ?? '/opt/homebrew/bin/sbx',
              ['exec', process.env['WSL_SBX_NAME'] ?? 'wsl-sbx-smoke-20261006', 'python3', '-I', '-c', clean, guestDir],
              { timeout: 30000 },
            ),
          ]
        : []),
    ]);
    failures.push(...[...closed, ...recorded, ...cleaned].filter((result) => result.status === 'rejected').map((result) => result.reason));
  }
  if (failures.length) throw new AggregateError(failures, '本轮live验收或所属进程/目录清理失败');
});
