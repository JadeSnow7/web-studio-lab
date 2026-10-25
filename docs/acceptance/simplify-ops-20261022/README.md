# OPS-1 执行记录 · 简化操作

> 发布整理说明（2026-10-25）：下文保留来源工作树的历史实现与验证记录，并非当前整合提交的复验结果。截图、原始日志、DOM/机器回执及其审查材料仅在本地证据归档保留，本次未公开；文中的相对证据路径仅用于本地追溯，不能作为已交付的可访问证据。当前分批整合未运行 Electron 窗口、真实模型或 guest 写入，且继承 Harness #18、#22、#23 的未解决审查阻塞，不能据这些历史记录判断可合并。

合同见 [SPEC](SPEC.md)。分支 `agent/simplify-ops`，从 W4 已提交尖端 `fe3684f`（`agent/harness-approvals`，W4a + W4b，已推送到 `origin`）切出。本记录分别列出静态检查、单元测试、Electron E2E 与真实窗口截图的结果；本次没有用户接受。改动未提交。

## 前置检查（§3）

2026-10-22，macOS 26.6.2 arm64，Node v26.5.0，pnpm 10.34.6。

| 项                   | 结果                                                                                                                                                               |
| -------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `pwd`                | 本地来源工作树（机器路径未公开）                                                                                                                                   |
| `git remote -v`      | `origin https://github.com/JadeSnow7/web-studio-lab.git`（fetch/push）                                                                                             |
| `git rev-parse HEAD` | `fe3684f96c45e826af1071eb2058184c4aca4bf8`（feat(harness): ask the user for ACP permissions that were denied outright）                                            |
| 切分支前的分支       | `agent/harness-approvals`，与 `origin/agent/harness-approvals` 一致（ahead 0 / behind 0）                                                                          |
| `git status --short` | `?? docs/acceptance/simplify-ops-20261022/`                                                                                                                        |
| 未跟踪文件           | `docs/acceptance/simplify-ops-20261022/SPEC.md`，SHA-256 `19968fe7ae280c65dde52eea547e069e9d9a7b54f7d789d397165e80e4370aab`（OPS-1 草案，本包自己的文件）          |
| 已跟踪但未提交的修改 | 无                                                                                                                                                                 |
| W4 是否已交接        | 是：`apps/service`、`apps/desktop/src/main`、`packages/protocol`、preload、`Session.tsx`、`SettingsPage.tsx` 下均无未提交修改；W4a `c1aee7d`、W4b `fe3684f` 已提交 |
| W4 是否升级了 schema | 否：`apps/desktop/src/main/workbench/repository.ts` 仍写 `schemaVersion: 4`，`harnessSelection` 随 schema 4 的快照写入。与 R1 不冲突                               |

“提交 W4”在开始本次运行时已经完成（上表），没有新的 W4 提交。随后执行 `git switch -c agent/simplify-ops fe3684f`。

### 基线检查

| 命令                                                    | 退出码 | 关键输出                                                                                                                    |
| ------------------------------------------------------- | ------ | --------------------------------------------------------------------------------------------------------------------------- |
| `pnpm install --frozen-lockfile && pnpm build`          | 0      | renderer `✓ built`；日志 evidence/b-pre-baseline-install-build.txt（本地保留：`evidence/b-pre-baseline-install-build.txt`） |
| `pnpm typecheck`                                        | 0      | evidence/b-pre-baseline-unit.txt（本地保留：`evidence/b-pre-baseline-unit.txt`）                                            |
| `pnpm exec vitest run`                                  | 0      | 102 文件通过、8 跳过；1355 通过、26 跳过、0 失败（同上文件）                                                                |
| `env -u ELECTRON_RUN_AS_NODE pnpm exec playwright test` | 0      | 175 通过、16 跳过、0 失败；evidence/b-pre-baseline-e2e.txt（本地保留：`evidence/b-pre-baseline-e2e.txt`）                   |

基线上没有原本就失败的单元测试或 E2E。`pnpm check` 中全树 lint/格式在基线上的已知失败按 [PR 检查说明](../../development/pr-checks.md) 处理，只检查维护目录与本次改动文件。

## 批次记录

（按 B0 → B4 → B2 → B1 → B3 → B5 → B6 依次追加。）

### B0 · 冻结规范和基线

由一个文档写入 agent 完成，未触碰 `apps/`、`packages/`、`e2e/`。

- `SPEC.md`：定稿；基线改为 `fe3684f`，写明与 W4 在 Main、协议、preload、Session、设置页重叠；§3 按计划约定与 R3–R9 修订；§5 扩充为 O01–O14 及子项（39 行），每行标明批次与证据类型，O12（S10）延后；§6 按 R6 排序；§7 已定决定 D1–D6、R1–R10；§9 实施解释。
- 修正草案中与 `fe3684f` 不符的事实：F6（检查初始为 `not_run`，点「运行检查」后才 `blocked`，以状态槽 alert 呈现，没有红色横幅；产品路径不产生 `passed`）；F11（遗漏 ⌘, 与 ⌥⇧⌘D，`windowMenu` 带系统 ⌘W 关闭窗口，renderer 已有窗口级 Esc 监听，加速键不核对焦点窗口）；新增 F3a、F5a、F16、F17。
- `UX-CONTRACT.md`、`DESIGN.md`、`docs/architecture/current-runtime.md`：同步受影响条款，全部标为“OPS-1 合同，实施中”，未声称已实现。
- `scripts/check-docs.mjs`：把本包 SPEC 与 README 纳入检查（R10 理由：新增未跟踪文件不在 `git diff --check` 范围）。

§9 的六个待确认问题由主代理逐条判断，均按既有规则取保守做法，不新增业务规则（见 SPEC §9）；第 1 条“单一 `targetRef`”交付时请用户复核。合同审查由主代理对照 §2 与计划完成；B0 无源码，未做边界与测试审查。

| 命令                                                   | 退出码 | 关键输出                                     |
| ------------------------------------------------------ | ------ | -------------------------------------------- |
| `node scripts/check-docs.mjs`                          | 0      | 23 个规范文件通过                            |
| `prettier --check`（本批改动的 6 个文件，含本 README） | 0      | 首次 README 未格式化（exit 1），格式化后通过 |
| `git diff --check`                                     | 0      |                                              |

证据：evidence/b0-checks.txt（本地保留：`evidence/b0-checks.txt`）。`git diff --stat`：`DESIGN.md` 2、`UX-CONTRACT.md` 27、`current-runtime.md` 16、`check-docs.mjs` 3（4 个文件，+39 / −9），另有未跟踪的本目录。

闸门：W4 已交接；HEAD、未跟踪文件与指纹、基线检查已记录。通过，进入 B4。

### B4 · 降噪与入口清理（S3、S4）

由一个实现 agent 完成；三路只读对抗审查后修复一轮。

改动：

| 路径                                                                                                  | 变化                                                                                                                                   |
| ----------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------- |
| `packages/protocol/src/execution.ts`                                                                  | 新增 `CheckerCapabilitySchema`（`{ connected: true }` 或 `{ connected: false, reason: 'not_integrated' }`），`ExecutionStatus.checker` |
| `packages/protocol/src/app.ts`、`apps/desktop/src/main/ipc.ts`                                        | `AppInfo.diagnostics`：与诊断通道同一判定（`debug !== undefined`，即开发服务器或 `WSL_DEBUG_STATUS=1`）                                |
| `apps/desktop/src/main/workbench/checker.ts`（新增）、`main/execution.ts`、`workbench/application.ts` | Main 中检查器能力的唯一来源；`ExecutionStatus` 发布能力，`runValidation` 由同一来源产生记录（未接入时仍记 `blocked`，行为不变）        |
| `apps/desktop/src/shared/status/facts.ts`                                                             | 能力未接入且检查 `not_run` 时映射为中性稳态“检查器未接入”，不产出“检查适用性未知”；`blocked`、`failed`、`stale`、`running` 照旧        |
| `renderer/src/workspace/Session.tsx`、`state/execution.ts`                                            | `CheckReviewCard`：未接入时隐藏「运行检查」，说明“产品检查器尚未接入”；「接受结果」可见但禁用，原因可见并经 `aria-describedby` 关联    |
| `pages/SettingsPage.tsx`                                                                              | 检查器未接入说明                                                                                                                       |
| `pages/HomePage.tsx`、`ConversationsPage.tsx`、`TasksPage.tsx`、`shell/Notifications.tsx`             | 正式构建隐藏首页模式、会话类别演示、任务页演示记录、通知「历史演示动态」；诊断模式可见；尚未读取 AppInfo 时按正式构建处理              |
| `UX-CONTRACT.md`、`docs/architecture/current-runtime.md`                                              | S3、S4 改为“B4 已实施”，写明实际发布通道                                                                                               |

行为与约定变化：

- 检查器能力经 `execution:get-status` 发布，不持久化；workbench schema 4 未改。SPEC S3、O06b、§6、§9.3 已按实际落点修订。
- 接受门槛不变：`recordReview(accepted)` 仍要求 `passed` 且 `current`；没有 `accepted_unchecked`。
- 直接经工作台命令调用 `runValidation` 仍写 `blocked` 并显示为问题（未降级）；正常界面不再提供该入口。

修改的既有 E2E 断言（原 → 新，理由均为 S3/S4 合同变化）：

| 位置                                            | 原断言                                           | 新断言                                                                                                             |
| ----------------------------------------------- | ------------------------------------------------ | ------------------------------------------------------------------------------------------------------------------ |
| `e2e/workbench.spec.ts:152-162`                 | 状态为「尚未检查」，点击「运行检查」得到 blocked | 状态为「检查器未接入」、「运行检查」不存在；blocked 记录改经 IPC `runValidation` 产生，问题通道与 blocked 断言保留 |
| `e2e/status-surface.spec.ts:1487/1494`          | 同上                                             | 同上，并断言检查区说明                                                                                             |
| `e2e/status-surface.spec.ts:1645`               | 截图用例点「运行检查」制造异常态                 | 改用 `recordBlockedValidation`（IPC）制造同一异常态                                                                |
| `e2e/status-surface.spec.ts:1875-1883`          | 先见「检查无法执行 · 尚未审阅」                  | 先见「检查器未接入 · 尚未审阅」，blocked 后的标签照旧断言                                                          |
| `e2e/status-surface.spec.ts:1814`、`1905`       | 正式启动                                         | 以 `debugStatus: true` 启动（被拦截的发送只发生在首页「搜索」模式，该模式现只在诊断模式出现）；断言不变            |
| `e2e/p0-run-diff.spec.ts:203-207`               | 点击演示记录                                     | 断言真实运行行可见、演示条目不存在                                                                                 |
| `e2e/workspace-runtime.spec.ts:107-110`（live） | 同 workbench                                     | 按新合同静态修改，**未运行**                                                                                       |

测试输入（无断言变化）：`packages/protocol/src/harness.test.ts:76,84`、`facts.test.ts` 默认 fixture 增加 `checker`。

新增测试：`acceptance-gate.test.ts`（not_run、failed、blocked、stale、适用性未知、候选不匹配均拒绝；经仓储端口注入 passed + current 时接受；能力与 `runValidation` 同源）、`ipc-capabilities.test.ts`（开发 / `WSL_DEBUG_STATUS=1` / 正式 × 是否打包，断言 `diagnostics === 已注册 debug:status`）、`facts.test.ts` 与 `status-view.test.ts` 新块、`e2e/unconnected-capabilities.spec.ts`（O07 正式/诊断两态各断言真实历史、Agent 会话列表、Harness/Profile、「执行 Agent」选择；O06；O06a 预置 `workbench.json` 的 passed + current 仍可接受；O06b 测试侧替换 `execution:get-status` 处理器为已接入后，界面恢复「运行检查」）。

对抗审查（报告留存于本机会话 scratchpad，结论摘录如下）：

| 路   | 结论                                                                                             | 处理                                                               |
| ---- | ------------------------------------------------------------------------------------------------ | ------------------------------------------------------------------ |
| 合同 | 无阻断；SF-1 “检查适用性未知”以警告色挨着中性稳态                                                | 修复：该组合不产出适用性事实，加单测                               |
| 合同 | SF-2 直接调用 `runValidation` 仍产生问题级 blocked，与 §9.3 原文不符                             | 决定保持 Main 行为不变（不在 B4 改持久格式），修订 §9.3 为实际设计 |
| 合同 | SF-3 SPEC 写“快照”，实际为 `ExecutionStatus`                                                     | 修订 SPEC                                                          |
| 合同 | SF-4 通知「历史演示动态」在正式构建可见                                                          | 按计划“隐藏演示条目”加同一门控，更新 UX-CONTRACT                   |
| 合同 | SF-5 执行记录缺 B4 与断言清单；截图仅 renderer                                                   | 本节补齐；截图限制见下                                             |
| 边界 | 无阻断、无安全回归；Main 两处硬编码“已接入”                                                      | 合并为 `checker.ts` 单一来源                                       |
| 边界 | 缺 `debug:status` 注册与 `diagnostics` 一致的测试                                                | 新增 6 例矩阵                                                      |
| 测试 | 15 个变异中 14 个被捕获；F1 O07 写死 `packaged: false`，打包目标与 `&& !app.isPackaged` 变异漏检 | 跟随 `WSL_E2E_TARGET`，单测加打包用例；该变异现被捕获              |
| 测试 | F2 没有证明 renderer 使用 Main 能力                                                              | 新增 O06b                                                          |
| 测试 | F3 诊断态未断言真实入口                                                                          | 两态都断言                                                         |
| 测试 | 若干小问题（原因文字、加载信号、`process.versions` 还原、双重断言）                              | 已修                                                               |

检查（证据 evidence/b4-checks.txt（本地保留：`evidence/b4-checks.txt`），先失败用例 evidence/b4-tests-first-fail.txt（本地保留：`evidence/b4-tests-first-fail.txt`））：

| 阶段   | 命令                                                                         | 结果                                                                                                                                                            |
| ------ | ---------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 首轮   | `pnpm exec vitest run`（全量）                                               | 首次 2 失败：`harness.test.ts` fixture 缺 `checker`（本批引起，已修）；`setup-adapter.test.ts` 负载下 5000 ms 超时（未改动，复跑通过）。复跑 1376 通过、26 跳过 |
| 首轮   | 新 E2E 首次                                                                  | 1 失败（新用例自身导航错误），修后 4/4                                                                                                                          |
| 首轮   | 全量 E2E                                                                     | 179 通过、16 跳过                                                                                                                                               |
| 修复轮 | `pnpm typecheck`                                                             | 0                                                                                                                                                               |
| 修复轮 | vitest 受影响 13 文件 / 全量                                                 | 270 通过 / 1382 通过、26 跳过                                                                                                                                   |
| 修复轮 | eslint、prettier（改动文件）、`check-docs`、`git diff --check`、`pnpm build` | 均 0                                                                                                                                                            |
| 修复轮 | E2E 新 spec / 9 个受影响 spec / 全量默认                                     | 5/5；112 通过、4 跳过（2 live、2 打包专属）；180 通过、16 跳过                                                                                                  |

截图：evidence/b4-session-checks-not-connected.renderer.png（本地保留：`evidence/b4-session-checks-not-connected.renderer.png`）（真实 Electron 窗口的 renderer 画面，已查看）。系统级窗口截图不可用：`screencapture` 与 `desktopCapturer` 无屏幕录制权限，因此原生网页层不在图中。

未运行：`WSL_E2E_TARGET=packaged`（需要 `pnpm package`）；live 用例。

`git diff --stat`（含 B0）：24 个跟踪文件，+425 / −133；未跟踪新增 `checker.ts`、`ipc-capabilities.test.ts`、`acceptance-gate.test.ts`、`e2e/unconnected-capabilities.spec.ts`。

闸门：接受门槛不变；诊断启用矩阵与状态负例通过。通过，进入 B2。

### B2 · 原生菜单（S5）

由一个实现 agent 完成；三路只读对抗审查后修复一轮。屏幕锁定期间无法运行 E2E；解锁后由主代理复跑全量 E2E 并在真实窗口中核验（见本节末）。

改动：

| 路径                                                                                                                                                            | 变化                                                                                                                                                                                                                                                                                                                                        |
| --------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `packages/protocol/src/native-menu.ts`（新增）、`ipc.ts`、`bridge.ts`、`index.ts`                                                                               | `menuId` 固定枚举 `tab`、`pane`、`run-records`、`web-more`、`capture-receiver`、`new-tab`；按菜单区分的严格上下文（`workspaceId`、可选 `anchor`，以及 `tabId` / `paneId` / `sessionId` / `resourceId` / `receiverSessionId`、运行记录可选 `current`）；结果 `{ menuId, itemId, target }` 或 `null`，标签与窗格目标带构建时的空间 `revision` |
| preload                                                                                                                                                         | `window.studio.shell.showMenu`；顶层仍为 6 个键；非法输入返回被拒绝的 Promise，不同步抛出                                                                                                                                                                                                                                                   |
| `apps/desktop/src/main/native-menu.ts`（新增）、`main/ipc.ts`、`main/menu.ts`、`main/index.ts`                                                                  | Main 核对来源与输入、只接受活动空间与本空间身份，按当前快照构建菜单项（renderer 不能提供文字或条目），`Menu.popup` 展示；每个窗口同时只有一个菜单（第二个请求 `conflict`）；窗口关闭、重载/导航、renderer 退出时以 `null` 结束                                                                                                              |
| renderer `state/native-menu.ts`、`workspace/native-menus.ts`（新增）及 `Sidebar`、`Workshop`、`SpacePage`、`space-ui`、`Panes`、`Session`、`Browser`、`App.tsx` | 六类菜单迁移并删除 HTML 弹层及其遮挡登记；选择由 renderer 执行：展示动作在空间已变或切换进行中时丢弃，业务动作走既有工作台命令（冻结目标、`navigate: false`、版本冲突检查）；打开前等待本空间未完成的命令；保存进行中、新建会话进行中禁用触发器；关闭标签后焦点移到相邻标签或标签列表                                                       |
| `e2e/helpers.ts`                                                                                                                                                | 测试侧接缝 `installNativeMenuSeam`（`electronApp.evaluate` 修补 `Menu.prototype.popup`，断言传入的是工作台窗口与整数坐标），默认安装，`realNativeMenus` 关闭                                                                                                                                                                                |
| `UX-CONTRACT.md`、`DESIGN.md`、`docs/architecture/current-runtime.md`                                                                                           | B2 已落地部分改为已实施，原生窗口核验见本记录                                                                                                                                                                                                                                                                                               |

R3 时序：结果由菜单项 `click` 决定；关闭回调以 `setTimeout(0)` 延后再判定取消，只决定一次；坐标限制在内容区；键盘打开（`click.detail === 0`）以触发器矩形定位，鼠标以指针位置定位。

行为变化：标签菜单不再有「关闭菜单」，右键标签打开同一菜单；窗格头只保留标题、专注、⋯；四窗格时分屏项（窗格菜单与标签菜单「在右侧/下方打开」）禁用；运行记录以单选标记当前视图；新建标签菜单选择类型后打开预选该类型的既有表单；「采集到会话」暂为原生菜单（选会话或新建会话即开始采集，接收者仍由 `requestId` 冻结），默认接收者属 B3。从触发器按 ↓ 不再打开菜单（合同的方向键规则针对标签列表；原生菜单内部自带方向键）。

修改的既有断言（理由：这些菜单改为系统菜单，不再让原生网页让位）：

| 位置                                                      | 原断言                                                                 | 新断言                                                           |
| --------------------------------------------------------- | ---------------------------------------------------------------------- | ---------------------------------------------------------------- |
| `e2e/status-surface.spec.ts:816`                          | `aria-haspopup="dialog"`                                               | `aria-haspopup="menu"`                                           |
| `e2e/status-surface.spec.ts:755`                          | 旧 `GUIDANCE` 文案                                                     | 新提示文案                                                       |
| `e2e/status-surface.spec.ts:830`、`867`、`1357`           | HTML 菜单内方向键、Home/End 焦点、`aria-current`、↓ 打开、原生网页隐藏 | 菜单条目、锚点位置、原生网页可见、Esc 后焦点留在触发器、选择结果 |
| `e2e/status-surface.spec.ts:~835`                         | 精确 `enabled: true`                                                   | 先等待页面加载完成再断言                                         |
| `e2e/status-surface.spec.ts:1022`                         | 对话框/菜单数量为 0                                                    | 没有新记录的菜单                                                 |
| `e2e/status-surface.spec.ts:1054`                         | 「新建关联会话」弹层                                                   | 新建会话 → 开始采集                                              |
| `e2e/status-surface.spec.ts:1075`                         | 弹层截图                                                               | 原生网页可见检查                                                 |
| `e2e/workspace-upgrade.spec.ts:50`                        | 「最多四个窗格」提示                                                   | 四窗格时「左右分屏」项禁用（`pane_limit` 提示另有新用例覆盖）    |
| `e2e/space-remake.spec.ts` SR10 `~98-110`                 | 菜单打开期间原生网页隐藏                                               | 通知栏关闭后即可见，菜单仍打开                                   |
| `e2e/public-document.spec.ts:107`、`121`、`126`           | 忙碌时条目可用；Esc/菜单隐藏步骤                                       | 轮询保存结果；原生网页可见                                       |
| `apps/desktop/src/main/native-menu.test.ts`（本批新文件） | 两个标签菜单连续打开                                                   | 先关闭第一个（Main 改为单个菜单）                                |

测试夹具：`window-close.test.ts:45` 的 mock 增加 `nativeMenuHost`。其他 spec 只替换为新的菜单辅助函数。

对抗审查（报告留存于本机会话 scratchpad）：

| 路   | 发现                                                                                                                                             | 处理                                                                                                       |
| ---- | ------------------------------------------------------------------------------------------------------------------------------------------------ | ---------------------------------------------------------------------------------------------------------- |
| 合同 | BL-1 实现后没有运行 E2E 与真实窗口证据                                                                                                           | 屏幕解锁后已跑首轮（4 失败，见下）；修复轮受影响 spec 通过；全量复跑与真实窗口待做                         |
| 合同 | 运行记录丢失当前视图标记                                                                                                                         | 修复：`current` 上下文 + 单选                                                                              |
| 合同 | 保存中与新建会话中第二次选择被静默丢弃                                                                                                           | 修复：进行中禁用触发器并说明                                                                               |
| 合同 | `current-runtime.md` 前言与条目矛盾                                                                                                              | 修复                                                                                                       |
| 合同 | ↓ 不再打开菜单                                                                                                                                   | 接受：合同的方向键规则针对标签列表                                                                         |
| 边界 | M1 preload 同步抛出（导致 O08b 失败）                                                                                                            | 修复：返回被拒绝的 Promise                                                                                 |
| 边界 | L1 Main 不阻止叠加菜单；L2 关闭回调缺失时 renderer 标志卡住；L3 菜单等待命令队列而迟到；L4 空间级版本检查与焦点命令竞争；L5 迟到选择打断空间切换 | 全部修复（单菜单、窗口事件结束、`finally` 清除、按当前快照构建、打开前等待本空间命令、切换中丢弃展示动作） |
| 测试 | O08b 必然失败                                                                                                                                    | 同 M1                                                                                                      |
| 测试 | R3 用 `queueMicrotask` 也能通过                                                                                                                  | 新增假定时器用例，该变异现被捕获                                                                           |
| 测试 | 辅助函数不等待条目可用，采集菜单易抖动                                                                                                           | 等待页面加载并在有界时间内重开，不绕过禁用检查                                                             |
| 测试 | 接缝不核对窗口、无真实菜单用例、`nativeMenuHost` 无单测                                                                                          | 补齐；新增 `realNativeMenus` 用例（`closePopup` 后得到 `null`）                                            |
| 测试 | 未覆盖：布局变化后的版本冲突、无网页实例、双击、`pane_limit`                                                                                     | 新增 E2E（`pane_limit` 用测试侧去掉 revision 的垫片触发）                                                  |

检查（证据 evidence/b2-checks.txt（本地保留：`evidence/b2-checks.txt`）、先失败用例 evidence/b2-tests-first-fail.txt（本地保留：`evidence/b2-tests-first-fail.txt`）、首轮 E2E evidence/b2-e2e-first-run.txt（本地保留：`evidence/b2-e2e-first-run.txt`））：

| 阶段                       | 命令                                                                                                                                                   | 结果                                                                                                                                                                                             |
| -------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------ | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| 实现                       | `pnpm typecheck`、受影响 vitest（19 文件 223 例）、eslint、prettier、`check-docs`、`git diff --check`、`pnpm build`                                    | 均 0                                                                                                                                                                                             |
| 实现                       | 全量 vitest                                                                                                                                            | 首次 `setup-adapter.test.ts` 负载超时（未改动，单独通过）；复跑 1437 通过、26 跳过                                                                                                               |
| 实现                       | E2E                                                                                                                                                    | 未运行：00:14–01:04 屏幕锁定，窗口无法获得焦点                                                                                                                                                   |
| 首轮 E2E（主代理，解锁后） | `native-menus.spec.ts` / 全量默认                                                                                                                      | 8 通过 1 失败（O08b）/ 185 通过、4 失败、16 跳过：O08b（preload 同步抛出）、O08 采集接收者、`status-surface:1022`、`workspace-migration:136`（「Agent 会话」在页面加载中被禁用，辅助函数未等待） |
| 修复轮                     | `pnpm typecheck`、受影响 vitest（22 文件 320 例）、全量 vitest（1459 通过、26 跳过）、eslint、prettier、`check-docs`、`git diff --check`、`pnpm build` | 均 0；10 个变异均被捕获                                                                                                                                                                          |
| 修复轮                     | `native-menus.spec.ts` / 本批改动的 spec                                                                                                               | 13/13；140 通过、3 跳过                                                                                                                                                                          |
| 修复轮                     | 全量默认 E2E                                                                                                                                           | **未完成**：前 140 项正常，第 141 项起 59 项在 `launchApp` 前台检查失败（屏幕约 04:40 再次锁定）。锁定后未复跑：`unconnected-capabilities`、`workshop-actions`、`workspace-debug`                |

`git diff --stat`（含 B0、B4）：55 个跟踪文件，+1271 / −1263。

解锁后（2026-10-23 11:03 起，主代理）：

| 检查                                                                                                                                        | 结果                                                                                                                                  |
| ------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------- |
| `pnpm build` + 全量默认 E2E（evidence/b2-e2e-rerun-full.txt（本地保留：`evidence/b2-e2e-rerun-full.txt`））                                 | 192 通过、1 失败、16 跳过。失败项 `e2e/workspace-runtime.spec.ts:26`（A06/A07）在第 36 行等待「取消回复」超时，发生在任何菜单操作之前 |
| 该用例独立复跑 `--repeat-each=3`（evidence/b2-e2e-rerun-workspace-runtime.txt（本地保留：`evidence/b2-e2e-rerun-workspace-runtime.txt`））  | 3/3 通过。全量中失败的原因 **undetermined**，不视为已修复；B6 全量回归再次核对                                                        |
| 真实窗口核验（检查脚本（本地保留：`evidence/b2-real-window-check.spec.ts.txt`）、事件记录（本地保留：`evidence/b2-real-window-log.json`）） | 见下                                                                                                                                  |

真实窗口核验：用 `realNativeMenus` 启动构建产物（1440×900），逐个打开真实系统菜单，以 macOS 辅助功能对菜单项执行真实按下（`AXPress`）或取消（`AXCancel`），窗口截图经系统捕获（含原生网页层与系统菜单）。10 步全部符合预期：

| 步  | 菜单与操作                                     | Main 记录的事件顺序                       | 结果                                                                                                                                                                                                                | 截图                                                                                                                       |
| --- | ---------------------------------------------- | ----------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------- |
| 1   | 窗格 ⋯ → 左右分屏                              | will-show → will-close → click → callback | 2 个窗格                                                                                                                                                                                                            | 01（本地保留：`evidence/b2-real-01-pane-menu-open.jpg`）                                                                   |
| 2   | 运行记录 → 日志                                | 同上                                      | 会话切到运行记录日志视图                                                                                                                                                                                            | 02（本地保留：`evidence/b2-real-02-run-records-open.jpg`）                                                                 |
| 3–5 | 标签 ··· → 向下 / 向上 / 向下移动（连续 3 次） | 每次都是 click 后 callback                | 标签顺序每次按选择改变；末位时「向下移动」禁用                                                                                                                                                                      | 03（本地保留：`evidence/b2-real-03-tab-menu-open.jpg`）                                                                    |
| 6   | 标签 ··· → Esc                                 | will-close → callback，无 click           | 取消；焦点回到「开发终端操作」                                                                                                                                                                                      | —                                                                                                                          |
| 7   | ⋯ 更多网页操作 → 点外部                        | —                                         | **未核验**：后台工具对菜单外的点击不是真实鼠标事件，菜单未关闭；全屏控制两次请求均未获批准。改用 Esc 关闭（取消，`aria-expanded=false`）。点外部的取消路径只由接缝用例与 `realNativeMenus` 的 `closePopup` 用例覆盖 | 04（本地保留：`evidence/b2-real-04-web-more-open.jpg`）                                                                    |
| 8   | 新建标签 → 终端                                | click 后 callback                         | 打开预选「终端」的创建表单；对话框仍让原生网页让位（O08c）                                                                                                                                                          | 05（本地保留：`evidence/b2-real-05-new-tab-open.jpg`）、06（本地保留：`evidence/b2-real-06-new-tab-form-occludes.jpg`）    |
| 9   | 聚焦 ⋯ 后按 Enter（键盘打开）→ Esc             | 无 click                                  | 菜单定位在按钮正下方；取消后焦点回到「更多网页操作」                                                                                                                                                                | 07（本地保留：`evidence/b2-real-07-web-more-keyboard-anchor.jpg`）                                                         |
| 10  | 采集到会话 → Agent 会话                        | click 后 callback                         | 进入点选（「选择中 · Esc 取消」，会话显示「正在采集…」）                                                                                                                                                            | 08（本地保留：`evidence/b2-real-08-capture-receiver-open.jpg`）、09（本地保留：`evidence/b2-real-09-capture-started.jpg`） |

每一步菜单打开期间，Main 报告原生网页可见（`previewVisible: true`），截图中网页内容可见。macOS 26.6.2 / Electron 44.5.1 上实际顺序是 `will-close` 先于 `click`（约 1 ms），菜单 `callback` 最后（约 45 ms 后）；结果都由 `click` 决定，没有出现被判为取消的选择。

闸门：原生窗口中菜单可用且网页不消失；取消、过时上下文与非法请求的单测与 E2E 通过。通过，进入 B1。遗留：全量 E2E 中 `workspace-runtime.spec.ts:26` 一次失败（原因 undetermined），以及真实窗口“点外部取消”未核验。

### B1 · 工程与引用分离、schema 5

由一个实现 agent 完成；三路只读对抗审查后修复一轮。实现与第一轮修复期间屏幕锁定，E2E 在解锁后由主代理首跑，第二轮修复解决唯一失败。

改动：

| 路径                                                                     | 变化                                                                                                                                                                                                                                                                                                                                                                                                              |
| ------------------------------------------------------------------------ | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `packages/protocol/src/workspace.ts`                                     | 标签 `autoTitle`（默认 `false`，只有网页标签可为 `true`）；`TaskProjectSchema` = App 的 `{ appId, projectId }`；会话 `taskProject`（默认 `null`）与 `taskProjectDecided`；命令 `saveTaskProject`；`confirmTask` 必带 `appId: uuid \| null` 与 `captureId: Id \| null`；`guestAppCwd(projectId)`（原 service 中的同一路径，改为共享）                                                                              |
| `apps/desktop/src/main/workbench/repository.ts`                          | schema 5：严格的 v4 / v5 形状；1–4 迁移为 `taskProject: null`、`taskProjectDecided: false`、`autoTitle: false`，`harnessSelection` 与任务历史（含已冻结的 `appTarget`）原样保留；原字节另存不可覆盖的 `.legacy-schema-N.json`（`wx`、0400），`.pending` 与备份 fsync 后改名；v6 及以上拒绝且原文件不变；v5 缺字段或带未知键拒绝，不补默认值                                                                       |
| `apps/desktop/src/main/workbench/application.ts`                         | `saveTaskProject`（他空间会话 `denied`，非本空间 App `conflict`）；采集受管 App 页面且会话未决定工程时，在同一次写入中开启工程；`confirmTask` 按 `appId` 冻结 `appTarget` 与 `guestCwd`（只能是 `guestAppCwd(projectId)`），并核对 `captureId` 归属与有效性；`startRun` 在任何副作用前拒绝：App 启停进行中、重启后 App 恢复未确认、冻结目录与当前不符、旧的“App 页面但无工程”版本；恢复不变量允许“有工程、无页面” |
| `apps/service/src/*`                                                     | 改用 `guestAppCwd`，路径不变                                                                                                                                                                                                                                                                                                                                                                                      |
| renderer `workspace/Session.tsx`、`app.css`                              | 输入框上方的「工程：{App 名}」开关（可移除、可重新开启；关闭时显示「未选择工程」）；确认前等待未完成的开关保存，按最新快照组装请求                                                                                                                                                                                                                                                                                |
| 根 `README.md`、`UX-CONTRACT.md`、`docs/architecture/current-runtime.md` | schema 5 与 B1 行为改为已实施                                                                                                                                                                                                                                                                                                                                                                                     |

`confirmTask` 拒绝规则：他会话的 `captureId` → `denied`；过期或未知 → `conflict`；与目标不符 → `invalid_input`；网页目标缺 `captureId` → `conflict`（原文案）；`appId` 不是本空间 App → `conflict`；`appId` 与会话已保存的开关不符 → `conflict`「工程开关已变化」；`guestCwd` 为空 → `conflict`「App 尚未启动」；引用 App 页面而工程关闭 → `conflict`「引用的是 App 页面，需要开启工程或移除引用」；目录不是受管目录 → `denied`。被拒绝时没有新版本、写入登记或持久化变化，草稿保留。路径、App 对象、`appTarget` 等多余字段在 IPC 边界被严格 schema 拒绝。

修改的既有断言：

| 位置                                                                                                                        | 原断言                                      | 新断言                                                              | 理由               |
| --------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------- | ------------------------------------------------------------------- | ------------------ |
| `observation-persistence.test.ts:61`                                                                                        | 旧标签 `toEqual` 原样                       | 原样加 `autoTitle: false`                                           | schema 5 迁移      |
| `observation-persistence.test.ts:81`、`space-app-persistence.test.ts:66`、`:218`、`resource-catalog-repository.test.ts:183` | `schemaVersion` 为 4                        | 为 5                                                                | schema 5           |
| `e2e/unconnected-capabilities.spec.ts:267`                                                                                  | `schemaVersion` 为 4                        | 为 5；预置文件改写成 schema 4 形状，重启时同时验证 4 → 5 迁移与备份 | schema 5           |
| `managed-app.test.ts:356`、`:375`                                                                                           | 冻结目录为 `'/guest/project'`，提示含该路径 | 冻结目录为 `guestAppCwd(projectId)`，提示含该路径                   | 只允许冻结受管目录 |

仅输入变化：约 40 处 `confirmTask` 调用补 `appId` / `captureId`（含 4 个 live 用例与 `p0-run-diff`；其中 3 处显式传 `appId`，原“页面即工程”的推断改由自动开启覆盖）；原生菜单测试字面量补新字段。`space-app-model-live` 首轮加的「开启工程」点击在修复轮撤回。

对抗审查（报告留存于本机会话 scratchpad）：

| 路   | 发现                                                                                  | 处理                                                         |
| ---- | ------------------------------------------------------------------------------------- | ------------------------------------------------------------ |
| 合同 | **阻断**：开关默认关闭且无人开启，App 页面任务失去 `fe3684f` 已有的工程绑定与源码差异 | 修复（SPEC §9.7）：持久化“已决定”标记，首次 App 采集自动开启 |
| 合同 | App 页面引用 + 工程关闭被静默接受                                                     | 修复（SPEC §9.8）：`conflict` 并保留草稿                     |
| 合同 | 根 `README.md` 仍写 schema 4；自动开启被文档推给 B3                                   | 修复                                                         |
| 边界 | F1 App 启停进行中仍可开始仅工程的执行                                                 | 修复                                                         |
| 边界 | F2 工程关闭的 App 页面任务没有写入登记，可能污染他人的源码差异                        | 由 §9.8 消除                                                 |
| 边界 | F3 App 恢复失败后信任持久化的 `guestCwd`；伪造 `/etc` 可通过校验                      | 修复：恢复未确认时拒绝；只接受受管目录                       |
| 边界 | F4 开关后立即发送冻结旧 `appId`                                                       | 修复（SPEC §9.9）                                            |
| 边界 | F6 新旧 schema 严格程度不一；F7 改名前未 fsync                                        | 修复                                                         |
| 测试 | **阻断**：新 E2E 在网页隐藏后采集，必然失败                                           | 修复：先采集；断言写入登记（重启前后）与重启后的差异         |
| 测试 | Profile 拒绝时可能遗留工程登记                                                        | 修复并加测试                                                 |
| 测试 | 缺“开关关闭不被重新推断”“工程 + 普通网页”“保存时不覆盖 v6”“备份不可变”等用例          | 补齐；12 个变异均被捕获                                      |

检查（证据 evidence/b1-checks.txt（本地保留：`evidence/b1-checks.txt`）、先失败用例 evidence/b1-tests-first-fail.txt（本地保留：`evidence/b1-tests-first-fail.txt`））：

| 阶段   | 命令                                                                                                                                                   | 结果                                                                                      |
| ------ | ------------------------------------------------------------------------------------------------------------------------------------------------------ | ----------------------------------------------------------------------------------------- |
| 实现   | 先写用例                                                                                                                                               | 20 失败（预期）；另记类型检查的夹具错误与一处迁移断言                                     |
| 实现   | `pnpm typecheck`、受影响 vitest（22 文件 307 例）、全量 vitest（1482 通过、26 跳过）、eslint、prettier、`check-docs`、`git diff --check`、`pnpm build` | 均 0                                                                                      |
| 修复轮 | 同上；受影响 13 文件 296 例；全量 1493 通过、26 跳过                                                                                                   | 均 0                                                                                      |
| 两轮   | E2E                                                                                                                                                    | **未运行**：屏幕锁定（`CGSSessionScreenIsLocked=Yes`），`ensureForeground` 失败一次后停止 |

解锁后（2026-10-23 12:40 起）：

| 阶段                                                                                       | 命令                                                                                                | 结果                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                   |
| ------------------------------------------------------------------------------------------ | --------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| 首跑（主代理，evidence/b1-e2e-first-run.txt（本地保留：`evidence/b1-e2e-first-run.txt`）） | `pnpm build`；`project-binding.spec.ts`；全量默认 E2E                                               | 新用例单独与全量中都失败：重启后的执行停在 `starting`（`:101`）；全量 193 通过、1 失败、16 跳过                                                                                                                                                                                                                                                                                                                                                                                                        |
| 修复轮 2                                                                                   | 根因                                                                                                | 测试夹具 `e2e/fixtures/source-snapshot-fixture.ts:56` 让所有会话共用固定代次 `'source-fixture'`，重启后计数从 1 重新开始；Main 对同一代次中不更新的 seq 正确地不予应用（`application.ts:2724`），回复与结束事件都被忽略。真实 service 每个会话槽位生成新代次（`apps/service/src/codex-chat.ts:336`），产品不受影响。修复只改夹具：每个夹具进程一个代次。恢复旧常量的对照运行复现同一失败（evidence/b1-r2-e2e-control-old-generation.txt（本地保留：`evidence/b1-r2-e2e-control-old-generation.txt`）） |
| 修复轮 2                                                                                   | `project-binding.spec.ts --repeat-each=3`                                                           | 3/3 通过（evidence/b1-r2-e2e-project-binding.txt（本地保留：`evidence/b1-r2-e2e-project-binding.txt`））                                                                                                                                                                                                                                                                                                                                                                                               |
| 修复轮 2                                                                                   | 10 个受影响 spec                                                                                    | 62 通过、1 失败：`workspace-migration.spec.ts:76` 在 sbx 检查完成前发送，得到「Codex CLI 不可用：正在检查 sbx…」，本批未改动该路径；`--repeat-each=2` 复跑 16/16 通过（evidence/b1-r2-e2e-affected.txt（本地保留：`evidence/b1-r2-e2e-affected.txt`）、evidence/b1-r2-e2e-workspace-migration-rerun.txt（本地保留：`evidence/b1-r2-e2e-workspace-migration-rerun.txt`））；原因记为既有时序竞争，**undetermined**，B6 再核对                                                                           |
| 修复轮 2                                                                                   | 全量默认 E2E                                                                                        | 194 通过、16 跳过、0 失败（evidence/b1-r2-e2e-full.txt（本地保留：`evidence/b1-r2-e2e-full.txt`））                                                                                                                                                                                                                                                                                                                                                                                                    |
| 修复轮 2                                                                                   | `pnpm typecheck`、受影响 vitest（4 文件 70 例）、eslint、prettier、`pnpm build`、`git diff --check` | 均 0                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                   |

修复轮 2 的 diff 只有夹具（1 个文件，+9 / −2）；没有修改断言。

闸门：无页面引用的工程任务有正确的工程绑定、写入登记与源码差异（单测与 E2E，含重启后）；非法组合被拒绝（单测与 IPC 单测）。通过，进入 B3。

全树 `pnpm lint` / `format:check` 在本批未改动的文件上失败（基线已知，见前置检查）。`git diff --stat`（全树，含 B0/B2/B4）：81 个文件，+2027 / −1346。

### B1 审查补修 · 工程保存失败阻止发送（2026-10-23）

独立审查发现 P1：`Session.tsx` 只等待工程切换请求结束，未检查 `ok:false` / IPC 异常返回的 `null`，可能按旧工程继续确认和执行。此次由 coder 修改，主线程审查并独立复验；保留既有未提交修改，不提交或推送。

- `apps/desktop/src/renderer/src/workspace/Session.tsx`：记录工程保存成功与否；发送和确认任务均等待最新工程选择保存成功。等待中有新的切换则继续等待；失败后重复发送仍阻断，草稿保留，通过既有错误通道提示重新选择；显式重选成功后恢复。Main、协议、持久格式和执行授权不变。
- `e2e/project-binding.spec.ts`：新增业务拒绝、IPC throw、延迟保存成功、等待中后续切换失败四例。测试在 Main IPC 边界注入故障并审计 `confirmTask` / `startRun`，核对任务版本、运行数量、持久草稿及输入框；同时覆盖重复发送、确认入口和成功重选恢复。截图使用每次运行独立目录，避免覆盖历史证据。

证据在本地归档中按 `evidence/p1-project-save/` 路径保留。旧实现有效基线为 3 failed / 1 passed（本地保留：`evidence/p1-project-save/06-baseline-e2e-fixture-corrected.txt`），其中后续切换用例直接捕获了错误派发；修复后 coder 的完整工程绑定文件 5 passed（本地保留：`evidence/p1-project-save/11-fixed-e2e-toast-dismissed.txt`）。此前 EPERM、测试夹具未配置 URL、错误提示遮挡后续点击等失败日志均保留；测试通过真实关闭按钮消除提示，不用强制点击绕过遮挡。

主线程独立验证：

| 命令                                                                                                                                                                                                                                               | 结果与证据                                                                                                                                                                                                                                                                   |
| -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `pnpm build`                                                                                                                                                                                                                                       | passed，退出 0；22-review-build.txt（本地保留：`evidence/p1-project-save/22-review-build.txt`）                                                                                                                                                                              |
| `pnpm exec vitest run apps/desktop/src/main/workbench/project-binding.test.ts apps/desktop/src/main/workbench/repository.test.ts apps/desktop/src/main/ipc-project-binding.test.ts apps/desktop/src/main/workbench/run-source-application.test.ts` | passed，4 文件 68 例；21-review-unit.txt（本地保留：`evidence/p1-project-save/21-review-unit.txt`）                                                                                                                                                                          |
| `env -u ELECTRON_RUN_AS_NODE pnpm exec playwright test e2e/project-binding.spec.ts e2e/review-regressions.spec.ts --output=test-results/p1-project-save-review`                                                                                    | passed，26 例；23-review-e2e.txt（本地保留：`evidence/p1-project-save/23-review-e2e.txt`）                                                                                                                                                                                   |
| `pnpm exec tsc -p tsconfig.e2e.json`                                                                                                                                                                                                               | passed；25-review-e2e-types.txt（本地保留：`evidence/p1-project-save/25-review-e2e-types.txt`）                                                                                                                                                                              |
| `pnpm typecheck`                                                                                                                                                                                                                                   | failed；20-review-typecheck.txt（本地保留：`evidence/p1-project-save/20-review-typecheck.txt`）。本轮期间另行出现的 `capture-receiver.test.ts` 引用不存在的 `capture-receiver`，并有 readonly 数组类型错误。该文件不在此次修改范围，未覆盖或修复；不能宣称全树类型检查通过。 |

此次仅验收该 P1 的故障、时序及关联回归；未运行全量 E2E、打包、真实模型、sandbox live 或完整 B3/B5/B6 验收。历史 194 passed 仍只属于上一轮记录。本轮没有用户接受结果或发布。

定向 ESLint 首次因测试新增的空 fixture 参数失败（24-review-lint.txt（本地保留：`evidence/p1-project-save/24-review-lint.txt`））；仅对该 Playwright 回调添加带理由的局部规则豁免后，独立复跑通过（26-review-lint-rerun.txt（本地保留：`evidence/p1-project-save/26-review-lint-rerun.txt`））。源码与测试格式检查通过（27-review-format.txt（本地保留：`evidence/p1-project-save/27-review-format.txt`））。文档检查首次因目录链接不被检查器支持而失败，改为目录文字加具体日志链接后复跑；未修改既有证据。

本轮生产源码 SHA-256：`Session.tsx` 为 `ba024a08d1254bdc661c2eb71149e273448a3a88c989be5398a7def7ca91731a`；最终测试 `project-binding.spec.ts` 为 `52321e1e0f2cc714d368878d760f7be4c4d679343d50031e659b00ca3f9a53e7`。26 例窗口复验后仅增加上述测试注释与 lint 豁免，没有改变运行逻辑。后续 B3 若修改这些文件，本记录不自动适用于新版本。

### B5 快捷键候选（2026-10-23，窗口验收受阻）

本阶段实现 S8、S9、S7 键盘关闭以及 CmdT 新网页路径；S6 默认环境、自动标题/重命名与悬停关闭未包含。主线程独立全量单测 1547 通过（另 103 脚本测试通过）、类型与构建通过，固定基准自检 12 通过。固定基准与既有改动保留；pnpm check 仍因原固定 cdp.ts lint 失败。

最终候选的 B3 取消/采集、两项保存 P1 与 B5 窗口复验尚未完成：Mac 锁屏导致窗口无法取得焦点，已请求用户手动解锁。采集新空间用例先前的 preview undefined 失败仍待验证；不得据静态通过宣称 B5 或全量回归通过。范围、完整证据和待执行项见 独立审查（本地保留：`evidence/b5-shortcuts/REVIEW.md`）。未提交、推送。

### 停止说明（2026-10-23 22:30，本会话主代理）

2026-10-25 整合注记：该私有执行输入保存在封存快照中，未作为仓库文档迁入；历史结果不等于本次验收。

本会话按 运行 prompt（原路径 `.local/ops-1-ultracode-prompt.md`） 编排到 B3，现按 §6 停止：发现另一个会话（Claude Desktop「Handoff code execution」，约 17:20 起）在同一工作树并行写入，包括上文“B1 审查补修”与“B5 快捷键候选”两节、`docs/acceptance/full-browser-20261023/`（BROWSER-1，不属于 OPS-1）及其源码与 E2E。本会话的 B3 实现 agent 与之同时修改了 `Session.tsx`、`Browser.tsx`、`project-binding.spec.ts` 等文件（它在对方改动之上继续，未回退）。继续 B5 会形成同一批文件的两个写入者，需要用户决定由哪一方继续。

B3 现状（本会话实现 agent 报告，主代理未复核 diff，闸门**未判定**）：

- 实现：一步「选择元素」与接收者按钮（`capture-receiver` 菜单只设接收者）；默认接收者解析与本设备最近活动偏好（`state/capture-receiver.ts`）；发起时冻结接收者与页面、重复触发去重；采集完成按条件展开，窄窗、四窗格或已导航时只提示「已采集到 {会话} · 打开」；展开后 `shell.focusWorkbench()`（新增无参通道，`window.studio` 仍 6 键）再聚焦输入框；自动新建会话取消后关闭其标签（会话仍在后台资源，现有命令无法移除）；采集写入任务目标（修复 F3a）；「任务设置」折叠区与引用标签；「任务」视图只保留版本与「重新运行」。
- 检查：先写用例 13 失败；`pnpm typecheck`、受影响 vitest（256）、全量 vitest（1545 通过、26 跳过）、eslint、prettier、`check-docs`、`git diff --check`、`pnpm build` 均 0；含对方 B5 改动后再跑受影响 vitest 259 通过、typecheck 0。本会话 agent 自己的 E2E 因锁屏 9/9 失败于 `ensureForeground`（evidence/b3-e2e-first-run-screen-locked.txt（本地保留：`evidence/b3-e2e-first-run-screen-locked.txt`））。对方会话在 21:13 的全量回归 215 通过、17 跳过（`evidence/b3-full-regression/`），之后 21:39 起 B5 候选又修改了 B3 依赖的文件，该结果不适用于当前树。汇总见 evidence/b3-checks.txt（本地保留：`evidence/b3-checks.txt`）。
- 对抗审查：B3 尚未进行。
- 待用户决定的 B3 解释：① 本空间无活动记录、也不同屏的会话不作为默认接收者，示例空间首次点选会自动新建会话；② 标签已关闭的会话不作为接收者、不列入菜单；③ 专注模式按窄窗处理（只提示）；④ R8 在采集失败时同样清理，草稿视为“已使用”；⑤ 自动会话按标签标题命名；⑥「打开」使用 `locateSession`，可能替换活动窗格中的网页；⑦ 展开时的版本冲突显示通用提示。

恢复需要：确定唯一的编排者与写入者；对当前树重新 `pnpm build` 并在解锁屏幕上运行 B3 列出的 E2E 与全量默认 E2E；完成 B3 三路审查与闸门；再继续 B5（对方候选未含 S6 默认环境、自动标题/重命名、悬停关闭）与 B6。BROWSER-1 是否并入本轮交付也需要决定。

### B5 解锁后续查：真实 CmdT 焦点修复候选

解锁后主线程独立定向 B3/P1 23 项通过，B5 7 项在全量中通过；首次全量为 220 passed / 17 skipped / 2 failed，两个旧测试契约/焦点前置问题已由 coder 仅修正测试。随后真实 CUA 发现 CmdT 创建新原生视图后夺回地址栏焦点，已由 coder 改为真实 browserLayout 回执后的单次聚焦，并新增延迟布局时序断言。

最终候选独立单测复跑 1551 + 103 项通过，类型检查通过。首次安装器 5 秒超时记录保留。Mac 再次锁屏，因此修复后的窗口复验未完成；前述窗口通过数不能覆盖新候选。固定基准保留，未提交推送。以 审查记录末节（本地保留：`evidence/b5-shortcuts/REVIEW.md`） 为当前状态。

### B5 快捷键阶段最终复验（2026-10-24）

当前 B5 快捷键阶段已完成独立窗口验证：全量默认 Electron 回归 223 通过、17 跳过、0 失败，包含 B5 8 项、B3 采集/取消 12 项、工程保存 P1 5 项和目标保存 P1 6 项。真实 macOS 按键复验确认 CmdT 地址栏可直接输入；最终修复同时等待首文档就绪与布局回执，解决新原生视图延迟激活抢焦点。此前锁屏及失败记录保留，以本节与 独立审查（本地保留：`evidence/b5-shortcuts/REVIEW.md`） 的最终结果为准。

最终独立 `pnpm test` 复跑为 1552 通过、26 跳过，另 103 项脚本测试通过；首次运行未改动的安装器用例发生 5 秒超时，原因未确定，失败日志保留。最终类型检查通过。384 个候选输入与 10 个固定基准文件的哈希核对均无变化。

本阶段覆盖 S8、S9、S7 键盘关闭及 CmdT 新网页路径；不代表整个 B5 完成，S6 默认环境、自动标题/重命名与悬停关闭仍未包含。全局检查仍存在固定基准 cdp.ts 的既有 lint 错误及历史格式问题，未为通过检查修改固定基准。未提交、推送或运行真实模型验收。

### B5 剩余功能候选（2026-10-24，末轮窗口复验待解锁）

默认环境、一键创建、自动标题/就地重命名与悬停关闭已实现。审查补修环境错误被隐式重试清除、重命名迟到回执抢焦点，并增加故障注入、同空间导航及动画帧时序测试。最后又通过门控证实文档代次投影延迟会错误拒绝标签编号快捷键，窄修复仅调整 `activate-tab-*` 的文档代次检查，保留空间、资源/webContents 归属与页面操作校验。

末次完整独立 Electron 回归为 233 通过、17 跳过、1 失败（连续 Cmd9→Cmd1）；其中新增 B5 11 项、B3 采集/取消 12 项、工程绑定 5 项、目标保存 6 项通过。该全量发生在最后快捷键窄修复之前，不能扩展为当前候选全量通过；原始失败是否与门控同因仍未确定。修复后窗口尝试因 Mac 锁屏停在 ensureForeground，已请求手动解锁，真实按键和最终完整复验尚未完成。

保留原始失败、固定 SPEC、10 个固定基准和已有改动；不提交或推送。改动、单测/类型/构建与后续状态详见 本轮独立审查（本地保留：`evidence/b5-remaining/REVIEW.md`）。

### B5 剩余功能最终独立复验（2026-10-24，解锁后）

默认环境、自动标题/就地重命名与悬停关闭已完成本轮技术验证。最终独立全量 Electron **235 通过、17 跳过、0 失败**；B5/B3/两项保存 P1 定向 **43 通过**。永久文档投影延迟门控通过：标签编号快捷键可用，陈旧文档采集仍拒绝。真实 CUA 复验了新网页地址焦点、自动/手动标题、F2/双击及取消、连续编号切换/关闭、后台实例保留和默认终端不自动连接。

最终独立全量单测 **1561 通过、26 跳过，另 103 项脚本通过**；类型检查、构建与 24 文件范围 lint/格式通过。24 个候选输入一致、10 个固定基准未变。历史失败及首次非门控 Cmd1 失败的未确定归因保留，不用后续通过改写旧证据；全局既有 lint/格式限制仍在。该结果取代上节“待解锁”状态，不扩展为 B6、真实模型、发布或用户接受。

详见 最终独立结论（本地保留：`evidence/b5-remaining/REVIEW.md`） 与 真实窗口记录（本地保留：`evidence/b5-remaining/UNLOCKED-MANUAL.md`）。保留现有改动和固定 SPEC，未提交或推送。

## B6 集成验收（2026-10-24）

B6 已完成维护范围内的集成验证，详见 审查与 SPEC 覆盖矩阵（本地保留：`evidence/b6-integration/REVIEW.md`）、既有断言审查（本地保留：`evidence/b6-integration/ASSERTION-REVIEW.md`） 与 真实窗口检查（本地保留：`evidence/b6-integration/MANUAL.md`）。coder 仅新增 e2e/b6-integration.spec.ts 共 9 项；主线程审查并独立复验。

- 最终默认 Electron 全量：244 通过、17 跳过、0 失败，含 B3 取消/采集、工程和目标保存两项 P1、B5 快捷键及剩余行为。
- 单位测试 1561 通过、26 跳过，脚本 103 通过；类型、构建、维护目录 lint/format 通过，固定基准自检 12 通过。
- 三主题 × 960/1440 的真实同屏布局与原生菜单外部点击、Down、Esc 已复验。
- 首次独立全量 243 通过、17 跳过、1 失败：面板未打开，根因未定。相同候选定向重复 3 次及最终全量通过，首次失败证据继续保留。
- 全局 pnpm check 仍受历史固定 cdp.ts prefer-const 影响，全局格式检查仍有 10 个历史固定文件；遵循既有维护目录例外，不称全树绿色。

现有改动、固定 SPEC/基准和历史失败证据均保留。没有提交或推送；真实模型、sandbox live、packaged 专属验证及用户接受不在本轮结论内。

## B6 面板偶发失败跟进（2026-10-24）

详见 诊断、红绿证据及剩余限制（本地保留：`evidence/b6-palette-followup/REVIEW.md`）。面板首轮仍缺少焦点/遮挡回执，原因未定；原用例未改动重复 5 次通过，新增自然/延迟确认/真实失焦恢复 3 项诊断通过。未通过放宽焦点守卫掩盖失败。

扩展回归发现并确定性复现独立 CmdT 缺陷：同身份原生网页文档代次领先 Renderer 时，新建空白标签被错误拒绝。coder 最小修复只允许 new-web-tab 忽略旧文档代次差，归属与采集校验保留；主线程审查、独立红绿与重建复验通过。

修复后完整离线测试 1566 通过、26 跳过，脚本 103 通过；类型、构建和改动文件 lint/format 通过。相关窗口回归 53 通过、3 失败；三项隔离复验均通过，但原 WebSocket EPIPE、窗口清理和 hover 失败保留，不能称整组全绿。B6、B3 取消采集及两项保存 P1 在修复后回归均通过。固定 SPEC/基准与历史失败保留，无提交或推送。
