# 状态降噪与统一状态接口（2026-10-11）

按已确认的[设计（修订 2）](../../design/2026-10-11-status-surface/README.md)实施。健康稳态不再以常驻文字占据界面；需要用户处理或改变了可做之事的状态显式出现；控制权、进行中与未确认的事实不被折叠。界面、诊断面板、调试 IPC 与日志共用同一份状态事实。交付范围为本地分支，未推送、未创建远端 PR、未发布或部署。

本页前半部分保留原实施阶段记录；它们不代表六项修复后的当前验证结果。本轮未提交修复、原始命令回执和验收边界见后文「六项修复复验」。12 项已接受偏差继续有效。

## 原实施：分支与审阅入口

分支 `agent/status-surface`，独立工作树 `/Users/huaodong/workspace/_worktrees/status-surface-20261011`，基线 `codex/consolidate-review-20261011` @ `917f375`。主工作树与其他工作树未修改。

先读设计目录的 [review-response.md](../../design/2026-10-11-status-surface/review-response.md)「实施期修订」表：其中每项设计修订都经用户确认。再按下表逐个提交审阅：

| 提交      | 阶段 | 内容                                                                        |
| --------- | ---- | --------------------------------------------------------------------------- |
| `8fb875e` | —    | 纳入设计目录                                                                |
| `c6c21d5` | P0   | 协议 DTO 与按域 raw 白名单；`apps/desktop/src/shared/status` 事实投影与脱敏 |
| `7f590a4` | P1   | 展示层 `status-view.ts`、StatusDot / StatusSlot、错误出口合并为 Toast 队列  |
| `e0fe86e` | P2-1 | 标题栏；全局持续条件进标题栏，Toast 只放一次性失败                          |
| `d499077` | P2-2 | 侧栏标签行尾状态点；`cleanupPending` 事实时机修订                           |
| `cc48a20` | P2-3 | 终端胶囊、图标按钮、状态槽                                                  |
| `b83ca38` | P2-4 | 网页工具栏「采集到会话 ⌄」「⋯」、页面状态进状态槽                           |
| `d952b0b` | P2-5 | 会话、运行详情、运行记录菜单、会话输入区                                    |
| `01dc4b4` | P2-6 | Composer、首页、通知与任务历史中文标签                                      |
| `9d71270` | P2-7 | 观察「来源」折叠区、文件首次说明与变化提示                                  |
| `ca57b76` | P2-8 | 受管 App 对话框                                                             |
| `f6df6b5` | P3   | 诊断通道 `debug:status`、诊断面板与 NDJSON                                  |
| `1bce260` | P4   | `UX-CONTRACT.md`、`DESIGN.md`、架构说明与本验收记录                         |

每个阶段 / 区域均由实现子代理完成、主代理审阅与验证、独立审查子代理复核，P1 / P2 问题修复后提交。

## 行为与约定变化（按 design.md §5 区域）

- **标题栏**：健康时右侧只留铃铛；对话不可用显示「Codex CLI · 对话不可用」，比赛环境存在问题显示「环境 · {问题}」，均进入设置页。
- **侧栏**：去掉「已显示」与页脚规则说明；标签行尾为形状标记（终端已连接为成功色实心点，执行中为环，失败为三角，关闭但进程退出未确认为虚线环）；会话取最新运行，与历史选择无关。「后台资源 / 已关闭标签」附计数，无内容不显示。
- **终端**：工具栏为「环境 · cwd 末段」胶囊 + 形状标记，沙箱全名与绝对 cwd 在悬停；中断与关闭为图标按钮（名称不变）；连接中 / 关闭中 / 未确认常驻，连接失败与不可用为问题，已关闭为提示；页脚说明移除。
- **网页**：工具栏收为后退 / 前进 / 刷新 / 地址 / 选择元素 / 采集到会话 ⌄ / ⋯；页面状态全部进状态槽；点选中两个弹出层禁用；「沙箱应用」状态行改为工具栏形状标记。
- **会话**：删除「Codex CLI · 状态 · 沙箱由服务决定」与「运行 {runId}」，不再输出英文枚举；视图收为「对话 / 任务 / 上下文 / 检查 / 运行记录 ⌄」；底部常驻通道同时承载执行中、取消中与「App 数据操作待确认 · 重新核对」；版本 / 运行选择是展示状态。
- **输入区与首页**：输入框可访问名称不变，「发送到 · …」为描述；快捷键说明移入发送按钮 title；首页两条说明改为描述；有运行中任务的空间卡片显示形状标记。
- **观察与文件**：来源、环境、时间、范围、版本 / 散列移入结果「来源」折叠区；文件首次说明为一次性提示，SFTP 无 watch 等说明此后常在标题区悬停与描述中；文件可能变化以中文标签进问题通道；取消读取在状态槽。
- **受管 App 对话框**：稳态为形状标记 + 可见文字；启动中 / 停止中与「应用进程清理未确认」常驻；失败为问题，完整错误在「错误详情」。
- **全局出口**：一次性失败进 Toast；持久化失败保留横幅，出现时 Toast 上移，两者互不遮挡。
- **诊断**：仅开发服务器或 `WSL_DEBUG_STATUS=1` 启用；菜单「诊断」（⌥⇧⌘D）打开面板；复制 JSON 与 NDJSON 已脱敏；页面现场、ID、evidenceRef、执行绑定只在面板内查看。
- **合同**：`UX-CONTRACT.md` 新增 Status / Diagnostics 两行与「状态呈现与诊断」一节，逐条修订见 [contract-changes.md](../../design/2026-10-11-status-surface/contract-changes.md)；`DESIGN.md` 按其 B 节修订；`docs/ARCHITECTURE.md` 与 `docs/architecture/current-runtime.md` 登记 `apps/desktop/src/shared` 层。

## 与设计的偏差（均经用户确认或已记录）

| 偏差                                                                             | 理由                                                                           |
| -------------------------------------------------------------------------------- | ------------------------------------------------------------------------------ |
| `app-cleanup` 在 `appCleanupPending` 即产出，按执行器状态换文案                  | 重启恢复路径执行器状态缺失，原条件会丢失「重新核对」                           |
| `history-restored` 令牌改为 `sessionId`                                          | 原令牌含采集请求，已确认提示会在每次采集后重现                                 |
| 全局持续条件进标题栏，Toast 只放一次性失败                                       | 持续条件进 Toast 会在开发与 E2E 默认环境常驻并遮挡发送按钮（9 个既有用例失败） |
| 终端 cleanup 仅在 failed / closed / idle 产出；运行 process-cleanup 仅在终态产出 | 源码中 `cleanupPending` 在进程存活期间始终为 true                              |
| App cleanup 在 failed 或 stopped 且未确认时产出，label「应用进程清理未确认」     | 服务端把清理未确认记为 failed                                                  |
| App `created` label 为「已创建」                                                 | 既有 `workshop-actions.spec.ts` 精确断言                                       |
| 观察错误标签沿用现有文案（如「未获授权」）                                       | 设计引用的修订 1 对照表不在仓库；既有 E2E 断言「未获授权」                     |
| 诊断快捷键 ⌥⇧⌘D（设计稿为 ⌥⌘D）                                                  | ⌥⌘D 是 macOS 系统「显示 / 隐藏 Dock」                                          |
| 「采集到会话」弹出层为 `role="dialog"`                                           | 内含关联会话 `<select>`，不能是 menu                                           |
| 面板首版只有「复制 JSON」，无「暂停刷新」「导出 NDJSON」按钮                     | NDJSON 由 `WSL_STATUS_LOG` 开启                                                |
| 槽内「取消读取」对用户与执行发起的观察都提供                                     | 协议无发起者字段                                                               |
| 「文件可能变化」重新读取后不自动消失                                             | Main 既有语义（只替换不清除），本次不改                                        |

## E2E 调整与新增

按 plan §4 只改定位方式、不删断言、不放宽语义、不扩大 ignore：

- `workbench.spec.ts`：:132–137 改为按 `data-status` 定位中文 label；:68 改为在诊断面板中查看现场（该文件串行共享实例，整体启用诊断，启动用例严格断言含 `debug` 的 7 键；未启用的 6 键由 `workspace-debug.spec.ts` 原样断言）。
- `workspace-runtime.spec.ts:108`、`app-control-cancel-live.spec.ts:360`（live，仅改代码）。
- `workspace-observation.spec.ts:129` 改为左栏「设置」。
- `review-regressions.spec.ts`、`workspace-migration.spec.ts`、`space-app-model-live.spec.ts`（live）、`resources.spec.ts`、`public-document.spec.ts`、`resources-live.spec.ts`（live）：先 `openBrowserMenu` 再按原名称定位。
- `workspace-migration.spec.ts:84`（plan 补充）：原断言依赖已删除的「运行 {runId}」行，改按 `data-status-key` 定位同一运行；plan 中 :35 归属已更正（任务页导航，不改）。
- 新增 `e2e/status-surface.spec.ts`（58 个用例：各区域可见性、键盘、组合场景与三主题 × 两宽度截图）与 `e2e/debug-status.spec.ts`（启用矩阵、通道、面板、NDJSON；packaged 两行仅写代码）。`e2e/helpers.ts` 新增 `openBrowserMenu`、`clickAppMenu`、`appMenuHas` 与 `launchApp({ debugStatus, statusLog })`。

## 原实施验证（封存记录）

环境为 macOS、Node 26.5.0、pnpm 10.34.6、Electron 44.5.1。根依赖 `pnpm install --frozen-lockfile`，模板 `npm ci --ignore-scripts`；Electron 下载未完成，复用主工作树同版本二进制到本工作树依赖目录，源码与锁文件未为此更改。

| 检查             | 结果与证据                                                                                                                                                                                                                                                                                                                                                     |
| ---------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 文档与类型       | `node scripts/check-docs.mjs`、`pnpm typecheck` 通过；[文档](final-validation/check-docs.txt)、[类型](final-validation/typecheck.txt)                                                                                                                                                                                                                          |
| 产品及工具测试   | `pnpm test` 通过：87 文件 / 892 测试通过，15 跳过；打包逻辑 27、构建目录 6 通过；[日志](final-validation/test.txt)。本机高负载期间（load average 10–26，来自其他应用）曾出现 1–6 个与本改动无关的超时（service MCP、本地 PTY、observation-application、setup-adapter）；同负载下 917f375 基线导出同样失败 5 个同类用例，单独运行两者均通过；负载回落后全量通过 |
| 固定离线基线     | `pnpm baseline:selftest` 12/12 通过；[日志](final-validation/baseline-selftest.txt)，不代表真实模型完成任务                                                                                                                                                                                                                                                    |
| 构建             | `pnpm build` 通过                                                                                                                                                                                                                                                                                                                                              |
| Electron 窗口    | 全量 `pnpm exec playwright test`：148 通过、16 跳过（live / packaged）、0 失败；[日志](final-validation/e2e.txt)                                                                                                                                                                                                                                               |
| 全树 lint / 格式 | `failed`（既有）：lint 217 个错误，与基线相同且出错文件完全一致；当时记录格式 801 个文件、集合无增减；独立复核随后发现 check-delta.json 自身未格式化，实际为 802。该差异及当前集合见下文修复记录与[更新后的差异汇总](final-validation/check-delta.json)                                                                                                        |

已知非回归 E2E 现象（917f375 基线导出上同样复现，记录于 review-response.md）：`review-regressions.spec.ts:82` 间歇失败；`workspace-migration.spec.ts:151/153` 依赖系统窗口焦点。最终全量运行中两者均通过。

`pnpm check` 因既有 lint / 格式失败不能称为通过，本分支也不能称为全部 CI 绿色。

## 原实施窗口复核

各区域白 / 暗 / 暖 × 1440 / 960（<1080）正常与异常截图共 105 张生成于 `test-results/screens/build/status-surface/`（未纳入版本库），由实现子代理与主代理分区域目视复核。代表性截图：

- [标题栏：对话不可用与环境未就绪（浅色 960）](screens/titlebar-unavailable-light-960.png)
- [网页：加载失败在问题通道、另有 1 项（浅色 1440）](screens/browser-abnormal-light-1440.png)
- [会话检查页：检查无法执行（浅色 1440）](screens/session-abnormal-light-1440.png)——页内字段为记录，状态槽为告警，两处同时可见是有意保留
- [终端：SSH 连接失败（深色 960）](screens/terminal-abnormal-dark-960.png)
- [受管 App：运行失败（深色 960）](screens/app-dialog-failed-dark-960.png)
- [诊断面板（深色 1440）](screens/debug-panel-dark-1440.png)

截图中的任务名、ID 与时间为 fixture 数据，不是真实运行结果。

## 原实施验收边界与未运行项

- `not_run`：真实模型、sandbox live、签名 / 公证、打包 App（`WSL_E2E_TARGET=packaged`）与发布。`*-live.spec.ts` 与 packaged 用例只做代码调整，未运行。
- 开发服务器（`pnpm dev`）的诊断启用只由 `debugStatusEnabled` 单测覆盖。
- 用户接受：`not_run`。
- 范围外现状未改：设置页（状态主场）、「空间现场在后台保留」标题副文本、首页模式阻止 `Notice`。

## 六项修复复验（2026-10-12，未提交）

### 版本与证据边界

- 唯一产品工作树仍为 `/Users/huaodong/workspace/_worktrees/status-surface-20261011`，分支 `agent/status-surface`，HEAD `1bce260678c5d60e6889a093e0c523c333019fca`；本节记录的是其上的未提交修复，不是新的提交。
- 源码、测试由 SWE-2 实现角色完成，主代理审查与串行复验；没有更改 Main 业务状态机、命令语义、持久化格式、依赖或检查配置。未读写主工作树或其他已有工作树。
- 类型修正后的第一轮定向检查、两组重复 E2E 与第一轮全量检查绑定综合差异 SHA-256 `ab248a5aad1a2352e0be796f32c6af3a99425e546de4c3fd58c55f8314ec7008`。首轮 lint 随后检出新增 E2E 中一个未使用的 `panel` 变量（218 errors / 0 warnings）；SWE-2 仅删除该声明，未改断言或产品逻辑，定向 ESLint / Prettier 均退出 0，见 `lint-fix-targeted-*` 回执。
- 该单行测试整理后的终版综合差异 SHA-256 为 `d18e5e9dbf25264d65e80843f6d9aa5ee7b5f9b08e2bc900b494ab62e42206ab`，终版复验用 `final-v2-*` 记录；第一轮结果不冒充终版运行。哈希输入均为 `git diff HEAD -- apps/desktop/src packages/protocol/src e2e`，包括测试；前后值及 `changedDuringRun` 见每份 `.meta.json`。文档和新增证据另在落盘后检查，不把此哈希当作整个仓库的内容哈希。
- 新证据统一位于 `repair-validation/`。命令经 [run-command.mjs](repair-validation/run-command.mjs) 保存完整参数、cwd、HEAD、起止时间、退出码、受控环境覆盖与源码差异哈希；`.txt` 是 stdout / stderr 按到达顺序交错的原始字节，不重排或清理空行。既有 `final-validation/*.txt` 与红测试输出保持不变。
- 基线来自本工作树 `git archive 917f375` 的全新系统临时导出，冻结锁安装，不是切换或修改另一工作树，见 [baseline-export.json](repair-validation/baseline-export.json)。它仅用于独立对照，不替代当前树验证。
- 测试及 Electron 窗口套件串行执行；默认 Vitest 保持原配置，因实际超时补充的低并发运行单独标注，Playwright 使用原配置的 1 worker；wrapper 强制 `WSL_E2E_TARGET=build`，关闭继承的 live 开关和 packaged hash-rejection 开关。不使用 `pnpm check` 的提前退出替代独立结果。

### 六项修复与验收映射

| 问题              | 有界修改与行为                                                                                                                                                                                                                                                   | 当前证据                                                                                                                                                                            |
| ----------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 1 日志覆盖        | `main/debug-status.ts` 改为 `wx` / `0600` 独占创建。已有文本、同 snapshot 前缀的任意 JSON、旧日志、空文件、目录和链接均拒绝接管；失败报告一次并停写，不影响诊断内存；保留 500 条转换缓冲及含 limit 行的 5 MiB 上限，无轮转、备份或迁移                           | 红测试复现原 JSON / 旧日志被改写，日志测试在定向与全量阶段均通过（默认全量整体结果另列）；红绿日志分别保留为 `diagnostics-red-*` / `diagnostics-green-*`                            |
| 2 统一事实 / 展示 | `shared/status/facts.ts` 产出 `file:<id>:unavailable`，degraded / problem、优先级 60、raw `{}`，空原因取默认说明。Files 删除重复行内提示；Observation 经 `state/status-view.ts` 取四态历史、来源及共享中文错误标签，历史不提升为当前告警，表单与取消操作语义保留 | 事实 / 展示层单测；文件缺环境 / 带原因及历史错误分离的正式 E2E；[组件 grep](repair-validation/component-status-grep.json) 仅剩操作启用条件使用 unavailableReason                    |
| 3 诊断刷新        | Main / preload / protocol 增加仅诊断启用时存在的只读 `debug:facts-changed` / `onFactsChanged`；detail / raw 独变不产生转换、seq 或 NDJSON。Renderer 先订阅后初读，单在途请求、合并通知、丢弃过期响应、卸载清理，无轮询                                           | Main / Renderer 单测覆盖投影相等、appInstanceId / 脱敏上下文变化、通知异常及失败恢复；面板持续打开 E2E 覆盖详情、raw、合并、关闭与复制一致；默认六键及 PageCapture 出口边界断言保留 |
| 4 SSH 禁用        | Terminal 工具栏消费统一 `terminal.connect.disabled`；failed / closed / idle 且 cleanupPending 时可见但禁用，清理确认后恢复；starting / closing 与 Ctrl-C 名称不变。Main 拒绝语义不改                                                                             | 新状态矩阵 E2E；原 SSH 实际回环 / PTY 用例增加禁用断言，仍经具名业务接口验证 Main 明确拒绝和 PTY 不增加；原未确认常驻用例重复 3 次                                                  |
| 5 正式 E2E        | 仅扩展指定 status-surface / debug-status / helpers，以及问题 4 必需的 ssh-product；新增 7 条以「修复复验：」命名，涵盖三种组合、Tab / Enter、方向键 / Esc 回焦、原生网页让位 / 恢复、文件、历史和诊断                                                            | 定向 70 通过 / 2 packaged 跳过；新增 7 条各 3 次共 21 通过，原三条各 3 次共 9 通过；11 张新图见下节                                                                                 |
| 6 证据一致        | 原实施结果和修复结果分开；check-delta 已定向格式化；旧原始输出不改。最后比较 lint 错误数与文件集合、format 文件集合，而非仅比较总数                                                                                                                              | 基线与终版 errors 均 217、warnings 均 0、format 均 801，完整文件集合相同，新增 / 消除均空；封存重放回执见后节                                                                       |

### 定向与重复验证

下列日志均在 `repair-validation/`，同名 `.meta.json` 记录完整命令与退出码。首次失败、修正后复跑是两个独立结果，未拼接成一次通过。

| 命令                                                                                                                                                                                                                                               | 退出码 | 结果                                                                                                         | 原始输出                                                   |
| -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------ | ------------------------------------------------------------------------------------------------------------ | ---------------------------------------------------------- |
| `pnpm typecheck`（首次）                                                                                                                                                                                                                           | 2      | 新增 Renderer 单测的 `setImmediate` 无类型；仅改为 `setTimeout(resolve, 0)` 刷新助手，未改测试超时或产品逻辑 | [首次类型检查](repair-validation/targeted-typecheck.txt)   |
| `pnpm typecheck`（修正后）                                                                                                                                                                                                                         | 0      | 产品、E2E 与基线类型通过                                                                                     | [独立复跑](repair-validation/targeted-typecheck-rerun.txt) |
| `pnpm exec vitest run apps/desktop/src/shared/status apps/desktop/src/main/debug-status.test.ts apps/desktop/src/main/ipc-guard.test.ts apps/desktop/src/renderer/src/state/status-view.test.ts apps/desktop/src/renderer/src/state/debug.test.ts` | 0      | 6 文件、196 测试通过，0 失败 / 跳过                                                                          | [定向单测](repair-validation/targeted-vitest.txt)          |
| `pnpm build`                                                                                                                                                                                                                                       | 0      | 构建通过；Zod / Rollup 注释警告保留                                                                          | [定向构建](repair-validation/targeted-build.txt)           |
| `pnpm exec playwright test e2e/status-surface.spec.ts e2e/debug-status.spec.ts e2e/ssh-product.spec.ts`                                                                                                                                            | 0      | 70 通过、2 跳过、0 失败                                                                                      | [定向窗口](repair-validation/targeted-e2e.txt)             |
| `pnpm exec playwright test e2e/status-surface.spec.ts e2e/debug-status.spec.ts --grep '修复复验：' --repeat-each=3`                                                                                                                                | 0      | 精确选中新增 7 条，共 21 通过、0 失败 / 跳过                                                                 | [新增三次重复](repair-validation/new-e2e-repeat3.txt)      |
| `pnpm exec playwright test e2e/status-surface.spec.ts --grep '终端已关闭：提示可见\|SSH 断线后进程未确认\|会话状态条：取消中' --repeat-each=3`                                                                                                     | 0      | 原三条各 3 次，共 9 通过、0 失败 / 跳过                                                                      | [原有三次重复](repair-validation/original-e2e-repeat3.txt) |

### 第一轮全量验证（lint 整理前）

本轮首个默认全量单测通过，但首个全量 Electron E2E 为 `failed`；局部复跑的通过不覆盖或拼接替代该失败结果。下表各次运行间源码和断言保持不变，未增加重试或延长超时。之后仅删除未使用变量，终版另行复验，不能抹去本表的失败：

| 命令                                                                                                                                                                              | 退出码 | 结果                                                                                                                                      | 原始输出                                                             |
| --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------ | ----------------------------------------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------- |
| `node scripts/check-docs.mjs`                                                                                                                                                     | 0      | 19 个规范文件；只检查入口、链接目标和尾随空白，不代表语义验收                                                                             | [文档](repair-validation/final-check-docs.txt)                       |
| `pnpm typecheck`                                                                                                                                                                  | 0      | 产品、E2E、基线类型通过                                                                                                                   | [类型](repair-validation/final-typecheck.txt)                        |
| `pnpm test`                                                                                                                                                                       | 0      | Vitest：87 文件通过、6 文件跳过；915 测试通过、15 跳过、0 失败。其后打包逻辑单测 27/27、构建目录单测 6/6 通过；没有执行打包 / 签名 / 发布 | [全量单测](repair-validation/final-test.txt)                         |
| `pnpm baseline:selftest`                                                                                                                                                          | 0      | 12/12 合成自检通过；Node DEP0205 弃用警告原样保留，不是模型验收                                                                           | [离线自检](repair-validation/final-baseline-selftest.txt)            |
| `pnpm build`                                                                                                                                                                      | 0      | service 与 desktop 构建通过，Zod 的 Rollup 注释警告保留                                                                                   | [构建](repair-validation/final-build.txt)                            |
| `pnpm exec playwright test`                                                                                                                                                       | 1      | 153 通过、16 跳过、2 失败；本轮新增 7 条均通过，失败详情见下                                                                              | [全量窗口](repair-validation/final-e2e.txt)                          |
| `pnpm exec playwright test e2e/status-surface.spec.ts`（失败文件独立复跑）                                                                                                        | 1      | 61 通过、3 失败、0 跳过，另有 2 个 worker 清理超时；原首页截图用例通过，但出现其他启动 / 生命周期失败，不能称文件复跑通过                 | [状态文件复跑](repair-validation/final-e2e-status-file-rerun.txt)    |
| `pnpm exec playwright test e2e/workspace-migration.spec.ts`（失败文件独立复跑）                                                                                                   | 0      | 8 通过、0 失败 / 跳过；原生焦点用例通过。两条预期 Renderer 异常是通过的负控，不是新的未处理异常                                           | [迁移文件复跑](repair-validation/final-e2e-migration-file-rerun.txt) |
| `pnpm exec playwright test e2e/status-surface.spec.ts --grep '侧栏：「后台资源 / 已关闭标签」没有内容时不出现\|终端已关闭：提示可见\|App 对话框截图：' --trace=retain-on-failure` | 0      | 对上述三条新增失败做一次独立诊断运行，3 通过、0 失败 / 跳过；仅加失败保留 trace，不改断言、重试或超时。不替代失败的默认文件 / 全量结果    | [生命周期诊断](repair-validation/final-e2e-lifecycle-probe.txt)      |

首轮 `pnpm lint` 退出 1：218 errors、0 warnings，新增的 `e2e/status-surface.spec.ts:645` 未使用变量已在终版删除；[原始失败](repair-validation/final-lint.txt) 不覆盖，终版基线集合对照另列。

### 第一轮 E2E 失败核对（不归并为全量通过）

- 全量的 `workspace-migration.spec.ts:153/181` 失败为原生 `webContents.isFocused()` 的 true / false 断言，与 [已记录现象](../../design/2026-10-11-status-surface/review-response.md) 的系统焦点依赖一致；本轮文件未改，独立文件复跑通过。该记录来自此前 917f375 复核，本轮未重新运行基线窗口套件。
- 全量的 `status-surface.spec.ts:1860/1873` 首页截图在 `helpers.ts:453` 导航按钮脱离 DOM 后 30 秒超时。SWE-2 只读核对：本用例、launchApp、resize、theme、workshopNavigate，以及 Workshop / panels / shell 导航实现均未修改；本用例不安装新增 shim，且诊断关闭。窄窗 peek 导航卸载是可能机制，不是已证实根因。原定向运行及此次文件复跑中该用例通过，但归因仍为 `undetermined`，不把它冒充已在 917f375 复现的既有问题，也不声称完全排除时序影响。
- 状态文件复跑新增失败：`:324` 侧栏用例 90 秒超时、`:476` 终端生命周期用例在进入业务断言前等待 Renderer `div.app` 10 秒超时、`:2566/2591` App 截图期间目标页面关闭；另有两次 90 秒 worker teardown 超时。这些症状与已列 service / observation / setup 负载超时不同，未直接归为基线问题。三条用例的独立诊断运行随后通过，但归因仍 `undetermined`；停止循环复跑，不以「最终一次变绿」覆盖首次失败。
- 复跑后按本工作树 Electron 可执行路径筛查没有残留匹配进程（pgrep 退出 1、空输出），磁盘剩余 13 GiB；[进程](repair-validation/post-rerun-electron-processes.txt)、[磁盘](repair-validation/post-rerun-disk.txt)、[负载](repair-validation/post-rerun-load.txt)、[内存](repair-validation/post-rerun-memory.txt) 均保留。它们是失败后的资源快照，不足以证明失败由负载或内存造成；没有清缓存、删证据或杀其他应用。
- 每次下一轮 Playwright 清理输出目录前，以 `git diff --no-index -- /dev/null <error-context.md>` 原样保存错误上下文：[全量首页](repair-validation/final-e2e-home-context.txt)、[全量焦点](repair-validation/final-e2e-focus-context.txt)、[复跑侧栏](repair-validation/status-rerun-sidebar-context.txt)、[复跑启动](repair-validation/status-rerun-startup-context.txt)、[复跑截图](repair-validation/status-rerun-screenshot-context.txt)。这些归档命令退出 1 表示相对空文件存在内容差异，不是又一次测试失败。

### 终版复验（v2，删除未使用变量后）

以下均绑定终版综合差异 `d18e5e9d…2206ab`，重新运行用户要求的定向、两组三次重复及全量序列；不是复用首轮回执。默认单测失败、低并发补充与终版全量窗口通过分别记录；lint / format 的完整文件集合对照见后节。

| 命令 / 阶段                                                                                                                                    | 退出码 | 结果                                                                                                              | 原始输出                                                         |
| ---------------------------------------------------------------------------------------------------------------------------------------------- | ------ | ----------------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------- |
| `pnpm typecheck`（定向）                                                                                                                       | 0      | protocol / service / desktop、E2E 与 baseline 类型检查通过                                                        | [定向类型](repair-validation/final-v2-typecheck.txt)             |
| 指定 6 文件的 `pnpm exec vitest run`（完整参数见 meta）                                                                                        | 0      | 196 通过、0 失败 / 跳过                                                                                           | [定向单测](repair-validation/final-v2-targeted-vitest.txt)       |
| `pnpm build`（定向）                                                                                                                           | 0      | service / desktop 构建通过，原依赖 Rollup 注释警告保留                                                            | [定向构建](repair-validation/final-v2-targeted-build.txt)        |
| `pnpm exec playwright test e2e/status-surface.spec.ts e2e/debug-status.spec.ts e2e/ssh-product.spec.ts`                                        | 0      | 70 通过、2 packaged 跳过、0 失败                                                                                  | [定向窗口](repair-validation/final-v2-targeted-e2e.txt)          |
| `pnpm exec playwright test e2e/status-surface.spec.ts e2e/debug-status.spec.ts --grep '修复复验：' --repeat-each=3`                            | 0      | 新增 7 条各三次，21 通过、0 失败 / 跳过                                                                           | [新增重复](repair-validation/final-v2-new-e2e-repeat3.txt)       |
| `pnpm exec playwright test e2e/status-surface.spec.ts --grep '终端已关闭：提示可见\|SSH 断线后进程未确认\|会话状态条：取消中' --repeat-each=3` | 0      | 原三条各三次，9 通过、0 失败 / 跳过                                                                               | [原有重复](repair-validation/final-v2-original-e2e-repeat3.txt)  |
| `node scripts/check-docs.mjs`（全量）                                                                                                          | 0      | 19 个规范文件；入口、链接目标与尾随空白通过                                                                       | [文档](repair-validation/final-v2-check-docs.txt)                |
| `pnpm typecheck`（全量）                                                                                                                       | 0      | 默认类型检查通过                                                                                                  | [全量类型](repair-validation/final-v2-full-typecheck.txt)        |
| `pnpm test`（默认配置）                                                                                                                        | 1      | 914 通过、15 跳过、1 失败；setup-adapter 第 42 行用例 5000ms 超时，后续两个脚本被 `&&` 短路，不能报告默认命令通过 | [默认单测失败](repair-validation/final-v2-test.txt)              |
| `pnpm exec vitest run apps/desktop/src/main/setup-adapter.test.ts`                                                                             | 0      | 失败文件独立复跑 6/6 通过                                                                                         | [单文件复跑](repair-validation/final-v2-setup-adapter-rerun.txt) |
| `pnpm exec vitest run --maxWorkers=2`                                                                                                          | 0      | 降低并行度的独立补充：87 文件通过、6 文件跳过；915 测试通过、15 跳过、0 失败，不代替默认 `pnpm test`              | [低并发补充](repair-validation/final-v2-vitest-workers2.txt)     |
| `node --test scripts/packaging/*.test.mjs`                                                                                                     | 0      | 独立补跑 27/27；是打包逻辑单测，不是执行打包 / 签名 / 发布                                                        | [打包逻辑](repair-validation/final-v2-packaging-tests.txt)       |
| `pnpm test:external-builds`                                                                                                                    | 0      | 独立补跑 6/6                                                                                                      | [构建目录](repair-validation/final-v2-external-build-tests.txt)  |
| `pnpm baseline:selftest`                                                                                                                       | 0      | 12/12 合成自检；DEP0205 警告原样保留，不是模型任务验收                                                            | [离线自检](repair-validation/final-v2-baseline-selftest.txt)     |
| `pnpm build`（全量）                                                                                                                           | 0      | service / desktop 构建通过；Zod / Rollup 注释警告原样保留                                                         | [全量构建](repair-validation/final-v2-build.txt)                 |
| `pnpm exec playwright test`（全量）                                                                                                            | 0      | 155 通过、16 跳过、0 失败；1 worker、build / 离线 fixture。不是拼接局部结果                                       | [全量窗口](repair-validation/final-v2-e2e.txt)                   |

终版默认单测失败是 `installer native boundaries > accepts actual sanitized sbx inspect shape, rejects mounts and daemon drift` 的 5000ms 超时，而不是字段/行为断言失败。对应测试及实现相对 917f375 [无差异](repair-validation/final-v2-setup-source-diff.txt)（命令退出 0、输出为空），独立文件及低并发运行均通过；与原记录和用户已列明的负载敏感超时类别一致。本轮没有新做基线全量单测复现，不从文件名或补跑通过直接断言具体系统根因，未更改该文件、超时或断言。

终版全量窗口通过只说明本次完整运行结果；首轮首页导航、启动/生命周期与清理超时的原始失败仍保留，不宣称被删除未使用变量这一无行为修改「修好」。未因间歇问题增加重试或跳过。

### 窗口与截图证据

- 新增用例和原三条的重复结果分别为 21/21 与 9/9；不是把多次局部通过合并为全量通过。窗口验证使用真正的 Electron Main / preload / Renderer，组合条件通过满足 schema 的测试快照 shim 注入；SSH 用本地回环与真实 PTY，不连接线上沙箱或真实模型。
- [终版截图清单与 SHA-256](repair-validation/final-v2-new-e2e-repeat3-screens.json) 独占归档 11 张终版截图，绑定 `final-v2-new-e2e-repeat3.meta.json` 的时段和 `d18e5e9d…2206ab` 哈希；源文件 mtime 均在运行起止时刻的 1 秒容差内。PNG 头 / IHDR、尺寸和字节数经程序检查，复制原字节并记录哈希。`shasum --algorithm 256 --check` 对归档目标复核 11/11 OK、退出 0，见 [校验输出](repair-validation/final-v2-verify-screens.txt)。没有用首轮图片替代终版运行。
- [首轮 11 张截图](repair-validation/new-e2e-repeat3-screens.json) 另行保留，绑定首轮 `ab248a5a…7008`，不覆盖、不改名冒充终版；其归档哈希也 [11/11 校验通过](repair-validation/verify-archived-screens.txt)。两套是不同运行证据，不是 22 个不同场景。
- 三个组合各含 1440 / 960 条件，共 6 张；文件不可用两态、观察历史、终端清理未确认、诊断实时更新共 5 张。高 DPI PNG 中 8 张为 2880×1718、3 张为 1920×1400，详见清单。
- 代表图：[AI / 失败 / 拦截组合](repair-validation/screens/final-v2-new-e2e-repeat3/combo-ai-loaderror-blockednav-1440.png)、[暂停 / 断开组合](repair-validation/screens/final-v2-new-e2e-repeat3/combo-paused-detached-960.png)、[折叠菜单](repair-validation/screens/final-v2-new-e2e-repeat3/combo-problem-more-1440.png)、[文件不可用](repair-validation/screens/final-v2-new-e2e-repeat3/files-unavailable-no-env-1440.png)、[观察历史](repair-validation/screens/final-v2-new-e2e-repeat3/files-observation-history-1440.png)、[连接禁用](repair-validation/screens/final-v2-new-e2e-repeat3/terminal-cleanup-pending-disabled-1440.png)、[诊断更新](repair-validation/screens/final-v2-new-e2e-repeat3/debug-panel-live-update-1440.png)。
- 本轮没有把 PNG 图像内容读入模型，不声称进行了逐图人工目视或像素级复核。可见文本、实际焦点、Tab / Enter / 方向键 / Esc、原生网页让位与恢复、动作参数及禁用状态由正式 E2E 断言证明，截图本身不证明这些动态行为。

### lint / format 文件集合与落盘后封存

基线为独立 `git archive 917f375` 导出并按冻结锁安装的临时目录；lint 使用完整 `eslint . --format json`，format 使用未缩小范围的 `pnpm format:check`，不修改 ignore 或检查配置。比较器核对完整相对路径集合，不只比数量，原始结果及双方文件数组见 [check-delta-v2.json](repair-validation/check-delta-v2.json)，比较命令 [退出 0](repair-validation/compare-v2-checks.meta.json)。

| 项目            | 917f375 基线 | 终版 | 新增 / 消除 | 文件集合                      |
| --------------- | ------------ | ---- | ----------- | ----------------------------- |
| lint errors     | 217          | 217  | 0 / 0       | 完全相同                      |
| lint warnings   | 0            | 0    | 0 / 0       | 不把零 warnings 写成零 errors |
| format 失败文件 | 801          | 801  | 0 / 0       | 完全相同                      |

对应命令及其独立结果：

| 命令                                                   | 退出码 | 结果 / 证据                                                                                                                                                            |
| ------------------------------------------------------ | ------ | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `pnpm lint`                                            | 1      | 217 errors、0 warnings；[终版原始输出](repair-validation/final-v2-lint.txt)                                                                                            |
| `pnpm exec eslint . --format json`                     | 1      | 全量机器可读结果，与基线比较；[终版 JSON 原始输出](repair-validation/final-v2-lint-json.txt)                                                                           |
| 基线目录的 `pnpm exec eslint . --format json`          | 1      | 217 errors、0 warnings；[基线 JSON 原始输出](repair-validation/baseline-lint-json.txt)，完整目录参数见 meta                                                            |
| 基线目录的 `pnpm format:check`                         | 1      | 801 个文件；[基线格式](repair-validation/baseline-format.txt)                                                                                                          |
| `pnpm format:check`（本轮记录首次）                    | 1      | 802 个文件；新增的是 `repair-validation/component-status-grep.json`，不是旧 `check-delta.json`；[失败原始输出](repair-validation/final-v2-format.txt)                  |
| 仅格式化上述本轮 grep 记录，再运行 `pnpm format:check` | 0 / 1  | 记录格式化退出 0，完整格式检查仍退出 1、801 文件；[格式化](repair-validation/final-v2-format-grep-record.txt)、[完整复跑](repair-validation/final-v2-format-fixed.txt) |
| `git diff --check`                                     | 0      | 相对 HEAD 的未提交差异无输出；[回执](repair-validation/final-v2-diff-check.meta.json)                                                                                  |
| `git diff --cached --check`                            | 0      | 索引检查无输出；[回执](repair-validation/final-v2-cached-diff-check.meta.json)                                                                                         |
| `git diff 917f375 --check`                             | 2      | 历史 `final-validation/typecheck.txt:15` 的 EOF 新增空行；[原样告警](repair-validation/final-v2-baseline-diff-check.txt)。旧日志不编辑，不声称所有比较均无空白告警     |
| `git status --short`                                   | 0      | 26 个 tracked 修改与新增 `repair-validation/` 目录；未暂存、未提交；[状态](repair-validation/final-v2-status.txt)                                                      |

独立复核时「801 记录 / 802 实测」来自旧 `final-validation/check-delta.json` 自身未格式化，本轮已格式化并将其更新为 [终版摘要](final-validation/check-delta.json)。本轮 grep 记录后来也出现一次相同数量但不同路径的格式错误，单独保留、修正和复跑，不能混为同一次检查。

为避免比较记录落盘后又引入未检查文件，封存阶段在本 README、delta 摘要、完整集合报告及其余证据落盘并格式化后，重新执行全量 lint、ESLint JSON 和 format。封存回执：[lint](repair-validation/sealed-final-lint.meta.json)、[ESLint JSON](repair-validation/sealed-final-lint-json.meta.json)、[format](repair-validation/sealed-format.meta.json)。随后以 `git diff --no-index` 将新原始 ESLint JSON / format 输出与本节比较器输入逐字节核对：[lint 重放核对](repair-validation/sealed-lint-replay.meta.json)、[format 重放核对](repair-validation/sealed-format-replay.meta.json)；只有二者均退出 0 才说明最终文件集合与本节记录仍一致。记录自身的格式检查见 [封存记录检查](repair-validation/sealed-records-format.meta.json)。原始 `.txt` 不格式化。

终版仍不能声明 `pnpm check` 全绿：默认单测有一次保留的超时失败，全量 lint / format 仍是既有失败。补跑、减少并行度、fixture 窗口通过和用户接受是不同结论。

### 本轮未验证与范围外事项

- `not_run`：真实模型、sandbox live、packaged E2E、开发服务器真实启动、打包、签名、公证、发布与部署，均未获本轮运行授权；开发服务器启用条件仅有单测证据。
- `not_run`：用户接受和本轮截图的人工目视复核；静态检查、fixture 窗口交互与用户接受分别记录。
- 未扩大修复范围：已记录的 review-regressions 间歇问题、workspace-migration 系统焦点依赖及其他既有负载超时；如本轮出现，必须按实际症状单列，不仅凭文件名归类。
- 保留原封存 `final-validation/typecheck.txt:15` 的 EOF 空行；最终会同时记录相对 HEAD 的 diff 检查与相对 `917f375` 的历史空白告警，不清理日志字节来制造无告警。
- 本轮不 commit、不 push、不创建 PR；最终状态与差异范围待全部新证据落盘后的检查回执确认。
