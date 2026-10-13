# Instructions

- Following Playwright test failed.
- Explain why, be concise, respect Playwright best practices.
- Provide a snippet of code with the fix, if possible.

# Test info

- Name: space-app-model-live.spec.ts >> live: real App creation, native element capture and product model edit rebuild the same project
- Location: e2e/space-app-model-live.spec.ts:45:1

# Error details

```
Error: Product model run failed: Reconnecting... 1/5 (unexpected status 401 Unauthorized: Your authentication token has expired. Please try refreshing it., url: https://chatgpt.com/backend-api/codex/responses, cf-ray: a482ab381d1b91fd-BOS, auth error: 401, auth error code: token_expired)
```

# Test source

```ts
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
  145 |     const browserUi = mainPage
  146 |       .locator('.workspace-browser:visible')
  147 |       .filter({ has: mainPage.locator(`[id="address-${browser.resourceId}"]`) });
  148 |     await expect(browserUi).toHaveCount(1);
  149 |     await expect(browserUi.getByLabel('页面地址', { exact: true })).toHaveValue(native.url());
  150 |     await browserUi.getByLabel('关联会话', { exact: true }).selectOption(receiver.sessionId);
  151 |     await browserUi.getByRole('button', { name: '采集到关联会话', exact: true }).click();
  152 |     await expect.poll(async () => (await state()).resources.find((r) => r.resourceId === browser.resourceId)?.preview?.picking).toBe(true);
  153 |     const point = await native.getByRole('heading', { name: '从这里开始构建', exact: true }).boundingBox();
  154 |     if (!point) throw new Error('Native heading has no layout box');
  155 |     await application.evaluate(
  156 |       ({ webContents }, input) => {
  157 |         const target = webContents.fromId(input.id);
  158 |         if (!target) throw new Error('Captured native page disappeared');
  159 |         target.sendInputEvent({ type: 'mouseMove', x: input.x, y: input.y });
  160 |         target.sendInputEvent({ type: 'mouseDown', x: input.x, y: input.y, button: 'left', clickCount: 1 });
  161 |         target.sendInputEvent({ type: 'mouseUp', x: input.x, y: input.y, button: 'left', clickCount: 1 });
  162 |       },
  163 |       { id: originalPage.webContentsId, x: Math.round(point.x + point.width / 2), y: Math.round(point.y + point.height / 2) },
  164 |     );
  165 |     const session = mainPage.getByRole('region', { name: 'Agent 会话内容' });
  166 |     await expect(session).toContainText('现场适用性：有效');
  167 |     const captured = (await state()).sessions.find((s) => s.sessionId === receiver.sessionId)!;
  168 |     expect(captured.contextTarget).toEqual({ kind: 'web', resourceId: browser.resourceId });
  169 |     expect(captured.context!.page).toEqual(originalPage);
  170 |     expect(captured.context!.element).toMatchObject({ tagName: 'h1', text: '从这里开始构建' });
  171 |     expect(captured.context!.element.selector).toContain('h1');
  172 |     expect(captured.context!.screenshot.viewport).toMatch(/^data:image\/png;base64,/);
  173 |     await session.getByRole('button', { name: '任务', exact: true }).click();
  174 |     await session.getByLabel('附加目标（明确选择）').selectOption(browser.resourceId);
  175 |     const allowedFile = `${running.guestCwd}/src/App.tsx`;
  176 |     await session
  177 |       .getByLabel('修改目标', { exact: true })
  178 |       .fill(
  179 |         `直接使用工具修改 Main 绑定的当前 App 工程。只在 src/App.tsx 中将所选 h1 的文字“从这里开始构建”替换为“${nonce}”。只做这一次字符串替换，其他文件和其他字节保持原样，不格式化，不安装依赖，不构建，不启动或停止进程，不修改其他工程。完成后读取该文件核对并简短报告。`,
  180 |       );
  181 |     await session.getByLabel('允许修改范围（每行一条）').fill(allowedFile);
  182 |     await session.getByLabel('验收条件（每行一条）').fill(`只有 src/App.tsx 的目标标题发生变化\n原生 App 页面重启后显示 ${nonce}`);
  183 |     await session.getByRole('button', { name: '确认任务（生成新版本）', exact: true }).click();
  184 |     const confirmed = (await state()).sessions.find((s) => s.sessionId === receiver.sessionId)!.taskVersions.at(-1)!;
  185 |     expect(confirmed.appTarget).toMatchObject({ ...owned, guestCwd: running.guestCwd });
  186 |     expect(confirmed.allowedScopes).toEqual([allowedFile]);
  187 |     expect(confirmed.capture!.captureId).toBe(captured.context!.captureId);
  188 |     expect(confirmed.captureBinding).toMatchObject({ instanceId: browser.instanceId, generation: browser.generation });
  189 |     const { screenshot: _screenshot, ...captureIdentity } = confirmed.capture!;
  190 |     evidence['confirmed'] = { ...confirmed, capture: captureIdentity };
  191 |     await receipt('model-start');
  192 |     await session.getByRole('button', { name: '开始运行', exact: true }).click();
  193 |     await expect
  194 |       .poll(
  195 |         async () => {
  196 |           const run = (await state()).runs.find((r) => r.taskVersionId === confirmed.taskVersionId);
  197 |           if (run) ownedRunId = run.runId;
  198 |           if (run?.state === 'failed' || run?.state === 'cancelled') {
  199 |             evidence['failedRun'] = run;
> 200 |             throw new Error(`Product model run ${run.state}: ${run.error}`);
      |                   ^ Error: Product model run failed: Reconnecting... 1/5 (unexpected status 401 Unauthorized: Your authentication token has expired. Please try refreshing it., url: https://chatgpt.com/backend-api/codex/responses, cf-ray: a482ab381d1b91fd-BOS, auth error: 401, auth error code: token_expired)
  201 |           }
  202 |           return run?.state;
  203 |         },
  204 |         { timeout: 300000, intervals: [500, 1000, 2000] },
  205 |       )
  206 |       .toBe('completed');
  207 |     const run = (await state()).runs.find((r) => r.runId === ownedRunId)!;
  208 |     expect(run.executionBinding?.turnId).toBeTruthy();
  209 |     expect(run.conversation?.toolExecutions.length).toBeGreaterThan(0);
  210 |     expect(run.conversation?.cleanupPending).toBe(false);
  211 |     const toolCommands = run.conversation!.toolExecutions.map((tool) => tool.command).join('\n');
  212 |     expect(toolCommands).toContain(running.guestCwd);
  213 |     expect(toolCommands).toContain('src/App.tsx');
  214 |     expect(run.review).toBeNull();
  215 |     expect(run.validation.state).toBe('not_run');
  216 |     evidence['modelRun'] = run;
  217 |     const after = await sources(running.guestCwd);
  218 |     await writeFile(path.join(evidenceRoot, 'App.after.tsx'), after.source);
  219 |     evidence['sourceAfter'] = after.files;
  220 |     expect(after.source).toBe(before.source.replace('从这里开始构建', nonce));
  221 |     expect(Object.keys(after.files).sort()).toEqual(Object.keys(before.files).sort());
  222 |     expect(Object.keys(after.files).filter((file) => after.files[file] !== before.files[file])).toEqual(['src/App.tsx']);
  223 |     await receipt('model-source-verified');
  224 |     await mainPage.getByRole('button', { name: '停止应用', exact: true }).click();
  225 |     await waitApp('stopped');
  226 |     expect((await state()).managedApp!.cleanupConfirmed).toBe(true);
  227 |     evidence['ownedAppProcessesAfterStop'] = (await sources(running.guestCwd)).processes;
  228 |     expect(evidence['ownedAppProcessesAfterStop']).toEqual([]);
  229 |     await mainPage.getByRole('button', { name: '启动应用', exact: true }).click();
  230 |     await waitApp('running');
  231 |     const restarted = (await state()).managedApp!;
  232 |     expect(restarted.projectId).toBe(owned.projectId);
  233 |     expect(restarted.appInstanceId).not.toBe(running.appInstanceId);
  234 |     await expect.poll(() => application.windows().some((p) => p.url().startsWith(restarted.url!)), { timeout: 20000 }).toBe(true);
  235 |     const reopened = application.windows().find((p) => p.url().startsWith(restarted.url!))!;
  236 |     await expect(reopened.getByRole('heading', { name: nonce, exact: true })).toBeVisible();
  237 |     await expect(reopened.getByRole('heading', { level: 1 })).toHaveCount(1);
  238 |     await expect(reopened.getByRole('heading', { name: '应用服务', exact: true })).toBeVisible();
  239 |     await expect(reopened.getByTestId('app-instance-id')).toHaveText(restarted.appInstanceId!);
  240 |     const health = await reopened.evaluate(async () => await (await fetch('/api/health')).json());
  241 |     expect(health.identity.projectId).toBe(owned.projectId);
  242 |     expect(health.identity.workspaceId).toBe(owned.workspaceId);
  243 |     expect(health.identity.appInstanceId).toBe(restarted.appInstanceId);
  244 |     expect((await state()).resources.find((r) => r.appProjectId === owned!.projectId)!.resourceId).toBe(browser.resourceId);
  245 |     evidence['rebuilt'] = { runtime: restarted, health };
  246 |     await reopened.screenshot({ path: path.join(evidenceRoot, 'native-after.png') });
  247 |     await mainPage.screenshot({ path: path.join(evidenceRoot, 'renderer-after.png') });
  248 |     const windowPng = await application.evaluate(async ({ BrowserWindow }) =>
  249 |       (await BrowserWindow.getAllWindows()[0]!.capturePage()).toPNG().toString('base64'),
  250 |     );
  251 |     await writeFile(path.join(evidenceRoot, 'native-window-after.png'), Buffer.from(windowPng, 'base64'));
  252 |     evidence['rendererErrors'] = launched.rendererErrors;
  253 |     expect(launched.rendererErrors).toEqual([]);
  254 |     evidence['result'] = 'passed';
  255 |     await receipt('native-rebuild-verified');
  256 |   } catch (error) {
  257 |     evidence['result'] = 'failed';
  258 |     evidence['error'] = error instanceof Error ? error.stack : String(error);
  259 |     failure = error;
  260 |   } finally {
  261 |     // Only this fresh profile's bound run and app may be stopped; guest source and receipts remain.
  262 |     const cleanupOwnedResources = async () => {
  263 |       if (app && page && owned) {
  264 |         try {
  265 |           const owner = (await workspaceSnapshot(page)).workspaces.find((w) => w.workspaceId === owned!.workspaceId)!;
  266 |           if (owner.app?.appId !== owned.appId || owner.managedApp?.projectId !== owned.projectId)
  267 |             throw new Error('Cleanup App ownership changed');
  268 |           const run = owner.runs.find((r) => r.runId === ownedRunId);
  269 |           if (run && ['starting', 'running', 'cancelling'].includes(run.state)) {
  270 |             const result = await page.evaluate(
  271 |               (target) => window.studio.workbench.command({ type: 'cancelRun', commandId: crypto.randomUUID(), ...target }),
  272 |               { workspaceId: owned.workspaceId, runId: run.runId },
  273 |             );
  274 |             if (!result.ok) throw new Error(`Cancel owned run failed: ${result.error.message}`);
  275 |             await expect
  276 |               .poll(
  277 |                 async () =>
  278 |                   (await workspaceSnapshot(page!)).workspaces
  279 |                     .find((w) => w.workspaceId === owned!.workspaceId)!
  280 |                     .runs.find((r) => r.runId === run.runId)?.state,
  281 |                 { timeout: 45000 },
  282 |               )
  283 |               .not.toMatch(/^(starting|running|cancelling)$/);
  284 |           }
  285 |           if (!owner.managedApp.cleanupConfirmed) {
  286 |             const stopped = await page.evaluate(
  287 |               (workspaceId) => window.studio.workbench.command({ type: 'stopApp', commandId: crypto.randomUUID(), workspaceId }),
  288 |               owned.workspaceId,
  289 |             );
  290 |             if (!stopped.ok) throw new Error(`Stop owned App failed: ${stopped.error.message}`);
  291 |             expect(stopped.snapshot.workspaces.find((w) => w.workspaceId === owned!.workspaceId)!.managedApp!.cleanupConfirmed).toBe(true);
  292 |             const cleaned = stopped.snapshot.workspaces.find((w) => w.workspaceId === owned!.workspaceId)!.managedApp!;
  293 |             evidence['cleanup'] = cleaned;
  294 |             const processCheck = await promisify(execFile)(
  295 |               binary,
  296 |               ['exec', sandbox, 'python3', '-c', readSourceScript, cleaned.guestCwd, owned.projectId],
  297 |               { timeout: 45000, maxBuffer: 4 * 1024 * 1024 },
  298 |             );
  299 |             evidence['ownedAppProcessesAfterCleanup'] = SourceSnapshot.parse(JSON.parse(processCheck.stdout)).processes;
  300 |             expect(evidence['ownedAppProcessesAfterCleanup']).toEqual([]);
```