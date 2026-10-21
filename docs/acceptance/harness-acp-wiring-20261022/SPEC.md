# W3b · ACP 接入执行核心与 Claude Code

状态：2026-10-22 用户“授权继续”，包括在 guest 准备脚本中按固定版本安装 Claude Code 的 ACP 包装器，以及真实模型验收。基线：`agent/harness-acp`（W3a）。

## 1. 范围

1. **guest helper 的 stdin relay**：start 帧 `stdin: 'relay'` 时保持子进程 stdin 打开，经 `input` 帧转发、`input-end` 帧在写完排队输入后关闭 stdin；relay 不携带 `prompt`。非 relay 进程拒绝 `input-end`。终端与 Codex 路径不变。
2. **MCP 挂载方式 `acp-stdio`**：helper 照常准备资料包、观察 socket 与 `wsl-app` CLI，但不改 argv，而是在启动 Agent 之前发出 `mcp-server` 帧（`wsl_space`，python3 的绝对路径与参数）。执行核心把它放进 `session/new` / `session/load` 的 `mcpServers`。
3. **执行核心**：`CodexChat` 接受 `ChatHarness`（native 或 acp）。ACP 轮次：以 relay 启动 Agent → 收到 `ready` 后由 `AcpTurn` 驱动 → 归一化事件进入同一套会话、工具、警告记录 → prompt 返回后 `input-end`，Agent 自行退出，沿用现有清理回执判定。取消沿用现有路径：中止信号使 `AcpTurn` 发出 `session/cancel`，随后关闭进程并确认清理。
4. **可用性探测**：ACP Harness 初始化时在 guest 内启动 Agent，只发 `initialize`（不调用模型），能力与版本取自回复；失败或清理未确认时状态为不可用并说明原因。
5. **审批策略**：`workspaceWritePolicy` 与 Codex `--sandbox workspace-write` 对等：读、写、删、移动、搜索、执行、思考及其他工具（含 wsl_space MCP）放行一次；`fetch`、`switch_mode` 与未知类型拒绝，并在会话警告中记录。隔离边界仍是 sbx guest。逐项交给用户审批属于 W4。
6. **Harness 选择**：W4 之前用开发期环境变量 `WSL_HARNESS`（`codex` 缺省，`claude-code`）。未知取值启动即报错。
7. **guest 准备脚本**：加装 `@agentclientprotocol/claude-agent-acp@0.94.0` 并核对版本。认证不在脚本里处理。

## 2. 不在本包

- 打包安装器的 guest 载荷（`setup.ts` 中的版本字面量与 runtime 依赖清单）：仍只含 Codex，随打包工作另行处理；本包只覆盖开发路径。
- Profile 与界面选择器、逐项审批界面（W4）。
- sbx 网络策略：Claude Code 需要访问 Anthropic 的服务，guest 网络策略是否放行由用户在本机确认。

## 3. 验收

| #   | 场景                         | 期望                                                                                                                   | 方式                               |
| --- | ---------------------------- | ---------------------------------------------------------------------------------------------------------------------- | ---------------------------------- |
| R1  | 真实 helper relay            | 一轮 ACP 往返完整；`input-end` 后 Agent 自行退出，清理确认                                                             | 本机 Python 运行 helper + 假 Agent |
| R2  | `acp-stdio`                  | `mcp-server` 帧先于 `ready`，命令为绝对路径                                                                            | 同上                               |
| R3  | 非法声明                     | 未知 stdin 模式、relay 携带 prompt、非 relay 进程收到 `input-end` 均拒绝                                               | 同上                               |
| R4  | 执行核心一轮                 | 消息、工具、警告进入会话；start 帧为 relay + acp-stdio 且不含 prompt；正常完成并确认清理                               | fixture sbx + 假 Agent             |
| R5  | 探测                         | 只发 initialize，状态报告实测能力与版本；Agent 不可启动时不可用并说明原因，发送被拒绝                                  | 同上                               |
| R6  | 策略、恢复、取消、失败       | 编辑权限自动放行；不支持 loadSession 时换新会话不判冲突；取消后状态为 cancelled 且清理确认；refusal 与协议错误记为失败 | 同上                               |
| R7  | Codex 回归                   | 既有测试原样通过                                                                                                       | 全量测试                           |
| R8  | 真实模型（需用户在本机执行） | `WSL_HARNESS=claude-code` 与缺省 Codex 下各跑通一次手帐场景，执行记录中的 Harness 分别为 Claude Code 与 Codex CLI      | 见执行记录中的步骤                 |
