# W3a · ACP 客户端与契约测试（尚未接入产品）

状态：2026-10-22 用户“继续”授权实施。来源：[多 Harness 协作计划](../../plans/2026-10-21-multi-harness-collaboration.md) W3；设计依据为[多 Harness 协作设计](../../design/2026-10-21-multi-harness-collaboration.md) §4。基线：`agent/harness-port-codex`（W2）。

## 1. 拆分

计划中的 W3 拆成两步交付：

- **W3a（本包）**：ACP 协议客户端、轮次驱动、Claude Code 的启动描述，以及确定性的假 ACP Agent 和契约测试。这些代码还没有接入执行核心，产品行为不变。
- **W3b（下一包）**：guest helper 在轮次内双向转发 stdin（ACP 是长连接的 JSON-RPC，现有 helper 写完提示词就关闭子进程的 stdin）；执行核心按 HarnessBinding 选择 native 或 ACP；权限请求接入 Main 的审批；guest 准备脚本按固定版本安装 `@agentclientprotocol/claude-agent-acp`；然后用真实模型验收。

拆分的原因：stdin 转发要改 guest helper 的进程与清理逻辑，风险和验证方式都与协议客户端不同，分开更容易审阅和回退。

## 2. 协议依据

依据 agentclientprotocol.com 的 initialization、session-setup、prompt-turn、tool-calls 页面，以及官方 SDK `@agentclientprotocol/sdk` 2.0.0：

- 传输为 stdio 上逐行的 JSON-RPC 2.0（SDK 的 `ndJsonStream`），协议版本为 `1`。
- 本客户端使用：`initialize`、`session/new`、`session/load`、`session/prompt`、`session/cancel`（通知），处理 `session/update` 通知和 `session/request_permission` 请求。
- 客户端在 `initialize` 中声明**不提供** `fs` 与 `terminal`；Agent 调用这些方法时回复 -32601，并记一次警告。按 Lane 根目录限定的客户端文件能力留到 W5。

## 3. 行为

| 事项     | 规则                                                                                                                                                                                                  |
| -------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 版本     | `initialize` 返回的版本不是 1 即协议违约                                                                                                                                                              |
| 会话     | 有上一轮 sessionId 且 Agent 声明 `loadSession` 时用 `session/load`，回放的历史不进入本轮；否则新建会话并警告上下文不会带入                                                                            |
| 消息     | `agent_message_chunk` 按 `messageId` 合并；没有 messageId 的连续片段合并为一条；遇到工具调用或轮次结束时发出                                                                                          |
| 工具     | `tool_call` / `tool_call_update` 按 toolCallId 合并（`null` 表示不变）；完成或失败时发出记录，命令记为 `acp:<kind> <title>`，输出按单条 16000 字符裁剪；轮次结束时未完成的工具以 exitCode `null` 发出 |
| 其他更新 | 思考片段只计数；plan、命令列表、模式等已知类型静默忽略；`notice` 记为警告；未知类型每种只警告一次                                                                                                     |
| 权限     | 默认策略一律拒绝（优先 `reject_once`），策略可注入；策略抛错按 `cancelled` 回复                                                                                                                       |
| 停止原因 | `end_turn` 为完成；`cancelled` 只在本端请求取消后才算正常，否则记为失败；`max_tokens` / `max_turn_requests` / `refusal` 记为失败                                                                      |
| 取消     | 发 `session/cancel`，所有待决的权限请求回复 `cancelled`，然后等待 `session/prompt` 返回；进程退出确认由传输所有者负责（W3b 沿用现有清理回执）                                                         |
| 协议违约 | 非 JSON、非 JSON-RPC、未知响应身份、超长行、其他会话的更新、必需字段缺失，都抛出 `AcpProtocolError`，由调用方把轮次记为失败并关闭进程                                                                 |
| 迟到消息 | 轮次结束时关闭客户端，之后到达的更新和响应被隔离，不进入本轮，也不判为违约                                                                                                                            |
| 能力描述 | `acpDescriptor` 只依据本次 `initialize` 的回复（`capabilitySource: probed`）                                                                                                                          |

## 4. 验收

| #   | 场景                        | 期望                                                                                            |
| --- | --------------------------- | ----------------------------------------------------------------------------------------------- |
| A1  | Codex 与 ACP 共用的最小契约 | 先报会话身份、至少一条助手消息、以完成事件结束、无失败事件                                      |
| A2  | 消息、工具、未知更新        | 按上表合并与发出；未知类型只警告一次                                                            |
| A3  | 权限                        | 默认拒绝；注入策略可批准；策略抛错回复 cancelled                                                |
| A4  | 取消                        | 待决权限回复 cancelled，发出 session/cancel，cancelled 结束且不记失败；取消先于权限请求时也成立 |
| A5  | 会话恢复                    | 支持时走 session/load 且不回放历史；不支持时新建并警告                                          |
| A6  | 失败与违约                  | refusal、意外 cancelled 记为失败；版本、JSON、未知身份、其他会话判为违约                        |
| A7  | 未提供的客户端能力          | 回复 -32601 并警告                                                                              |
| A8  | 迟到消息                    | 被隔离，不报错                                                                                  |
| A9  | 产品回归                    | 既有测试原样通过；产品代码未引用新模块                                                          |

默认测试不调用模型；假 Agent 只用本机 Node 运行，不经过 sbx。
