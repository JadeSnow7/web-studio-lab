# ADR-0001：模块化单体与唯一任务执行核心

状态：2026-10-06 原决定保留；2026-10-08 修订业务核心的进程归属。适用范围：Web Studio Lab 首版单项目、单 Agent、固定模板闭环。

## 2026-10-08 修订：Main 工作台拥有业务事实

本次空间整合采用 Main 中的 `WorkbenchApplication` 作为空间、资源、会话、任务版本和运行的唯一写入者；独立 Node utility service 只承载 Codex、PTY、文件与 SSH 等执行适配器。Renderer 消费 Main 快照，不能恢复候选分支的第二套空间状态。该决定替代下面原决定第 2 项中“独立 Node 宿主承载业务核心、Main 仅转发”的进程安排。

应用用例通过端口与 Electron 窗口/浏览器适配器分离，`WorkbenchApplication` 不导入 Electron。这样既保留可独立测试的业务规则，也使已有工作台持久化与异步归属保持一个权威入口；不为未来 CLI 建设第二宿主或通用框架。Main 停止与 service 清理仍须分别确认，服务 ACK 不能代替实际进程退出。

模块责任、具名 IPC、稳定身份与执行/验证/接受分离继续适用。完整写入许可、母模板与独立检查器仍是目标能力，不能据这次进程安排宣称已实现。源码与验证边界见[当前运行时](../current-runtime.md)及[整合合同](../../acceptance/integration-20261008/SPEC.md)。

## 原背景（2026-10-06）

当前树 `536f0a1` 只有初始化说明。另一个本地提交 `643c1e2` 的 `docs/ARCHITECTURE.md` 按 Electron/Node 服务/协议划分，计划让工作台经 Hono/WS 和 token 调用服务；后续 `c0edaf6` 任务计划改为限定 IPC。主 checkout 的未提交源码已经使用具名 `window.studio` IPC，但执行服务仍未接入。来源与差异见 [基线记录](../baseline-2026-10-06.md)。

只有进程图不足以指导任务、资源和结果的归属；把 Browser/Workshop 直接当业务模块也会令视图切换影响执行。旧 run 模型把执行、验收和审阅聚合，且 workspace 指向生成目录，容易与用户空间、应用启动混淆。

## 原决定（第 2 项的进程安排已由上文替代）

1. 采用 [架构基线](../../ARCHITECTURE.md) 中的五个业务责任模块，内部按实际需要分为 Presentation、Application、Domain、Adapters。跨模块公开接口协作，Domain 不依赖具体平台，装配入口连接能力接口。不要求五个包或空目录。
2. 任务编排、预算、项目写入许可、取消和恢复只有一个本地业务核心。它不依赖 Electron，首版由独立 Node 宿主承载；Main 管窗口/浏览器、鉴别来源和转发消息，不复制任务逻辑。CLI 将来复用同一核心。
3. 工作台采用具名 Preload/IPC，取消旧 Hono/WS 工作台传输、端口/token 发现接口。Hono 可用于生成 App API。复用现成 Harness 的薄适配器，不自研推理循环，不要求接入 Rein/Veriflow 仓库。
4. 沿用 `runId`，但严格只指 TaskRun；应用启动使用 `appInstanceId`，用户空间与项目分别使用 `workspaceId`、`projectId`。执行结果、验证结果、用户接受独立记录。历史查看是只读动作，不再作为 `replay` 执行模式。
5. Browser 承载资源，Workshop 承载会话/任务/审阅；调整初始化 README 将终端归 Workshop 的描述。这里只澄清职责，不改现有交互样机或 UI。

## 理由与代价

单体模块化足以支持当前一条串行闭环，避免把进程隔离变成多套业务状态。独立宿主保留 CLI/无模型验证的复用位置，代价是必须处理消息关联、断线、停止确认和宿主打包；因此不再同时保留 HTTP/WS 路线。端口由需求模块拥有，可以替换 Harness 而不强制引入通用插件系统。

曾考虑业务逻辑全部进入 Main：实现启动更直接，但会使任务测试/CLI 依赖 Electron，并把窗口生命周期和任务状态耦合；因此不选。也不选多服务或三个仓库同时依赖，因为当前范围没有需要它们解决的独立部署或调度问题。

本决定并不提供运行时安全、并发隔离或完整验收保证；这些须通过具体适配器与对应负例验证。文档和脚本检查不能替代它们。

## 与既有约定的过渡

- 当前使用已有分支的 `docs/ARCHITECTURE.md`、`CONTRIBUTING.md` 路径，`AGENTS.md` 成为统一 Agent 入口，`CLAUDE.md` 仅引用它；不再维护重复命令和比赛日期。
- 其他 worktree 的未提交实现与历史计划保持原样。本次既未 cherry-pick，也未覆盖、迁入或合并它们；本 ADR 不声称那些 checkout 已遵循新规范。
- 后续整合时逐段更新同名文档，保留历史计划原义并追加差异引用；不可直接用本轮文件覆盖另一个 checkout 的整个 dirty 文件。冲突按事实和最新任务目标处理。
- 现有 `RunRecord` 的 `runId`、`TaskVersion`、协议包和 IPC 命名继续复用。`SourceState`、项目身份、AppInstance 及独立审阅记录在真实执行接入时扩充；旧 UI 聚合状态保留为投影，不能作为领域状态机。没有真实持久数据时不增加兼容层；若已有数据，先检查格式再制定显式迁移。
- 旧分支的四种终态、工具失败归业务失败、`replay` 模式、过期排期及可用命令不能直接复制。当前实际命令以 [CONTRIBUTING](../../../CONTRIBUTING.md) 为准。

检查本决定是否足以指导实现，使用 [优先级用例走查](../task-priority-walkthrough.md)；源码出现后再接入导入限制和真实生命周期验证。
