# W3b 执行记录 · ACP 接入执行核心与 Claude Code

合同见 [SPEC](SPEC.md)。分支 `agent/harness-acp-wiring`，基于 `agent/harness-acp`（W3a）。R1–R7 为离线结果；R8 需要在作者本机的 sbx 中执行，尚未运行。

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

## 未运行与未实现

- R8 未运行。
- Electron E2E：容器中未运行；2026-10-22 已在 macOS 上运行，结果见上。打包后的 E2E 未运行。
- 打包安装器的 guest 载荷、W4 的 Profile 与选择器、逐项审批界面。
