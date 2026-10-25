# Web Studio Lab

Web Studio Lab 是基于 [Web Studio](https://github.com/JadeSnow7/Web-Studio) 既有设计与工程经验构建的 Electron 桌面工作台，参加 [OSCHINA 开源大赛 2026](https://www.oschina.net/os2026/)。目标闭环：在运行页面上点选元素、确认任务，由 Codex CLI 修改代码，工作台启动 App 并执行固定验收，给出可复验的证据，最后由开发者决定是否接受结果。

本次整合的源码说明与历史记录分开：OPS / Browser / Harness 的链接记录绑定其原日期和来源版本，不能作为当前候选重新验证或用户接受的证明。本轮范围和已完成检查见[2026-10-25 整合记录](docs/acceptance/consolidation-20261025/README.md)；最终验收以仓库外回执为准。

范围、排期与验收以[任务计划](docs/plans/2026-10-os2026-task-plan.md)为准，实现约束见[架构文档](docs/ARCHITECTURE.md)。

移动端扩展已形成[Expo Android 第一阶段设计](docs/design/2026-10-11-expo-android-phase1.md)和[实施与验收计划](docs/plans/2026-10-11-expo-android-phase1.md)：拟支持固定 Expo 项目、工作台 Web 预览、Android USB 真机连接和本地 APK 导出。当前仅完成设计，尚未修改移动端源码或执行移动端验收；不计入既有比赛闭环已实现能力。

多 Harness 的目标路线、采纳决定与实施映射分别见[设计](docs/design/2026-10-21-multi-harness-collaboration.md)、[ADR-0003](docs/architecture/adr/0003-pluggable-harness-and-collaboration.md)和[计划](docs/plans/2026-10-21-multi-harness-collaboration.md)。MHC-W8 指 Bot/会议，WF-W8 指 Workflow 固定波次；MHC-W9 指 Gemini/Cursor，WF-W9 指 Ultra，不能混用。

| 范围               | 源码与证据边界                                                                                                                                                                                                                          |
| ------------------ | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 普通会话           | Codex native / Claude Code ACP、Profile 自检/选择/冻结与一次审批已有接线；历史 live 不等于本候选复验                                                                                                                                    |
| Workflow 隔离候选  | I4 已整合只读执行、候选发布/显式应用、固定波次及关闭清理修复源码；实际隔离适配器仅 Codex native；已取得的历史真实运行证据仅覆盖 `codex:default`，当前候选未做真实多 Profile 矩阵验收；成员表由 Main 每次受理时冻结的 Profile 快照生成。 |
| 真实矩阵与阶段出口 | MockHarness 3×2 等 fixture 矩阵只证明离线条件；E8 真实矩阵、WF-W9/Ultra 未做，P2/P3 出口尚未通过                                                                                                                                        |
| 后续路线           | 多方案选择、Board/Handoff、Bot/会议、Gemini/Cursor、remote 仍未在本次实施或接受                                                                                                                                                         |

2026-10-25 整合注记：上表说明源码范围；I4 聚焦红/绿回归与离线全量检查已完成，最终构建和窗口验收待主代理执行，不提前宣称 Workflow 产品验收通过。[2026-10-14 收尾记录](docs/acceptance/consolidation-20261011/closeout-20261014.md)只保留当日保全事实，不增加本次产品结论。

## 当前状态

当前候选树整合 Electron 工作台、统一观察、受管标准 App、账户资源目录、App 控制面、App 名称/说明和任务目标绑定，以及统一状态呈现与诊断。六板块布局继续遵循[空间页重制 SR-1](docs/acceptance/space-remake/SPEC.md)。2026-10-13 的 PR 范围、审查修复、实际验证与未运行项见[2026-10-13 历史 PR 说明](docs/acceptance/consolidation-20261011/PR.md)；[2026-10-11 整合记录](docs/acceptance/consolidation-20261011/README.md)、[状态界面实施与修复记录](docs/acceptance/status-surface-20261011/README.md)及更早记录保留为历史，不能替代当前版本复验。独立源码工具支持 edu-web 源码快照、校验、三方合并和人工冲突解决，见[CLI 说明](docs/development/edu-source-cli.md)；当前 edu-only 导入、运行和导出接线受 Main/source 保护约束；edu 任务写回及发音验证未开放，旧分支记录不替代本候选验收。

| 能力         | 实现与验证边界                                                                                                                                                                                                  |
| ------------ | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 全局导航     | 首页、空间、资源、会话、任务和底部设置保持独立入口；空间工作台只装配到空间页                                                                                                                                    |
| 空间工作台   | 空间切换、垂直标签、最多四窗格、后台资源重开；关闭标签不停止实例                                                                                                                                                |
| 左右侧栏     | 全局按钮和空间标签整组浮动/固定；右侧仅通知；左右固定偏好分别保存到本设备                                                                                                                                       |
| 主题         | 设置页编辑当前空间的白/暗/暖/系统主题，终端同步共享颜色                                                                                                                                                         |
| 网页与现场   | 原生WebContentsView、地址与导航、同一页面CDP采集；请求固定接收会话与文档身份                                                                                                                                    |
| 对话与终端   | sbx内Codex和Linux PTY；个人会话独立，空间会话由Main工作台管理                                                                                                                                                   |
| 任务与通知   | 持久任务版本、运行历史、日志、终态通知与阅读回执；执行、检查和人工接受分别记录                                                                                                                                  |
| 恢复         | 恢复元数据、草稿、布局和历史，不自动重放执行或重新连接PTY                                                                                                                                                       |
| 标准应用     | 独立版本化 React/TS/Vite + Hono + Drizzle/PGlite + Zod 模板；空间内创建、受管启动、Browser接入、停止与源码导出                                                                                                  |
| 完整业务闭环 | 任务源码快照与真实diff已有接线；priority业务API、独立检查器与完整固定业务闭环仍有缺口；2026-10-09 的 VS001/标准应用历史结果见[最小闭环记录](docs/acceptance/integrated-app-installer-public-20261009/README.md) |
| 统一观察     | Browser、文件、终端与 SSH 已接 Main、MCP 和空间界面；完整验证进行中                                                                                                                                             |
| App 控制面   | 阶段 A 已接线；下文保留历史真实模型与 Host 复验证据，本次 PR 不重新调用模型或 sandbox live；产品检查器尚未接入                                                                                                  |
| 状态与诊断   | Main 只读事实投影与 Renderer 状态槽；取消、接管和清理未确认持续可见，诊断默认关闭，日志有界且检查文件归属                                                                                                       |
| Code Wiki    | [独立交互原型](docs/design/2026-10-12-code-wiki/README.md)：模块、通信、源码依赖及流程地图；源码摘录固定于 2026-10-12，不是本候选的自动扫描结果                                                                 |

## 环境

详细安装与独立 sbx 沙箱测试前置条件见[开发依赖与安装](docs/development/dependencies.md)。2026-10-06 的本机历史记录包含 sbx v0.47.0、Docker/OpenAI OAuth 准备与真实 smoke，见[沙箱验证记录](docs/verification/2026-10-06-sbx/README.md)和[应用接入验证](docs/verification/2026-10-06-sbx-app/README.md)。新机器须重新准备，本轮认证和 live 是否可用以当前验收记录为准。未配置 sbx 不妨碍启动桌面；sandbox 对话/终端会明确不可用。

- macOS Apple Silicon。其他平台没有验证。
- Node：与 Electron 44.5.1 内置的 Node 24 对齐，`.nvmrc` 为 24。2026-10-06 的本地验证实际运行在 Node 26.5.0 上，该记录不代表当前环境；本次离线检查已使用 Node 24.21.0。
- pnpm 10.34.6（见根 `package.json` 的 `packageManager`）。若本机尚未安装，可以 `npm install -g pnpm@10.34.6`，或者在下面的命令前加 `npx pnpm@10.34.6` 代替 `pnpm`。
- 首次运行 Electron 时会下载 Electron 二进制（约 100 MB）；首次打包时 electron-builder 还会下载自己的 Electron 包与 dmg 工具。需要网络。

## 启动与检查

所有命令都从仓库根目录执行。

```bash
pnpm install --frozen-lockfile
```

```bash
WSL_SBX_NAME=wsl-sbx-smoke-20261006 pnpm dev
```

`pnpm dev` 启动 Vite dev server 和 Electron 工作台。启动后 Browser 区加载演示页面 `wsl-demo://taskflow/index.html`，可在网页工具栏关联会话并采集页面现场，在接收会话的“任务”视图确认任务；日志和检查从任务历史或会话运行详情进入。

```bash
pnpm check
```

`pnpm check` 依次运行类型检查（含 e2e 与配置文件）、ESLint、Prettier 格式检查和 Vitest 单元测试，并在首个失败时停止。本树保留 VS001 与来源档案的原始格式；2026-10-13 的失败与结果只属于[历史 PR 说明](docs/acceptance/consolidation-20261011/PR.md)。本轮分别执行的检查、来源格式例外及未运行项见[本轮整合记录](docs/acceptance/consolidation-20261025/README.md)。需要全部结果时分别运行 `pnpm typecheck`、`pnpm lint`、`pnpm format:check`、`pnpm test`，不要自动格式化封存证据。

```bash
pnpm test:e2e
```

`pnpm test:e2e` 先 `pnpm build`，再用 Playwright 驱动真实的 Electron 窗口，检查启动与安全边界、页面现场、任务与运行归属、空间和标签切换、草稿、左右气泡、快捷键、主题及窄窗恢复。截图写到 `test-results/screens/`。

## 沙箱对话与终端

先按[依赖说明](docs/development/dependencies.md)准备 sbx、该 sandbox 已配置的认证和 guest Codex/Node。启动时用 `WSL_SBX_NAME` 选择已有沙箱，历史测试使用 `wsl-sbx-smoke-20261006`；`WSL_SBX_BIN` 可指定 CLI 路径。历史 live 验证仅适用于各自记录的版本与授权；2026-10-13 PR 整理不调用真实模型或 sandbox live。应用从 PATH、`/opt/homebrew/bin/sbx`、`/usr/local/bin/sbx` 定位 sbx，配置不成功时明确禁用发送。生产通路不再使用 `WSL_CODEX_BIN` 或 host Codex。

首页个人对话和会话页支持 Enter 发送、Shift+Enter 换行、取消和开始新对话。空间会话标签分别保存草稿、任务版本与运行，进入新会话使用空间的新建会话入口。界面显示 sandbox 与 guest cwd，运行详情可查看工具结果及警告。Codex 可以使用 guest 工具读写 `/home/agent/workspace`；对话历史分开，但文件系统与终端共享。新对话不会删除 guest 文件，也不承诺删除 CLI 历史。

空间垂直标签中的“开发终端”提供显式连接入口，打开交互shell，支持持续 cwd/环境、Ctrl-C、窗口尺寸变化与关闭。切换标签保留 shell；关闭终端或取消对话须确认所属远端进程退出。应用不会停止整个 sandbox，sandbox 内安装与文件由 sbx 保留。Browser 可加载演示页面、原生 HTTP/HTTPS 网站，以及当前空间明确启动且通过身份健康检查的沙箱应用。

普通 `pnpm test:e2e` 使用缺失配置或确定性 sbx fixture，不调用真实模型。App 名称/说明、失败草稿、键盘和窄窗流程由 `e2e/space-app.spec.ts` 验证。显式真实检查需要本机已准备好的 sandbox、有效的既有 sandbox 认证、网络和原生窗口权限：

```bash
pnpm build
WSL_LIVE_SBX=1 WSL_SBX_NAME=wsl-sbx-smoke-20261006 pnpm exec playwright test e2e/sbx.spec.ts --grep 'live'
```

固定范围见 [sbx 应用 SPEC](docs/verification/2026-10-06-sbx-app/SPEC.md)，执行结果见[验证记录](docs/verification/2026-10-06-sbx-app/README.md)。原来的 [host 对话记录](docs/verification/2026-10-06-codex-chat/README.md)保留为历史证据。

## 受管 App 的 Agent 控制面（阶段 A）

标准模板 1.1.0 内建 Agent 控制面：前端 `defineCommand`/`exposeState` 注册表、仅 agent 构建挂载的 `window.__WSL_AGENT__`、后端 `server/agent-cli.ts` 与构建导出的 `agent/app.manifest.json`。guest Codex 在 TaskRun 内通过 `app_*` MCP 工具或 `wsl-app` CLI 读取自描述、快照并以结构化动作操控页面、读写本实例数据和回放场景；Main 统一授权、审计并在用户点击 Browser 区时暂停 AI。设计见[控制面设计](docs/design/2026-10-11-app-control-plane.md)，取舍见 [ADR-0002](docs/architecture/adr/0002-app-control-plane.md)，计划与验收矩阵见[实施计划](docs/plans/2026-10-11-app-control-plane.md)，本轮结果见[验证记录](docs/verification/2026-10-11-app-control-plane/README.md)。真实 Electron 与 CDP 的集成检查（本机构建的模板服务，无 sandbox、无模型）：

```bash
pnpm exec playwright test e2e/app-control-harness.spec.ts
```

产品窗口 + 真实 sandbox 的 A03/A07 在修复后复验通过（`WSL_APP_CONTROL_LIVE=1 pnpm exec playwright test e2e/app-control-live.spec.ts`，guest 侧由测试引导代替）。获得真实模型授权后，[A11](docs/verification/2026-10-11-app-control-plane/round-09-model-live/README.md) 通过正常 TaskRun 调用真实 guest Codex 与 MCP，Host 独立重放固定场景 16 步并核对数据库成功；默认测试仍不调用模型，A11 需显式 `WSL_APP_CONTROL_MODEL_LIVE=1`。[round-10 CLI 修复](docs/verification/2026-10-11-app-control-plane/round-10-cli/README.md) 将被命令沙箱拒绝的 Unix socket 改为每轮有界文件通道；真实 Codex 命令沙箱中 11 项 CLI 检查、MCP 及 Host 固定 16 步通过，旧实例和未授权 reset 正确拒绝，原权限与 64/4 预算不变。[round-11](docs/verification/2026-10-11-app-control-plane/round-11-cli-cancel/README.md) 补齐真实模型在途 CLI 的产品按钮取消：停止新动作、所属进程/通道清理、保留源码和下一轮迟到响应隔离通过；同时修复 AI 重启自动切走用户会话。独立 Host 测试不改变产品的 validation 或用户接受状态。

[round-12 审查修复](docs/verification/2026-10-11-app-control-plane/round-12-review-fixes/README.md) 增加 HTTP 操作身份与终态核对、持久写入保护及“重新核对”，修复 CLI 清理归属、快照引用复用和嵌套 JSON 散列。取消数据操作时 App 保持运行；旧模板不具备操作追踪能力时拒绝写入。引用目标必须携带 `snapshotId`。本轮自动检查、真实运行、失败记录和用户接受边界分别见该轮记录。

## 我的资源与空间连接

资源归属用户账户，个人收藏、空间连接、正文版本与运行实例分别记录。全局“资源”定位为个人收藏；空间资源在空间页独立折叠区访问，活跃标签和后台实例保留各自状态。本轮实现、验收证据及未决项见[账户资源改造记录](docs/acceptance/resource-ownership-20261010/README.md)，目标约定见[冻结合同](docs/acceptance/resource-ownership-20261010/SPEC.md)。

收藏网页链接只保存地址，不访问网络。普通网页在应用内使用 Chromium 原生 HTTP/HTTPS 浏览，保留网站样式、脚本、搜索、表单和登录；同空间网页共享持久网站会话，登录弹窗仍在应用内打开。不同空间、工作台和受管 App 使用独立 session。保存正文快照是独立的显式操作，只读取当前页面正文并追加不可变版本，与收藏、连接空间分别执行。行为、隔离边界与本轮实际验证见[完整浏览合同](docs/acceptance/full-browser-20261023/SPEC.md)和[验证记录](docs/acceptance/full-browser-20261023/README.md)。

空间会话只读取本空间明确选择的连接版本，个人会话只读取明确选择的收藏版本，默认不附带。每轮最多 16 个参考，收藏数量不继承这个限制；新版本不改变在途与历史任务的固定证据。Main 是目录唯一写入者，当前 schema 5 持久化账户目录、工作台与 App 元数据（schema 1–4 仅作迁移来源），并识别两种历史 schema 3 来源；旧空间资源迁移为账户资源和原空间连接，默认不收藏，旧文件保留且不自动启动进程。

真实网络、模型结果和受控 fixture 分别记录。历史[公开快照合同](docs/verification/2026-10-06-public-resources/SPEC.md)保留来源隔离证据，旧空间所有权与 TaskFlow 专用集合由新合同替代。本轮未运行真实模型或 sandbox live。

普通测试默认不调用模型。以下分别是实际 Codex 读取明确标识的内存测试资料，以及真实公网到 UI 空间再到模型的链路；需显式运行并保留实际结果，不能相互替代：

```bash
WSL_LIVE_RESOURCE_AGENT=1 WSL_SBX_NAME=wsl-sbx-smoke-20261006 pnpm exec vitest run apps/service/src/resource-agent.live.test.ts
pnpm build
WSL_LIVE_RESOURCE=1 WSL_SBX_NAME=wsl-sbx-smoke-20261006 pnpm exec playwright test e2e/resources-live.spec.ts
```

## 打包

本机可按 [外置构建产物说明](docs/development/external-builds.md) 将构建输出与载荷缓存放到外置盘。

比赛安装器的构建入口现要求固定离线载荷、Developer ID Application 签名及 Apple 公证。安装方式、构建凭据和失败恢复见[比赛版安装与构建](docs/development/competition-installer.md)，本轮实际验证边界见[安装器验收约定](docs/acceptance/installer-20261009/SPEC.md)。

```bash
pnpm payloads:prepare
pnpm package
```

正式构建输出到 `apps/desktop/release/`（DMG、ZIP、App，以及校验和与版本清单）。缺少正式证书、公证失败或载荷不一致时停止，不降级为正式交付。打包后可以对包内应用重跑同一套检查：

```bash
pnpm test:e2e:packaged
```

仅内部开发验证可生成明确标记的未签名包，输出到独立的 `apps/desktop/release-internal/`。它不能证明 Gatekeeper、首次安装或比赛交付通过：

```bash
pnpm package:unsigned
```

## 目录

| 路径                 | 内容                                                                                                |
| -------------------- | --------------------------------------------------------------------------------------------------- |
| `apps/desktop`       | Electron：`src/main`（窗口、IPC、Browser 区控制）、`src/preload`（窄 API）、`src/renderer`（React） |
| `apps/service`       | 独立Node对话、捕获、只读MCP和PTY服务；Main拥有账户目录并协调空间任务                                |
| `packages/protocol`  | Zod schema：页面现场、任务版本、run / attempt / 审阅、IPC 通道                                      |
| `demo/`              | 演示页面，只供 Browser 区演示加载，与真实运行数据分开                                               |
| `e2e/`               | Playwright 驱动 Electron 的端到端检查                                                               |
| `docs/plans/`        | 比赛任务计划                                                                                        |
| `docs/verification/` | 验证记录与截图                                                                                      |

安全基线：工作台与 Browser 区都启用 `contextIsolation`、`sandbox`，关闭 `nodeIntegration`；Browser 区没有 preload，使用独立 session；IPC 在主进程用 Zod 校验参数，并只接受主窗口顶层工作台页面的请求。详见[当前运行时](docs/architecture/current-runtime.md)的Electron安全基线。

## 架构与固定验收入口

[Agent 入口](AGENTS.md)、[架构基线](docs/ARCHITECTURE.md)与[开发规范](CONTRIBUTING.md)说明职责和协作要求；[当前运行时](docs/architecture/current-runtime.md)区分真实实现、目标约束与缺口。目标架构的取舍见 [ADR-0001](docs/architecture/adr/0001-modular-monolith.md)，受管 App 控制面的命名空间与 dispatcher 落点见 [ADR-0002](docs/architecture/adr/0002-app-control-plane.md)。

main 的 [VS001 固定验收基线](docs/acceptance/README.md)、`tests/vertical-slice`、固定 fixture 和实现前失败证据全部保留，包括 PR1 的观察值拒绝和源码类型检查修复。`src/vertical-slice/adapter.ts` 已接入现有 sbx/Codex、Vite 和 Electron Browser；实现及运行条件见 [VS001 接入记录](docs/acceptance/integrated-app-installer-public-20261009/README.md)。本轮真实五项与标准应用的结果分别记录在[最小闭环记录](docs/acceptance/integrated-app-installer-public-20261009/README.md)，不能据此认定完整比赛业务闭环完成；原验收需显式配置已有 sandbox 与实际模型。整合后的运行入口以本树 `package.json` 为准。

## 来源与继承边界

原项目：[JadeSnow7/Web-Studio](https://github.com/JadeSnow7/Web-Studio)。

参考基线固定为 [`f377db874f0ecba3390804146776b5e5786d2f86`](https://github.com/JadeSnow7/Web-Studio/tree/f377db874f0ecba3390804146776b5e5786d2f86)。本仓库从独立 Git 历史开始，没有迁入原项目源码、设计文档正文或二进制资产，也不迁入上游 Swift、Metal 与 Ghostty 代码。

优先参考以下已形成的设计契约：

- 工作区、资源描述、运行实例与可见区域分别拥有身份和生命周期。
- 资源切换保留会话；关闭视图与关闭底层资源分开处理。
- Agent 请求使用显式确认的有界快照，保持请求不可变，忽略取消后的迟到结果。
- 持久化恢复描述，不自动恢复终端进程；保存需要处理版本与并发修订冲突。

固定基线下的设计入口：

- [产品与结构设计（DESIGN.md）](https://github.com/JadeSnow7/Web-Studio/blob/f377db874f0ecba3390804146776b5e5786d2f86/DESIGN.md)
- [交互契约（UX-CONTRACT.md）](https://github.com/JadeSnow7/Web-Studio/blob/f377db874f0ecba3390804146776b5e5786d2f86/UX-CONTRACT.md)
- [源码架构导览](https://github.com/JadeSnow7/Web-Studio/blob/f377db874f0ecba3390804146776b5e5786d2f86/docs/source-guide/README.md)

后续迁移将逐项确认资产来源与适用许可，保留对应版权和第三方声明。原项目的本地运行记录、构建产物、环境配置和凭据不属于迁移内容。

## 许可证

本项目采用 [Apache License 2.0](LICENSE)。原项目在上述固定基线下也提供 [Apache-2.0 许可证](https://github.com/JadeSnow7/Web-Studio/blob/f377db874f0ecba3390804146776b5e5786d2f86/LICENSE)。本仓库引入的 npm 依赖适用各自许可证，依赖许可清单在冻结前统一生成（T12）；打包产物中的 Chromium 与 Electron 许可随包附带。

## 沙箱标准应用（第一工作包）

唯一母模板位于 [`templates/standard-app`](templates/standard-app/README.md)，独立维护 npm 锁文件和内容哈希，不修改 VS001 fixture。空间侧栏顶部提供网页、终端、会话和 App 图标入口；App 按钮打开创建与管理界面，支持名称/说明编辑、创建、启动、停止/取消和导出。名称和说明由 Main 持久保存，编辑不改变运行实例；确认任务时固定 App、项目工作目录与页面上下文，切空间不会重定向已有任务。工作台在已有 sandbox 内创建独占项目目录，应用进程独立于 Codex 任务；正式启动构建静态前端并由 Hono 同端口提供页面和 `/api`。重启保留磁盘 PGlite 数据，普通重启不运行 seed。

应用启动后验证 workspace、environment、project 与 appInstance 身份，再给原生 Browser 授予当前回环 origin 的访问能力。停止先撤销本实例端口映射，再确认所属进程清理；未知映射不自动删除。关闭 Browser 标签仍保留应用，停止请使用“停止应用”。源码导出要求服务已停止并确认清理，生成可运行源码目录及同级 `.manifest.json`，不包含数据或依赖目录。

安装包携带母模板和 Linux ARM64/glibc 离线依赖，Main 从安装资源校验源码、独立锁和归档哈希后传入服务。创建、导入依赖与端口操作共用安装配置中的 Sbx.app，不依赖 PATH 或 WSL 环境注入；缺失或损坏载荷显示设置错误并阻止连接。开发构建仍可通过 `WSL_APP_DEPENDENCY_ARCHIVE=/absolute/archive.tar.gz`（含配套哈希清单）和 `WSL_SBX_NAME` 联调。模板 A/B 会话仅是受控开发设施，统一会话观察该 sandbox Browser 的额外授权仍不在本包内。

显式启用的 `WSL_APP_LIVE=1 pnpm exec playwright test e2e/managed-app-live.spec.ts` 验证产品窗口、API、持久化、导出和取消，不调用模型。运行前须准备上述既有沙箱与依赖；真实验收的公开摘要与限制见[本轮记录](docs/acceptance/integrated-app-installer-public-20261009/README.md)。

整合构建的 `pnpm payloads:prepare` 同时准备工具链和模板依赖；`WSL_PAYLOAD_OFFLINE=1` 只使用已缓存下载与 npm 包，缺缓存即失败。发布 sourceFingerprint 包含 templates，载荷清单记录独立锁、模板内容、归档、平台审计与依赖许可证。打包产品复用上述 live 脚本（`WSL_E2E_TARGET=packaged`）；测试运行器选择 Sbx.app 和已有沙箱，应用进程清除所有 WSL 变量且仅保留系统 PATH。损坏载荷负例见 `e2e/managed-app-packaged-rejection.spec.ts`。最终整合版本的结果见[公开验收摘要](docs/acceptance/integrated-app-installer-public-20261009/README.md)；历史来源树证据不作为本轮通过依据。
