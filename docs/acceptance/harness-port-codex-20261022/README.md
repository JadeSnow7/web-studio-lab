# W2 执行记录 · Harness 端口与 Codex 迁移

合同见 [SPEC](SPEC.md)。分支 `agent/harness-port-codex`，基于 `agent/project-write-lease`（W0）与 `origin/main` `38af329`。本记录只说明静态检查和离线测试结果，不代表真实 sandbox 复验或用户接受。

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

- Electron E2E：交给 macOS PR 门禁。界面上 Codex 的显示名仍为“Codex CLI”，`status-surface.spec.ts` 中的文案断言预期不变。
- 真实 sbx guest 的无模型回归与真实模型对话：需要授权。
- `pnpm check` 全仓 lint / format：基线已有的历史失败，按 PR 门禁口径执行。

## 合并顺序

本分支包含 W0 的两个提交。建议按 W0 → W1 → W2 合并：本合同链接的 ADR-0003 与实施计划在 W1 中，W1 合并前这些链接不可用。
