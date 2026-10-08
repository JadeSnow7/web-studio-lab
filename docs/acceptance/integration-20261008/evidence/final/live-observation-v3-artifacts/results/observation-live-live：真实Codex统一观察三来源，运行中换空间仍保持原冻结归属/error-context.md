# Instructions

- Following Playwright test failed.
- Explain why, be concise, respect Playwright best practices.
- Provide a snippet of code with the fix, if possible.

# Test info

- Name: observation-live.spec.ts >> live：真实Codex统一观察三来源，运行中换空间仍保持原冻结归属
- Location: e2e/observation-live.spec.ts:41:1

# Error details

```
Error: expect(received).toBe(expected) // Object.is equality

Expected: false
Received: true
```

# Test source

```ts
  1   | import { execFile, type ChildProcess } from 'node:child_process';
  2   | import { randomUUID } from 'node:crypto';
  3   | import { mkdtemp, mkdir, rm, writeFile } from 'node:fs/promises';
  4   | import { tmpdir } from 'node:os';
  5   | import path from 'node:path';
  6   | import { promisify, stripVTControlCharacters } from 'node:util';
  7   | import { expect, test, type Page } from '@playwright/test';
  8   | import { WorkspaceObservationResultSchema, type WorkbenchCommand, type ChatConversation } from '../packages/protocol/src';
  9   | import { launchApp, workspaceSnapshot, workshopNavigate } from './helpers';
  10  | 
  11  | async function command(page: Page, input: WorkbenchCommand) {
  12  |   const result = await page.evaluate((input) => window.studio.workbench.command(input), input);
  13  |   expect(result.ok, JSON.stringify(result)).toBe(true);
  14  | }
  15  | async function switchSpace(page: Page, name: string) {
  16  |   await page.getByRole('button', { name: '切换空间', exact: true }).click();
  17  |   await page
  18  |     .getByRole('dialog', { name: '切换空间' })
  19  |     .getByRole('button')
  20  |     .filter({ has: page.locator('strong', { hasText: name }) })
  21  |     .click();
  22  | }
  23  | function payload(tool: ChatConversation['toolExecutions'][number]) {
  24  |   expect(tool.exitCode).toBe(0);
> 25  |   expect(tool.truncated).toBe(false);
      |                          ^ Error: expect(received).toBe(expected) // Object.is equality
  26  |   const envelope = JSON.parse(tool.output) as {
  27  |     status: string;
  28  |     error: unknown;
  29  |     result: { isError?: boolean; structuredContent?: { untrusted: boolean; data: unknown }; content?: { type: string; text?: string }[] };
  30  |   };
  31  |   expect(envelope.status).toBe('completed');
  32  |   expect(envelope.error).toBeNull();
  33  |   expect(envelope.result.isError).not.toBe(true);
  34  |   const structured = envelope.result.structuredContent ?? JSON.parse(envelope.result.content!.find((part) => part.type === 'text')!.text!);
  35  |   expect(structured.untrusted).toBe(true);
  36  |   const data = WorkspaceObservationResultSchema.parse(structured.data);
  37  |   expect('error' in data, JSON.stringify(data)).toBe(false);
  38  |   return data;
  39  | }
  40  | 
  41  | test('live：真实Codex统一观察三来源，运行中换空间仍保持原冻结归属', async ({ playwright: _playwright }, info) => {
  42  |   test.skip(process.env['WSL_LIVE_OBSERVATION'] !== '1', '需主线程串行授权启用 WSL_LIVE_OBSERVATION=1；默认不调用模型/sandbox');
  43  |   test.setTimeout(240000);
  44  |   const owned = await mkdtemp(path.join(tmpdir(), 'wsl-observation-live-'));
  45  |   const root = path.join(owned, 'authorized-files');
  46  |   await mkdir(root);
  47  |   const fileNonce = `OBS_FILE=${randomUUID()}`;
  48  |   const browserNonce = `OBS_BROWSER=${randomUUID()}`;
  49  |   const interference = `OTHER_SPACE=${randomUUID()}`;
  50  |   await writeFile(path.join(root, 'nonce.txt'), fileNonce + '\n');
  51  |   const guestDir = `/home/agent/workspace/wsl-observation-${randomUUID()}`;
  52  |   let app: Awaited<ReturnType<typeof launchApp>>['app'] | undefined;
  53  |   let electronProcess: ChildProcess | undefined;
  54  |   let originalFailure: unknown;
  55  |   const cleanupErrors: unknown[] = [];
  56  |   let guestCreated = false;
  57  |   let processCleanupConfirmed = false;
  58  |   let page: Page | undefined;
  59  |   let ownerId: string | undefined;
  60  |   let phase = 'launch';
  61  |   const evidence: Record<string, unknown> = { evidenceKind: 'real-codex-guest-mcp-main-browser-local-file-sandbox-pty', guestDir };
  62  |   try {
  63  |     const launched = await launchApp({ live: true, observationRoot: root, userData: path.join(owned, 'profile') });
  64  |     app = launched.app;
  65  |     electronProcess = app.process();
  66  |     page = launched.page;
  67  |     await workshopNavigate(page, '空间');
  68  |     const initial = await workspaceSnapshot(page);
  69  |     ownerId = initial.activeWorkspaceId;
  70  |     const ownerName = initial.workspaces.find((w) => w.workspaceId === ownerId)!.name;
  71  |     phase = 'prepare-isolation';
  72  |     const otherId = randomUUID();
  73  |     const otherName = `观察隔离-${randomUUID().slice(0, 8)}`;
  74  |     await command(page, { type: 'createWorkspace', workspaceId: otherId, commandId: randomUUID(), name: otherName });
  75  |     await command(page, {
  76  |       type: 'createTab',
  77  |       workspaceId: otherId,
  78  |       commandId: randomUUID(),
  79  |       kind: 'web',
  80  |       title: '隔离网页',
  81  |       environmentId: 'local',
  82  |       url: 'wsl-demo://taskflow/index.html',
  83  |     });
  84  |     await expect
  85  |       .poll(async () => {
  86  |         const preview = (await workspaceSnapshot(page!)).workspaces
  87  |           .find((w) => w.workspaceId === otherId)!
  88  |           .resources.find((r) => r.kind === 'web')!.preview;
  89  |         return !!preview?.page && !preview.loading;
  90  |       })
  91  |       .toBe(true);
  92  |     const otherBrowser = (await workspaceSnapshot(page)).workspaces
  93  |       .find((w) => w.workspaceId === otherId)!
  94  |       .resources.find((r) => r.kind === 'web')!;
  95  |     await app.evaluate(
  96  |       ({ webContents }, { id, text }) =>
  97  |         webContents
  98  |           .fromId(id)!
  99  |           .executeJavaScript(`document.body.innerHTML = ${JSON.stringify(`<h1>${text}</h1>`)}; document.title='观察隔离';`),
  100 |       { id: otherBrowser.preview!.page!.webContentsId, text: interference },
  101 |     );
  102 |     await switchSpace(page, ownerName);
  103 |     phase = 'resources';
  104 |     await page.getByRole('button', { name: '新建标签', exact: true }).click();
  105 |     const editor = page.getByRole('dialog', { name: '新建标签' });
  106 |     await editor.getByLabel('标签类型').selectOption('file');
  107 |     await editor.getByLabel('名称', { exact: true }).fill('Live授权文件');
  108 |     await editor.getByLabel('资源环境').selectOption('local');
  109 |     await editor.getByRole('button', { name: '保存', exact: true }).click();
  110 |     const files = page.getByRole('region', { name: '只读文件浏览' });
  111 |     await files.getByLabel('文件路径').fill('nonce.txt');
  112 |     await files.getByRole('button', { name: '读取文件', exact: true }).click();
  113 |     await expect(files.getByRole('region', { name: '当前文件结果' })).toContainText(fileNonce);
  114 |     await page.getByRole('button', { name: '开发终端', exact: true }).click();
  115 |     const panel = page.getByRole('region', { name: '资源终端' });
  116 |     await expect(panel.getByRole('button', { name: '连接终端', exact: true })).toBeEnabled({ timeout: 30000 });
  117 |     await panel.getByRole('button', { name: '连接终端', exact: true }).click();
  118 |     await expect
  119 |       .poll(
  120 |         async () =>
  121 |           (await workspaceSnapshot(page!)).workspaces.find((w) => w.workspaceId === ownerId)!.resources.find((r) => r.kind === 'terminal')!
  122 |             .terminal?.state,
  123 |         { timeout: 30000 },
  124 |       )
  125 |       .toBe('running');
```