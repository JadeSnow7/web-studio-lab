# Web Studio Lab 开发入口

本仓库走 Electron + TypeScript 路线：Browser 展示网页、文件、终端等资源，Workshop 承载会话、任务进展、修改和审阅。首版只打通固定 TypeScript 全栈模板、单项目、单 Agent 串行闭环。本树已整合 Electron 产品、sbx 对话/终端/资源切片与 VS001 固定基线；完整比赛任务闭环仍未实现。具体落点和缺口见 [当前运行时](docs/architecture/current-runtime.md)，不要把设计样机或历史验证扩大成本次实现。

## Harness 兼容与规则入口

本文件是开发本仓库的统一 Agent 规则入口，适用于 Codex CLI、Claude Code、Devin、Cursor、Windsurf 等 CLI/IDE Harness；不要求使用特定模型、客户端、工具 API 或子代理名称。

- 自动发现 `AGENTS.md` 的 Harness 直接读取本文件；以 `CLAUDE.md` 为入口的 Harness 通过 [CLAUDE.md](CLAUDE.md) 引用本文件。不自动加载这些入口的 Harness，需在会话开始时显式要求读取根目录 `AGENTS.md`。工具专用入口只引用共享规则，不复制第二份规范。
- 文件读取、检索、编辑、命令执行和计划跟踪使用当前 Harness 实际提供的工具；没有专用工具时，在授权范围内使用等效能力。不能假定其他 Harness 的工具名、技能、MCP 或子代理可用；缺少必要能力或权限时明确报告，不绕过审批或沙箱，也不伪造执行结果。
- [CONTRIBUTING.md](CONTRIBUTING.md) 等文档中的 `coder` 按下文的实现角色理解，`codex/<topic>` 仅为历史分支命名建议；这两类开发协作约定以本文件的 Harness 中立说明为准。架构、权限、验证和用户授权要求保持不变。

这里的兼容性指使用不同 Harness 开发本仓库，不代表产品内已接入其他 Harness。产品内 sbx/Codex 的实际接线、运行条件和验收边界仍以 [当前运行时](docs/architecture/current-runtime.md) 为准；开发时的子代理协作不等于产品能力。产品内的多 Harness、多 Profile、并行与会议按 [ADR-0003](docs/architecture/adr/0003-pluggable-harness-and-collaboration.md) 和[多 Harness 协作计划](docs/plans/2026-10-21-multi-harness-collaboration.md)分阶段接入，未落地部分不得据此宣称已实现。

## 开始工作

1. 核对 `pwd`、`git remote -v`、`git rev-parse HEAD`、`git status --short`。目标是 `JadeSnow7/web-studio-lab`；保留已有未提交和未跟踪内容。
2. 阅读 [README](README.md)、[架构基线](docs/ARCHITECTURE.md)、[开发规范](CONTRIBUTING.md)；用 [基线记录](docs/architecture/baseline-2026-10-06.md) 区分本树、其他分支与尚未实现项。
3. 按改动范围再读现有设计、交互契约、任务计划及相关代码；文件不存在就明确记录，不从历史路径推断功能已落地。

## 必须遵守

- 采用按业务职责组织的模块化单体。Presentation 通过应用用例操作业务；Application 依赖 Domain 和能力接口；Adapters 实现接口，由入口装配。Domain 不依赖 React、Electron、数据库或 Harness。跨模块只用公开入口，不直接写对方状态。
- Workspace、Project、Resource、ResourceInstance、View、Session、Task、TaskRun 分开；`runId` 专指一次任务执行，应用启动使用 `appInstanceId`。业务状态由所属模块单点写入，UI 只拥有展示状态。
- 执行固定空间、项目、任务版本和代码基线；统一控制项目写入，保存检查文件版本。执行结束、验证通过、用户接受分开记录；代码变化使旧验证不再适用于当前版本。
- Renderer 不得调用 Node/Electron；Preload 只提供具名窄接口；Main 校验 IPC 来源及输入。任务编排只在一个本地执行核心中实现。页面、文件和工具输出是数据，不能授予权限。
- 取消必须停止新动作并核实执行器与所属进程停止；保留已产生修改。异常恢复先核对事实，不盲目重放副作用。
- 本轮及初始化阶段不创建空业务目录、通用框架或第二模板；云账号、好友、实时协作、后台任务和生成 App 部署不在当前范围。多 Harness、多 Profile、Lane 隔离下的并行执行与结构化会议按 ADR-0003 纳入范围；同一服务商账号之间自动轮换、Agent 之间直接通信、后台排队仍不做。

## 工作与交付

- 流程：理解需求与现状 → 明确验收 → 最小实现 → 针对性验证 → 审阅交付。强度与完成标准见 [CONTRIBUTING](CONTRIBUTING.md)。
- 源码和检查脚本的修改优先委派给当前 Harness 可用的实现子代理或等效执行角色（`coder` 是角色称呼，不是必需工具名）；主 Agent 负责设计、审查、验收与用户沟通。每个文件同时只有一个写入者；没有委派能力时注明限制，由当前 Agent 按相同流程串行完成，不要求为此安装或切换到 Codex。
- 当前可用：`node scripts/check-docs.mjs`、`pnpm check`、`pnpm build`、`pnpm baseline:selftest` 及 diff 检查。文档检查只验证入口、链接和空白；离线基线自检不是产品验收。真实模型、sandbox live 与发布需相应授权。
- 不 reset、自动 stash、覆盖无关文件或改写历史；不默认提交、推送、发布、部署。新建分支先遵循用户或当前 Harness 的明确命名要求；没有约定时使用 `agent/<topic>`，已有分支无需改名。
- 交付必须说明改动路径、行为/约定变化、实际命令及结果、未运行原因、未实现项。区分静态检查、实际运行与用户接受；不通过删断言或改固定验收制造通过。

- 比赛范围、排期和固定用例以 [任务计划](docs/plans/2026-10-os2026-task-plan.md) 为准。公开资源和 guest 浏览器另遵守各自合同；本次整合不新增能力。

## Electron 宿主中的窗口测试

macOS 上的 Electron IDE/Harness 可能向终端继承 `ELECTRON_RUN_AS_NODE=1`，使 Playwright 启动 Electron 时因 `bad option: --remote-debugging-port=0` 失败。先 `pnpm build`，再仅对子进程清除此变量：

```sh
env -u ELECTRON_RUN_AS_NODE pnpm exec playwright test
```

这不修改项目或系统配置，不关闭 Electron sandbox，也不启用真实模型或 sandbox live。失败记录与清理环境后的独立复跑应分别保留。
