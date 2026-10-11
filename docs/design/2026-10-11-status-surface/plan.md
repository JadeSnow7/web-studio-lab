# 实施计划（修订 2）

基线 `codex/consolidate-review-20261011` @ `917f375`。按 AGENTS.md，新分支命名 `agent/status-surface`。审核通过前不动代码。

## 1. 约束

- 不 reset、不 stash、不覆盖无关文件。主工作树 `/Users/huaodong/workspace/web-studio-lab` 当前在 `codex/app-control-plane` 且有未提交内容，**不在该工作树实施**。本目录为未跟踪文件，实施时需整体带入 `agent/status-surface`（检出 `917f375` 不会自动出现）。
- 基线 `pnpm check` 本身不全绿：全树 lint 217 个、格式 801 个既有失败。每阶段以「不新增失败」加定向检查判定，不删断言、不扩大 ignore。
- `node scripts/check-docs.mjs` 的检查名单不含本目录；实施时如需纳入，在 P4 修改名单并说明。
- 每个阶段可单独提交、单独回滚；P0、P1 不改变任何可见界面。

## 2. 阶段

### P0 事实层与 DTO（界面不变）

改动：
- `packages/protocol/src/status.ts`：`StatusFact`、`StatusTransition`、`DebugStatusSnapshot` 与按 domain 的 raw 白名单 schema。
- `apps/desktop/src/shared/status/`：`index.ts`、`facts.ts`、`redact.ts` 及测试。
- `apps/desktop/tsconfig.node.json`、`tsconfig.web.json`：`include` 增加 `src/shared/**/*.ts`。

完成标准：
- status-interface.md §4 的全部枚举有映射，`satisfies Record` 穷举。
- 键唯一性：每个 domain 的所有 facet 同时成立时 key 两两不同（网页 9 个 facet 全真的组合必测）。
- `ExecutionStatus` 任意输入只产出 `capability`，从不产出 problem。
- raw 严格按白名单：传入含 PageCapture、终端输出、消息正文的输入，断言它们不出现在任何事实中。
- 脱敏：URL 查询串、家目录、SSH 主机、四类凭据模式、长度截断各有用例。

验证：`pnpm typecheck`；`pnpm exec vitest run apps/desktop/src/shared packages/protocol`。

### P1 展示层、组件与错误出口（界面不变）

改动：`renderer/src/state/status-view.ts`（`presentStatus`、`statusPresentationStore`、`useStatusView`）、`components/Status.tsx`、`App.tsx`、`shell/Overlays.tsx`、`state/errors.ts`、`pages/ResourcesPage.tsx`。

完成标准：
- 通道分配：control / unresolved / progress 全部进常驻通道且不受 problem 数量影响；problem 只显示一条；confirmation 确认后消失，`instanceToken` 变化后重新出现。
- 历史选择、hint 生命周期、切换空间与实例更换的重置规则各有用例（status-interface.md §6）。
- 错误出口：`workspace.error` 与 `errorStore` 合并为 Toast 队列；`storageError` 横幅保留。此阶段窗格内仍用旧文案。

验证：`status-view.test.ts`；`e2e/workspace-runtime.spec.ts`、`e2e/resources.spec.ts` 的失败恢复用例。

### P2 逐区域降噪（每个区域一个提交）

1. `shell/TitleBar.tsx`
2. `workspace/Sidebar.tsx`
3. `workspace/Terminal.tsx`
4. `workspace/Browser.tsx`（两个新菜单进入 occlusion）
5. `workspace/Session.tsx`、`workspace/RunDetails.tsx`、`workbench/RunViews.tsx`（选择状态移入展示 store；实施期说明：`RunViews.tsx` 只服务演示记录，本阶段不涉及；Session 输入区的「发送到」描述随本区域一并完成）
6. `shell/Composer.tsx`、`pages/HomePage.tsx`
7. `workspace/Observation.tsx`、`workspace/Files.tsx`
8. `workspace/ManagedAppDialog.tsx`

每个提交同步调整对应 E2E（§4），补充该区域的可见性与键盘用例（§5），并做白 / 暗 / 暖三主题、1080px 以下窄窗截图目视复核，包括正常稿与异常稿两种状态。

### P3 诊断通道

改动：`packages/protocol/src/ipc.ts`（`debug:status` invoke 与事件）、`main/debug-status.ts`、`main/ipc.ts`、`main/window.ts`（`additionalArguments`）、`main/menu.ts`、`preload/index.ts`、`renderer/src/shell/DebugPanel.tsx`、`e2e/helpers.ts`（`launchApp` 增加 `debugStatus` 选项）。

启用判定：`rendererSource().kind === 'dev-server' || WSL_DEBUG_STATUS === '1'`。

| 场景 | 期望 | 验证方式 |
| ---- | ---- | -------- |
| `pnpm build` 产物，默认 | 关闭；`window.studio` 恰为 6 键；菜单无「诊断」 | 现有 `workspace-debug.spec.ts:7` 不改 |
| `pnpm build` 产物，`WSL_DEBUG_STATUS=1` | 开启；`studio.debug` 存在；`debug:status` 结构合法；终端连接后出现转换 | 新增 E2E |
| 正式包，默认 | 关闭 | 现有 packaged 运行下的 `workspace-debug.spec.ts` |
| 正式包，显式启用 | 开启 | 新增 E2E。packaged helper 会清除所有 `WSL_*`，`debugStatus: true` 在清除之后再写入 `WSL_DEBUG_STATUS=1` |
| 开发服务器 | 开启 | 启用判定的单元测试（开发服务器不在 E2E 范围） |
| `WSL_STATUS_LOG` | 首行为 snapshot、只含事实；脱敏生效；5 MiB 上限写入 `limit` 后停止 | `debug-status.test.ts` |
| 未启用时调用 `debug:status` | 被 ipc-guard 拒绝 | `ipc-guard.test.ts` 模式 |

### P4 合同与收尾

改动：`UX-CONTRACT.md`、`DESIGN.md`（按 [contract-changes.md](contract-changes.md)）；新增本轮验收记录。

验证：`node scripts/check-docs.mjs`、`pnpm typecheck`、`pnpm build`、`pnpm test`、`pnpm exec playwright test`（Electron 全量）、premium 审计、截图目视复核。live 用例在授权的 live 环境另行复跑。

## 3. 工作量估计

| 阶段 | 估计 |
| ---- | ---- |
| P0 | 1 天 |
| P1 | 1 天 |
| P2 | 2.5 天（8 个提交，含可见性用例） |
| P3 | 1 天 |
| P4 | 0.5 天 |

## 4. E2E 调整清单

原则：断言的**语义不变**，只调整定位方式；不删除断言。

已在 `917f375` 上逐一检索本方案涉及的文案与可访问名称。以下**无需修改**：

- `toContainText('已连接')` 7 处；「现场适用性：有效 / 已失效」4 处；「已关闭，所属进程…」4 处；「取消回复」11 处；「重新核对」4 处；「历史已恢复」1 处（措辞沿用，环境级文字以视觉隐藏文本保留在 `textContent` 中）
- 按钮名称「连接终端」17 处、「关闭终端」6 处（改为图标按钮后名称不变）
- 「后台资源 / 已关闭标签」5 处（保留原文）
- `getByRole('textbox', { name: '会话消息', exact: true })` 15 处、`getByLabel('会话消息')` 4 处（`aria-label` 不变，「发送到 · …」改为描述而非名称）
- `workbench.spec.ts:57` 的采集指引 `role="status"`（hint 仍以 status 播报，文案不变）

**需要修改**的断言（24 处，10 个文件）：

| 位置 | 现断言 | 原因 | 调整为 |
| ---- | ------ | ---- | ------ |
| `workbench.spec.ts:132` | `toContainText('执行：completed')` | 英文枚举改中文 | `[data-status-key$=":state"][data-status="run:ok"]` 可见文本「执行完成」 |
| `workbench.spec.ts:134` | `toContainText('检查：not_run')` | 同上 | `[data-status="validation:idle"]` +「尚未检查」 |
| `workbench.spec.ts:136-137`、`workspace-runtime.spec.ts:108` | `检查：blocked`；`not … 检查：passed` | 同上 | 「检查无法执行」在问题通道**可见**；`[data-status="validation:ok"]` 计数为 0 |
| `workbench.spec.ts:68` | `getByText('诊断详情').click()` | 移至诊断面板 | 改为启用诊断的用例：打开面板，断言采集条目可查看且标注不可导出 |
| `app-control-cancel-live.spec.ts:360` | 精确匹配「Codex CLI · cancelled · 沙箱由服务决定」 | 该行删除 | 会话内 `[data-status="run:idle"]` +「已取消」（live，需授权环境复跑） |
| `workspace-observation.spec.ts:129` | 点击名称 `/^Codex CLI · /` 的标题栏按钮 | 健康时该按钮移除 | 改为点击左栏「设置」 |
| `review-regressions.spec.ts:172, 191`、`workspace-migration.spec.ts:130-131`、`space-app-model-live.spec.ts:154-155` | 直接操作「关联会话」与「采集到关联会话」 | 移入「采集到会话 ⌄」 | 新增 helper `openBrowserMenu(page, '采集到会话')`，控件名称不变 |
| `resources.spec.ts:52-53, 77, 96-97, 164`、`public-document.spec.ts:71` | 直接定位「保存正文快照」 | 移入「⋯」 | 先 `openBrowserMenu(page, '更多网页操作')`，菜单项名称不变 |
| `resources.spec.ts:63`、`resources-live.spec.ts:67` | 点击「查看空间资源」 | 同上 | 同上 |
| ~~`workspace-migration.spec.ts:35`~~ | 点击视图「日志 / diff / 报告」 | （实施期更正：该行属于任务页「运行视图」导航，不受会话「运行记录 ⌄」影响，无需修改） | — |
| `workspace-migration.spec.ts:84`（实施期补充） | `toContainText(run.runId)` | 依赖已删除的「运行 {runId}」行 | 定位 `[data-status-key="run:<runId>:state"]` 可见，语义不变 |

不受影响：任务页按钮「运行 · …」（`workspace-migration.spec.ts:34`）、首页卡片计数（同文件 :115-116）。实施每个 P2 提交前再 `git grep` 一次。

## 5. 可见性与键盘验收（新增）

`data-status` 与视觉隐藏文本只能证明「状态存在」，不能证明「用户看得到、够得着」。必须显式提示的条目另加以下 E2E，全部用 `toBeVisible()` 与键盘操作断言：

| 场景 | 断言 |
| ---- | ---- |
| AI 操控中 + 页面加载失败 + 已拦截导航同时成立 | AI 操控提示与加载失败**同时可见**；「另有 1 项」可展开看到拦截导航 |
| 已暂停 AI + 页面控制断开 | 「允许 AI 继续」与「重新附着」都可见，均可 Tab 到达并用 Enter 触发 |
| 取消中 + App 清理待确认 | 两条同时可见；「重新核对」可 Tab 到达，核对中禁用 |
| SSH 进程未确认后与终端交互 | 交互后提示**仍可见**（unresolved 不降级） |
| 终端已关闭后交互 | 交互前可见；交互后视觉消失、StatusDot 仍在；重新连接再关闭后再次可见（instanceToken 变化） |
| 问题通道「另有 N 项」 | 方向键移动、Esc 关闭并焦点回到触发器；列表展开期间原生网页让位 |
| 持久化失败 | 底部横幅可见且不被 Toast 遮挡 |
| 窄窗（<1080px）与三主题 | 以上条目在活动窗格中仍可见，对比度满足现有主题 token |

## 6. 风险与对策

| 风险 | 对策 |
| ---- | ---- |
| 必须持续可见的提示被折叠 | 三通道模型：control / unresolved / progress 不参与问题优先级竞争；§5 组合用例 |
| 组件绕过展示层自行判断 | 组件只调用 `useStatusView`；P2 每个提交删除对应的局部状态渲染分支，评审时检查 |
| 键冲突 | `domain:entity:facet` 规则 + 全 facet 组合唯一性测试 |
| 把能力未接入当成故障 | `ExecutionStatus` 只产出 `capability`，有单测锁定 |
| 诊断数据泄露 | raw 白名单、三出口边界、脱敏与大小上限（status-interface.md §8）；PageCapture 只在面板内查看 |
| 诊断在 E2E 默认开启 | 启用判定改为开发服务器或显式环境变量；§2 P3 矩阵 |
| 合同写死的文字被误删 | contract-changes.md 逐条列出；保留为常驻 / 问题通道条目或可访问名称 |
| 新菜单被原生网页遮住 | 展开前 `occlusion.open`，复用现有遮挡集合与焦点恢复 |
| 范围膨胀成框架 | 只覆盖列出的域；`src/shared/status` 只有 Main 与 Renderer 两个消费者 |
| 实施期间基线变化 | 每阶段开始前对比 `917f375` 与目标分支的协议 diff，先更新映射 |
| 本会话在连接文件夹中无法删除文件，git 会留下 `.lock` | 实施时需要对实施工作树授予删除权限，或由你在本机提交 |
