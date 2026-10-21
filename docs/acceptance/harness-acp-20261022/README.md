# W3a 执行记录 · ACP 客户端与契约测试

合同见 [SPEC](SPEC.md)。分支 `agent/harness-acp`，基于 `agent/harness-port-codex`（W2）。本记录只说明静态检查和离线测试结果。

## 改动

| 路径                                           | 变化                                                                                                                        |
| ---------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------- |
| `apps/service/src/harness/acp/protocol.ts`     | ACP v1 的消息 schema 子集                                                                                                   |
| `apps/service/src/harness/acp/client.ts`       | 与传输无关的逐行 JSON-RPC 客户端：配对、回复 Agent 请求、边界校验、关闭后隔离                                               |
| `apps/service/src/harness/acp/turn.ts`         | `AcpTurn`：initialize → new/load → prompt → cancel，归一化为 HarnessEvent；默认拒绝的权限策略                               |
| `apps/service/src/harness/acp/agents.ts`       | `AcpAgentSpec`、Claude Code 启动描述（`claude-agent-acp`，`@agentclientprotocol/claude-agent-acp` 0.94.0）、`acpDescriptor` |
| `apps/service/src/fixtures/fake-acp-agent.mjs` | 确定性的假 ACP Agent，含 13 个场景                                                                                          |
| `apps/service/src/harness/acp/*.test.ts`       | 契约与客户端测试                                                                                                            |

产品代码没有引用以上模块，构建产物里的执行路径不变。

## 验收对应

`turn.test.ts`：A1–A8（含 Codex 与 ACP 共用的契约断言）；`client.test.ts`：JSON-RPC 配对、错误、边界与关闭；A9 见下方全量测试。

## 实际运行（2026-10-22，Linux x86_64 容器，Node 24.22.0，pnpm 10.34.6）

| 命令                                                                                       | 结果                                                                                                             |
| ------------------------------------------------------------------------------------------ | ---------------------------------------------------------------------------------------------------------------- |
| `pnpm typecheck`                                                                           | 通过                                                                                                             |
| `pnpm exec eslint apps packages e2e scripts templates/standard-app`                        | 通过                                                                                                             |
| `pnpm exec prettier --check apps packages e2e scripts templates/standard-app` 及本目录文档 | 通过                                                                                                             |
| `pnpm exec vitest run`                                                                     | 1142 通过、16 跳过、1 失败：`setup-adapter-failure.test.ts` 在 Linux 上先报 `unsupported-system`，基线上同样失败 |
| `pnpm test:packaging` / `test:external-builds` / `test:edu-source` / `baseline:selftest`   | 40 / 6 / 57 / 12 项全部通过                                                                                      |
| `node scripts/check-docs.mjs`                                                              | 通过                                                                                                             |
| `pnpm build`                                                                               | 通过                                                                                                             |

开发中发现并修复：最初轮次结束后迟到的未知响应仍会被判为协议违约；改为轮次结束时由 `AcpTurn` 关闭客户端，测试补了断言。

## 未运行与未实现

- 真实 Claude Code（`claude-agent-acp`）未运行：需要在 guest 安装并登录，属于 W3b，且需授权。
- guest helper 的 stdin 转发、执行核心接入、Main 审批：W3b。
- 实施计划中 W3 的拆分说明，待 W1 合并后在计划里同步。
