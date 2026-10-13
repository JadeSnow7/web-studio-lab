# A11 真实模型与独立 Host 复验

A11 通过：真实 guest Codex 完成冻结欢迎语任务，并留下真实 MCP 操作记录；模型结束后，Host 独立重放固定场景的全部 16 步并核对数据库成功。该结果不改变产品 TaskRun 的 `validation=not_run`、`review=null`。

## 执行与身份

2026-10-11，Asia/Shanghai。用户在本轮明确授权真实模型与 sandbox live。源码为 [round-07-review 最终散列](../round-07-review/final-source-sha256.txt)，运行环境与构建/依赖散列见该目录的 `environment.json`、`runtime-input-sha256.json`。固定任务和场景文件未修改。

命令：`WSL_APP_CONTROL_MODEL_LIVE=1 WSL_SBX_NAME=wsl-sbx-smoke-20261006 WSL_SBX_BIN=/opt/homebrew/bin/sbx WSL_APP_DEPENDENCY_ARCHIVE=<repo>/packaging/generated/runtime/template-dependencies.tar.gz WSL_APP_CONTROL_MODEL_EVIDENCE=<本目录> pnpm exec playwright test e2e/app-control-model-live.spec.ts`。pnpm 10.34.6；退出 0，1 passed，整体耗时 5.1 分钟，见 [playwright.log](playwright.log)。真实模型只执行一个 run，从北京时间 12:05:28 到 12:07:57，未触发 10 分钟模型等待上限。

| 身份 | 值 |
| --- | --- |
| sandbox | `wsl-sbx-smoke-20261006` |
| 新建项目 | `61988490-8a35-43ba-83cb-b9f633d1c275` |
| guest cwd | `/home/agent/workspace/.wsl-apps/61988490-8a35-43ba-83cb-b9f633d1c275` |
| TaskRun | `c2b34b22-6399-442f-be5f-0cdc039655b3` |
| Host 固定复验实例 | `cfcb6b13-89bf-46ea-b374-a9e2ae1d8dea` |

## 两类证据

模型通过正常产品 `confirmTask/startRun` 进入真实 guest Codex，没有拦截 send/cancel，没有伪造 guest app-call。模型只收到任务和允许范围，固定场景与参考实现未提供给模型。Main 审计与真实 MCP 完成事件确认 `app.describe`、`app.ui.snapshot`、`app.ui.act`、`app.state.read`、`app.data.query` 成功；UI 动作包括 type、click、waitFor、navigate。模型实际运行 `npm run check` 和 `npm run agent:check`，退出 0。重启期间两次快照返回 `app_not_running`，待实例恢复后成功，审计保留失败记录。

工具调用存在不能单独证明模型完整自验，因此结果字段明确保留 `modelFullSelfVerification=not_proven_by_tool_presence`。任务完成由独立 Host 验证佐证：模型正常结束并确认清理后，Host 停止该 App、重置该项目的数据、重新启动，再通过产品 WebContentsView 对应的 Playwright Page 严格执行冻结场景。它是测试内独立验收，不是产品检查器，也没有模拟活动 run 调用 `app.scenario.run`。全部 16 步通过，console 无错误；停止后的只读查询返回 `[{"value":"固定验收 2026"}]`。

结果见 [results.json](results.json)、[host-fixed-trace.json](host-fixed-trace.json)、[Main 审计](app-control/c2b34b22-6399-442f-be5f-0cdc039655b3/audit.jsonl) 和[实际 App 截图](fixed-welcome-saved.png)。主线程已查看截图和模型源码 diff。欢迎语空值分支在发起 PUT 前返回；新增可见卡片、输入框、保存按钮及状态符合本次固定任务。

## CLI 限制、改动与清理

真实命令沙箱内执行 `/bin/bash -lc 'wsl-app describe'` 返回退出码 3、`transport_unavailable`，原因是 Unix socket 不可达；真实 MCP 同链路成功。此项是已实测限制，不记为 CLI 入口通过，也不为通过而放宽 Codex 命令沙箱。完整任意 shell 输出未复制，结果保存其 SHA-256、退出码与错误分类。

模型仅改变 `src/App.tsx`、`agent/AGENTS.md`、`agent/app.manifest.json`，全部属于冻结允许范围。内容和散列保存在 `guest-source-before.json`、`guest-source-after.json`、`guest-source-final.json`；Host 复验没有修改模型源码。这些是独立 sandbox 项目中的样例，不写入本仓库模板。

本轮三个 App 实例使用的 guest 端口为 41547、39751、34143；清理后对应映射为空，该项目 cwd 下进程为空，App 为 stopped 且 `cleanupConfirmed=true`，Electron 已退出，`cleanupErrors=[]`。sandbox 原有配置在启动时重建两条 8081 映射，它们不属于本轮项目，保持原样。源码和历史证据保留；未提交、推送、发布或重新打包安装。
