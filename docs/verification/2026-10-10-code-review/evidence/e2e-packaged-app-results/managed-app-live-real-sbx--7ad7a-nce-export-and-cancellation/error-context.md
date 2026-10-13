# Instructions

- Following Playwright test failed.
- Explain why, be concise, respect Playwright best practices.
- Provide a snippet of code with the fix, if possible.

# Test info

- Name: managed-app-live.spec.ts >> real sbx standard app through product Browser, persistence, export and cancellation
- Location: e2e/managed-app-live.spec.ts:9:1

# Error details

```
TimeoutError: locator.click: Timeout 30000ms exceeded.
Call log:
  - waiting for getByRole('button', { name: '停止应用', exact: true })
    - locator resolved to <button class="btn" type="button">停止应用</button>
  - attempting click action
    2 × waiting for element to be visible, enabled and stable
      - element is visible, enabled and stable
      - scrolling into view if needed
      - done scrolling
      - <dialog open="" aria-label="切换空间" class="space-switcher">…</dialog> intercepts pointer events
    - retrying click action
    - waiting 20ms
    2 × waiting for element to be visible, enabled and stable
      - element is visible, enabled and stable
      - scrolling into view if needed
      - done scrolling
      - <dialog open="" aria-label="切换空间" class="space-switcher">…</dialog> intercepts pointer events
    - retrying click action
      - waiting 100ms
    58 × waiting for element to be visible, enabled and stable
       - element is visible, enabled and stable
       - scrolling into view if needed
       - done scrolling
       - <dialog open="" aria-label="切换空间" class="space-switcher">…</dialog> intercepts pointer events
     - retrying click action
       - waiting 500ms

```

# Test source

```ts
  57  |           reject(new Error('Port-check guest exited before active receipt'));
  58  |         });
  59  |       });
  60  |       const result = await promisify(execFile)(binary, ['ports', sandbox, '--json'], { timeout: 20000 });
  61  |       return JSON.parse(result.stdout) as { host_ip: string; host_port: number; sandbox_port: number; protocol: string }[];
  62  |     } finally {
  63  |       keeper.stdin.end();
  64  |       expect(await closed).toBe(0);
  65  |     }
  66  |   };
  67  |   const state = async () => (await workspaceSnapshot(page)).workspaces.find((w) => w.workspaceId === 'taskflow-demo')!;
  68  |   const waitState = async (value: string) => {
  69  |     const deadline = Date.now() + 260000;
  70  |     while (Date.now() < deadline) {
  71  |       const current = (await state()).managedApp;
  72  |       if (current?.state === value) return;
  73  |       if (current?.state === 'failed' && value !== 'failed') throw new Error('App failed: ' + current.error);
  74  |       await page.waitForTimeout(250);
  75  |     }
  76  |     throw new Error('App state timed out: ' + JSON.stringify((await state()).managedApp));
  77  |   };
  78  |   try {
  79  |     await workshopNavigate(page, '空间');
  80  |     await page.getByRole('button', { name: '创建标准应用', exact: true }).click();
  81  |     await waitState('created');
  82  |     evidence['created'] = (await state()).managedApp;
  83  |     await page.getByRole('button', { name: '启动应用', exact: true }).click();
  84  |     await waitState('running');
  85  |     const first = (await state()).managedApp!;
  86  |     evidence['first'] = first;
  87  |     const browser = await expect
  88  |       .poll(async () => app.windows().some((p) => p.url().startsWith(first.url!)), { timeout: 15000 })
  89  |       .toBe(true)
  90  |       .then(() => app.windows().find((p) => p.url().startsWith(first.url!))!);
  91  |     await expect(browser.getByRole('heading', { name: '从这里开始构建' })).toBeVisible();
  92  |     await expect(browser.getByTestId('app-instance-id')).toHaveText(first.appInstanceId!);
  93  |     const health = await browser.evaluate(async () => await (await fetch('/api/health')).json());
  94  |     expect(health.identity).toEqual({
  95  |       workspaceId: first.workspaceId,
  96  |       environmentId: 'sandbox',
  97  |       projectId: first.projectId,
  98  |       appInstanceId: first.appInstanceId,
  99  |     });
  100 |     const native = (await state()).resources.find((r) => r.appProjectId === first.projectId)!;
  101 |     expect(native.preview?.page?.url).toBe(browser.url());
  102 |     const geometry = await app.evaluate(({ BrowserWindow }, id) => {
  103 |       const window = BrowserWindow.getAllWindows()[0]!;
  104 |       const view = window.contentView.children.find((candidate) => (candidate as Electron.WebContentsView).webContents?.id === id) as
  105 |         Electron.WebContentsView | undefined;
  106 |       return view
  107 |         ? { visible: view.getVisible(), bounds: view.getBounds(), webContentsId: view.webContents.id, url: view.webContents.getURL() }
  108 |         : null;
  109 |     }, native.preview!.page.webContentsId);
  110 |     expect(geometry?.visible).toBe(true);
  111 |     expect(geometry!.bounds.width).toBeGreaterThan(100);
  112 |     expect(geometry!.bounds.height).toBeGreaterThan(100);
  113 |     const workspace = await state();
  114 |     const activePane = (function find(layout: typeof workspace.layout): { paneId: string; tabId: string | null } | undefined {
  115 |       return layout.kind === 'pane'
  116 |         ? layout.paneId === workspace.activePaneId
  117 |           ? layout
  118 |           : undefined
  119 |         : (find(layout.first) ?? find(layout.second));
  120 |     })(workspace.layout);
  121 |     expect(workspace.tabs.find((tab) => tab.tabId === activePane?.tabId)?.targetRef.resourceId).toBe(native.resourceId);
  122 |     evidence['nativeBrowser'] = { resource: native, health, geometry, activePane };
  123 |     await browser.screenshot({ path: path.join(evidenceRoot, 'native-browser.png') });
  124 |     await page.screenshot({ path: path.join(evidenceRoot, 'workbench-renderer.png') });
  125 |     const windowPng = await app.evaluate(async ({ BrowserWindow }) =>
  126 |       (await BrowserWindow.getAllWindows()[0]!.capturePage()).toPNG().toString('base64'),
  127 |     );
  128 |     await writeFile(path.join(evidenceRoot, 'workbench-window.png'), Buffer.from(windowPng, 'base64'));
  129 |     const pauseMs = Math.min(60000, Math.max(0, Number(process.env['WSL_APP_SCREEN_PAUSE_MS'] ?? 0)));
  130 |     if (pauseMs) {
  131 |       console.log('MANAGED_APP_SCREEN_READY', JSON.stringify({ url: first.url, webContentsId: native.preview!.page.webContentsId }));
  132 |       await page.waitForTimeout(pauseMs);
  133 |     }
  134 |     const nonce = randomUUID();
  135 |     const persistence = await browser.evaluate(async (nonce) => {
  136 |       const request = async (url: string, method = 'GET', body?: unknown) => {
  137 |         const response = await fetch(url, {
  138 |           method,
  139 |           headers: body ? { 'Content-Type': 'application/json' } : {},
  140 |           ...(body ? { body: JSON.stringify(body) } : {}),
  141 |         });
  142 |         return { status: response.status, body: await response.json() };
  143 |       };
  144 |       const a = await request('/api/dev/session', 'POST', { userId: 'A' });
  145 |       const writeA = await request('/api/kv/welcome', 'PUT', { value: nonce });
  146 |       const b = await request('/api/dev/session', 'POST', { userId: 'B' });
  147 |       const readB = await request('/api/kv/welcome');
  148 |       const writeB = await request('/api/kv/welcome', 'PUT', { value: 'B-' + nonce });
  149 |       return { a, writeA, b, readB, writeB };
  150 |     }, nonce);
  151 |     expect(persistence.a.status).toBe(200);
  152 |     expect(persistence.writeA.body.value).toBe(nonce);
  153 |     expect(persistence.b.status).toBe(200);
  154 |     expect(persistence.readB.body.value).toBe('Ready');
  155 |     expect(persistence.writeB.body.value).toBe('B-' + nonce);
  156 |     evidence['storageBefore'] = persistence;
> 157 |     await page.getByRole('button', { name: '停止应用', exact: true }).click();
      |                                                                   ^ TimeoutError: locator.click: Timeout 30000ms exceeded.
  158 |     await waitState('stopped');
  159 |     expect((await state()).managedApp?.cleanupConfirmed).toBe(true);
  160 |     const firstStoppedPorts = await portMappings();
  161 |     evidence['firstStoppedPorts'] = firstStoppedPorts;
  162 |     expect(firstStoppedPorts.some((port) => port.sandbox_port === first.guestPort)).toBe(false);
  163 |     await expect
  164 |       .poll(async () =>
  165 |         fetch(first.url! + '/api/health', { signal: AbortSignal.timeout(1500) }).then(
  166 |           () => false,
  167 |           () => true,
  168 |         ),
  169 |       )
  170 |       .toBe(true);
  171 |     await page.getByRole('button', { name: '启动应用', exact: true }).click();
  172 |     await waitState('running');
  173 |     const second = (await state()).managedApp!;
  174 |     expect(second.projectId).toBe(first.projectId);
  175 |     expect(second.appInstanceId).not.toBe(first.appInstanceId);
  176 |     const restartedPorts = await portMappings();
  177 |     evidence['restartedPorts'] = restartedPorts;
  178 |     expect(restartedPorts.filter((port) => port.sandbox_port === second.guestPort)).toHaveLength(1);
  179 |     if (first.guestPort !== second.guestPort) expect(restartedPorts.some((port) => port.sandbox_port === first.guestPort)).toBe(false);
  180 |     await expect.poll(async () => app.windows().some((p) => p.url().startsWith(second.url!)), { timeout: 15000 }).toBe(true);
  181 |     const restarted = app.windows().find((p) => p.url().startsWith(second.url!))!;
  182 |     await expect(restarted.getByTestId('app-instance-id')).toHaveText(second.appInstanceId!);
  183 |     const persisted = await restarted.evaluate(async () => {
  184 |       const values = [];
  185 |       for (const userId of ['A', 'B']) {
  186 |         const session = await fetch('/api/dev/session', {
  187 |           method: 'POST',
  188 |           headers: { 'Content-Type': 'application/json' },
  189 |           body: JSON.stringify({ userId }),
  190 |         });
  191 |         if (!session.ok) throw new Error('session failed');
  192 |         values.push(await (await fetch('/api/kv/welcome')).json());
  193 |       }
  194 |       return values;
  195 |     });
  196 |     expect(persisted.map((v) => v.value)).toEqual([nonce, 'B-' + nonce]);
  197 |     evidence['restart'] = { second, persisted };
  198 |     // Close the actual running workbench; service shutdown must revoke its own mapping before disconnecting.
  199 |     await app.close();
  200 |     const windowClosedPorts = await portMappings();
  201 |     expect(windowClosedPorts.some((port) => port.sandbox_port === second.guestPort)).toBe(false);
  202 |     evidence['windowClosedPorts'] = windowClosedPorts;
  203 |     ({ app, page } = await launchApp({ live: true, userData: profile }));
  204 |     await workshopNavigate(page, '空间');
  205 |     const restored = (await state()).managedApp!;
  206 |     expect(restored.state).toBe('stopped');
  207 |     expect(restored.url).toBeNull();
  208 |     expect(restored.projectId).toBe(first.projectId);
  209 |     await page.getByRole('button', { name: '启动应用', exact: true }).click();
  210 |     await waitState('running');
  211 |     const third = (await state()).managedApp!;
  212 |     expect(third.appInstanceId).not.toBe(second.appInstanceId);
  213 |     await expect.poll(async () => app.windows().some((p) => p.url().startsWith(third.url!)), { timeout: 15000 }).toBe(true);
  214 |     const reopened = app.windows().find((p) => p.url().startsWith(third.url!))!;
  215 |     await expect(reopened.getByTestId('app-instance-id')).toHaveText(third.appInstanceId!);
  216 |     const afterWindowClose = await reopened.evaluate(async () => {
  217 |       const values = [];
  218 |       for (const userId of ['A', 'B']) {
  219 |         const response = await fetch('/api/dev/session', {
  220 |           method: 'POST',
  221 |           headers: { 'Content-Type': 'application/json' },
  222 |           body: JSON.stringify({ userId }),
  223 |         });
  224 |         if (!response.ok) throw new Error('session failed');
  225 |         values.push(await (await fetch('/api/kv/welcome')).json());
  226 |       }
  227 |       return values;
  228 |     });
  229 |     expect(afterWindowClose.map((v) => v.value)).toEqual([nonce, 'B-' + nonce]);
  230 |     evidence['windowRestored'] = { restored, third, persisted: afterWindowClose };
  231 |     await page.getByRole('button', { name: '停止应用', exact: true }).click();
  232 |     await waitState('stopped');
  233 |     const secondStoppedPorts = await portMappings();
  234 |     evidence['secondStoppedPorts'] = secondStoppedPorts;
  235 |     expect(secondStoppedPorts.some((port) => port.sandbox_port === third.guestPort)).toBe(false);
  236 |     expect(secondStoppedPorts.some((port) => port.sandbox_port === second.guestPort)).toBe(false);
  237 |     await page.getByRole('button', { name: '导出源码', exact: true }).click();
  238 |     await expect.poll(async () => (await state()).appExport?.path, { timeout: 30000 }).toBeTruthy();
  239 |     const exported = (await state()).appExport!;
  240 |     const manifest = JSON.parse(await readFile(exported.manifestPath ?? `${exported.path}.manifest.json`, 'utf8'));
  241 |     expect(createHash('sha256').update(JSON.stringify(manifest.files)).digest('hex')).toBe(exported.sha256);
  242 |     for (const file of manifest.files as { path: string; base64: string }[])
  243 |       expect((await readFile(path.join(exported.path, file.path))).toString('base64')).toBe(file.base64);
  244 |     expect(manifest.files.some((f: { path: string }) => f.path === 'package-lock.json')).toBe(true);
  245 |     evidence['export'] = exported;
  246 |     await page.getByRole('button', { name: '启动应用', exact: true }).click();
  247 |     await expect(page.getByRole('button', { name: '取消启动', exact: true })).toBeEnabled();
  248 |     await page.getByRole('button', { name: '取消启动', exact: true }).click();
  249 |     await waitState('stopped');
  250 |     expect((await state()).managedApp?.cleanupConfirmed).toBe(true);
  251 |     evidence['cancelled'] = (await state()).managedApp;
  252 |     const finalAwakePorts = await portMappings();
  253 |     for (const owned of [first.guestPort, second.guestPort, third.guestPort])
  254 |       expect(finalAwakePorts.some((port) => port.sandbox_port === owned)).toBe(false);
  255 |     evidence['finalAwakePorts'] = finalAwakePorts;
  256 |     evidence['passed'] = true;
  257 |   } catch (error) {
```