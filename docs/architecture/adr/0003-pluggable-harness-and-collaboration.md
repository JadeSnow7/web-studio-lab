# ADR-0003：可插拔 Harness、Profile 与多 Agent 协作

状态：**已采纳，2026-10-21**。适用范围：[多 Harness 协作设计](../../design/2026-10-21-multi-harness-collaboration.md)全部阶段；[AGENTS.md](../../../AGENTS.md) 与 [ARCHITECTURE.md](../../ARCHITECTURE.md) 的范围条款已据此修改。

## 背景

产品定位已经扩展为 AI 浏览器加全栈开发工作台，底层不应绑定 Codex + sbx。当前实现中 Harness 名称在协议里写死为 `'Codex CLI'`，参数构造、事件解析和 MCP 注入都只认 Codex；执行并发只按会话限制，同一项目的两个会话可以同时写入同一 guest 目录，ARCHITECTURE §5 的项目统一写入控制尚未实现。用户希望接入多种 Harness，支持多账号和并行，并让不同 Bot 协作、开会、共享上下文。

## 决定

1. **一个 `AgentHarness` 端口，四类适配器**：`native`、`acp`、`pty-only`、`remote`。ACP 是新 Harness 的首选通路；Codex 现有 native 路径原样迁移，作为回归基线。能力只来自实际探测，不按文档假设。
2. **Profile 只引用环境内的配置目录，Lab 不经手凭据**。登录由用户在该环境内用 CLI 自己的流程完成。同一服务商的多个 Profile 之间不自动轮换。
3. **并行靠隔离副本，不放开写入锁**。先补项目级写入许可；每个写入执行在自己的 Lane 上持有许可；主工作树只接受三方合并，冲突交用户。
4. **Agent 之间不直接通信**。会议、交接和看板内容都经 Main 记录后按冻结范围分发；所有跨 Agent 内容是不可信数据，不能授予权限。
5. **会议是结构化流程**：议程、确定性主持、轮次与字符预算、固定发言格式；会议只读，产出的任务草稿须用户确认。
6. **编排逻辑仍只在 Main 一处**。Harness 注册表、Profile、Bot、Lane、Board 的权威状态都在 Main WorkbenchApplication；service 只承载适配器与所属进程。

## 备选与理由

- **为每个 CLI 写专用解析器**：控制最细，但维护量随 Harness 数量线性增长，且多数目标 Harness 已支持 ACP。只对 Codex 保留 native。
- **Lab 管理账号凭据并在账号间自动轮换**：实现简单、看起来更“智能”，但触及服务商条款，也让 Lab 成为凭据持有方。不选；与 Session Broker 已定的“上下文协调层，不做凭据中继”一致。
- **允许多个执行直接写同一工作树，靠文件版本检查兜底**：Agent 会用自己的 shell 写文件，Lab 无法拦截，版本检查只能事后发现覆盖。不选。
- **Agent 之间建立直接消息通道（共享聊天室）**：交互自然，但 token 消耗失控、Agent 易互相附和，且提示注入会在 Agent 之间扩散，作者身份也无法核实。不选。
- **把编排放到外部服务（Rein / Session Broker）**：长期可能更合适，但现在会在 Main 与外部各维护一份流程状态。不选；用户已于 2026-10-21 决定在 Lab 实现（设计 D1）。契约放在 `packages/protocol`，保留以后替换实现的可能。

## 后果

- 协议中 `harness: z.literal('Codex CLI')` 与 guest `codex` 版本字面量改为通用结构，需要持久化迁移；旧记录迁移为 Codex native。
- `guest-helper.py` 不再按 `argv[0]` 识别 Harness，MCP 配置由 service 显式传入。
- 新增 Agent 模块职责（Harness 注册表、Profile、Bot），会话与上下文模块新增 Board、Handoff、Meeting，任务与执行模块新增 Lane、WriteLease、MergeRecord。
- `scripts/edu-source.mjs` 的三方合并核心抽出复用，edu-web profile 行为不变。
- AGENTS.md、ARCHITECTURE.md 与 current-runtime.md 的范围和端口描述需要同步修改。

## 2026-10-25 实现落点协调（整合说明）

以上背景与决定保留 2026-10-21 的采纳记录；“当前”指当时基线。第 6 点“编排逻辑只在 Main、所有对象归 WorkbenchApplication”的进程放置表述，由本节按候选源码细化：Main 是业务、授权和持久提交权威；WorkflowApplication 负责 workflow 的受理、批准、恢复及候选发布/显式应用，WorkbenchApplication 保留工作台任务、项目写许可与人工接受。service 承载唯一 workflow 执行内核，负责冻结授权内的调用/attempt 调度、有限重试、有序交付和 VM 推进；事件须经 Main Journal 确认。不得在 Main、service 或外部复制另一套执行调度状态机。

依据是 `apps/desktop/src/main/workflow/application.ts`、`journal-sqlite.ts` 与 `apps/service/src/workflow/engine.ts`、`kernel.ts` 的静态接线，见[当前运行时](../current-runtime.md)。本协调说明进程职责，不宣称已证明所有逐次派发授权保证，也不要求迁移内核或新建 Bot/Board 持久化。第 3 点的完整 Lane/AppInstance 和第 4–5 点的 Board、Handoff、Bot、会议仍为路线目标，不能用 Workflow 固定波次候选替代验收。

普通会话已有 Codex native / Claude Code ACP 接线；Workflow 的实际隔离适配器仅 Codex native；已取得的历史真实运行证据仅覆盖 `codex:default`，当前候选未做真实多 Profile 矩阵验收；成员表由 Main 每次受理时冻结的 Profile 快照生成。离线 MockHarness 多成员矩阵不等于真实多 Harness/Profile 验收。`RunSourceRepository.mergeCandidate` 是当前候选合并落点；从 `edu-source` 抽取共用核心仍是原目标，不能描述为已复用。

Harness/Profile 只是出处变化时，同一代码、任务要求、验收规则和运行条件的既有验证事实不因此自动失效；输出、工具或环境变化仍须重新判断适用性。该原则不允许在不同 Harness/model/profile 语义间复用 workflow 缓存键。

本文原 W0–W10 统属多 Harness 协作计划，记为 MHC-W0–MHC-W10；Workflow 的同名工作包记为 WF-W0–WF-W9。WF-W8 固定波次不等于 MHC-W8 Bot/会议；WF-W9 Ultra 与 MHC-W9 Gemini/Cursor 均未启动。静态说明、历史检查、本候选复验和用户接受分别记录；本协调说明不构成验收通过。
