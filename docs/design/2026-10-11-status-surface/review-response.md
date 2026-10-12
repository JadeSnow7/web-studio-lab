# 审核意见处理（修订 2）

审核结论：降噪方向合理，修订后再进入实施。以下逐条对应处理；所有涉及源码的判断已在 `917f375` 上复核。

## 实施前必须解决

| # | 意见 | 复核 | 处理 | 位置 |
| - | ---- | ---- | ---- | ---- |
| P1-1 | 单条状态槽会让 AI 操控、暂停恢复、取消与清理未确认被其他错误折叠；SSH「未确认」被描述为交互后降级，与接口表冲突 | 成立 | 引入事实 `kind`；状态槽分**常驻 / 问题 / 提示**三通道。control、unresolved、progress 全部进常驻通道，不参与优先级竞争、不折叠、不降级。只有 confirmation 与 hint 会因交互消失。SSH 未确认改为 `unresolved` | design.md §3–4；status-interface.md §2、§5；tiers 稿 |
| P1-2 | `StatusInput` 无法推导历史选择、过渡确认、一次性提示与 Browser 本地提示 | 成立 | 拆为两层：①业务事实 `projectFacts`（只吃 Main 快照，Main 与 Renderer 共用）；②展示 `presentStatus`（Renderer 独有，输入含选择、确认、hint、界面错误、遮挡、输出缺口）。补齐历史选择改写、hint 生命周期、确认记录与 `instanceToken` 失效、切空间 / 实例更换的重置规则。组件只调用 `useStatusView` | status-interface.md §1、§6 |
| P1-3 | `web:<resourceId>` 单键与「同页多个条件分别产出」矛盾 | 成立 | 键改为 `domain:entityId:facet`，逐域列出 facet；补「全 facet 同时成立时键两两不同」的测试要求 | status-interface.md §3；plan.md P0 |
| P1-4 | `ExecutionStatus.available:false` 表示 T04 未接入，不是 Runner 故障 | 成立（`main/execution.ts` 固定返回该值） | 新增 `capability` 种类：只在设置页与诊断面板出现，不进 Toast、标题栏或状态槽，无动作；单测锁定 | status-interface.md §4.1；design.md §1、§5 |

## 接口与验收

| # | 意见 | 复核 | 处理 | 位置 |
| - | ---- | ---- | ---- | ---- |
| P2-5 | `!app.isPackaged` 会让 E2E 的 build 产物默认启用诊断；packaged helper 清除 `WSL_*`；输入区名称变化会影响「会话消息」精确匹配 | 成立（`e2e/helpers.ts:68,100`；15 处精确 textbox 匹配 + 4 处 getByLabel） | 启用判定改为 `rendererSource().kind === 'dev-server' \|\| WSL_DEBUG_STATUS === '1'`；给出 5 种场景的验证矩阵与 `launchApp({ debugStatus })` 接线。输入框可访问名称**保持不变**，「发送到 · …」改为 `aria-describedby` 描述 | status-interface.md §8.1、§9；plan.md P3、§4 |
| P2-6 | 文案、优先级与选择逻辑放进 `packages/protocol` 违反包边界 | 成立（ARCHITECTURE.md：只容纳跨进程 schema、DTO、事件信封） | 协议包只保留 DTO 与 raw 白名单 schema；事实投影放 `apps/desktop/src/shared/status`（Main 与 Renderer 公开入口，需更新两个 tsconfig 的 `include`）；展示投影放 Renderer | status-interface.md §1、§10 |
| P2-7 | 诊断落盘缺少脱敏与大小边界 | 成立 | raw 改为按域白名单 schema，明确排除截图、PageCapture、终端输出、消息、文件内容、凭据；区分面板 / 复制导出 / NDJSON 三种出口，PageCapture 只在面板内查看且不可导出；规定 URL、路径、SSH 主机、凭据模式的脱敏与长度、缓冲、文件上限 | status-interface.md §8.2–8.5 |

## 文稿一致性

| 意见 | 处理 |
| ---- | ---- |
| 散列一处折叠进「来源」、一处完全不呈现 | 统一为：版本 / 散列是结果元数据，在「来源」展开区可见（满足合同「散列可见」）；诊断专属的只有 `evidenceRef` 等内部引用。design.md §3、status-interface.md §4.8、contract-changes.md A2 / A3 / C 已同步 |
| after 稿没有异常状态，不能证明异常仍被保留；只用 `data-status` 或隐藏文本断言不足 | 新增 `after-anomaly` 设计稿，使用与 before 相同的异常集合；plan.md 新增 §5「可见性与键盘验收」，必须显式的条目用 `toBeVisible()`、Tab / Enter / Esc 断言，覆盖组合场景 |

## 决策 1 的细化（2026-10-11 已确认）

决策 1 原为「仅开发构建 + `WSL_DEBUG_STATUS=1`」。为了不让 E2E 使用的 `pnpm build` 产物（未打包，但不是开发服务器）默认开启诊断，「开发构建」现在具体定义为 **`pnpm dev` 的开发服务器**。按这个定义，build 产物与正式包都需要显式设置 `WSL_DEBUG_STATUS=1`。如果你希望本地 build 产物也默认开启，需要另找办法让现有的六键测试成立，例如由测试显式关闭。

## 实施期修订（2026-10-11，用户已确认）

P0 独立审查发现两处设计与源码事实的冲突，经用户确认后修订：

| 审查项 | 问题 | 修订 | 位置 |
| ------ | ---- | ---- | ---- |
| P0 审查 P2-1 | `app-cleanup` 仅在执行器已确认停止时产出；Main 重启恢复（`main/workbench/application.ts` 恢复分支）时执行器状态缺失或未确认，现有 `Session.tsx` 仍显示「重新核对」，按原设计会丢失该动作 | 只要 `appCleanupPending` 就产出；按执行器状态切换文案，动作条件不变 | status-interface.md §4.5 |
| P0 审查 P2-3 | context 三个 facet 共用 `sessionId:requestId` 令牌，已确认的「历史已恢复」在每次新采集后重现 | history-restored 令牌改为 `sessionId` | status-interface.md §6.3 |
| 实施期问题（P2 标题栏） | 全局 problem 进 Toast 会在 `pnpm dev` 与未打包 E2E（无 `runtime.json`，环境未就绪）中常驻右下角；先改为「可关闭 Toast」，全量 E2E 仍有 9 个既有用例因 Toast 遮挡发送按钮与 `getByRole('alert')` 多重命中失败 | 持续条件改进标题栏（「Codex CLI · 对话不可用」「环境 · {label}」），Toast 只承载一次性失败 | status-interface.md §5；design.md §4 |
| 实施期问题（P2 侧栏） | `cleanupPending` 在终端与运行的进程存活期间始终为 true，按原 §4.2 / §4.5 健康的已连接终端与执行中的运行会常驻「未确认」 | 终端 cleanup 仅在 failed / closed / idle 时产出；运行 process-cleanup 仅在终态产出 | status-interface.md §4.2、§4.5 |
| 实施期问题（P2 App 对话框） | `app:<ws>:state` 的 created label「已创建，未启动」与既有 `e2e/workshop-actions.spec.ts` 对对话框首个 status 的精确断言「已创建」冲突 | label 改为「已创建」，「未启动」由可见的「启动应用」按钮表达 | status-interface.md §4.4 |
| 实施期问题（P2 App 对话框审查） | 服务端把清理未确认记为 failed + cleanupConfirmed=false，原 §4.4 只在 stopped 时产出 cleanup，失败时无常驻「未确认」；完整错误被 300 字符与两行截断 | cleanup 在 failed 或 stopped 且未确认时产出，label「应用进程清理未确认」；完整错误进对话框「错误详情」折叠区 | status-interface.md §4.4 |
| 实施期问题（P3 诊断） | 设计稿的诊断快捷键 ⌥⌘D 在 macOS 上是系统「显示 / 隐藏 Dock」 | 菜单「诊断」快捷键改为 `CmdOrCtrl+Alt+Shift+D`；面板首版只提供「复制 JSON」，NDJSON 由 `WSL_STATUS_LOG` 开启 | status-interface.md §8.6；README 设计稿表 |

另：观察错误标签沿用现有 `Observation.tsx` 文案（如 `unauthorized`「未获授权」、`stale_ref`「引用已失效」），因为 §4.8 引用的修订 1 对照表不在仓库中，且 `e2e/ssh-product.spec.ts` 断言「未获授权」。

### 实施期已知的非回归 E2E 现象

| 用例 | 现象 | 判断依据 |
| ---- | ---- | -------- |
| `e2e/review-regressions.spec.ts:82` | 间歇失败：页面初始地址晚于 `fill()` 到达，提交的地址不是被拒地址 | 917f375 基线导出上同样复现（12 次 1 次失败） |
| `e2e/workspace-migration.spec.ts:151` | 单独重复运行时原生 webContents 焦点断言失败；全量顺序运行通常通过 | 917f375 基线导出上单独重复运行同样 6/6 失败，依赖系统窗口焦点 |
