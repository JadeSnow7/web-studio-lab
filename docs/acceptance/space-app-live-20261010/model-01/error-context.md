# Instructions

- Following Playwright test failed.
- Explain why, be concise, respect Playwright best practices.
- Provide a snippet of code with the fix, if possible.

# Test info

- Name: space-app-model-live.spec.ts >> live: real App creation, native element capture and product model edit rebuild the same project
- Location: e2e/space-app-model-live.spec.ts:45:1

# Error details

```
Error: locator.selectOption: Error: strict mode violation: getByLabel('关联会话', { exact: true }) resolved to 2 elements:
    1) <select aria-label="关联会话">…</select> aka getByLabel('关联会话').first()
    2) <select aria-label="关联会话">…</select> aka getByRole('combobox')

Call log:
  - waiting for getByLabel('关联会话', { exact: true })

```

# Test source

```ts
  45  | test('live: real App creation, native element capture and product model edit rebuild the same project', async () => {
  46  |   test.skip(process.env['WSL_APP_MODEL_LIVE'] !== '1', 'requires explicit real sandbox AND model authorization');
  47  |   test.setTimeout(900_000);
  48  |   const sandbox = process.env['WSL_SBX_NAME'];
  49  |   if (!sandbox) throw new Error('WSL_SBX_NAME must explicitly select the authorized live sandbox');
  50  |   const binary = process.env['WSL_SBX_BIN'] ?? '/opt/homebrew/bin/sbx';
  51  |   const nonce = `WSL_APP_MODEL_${randomUUID().replaceAll('-', '')}`;
  52  |   // Each attempt has independent receipts; retries cannot overwrite an earlier failure.
  53  |   const evidenceRoot = path.resolve(process.env['WSL_APP_MODEL_EVIDENCE'] ?? 'test-results/space-app-model-live', nonce);
  54  |   const profile = path.join(evidenceRoot, 'profile');
  55  |   await mkdir(evidenceRoot, { recursive: true });
  56  |   const evidence: Record<string, unknown> = {
  57  |     startedAt: new Date().toISOString(),
  58  |     sandbox,
  59  |     nonce,
  60  |     profile,
  61  |     stage: 'launch',
  62  |     result: 'running',
  63  |   };
  64  |   const receipt = async (stage: string) => {
  65  |     evidence['stage'] = stage;
  66  |     await writeFile(path.join(evidenceRoot, 'evidence.json'), JSON.stringify(evidence, null, 2));
  67  |   };
  68  |   let app: ElectronApplication | undefined;
  69  |   let page: Page | undefined;
  70  |   let owned: { workspaceId: string; projectId: string; appId: string } | undefined;
  71  |   let ownedRunId: string | undefined;
  72  |   let failure: unknown;
  73  |   const cleanupErrors: string[] = [];
  74  |   await receipt('launch');
  75  |   try {
  76  |     const launched = await launchApp({ live: true, userData: profile, sandbox });
  77  |     app = launched.app;
  78  |     page = launched.page;
  79  |     const mainPage = page;
  80  |     const application = app;
  81  |     await setWindowSize(application, 1440, 900);
  82  |     const state = async () => (await workspaceSnapshot(mainPage)).workspaces.find((w) => w.workspaceId === 'taskflow-demo')!;
  83  |     const waitApp = async (expected: string) => {
  84  |       await expect
  85  |         .poll(
  86  |           async () => {
  87  |             const current = (await state()).managedApp;
  88  |             if (current?.state === 'failed' && expected !== 'failed') throw new Error(`App ${expected} failed: ${current.error}`);
  89  |             return current?.state;
  90  |           },
  91  |           { timeout: 280000, intervals: [250, 500, 1000] },
  92  |         )
  93  |         .toBe(expected);
  94  |     };
  95  |     const sources = async (cwd: string) => {
  96  |       const result = await promisify(execFile)(binary, ['exec', sandbox, 'python3', '-c', readSourceScript, cwd, owned!.projectId], {
  97  |         timeout: 45000,
  98  |         maxBuffer: 4 * 1024 * 1024,
  99  |       });
  100 |       return SourceSnapshot.parse(JSON.parse(result.stdout));
  101 |     };
  102 |     await workshopNavigate(mainPage, '空间');
  103 |     await mainPage.getByRole('button', { name: '创建标准应用', exact: true }).click();
  104 |     const editor = mainPage.getByRole('dialog', { name: '创建 App', exact: true });
  105 |     await editor.getByLabel('App 名称').fill(`真实模型验证 ${nonce}`);
  106 |     await editor.getByLabel('App 说明').fill('本次仅授权修改当前 App 的 src/App.tsx 标题');
  107 |     await editor.getByRole('button', { name: '保存 App' }).click();
  108 |     await expect.poll(async () => (await state()).app?.appId, { timeout: 15000 }).toBeTruthy();
  109 |     const registered = await state();
  110 |     owned = { workspaceId: registered.workspaceId, projectId: registered.app!.projectId, appId: registered.app!.appId };
  111 |     await waitApp('created');
  112 |     const created = await state();
  113 |     evidence['created'] = { app: created.app, managedApp: created.managedApp };
  114 |     await receipt('created');
  115 |     await mainPage.getByRole('button', { name: '启动应用', exact: true }).click();
  116 |     await waitApp('running');
  117 |     const running = (await state()).managedApp!;
  118 |     evidence['firstRuntime'] = running;
  119 |     await expect.poll(() => application.windows().some((p) => p.url().startsWith(running.url!)), { timeout: 20000 }).toBe(true);
  120 |     const native = application.windows().find((p) => p.url().startsWith(running.url!))!;
  121 |     await expect(native.getByRole('heading', { name: '从这里开始构建', exact: true })).toBeVisible();
  122 |     await expect(native.getByTestId('app-instance-id')).toHaveText(running.appInstanceId!);
  123 |     await expect
  124 |       .poll(async () => (await state()).resources.find((r) => r.appProjectId === owned!.projectId)?.preview?.page.url)
  125 |       .toBe(native.url());
  126 |     const browser = (await state()).resources.find((r) => r.appProjectId === owned!.projectId)!;
  127 |     const originalPage = browser.preview!.page;
  128 |     const nativeIdentity = await application.evaluate(({ BrowserWindow }, id) => {
  129 |       const view = BrowserWindow.getAllWindows()[0]!.contentView.children.find(
  130 |         (child) => (child as Electron.WebContentsView).webContents?.id === id,
  131 |       ) as Electron.WebContentsView | undefined;
  132 |       return view ? { id: view.webContents.id, visible: view.getVisible(), url: view.webContents.getURL() } : null;
  133 |     }, originalPage.webContentsId);
  134 |     expect(nativeIdentity).toEqual({ id: originalPage.webContentsId, visible: true, url: native.url() });
  135 |     const before = await sources(running.guestCwd);
  136 |     expect(before.source.split('从这里开始构建')).toHaveLength(2);
  137 |     await writeFile(path.join(evidenceRoot, 'App.before.tsx'), before.source);
  138 |     evidence['sourceBefore'] = before.files;
  139 |     evidence['ownedAppProcessesBefore'] = before.processes;
  140 |     expect(before.processes.length).toBeGreaterThan(0);
  141 |     evidence['nativePageBefore'] = { resourceId: browser.resourceId, page: originalPage, nativeIdentity };
  142 |     await native.screenshot({ path: path.join(evidenceRoot, 'native-before.png') });
  143 |     await receipt('capture');
  144 |     const receiver = (await state()).sessions[0]!;
> 145 |     await mainPage.getByLabel('关联会话', { exact: true }).selectOption(receiver.sessionId);
      |                                                        ^ Error: locator.selectOption: Error: strict mode violation: getByLabel('关联会话', { exact: true }) resolved to 2 elements:
  146 |     await mainPage.getByRole('button', { name: '采集到关联会话', exact: true }).click();
  147 |     await expect.poll(async () => (await state()).resources.find((r) => r.resourceId === browser.resourceId)?.preview?.picking).toBe(true);
  148 |     const point = await native.getByRole('heading', { name: '从这里开始构建', exact: true }).boundingBox();
  149 |     if (!point) throw new Error('Native heading has no layout box');
  150 |     await application.evaluate(
  151 |       ({ webContents }, input) => {
  152 |         const target = webContents.fromId(input.id);
  153 |         if (!target) throw new Error('Captured native page disappeared');
  154 |         target.sendInputEvent({ type: 'mouseMove', x: input.x, y: input.y });
  155 |         target.sendInputEvent({ type: 'mouseDown', x: input.x, y: input.y, button: 'left', clickCount: 1 });
  156 |         target.sendInputEvent({ type: 'mouseUp', x: input.x, y: input.y, button: 'left', clickCount: 1 });
  157 |       },
  158 |       { id: originalPage.webContentsId, x: Math.round(point.x + point.width / 2), y: Math.round(point.y + point.height / 2) },
  159 |     );
  160 |     const session = mainPage.getByRole('region', { name: 'Agent 会话内容' });
  161 |     await expect(session).toContainText('现场适用性：有效');
  162 |     const captured = (await state()).sessions.find((s) => s.sessionId === receiver.sessionId)!;
  163 |     expect(captured.contextTarget).toEqual({ kind: 'web', resourceId: browser.resourceId });
  164 |     expect(captured.context!.page).toEqual(originalPage);
  165 |     expect(captured.context!.element).toMatchObject({ tagName: 'h1', text: '从这里开始构建' });
  166 |     expect(captured.context!.element.selector).toContain('h1');
  167 |     expect(captured.context!.screenshot.viewport).toMatch(/^data:image\/png;base64,/);
  168 |     await session.getByRole('button', { name: '任务', exact: true }).click();
  169 |     await session.getByLabel('附加目标（明确选择）').selectOption(browser.resourceId);
  170 |     const allowedFile = `${running.guestCwd}/src/App.tsx`;
  171 |     await session
  172 |       .getByLabel('修改目标', { exact: true })
  173 |       .fill(
  174 |         `直接使用工具修改 Main 绑定的当前 App 工程。只在 src/App.tsx 中将所选 h1 的文字“从这里开始构建”替换为“${nonce}”。只做这一次字符串替换，其他文件和其他字节保持原样，不格式化，不安装依赖，不构建，不启动或停止进程，不修改其他工程。完成后读取该文件核对并简短报告。`,
  175 |       );
  176 |     await session.getByLabel('允许修改范围（每行一条）').fill(allowedFile);
  177 |     await session.getByLabel('验收条件（每行一条）').fill(`只有 src/App.tsx 的目标标题发生变化\n原生 App 页面重启后显示 ${nonce}`);
  178 |     await session.getByRole('button', { name: '确认任务（生成新版本）', exact: true }).click();
  179 |     const confirmed = (await state()).sessions.find((s) => s.sessionId === receiver.sessionId)!.taskVersions.at(-1)!;
  180 |     expect(confirmed.appTarget).toMatchObject({ ...owned, guestCwd: running.guestCwd });
  181 |     expect(confirmed.allowedScopes).toEqual([allowedFile]);
  182 |     expect(confirmed.capture!.captureId).toBe(captured.context!.captureId);
  183 |     expect(confirmed.captureBinding).toMatchObject({ instanceId: browser.instanceId, generation: browser.generation });
  184 |     const { screenshot: _screenshot, ...captureIdentity } = confirmed.capture!;
  185 |     evidence['confirmed'] = { ...confirmed, capture: captureIdentity };
  186 |     await receipt('model-start');
  187 |     await session.getByRole('button', { name: '开始运行', exact: true }).click();
  188 |     await expect
  189 |       .poll(
  190 |         async () => {
  191 |           const run = (await state()).runs.find((r) => r.taskVersionId === confirmed.taskVersionId);
  192 |           if (run) ownedRunId = run.runId;
  193 |           if (run?.state === 'failed' || run?.state === 'cancelled') {
  194 |             evidence['failedRun'] = run;
  195 |             throw new Error(`Product model run ${run.state}: ${run.error}`);
  196 |           }
  197 |           return run?.state;
  198 |         },
  199 |         { timeout: 300000, intervals: [500, 1000, 2000] },
  200 |       )
  201 |       .toBe('completed');
  202 |     const run = (await state()).runs.find((r) => r.runId === ownedRunId)!;
  203 |     expect(run.executionBinding?.turnId).toBeTruthy();
  204 |     expect(run.conversation?.toolExecutions.length).toBeGreaterThan(0);
  205 |     expect(run.conversation?.cleanupPending).toBe(false);
  206 |     const toolCommands = run.conversation!.toolExecutions.map((tool) => tool.command).join('\n');
  207 |     expect(toolCommands).toContain(running.guestCwd);
  208 |     expect(toolCommands).toContain('src/App.tsx');
  209 |     expect(run.review).toBeNull();
  210 |     expect(run.validation.state).toBe('not_run');
  211 |     evidence['modelRun'] = run;
  212 |     const after = await sources(running.guestCwd);
  213 |     await writeFile(path.join(evidenceRoot, 'App.after.tsx'), after.source);
  214 |     evidence['sourceAfter'] = after.files;
  215 |     expect(after.source).toBe(before.source.replace('从这里开始构建', nonce));
  216 |     expect(Object.keys(after.files).sort()).toEqual(Object.keys(before.files).sort());
  217 |     expect(Object.keys(after.files).filter((file) => after.files[file] !== before.files[file])).toEqual(['src/App.tsx']);
  218 |     await receipt('model-source-verified');
  219 |     await mainPage.getByRole('button', { name: '停止应用', exact: true }).click();
  220 |     await waitApp('stopped');
  221 |     expect((await state()).managedApp!.cleanupConfirmed).toBe(true);
  222 |     evidence['ownedAppProcessesAfterStop'] = (await sources(running.guestCwd)).processes;
  223 |     expect(evidence['ownedAppProcessesAfterStop']).toEqual([]);
  224 |     await mainPage.getByRole('button', { name: '启动应用', exact: true }).click();
  225 |     await waitApp('running');
  226 |     const restarted = (await state()).managedApp!;
  227 |     expect(restarted.projectId).toBe(owned.projectId);
  228 |     expect(restarted.appInstanceId).not.toBe(running.appInstanceId);
  229 |     await expect.poll(() => application.windows().some((p) => p.url().startsWith(restarted.url!)), { timeout: 20000 }).toBe(true);
  230 |     const reopened = application.windows().find((p) => p.url().startsWith(restarted.url!))!;
  231 |     await expect(reopened.getByRole('heading', { name: nonce, exact: true })).toBeVisible();
  232 |     await expect(reopened.getByRole('heading', { level: 1 })).toHaveCount(1);
  233 |     await expect(reopened.getByRole('heading', { name: '应用服务', exact: true })).toBeVisible();
  234 |     await expect(reopened.getByTestId('app-instance-id')).toHaveText(restarted.appInstanceId!);
  235 |     const health = await reopened.evaluate(async () => await (await fetch('/api/health')).json());
  236 |     expect(health.identity.projectId).toBe(owned.projectId);
  237 |     expect(health.identity.workspaceId).toBe(owned.workspaceId);
  238 |     expect(health.identity.appInstanceId).toBe(restarted.appInstanceId);
  239 |     expect((await state()).resources.find((r) => r.appProjectId === owned!.projectId)!.resourceId).toBe(browser.resourceId);
  240 |     evidence['rebuilt'] = { runtime: restarted, health };
  241 |     await reopened.screenshot({ path: path.join(evidenceRoot, 'native-after.png') });
  242 |     await mainPage.screenshot({ path: path.join(evidenceRoot, 'renderer-after.png') });
  243 |     const windowPng = await application.evaluate(async ({ BrowserWindow }) =>
  244 |       (await BrowserWindow.getAllWindows()[0]!.capturePage()).toPNG().toString('base64'),
  245 |     );
```