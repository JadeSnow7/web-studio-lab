# Web Studio Lab 开发入口

本仓库走 Electron + TypeScript 路线：Browser 展示网页、文件、终端等资源，Workshop 承载会话、任务进展、修改和审阅。首版只打通固定 TypeScript 全栈模板、单项目、单 Agent 串行闭环。本树已整合 Electron 产品、sbx 对话/终端/资源切片与 VS001 固定基线；完整比赛任务闭环仍未实现。具体落点和缺口见 [当前运行时](docs/architecture/current-runtime.md)，不要把设计样机或历史验证扩大成本次实现。

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
- 本轮及初始化阶段不创建空业务目录、通用框架或第二模板；云账号、好友、订阅、多 Agent、实时协作、后台任务和生成 App 部署均不在首版范围。

## 工作与交付

- 流程：理解需求与现状 → 明确验收 → 最小实现 → 针对性验证 → 审阅交付。强度与完成标准见 [CONTRIBUTING](CONTRIBUTING.md)。
- 源码和检查脚本的修改委派给 `coder`；主线程负责设计、审查、验收与用户沟通。每个文件同时只有一个写入者；委派不可用时注明后自行完成。
- 当前可用：`node scripts/check-docs.mjs`、`pnpm check`、`pnpm build`、`pnpm baseline:selftest` 及 diff 检查。文档检查只验证入口、链接和空白；离线基线自检不是产品验收。真实模型、sandbox live 与发布需相应授权。
- 不 reset、自动 stash、覆盖无关文件或改写历史；不默认提交、推送、发布、部署。新增分支默认 `codex/<topic>`，已有分支无需改名。
- 交付必须说明改动路径、行为/约定变化、实际命令及结果、未运行原因、未实现项。区分静态检查、实际运行与用户接受；不通过删断言或改固定验收制造通过。

- 比赛范围、排期和固定用例以 [任务计划](docs/plans/2026-10-os2026-task-plan.md) 为准。公开资源和 guest 浏览器另遵守各自合同；本次整合不新增能力。
