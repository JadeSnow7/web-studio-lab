# 多 Harness 协作实施计划

状态：**执行中，2026-10-22**。W0 已在 `agent/project-write-lease` 实现（执行记录见该分支的 `docs/acceptance/project-write-lease-20261021/README.md`）；W1 即本范围文档变更。已定：在 Lab 实现（D1）；换 Harness 不影响验证适用性（D6）；2026-10-16 计划去重（D7）。设计见[多 Harness 协作设计](../design/2026-10-21-multi-harness-collaboration.md)，决策见 [ADR-0003](../architecture/adr/0003-pluggable-harness-and-collaboration.md)。开工时以届时最新的 `origin/main` 为基线（起草时为 `c4ad991`），先重新核对设计 §1 的耦合点表。

流程沿用 [AGENTS.md](../../AGENTS.md) 与 [CONTRIBUTING.md](../../CONTRIBUTING.md)：明确验收 → 最小实现 → 针对性验证 → 审阅交付。每个工作包一个小 PR，分支 `agent/<topic>`；执行结束、验证通过、用户接受分别记录。默认测试不调用模型；真实模型与 sandbox live 用例需单独授权。

## 工作包

| #   | 分支                          | 内容                                                                                                                                                                                                   | 依赖                 | 验收                                                                                                                                                                                   |
| --- | ----------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ | -------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| W0  | `agent/project-write-lease`   | 项目级写入许可：同一 `(projectId, laneId)` 只有一个持有者；串行模式 `laneId = main`                                                                                                                    | —                    | 两个会话对同一项目先后启动执行，第二个被明确拒绝；取消未确认时许可不释放；现有串行用例全部通过                                                                                         |
| W1  | `agent/adr-0003-scope`        | 只改文档：ADR-0003 定稿，修改 AGENTS.md 范围条款、ARCHITECTURE §1/§2/§5；去重后的 2026-10-16 评审后计划一并入库；把新文档加入 `scripts/check-docs.mjs` 列表                                            | 用户采纳设计         | `node scripts/check-docs.mjs` 通过                                                                                                                                                     |
| W2  | `agent/harness-port-codex`    | `AgentHarness` 端口与 `HarnessDescriptor/HarnessRef` 协议；Codex 迁入 `apps/service/src/harness/codex/`，行为不变；协议 `'Codex CLI'` 字面量迁移；界面标签改为实际 Harness；helper 改为显式 MCP 配置帧 | W0、W1               | 现有 codex-chat、argv、MCP、取消相关测试原样迁移并通过；旧持久记录迁移测试；sbx 无模型 live 回归通过                                                                                   |
| W3  | `agent/harness-acp`           | 通用 ACP 客户端适配器：`initialize` 能力探测、`session/new` 传 MCP、`session/update` 归一化、`session/request_permission` 进 Main、`fs/*` 限定 Lane 根、取消后确认进程树退出；首个目标 Claude Code     | W2                   | 用确定性的假 ACP agent fixture 跑契约测试（事件归一化、权限拒绝、取消、迟到响应隔离），与 Codex 共用一套断言；授权后手帐场景在 Codex 与 Claude Code 下各跑通一次真实模型，回执结构一致 |
| W4  | `agent/harness-profiles`      | Profile 管理：环境内 `configDir`、无模型自检、每 Profile 并发上限、配额/认证失败的明确报错；设置页 Harness 与 Profile 列表                                                                             | W2                   | 同一 Harness 两个 Profile 分别自检；凭据不出现在日志、DTO 与持久化文件中（测试扫描）；配额失败不自动换 Profile                                                                         |
| W5  | `agent/lanes-merge`           | Lane 创建（目录复制或 git worktree，二选一后记录理由）、每 Lane 写入许可与 AppInstance、三方合并核心从 `edu-source` 抽出、合并与冲突视图                                                               | W0、W2               | 两个 Lane 并行修改同一项目：无重叠时合并成功；重叠时报告冲突且主工作树不变；合并后旧验证变为不适用；edu-source 现有测试不变                                                            |
| W6  | `agent/multi-proposal`        | 多方案竞标：一个 TaskVersion 派给 N 个 Bot/Harness，各自 Lane 并行，并列展示验证与 diff，用户选择合并                                                                                                  | W3、W5               | 两个 Harness 的竞标用 fixture 跑通；授权后真实模型各跑一次                                                                                                                             |
| W7  | `agent/context-board`         | Board、ContextItem、Handoff；`context_*` MCP 工具；文件退化路径；注入预算                                                                                                                              | W2                   | 实现 → 审阅交接：审阅执行只凭 Handoff 和快照完成；作者身份不可伪造（内容自称不同身份时仍按 scope 记录）；跨 Agent 内容中的指令不改变权限（负例测试）                                   |
| W8  | `agent/bots-meetings`         | Bot 定义与版本；会议：议程、确定性主持、轮次与字符预算、发言格式校验、DecisionRecord、任务草稿确认                                                                                                     | W7                   | 一场两议题、三 Bot 的评审会用 fixture 跑通；格式不合法发言记为失败不重试；任务草稿未确认时不产生 TaskVersion                                                                           |
| W9  | `agent/harness-gemini-cursor` | 在 ACP 适配器上接入 Gemini CLI、Cursor，补实测能力矩阵                                                                                                                                                 | W3                   | 每个 Harness 的自检记录与能力声明；能力不足的功能在发送前拒绝                                                                                                                          |
| W10 | `agent/harness-remote`        | remote 适配器（Devin 云端交接等）：逐任务外发授权、回执记录、补丁经 W5 合并、Lab 重新验证                                                                                                              | W5，单独 SPEC 与授权 | 另立合同                                                                                                                                                                               |

## 建议节奏

- 展示前：W0、W1、W2，以及 W3 的 fixture 契约部分。它们取代 2026-10-16 计划原第 8–10 项（该计划已去重）。
- 展示后：W3 真实模型验收、W4、W5、W6，然后 W7、W8，最后 W9、W10。

## 每个工作包的交付说明

沿用 AGENTS.md 交付要求：改动路径、行为与约定变化、实际运行的命令及结果、未运行的原因、未实现项；静态检查、实际运行和用户接受分开说明。

## 2026-10-25 编号与状态协调（本轮整合说明）

上文状态、基线、时间节奏和 PR 建议保留 2026-10-22 原计划语境；不是本次重新开工指令。本文所有原 Wn 均为 MHC-Wn，Workflow 计划编号写为 WF-Wn。

- MHC-W0/W2/W3/W4 已有对应源码和各自历史记录；本次须在整合源码上复验，不能由计划或历史通过状态推定当前接受。
- MHC-W5 的完整 Lane/AppInstance 与 MHC-W6 多方案竞标未被 WF-W8 固定波次候选替代。
- MHC-W7 Board/Handoff、MHC-W8 Bot/会议仍为后续目标。
- MHC-W9 Gemini/Cursor、MHC-W10 remote 与 WF-W9 Ultra 均不在本次实施范围。WF 的 E8 真实矩阵未做，P2/P3 整阶段不据离线结果通过。

普通会话与 Workflow 隔离矩阵须分开：前者接 Codex native / Claude Code ACP，后者的实际隔离适配器仅 Codex native；已取得的历史真实运行证据仅覆盖 `codex:default`，当前候选未做真实多 Profile 矩阵验收；成员表由 Main 每次受理时冻结的 Profile 快照生成。职责和来源协调见 [ADR-0003 附录](../architecture/adr/0003-pluggable-harness-and-collaboration.md)；本协调说明不新增真实模型、sandbox live 或发布授权。
