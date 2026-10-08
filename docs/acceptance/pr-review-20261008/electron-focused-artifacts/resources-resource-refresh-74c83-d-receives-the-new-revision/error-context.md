# Instructions

- Following Playwright test failed.
- Explain why, be concise, respect Playwright best practices.
- Provide a snippet of code with the fix, if possible.

# Test info

- Name: resources.spec.ts >> resource refresh retries Main after a transient list failure and receives the new revision
- Location: e2e/resources.spec.ts:178:1

# Error details

```
Error: electronApplication.evaluate: Error: 拒绝来自非工作台页面的 IPC 请求
    at assertTrustedSender (/Users/huaodong/.codex/worktrees/bf64/web-studio-lab/apps/desktop/out/main/index.js:18424:11)
    at /Users/huaodong/.codex/worktrees/bf64/web-studio-lab/apps/desktop/out/main/index.js:18490:7
    at snapshot (eval at evaluate (:311:30), <anonymous>:11:27)
    at eval (eval at evaluate (:311:30), <anonymous>:35:27)
    at UtilityScript.evaluate (<anonymous>:313:16)
    at UtilityScript.<anonymous> (<anonymous>:1:44)
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
    - button "Codex CLI · 对话不可用" [ref=e13] [cursor=pointer]
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
          - button "聚焦窗格 · TaskFlow 预览" [ref=e86]:
            - generic [ref=e90]: TaskFlow 预览
          - generic [ref=e91]:
            - button "左右分屏" [ref=e92] [cursor=pointer]: ◫
            - button "上下分屏" [ref=e93] [cursor=pointer]: ⬒
            - button "专注当前窗格" [ref=e94] [cursor=pointer]: ⤢
            - button "窗格操作" [ref=e95] [cursor=pointer]: ···
        - generic [ref=e96]:
          - generic [ref=e97]:
            - button "后退" [disabled] [ref=e98]
            - button "前进" [disabled] [ref=e101]
            - button "刷新页面" [ref=e104] [cursor=pointer]
            - generic [ref=e108]:
              - generic [ref=e109]: 页面地址
              - textbox "页面地址" [ref=e110]: wsl-demo://taskflow/index.html
            - button "选择元素" [ref=e111] [cursor=pointer]
          - generic [ref=e112]:
            - generic [ref=e113]:
              - text: 关联会话
              - combobox "关联会话" [ref=e114]:
                - option "明确选择会话" [selected]
                - option "Agent 会话"
            - button "新建关联会话" [ref=e115] [cursor=pointer]
            - button "采集到关联会话" [disabled] [ref=e116]
            - button "打开关联会话" [disabled] [ref=e117]
          - generic [ref=e118]:
            - generic [ref=e119]: 公开 HTTPS 网页 · 只读参考资源
            - button "加入空间" [disabled] [ref=e120]
            - button "查看空间资源" [ref=e121] [cursor=pointer]
    - button "通知 · 0 条未读" [ref=e123] [cursor=pointer]:
      - generic [ref=e126]: "0"
```

# Test source

```ts
  18324 |     );
  18325 |   }
  18326 |   async resourcesSave(spaceId, snapshot, resourceId) {
  18327 |     return ResourceCollectionSchema.parse(
  18328 |       await this.request({ method: "resources.save", payload: ResourceSaveRequestSchema.parse({ spaceId, snapshot, resourceId }) })
  18329 |     );
  18330 |   }
  18331 |   async resourcesRemove(spaceId, resourceId) {
  18332 |     return ResourceCollectionSchema.parse(
  18333 |       await this.request({ method: "resources.remove", payload: ResourceRemoveRequestSchema.parse({ spaceId, resourceId }) })
  18334 |     );
  18335 |   }
  18336 |   async status() {
  18337 |     if (this.failure)
  18338 |       return {
  18339 |         available: false,
  18340 |         reason: this.failure,
  18341 |         version: null,
  18342 |         sandbox: this.lastStatus?.sandbox ?? null,
  18343 |         cwd: this.lastStatus?.cwd ?? null
  18344 |       };
  18345 |     this.lastStatus = ChatStatusSchema.parse(await this.request({ method: "status" }));
  18346 |     return this.lastStatus;
  18347 |   }
  18348 |   async register(id, workspaceId) {
  18349 |     await this.request({ method: "register", payload: { conversationId: id, workspaceId } });
  18350 |   }
  18351 |   async get(id) {
  18352 |     return ChatConversationSchema.parse(await this.request({ method: "get", payload: { conversationId: id } }));
  18353 |   }
  18354 |   async send(id, text, observationScope) {
  18355 |     return ChatConversationSchema.parse(await this.request({ method: "send", payload: { conversationId: id, text, observationScope } }));
  18356 |   }
  18357 |   async cancel(id) {
  18358 |     return ChatConversationSchema.parse(await this.request({ method: "cancel", payload: { conversationId: id } }));
  18359 |   }
  18360 |   async reset(id) {
  18361 |     return ChatConversationSchema.parse(await this.request({ method: "reset", payload: { conversationId: id } }));
  18362 |   }
  18363 |   async terminalGet(resourceId) {
  18364 |     return TerminalSnapshotSchema.parse(await this.request({ method: "terminal.get", resourceId }));
  18365 |   }
  18366 |   async terminalOpen(cols, rows, resourceId) {
  18367 |     return TerminalSnapshotSchema.parse(await this.request({ method: "terminal.open", payload: { cols, rows, resourceId } }));
  18368 |   }
  18369 |   async terminalWrite(sessionId, data, resourceId) {
  18370 |     await this.request({ method: "terminal.write", payload: { sessionId, data, resourceId } });
  18371 |   }
  18372 |   async terminalResize(sessionId, cols, rows, resourceId) {
  18373 |     await this.request({ method: "terminal.resize", payload: { sessionId, cols, rows, resourceId } });
  18374 |   }
  18375 |   async terminalClose(sessionId, resourceId) {
  18376 |     return TerminalSnapshotSchema.parse(await this.request({ method: "terminal.close", payload: { sessionId, resourceId } }));
  18377 |   }
  18378 |   shutdown() {
  18379 |     if (this.shutdownResult) return this.shutdownResult;
  18380 |     this.stopped = true;
  18381 |     this.shutdownResult = (async () => {
  18382 |       if (this.failure && (this.initializationPending || this.unknownCleanup || [...this.conversations.values()].some((conversation) => conversation.cleanupPending) || [...this.terminals.values()].some((t) => t.cleanupPending)))
  18383 |         throw new Error(this.failure + "；guest 清理未确认");
  18384 |       if (!this.failure) {
  18385 |         try {
  18386 |           await this.request({ method: "shutdown" });
  18387 |           this.child.kill();
  18388 |         } catch (error2) {
  18389 |           this.onStatus({
  18390 |             available: false,
  18391 |             reason: `guest 清理失败：${error2.message}`,
  18392 |             version: null,
  18393 |             sandbox: this.lastStatus?.sandbox ?? null,
  18394 |             cwd: this.lastStatus?.cwd ?? null
  18395 |           });
  18396 |           throw error2;
  18397 |         }
  18398 |       }
  18399 |       await this.exit;
  18400 |     })();
  18401 |     return this.shutdownResult;
  18402 |   }
  18403 | }
  18404 | function getExecutionStatus() {
  18405 |   return {
  18406 |     available: false,
  18407 |     reason: "固定比赛执行与验收服务（T04）尚未接入。空间任务已接入 sbx Codex CLI Runner；当前连接与可用性请查看沙箱对话状态。",
  18408 |     harness: { name: "Codex CLI", state: "integrated", version: null, model: null }
  18409 |   };
  18410 | }
  18411 | function isTrustedRendererUrl(url2, trusted) {
  18412 |   let parsed;
  18413 |   try {
  18414 |     parsed = new URL(url2);
  18415 |   } catch {
  18416 |     return false;
  18417 |   }
  18418 |   if (trusted.kind === "dev-server") return parsed.origin === trusted.origin;
  18419 |   const expected = new URL(trusted.url);
  18420 |   return parsed.protocol === "file:" && parsed.pathname === expected.pathname;
  18421 | }
  18422 | function assertTrustedSender(sender, trusted) {
  18423 |   if (!sender.isMainWindow || !sender.isTopFrame || sender.frameUrl === null || !isTrustedRendererUrl(sender.frameUrl, trusted)) {
> 18424 |     throw new Error("拒绝来自非工作台页面的 IPC 请求");
        |           ^ Error: electronApplication.evaluate: Error: 拒绝来自非工作台页面的 IPC 请求
  18425 |   }
  18426 | }
  18427 | function senderInfo(event, window) {
  18428 |   const frame = event.senderFrame;
  18429 |   return {
  18430 |     isMainWindow: !window.isDestroyed() && event.sender === window.webContents,
  18431 |     isTopFrame: frame !== null && frame === event.sender.mainFrame,
  18432 |     frameUrl: frame?.url ?? null
  18433 |   };
  18434 | }
  18435 | function assertLegacySession(id) {
  18436 |   if (id !== "conv-personal-default") throw new Error("会话必须通过所属空间任务用例访问");
  18437 | }
  18438 | function registerIpc({ window, trusted, chat, workbench }) {
  18439 |   const handlers = {
  18440 |     "workbench:environments": () => {
  18441 |       if (!workbench) throw new Error("工作台服务不可用");
  18442 |       return workbench.environments();
  18443 |     },
  18444 |     "workbench:observe": (input) => {
  18445 |       if (!workbench) throw new Error("工作台服务不可用");
  18446 |       return workbench.observe({ ...input, args: input.args ?? {} });
  18447 |     },
  18448 |     "workbench:reload": () => {
  18449 |       if (!workbench) throw new Error("工作台服务不可用");
  18450 |       return workbench.retryInitialization();
  18451 |     },
  18452 |     "workbench:get-snapshot": () => {
  18453 |       if (!workbench) throw new Error("工作台服务不可用");
  18454 |       return workbench.getSnapshot();
  18455 |     },
  18456 |     "workbench:command": (command2) => {
  18457 |       if (!workbench) throw new Error("工作台服务不可用");
  18458 |       return workbench.command(command2);
  18459 |     },
  18460 |     "app:get-info": () => ({
  18461 |       appVersion: electron.app.getVersion(),
  18462 |       electron: process.versions.electron,
  18463 |       chrome: process.versions.chrome,
  18464 |       node: process.versions.node,
  18465 |       platform: process.platform,
  18466 |       arch: process.arch,
  18467 |       packaged: electron.app.isPackaged
  18468 |     }),
  18469 |     "chat:get-status": () => chat.status(),
  18470 |     "chat:get": ({ conversationId }) => {
  18471 |       assertLegacySession(conversationId);
  18472 |       return chat.get(conversationId);
  18473 |     },
  18474 |     "chat:send": ({ conversationId, text }) => {
  18475 |       assertLegacySession(conversationId);
  18476 |       return chat.send(conversationId, text);
  18477 |     },
  18478 |     "chat:cancel": ({ conversationId }) => {
  18479 |       assertLegacySession(conversationId);
  18480 |       return chat.cancel(conversationId);
  18481 |     },
  18482 |     "chat:reset": ({ conversationId }) => {
  18483 |       assertLegacySession(conversationId);
  18484 |       return chat.reset(conversationId);
  18485 |     },
  18486 |     "execution:get-status": () => getExecutionStatus()
  18487 |   };
  18488 |   for (const channel of INVOKE_CHANNEL_NAMES) {
  18489 |     electron.ipcMain.handle(channel, (event, raw) => {
  18490 |       assertTrustedSender(senderInfo(event, window), trusted);
  18491 |       const request = invokeChannels[channel].request.parse(raw);
  18492 |       const handler = handlers[channel];
  18493 |       return Promise.resolve(handler(request)).then((result) => invokeChannels[channel].response.parse(result));
  18494 |     });
  18495 |   }
  18496 |   return () => {
  18497 |     for (const channel of INVOKE_CHANNEL_NAMES) electron.ipcMain.removeHandler(channel);
  18498 |   };
  18499 | }
  18500 | function sendToRenderer(window, channel, payload) {
  18501 |   if (window.isDestroyed()) return;
  18502 |   window.webContents.send(channel, payload);
  18503 | }
  18504 | function installAppMenu(window, preview) {
  18505 |   const command2 = (name) => () => {
  18506 |     if (window.isDestroyed()) return;
  18507 |     window.webContents.focus();
  18508 |     sendToRenderer(window, "shell:command", name);
  18509 |   };
  18510 |   const template = [
  18511 |     {
  18512 |       label: electron.app.name,
  18513 |       submenu: [
  18514 |         { role: "about", label: "关于 Web Studio Lab" },
  18515 |         { type: "separator" },
  18516 |         { label: "应用设置…", accelerator: "CmdOrCtrl+,", click: command2("open-settings") },
  18517 |         { type: "separator" },
  18518 |         { role: "hide", label: "隐藏 Web Studio Lab" },
  18519 |         { role: "hideOthers", label: "隐藏其他" },
  18520 |         { role: "unhide", label: "全部显示" },
  18521 |         { type: "separator" },
  18522 |         { role: "quit", label: "退出 Web Studio Lab" }
  18523 |       ]
  18524 |     },
```