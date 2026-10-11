# 修复后产品窗口与 sandbox 复验

A03/A07 在 [round-07-review](../round-07-review/README.md) 的最终源码上通过。执行使用现有 `wsl-sbx-smoke-20261006` 中的新项目 `78e750c6-339f-4906-9b9c-8ac9a10a868d`，不调用模型；Main↔service 的测试注入边界与 round-06 相同。

命令：`WSL_APP_CONTROL_LIVE=1 WSL_SBX_NAME=wsl-sbx-smoke-20261006 WSL_SBX_BIN=/opt/homebrew/bin/sbx WSL_APP_DEPENDENCY_ARCHIVE=<repo>/packaging/generated/runtime/template-dependencies.tar.gz WSL_APP_CONTROL_EVIDENCE=<本目录> pnpm exec playwright test e2e/app-control-live.spec.ts`。pnpm 10.34.6，退出 0，1 passed，耗时 2.5 分钟。原始输出见 [playwright.log](playwright.log)，逐项结果见 [results.json](results.json)。

- 原版固定场景第 2 步失败；参考实现写入后，未重建时写操作返回 `manifest_stale`。
- `app.restart` 后旧实例被拒，新实例两次固定场景都 passed，回放一致，数据库读到“固定验收 2026”。
- `sendInputEvent` 模拟用户接管，进行中的动作返回 `paused_by_user`；指示和恢复按钮可见，恢复后动作成功。工作台焦点及 `document.hasFocus()` 保持不变。仍不等于真人输入验证。
- 停止后数据库查询的 `mode` 为 `cli`，写入返回 `app_not_running`；run 结束后调用返回 `no_active_run`。
- 独立检查该项目 cwd 下的 guest 进程，结果为空，见 [owned-processes-after.json](owned-processes-after.json)。停止后的映射仅为既有配置的两条 8081 映射；测试使用动态端口，没有清理不属于该项目的配置。

工作台指示见 [A07-paused-indicator.png](A07-paused-indicator.png)。`BrowserWindow.capturePage()` 不包含原生网页内容；实际 App 页面与固定场景轨迹在 [app-control](app-control/) 下，不能把工作台截图的空白网页区解释为已验证页面内容。
