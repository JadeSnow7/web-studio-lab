# 模块化轻量重构计划 · 第一轮（行为不变）

本计划只覆盖第一轮的三个行为不变小包，以及开工前的基线测量。它建立在 [评审后修改计划（修订版）](2026-10-16-post-review-update-plan.md) 的 S7“按用例拆职责”之上，遵守 [AGENTS](../../AGENTS.md)、[开发规范](../../CONTRIBUTING.md) 与 [架构基线](../ARCHITECTURE.md)。本文件是计划，不是实施记录，也不授权提交、推送、合并、真实模型或 guest live。

本次审核修订仅更新计划文档，不执行 P0 或任何重构包；下文的可写路径、测试与命令均描述后续执行范围，不表示本次已实施或验证。2026-10-17 第二次审核修订对照检查点源码，核对并更正了以下内容：行号与方法计数、A07 所在测试、构建可复现前提、包 1 方法归属表、包 2 写入范围与预算计数时机、包 3 上下文与在途表归属、第 7 节受影响路径判定，以及执行环境说明。文中引用的行号均以检查点 `1c856f5` 为准。

## 0. 起点与授权

| 项目             | 事实                                                                                                                                                                                                              |
| ---------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 检查点提交       | `1c856f5031635e3f2d8dd332bd83429b07a6be10`（tree `c023eb09…`），父提交 `d917013`；用户于 2026-10-17 20:04 授权本地提交，未推送                                                                                    |
| 与交接快照的关系 | 46 个文件与 `handoff-before-refactor-2026-10-17T08-40-03-780Z` 快照逐字节一致；已修改文件 diff 的 SHA-256 与快照 `diff-head.patch` 相同（`8fe33a3e…b19d`）。回执在 `.local/refactor/checkpoint-receipt.json`      |
| 分支             | `agent/guest-linux-regression` 停在检查点；重构在 `agent/refactor-modular-20261017` 上进行，该分支检出于工作树 `../_worktrees/wsl-review-fixes-20261016`（目录名与分支名不同，执行前以 `git worktree list` 核对） |
| 阶段状态         | R1–R3 本地完成；**R4 仍为 incomplete**（A07 首轮焦点失败根因未定）；R5/R6 未开始；Mota 模型入口继续被能力门禁拒绝                                                                                                 |
| 用户决定         | 允许在 R4 阻塞期间先做重构；重构包避开 R5/R6 将修改的文件与区域（冲突风险见下）                                                                                                                                   |

“避开 R5/R6”尚未逐文件核实。R5 涉及 protocol、service、helper 与 Desktop 导出落盘，本轮不移动 `app.export` 分支与导出代码。R6 要求保存收敛到 Main 具名用例，大概率需要在 `ports.ts` / `host.ts` / `application.ts` 增加端口或用例方法，与包 1 的接口分组相邻。约定包 1 先落地，R6 再把新增方法放入对应分组；若 R6 先开工，包 1 暂停并重新评估冲突。

快照目录中的 `verify.mjs --against-worktree` 在检查点之后预期失败（HEAD 和 Git 状态已变化）。不要为让它通过而修改旧哈希；重构以本节的检查点回执为新起点。

## 1. 范围

**本轮做：** 三个小包（第 4–6 节），每包单独可审、单独可回退，按顺序串行实施，同一文件同一时刻只有一个写入者。

**本轮不做：**

- R4 焦点诊断与修复、R5 导出合同、R6 可信编辑入口；
- `apps/service/src/app-service.ts` 的完成链（R3 高风险区）、`apps/service/src/codex-chat.ts`、`apps/service/src/app-helper.py`、`apps/service/src/mota-server.cjs`；
- `apps/desktop/src/main/preview/controller.ts`、`app-ui.ts` 等与 A07 焦点相关的路径；
- `application.ts` 中 R4 修改过的运行生命周期区域（检查点中约第 4400–4700 行：`applyConversation`、Mota 违规与清理结算）；
- 任何 schema、IPC 合同、持久化格式、依赖、预算或冻结输入的变化；
- 新功能：verification、Code Wiki、版本管理、GitHub 绑定、edu/Mota 解耦与 App 清单。它们在第一阶段出口之后另行立项（第 8 节）。

## 2. 当前职责、依赖与写入者（与本轮相关的部分）

| 位置                                                        | 职责                                                           | 业务状态写入者                             | 本轮问题                                                                                   |
| ----------------------------------------------------------- | -------------------------------------------------------------- | ------------------------------------------ | ------------------------------------------------------------------------------------------ |
| `apps/desktop/src/main/workbench/application.ts`（5089 行） | 工作台用例、导入、研究、运行与状态归并                         | 唯一写入者（`snapshot`、命令队列、持久化） | 研究用例（检查点第 1854–2047 行）与运行生命周期混在同一类中                                |
| `apps/desktop/src/main/workbench/ports.ts`                  | `WorkbenchRuntime` 单一接口，46 个方法                         | 无                                         | 浏览器、终端、App、导入、edu/Mota、验证、Agent 发送混在一个接口                            |
| `apps/desktop/src/main/workbench/host.ts`                   | 宿主适配器，实现 `WorkbenchRuntime`                            | 只持有原生句柄                             | 以 `import type { WorkbenchApplication }` 反向依赖应用类，形成类型环；实际只回调 11 个方法 |
| `apps/desktop/src/main/workbench/research.ts`               | `ResearchOwners` 与研究预算/采集断言（纯逻辑）                 | 无                                         | 已是可复用模块；用例本体仍在 `application.ts`                                              |
| `apps/service/src/index.ts`（618 行）                       | utilityProcess 消息边界、统一准入包装、43 个 `case` 分支的路由 | service 只持有进程与适配器状态             | 路由集中在一个 switch；Mota 门禁位于 `send` 分支中                                         |

## 3. P0：开工前基线测量（必须先完成）

重构以“行为不变”为验收依据，而 A07 首轮失败尚未定因。没有对照基线，重构后再出现失败将无法归因。

1. 在检查点 `1c856f5` 上执行 `pnpm check`、`pnpm build`、`pnpm baseline:selftest`，保存回执。
2. **构建可复现性：** 在同一提交、同一工作树、同一依赖安装下连续构建两次，逐文件比较 `apps/desktop/out/main` 与 `apps/service/out` 的 SHA-256。两次一致时，以第二次结果作为第 4 节的对照指纹；不一致时记录差异文件与原因，第 4 节不能使用逐字节对比，需先另定判定方法，不得开工包 1。当前 main 构建未配置 source map；若产物中出现 `.map` 文件，单列比较，不默认排除。
3. 在**已解锁的 macOS 交互桌面**上连续运行默认 E2E 3 轮（`pnpm test:e2e`，入口只对子进程清除 `ELECTRON_RUN_AS_NODE`），每轮独立保存 `test-results/e2e-runs/run-*`。`pnpm test:e2e` 会先执行 `pnpm build`，构建指纹须取自该轮实际使用的产物。记录实际失败的断言位置、期望值与实际值、A07 的 `focusBefore` / `focusAfter`、活动窗口与原生焦点观测，以及 macOS、Electron、Node、桌面解锁状态、源码和构建指纹；缺失观测明确标为未取得。逐项记录 A07 之后的 A08、A09、A10 等检查是否真正执行，不能仅凭 Playwright 的测试总数推断覆盖。判定按第 7 节执行。
4. **受影响 E2E 用例清单：** 为包 2、包 3 分别列出默认 E2E 中实际经过其改动路径的用例（文件、行号、经过的方法），并核实 A07 所在测试是否经过这些路径。依据是源码检索加该轮报告中实际执行的用例，不按文件名推断。该清单是第 7 节“受影响路径”的唯一依据，执行包 2/3 时不得临时扩充或缩减；需要调整时先修订本计划。

**A07 的位置：** 本计划所说的 A07 是默认 E2E 中 `e2e/app-control-harness.spec.ts:169` 的参考实现测试。A07 焦点断言位于第 400 行（`expect(focusAfter).toEqual(focusBefore)`），同一测试内其后依次是 A08 取消（第 403 行起）、A09 回放（第 447 行起）和 A10 生产构建无桥接（第 533 行起）。`e2e/app-control-live.spec.ts:66` 的标题也含 A07，但需要 `WSL_APP_CONTROL_LIVE=1` 授权，默认 E2E 会跳过，不属于本计划基线。R4 已有两轮记录：`.local/r4/default-e2e-01` 在第 400 行失败（1 failed / 22 skipped / 166 passed），`default-e2e-02` 全部通过（22 skipped / 168 passed）。该失败为间歇性，3 轮基线用于记录失败频率与特征；重构后单轮通过或失败都不能单独证明与基线相同或不同。

**初步覆盖事实（P0 第 4 步复核）：** 默认 E2E 的 spec 文件中没有直接经过研究调用的用例（`research` 只出现在 Mota/模型 live 用例及其 fixture 中），因此包 2 的研究路径主要由单元测试覆盖，默认 E2E 只作宽回归。包 3 的观察、终端和环境路由，候选覆盖用例在 `workspace-observation.spec.ts`、`resources.spec.ts`、`sbx.spec.ts`、`ssh-product.spec.ts`、`workspace-runtime.spec.ts` 等文件中，需在 P0 逐项确认实际执行。

回执保存在 `.local/refactor/baseline/`，不覆盖 `.local/r1`–`.local/r4`。**执行环境：** 各 Harness 的 shell 环境可能不同，执行前用 `uname -a` 和 `sw_vers` 核对是否运行在 macOS 宿主上，并确认桌面已解锁（R4 回执记录过默认 E2E 因桌面锁定受阻）。不满足条件时，第 3 步记录为 `not_run` 并写明原因，交由用户或宿主上的 Harness 执行后再回来分析；不能用其他环境的结果代替。

## 4. 包 1：能力端口分组与宿主回调接口（只改类型）

**目标：** 消除 `host.ts` 到 `application.ts` 的类型环；把 `WorkbenchRuntime` 按能力分组，为后续 Agent / Browser / App 模块提供落点。

**可写路径：** `apps/desktop/src/main/workbench/ports.ts`、`host.ts`（仅类型与 import）、`application.ts`（仅类声明处增加 `implements`）。

**做法：**

- 在 `ports.ts` 新增 `WorkbenchHostEvents`，列出 host 实际回调的 11 个方法：`performActiveBrowserAction`、`onVerification`、`onAdmissionRecovery`、`maintenanceLocked`、`onApp`、`verificationAllowsAudio`、`isActiveWorkspace`、`onPreview`、`onCapture`、`onCaptureError`、`onBrowserFocus`。`host.ts` 改为依赖此接口；`WorkbenchApplication` 声明 `implements WorkbenchHostEvents`。
- `host.ts` 中 `application` 访问器（检查点第 308–316 行）的类型同步改为 `WorkbenchHostEvents | null`。已核对：`apps/desktop/src/main/index.ts:93` 及 `host-migration`、`onapp-persistence`、`migration-followup`、`mota-managed-app` 测试只对它赋值，赋值的是完整应用或 `as unknown as WorkbenchApplication`，类型收窄后仍可编译。测试文件不在可写范围内；若实际需要修改任何测试才能通过类型检查，按停止条件处理。
- 把 `WorkbenchRuntime` 拆为下表 7 个具名接口的交集类型，并保留原名导出。方法签名、可选标记、参数顺序、JSDoc 一律不变。每个方法恰好归入一组：

| 接口            | 方法                                                                                                                                                                                                                                                                                                           |
| --------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `BrowserPort`   | `validateBrowserUrl`、`ensureBrowser`、`browserState`、`browserLayout`、`browserAction`、`hideBrowsers`、`openResearchDocument?`（7）                                                                                                                                                                          |
| `TerminalPort`  | `terminalOpen`、`terminalWrite`、`terminalResize`、`terminalStop`（4）                                                                                                                                                                                                                                         |
| `ResourcePort`  | `environmentsList`、`registerResource`、`releaseResource`、`observe`、`captureResource`（5）                                                                                                                                                                                                                   |
| `AgentPort`     | `registerSession`、`send`、`cancel`（3）                                                                                                                                                                                                                                                                       |
| `AppPort`       | `appGet?`、`appCreate?`、`appStart?`、`appStop?`、`appExport?`、`appSourceSnapshot?`、`releaseAppBrowser?`、`appUi?`、`appAgent?`、`appLogs?`、`appLeaseValid?`（11）                                                                                                                                          |
| `AppImportPort` | `appSelectImportSource?`、`appImportSource?`、`appCancelImport?`（3）                                                                                                                                                                                                                                          |
| `TrialAppPort`  | `motaControl?`、`eduTaskSource?`、`eduTaskPrepare?`、`eduTaskApply?`、`eduTaskCancel?`、`appSelectEduSource?`、`appImportEdu?`、`verificationBegin?`、`verificationEnd?`、`verificationStatus?`、`verificationReconcile?`、`verificationRecoverAdmission?`、`deactivateAudio?`（13；标注“试验场专属，待解耦”） |

合计 46 个方法，与检查点 `WorkbenchRuntime` 一致。`ports.ts` 中加入仅类型的断言：拆分前的成员名集合与拆分后交集的 `keyof` 双向相等，各成员可选性一致。该断言在编译时擦除，不进入产物；分组归属有争议时以本表为准，改表需先修订本计划。

**关键不变量：** 运行时代码零变化。

**验证与停止条件：**

- `pnpm typecheck`、改动文件的 lint 与格式、`apps/desktop/src/main/workbench/*.test.ts`。
- `pnpm build` 后与 P0 第 2 步得到的可复现指纹对比：`apps/desktop/out/main` 与 `apps/service/out` 都必须逐文件、逐字节一致（本包不改 service，其产物应同样不变）。**任何产物差异即停止**，说明改动越出了“只改类型”。P0 未证明构建可复现时，本包不开工。
- 不需要 E2E：P0 已证明构建可复现，且产物逐字节一致，即可证明运行行为未变。

## 5. 包 2：研究用例迁出 `application.ts`

**目标：** 以研究这一通用能力为样板，验证“状态仍归工作台模块、在同一串行化边界内写入，研究读取与纳入逻辑迁到模块内独立文件”的拆法。`researchForTurn` 自身含运行生命周期结算，该部分保留在应用类；本包不修改 R4、R5、R6 的业务行为。

**可写路径：** 新文件 `apps/desktop/src/main/workbench/research-use-case.ts`；`application.ts` 中 `researchForTurn`、`researchFailure`、`researchContext`、`performResearch`（检查点第 1854–2047 行），以及本次提取所需的 import、用例实例装配与窄接口委托；必要时 `research.ts` 只增不改。允许在同目录 `research-application.test.ts`、`observation-application.test.ts` 新增混合预算回归及必要 fixture，不删除、放宽或重写既有断言。其余运行生命周期区域不在可写范围内。

**做法：**

- `researchFailure`、`researchContext`、`performResearch` 按现有行为迁入 `ResearchUseCase`，只调整必要的依赖访问和委托。构造参数 `ResearchHost` 只提供这三段逻辑实际使用的能力，逐项为：
  - 串行化与持久化：`serialize`、`persist`；
  - 读取：`requireWorkspace`、`run`、`session`、`resource`、`instance`、当前活动空间 ID、执行轮次绑定（`run.executionBinding ?? runTurns.get(runId)`）、`catalog.accountId`、`closing`、`ready`；
  - 资源动作：`createResource`、`openResource`、应用类私有的 `ensureBrowser`（即包装运行时的那一层，不直接调用 `runtime.ensureBrowser`）；
  - 运行时能力：`Pick<BrowserPort, 'validateBrowserUrl' | 'browserState' | 'openResearchDocument'>`，复用包 1 的分组；
  - 共享对象：**同一个** `observationCounts` 计数器与同一个 `ResearchOwners` 实例。

  状态与回调在调用时读取，不在构造时复制。`this.ready` 会在检查点第 293、307 行重新赋值，`this.catalog` 也会在加载、回滚等多处重新赋值，二者必须通过访问器读取，不能在构造时保存引用。不向新用例暴露 `trackRunOperation`、`updateRuntime`、`runLogBaselines` 或 `releaseObservationScope`。

- **样板的收益判据：** `research-use-case.ts` 不导入 `WorkbenchApplication`，不从模块公开入口导出，只由 `application.ts` 装配；`ResearchHost` 不超出上面列出的成员。若提取后发现必须继续增加 `ResearchHost` 成员，说明这只是把私有方法改成了公开回调，收益不成立，应停止并重新评估拆法，不为保住提取而扩大接口。本包不要求新增 fake host 单测。
- `WorkbenchApplication.researchForTurn` 保留公开入口、请求解析、授权与在途上限检查、pending 增减、组合 `AbortSignal`、operation tracking、错误/取消回复转换及原有 Promise 链顺序，仅将研究处理与错误转换调用委托给用例对象。其 `finally` 中聚合清理标记、结算 cancelling run、更新 conversation、删除日志基线、释放观察权限的逻辑原位保留；新用例不写运行终态、不承担 Mota 清理。`apps/desktop/src/main/index.ts` 中 `chat.setResearchReader(...)` 的接线不变。
- 其他留在 `application.ts` 不动的研究相关代码：`startRun` 中授权的创建与注册、运行生命周期中的 `revoke` / `forget`、快照投影中 `researchSummary` 的生成、`cancelRun` 时的撤销。这些与上述结算逻辑仍由任务执行逻辑拥有。

**关键不变量：**

- **写入归属：** 迁出后的代码在文本上会直接写一部分状态，这里不称“写入者不变”，而是限定写入范围与边界。`ResearchUseCase` 是工作台模块的内部协作者，业务状态仍归工作台模块所有，不产生第二个模块级写入者。它只允许写以下内容，且（除 `owner.opening` 的复位外）都在 `serialize` 回调内进行，与检查点一致：`run.research.captures`、`run.research.inclusions`（含持久化失败回滚）、`owner.opening`、`owner.readerResourceId`、`observationCounts` 当前 run 的计数，以及经 `createResource` / `openResource` 回调间接产生的资源变更。`finally` 中 `owner.opening = false` 的复位保持原位置、原语义（检查点第 2038–2046 行，在 `serialize` 之外）。用例不持有状态副本，不写 `run.state`、`endedAt`、`cleanupPending`、`conversation` 等运行生命周期字段。
- 观察与研究共用每轮 64 次调用预算，必须仍是**同一个计数器**，不能复制。现有两条路径的计数时机不同，提取时按原样保留，不“顺手”统一：研究在授权检查通过后立即加一（检查点第 1932–1934 行），之后即使因来源不匹配、保存失败等原因失败也不退还；观察只在请求持久化成功后加一（第 2246 行）。在途上限也不同：研究按本轮 `owner.pending >= 4` 限制（第 1859 行），观察按全局 `this.observations.size >= 4` 限制（第 2148 行）。两者均保持不变。
- 取消、关闭和迟到回复的语义不变：`AbortSignal` 传播、`closing` 检查、持久化后再回复、错误码映射（`cancelled`、`unauthorized`、`budget_exceeded`、`storage_failed` 等）。
- R3 的 Promise lint 当前只作用于 `app-service.ts`，本包不移动其中任何代码，规则无需迁移。`researchForTurn` 的 Promise 链保留在 `application.ts`；本包不调整链的顺序、错误语义或 lint 作用域。

**验证与停止条件：**

- 先补基线再提取：现有 observation 测试只验证观察调用的 64 次上限，现有 research 测试没有混合消耗验证。先在未提取的实现上新增并运行同一 run 内 observation/research 混合预算回归，保存通过的输入与结果，再对提取后的实现运行同一测试。两个方向分别覆盖“观察消耗后研究到达上限”和“研究消耗后观察到达上限”：合计第 64 次仍可执行、第 65 次返回 `budget_exceeded`，拒绝时不调用底层采集能力。使用合法调用避免提前触发来源数量或在途上限，确保独立计数器的错误实现不能通过。另加一条计数时机基线：计数之后才失败的研究调用（例如 `research.include` 的 `contentSha256` 不匹配，返回 `invalid_request`）仍消耗一次预算，防止提取时被改成失败退还。新增基线失败时先核对测试与原实现行为，暂停提取，不在本包混入业务修复。
- 定向：`research-application.test.ts`（既有 11 项及新增回归）、`research.test.ts`、`apps/desktop/src/main/chat-research.test.ts`、`observation-application.test.ts`，以及 `apps/desktop/src/main/workbench` 下其余测试；保留取消、迟到结果、保存失败回滚和关闭等待的既有断言。
- 全量：`pnpm check`、`pnpm build`、`pnpm baseline:selftest`；在 Mac 宿主上跑默认 E2E 1 轮，与第 3 节基线对比。按 P0 的初步事实，默认 E2E 基本不经过研究路径，它只用于发现其他回归；研究路径的行为不变依据是上面的定向单测和混合预算回归，不能以 E2E 通过代替。
- 停止条件：需要删除、放宽或修改既有断言；需要扩大 `ResearchHost` 到本节所列成员之外，包括运行生命周期或 Mota 相关方法；需要改变保留入口的生命周期结算行为；需要修改协议类型。上述新增测试和新增断言属于本包必做范围，不触发停止条件。

## 6. 包 3：service 路由按模块分表（不含 send、edu、Mota、验证）

**目标：** 把 `apps/service/src/index.ts` 中与 R4 无关的路由迁到按能力划分的处理表，保留统一准入包装。

**收益与优先级：** 本包只迁出 13 个分支，约 80 行；`index.ts` 的主要复杂度在准入包装、`send` 与 `app.*`，本包不涉及。因此本包收益有限，可选执行：若 P0 显示包 3 受影响路径缺少可用的 E2E 覆盖，或包 2 暴露出需要先解决的拆法问题，可推迟到后续 Agent/service 模块化时一并处理，不影响第一阶段出口。

**可写路径：** 新目录 `apps/service/src/routes/`（`observation.ts`、`environment.ts`、`terminal.ts`、`replies.ts` 等）；`index.ts` 中对应的 `case` 分支及必要的 import、处理表装配与分派接线；`apps/service/src/index.test.ts` 中迁出路由的合同测试及必要 fixture。不移动或改写保留分支及统一准入包装。

**迁出的方法：** `observation.read`、`observation.cancel`、`observation.reply`、`environments.list`、`resource.register`、`resource.release`、`terminal.get`、`terminal.open`、`terminal.write`、`terminal.resize`、`terminal.close`，以及 `app.reply`、`research.reply` 两个回复转发。其中 `research.reply` 不是纯转发：它先调用 `validateResearchReply` 校验，校验抛错时在途项不删除，走通用错误响应；迁出后保持这一顺序。

**保留在 `index.ts` 不动：** 统一准入包装（维护门、`pendingSends`、取消标记）、`send`（含 `assertTaskAdmission` → `assertMotaCapability` → Mota 租约 → `chat.send` 的顺序）、`cancel`、`reset`、`register`、`status`、`get`、全部 `app.*` 的 edu / Mota / 验证 / 导入 / 生命周期分支，以及 `shutdown`。

**做法与不变量：**

- 每个处理表导出 `{ [method]: handler }`，不在模块内新建状态。handler 接收三类输入：
  - 已解析的请求。注意 `terminal.get` 读取的是 `request.resourceId`，不是 `request.payload`，handler 签名按请求的实际形状取值；
  - 进程级共享上下文，由 `index.ts` 构造一次并传入：`environments`、`terminalFor`、`requireReady`、`validateResearchReply`，以及 `observations`、`observationCalls`、`appCalls`、`researchCalls` 这几张在途表。这些表仍由 `index.ts` 声明和拥有：`observations` 同时被 `shutdown` 分支（检查点第 527 行）和 SIGTERM 处理器（第 605 行）遍历中止，处理表模块只能使用传入的同一个实例，不得自建；
  - 请求级准入上下文：`checkAdmission` 是每个请求在第 227–231 行生成的闭包，`terminal.open` 的第二次准入检查依赖它，必须按请求传入，不能放进进程级上下文。
- 用类型约束保证每个请求方法**恰好被处理一次**：未迁出的方法仍由 switch 处理，迁出的方法从 switch 删除。检查点的 switch 没有 `default`，`result` 也未标注类型；本包新增 `never` 穷尽分支，并让处理表 `satisfies` 迁出方法的映射类型，使漏处理、重复处理在编译期失败。这是新增的类型检查，不改变运行分派。
- 包装中的 `mutating` 列表和 `initializationError` 放行列表按方法名字符串判断（`string[].includes`），本包保持原样。方法策略因此分在两处，作为后续事项记录，例如给两份列表加 `satisfies readonly ChatServiceRequest['method'][]`，不在本包修改。
- 请求仍先经过同一个准入包装，Zod 解析位置、回复消息结构与错误文本不变。
- `observation.read` 与 `observation.cancel` 必须使用同一个在途请求表；取消命中原 read 的信号，结算后移除原映射。sandbox 的 `terminal.open` 必须保留 `requireReady` 完成后的第二次 `checkAdmission`，不能只检查请求刚到达时的维护状态。
- 合同测试追加到已由普通项目收集的 `index.test.ts`，不新增测试文件或修改调度配置。`scripts/check-test-scheduling.test.mjs` 只检查列明的既有文件，不能将其通过视作任意新增文件已被收集的证据。

**验证与停止条件：**

- 先补基线再分表：在原 switch 实现上经 `process.parentPort` 请求入口新增合同测试，保存通过的输入与结果，再对分表后的实现运行同一组测试。逐项覆盖本节全部迁出方法的成功分派、实际传递参数、返回结果/关联请求 ID 及仅调用一次；回复转发覆盖正确在途接收者；`research.reply` 另加非法回复用例，确认校验失败时返回错误、在途项保留且原等待方未被结算。`observation.read` 覆盖重复 `requestId` 拒绝。保留已有非法输入与维护门拒绝断言。只测试下层类或处理表不能替代入口分派验证。新增基线失败时先核对测试与原实现行为，暂停分表，不改路由行为来制造基线通过。
- 必跑时序负例：挂起 `observation.read` 后通过同一入口发送对应 `observation.cancel`，确认原请求收到取消、结算并移除映射；让 sandbox `terminal.open` 等待 `requireReady`，等待期间进入维护状态，随后恢复 ready，必须由第二次准入检查拒绝且底层终端不打开。同时保留 ready 后准入允许时正常打开的正例。挂起 `observation.read` 时发送 `shutdown`，确认同一在途表中的请求被中止。
- 定向：新增合同测试所在的 `apps/service/src/index.test.ts`，以及 `observation-*.test.ts`、`local-terminal*.test.ts`、`ssh-terminal.test.ts`、`environment-*.test.ts`、`terminal-output.test.ts`。后者是下层行为回归，类型穷尽检查也只验证方法覆盖，均不能替代上述参数、取消和准入顺序断言。
- 全量：`pnpm check`、`pnpm build`、`pnpm baseline:selftest`；Mac 宿主上默认 E2E 1 轮，与基线对比。
- 本包不改 guest helper，不需要 `pnpm test:linux`；若实际改动触及 helper，立即停止并重新评估。
- 停止条件：准入包装需要调整；任何保留分支需要移动；回复结构或错误文本出现差异。

## 7. 回执、E2E 判定与提交

- 每包产出 `.local/refactor/<包名>/receipt.json`：输入提交、源码与构建指纹、实际命令及结果、未运行项及原因。不覆盖旧回执，不改旧期望哈希。
- 结果状态使用 `passed`、`failed`、`undetermined`、`not_run`。
- **A07 执行结果：** 断言失败的该轮 E2E 始终记录 `failed`，不能因基线出现过同名失败而改为通过或直接认定“与基线一致”。A07 焦点断言（`e2e/app-control-harness.spec.ts:400`）与其后的 A08 取消、A09 回放、A10 生产构建无桥接处于同一个测试，提前失败时，尚未到达的检查逐项记录 `not_run`；测试总数或其他用例绿色不补足这些覆盖。
- **A07 归因：** 单独记录回归归因结论，对照基线和重构后的具体断言位置、期望/实际值、焦点与活动窗口观测、环境及输入指纹。任一差异未解释、必要观测缺失或无法排除重构影响时，归因为 `undetermined`；需要额外焦点诊断或补充窗口覆盖时，先另定诊断范围，不在本包顺手修复。即使证据支持同一既有问题，也只记录已核对的具体失败特征，保留该轮 `failed` 与未执行清单，不能据此认定整包行为不变。
- **归因与停止的关系：** 是否停止后续包，取决于失败或 `not_run` 的检查是否落在 P0 第 4 步清单列出的本包受影响路径上：
  - 落在受影响路径上，或无法确认是否受影响：归因为 `undetermined` 时停止后续包；
  - P0 清单已确认 A07 所在测试不经过本包路径：A07 失败及其后 A08–A10 的 `not_run` 照常记录，归因单独结算，但不单独阻止本包的局部准入。这些检查也不计入本包的覆盖；
  - 本包受影响路径上的 E2E 用例，必须实际执行并通过。
- **局部准入与完整验收：** 允许 R4 阻塞期间推进有独立证据的重构，包 1 仍按第 4 节的类型检查与产物一致条件验收。包 2/3 须逐项区分受影响路径的实际覆盖、既有失败和未执行项。受影响路径的覆盖由 P0 清单中的 E2E 用例与各包列出的定向单测共同构成，包 2 的研究路径以定向单测为主（见第 5 节）。只有证据能排除新增回归、且受影响路径已有实际覆盖时，才可继续后续包，否则本包验收保持未完成。A07 阻断的后续检查不能被下层单测、类型检查或总通过数替代。局部准入不关闭 R4，也不满足第一阶段出口所需的完整 E2E；该出口仍需补齐遗漏检查。
- 重构后的绿色 E2E 不证明 R4 首轮焦点失败根因已解决；R4 状态仍单独结算。不增加重试、不调高超时、不放宽断言，不以追加运行覆盖原失败。
- 冻结输入（`scripts/frozen-inputs.json` 的 14 个文件）每包检查一次，必须保持原字节。
- 每包完成后由用户决定是否本地提交；推送、PR、合并另行授权。

## 8. 本轮之后（不在本计划范围）

本节只记录方向，不参与第一轮任何包的验收。篇幅已接近前 7 节之和，后续另写 ADR/SPEC 时迁出到独立文档，本文件只保留指向链接。

按修订计划，第一阶段出口要求 R1–R5 完成（保留编辑保存时还需 R6），再取得合并授权。之后的方向已在 2026-10-17 的讨论中确定，届时另写 ADR 与 SPEC（修订计划中的 ADR-0003 已用于“可插拔 Harness 与运行环境”，新范围需要另起编号）：

- 模块化继续：`application.ts` 收缩为内核 + 各模块用例；Agent、Browser、App、verification 模块落位；`ChatService` 更名为 service 客户端。
- 试验场解耦：Lab 产品代码不出现具体 App 名称；App 清单 + `node-template` / `command` / `static` 三个通用运行驱动；edu 以 `JadeSnow7/edu` 为准，Mota 新建公开仓库并继续由 `static` 驱动托管；试验夹具移入 `trials/`。
- verification：轨迹（只追加）、确定性评估（门禁）、参考评估（模型，仅参考）、只读回放（含视觉回放）；录制默认开启，本机 7 天、云端 14 天（数值待评估）。
- Code Wiki：本项目知识库 + 产品内项目 wiki；存于 Lab；专用 wiki Agent 只读、在任务结束后串行更新，事实来源可用命令复核，区分 Agent 版与人工定稿。
- 版本管理：Main 侧 git 仓库作为唯一权威，tree hash 作为 SourceSnapshot；GitHub 以 Lab 为主单向推送到专用分支。

### 8.1 “Lab”实验项与四个方向

可编辑、可训练的 App 明确以实验项“Lab”推出；本节“Lab 实验项”指这一后续能力，不表示现有 Web Studio Lab 宿主已经支持计算图或训练。先用一个独立小型 App 验证机制，再考虑产品接入。推进顺序为：计算图 → Code Wiki + 自适应布局；电路映射暂不优先，留待后续探索。正式接入仍遵守本节前述第一阶段出口及单独立项要求。

1. **计算图，第一优先级。** 将 App 的计算结构 `G`、可训练参数 `θ`、运行状态 `S` 分开表达、保存和版本化；编辑 `G` 增加或改变功能，训练 `θ` 改善已定义的行为，运行事件更新 `S`。先支持有界数值计算、明确的输入输出和固定状态转换，保留固定规则与可训练子图的边界。语义模块具有稳定 ID，输入输出标明类型、范围和含义；编译后的算子或连线编号不作为业务身份。Handwired 是候选实现，不能据此承诺任意 TypeScript/React 自动转换或整个 App 均可训练。
2. **Code Wiki，计算图基线之后。** 在既有项目 wiki 方向上增加“功能 → 语义模块 → 源码/计算子图 → 验证证据”的导航。分别表达源码依赖、数值数据流、状态读写和副作用关系，区分静态事实、运行观测与设计推断；源码依赖图不等于数值计算图，图形节点也不获得业务状态写入权。普通代码同样可建立 Wiki，不以全应用转换为计算图为前提；先做只读关联，再讨论自动同步。
3. **自适应布局，与 Code Wiki 同属后续阶段。** 在计算图可编辑、可运行、局部可训练的基线上，用窗口、内容和用户确认的示范学习尺寸比例或有限布局候选。先作用于独立实验 App；最小尺寸、窄屏切换、键盘与焦点规则保持确定性，候选布局只在用户应用或明确的场景切换点生效，避免操作途中移动目标。完整 Code Wiki 和自适应布局都不是首个计算图实验的通过条件，也不先改当前工作台主界面。
4. **电路映射，后续探索。** 先保留计算图到电路表达的研究方向，不安排本阶段 RTL、FPGA、ASIC 或硬件后端交付。可视化电路与实际硬件实现分别评估；将来选定有界计算内核后，再与普通实现及直接硬件实现比较正确性、成本和性能，不预先宣称效率收益。

### 8.2 首个计算图实验与验收条件

首个实验建议采用固定容量的小型任务列表：固定子图处理新增、完成等状态转换，一个可训练评分子图输出排序建议；具体样例由后续单独 SPEC 冻结。该示例的任务状态只属于实验 App，不是宿主的 `Task` / `TaskRun`。界面先使用固定布局，验收“编辑图 → 运行 App → 训练指定子图 → 比较版本 → 保存恢复”的闭环；局部训练直接在首个实验中验证，布局学习留到后续。

- **先冻结基准。** 单独 SPEC 写明容量、输入编码与取值域、事件语义、固定规则、可训练参数范围、训练/运行预算、数值容差、响应时延上限和评分改善门槛；固定训练集、留出评估集及独立 TypeScript 参考实现。执行前冻结，不能根据训练结果改验收标准。
- **图实际驱动行为。** 用户能查看和修改有语义标签的节点与连接，修改后的图实际决定计算结果。至少用一次结构编辑增加可观察功能（任务列表示例为“隐藏已完成项”），无需重新训练固定规则；编辑前已有行为继续通过同一基准。固定子图逐项与独立参考实现对照，数值输出按预定容差比较；只画图、只跑预置图或只比较同一求值器的两个模式不足以通过。
- **局部训练有效且受限。** 用户确认示范后，只更新声明可训练的 `θ`，不改 `G` 或业务状态 `S`。在留出数据上与未训练版本及固定评分规则比较，满足预定改善门槛，同时固定状态转换回归通过。记录数据、随机种子、训练配置、预算和实际结果；训练损失下降不能单独作为通过依据。
- **版本与证据可核对。** 每轮结果绑定源码快照、图、权重、输入/状态格式、运行配置、训练及评估数据、验证规则的版本或摘要。外置权重和数据需要独立摘要，不能仅用 Git tree hash 代替。任一影响行为或评估的输入变化后，旧结果保留历史意义，新版本须重新判定适用性；关联 Wiki 声明标记待复核，不将所有文档一律作废。
- **保存、恢复与回退可复现。** `G`、`θ`、`S` 独立保存并以明确版本组合恢复；恢复后对同一输入得到符合基准的状态和输出。可比较候选与已接受版本，回退到指定组合；不兼容的图/状态格式明确拒绝加载，不静默重置。训练完成、验证通过和用户接受分别记录。
- **取消与权限边界成立。** 取消训练后停止新训练步骤，核实所属执行已停止，迟到结果不替换当前版本，保留已产生的候选和记录。模型输出只能产生既定范围的建议；权限、文件保存一致性、取消结算和验收门禁由确定性应用逻辑控制，不参与训练。实验不能直接写宿主业务状态或获得新增文件、网络、工具权限。
- **真实交互与退出条件。** 在真实浏览器验证图编辑、运行、训练、取消、保存恢复和版本比较，检查键盘、焦点、错误提示及预定响应时延；接入 Electron 后另验实际窗口。按第 7 节状态口径保留失败、未运行项及用户接受记录。以上首个实验条件通过后，才推进其上的 Code Wiki 与自适应布局；布局阶段另用未参与训练的尺寸、内容和任务对照固定规则，验证操作稳定性、用户纠正次数或任务完成表现，不能沿用计算图通过结论。

### 8.3 已有实验参考与本轮边界

- 参考 2026-10-17 的[“解释 handwired”](chatgpt-conversation://6ad33863-88dc-83ea-873b-b83d087ef531)与[“Handwired转换限制”](chatgpt-conversation://6ad33fa8-8f88-83ea-8dba-9b273b953b66)讨论。这两个链接指向仓库外的对话记录：`check-docs` 会跳过非本地链接，其他 Harness 和评审者通常无法打开，因此不作为可复核依据。后续 SPEC 立项时，应把所依赖的结论摘录进仓库，并注明来源与未验证项。前者记录已完成并部署的独立[神经布局实验室](https://web-studio-neural-layout-lab.windy-larch-3267.chatgpt.site)，可借鉴示范采集、浏览器内训练、前后比较、取消/回退和 JSON 导出；其训练与 DOM 检查结果属于对话中的报告，真实浏览器交互当时未完成验证。本仓库尚未复核或接入其源码，不能据此认定已接入 Handwired 或通过本节验收。复用前核对源码、依赖、版本和可复现结果，保留原实验的证据边界。
- [既有 Code Wiki 原型](../design/2026-10-12-code-wiki/README.md)可供模块导航和关系展示参考；它是人工维护的源码快照原型，不能视为已实现计算图、自动依赖提取或产品内同步。Handwired 的能力边界参考其[官方教程](https://github.com/chenglou/handwired/blob/main/docs/tutorial.md)与[执行模型](https://github.com/chenglou/handwired/blob/main/docs/execution-model.md)，选型时固定版本并独立验证。

本次仅补充第 8 节的方向、顺序与验收约定，不实施或发布“Lab”实验项。P0 和第一轮三个重构包的可写路径、行为不变要求、测试、停止条件及 R1–R6 状态均不因本节改变；不提前创建实验目录、图运行时、空接口、协议、持久化格式或依赖，也不改变冻结输入。后续实验通过单独 ADR/SPEC 确定状态所有者和接入方式，遵守模块公开入口、Main 权威状态、窄 IPC 与单执行核心，不为样例增加宿主专用分支。独立实验结果不能代替 A07/R4 诊断、第一阶段出口、工作台集成验收或用户接受；实施、提交、推送和发布均不由本次文档修订授权。

## 9. 2026-10-18 追加更正：R4、E2E 与 S4 分别结算

本节保留第 0–8 节原文，纠正其中把 R4 与 A07 焦点混称的语义。权威定义以[修订计划 R4/S4](2026-10-16-post-review-update-plan.md)为准：R4 是 Mota 违规检测、撤权与启动能力门禁；A07 焦点及全套 edu-audio 超时是独立默认 E2E 出口；OS 文件/进程/网络隔离属于 S4。Mota 模型继续被未验证的原生工具能力门禁拒绝；这不是能力通过。R4 状态不因本节、后续绿色 E2E 或本轮 B1 修复转为通过。

以下行号固定指向本次追加前的 `e6bb391` 原文；读到历史用语时应用右列解释：

| 原行/位置            | 历史用语                          | 追加后的解释                                                                                 |
| -------------------- | --------------------------------- | -------------------------------------------------------------------------------------------- |
| 14，第 0 节阶段状态  | R4 incomplete（A07 焦点根因未定） | R4 状态维持 incomplete；括号所述 A07 是另一个 E2E 阻塞，不能作为 R4 定义或唯一原因           |
| 27，第 1 节          | R4 焦点诊断与修复                 | 此处实际指 A07 焦点诊断；不在第一轮重构范围，与 R4 安全门禁分开                              |
| 53，第 3 节 A07 位置 | R4 已有两轮记录                   | `.local/r4/` 是历史目录名；两轮为默认 E2E，不自动构成 R4 违规/撤权/能力验收                  |
| 57，第 3 节执行环境  | R4 回执记录桌面锁定               | 桌面状态约束默认 Electron E2E；锁定不证明或否定 R4/S4 安全能力                               |
| 169–170，第 7 节     | R4 阻塞、R4 首轮焦点失败          | 局部准入不关闭任何合并阻塞；首轮焦点实际是 A07，需按本节独立保留 failed/undetermined/not_run |
| 212，第 8.3 节       | A07/R4 诊断                       | 读作 A07 E2E 诊断与 R4 违规/能力事项两条独立工作线；S4 另行验证                              |

另据 P0 原始回执，A10 实际是同一 serial 文件中的第二个测试，不在 A07–A09 的参考实现测试内部；前一个测试失败时可由 serial 调度跳过。P0 三轮 A07–A10 均实际通过；所引用包 2 最终轮也通过这四项，但旧场景 R3 原生焦点失败，不能混作 A07 失败或修订计划 R3 Promise 包。更早 A07 失败为 `run-PzwecM`，其失败和下游未运行保持独立。

[全 PR 252 文件映射](../acceptance/review-audit-20261018/README.md)记录固定范围与证据缺口。第一轮三包只覆盖端口类型、研究用例和 13 条 service 路由；并非全 PR 拆分或全量重审。包 1 有局部类型/产物一致验收；包 2/3 源实现及局部审查完成，完整验收仍 incomplete。原失败、旧回执和后续通过分别保留，不能互相覆盖。

R6 只形成[ADR-0004 提案](../architecture/adr/0004-mota-trusted-editor-save.md)，未改运行时代码。R5、R6、S4、默认 E2E 与整个第一阶段出口仍按各自实证结算，本节不授权提交、推送或合并。
