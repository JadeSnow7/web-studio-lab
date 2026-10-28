# W2 · Harness 端口与 Codex 迁移（行为不变）

状态：2026-10-22 用户“确认后展开下一步”授权实施。来源：[多 Harness 协作计划](../../plans/2026-10-21-multi-harness-collaboration.md) W2；决策见 [ADR-0003](../../architecture/adr/0003-pluggable-harness-and-collaboration.md)。基线：`agent/project-write-lease`（W0）之上，`origin/main` `38af329`。

## 1. 目标

把 Codex 专有的参数构造、事件解析和 MCP 挂载方式从执行核心里分离出来，为 W3 的 ACP 适配器留出同一个接口；对用户和现有测试，行为不变。

## 2. 范围

1. **协议**：新增 `packages/protocol/src/harness.ts`：`HarnessDescriptor`（身份、显示名、适配器类型、探测版本、能力、能力来源）、`HarnessRef`（执行冻结的出处）、`LEGACY_CODEX_HARNESS_REF` 与显示名辅助函数。`HarnessStatus.name` 与 `RunRecord.harness.name` 不再限定为 `'Codex CLI'`，新增可选 `harnessId`。
2. **service 适配器契约**：`apps/service/src/harness/types.ts` 定义 `NativeHarnessAdapter` 与归一化事件（`session`、`message`、`warning`、`tool`、`turn_completed`、`turn_failed`）。执行核心只消费归一化事件。
3. **Codex 适配器**：`apps/service/src/harness/codex/adapter.ts`。原 `EventSchema`、`parseCodexLine`、`boundedMcpOutput` 逐字迁入，`argv` 与迁移前逐项一致；能力按已有真实验证记录声明（`capabilitySource: 'declared'`），版本沿用 sbx 连接检查的实际探测结果。`codex-chat.ts` 继续导出 `parseCodexLine`，现有测试不改。
4. **执行核心**：`CodexChat` 通过注入的适配器构造参数、解析输出；错误文案以适配器的 `label` 拼接，Codex 下与迁移前逐字相同。`getStatus()` / `initialize()` 附带 `harness` 描述符。类名与文件名暂不改动，W3 再更名。
5. **显式 MCP 挂载**：start 帧新增 `mcp: 'codex-config'`，由适配器声明。`guest-helper.py` 不再用 `argv[0] == "codex"` 判断能否挂载资料包与 MCP；携带资料包但未声明时拒绝，未知声明在预检阶段拒绝。
6. **Main 与界面**：`ChatService.harness()` 返回服务报告的描述符；`WorkbenchRuntime.currentHarness()` 在 `startRun` 时把 `HarnessRef` 冻结进 `WorkbenchRun.harness`。界面上原先写死的“Codex CLI”标签改为读取执行记录或服务状态；无报告时仍显示“Codex CLI”。

## 3. 兼容与迁移

- 旧执行记录没有 `harness` 字段，读取时按 `LEGACY_CODEX_HARNESS_REF` 解释（Codex CLI native），不改写持久数据。
- 旧版 `HarnessStatus` / `RunRecord` 不带 `harnessId` 仍可解析。
- 验证适用性不随 Harness 变化（设计 D6），本包不改验证逻辑。

## 4. 不在本包

- ACP 适配器与 Claude Code 接入（W3）。
- Profile、Harness 选择器（W4）。
- `SbxConnection` 中 `codex --version` 探测与 `agent: 'codex'` 的 sandbox 校验、`setup.ts` 中 guest `codex` 版本字面量：属于运行环境准备，随 W3/B2 调整。
- start 帧的 `mode: 'codex'`：它是“非终端进程”传输模式（受管 App 的 npm 命令也用它），不是 Harness 身份，本包不改名。

## 5. 验收

| #   | 场景                                  | 期望                                                                       |
| --- | ------------------------------------- | -------------------------------------------------------------------------- |
| H1  | 现有 service、Main、renderer 单元测试 | 原样通过，不修改既有断言                                                   |
| H2  | Codex 适配器                          | 参数与迁移前逐项一致；每类事件映射正确；字段缺失抛出与迁移前相同的错误文案 |
| H3  | 对话状态                              | 报告 `harnessId: 'codex'` 描述符，版本与连接检查一致                       |
| H4  | start 帧                              | 携带 `mcp: 'codex-config'`，参数由适配器构造                               |
| H5  | guest helper                          | 有资料包无声明时拒绝且不启动子进程；未知声明预检拒绝                       |
| H6  | 执行记录                              | `startRun` 冻结服务报告的 HarnessRef，之后变化不影响；无报告时不写该字段   |
| H7  | 旧记录                                | 不带 harness 的执行记录可读，显示为 Codex CLI                              |

默认测试不调用模型。真实 sbx guest 下的无模型回归需要授权，不属于本包完成条件。
