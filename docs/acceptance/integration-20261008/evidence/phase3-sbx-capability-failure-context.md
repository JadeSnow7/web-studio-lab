# Instructions

- Following Playwright test failed.
- Explain why, be concise, respect Playwright best practices.
- Provide a snippet of code with the fix, if possible.

# Test info

- Name: sbx.spec.ts >> sbx：空间提供独立终端标签，切换时隐藏原生预览
- Location: e2e/sbx.spec.ts:40:1

# Error details

```
Error: expect(locator).toContainText(expected) failed

Locator: getByRole('region', { name: '资源终端' }).getByRole('alert')
Expected substring: "sbx"
Timeout: 5000ms
Error: element(s) not found

Call log:
  - Expect "toContainText" getByRole('region', { name: '资源终端' }).getByRole('alert') with timeout 5000ms
  - waiting for getByRole('region', { name: '资源终端' }).getByRole('alert')

```

```yaml
- banner:
  - button "显示或隐藏 Workshop（⌘B）"
  - button "切换空间":
    - text: ▦
    - strong: TaskFlow
    - text: ⌄
  - button "Codex CLI · 对话不可用"
- complementary "Workshop":
  - navigation "Workshop 导航":
    - button "首页"
    - button "空间"
    - button "资源"
    - button "会话"
    - button "任务"
    - button "取消固定 Workshop" [pressed]
    - button "设置"
  - region "空间导航":
    - strong: TaskFlow
    - text: 空间标签
    - navigation "空间标签":
      - button "TaskFlow 预览"
      - button "TaskFlow 预览操作": ···
      - button "开发终端"
      - button "开发终端操作": ···
      - button "Agent 会话"
      - button "Agent 会话操作": ···
      - group: 后台资源 / 已关闭标签
    - button "新建标签"
    - button "搜索空间或标签"
    - text: 关闭窗格保留标签 · 隐藏继续运行
- main:
  - region "TaskFlow工作现场":
    - button "聚焦窗格 · 开发终端": 开发终端
    - button "左右分屏": ◫
    - button "上下分屏": ⬒
    - button "专注当前窗格": ⤢
    - button "窗格操作": ···
    - region "资源终端":
      - status: sandbox · 工作目录未读取 · 尚未连接
      - button "连接终端"
      - list:
        - listitem
        - listitem
        - listitem
        - listitem
        - listitem
        - listitem
        - listitem
        - listitem
        - listitem
        - listitem
        - listitem
        - listitem
        - listitem
        - listitem
        - listitem
        - listitem
        - listitem
        - listitem
        - listitem
        - listitem
        - listitem
        - listitem
        - listitem
        - listitem
        - listitem
        - listitem
        - listitem
        - listitem
        - listitem
        - listitem
        - listitem
        - listitem
        - listitem
        - listitem
        - listitem
        - listitem
        - listitem
        - listitem
        - listitem
        - listitem
        - listitem
        - listitem
        - listitem
        - listitem
        - listitem
      - textbox "终端输入"
      - paragraph: 输出最多保留 256 Ki 字符 · 隐藏窗格继续运行
- button "通知 · 0 条未读": "0"
- alert:
  - text: "unsupported: 终端环境未配置"
  - button "关闭错误提示": ×
```

# Test source

```ts
  1   | import type { StudioApi } from '../packages/protocol/src';
  2   | import path from 'node:path';
  3   | import { tmpdir } from 'node:os';
  4   | import { mkdtemp, writeFile, rm } from 'node:fs/promises';
  5   | import { randomUUID } from 'node:crypto';
  6   | import { stripVTControlCharacters } from 'node:util';
  7   | import { expect, test, type ElectronApplication, type Page } from '@playwright/test';
  8   | import {
  9   |   launchApp,
  10  |   previewInfo,
  11  |   setWindowSize,
  12  |   windowShots,
  13  |   screensDir,
  14  |   terminalSnapshot,
  15  |   workshopNavigate,
  16  |   workspaceSnapshot,
  17  | } from './helpers';
  18  | 
  19  | // PTY 可发 CRLF 后额外 CR；仅规范化测试读取，服务快照保留原始字节。
  20  | function ptyText(raw: string): string {
  21  |   return stripVTControlCharacters(raw).replace(/\r/g, '');
  22  | }
  23  | 
  24  | let app: ElectronApplication;
  25  | let page: Page;
  26  | test.afterEach(async () => {
  27  |   if (app) await app.close();
  28  | });
  29  | 
  30  | test('PTY 文本：规范化控制字符后只匹配完整输出行', () => {
  31  |   const raw = 'bash$ if test -e path; then echo CANARY_ACCESSIBLE; else echo CANARY_ABSENT; fi\r\n\r\x1b[32mCANARY_ABSENT\x1b[0m\r\n';
  32  |   expect(ptyText(raw)).toMatch(/^CANARY_ABSENT$/m);
  33  |   expect(ptyText('bash$ echo CANARY_ABSENT\r\n')).not.toMatch(/^CANARY_ABSENT$/m);
  34  |   expect(ptyText('bash$ echo FG_EXITED\r\n')).not.toMatch(/^FG_EXITED$/m);
  35  |   expect(ptyText('bash$ printf "NONCE=11111111-1111-1111-1111-111111111111"\r\n')).not.toMatch(/^NONCE=[0-9a-f-]{36}$/m);
  36  |   expect(ptyText('\r\n\rFG_PID=321\r\n')).toMatch(/^FG_PID=321$/m);
  37  |   expect(ptyText('\r\n\r24 80\r\n').match(/^\d+ \d+$/gm)).toEqual(['24 80']);
  38  | });
  39  | 
  40  | test('sbx：空间提供独立终端标签，切换时隐藏原生预览', async () => {
  41  |   ({ app, page } = await launchApp());
  42  |   const terminalTab = page.getByRole('button', { name: '开发终端', exact: true });
  43  |   await expect(terminalTab).toBeVisible({ timeout: 3000 });
  44  |   await terminalTab.click();
  45  |   await expect(terminalTab).toHaveAttribute('aria-current', 'page');
  46  |   await expect(page.getByRole('region', { name: '资源终端' })).toBeVisible();
  47  |   expect((await previewInfo(app)).visible).toBe(false);
  48  |   const panel = page.getByRole('region', { name: '资源终端' });
  49  |   await panel.getByRole('button', { name: '连接终端', exact: true }).click();
> 50  |   await expect(panel.getByRole('alert')).toContainText('sbx');
      |                                          ^ Error: expect(locator).toContainText(expected) failed
  51  |   await expect(panel).toContainText('连接失败');
  52  | });
  53  | 
  54  | test('sbx：对话显示执行来源，连接失败不允许发送', async () => {
  55  |   ({ app, page } = await launchApp());
  56  |   await workshopNavigate(page, '首页');
  57  |   const region = page.getByRole('region', { name: '混合输入' });
  58  |   await expect(region.getByLabel('对话执行环境')).toBeVisible({ timeout: 3000 });
  59  |   await expect(region.getByLabel('对话执行环境')).toContainText('sbx');
  60  |   await region.getByRole('textbox').fill('连接不可用时保留草稿');
  61  |   await region.getByRole('button', { name: '发送', exact: true }).click({ force: true });
  62  |   await expect(region.getByRole('textbox')).toHaveValue('连接不可用时保留草稿');
  63  |   await expect(region.locator('.message-user')).toHaveCount(0);
  64  | });
  65  | 
  66  | test('空间会话：执行器不可用时保留草稿并记录失败运行', async () => {
  67  |   ({ app, page } = await launchApp());
  68  |   await page.getByRole('navigation', { name: '空间标签' }).getByRole('button', { name: 'Agent 会话', exact: true }).click();
  69  |   const region = page.getByRole('region', { name: 'Agent 会话内容' });
  70  |   await region.getByRole('textbox', { name: '会话消息', exact: true }).fill('执行器不可用时不能清空这份空间草稿');
  71  |   await region.getByRole('button', { name: '发送', exact: true }).click();
  72  |   await expect.poll(async () => (await workspaceSnapshot(page)).workspaces[0]!.runs.at(-1)?.state).toBe('failed');
  73  |   await expect(region.getByRole('textbox', { name: '会话消息', exact: true })).toHaveValue('执行器不可用时不能清空这份空间草稿');
  74  |   expect((await workspaceSnapshot(page)).workspaces[0]!.sessions[0]!.draft).toBe('执行器不可用时不能清空这份空间草稿');
  75  | });
  76  | 
  77  | test('fixture：终端持久 cwd、Ctrl-C、resize、切标签保留与确认关闭', async () => {
  78  |   ({ app, page } = await launchApp({ sbxBin: new URL('./fixtures/sbx.mjs', import.meta.url).pathname }));
  79  |   await page.getByRole('button', { name: '开发终端', exact: true }).click();
  80  |   const panel = page.getByRole('region', { name: '资源终端' });
  81  |   await panel.getByRole('button', { name: '连接终端', exact: true }).click();
  82  |   await expect(panel).toContainText('fixture-sandbox');
  83  |   await expect(panel).toContainText('已连接');
  84  |   const input = panel.getByLabel('终端输入');
  85  |   await input.focus();
  86  |   await input.pressSequentially('cd /tmp');
  87  |   await input.press('Enter');
  88  |   await input.pressSequentially('pwd');
  89  |   await input.press('Enter');
  90  |   await expect(panel.locator('.xterm')).toContainText('/tmp');
  91  |   await input.pressSequentially('printf marker');
  92  |   await input.press('Enter');
  93  |   await expect(panel.locator('.xterm')).toContainText('TERMINAL_MARKER');
  94  |   await page.getByRole('button', { name: 'TaskFlow 预览', exact: true }).click();
  95  |   await page.getByRole('button', { name: '开发终端', exact: true }).click();
  96  |   await expect(panel.locator('.xterm')).toContainText('TERMINAL_MARKER');
  97  |   await input.focus();
  98  |   await input.pressSequentially('sleep 60');
  99  |   await input.press('Enter');
  100 |   await input.press('Control+c');
  101 |   await expect(panel.locator('.xterm')).toContainText('^C');
  102 |   await setWindowSize(app, 1024, 768);
  103 | 
  104 |   await input.focus();
  105 |   await input.pressSequentially('stty size');
  106 |   await input.press('Enter');
  107 |   const snapshot = await terminalSnapshot(page);
  108 |   expect(ptyText(snapshot.output)).toMatch(/^\d+ \d+$/m);
  109 |   await windowShots(app, page, 'sbx-terminal-fixture-narrow');
  110 |   await panel.getByRole('button', { name: '关闭终端', exact: true }).click();
  111 |   await expect(panel).toContainText('已关闭，所属进程已确认退出');
  112 |   expect((await terminalSnapshot(page)).state).toBe('closed');
  113 | });
  114 | 
  115 | test('fixture：活动终端直接关闭应用需确认 Electron 进程退出', async () => {
  116 |   test.setTimeout(30000);
  117 |   const { app: closingApp, page: closingPage } = await launchApp({ sbxBin: new URL('./fixtures/sbx.mjs', import.meta.url).pathname });
  118 |   const child = closingApp.process();
  119 |   let exited = false;
  120 |   const processExit = new Promise<{ code: number | null; signal: NodeJS.Signals | null }>((resolve) => {
  121 |     child.once('exit', (code, signal) => {
  122 |       exited = true;
  123 |       resolve({ code, signal });
  124 |     });
  125 |   });
  126 |   let stderr = '';
  127 |   child.stderr?.on('data', (chunk: Buffer) => {
  128 |     stderr = (stderr + chunk.toString()).slice(-12000);
  129 |   });
  130 |   let timer: ReturnType<typeof setTimeout> | undefined;
  131 |   try {
  132 |     await closingPage.getByRole('button', { name: '开发终端', exact: true }).click();
  133 |     const panel = closingPage.getByRole('region', { name: '资源终端' });
  134 |     await panel.getByRole('button', { name: '连接终端', exact: true }).click();
  135 |     await expect(panel).toContainText('已连接');
  136 |     const terminal = await terminalSnapshot(closingPage);
  137 |     expect(terminal.state).toBe('running');
  138 |     expect(terminal.cleanupPending).toBe(true);
  139 |     // 不预先关闭 PTY：直接覆盖应用关闭时的远端清理路径。
  140 |     const outcome = await Promise.race([
  141 |       closingApp.close().then(() => processExit),
  142 |       new Promise<never>((_, reject) => {
  143 |         timer = setTimeout(() => reject(new Error(`活动终端 app.close 在 12 秒内未完成；Electron stderr:\n${stderr}`)), 12000);
  144 |       }),
  145 |     ]);
  146 |     expect(outcome.signal).toBeNull();
  147 |     expect(outcome.code).toBe(0);
  148 |   } finally {
  149 |     if (timer) clearTimeout(timer);
  150 |     if (!exited) {
```