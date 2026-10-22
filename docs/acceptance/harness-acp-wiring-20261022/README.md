# W3b 执行记录 · ACP 接入执行核心与 Claude Code

合同见 [SPEC](SPEC.md)。分支 `agent/harness-acp-wiring`，基于 `agent/harness-acp`（W3a）。R1–R7 为离线结果；R8 已于 2026-10-22 在作者本机的 sbx 中运行，结果见“R8 实际运行”。

## 改动

| 路径                                                               | 变化                                                                                   |
| ------------------------------------------------------------------ | -------------------------------------------------------------------------------------- |
| `apps/service/src/guest-helper.py`                                 | `stdin: 'relay'`、`input` / `input-end` 转发；`mcp: 'acp-stdio'` 发出 `mcp-server` 帧  |
| `apps/service/src/sbx.ts`                                          | start 帧新字段、`mcp-server` 帧 schema、`writeInput`（按 60000 字节分块）与 `endInput` |
| `apps/service/src/codex-chat.ts`                                   | `ChatHarness`；ACP 轮次、可用性探测、审批策略接线；会话 `fresh` 时替换身份             |
| `apps/service/src/harness/acp/policy.ts`                           | `workspaceWritePolicy`                                                                 |
| `apps/service/src/harness/registry.ts`、`index.ts`                 | `WSL_HARNESS` 选择                                                                     |
| `apps/service/src/harness/acp/turn.ts`、`harness/types.ts`         | 导出 initialize 参数；`session` 事件的 `fresh` 标记                                    |
| `e2e/fixtures/sbx.mjs`                                             | fixture sbx 支持 relay：在本机启动 argv 指定进程并转发输入                             |
| `scripts/sbx-prepare-guest.sh`、`docs/development/dependencies.md` | 加装并核对 `claude-agent-acp` 0.94.0                                                   |

## 验收对应

| #     | 测试                                                                  |
| ----- | --------------------------------------------------------------------- |
| R1–R3 | `apps/service/src/guest-helper-relay.test.ts`                         |
| R4–R6 | `apps/service/src/codex-chat.test.ts`“ACP Harness 经执行核心（W3b…）” |
| R7    | 全量测试                                                              |

## 实际运行（2026-10-22，macOS）

环境：macOS 26.6.2（25G83）arm64，Node v26.5.0（产品期望 Node 24，本机实际版本如实记录），pnpm 10.34.6，Python 3.15.0，Electron 44.5.1。基线 `origin/main` `ebf4391`（PR #17），被测提交 `03fea41`；之后的变基只在其下方加入 W0、W2、W3a 的执行记录、在其上方加入本记录，均为文档提交，代码未变。命令按交接清单逐项独立执行，单项失败不中断后续项。

| 命令                                                                                     | 结果                                                                                                                                                                                                                                                                           |
| ---------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `pnpm install --frozen-lockfile`                                                         | 通过                                                                                                                                                                                                                                                                           |
| `pnpm typecheck`                                                                         | 通过                                                                                                                                                                                                                                                                           |
| `pnpm exec eslint apps packages e2e scripts templates/standard-app`                      | 通过                                                                                                                                                                                                                                                                           |
| `pnpm exec prettier --check apps packages e2e scripts templates/standard-app`            | 通过                                                                                                                                                                                                                                                                           |
| `pnpm exec vitest run`                                                                   | 1325 通过、22 跳过、1 失败：`setup-adapter.test.ts` 的 “accepts actual sanitized sbx inspect shape, rejects mounts and daemon drift” 在全量并行下超过 5 秒超时；未改动的 `origin/main` `ebf4391` 上同样超时，与本包无关。`setup-adapter-failure.test.ts` 在 macOS 上运行并通过 |
| `pnpm test:packaging` / `test:external-builds` / `test:edu-source` / `baseline:selftest` | 40 / 6 / 57 / 12 项全部通过                                                                                                                                                                                                                                                    |
| `node scripts/check-docs.mjs`                                                            | 通过                                                                                                                                                                                                                                                                           |
| `pnpm build`                                                                             | 通过                                                                                                                                                                                                                                                                           |
| `env -u ELECTRON_RUN_AS_NODE pnpm exec playwright test`                                  | 第一次：135 通过、36 失败、16 跳过（12.3 分钟）；独立复跑：171 通过、16 跳过（7.0 分钟）。见下                                                                                                                                                                                 |
| `git diff --check origin/main...HEAD`                                                    | 通过                                                                                                                                                                                                                                                                           |

- E2E 第一次运行的 36 个失败（编号 9–51 连续一段，含 branding、chat、debug-status、installer、p0-run-diff、public-document、resources、review-regressions）全部在 `e2e/helpers.ts:118` 的 `ensureForeground` 处失败：“The owned E2E workbench window must be visible and natively focused”，10 秒内窗口未取得原生前台焦点，测试主体尚未开始；这段时间本机桌面上有其他应用取得焦点。同一构建、同一提交在不切换前台的情况下独立复跑，171 项全部通过。两次的日志与第一次的 `test-results` 只保存在本机，未入库。
- 本分支提交在变基时没有冲突。

以下容器结果保留为历史。

## 实际运行（2026-10-22，Linux x86_64 容器，Node 24.22.0，pnpm 10.34.6，Python 3）

| 命令                                                                                     | 结果                                                                                                             |
| ---------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------- |
| `pnpm typecheck`                                                                         | 通过                                                                                                             |
| `pnpm exec eslint apps packages e2e scripts templates/standard-app`                      | 通过                                                                                                             |
| `pnpm exec prettier --check apps packages e2e scripts templates/standard-app` 及相关文档 | 通过                                                                                                             |
| `pnpm exec vitest run`                                                                   | 1157 通过、16 跳过、1 失败：`setup-adapter-failure.test.ts` 在 Linux 上先报 `unsupported-system`，基线上同样失败 |
| `pnpm test:packaging` / `test:external-builds` / `test:edu-source` / `baseline:selftest` | 40 / 6 / 57 / 12 项全部通过                                                                                      |
| `node scripts/check-docs.mjs`                                                            | 通过                                                                                                             |
| `pnpm build`                                                                             | 通过                                                                                                             |

全量测试中暴露并修复两处问题：

- `observation-socket.test.ts` 会单独抽出 helper 的 stdin 解析分支执行，新条件先求值 `relay` 导致名称未定义；改为先判断帧类型，既有测试不改。
- ACP 的 prompt 响应与迟到更新同批到达时，迟到片段被拼进消息。修复放在 W3a 分支（`fix(harness): isolate ACP updates that follow the prompt response`），本分支变基其上。

## R8 真实模型验收步骤（作者本机）

1. 在 guest 中重新执行准备脚本：`env -u SSH_AUTH_SOCK sbx exec -i "$WSL_SBX_NAME" bash < scripts/sbx-prepare-guest.sh`，最后一行应输出 `0.94.0`。
2. 在 Lab 的 sandbox 终端里登录 Claude：`claude-agent-acp --cli auth login --claudeai`（订阅）或 `--console`（API 计费），按提示在浏览器完成。
3. 确认 sbx 的网络策略允许 guest 访问 Anthropic 的服务；被拦截时探测会通过、对话会失败，错误会显示在会话里。
4. 以 `WSL_HARNESS=claude-code WSL_SBX_NAME=<sandbox> pnpm dev` 启动：设置页与标题栏应显示 “Claude Code”，版本为 Agent 报告的版本。
5. 跑一次手帐场景（生成 → 保存 → 刷新 → 四个字段核对），执行详情中的 Harness 应为 Claude Code；再以缺省（不设 `WSL_HARNESS`）跑一次，应为 Codex CLI。
6. 记录两次的执行 ID、会话警告（特别是被拒绝的权限）与结果，补入本记录。

## R8 实际运行（2026-10-22，macOS，作者在场）

环境：macOS 26.6.2 arm64，sbx v0.47.0，sandbox `wsl-sbx-smoke-20261006`（Codex 模板创建）。代码为本分支被测提交 `03fea41`（与上文 macOS 检查相同，之后只有文档提交）。Lab 以 `pnpm dev` 开发路径运行，未用打包安装器。界面操作由作者完成，本 Agent 只读核对执行记录、guest 源码和 App 数据。

### 准备

| 步骤        | 实际结果                                                                                                                                                                                                                                                                                                                                                                                                                                                               |
| ----------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 1. 准备脚本 | `env -u SSH_AUTH_SOCK sbx exec -i wsl-sbx-smoke-20261006 bash < scripts/sbx-prepare-guest.sh` 退出 0，最后一行 `0.94.0`；同时报告 Node v24.21.0、codex-cli 0.160.0、pnpm 10.34.6                                                                                                                                                                                                                                                                                       |
| 2. 网络策略 | kit 策略只放行 OpenAI、GitHub、npm、Ubuntu 等，`api.anthropic.com`、`claude.ai`、`console.anthropic.com`、`platform.claude.com` 均为默认拒绝。经作者同意，加了仅作用于该 sandbox 的 local 放行规则：上述四个主机，以及登录时被 `browser-open` 拦下的 `claude.com:443`，全部为 `:443`                                                                                                                                                                                   |
| 3. 登录     | 作者在 Lab 的 sandbox 终端执行 `claude-agent-acp --cli auth login --claudeai`。第一次：`browser-open` 访问 `claude.com` 被拦，作者改为手动打开链接（其间 Lab 内置浏览器打开授权地址报 `ERR_FAILED`），粘贴后三次 “Invalid code”，再次执行得到 `Request failed with status code 400`；policy log 显示令牌交换已到达 `platform.claude.com`，400 来自服务端，判断为手动复制时授权码或链接不完整（未进一步验证）。放行 `claude.com` 后重试成功，此后 policy log 无新的拦截 |

登录过程中作者打开的授权地址被 Lab 记为空间网页资源，写入本机 `workbench.json`；其中只有一次性的 `code_challenge` 与 `state`，不含令牌。未读取或复制登录凭据。

### 两次运行

两次使用同一目标文本，均新建空间与标准 App，确认任务时未选择 App 页面作为执行目标：

> 把这个 App 改成手帐：左侧月历，右侧正文，并有心情、标签与来源字段；本地保存，刷新或重开同一日期后显示相同内容。只修改这个 App 的项目。

| 项                                                             | Claude Code（`WSL_HARNESS=claude-code`）                                                                                                                                                                                               | Codex（缺省）                                                                                                                                                                                         |
| -------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| runId                                                          | `8cb50204-c0f4-403c-886c-f7beb615af5a`                                                                                                                                                                                                 | `7aecc26f-c7c0-431c-8bf1-9a9af804d9c5`                                                                                                                                                                |
| 执行记录中的 Harness                                           | `claude-code` / Claude Code / `acp` / `0.94.0`                                                                                                                                                                                         | `codex` / Codex CLI / `native` / `codex-cli 0.160.0`                                                                                                                                                  |
| 时长（UTC）                                                    | 07:00:44 → 07:15:35                                                                                                                                                                                                                    | 08:42:43 → 08:50:14                                                                                                                                                                                   |
| 结果                                                           | `completed`，`cleanupPending: false`，执行器 `idle`                                                                                                                                                                                    | 同左                                                                                                                                                                                                  |
| validation / review                                            | `not_run` / `null`                                                                                                                                                                                                                     | 同左                                                                                                                                                                                                  |
| 会话警告                                                       | 1 条：`ACP 未识别的通知：_auth/status_update`；无被拒绝的权限                                                                                                                                                                          | 1 条：Codex 忽略 guest `~/.codex/config.toml` 中 `mcp_servers.mcp-gateway` 的 2 项设置（guest 环境配置）                                                                                              |
| 工具调用                                                       | 42 次，失败 5 次：4 次 `app_ui_act` 点击返回 `No node found at given location`；1 次 `sleep 45; echo done` 被 Claude Code 自身的工具守卫拦截                                                                                           | 47 次（其中 `app_ui_act` 17 次），失败 9 次：3 次同样的 `No node found at given location`；其余为 Codex 自行试错（参数不符合 schema、类型错误、非 git 目录的 `git status`），随后改正                 |
| 源码改动（guest 导出后与 `templates/standard-app` 逐文件比较） | 改 `server/app.ts`、`server/schema.ts`、`src/App.tsx`、`src/agent/commands.ts`、`migrations/meta/_journal.json`、`agent/AGENTS.md`、`agent/app.manifest.json` 及 3 个测试；新增 `migrations/0001_journal.sql`、`tests/journal.test.ts` | 改 `src/App.tsx`、`src/styles.css`、`agent/AGENTS.md`、`agent/app.manifest.json`                                                                                                                      |
| App 目录之外                                                   | 运行时间窗内 guest 工作区无其他文件改动                                                                                                                                                                                                | 同左                                                                                                                                                                                                  |
| 持久化方式                                                     | App 数据库新表 `journal_entries`，`/api/journal` 读写                                                                                                                                                                                  | 页面 `localStorage`（键 `daybook.7fb804b1.entries.v1`），未使用 App 数据库                                                                                                                            |
| 保存 → 刷新 → 四字段                                           | 作者在 2026-10-08 以虚构内容经鼠标保存并 ↻ 刷新；只读 `GET /api/journal/2026-10-08` 逐字段一致：正文、心情 `happy`（界面“开心”）、标签 `["测试","散步"]`、来源 `虚构来源 R8-Claude`                                                    | 作者报告：在 2026-10-08 以虚构内容（来源 `虚构来源 R8-Codex`）经鼠标保存，↻ 刷新后重新点选 8 日，四字段一致。**作者观察，无截图、无独立读取**：数据只在 Lab 页面的内存会话中，本 Agent 无法从磁盘读取 |

补充事实：

- Claude Code 一轮中 Agent 自行在 2026-10-22 保存过测试数据；作者的核对使用 2026-10-08。作者第一次报告保存时数据库并无 10-08 记录，截图显示页面仍停在 10-22，重做后才写入；之后两条记录的 `updatedAt` 又各被刷新一次（内容不变），按原样记录。
- Codex 一轮中作者第一次刷新后的截图显示“这个月，留下了 0 天的足迹”，当时无法区分未保存与刷新丢失；作者重做后报告刷新后四字段一致，未提供截图。
- 两次的 `sourceChange` 均为 `unavailable`（“任务未绑定受管 App 工程”），因为任务版本的 `appTarget`/`targetRef` 为 `null`；源码改动由上表的 guest 导出比较得出，不是产品内采集结果。
- `app_ui_act` 点击失败在两种 Harness 下都出现，原因未定位（推测与页面视图当时不可见或尺寸为零有关，未验证），不归因于 Harness。
- App 页面的浏览器分区为 `'preview-' + workspaceId + '-' + resource.instanceId`（`apps/desktop/src/main/workbench/host.ts`），没有 `persist:` 前缀，属于内存会话。因此 Codex 选择的 `localStorage` 只在本次 Lab 运行期间、同一页面实例内保留，Lab 退出或实例更替后丢失；本轮未验证这一点，记为产品风险。
- 两次结论限定为：执行记录中的 Harness 分别为 Claude Code 与 Codex CLI；生成、保存、刷新在本 sandbox、本代码版本下跑通各一次（Codex 一轮的四字段为作者观察）。不代表独立验收通过或用户接受。

## 未运行与未实现

- R8 只覆盖下文所列的一次 Claude Code 与一次 Codex 运行；未覆盖 Lab 重启后的数据保留、受管 App 绑定为执行目标的情形，以及打包安装器路径。
- Electron E2E：容器中未运行；2026-10-22 已在 macOS 上运行，结果见上。打包后的 E2E 未运行。
- 打包安装器的 guest 载荷、W4 的 Profile 与选择器、逐项审批界面。
