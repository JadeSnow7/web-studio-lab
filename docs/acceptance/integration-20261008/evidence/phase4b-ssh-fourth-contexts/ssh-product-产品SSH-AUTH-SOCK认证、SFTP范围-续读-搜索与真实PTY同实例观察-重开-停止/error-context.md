# Instructions

- Following Playwright test failed.
- Explain why, be concise, respect Playwright best practices.
- Provide a snippet of code with the fix, if possible.

# Test info

- Name: ssh-product.spec.ts >> 产品SSH_AUTH_SOCK认证、SFTP范围/续读/搜索与真实PTY同实例观察/重开/停止
- Location: e2e/ssh-product.spec.ts:20:1

# Error details

```
Error: expect(received).toContain(expected) // indexOf

Expected substring: "中文_SSH_d0f42d01-3384-4ce3-901e-be8fc323e896"
Received string:    "·
The default interactive shell is now zsh.·
To update your account to use zsh, please run `chsh -s /bin/zsh`.·
For more details, please visit https://support.apple.com/kb/HT208050.·
PTY> stty -echo; tty; stty size; printf '\\u4e2d\\u6587_SSH_d0f42d01-3384-4ce3-901e-be8fc323e896\\n'·
/dev/ttys006·
41 115·
\\u4e2d\\u6587_SSH_d0f42d01-3384-4ce3-901e-be8fc323e896·
PTY> "

Call Log:
- Timeout 5000ms exceeded while waiting on the predicate
```

# Test source

```ts
  1   | import { expect, test, type Page } from '@playwright/test';
  2   | import { launchApp, workspaceSnapshot, setWindowSize } from './helpers';
  3   | import { sshLoopback } from './fixtures/ssh-loopback';
  4   | import type { WorkbenchResource } from '../packages/protocol/src';
  5   | 
  6   | test.setTimeout(180000);
  7   | async function create(page: Page, kind: 'file' | 'ssh', title: string) {
  8   |   await page.getByRole('button', { name: '新建标签', exact: true }).click();
  9   |   const editor = page.getByRole('dialog', { name: '新建标签' });
  10  |   await editor.getByLabel('标签类型').selectOption(kind);
  11  |   await editor.getByLabel('名称', { exact: true }).fill(title);
  12  |   await editor.getByLabel('资源环境').selectOption('ssh');
  13  |   await editor.getByRole('button', { name: '保存', exact: true }).click();
  14  | }
  15  | async function resource(page: Page, title: string): Promise<WorkbenchResource> {
  16  |   const snapshot = await workspaceSnapshot(page);
  17  |   return snapshot.workspaces.find((w) => w.workspaceId === snapshot.activeWorkspaceId)!.resources.find((r) => r.title === title)!;
  18  | }
  19  | 
  20  | test('产品SSH_AUTH_SOCK认证、SFTP范围/续读/搜索与真实PTY同实例观察/重开/停止', async ({}, info) => {
  21  |   const fixture = await sshLoopback();
  22  |   let app: Awaited<ReturnType<typeof launchApp>>['app'] | undefined;
  23  |   try {
  24  |     const launched = await launchApp({ sshEnvironment: fixture.environment });
  25  |     app = launched.app;
  26  |     const page = launched.page;
  27  |     await create(page, 'file', '回环SSH文件');
  28  |     const files = page.getByRole('region', { name: '只读文件浏览' });
  29  |     await files.getByRole('button', { name: '列出目录', exact: true }).click();
  30  |     await files.getByRole('button', { name: '中文.txt · file', exact: true }).click();
  31  |     const current = files.getByRole('region', { name: '当前文件结果' });
  32  |     await expect(current).toContainText(fixture.nonce);
  33  |     await expect(current).toContainText('远端文件');
  34  |     const file = await resource(page, '回环SSH文件');
  35  |     const first = (await workspaceSnapshot(page)).workspaces[0]!.observations.at(-1)!;
  36  |     expect(first.request.sessionId).toBeNull();
  37  |     expect(first.request.runId).toBeNull();
  38  |     expect(first.request.target).toMatchObject({
  39  |       environmentId: 'ssh',
  40  |       resourceId: file.resourceId,
  41  |       instanceId: file.instanceId,
  42  |       instanceGeneration: file.generation,
  43  |     });
  44  |     expect(first.result).toMatchObject({ source: 'sftp', resource: first.request.target });
  45  |     await files.getByLabel('文件路径').fill('large.txt');
  46  |     await files.getByRole('button', { name: '读取文件', exact: true }).click();
  47  |     await expect(files.getByRole('button', { name: '继续读取', exact: true })).toBeVisible();
  48  |     await files.getByRole('button', { name: '继续读取', exact: true }).click();
  49  |     await expect.poll(async () => (await workspaceSnapshot(page)).workspaces[0]!.observations.at(-1)!.state).toBe('completed');
  50  |     const continuation = (await workspaceSnapshot(page)).workspaces[0]!.observations.at(-1)!;
  51  |     expect(continuation.result).toMatchObject({ source: 'sftp', coverage: { range: { startByte: expect.any(Number) } } });
  52  |     await files.getByLabel('文件路径').fill('.');
  53  |     await files.getByLabel('文件搜索').fill(fixture.nonce);
  54  |     await files.getByRole('button', { name: '搜索文件', exact: true }).click();
  55  |     await expect(files.getByRole('list', { name: '文件搜索结果' })).toContainText('中文.txt');
  56  |     for (const path of ['../outside.txt', 'escape.txt']) {
  57  |       await files.getByLabel('文件路径').fill(path);
  58  |       await files.getByRole('button', { name: '读取文件', exact: true }).click();
  59  |       await expect(current).toContainText('未获授权');
  60  |       expect((await workspaceSnapshot(page)).workspaces[0]!.observations.at(-1)!.result).toMatchObject({ error: 'unauthorized' });
  61  |     }
  62  |     await create(page, 'ssh', '回环真PTY');
  63  |     const terminal = page.getByRole('region', { name: '资源终端' });
  64  |     await terminal.getByRole('button', { name: '连接终端', exact: true }).click();
  65  |     await expect(terminal).toContainText('已连接');
  66  |     expect(fixture.evidence.signedAuthentications).toBeGreaterThan(0);
  67  |     await setWindowSize(app, 1300, 800);
  68  |     await expect.poll(() => fixture.evidence.resize.length).toBeGreaterThan(0);
  69  |     const connected = await resource(page, '回环真PTY');
  70  |     const input = terminal.getByLabel('终端输入');
  71  |     await input.pressSequentially(`stty -echo; tty; stty size; printf '\\u4e2d\\u6587_${fixture.nonce}\\n'`);
  72  |     await input.press('Enter');
> 73  |     await expect.poll(async () => (await resource(page, '回环真PTY')).terminal?.output).toContain(`中文_${fixture.nonce}`);
      |                                                                                      ^ Error: expect(received).toContain(expected) // indexOf
  74  |     expect((await resource(page, '回环真PTY')).terminal!.output).toMatch(/\/dev\/(?:ttys\w+|pts\/\d+)/);
  75  |     const size = fixture.evidence.resize.at(-1);
  76  |     expect(size).toBeDefined();
  77  |     expect((await resource(page, '回环真PTY')).terminal!.output).toContain(`${size!.rows} ${size!.cols}`);
  78  |     await page.getByRole('button', { name: '回环真PTY操作', exact: true }).click();
  79  |     await page.getByRole('menuitem', { name: '关闭标签（保留后台执行）' }).click();
  80  |     await page.getByText('后台资源 / 已关闭标签', { exact: true }).click();
  81  |     await page.getByRole('button', { name: '回环真PTY · 重新打开', exact: true }).click();
  82  |     const reopened = await resource(page, '回环真PTY');
  83  |     expect(reopened.instanceId).toBe(connected.instanceId);
  84  |     expect(reopened.terminal!.sessionId).toBe(connected.terminal!.sessionId);
  85  |     await page.getByRole('navigation', { name: '空间标签' }).getByRole('button', { name: 'Agent 会话', exact: true }).click();
  86  |     const session = page.getByRole('region', { name: 'Agent 会话内容' });
  87  |     await session.getByRole('button', { name: '上下文', exact: true }).click();
  88  |     const observe = session.getByRole('region', { name: '会话统一观察' });
  89  |     await observe.getByLabel('观察来源').selectOption(connected.resourceId);
  90  |     await observe.getByLabel('读取动作').selectOption('terminal.read_output');
  91  |     await observe.getByRole('button', { name: '读取观察', exact: true }).click();
  92  |     await expect(observe.getByRole('region', { name: '当前观察结果' })).toContainText(fixture.nonce);
  93  |     const w = (await workspaceSnapshot(page)).workspaces[0]!;
  94  |     const observation = w.sessions[0]!.observations.at(-1)!;
  95  |     expect(observation.request.target).toMatchObject({
  96  |       environmentId: 'ssh',
  97  |       resourceId: connected.resourceId,
  98  |       instanceId: connected.instanceId,
  99  |       instanceGeneration: connected.generation,
  100 |     });
  101 |     expect(observation.result).toMatchObject({ resource: observation.request.target, source: 'terminal_output' });
  102 |     await page.getByRole('navigation', { name: '空间标签' }).getByRole('button', { name: '回环真PTY', exact: true }).click();
  103 |     await terminal.getByRole('button', { name: '关闭终端', exact: true }).click();
  104 |     await expect.poll(async () => (await resource(page, '回环真PTY')).terminal?.state).toBe('closed');
  105 |     await expect.poll(() => fixture.evidence.ptysCleaned).toBe(1);
  106 |     expect((await resource(page, '回环真PTY')).terminal!.cleanupPending).toBe(false);
  107 |     await terminal.getByRole('button', { name: '连接终端', exact: true }).click();
  108 |     await expect.poll(async () => (await resource(page, '回环真PTY')).terminal?.state).toBe('running');
  109 |     const next = await resource(page, '回环真PTY');
  110 |     expect(next.instanceId).not.toBe(connected.instanceId);
  111 |     expect(next.generation).toBeGreaterThan(connected.generation);
  112 |     fixture.disconnect();
  113 |     await expect.poll(async () => (await resource(page, '回环真PTY')).terminal?.state).toBe('failed');
  114 |     expect((await resource(page, '回环真PTY')).terminal!.cleanupPending).toBe(true);
  115 |     await terminal.getByRole('button', { name: '连接终端', exact: true }).click();
  116 |     await expect(page.locator('.workspace-error')).toContainText('清理未确认');
  117 |     expect(fixture.evidence.ptysStarted).toBe(2);
  118 |   } finally {
  119 |     const failures: unknown[] = [];
  120 |     try {
  121 |       await app?.close();
  122 |     } catch (error) {
  123 |       failures.push(error);
  124 |     }
  125 |     try {
  126 |       await fixture.stop();
  127 |     } catch (error) {
  128 |       failures.push(error);
  129 |     }
  130 |     await info.attach('owned-ssh-evidence', { body: JSON.stringify(fixture.evidence, null, 2), contentType: 'application/json' });
  131 |     if (failures.length) throw new AggregateError(failures, 'Owned product SSH cleanup failed');
  132 |   }
  133 | });
  134 | 
  135 | test('产品错误host pin在认证前拒绝，不启动PTY', async ({}, info) => {
  136 |   const fixture = await sshLoopback();
  137 |   let app: Awaited<ReturnType<typeof launchApp>>['app'] | undefined;
  138 |   try {
  139 |     const launched = await launchApp({ sshEnvironment: { ...fixture.environment, hostKeySha256: '0'.repeat(64) } });
  140 |     app = launched.app;
  141 |     const page = launched.page;
  142 |     await create(page, 'ssh', '错误pin');
  143 |     const terminal = page.getByRole('region', { name: '资源终端' });
  144 |     await terminal.getByRole('button', { name: '连接终端', exact: true }).click();
  145 |     await expect.poll(async () => (await resource(page, '错误pin')).terminal?.state).toBe('failed');
  146 |     expect(fixture.evidence.authentications).toBe(0);
  147 |     expect(fixture.evidence.ptysStarted).toBe(0);
  148 |     expect((await resource(page, '错误pin')).terminal!.cleanupPending).toBe(false);
  149 |     const first = await resource(page, '错误pin');
  150 |     await terminal.getByRole('button', { name: '连接终端', exact: true }).click();
  151 |     await expect
  152 |       .poll(async () => {
  153 |         const next = await resource(page, '错误pin');
  154 |         return next.instanceId !== first.instanceId && next.terminal?.state === 'failed';
  155 |       })
  156 |       .toBe(true);
  157 |     expect((await resource(page, '错误pin')).generation).toBeGreaterThan(first.generation);
  158 |     expect(fixture.evidence.connections).toBeGreaterThanOrEqual(2);
  159 |     expect(fixture.evidence.authentications).toBe(0);
  160 |     expect(fixture.evidence.ptysStarted).toBe(0);
  161 |   } finally {
  162 |     const failures: unknown[] = [];
  163 |     try {
  164 |       await app?.close();
  165 |     } catch (error) {
  166 |       failures.push(error);
  167 |     }
  168 |     try {
  169 |       await fixture.stop();
  170 |     } catch (error) {
  171 |       failures.push(error);
  172 |     }
  173 |     await info.attach('owned-ssh-evidence', { body: JSON.stringify(fixture.evidence, null, 2), contentType: 'application/json' });
```