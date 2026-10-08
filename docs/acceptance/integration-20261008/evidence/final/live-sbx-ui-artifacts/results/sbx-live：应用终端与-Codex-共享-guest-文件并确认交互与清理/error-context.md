# Instructions

- Following Playwright test failed.
- Explain why, be concise, respect Playwright best practices.
- Provide a snippet of code with the fix, if possible.

# Test info

- Name: sbx.spec.ts >> live：应用终端与 Codex 共享 guest 文件并确认交互与清理
- Location: e2e/sbx.spec.ts:159:1

# Error details

```
AggregateError: 本轮live验收或所属进程/目录清理失败
```

```
Error: expect(locator).toContainText(expected) failed

Locator: getByRole('region', { name: '资源终端' })
Expected substring: "wsl-sbx-smoke-20261006"
Received string:    "sandbox · 工作目录未读取 · 尚未连接连接终端                                                                              输出最多保留 256 Ki 字符 · 隐藏窗格继续运行"
Timeout: 30000ms

Call log:
  - Expect "toContainText" getByRole('region', { name: '资源终端' }) with timeout 30000ms
  - waiting for getByRole('region', { name: '资源终端' })
    5 × locator resolved to <section aria-label="资源终端" class="terminal-panel">…</section>
      - unexpected value "sandbox · 工作目录未读取 · 尚未连接连接终端环境能力尚未核对或终端未配置                                 输出最多保留 256 Ki 字符 · 隐藏窗格继续运行"
    13 × locator resolved to <section aria-label="资源终端" class="terminal-panel">…</section>
       - unexpected value "sandbox · 工作目录未读取 · 尚未连接连接终端环境能力尚未核对或终端未配置                                                                            输出最多保留 256 Ki 字符 · 隐藏窗格继续运行"
    13 × locator resolved to <section aria-label="资源终端" class="terminal-panel">…</section>
       - unexpected value "sandbox · 工作目录未读取 · 尚未连接连接终端正在检查 sbx…                                                                            输出最多保留 256 Ki 字符 · 隐藏窗格继续运行"
    32 × locator resolved to <section aria-label="资源终端" class="terminal-panel">…</section>
       - unexpected value "sandbox · 工作目录未读取 · 尚未连接连接终端                                                                              输出最多保留 256 Ki 字符 · 隐藏窗格继续运行"

```

```yaml
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
```

# Test source

```ts
  75  |   await expect(region.getByRole('textbox', { name: '会话消息', exact: true })).toHaveValue('执行器不可用时不能清空这份空间草稿');
  76  |   expect((await workspaceSnapshot(page)).workspaces[0]!.sessions[0]!.draft).toBe('执行器不可用时不能清空这份空间草稿');
  77  | });
  78  | 
  79  | test('fixture：终端持久 cwd、Ctrl-C、resize、切标签保留与确认关闭', async () => {
  80  |   ({ app, page } = await launchApp({ sbxBin: new URL('./fixtures/sbx.mjs', import.meta.url).pathname }));
  81  |   await page.getByRole('button', { name: '开发终端', exact: true }).click();
  82  |   const panel = page.getByRole('region', { name: '资源终端' });
  83  |   await panel.getByRole('button', { name: '连接终端', exact: true }).click();
  84  |   await expect(panel).toContainText('fixture-sandbox');
  85  |   await expect(panel).toContainText('已连接');
  86  |   const input = panel.getByLabel('终端输入');
  87  |   await input.focus();
  88  |   await input.pressSequentially('cd /tmp');
  89  |   await input.press('Enter');
  90  |   await input.pressSequentially('pwd');
  91  |   await input.press('Enter');
  92  |   await expect(panel.locator('.xterm')).toContainText('/tmp');
  93  |   await input.pressSequentially('printf marker');
  94  |   await input.press('Enter');
  95  |   await expect(panel.locator('.xterm')).toContainText('TERMINAL_MARKER');
  96  |   await page.getByRole('button', { name: 'TaskFlow 预览', exact: true }).click();
  97  |   await page.getByRole('button', { name: '开发终端', exact: true }).click();
  98  |   await expect(panel.locator('.xterm')).toContainText('TERMINAL_MARKER');
  99  |   await input.focus();
  100 |   await input.pressSequentially('sleep 60');
  101 |   await input.press('Enter');
  102 |   await input.press('Control+c');
  103 |   await expect(panel.locator('.xterm')).toContainText('^C');
  104 |   await setWindowSize(app, 1024, 768);
  105 | 
  106 |   await input.focus();
  107 |   await input.pressSequentially('stty size');
  108 |   await input.press('Enter');
  109 |   const snapshot = await terminalSnapshot(page);
  110 |   expect(ptyText(snapshot.output)).toMatch(/^\d+ \d+$/m);
  111 |   await windowShots(app, page, 'sbx-terminal-fixture-narrow');
  112 |   await panel.getByRole('button', { name: '关闭终端', exact: true }).click();
  113 |   await expect(panel).toContainText('已关闭，所属进程已确认退出');
  114 |   expect((await terminalSnapshot(page)).state).toBe('closed');
  115 | });
  116 | 
  117 | test('fixture：活动终端直接关闭应用需确认 Electron 进程退出', async () => {
  118 |   test.setTimeout(30000);
  119 |   const { app: closingApp, page: closingPage } = await launchApp({ sbxBin: new URL('./fixtures/sbx.mjs', import.meta.url).pathname });
  120 |   const child = closingApp.process();
  121 |   let exited = false;
  122 |   const processExit = new Promise<{ code: number | null; signal: NodeJS.Signals | null }>((resolve) => {
  123 |     child.once('exit', (code, signal) => {
  124 |       exited = true;
  125 |       resolve({ code, signal });
  126 |     });
  127 |   });
  128 |   let stderr = '';
  129 |   child.stderr?.on('data', (chunk: Buffer) => {
  130 |     stderr = (stderr + chunk.toString()).slice(-12000);
  131 |   });
  132 |   let timer: ReturnType<typeof setTimeout> | undefined;
  133 |   try {
  134 |     await closingPage.getByRole('button', { name: '开发终端', exact: true }).click();
  135 |     const panel = closingPage.getByRole('region', { name: '资源终端' });
  136 |     await panel.getByRole('button', { name: '连接终端', exact: true }).click();
  137 |     await expect(panel).toContainText('已连接');
  138 |     const terminal = await terminalSnapshot(closingPage);
  139 |     expect(terminal.state).toBe('running');
  140 |     expect(terminal.cleanupPending).toBe(true);
  141 |     // 不预先关闭 PTY：直接覆盖应用关闭时的远端清理路径。
  142 |     const outcome = await Promise.race([
  143 |       closingApp.close().then(() => processExit),
  144 |       new Promise<never>((_, reject) => {
  145 |         timer = setTimeout(() => reject(new Error(`活动终端 app.close 在 12 秒内未完成；Electron stderr:\n${stderr}`)), 12000);
  146 |       }),
  147 |     ]);
  148 |     expect(outcome.signal).toBeNull();
  149 |     expect(outcome.code).toBe(0);
  150 |   } finally {
  151 |     if (timer) clearTimeout(timer);
  152 |     if (!exited) {
  153 |       console.error('失败收尾：仅强制结束本用例创建的 Electron 主进程；此操作不作为关闭成功证据。', stderr);
  154 |       child.kill('SIGKILL');
  155 |     }
  156 |   }
  157 | });
  158 | 
  159 | test('live：应用终端与 Codex 共享 guest 文件并确认交互与清理', async () => {
  160 |   test.skip(process.env['WSL_LIVE_SBX'] !== '1', '真实 sbx 与模型须显式启用 WSL_LIVE_SBX=1');
  161 |   test.setTimeout(240000);
  162 |   const canaryDir = await mkdtemp(path.join(tmpdir(), 'wsl-sbx-ui-canary-'));
  163 |   const canary = path.join(canaryDir, 'host-only.txt');
  164 |   await writeFile(canary, 'host-only test canary');
  165 |   const guestDir = `/home/agent/workspace/wsl-ui-${randomUUID()}`;
  166 |   let guestDirectoryMayExist = false;
  167 |   let liveApp: ElectronApplication | null = null;
  168 |   let nonce: string | null = null;
  169 |   const failures: unknown[] = [];
  170 |   try {
  171 |     ({ app, page } = await launchApp({ live: true }));
  172 |     liveApp = app;
  173 |     await page.getByRole('button', { name: '开发终端', exact: true }).click();
  174 |     const panel = page.getByRole('region', { name: '资源终端' });
> 175 |     await expect(panel).toContainText('wsl-sbx-smoke-20261006', { timeout: 30000 });
      |                         ^ Error: expect(locator).toContainText(expected) failed
  176 |     await panel.getByRole('button', { name: '连接终端', exact: true }).click();
  177 |     await expect(panel).toContainText('已连接', { timeout: 30000 });
  178 |     const input = panel.getByLabel('终端输入');
  179 |     async function command(text: string) {
  180 |       await input.focus();
  181 |       // xterm screenReaderMode 使用 keypress 路径；insertText 仅发 input 事件，不能模拟实际键入。
  182 |       await input.pressSequentially(text);
  183 |       await input.press('Enter');
  184 |     }
  185 |     const output = async () => ptyText((await terminalSnapshot(page)).output);
  186 |     await command('uname -s; node --version; codex --version; pwd');
  187 |     await expect.poll(output).toMatch(/^Linux$[\s\S]*^v24\.[^\n]*$[\s\S]*^codex-cli 0\.[^\n]*$[\s\S]*^\/home\/agent\/workspace$/m);
  188 |     const guestFile = `${guestDir}/nonce.txt`;
  189 |     guestDirectoryMayExist = true;
  190 |     await command(
  191 |       `mkdir -p '${guestDir}'; cd '${guestDir}'; node -e 'const fs=require("node:fs");const nonce=require("node:crypto").randomUUID();fs.writeFileSync("nonce.txt",nonce);console.log("NONCE="+nonce)'`,
  192 |     );
  193 |     await expect.poll(output).toMatch(/^NONCE=[0-9a-f-]{36}$/m);
  194 |     const capturedNonce = (await output()).match(/^NONCE=([0-9a-f-]{36})$/m)![1]!;
  195 |     nonce = capturedNonce;
  196 |     await command('pwd');
  197 |     await expect.poll(async () => (await output()).split('\n')).toContain(guestDir);
  198 |     await command(`if test -e '${canary}'; then echo CANARY_ACCESSIBLE; else echo CANARY_ABSENT; fi`);
  199 |     await expect.poll(output).toMatch(/^CANARY_ABSENT$/m);
  200 |     await command('stty size');
  201 |     await expect.poll(output).toMatch(/^\d+ \d+$/m);
  202 |     const initialSize = (await output()).match(/^\d+ \d+$/gm)!.at(-1)!;
  203 |     await windowShots(app, page, 'sbx-terminal-live-wide');
  204 |     await setWindowSize(app, 1024, 768);
  205 | 
  206 |     await command('stty size');
  207 |     await expect.poll(async () => (await output()).match(/^\d+ \d+$/gm)?.at(-1)).not.toBe(initialSize);
  208 |     await command(`python3 -c 'import os,time;print("FG_PID="+str(os.getpid()),flush=True);time.sleep(60)'`);
  209 |     await expect.poll(output).toMatch(/^FG_PID=\d+$/m);
  210 |     const foregroundPid = (await output()).match(/^FG_PID=(\d+)$/m)![1]!;
  211 |     await input.press('Control+c');
  212 |     await command('echo INTERRUPT_OK');
  213 |     await expect.poll(output).toMatch(/^INTERRUPT_OK$/m);
  214 |     await command(`if kill -0 ${foregroundPid} 2>/dev/null; then echo FG_STILL_RUNNING; else echo FG_EXITED; fi`);
  215 |     await expect.poll(output).toMatch(/^FG_EXITED$/m);
  216 |     await page.getByRole('button', { name: 'TaskFlow 预览', exact: true }).click();
  217 |     await page.getByRole('button', { name: '开发终端', exact: true }).click();
  218 |     expect(await output()).toContain(nonce);
  219 |     await windowShots(app, page, 'sbx-terminal-live-narrow');
  220 |     await workshopNavigate(page, '首页');
  221 |     const region = page.getByRole('region', { name: '混合输入' });
  222 |     await expect(region.getByLabel('对话执行环境')).toContainText('/home/agent/workspace');
  223 |     await region.getByRole('textbox').fill(`使用工具读取文件 ${guestFile}，仅回复文件的完整内容。`);
  224 |     await region.getByRole('button', { name: '发送', exact: true }).click();
  225 |     await expect(region.locator('.message-agent').last()).toContainText(nonce, { timeout: 120000 });
  226 |     await expect(region).not.toContainText('正在等待 Codex 回复', { timeout: 30000 });
  227 |     const conversation = await page.evaluate(() => (window as unknown as { studio: StudioApi }).studio.chat.get('conv-personal-default'));
  228 |     expect(conversation.state).toBe('idle');
  229 |     expect(conversation.error).toBeNull();
  230 |     expect(conversation.cleanupPending).toBe(false);
  231 |     expect(
  232 |       conversation.messages
  233 |         .filter((message) => message.role === 'assistant')
  234 |         .at(-1)
  235 |         ?.text.trim(),
  236 |     ).toBe(nonce);
  237 |     expect(
  238 |       conversation.toolExecutions.some(
  239 |         (tool) => tool.command.includes(guestFile) && tool.output.includes(capturedNonce) && tool.exitCode === 0,
  240 |       ),
  241 |     ).toBe(true);
  242 |     await writeFile(path.join(screensDir, 'sbx-live-conversation.json'), JSON.stringify(conversation, null, 2));
  243 |     await windowShots(app, page, 'sbx-chat-live-read');
  244 |     await workshopNavigate(page, '空间');
  245 |     await panel.getByRole('button', { name: '关闭终端', exact: true }).click();
  246 |     await expect(panel).toContainText('已关闭，所属进程已确认退出', { timeout: 30000 });
  247 |     const terminal = await terminalSnapshot(page);
  248 |     expect(terminal.state).toBe('closed');
  249 |     expect(terminal.cleanupPending).toBe(false);
  250 |     await writeFile(path.join(screensDir, 'sbx-live-terminal.json'), JSON.stringify(terminal, null, 2));
  251 |   } catch (error) {
  252 |     failures.push(error);
  253 |   } finally {
  254 |     const closed = await Promise.allSettled(liveApp ? [liveApp.close()] : []);
  255 |     const recorded = await Promise.allSettled([
  256 |       mkdir(screensDir, { recursive: true }).then(() =>
  257 |         writeFile(
  258 |           path.join(screensDir, 'sbx-live-owned-cleanup.json'),
  259 |           JSON.stringify({
  260 |             guestDir,
  261 |             nonce,
  262 |             guestDirectoryMayExist,
  263 |             processCleanupConfirmed: closed.every((result) => result.status === 'fulfilled'),
  264 |           }),
  265 |         ),
  266 |       ),
  267 |     ]);
  268 |     const clean = `import pathlib,re,shutil,sys
  269 | p=pathlib.Path(sys.argv[1])
  270 | if p.parent != pathlib.Path('/home/agent/workspace') or not re.fullmatch(r'wsl-ui-[0-9a-f]{8}(?:-[0-9a-f]{4}){3}-[0-9a-f]{12}',p.name): raise ValueError('Unowned cleanup path')
  271 | if p.is_symlink(): p.unlink()
  272 | elif p.exists(): shutil.rmtree(p)
  273 | `;
  274 |     const cleaned = await Promise.allSettled([
  275 |       rm(canaryDir, { recursive: true, force: true }),
```