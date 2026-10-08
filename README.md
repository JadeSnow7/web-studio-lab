# Web Studio Lab

Web Studio Lab 是基于 [Web Studio](https://github.com/JadeSnow7/Web-Studio) 既有设计与工程经验构建的 Electron 桌面工作台，参加 [OSCHINA 开源大赛 2026](https://www.oschina.net/os2026/)。目标闭环：在运行页面上点选元素、确认任务，由 Codex CLI 修改代码，工作台启动 App 并执行固定验收，给出可复验的证据，最后由开发者决定是否接受结果。

范围、排期与验收以[任务计划](docs/plans/2026-10-os2026-task-plan.md)为准，实现约束见[架构文档](docs/ARCHITECTURE.md)。

## 当前状态

当前工作树按[空间页重制 SR-1](docs/acceptance/space-remake/SPEC.md)保留升级前的全局布局，本地基准为 `9e1df45`。正在实施[跨分支整合 INTEGRATION-1](docs/acceptance/integration-20261008/SPEC.md)：`331c47f` 已加入统一观察协议与 Provider，`c97b673` 接入环境和终端，`d9beb8a` 接入 Main、持久化与 MCP，`612cde0` 接入空间文件浏览和会话观察；完整验证继续进行。源码、检查、原生窗口与未完成项分别记录在[当前验收](docs/acceptance/integration-20261008/task-summary.md)，历史记录不能替代本轮结果。

| 能力         | 实现与验证边界                                                                   |
| ------------ | -------------------------------------------------------------------------------- |
| 全局导航     | 首页、空间、资源、会话、任务和底部设置保持独立入口；空间工作台只装配到空间页     |
| 空间工作台   | 空间切换、垂直标签、最多四窗格、后台资源重开；关闭标签不停止实例                 |
| 左右侧栏     | 全局按钮和空间标签整组浮动/固定；右侧仅通知；左右固定偏好分别保存到本设备        |
| 主题         | 设置页编辑当前空间的白/暗/暖/系统主题，终端同步共享颜色                          |
| 网页与现场   | 原生WebContentsView、地址与导航、同一页面CDP采集；请求固定接收会话与文档身份     |
| 对话与终端   | sbx内Codex和Linux PTY；个人会话独立，空间会话由Main工作台管理                    |
| 任务与通知   | 持久任务版本、运行历史、日志、终态通知与阅读回执；执行、检查和人工接受分别记录   |
| 恢复         | 恢复元数据、草稿、布局和历史，不自动重放执行或重新连接PTY                        |
| 完整业务闭环 | 母模板、priority业务API、独立检查器、真实diff/报告产物及VS001产品adapter仍未实现 |
| 统一观察     | Browser、文件、终端与 SSH 已接 Main、MCP 和空间界面；完整验证进行中              |

## 环境

详细安装与独立 sbx 沙箱测试前置条件见[开发依赖与安装](docs/development/dependencies.md)。2026-10-06 的本机历史记录包含 sbx v0.47.0、Docker/OpenAI OAuth 准备与真实 smoke，见[沙箱验证记录](docs/verification/2026-10-06-sbx/README.md)和[应用接入验证](docs/verification/2026-10-06-sbx-app/README.md)。新机器须重新准备，本轮认证和 live 是否可用以当前验收记录为准。未配置 sbx 不妨碍启动桌面；sandbox 对话/终端会明确不可用。

- macOS Apple Silicon。其他平台没有验证。
- Node：与 Electron 44.5.1 内置的 Node 24 对齐，`.nvmrc` 为 24。2026-10-06 的本地验证实际运行在 Node 26.5.0 上，Node 24 尚未单独验证。
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

`pnpm check` 依次运行类型检查（含 e2e 与配置文件）、ESLint、Prettier 格式检查和 Vitest 单元测试。

```bash
pnpm test:e2e
```

`pnpm test:e2e` 先 `pnpm build`，再用 Playwright 驱动真实的 Electron 窗口，检查启动与安全边界、页面现场、任务与运行归属、空间和标签切换、草稿、左右气泡、快捷键、主题及窄窗恢复。截图写到 `test-results/screens/`。

## 沙箱对话与终端

先按[依赖说明](docs/development/dependencies.md)准备 sbx、宿主 OAuth 和 guest Codex/Node。启动时用 `WSL_SBX_NAME` 选择已有沙箱，历史测试使用 `wsl-sbx-smoke-20261006`；`WSL_SBX_BIN` 可指定 CLI 路径。SR-1 重制阶段没有调用真实模型；本次整合已获 live 验证授权，执行结果单独记录在当前验收中。应用从 PATH、`/opt/homebrew/bin/sbx`、`/usr/local/bin/sbx` 定位 sbx，配置不成功时明确禁用发送。生产通路不再使用 `WSL_CODEX_BIN` 或 host Codex。

首页个人对话和会话页支持 Enter 发送、Shift+Enter 换行、取消和开始新对话。空间会话标签分别保存草稿、任务版本与运行，进入新会话使用空间的新建会话入口。界面显示 sandbox 与 guest cwd，运行详情可查看工具结果及警告。Codex 可以使用 guest 工具读写 `/home/agent/workspace`；对话历史分开，但文件系统与终端共享。新对话不会删除 guest 文件，也不承诺删除 CLI 历史。

空间垂直标签中的“开发终端”提供显式连接入口，打开交互shell，支持持续 cwd/环境、Ctrl-C、窗口尺寸变化与关闭。切换标签保留 shell；关闭终端或取消对话须确认所属远端进程退出。应用不会停止整个 sandbox，sandbox 内安装与文件由 sbx 保留。Browser 可加载演示页面和受控公开 HTTPS 只读文档，尚未转发 guest 服务端口。

普通 `pnpm test:e2e` 使用缺失配置或确定性 sbx fixture，不调用真实模型。显式真实检查需要本机已准备好的 sandbox、有效 OAuth、网络和原生窗口权限：

```bash
pnpm build
WSL_LIVE_SBX=1 WSL_SBX_NAME=wsl-sbx-smoke-20261006 pnpm exec playwright test e2e/sbx.spec.ts --grep 'live'
```

固定范围见 [sbx 应用 SPEC](docs/verification/2026-10-06-sbx-app/SPEC.md)，执行结果见[验证记录](docs/verification/2026-10-06-sbx-app/README.md)。原来的 [host 对话记录](docs/verification/2026-10-06-codex-chat/README.md)保留为历史证据。

## 公开网页与空间快照

公开文档沿用既有只读路径：在地址栏输入公开 HTTPS URL，成功加载后点击“加入空间”。资源页可查看 URL、标题、正文、资源身份、版本与摘要，并用当前同 URL 页面更新或移除。外部脚本、子资源和登录状态不进入该文档视图；不支持的响应会明确失败。

此既有公开快照合同仅服务 `taskflow-demo` 的对应空间会话，其他空间和个人会话没有该资源范围；不能据此宣称任意空间已获得公开快照权限。资源更新或删除后下一轮读取新集合，历史消息保留。本次统一观察使用独立的 Main 资源绑定，不扩展旧公开快照合同。该功能不创建 host mount，不改变已有沙箱认证。真实网络与模型结果、DNS 阻塞和受控 fixture 必须分别判断，见[公开快照合同](docs/verification/2026-10-06-public-resources/SPEC.md)。

普通测试默认不调用模型。以下分别是实际 Codex 读取明确标识的内存测试资料，以及真实公网到 UI 空间再到模型的链路；需显式运行并保留实际结果，不能相互替代：

```bash
WSL_LIVE_RESOURCE_AGENT=1 WSL_SBX_NAME=wsl-sbx-smoke-20261006 pnpm exec vitest run apps/service/src/resource-agent.live.test.ts
pnpm build
WSL_LIVE_RESOURCE=1 WSL_SBX_NAME=wsl-sbx-smoke-20261006 pnpm exec playwright test e2e/resources-live.spec.ts
```

## 打包

```bash
pnpm package
```

生成 macOS Apple Silicon 试用包，输出到 `apps/desktop/release/`（`.dmg`、`.zip` 与 `mac-arm64/Web Studio Lab.app`）。打包后可以对包内应用重跑同一套检查：

```bash
pnpm test:e2e:packaged
```

试用包**没有签名，也没有公证**（只有链接器生成的 ad-hoc 签名，Gatekeeper 评估不通过）。从其他机器下载后，macOS 会拦截打开，可以在 Finder 中右键选择“打开”，或者去掉隔离属性：

```bash
xattr -dr com.apple.quarantine "/Applications/Web Studio Lab.app"
```

## 目录

| 路径                 | 内容                                                                                                |
| -------------------- | --------------------------------------------------------------------------------------------------- |
| `apps/desktop`       | Electron：`src/main`（窗口、IPC、Browser 区控制）、`src/preload`（窄 API）、`src/renderer`（React） |
| `apps/service`       | 独立Node对话、资源和PTY服务；Main工作台协调空间任务                                                 |
| `packages/protocol`  | Zod schema：页面现场、任务版本、run / attempt / 审阅、IPC 通道                                      |
| `demo/`              | 演示页面，只供 Browser 区演示加载，与真实运行数据分开                                               |
| `e2e/`               | Playwright 驱动 Electron 的端到端检查                                                               |
| `docs/plans/`        | 比赛任务计划                                                                                        |
| `docs/verification/` | 验证记录与截图                                                                                      |

安全基线：工作台与 Browser 区都启用 `contextIsolation`、`sandbox`，关闭 `nodeIntegration`；Browser 区没有 preload，使用独立 session；IPC 在主进程用 Zod 校验参数，并只接受主窗口顶层工作台页面的请求。详见[当前运行时](docs/architecture/current-runtime.md)的Electron安全基线。

## 架构与固定验收入口

[Agent 入口](AGENTS.md)、[架构基线](docs/ARCHITECTURE.md)与[开发规范](CONTRIBUTING.md)说明职责和协作要求；[当前运行时](docs/architecture/current-runtime.md)区分真实实现、目标约束与缺口。目标架构的取舍见 [ADR-0001](docs/architecture/adr/0001-modular-monolith.md)。

main 的 [VS001 固定验收基线](docs/acceptance/README.md)、`tests/vertical-slice`、固定 fixture 和实现前失败证据全部保留，包括 PR1 的观察值拒绝和源码类型检查修复。验收基准已有，不代表产品 adapter 或比赛闭环已完成；真实模型调用须另行明确启用。整合后的运行入口以本树 `package.json` 为准。

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
