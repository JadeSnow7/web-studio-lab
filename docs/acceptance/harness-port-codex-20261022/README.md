# W2 执行记录 · Harness 端口与 Codex 迁移

合同见 [SPEC](SPEC.md)。分支 `agent/harness-port-codex`，基于 `agent/project-write-lease`（W0）；起草时基于 `origin/main` `38af329`，2026-10-22 变基到 `ebf4391`（PR #17）。本记录只说明静态检查和离线测试结果，不代表真实 sandbox 复验或用户接受。

## 改动

| 路径                                                                                                       | 变化                                                                                                                               |
| ---------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------- |
| `packages/protocol/src/harness.ts`（新增）                                                                 | `HarnessDescriptor`、`HarnessRef`、`LEGACY_CODEX_HARNESS_REF`、`harnessRefOf`、`harnessDisplayName`                                |
| `packages/protocol/src/chat.ts`、`workspace.ts`、`run.ts`、`execution.ts`                                  | `ChatStatus.harness`、`WorkbenchRun.harness` 均为可选；`HarnessStatus` 与 `RunRecord` 的名称不再限定为 Codex，新增可选 `harnessId` |
| `apps/service/src/harness/types.ts`（新增）                                                                | `NativeHarnessAdapter` 契约与归一化事件                                                                                            |
| `apps/service/src/harness/codex/adapter.ts`（新增）                                                        | Codex 事件 schema、解析、MCP 输出裁剪逐字迁入；`argv`、描述符、事件映射                                                            |
| `apps/service/src/codex-chat.ts`                                                                           | 经适配器构造参数、解析输出；状态附带描述符；start 帧声明 `mcp`；错误文案以 `label` 拼接                                            |
| `apps/service/src/sbx.ts`、`guest-helper.py`                                                               | start 帧新增 `mcp`；helper 按声明挂载 MCP，不再识别 `argv[0]`                                                                      |
| `apps/desktop/src/main/chat-service.ts`、`workbench/ports.ts`、`host.ts`、`application.ts`、`execution.ts` | `harness()` / `currentHarness()`；`startRun` 冻结 HarnessRef                                                                       |
| renderer 7 个文件                                                                                          | 原先写死的“Codex CLI”标签改为读取执行记录或服务状态                                                                                |
| `apps/service/src/resource-mcp.live.test.ts`                                                               | live 用例的 start 帧补 `mcp` 声明（默认跳过）                                                                                      |

## 验收对应

| #      | 测试                                                                                 |
| ------ | ------------------------------------------------------------------------------------ |
| H1     | 既有测试全部原样通过（见下）                                                         |
| H2     | `apps/service/src/harness/codex/adapter.test.ts`                                     |
| H3、H4 | `codex-chat.test.ts`“Harness 端口（W2）”                                             |
| H5     | `guest-helper-mcp.test.ts`                                                           |
| H6     | `application.test.ts`“freezes the reported Harness…（W2）”“omits the Harness…（W2）” |
| H7     | `packages/protocol/src/harness.test.ts`                                              |

## 实际运行（2026-10-22，macOS）

环境：macOS 26.6.2（25G83）arm64，Node v26.5.0（产品期望 Node 24，本机实际版本如实记录），pnpm 10.34.6，Python 3.15.0，Electron 44.5.1。基线 `origin/main` `ebf4391`（PR #17），被测提交 `254453d`；之后的变基只在其下方加入 W0 执行记录、在其上方加入本记录，均为文档提交，代码未变。命令按交接清单逐项独立执行，单项失败不中断后续项。

| 命令                                                                                     | 结果                                                                                                                                                                                                                                                                                                                                  |
| ---------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `pnpm install --frozen-lockfile`                                                         | 通过                                                                                                                                                                                                                                                                                                                                  |
| `pnpm typecheck`                                                                         | 通过                                                                                                                                                                                                                                                                                                                                  |
| `pnpm exec eslint apps packages e2e scripts templates/standard-app`                      | 通过                                                                                                                                                                                                                                                                                                                                  |
| `pnpm exec prettier --check apps packages e2e scripts templates/standard-app`            | 通过                                                                                                                                                                                                                                                                                                                                  |
| `pnpm exec vitest run`                                                                   | 1293 通过、17 跳过、1 失败：`local-terminal-detached.test.ts` 的 “cleans an inherited owned child after fork, reparenting and setsid without claiming an OS sandbox” 在全量并行下一次失败（returncode 1）；本包未改动终端相关文件，单独重跑 5 次全部通过，记为负载下的间歇失败。`setup-adapter-failure.test.ts` 在 macOS 上运行并通过 |
| `pnpm test:packaging` / `test:external-builds` / `test:edu-source` / `baseline:selftest` | 40 / 6 / 57 / 12 项全部通过                                                                                                                                                                                                                                                                                                           |
| `node scripts/check-docs.mjs`                                                            | 通过                                                                                                                                                                                                                                                                                                                                  |
| `pnpm build`                                                                             | 通过                                                                                                                                                                                                                                                                                                                                  |
| `env -u ELECTRON_RUN_AS_NODE pnpm exec playwright test`                                  | 171 通过、16 跳过（8.1 分钟）；`status-surface.spec.ts` 全部通过，Codex 的显示名仍为 “Codex CLI”                                                                                                                                                                                                                                      |
| `git diff --check origin/main...HEAD`                                                    | 通过                                                                                                                                                                                                                                                                                                                                  |

- 变基冲突只在 `RunDetails.tsx` 与 `packages/protocol/src/index.ts` 的导入行，保留双方：PR #17 的 `CapturedSourceChange`/`PatchView` 与本包的 `harnessDisplayName`、`./harness` 导出。`application.ts` 的 `startRun` 自动合并，W0 许可检查与 HarnessRef 冻结均保留。
- 新增提交 `test(harness): run the guest helper MCP declaration test only on Linux`：helper 的 `read_start` 先拒绝非 Linux 主机并调用 `prctl`，macOS 上两个用例都先得到 “guest helper requires Linux”。改为与 `guest-workspace.test.ts` 相同的 `skipIf(process.platform !== 'linux')`，断言未改。因此这两项在 macOS 上跳过，只在 Linux 容器中运行过（2026-10-22，通过）。

以下容器结果保留为历史。

## 实际运行（2026-10-22，Linux x86_64 容器，Node 24.22.0，pnpm 10.34.6）

| 命令                                                                                       | 结果                                                                                                                                   |
| ------------------------------------------------------------------------------------------ | -------------------------------------------------------------------------------------------------------------------------------------- |
| `pnpm typecheck`                                                                           | 通过                                                                                                                                   |
| `pnpm exec eslint apps packages e2e scripts templates/standard-app`                        | 通过                                                                                                                                   |
| `pnpm exec prettier --check apps packages e2e scripts templates/standard-app` 及本目录文档 | 通过                                                                                                                                   |
| `pnpm exec vitest run`                                                                     | 1121 通过、16 跳过、1 失败：`setup-adapter-failure.test.ts` 的磁盘空间用例在 Linux 上先报 `unsupported-system`，未改动的基线上同样失败 |
| `pnpm test:packaging` / `test:external-builds` / `test:edu-source` / `baseline:selftest`   | 40 / 6 / 57 / 12 项全部通过                                                                                                            |
| `node scripts/check-docs.mjs`                                                              | 通过                                                                                                                                   |
| `pnpm build`                                                                               | 通过                                                                                                                                   |

## 未运行

- Electron E2E：容器中未运行；2026-10-22 已在 macOS 上运行，结果见上。打包后的 E2E 未运行。
- 真实 sbx guest 的无模型回归与真实模型对话：需要授权。
- `pnpm check` 全仓 lint / format：基线已有的历史失败，按 PR 门禁口径执行。

## 合并顺序

本分支包含 W0 的两个提交。建议按 W0 → W1 → W2 合并：本合同链接的 ADR-0003 与实施计划在 W1 中，W1 合并前这些链接不可用。
