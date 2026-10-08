# Instructions

- Following Playwright test failed.
- Explain why, be concise, respect Playwright best practices.
- Provide a snippet of code with the fix, if possible.

# Test info

- Name: sbx.spec.ts >> fixture：终端持久 cwd、Ctrl-C、resize、切标签保留与确认关闭
- Location: e2e/sbx.spec.ts:78:1

# Error details

```
TimeoutError: locator.click: Timeout 30000ms exceeded.
Call log:
  - waiting for getByRole('region', { name: '资源终端' }).getByRole('button', { name: '连接终端', exact: true })
    - locator resolved to <button disabled class="btn" type="button">连接终端</button>
  - attempting click action
    2 × waiting for element to be visible, enabled and stable
      - element is not enabled
    - retrying click action
    - waiting 20ms
    2 × waiting for element to be visible, enabled and stable
      - element is not enabled
    - retrying click action
      - waiting 100ms
    56 × waiting for element to be visible, enabled and stable
       - element is not enabled
     - retrying click action
       - waiting 500ms

```

# Page snapshot

```yaml
- generic [ref=e3]:
  - banner [ref=e4]:
    - button "显示或隐藏 Workshop（⌘B）" [ref=e5] [cursor=pointer]
    - button "切换空间" [ref=e8]:
      - generic [ref=e9]: ▦
      - strong [ref=e10]: TaskFlow
      - generic [ref=e11]: ⌄
    - button "Codex CLI · 对话已连接" [ref=e13] [cursor=pointer]
  - generic [ref=e15]:
    - complementary "Workshop" [ref=e16]:
      - navigation "Workshop 导航" [ref=e17]:
        - button "首页" [ref=e18] [cursor=pointer]
        - button "空间" [ref=e21] [cursor=pointer]
        - button "资源" [ref=e27] [cursor=pointer]
        - button "会话" [ref=e30] [cursor=pointer]
        - button "任务" [ref=e33] [cursor=pointer]
        - button "取消固定 Workshop" [pressed] [ref=e37] [cursor=pointer]
        - button "设置" [ref=e40] [cursor=pointer]
      - region "空间导航" [ref=e44]:
        - generic [ref=e45]:
          - strong [ref=e46]: TaskFlow
          - generic [ref=e47]: 空间标签
        - navigation "空间标签" [ref=e48]:
          - generic [ref=e49]:
            - button "TaskFlow 预览" [ref=e50]
            - button "TaskFlow 预览操作" [ref=e56] [cursor=pointer]: ···
          - generic [ref=e57]:
            - button "开发终端" [ref=e58]
            - button "开发终端操作" [ref=e64] [cursor=pointer]: ···
          - generic [ref=e65]:
            - button "Agent 会话" [ref=e66]
            - button "Agent 会话操作" [ref=e71] [cursor=pointer]: ···
          - group [ref=e72]:
            - generic "后台资源 / 已关闭标签" [ref=e73]
        - button "新建标签" [ref=e74] [cursor=pointer]
        - generic [ref=e77]:
          - button "搜索空间或标签" [ref=e78] [cursor=pointer]
          - generic [ref=e79]: 关闭窗格保留标签 · 隐藏继续运行
    - main [ref=e80]:
      - region "TaskFlow工作现场" [ref=e83]:
        - generic [ref=e85]:
          - button "聚焦窗格 · 开发终端" [ref=e86]:
            - generic [ref=e90]: 开发终端
          - generic [ref=e91]:
            - button "左右分屏" [ref=e92] [cursor=pointer]: ◫
            - button "上下分屏" [ref=e93] [cursor=pointer]: ⬒
            - button "专注当前窗格" [ref=e94] [cursor=pointer]: ⤢
            - button "窗格操作" [ref=e95] [cursor=pointer]: ···
        - region "资源终端" [ref=e96]:
          - generic [ref=e97]:
            - status [ref=e98]: sandbox · 工作目录未读取 · 尚未连接
            - button "连接终端" [disabled] [ref=e99]
          - status [ref=e100]: 正在检查 sbx…
          - generic [ref=e102]:
            - generic:
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
            - generic [ref=e104]:
              - generic:
                - textbox "终端输入" [active]
          - paragraph [ref=e105]: 输出最多保留 256 Ki 字符 · 隐藏窗格继续运行
    - button "通知 · 0 条未读" [ref=e106] [cursor=pointer]:
      - generic [ref=e109]: "0"
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
  49  |   await expect(panel).toContainText('sbx');
  50  |   await expect(panel.getByRole('button', { name: '连接终端', exact: true })).toBeDisabled();
  51  |   expect((await terminalSnapshot(page)).state).toBe('idle');
  52  |   expect((await terminalSnapshot(page)).sessionId).toBeNull();
  53  | });
  54  | 
  55  | test('sbx：对话显示执行来源，连接失败不允许发送', async () => {
  56  |   ({ app, page } = await launchApp());
  57  |   await workshopNavigate(page, '首页');
  58  |   const region = page.getByRole('region', { name: '混合输入' });
  59  |   await expect(region.getByLabel('对话执行环境')).toBeVisible({ timeout: 3000 });
  60  |   await expect(region.getByLabel('对话执行环境')).toContainText('sbx');
  61  |   await region.getByRole('textbox').fill('连接不可用时保留草稿');
  62  |   await region.getByRole('button', { name: '发送', exact: true }).click({ force: true });
  63  |   await expect(region.getByRole('textbox')).toHaveValue('连接不可用时保留草稿');
  64  |   await expect(region.locator('.message-user')).toHaveCount(0);
  65  | });
  66  | 
  67  | test('空间会话：执行器不可用时保留草稿并记录失败运行', async () => {
  68  |   ({ app, page } = await launchApp());
  69  |   await page.getByRole('navigation', { name: '空间标签' }).getByRole('button', { name: 'Agent 会话', exact: true }).click();
  70  |   const region = page.getByRole('region', { name: 'Agent 会话内容' });
  71  |   await region.getByRole('textbox', { name: '会话消息', exact: true }).fill('执行器不可用时不能清空这份空间草稿');
  72  |   await region.getByRole('button', { name: '发送', exact: true }).click();
  73  |   await expect.poll(async () => (await workspaceSnapshot(page)).workspaces[0]!.runs.at(-1)?.state).toBe('failed');
  74  |   await expect(region.getByRole('textbox', { name: '会话消息', exact: true })).toHaveValue('执行器不可用时不能清空这份空间草稿');
  75  |   expect((await workspaceSnapshot(page)).workspaces[0]!.sessions[0]!.draft).toBe('执行器不可用时不能清空这份空间草稿');
  76  | });
  77  | 
  78  | test('fixture：终端持久 cwd、Ctrl-C、resize、切标签保留与确认关闭', async () => {
  79  |   ({ app, page } = await launchApp({ sbxBin: new URL('./fixtures/sbx.mjs', import.meta.url).pathname }));
  80  |   await page.getByRole('button', { name: '开发终端', exact: true }).click();
  81  |   const panel = page.getByRole('region', { name: '资源终端' });
> 82  |   await panel.getByRole('button', { name: '连接终端', exact: true }).click();
      |                                                                  ^ TimeoutError: locator.click: Timeout 30000ms exceeded.
  83  |   await expect(panel).toContainText('fixture-sandbox');
  84  |   await expect(panel).toContainText('已连接');
  85  |   const input = panel.getByLabel('终端输入');
  86  |   await input.focus();
  87  |   await input.pressSequentially('cd /tmp');
  88  |   await input.press('Enter');
  89  |   await input.pressSequentially('pwd');
  90  |   await input.press('Enter');
  91  |   await expect(panel.locator('.xterm')).toContainText('/tmp');
  92  |   await input.pressSequentially('printf marker');
  93  |   await input.press('Enter');
  94  |   await expect(panel.locator('.xterm')).toContainText('TERMINAL_MARKER');
  95  |   await page.getByRole('button', { name: 'TaskFlow 预览', exact: true }).click();
  96  |   await page.getByRole('button', { name: '开发终端', exact: true }).click();
  97  |   await expect(panel.locator('.xterm')).toContainText('TERMINAL_MARKER');
  98  |   await input.focus();
  99  |   await input.pressSequentially('sleep 60');
  100 |   await input.press('Enter');
  101 |   await input.press('Control+c');
  102 |   await expect(panel.locator('.xterm')).toContainText('^C');
  103 |   await setWindowSize(app, 1024, 768);
  104 | 
  105 |   await input.focus();
  106 |   await input.pressSequentially('stty size');
  107 |   await input.press('Enter');
  108 |   const snapshot = await terminalSnapshot(page);
  109 |   expect(ptyText(snapshot.output)).toMatch(/^\d+ \d+$/m);
  110 |   await windowShots(app, page, 'sbx-terminal-fixture-narrow');
  111 |   await panel.getByRole('button', { name: '关闭终端', exact: true }).click();
  112 |   await expect(panel).toContainText('已关闭，所属进程已确认退出');
  113 |   expect((await terminalSnapshot(page)).state).toBe('closed');
  114 | });
  115 | 
  116 | test('fixture：活动终端直接关闭应用需确认 Electron 进程退出', async () => {
  117 |   test.setTimeout(30000);
  118 |   const { app: closingApp, page: closingPage } = await launchApp({ sbxBin: new URL('./fixtures/sbx.mjs', import.meta.url).pathname });
  119 |   const child = closingApp.process();
  120 |   let exited = false;
  121 |   const processExit = new Promise<{ code: number | null; signal: NodeJS.Signals | null }>((resolve) => {
  122 |     child.once('exit', (code, signal) => {
  123 |       exited = true;
  124 |       resolve({ code, signal });
  125 |     });
  126 |   });
  127 |   let stderr = '';
  128 |   child.stderr?.on('data', (chunk: Buffer) => {
  129 |     stderr = (stderr + chunk.toString()).slice(-12000);
  130 |   });
  131 |   let timer: ReturnType<typeof setTimeout> | undefined;
  132 |   try {
  133 |     await closingPage.getByRole('button', { name: '开发终端', exact: true }).click();
  134 |     const panel = closingPage.getByRole('region', { name: '资源终端' });
  135 |     await panel.getByRole('button', { name: '连接终端', exact: true }).click();
  136 |     await expect(panel).toContainText('已连接');
  137 |     const terminal = await terminalSnapshot(closingPage);
  138 |     expect(terminal.state).toBe('running');
  139 |     expect(terminal.cleanupPending).toBe(true);
  140 |     // 不预先关闭 PTY：直接覆盖应用关闭时的远端清理路径。
  141 |     const outcome = await Promise.race([
  142 |       closingApp.close().then(() => processExit),
  143 |       new Promise<never>((_, reject) => {
  144 |         timer = setTimeout(() => reject(new Error(`活动终端 app.close 在 12 秒内未完成；Electron stderr:\n${stderr}`)), 12000);
  145 |       }),
  146 |     ]);
  147 |     expect(outcome.signal).toBeNull();
  148 |     expect(outcome.code).toBe(0);
  149 |   } finally {
  150 |     if (timer) clearTimeout(timer);
  151 |     if (!exited) {
  152 |       console.error('失败收尾：仅强制结束本用例创建的 Electron 主进程；此操作不作为关闭成功证据。', stderr);
  153 |       child.kill('SIGKILL');
  154 |     }
  155 |   }
  156 | });
  157 | 
  158 | test('live：应用终端与 Codex 共享 guest 文件并确认交互与清理', async () => {
  159 |   test.skip(process.env['WSL_LIVE_SBX'] !== '1', '真实 sbx 与模型须显式启用 WSL_LIVE_SBX=1');
  160 |   test.setTimeout(240000);
  161 |   const canaryDir = await mkdtemp(path.join(tmpdir(), 'wsl-sbx-ui-canary-'));
  162 |   const canary = path.join(canaryDir, 'host-only.txt');
  163 |   await writeFile(canary, 'host-only test canary');
  164 |   try {
  165 |     ({ app, page } = await launchApp({ live: true }));
  166 |     await page.getByRole('button', { name: '开发终端', exact: true }).click();
  167 |     const panel = page.getByRole('region', { name: '资源终端' });
  168 |     await expect(panel).toContainText('wsl-sbx-smoke-20261006', { timeout: 30000 });
  169 |     await panel.getByRole('button', { name: '连接终端', exact: true }).click();
  170 |     await expect(panel).toContainText('已连接', { timeout: 30000 });
  171 |     const input = panel.getByLabel('终端输入');
  172 |     async function command(text: string) {
  173 |       await input.focus();
  174 |       // xterm screenReaderMode 使用 keypress 路径；insertText 仅发 input 事件，不能模拟实际键入。
  175 |       await input.pressSequentially(text);
  176 |       await input.press('Enter');
  177 |     }
  178 |     const output = async () => ptyText((await terminalSnapshot(page)).output);
  179 |     await command('uname -s; node --version; codex --version; pwd');
  180 |     await expect.poll(output).toMatch(/^Linux$[\s\S]*^v24\.[^\n]*$[\s\S]*^codex-cli 0\.[^\n]*$[\s\S]*^\/home\/agent\/workspace$/m);
  181 |     const guestDir = `/home/agent/workspace/wsl-ui-${randomUUID()}`;
  182 |     const guestFile = `${guestDir}/nonce.txt`;
```