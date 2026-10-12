# 状态降噪与统一状态接口（2026-10-11）

按已确认的[设计（修订 2）](../../design/2026-10-11-status-surface/README.md)实施。健康稳态不再以常驻文字占据界面；需要用户处理或改变了可做之事的状态显式出现；控制权、进行中与未确认的事实不被折叠。界面、诊断面板、调试 IPC 与日志共用同一份状态事实。交付范围为本地分支，未推送、未创建远端 PR、未发布或部署。

## 分支与审阅入口

分支 `agent/status-surface`，独立工作树 `/Users/huaodong/workspace/_worktrees/status-surface-20261011`，基线 `codex/consolidate-review-20261011` @ `917f375`。主工作树与其他工作树未修改。

先读设计目录的 [review-response.md](../../design/2026-10-11-status-surface/review-response.md)「实施期修订」表：其中每项设计修订都经用户确认。再按下表逐个提交审阅：

| 提交       | 阶段 | 内容                                                                        |
| ---------- | ---- | --------------------------------------------------------------------------- |
| `8fb875e`  | —    | 纳入设计目录                                                                |
| `c6c21d5`  | P0   | 协议 DTO 与按域 raw 白名单；`apps/desktop/src/shared/status` 事实投影与脱敏 |
| `7f590a4`  | P1   | 展示层 `status-view.ts`、StatusDot / StatusSlot、错误出口合并为 Toast 队列  |
| `e0fe86e`  | P2-1 | 标题栏；全局持续条件进标题栏，Toast 只放一次性失败                          |
| `d499077`  | P2-2 | 侧栏标签行尾状态点；`cleanupPending` 事实时机修订                           |
| `cc48a20`  | P2-3 | 终端胶囊、图标按钮、状态槽                                                  |
| `b83ca38`  | P2-4 | 网页工具栏「采集到会话 ⌄」「⋯」、页面状态进状态槽                           |
| `d952b0b`  | P2-5 | 会话、运行详情、运行记录菜单、会话输入区                                    |
| `01dc4b4`  | P2-6 | Composer、首页、通知与任务历史中文标签                                      |
| `9d71270`  | P2-7 | 观察「来源」折叠区、文件首次说明与变化提示                                  |
| `ca57b76`  | P2-8 | 受管 App 对话框                                                             |
| `f6df6b5`  | P3   | 诊断通道 `debug:status`、诊断面板与 NDJSON                                  |
| （本提交） | P4   | `UX-CONTRACT.md`、`DESIGN.md`、架构说明与本验收记录                         |

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

## 本轮验证

环境为 macOS、Node 26.5.0、pnpm 10.34.6、Electron 44.5.1。根依赖 `pnpm install --frozen-lockfile`，模板 `npm ci --ignore-scripts`；Electron 下载未完成，复用主工作树同版本二进制到本工作树依赖目录，源码与锁文件未为此更改。

| 检查             | 结果与证据                                                                                                                                                                                                                                                                                                                                                     |
| ---------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 文档与类型       | `node scripts/check-docs.mjs`、`pnpm typecheck` 通过；[文档](final-validation/check-docs.txt)、[类型](final-validation/typecheck.txt)                                                                                                                                                                                                                          |
| 产品及工具测试   | `pnpm test` 通过：87 文件 / 892 测试通过，15 跳过；打包逻辑 27、构建目录 6 通过；[日志](final-validation/test.txt)。本机高负载期间（load average 10–26，来自其他应用）曾出现 1–6 个与本改动无关的超时（service MCP、本地 PTY、observation-application、setup-adapter）；同负载下 917f375 基线导出同样失败 5 个同类用例，单独运行两者均通过；负载回落后全量通过 |
| 固定离线基线     | `pnpm baseline:selftest` 12/12 通过；[日志](final-validation/baseline-selftest.txt)，不代表真实模型完成任务                                                                                                                                                                                                                                                    |
| 构建             | `pnpm build` 通过                                                                                                                                                                                                                                                                                                                                              |
| Electron 窗口    | 全量 `pnpm exec playwright test`：148 通过、16 跳过（live / packaged）、0 失败；[日志](final-validation/e2e.txt)                                                                                                                                                                                                                                               |
| 全树 lint / 格式 | `failed`（既有）：lint 217 个错误，与基线相同且出错文件完全一致；格式 801 个文件，与基线集合完全一致，无新增无修复；[差异](final-validation/check-delta.json)。新增 / 修改的源码、测试与规范定向检查通过                                                                                                                                                       |

已知非回归 E2E 现象（917f375 基线导出上同样复现，记录于 review-response.md）：`review-regressions.spec.ts:82` 间歇失败；`workspace-migration.spec.ts:151/153` 依赖系统窗口焦点。最终全量运行中两者均通过。

`pnpm check` 因既有 lint / 格式失败不能称为通过，本分支也不能称为全部 CI 绿色。

## 窗口复核

各区域白 / 暗 / 暖 × 1440 / 960（<1080）正常与异常截图共 105 张生成于 `test-results/screens/build/status-surface/`（未纳入版本库），由实现子代理与主代理分区域目视复核。代表性截图：

- [标题栏：对话不可用与环境未就绪（浅色 960）](screens/titlebar-unavailable-light-960.png)
- [网页：加载失败在问题通道、另有 1 项（浅色 1440）](screens/browser-abnormal-light-1440.png)
- [会话检查页：检查无法执行（浅色 1440）](screens/session-abnormal-light-1440.png)——页内字段为记录，状态槽为告警，两处同时可见是有意保留
- [终端：SSH 连接失败（深色 960）](screens/terminal-abnormal-dark-960.png)
- [受管 App：运行失败（深色 960）](screens/app-dialog-failed-dark-960.png)
- [诊断面板（深色 1440）](screens/debug-panel-dark-1440.png)

截图中的任务名、ID 与时间为 fixture 数据，不是真实运行结果。

## 验收边界与未运行项

- `not_run`：真实模型、sandbox live、签名 / 公证、打包 App（`WSL_E2E_TARGET=packaged`）与发布。`*-live.spec.ts` 与 packaged 用例只做代码调整，未运行。
- 开发服务器（`pnpm dev`）的诊断启用只由 `debugStatusEnabled` 单测覆盖。
- 用户接受：`not_run`。
- 范围外现状未改：设置页（状态主场）、「空间现场在后台保留」标题副文本、首页模式阻止 `Notice`。
