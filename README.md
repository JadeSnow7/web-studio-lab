# Web Studio Lab

Web Studio Lab 是基于 [Web Studio](https://github.com/JadeSnow7/Web-Studio) 既有设计与工程经验构建的 Electron 桌面工作台，参加 [OSCHINA 开源大赛 2026](https://www.oschina.net/os2026/)。目标闭环：在运行页面上点选元素、确认任务，由 Codex CLI 修改代码，工作台启动 App 并执行固定验收，给出可复验的证据，最后由开发者决定是否接受结果。

范围、排期与验收以[任务计划](docs/plans/2026-10-os2026-task-plan.md)为准，实现约束见[架构文档](docs/ARCHITECTURE.md)。

## 当前状态

已有第一版可启动、可构建、可打包的 Electron 界面（`apps/desktop`）。**已接入 sbx 内的 Codex 对话与交互终端；任务执行编排、母模板、三个用例的 fixture 与固定验收尚未实现**，所以本版本不会启动任何真实 run。

| 能力                                                                                                         | 状态                                                           |
| ------------------------------------------------------------------------------------------------------------ | -------------------------------------------------------------- |
| 全局壳：极简白主题、原生红绿灯、紧凑顶栏、Workshop / Browser / 右侧通信栏                                    | 已实现                                                         |
| 六个入口：首页、空间、资源、会话、任务、设置                                                                 | 已实现；资源页接入当前空间快照，联系人与动态仍为标注的演示数据 |
| Workshop 隐藏（⌘B）、左边缘悬停或把手临时展开、图钉固定                                                      | 已实现                                                         |
| 右栏展开 / 收起（⌥⌘B）；窗口较窄时改为覆盖层                                                                 | 已实现                                                         |
| Browser 区：`WebContentsView` 加载本地演示页面，地址、前进后退、刷新、resize 与焦点                          | 已实现；演示页面与受控公开 HTTPS 只读文档                      |
| 点选现场：选择模式 → 点击元素 → 元素摘要、URL、元素与页面截图、页面身份、页面错误                            | 已实现；通过同一 `webContents` 的 CDP 完成                     |
| 导航后旧现场失效、需要重新采集                                                                               | 已实现                                                         |
| 任务确认：用例 C1/C2/C3 预填、目标、允许项目、验收、预算（默认 3 次 attempt、15 分钟），确认后生成不可变版本 | 已实现；版本只保存在本次启动的内存中                           |
| 运行、取消、失败、无法判断、超时、待审阅、接受、要求修改、历史查看、无模型复验                               | 只有界面状态：用写死的演示记录检查，带“演示数据”标识           |
| 真实任务执行（改码、固定验收、证据落盘、无模型复验）                                                         | 未实现（T02、T03、T04、T09）                                   |
| 交互终端（xterm.js + sbx 内 Linux PTY）                                                                      | 已接入；与 Codex 共享 guest 工作目录，本轮验收见下文           |
| 暗黑 / 暖色主题、拖拽平铺、多 Tab、人际消息、资源授权、定时调度                                              | 不在本轮范围                                                   |

## 环境

详细安装与独立 sbx 沙箱测试前置条件见[开发依赖与安装](docs/development/dependencies.md)。sbx v0.47.0 已安装，Docker/OpenAI OAuth 已完成，独立沙箱内 Codex 读取内部文件的真实 smoke 已通过，见[沙箱验证记录](docs/verification/2026-10-06-sbx/README.md)。桌面对话与终端现已接入同一个 sbx 环境，应用层测试见 [sbx 接入验证](docs/verification/2026-10-06-sbx-app/README.md)。

- macOS Apple Silicon。其他平台没有验证。
- Node：与 Electron 44.5.1 内置的 Node 24 对齐，`.nvmrc` 为 24。2026-10-06 的本地验证实际运行在 Node 26.5.0 上，Node 24 尚未单独验证。
- pnpm 10.34.6（见根 `package.json` 的 `packageManager`）。Node 25 起不再自带 Corepack，可以 `npm install -g pnpm@10.34.6`，或者在下面的命令前加 `npx pnpm@10.34.6` 代替 `pnpm`。
- 首次运行 Electron 时会下载 Electron 二进制（约 100 MB）；首次打包时 electron-builder 还会下载自己的 Electron 包与 dmg 工具。需要网络。

## 启动与检查

所有命令都从仓库根目录执行。

```bash
pnpm install --frozen-lockfile
```

```bash
WSL_SBX_NAME=wsl-sbx-smoke-20261006 pnpm dev
```

`pnpm dev` 启动 Vite dev server 和 Electron 工作台。启动后 Browser 区加载演示页面 `wsl-demo://taskflow/index.html`，可以按“选择元素”→ 点击页面元素 → 确认任务的顺序操作。

```bash
pnpm check
```

`pnpm check` 依次运行类型检查（含 e2e 与配置文件）、ESLint、Prettier 格式检查和 Vitest 单元测试。

```bash
pnpm test:e2e
```

`pnpm test:e2e` 先 `pnpm build`，再用 Playwright 驱动真实的 Electron 窗口，检查启动与安全边界、点选采集、任务确认、导航失效、选择模式退出、Tab、演示状态与审阅、草稿路由、Workshop、菜单快捷键和窄窗口。截图写到 `test-results/screens/`。

## 沙箱对话与终端

先按[依赖说明](docs/development/dependencies.md)准备 sbx、宿主 OAuth 和 guest Codex/Node。启动时用 `WSL_SBX_NAME` 选择已有沙箱，本机本轮使用 `wsl-sbx-smoke-20261006`；`WSL_SBX_BIN` 可指定 CLI 路径。应用从 PATH、`/opt/homebrew/bin/sbx`、`/usr/local/bin/sbx` 定位 sbx，配置不成功时明确禁用发送。生产通路不再使用 `WSL_CODEX_BIN` 或 host Codex。

首页个人对话、会话页和空间右栏保留原交互：Enter 发送，Shift+Enter 换行，可以取消和开始新对话。界面显示 sandbox 与 guest cwd，工程详情可查看工具结果及警告。Codex 可以使用 guest 工具读写 `/home/agent/workspace`；对话历史分开，但文件系统与终端共享。新对话不会删除 guest 文件，也不承诺删除 CLI 历史。

空间标签栏的“终端”打开交互 shell，支持持续 cwd/环境、Ctrl-C、窗口尺寸变化与关闭。切换标签保留 shell；关闭终端或取消对话须确认所属远端进程退出。应用不会停止整个 sandbox，sandbox 内安装与文件由 sbx 保留。Browser 可加载演示页面和受控公开 HTTPS 只读文档，尚未转发 guest 服务端口。

普通 `pnpm test:e2e` 使用缺失配置或确定性 sbx fixture，不调用真实模型。显式真实检查需要本机已准备好的 sandbox、有效 OAuth、网络和原生窗口权限：

```bash
pnpm build
WSL_LIVE_SBX=1 WSL_SBX_NAME=wsl-sbx-smoke-20261006 pnpm exec playwright test e2e/sbx.spec.ts --grep 'live'
```

固定范围见 [sbx 应用 SPEC](docs/verification/2026-10-06-sbx-app/SPEC.md)，执行结果见[验证记录](docs/verification/2026-10-06-sbx-app/README.md)。原来的 [host 对话记录](docs/verification/2026-10-06-codex-chat/README.md)保留为历史证据。

## 公开网页与空间快照

本轮按用户授权新增只读公开文档路径：在地址栏输入公开 HTTPS URL，成功加载后点击“加入空间”。资源页可查看 URL、标题、正文、资源身份、版本与摘要，并用当前同 URL 页面更新或移除。外部脚本、子资源和登录状态不进入该文档视图；不支持的响应会明确失败。

空间会话通过有限只读 MCP 获取用户保存的快照，个人会话是空资源范围。资源更新或删除后下一轮读取新集合；历史消息保留。该功能不创建 host mount，不改变已有沙箱认证。真实网络与模型结果、DNS 阻塞和受控 fixture 必须分别判断，见[本轮合同](docs/verification/2026-10-06-public-resources/SPEC.md)。

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
| `apps/service`       | 独立 Node Codex 对话核心与 utilityProcess 入口；任务执行尚未实现                                    |
| `packages/protocol`  | Zod schema：页面现场、任务版本、run / attempt / 审阅、IPC 通道                                      |
| `demo/`              | 演示页面，只供 Browser 区演示加载，与真实运行数据分开                                               |
| `e2e/`               | Playwright 驱动 Electron 的端到端检查                                                               |
| `docs/plans/`        | 比赛任务计划                                                                                        |
| `docs/verification/` | 验证记录与截图                                                                                      |

安全基线：工作台与 Browser 区都启用 `contextIsolation`、`sandbox`，关闭 `nodeIntegration`；Browser 区没有 preload，使用独立 session；IPC 在主进程用 Zod 校验参数，并只接受主窗口顶层工作台页面的请求。详见[架构文档](docs/ARCHITECTURE.md)第 4 节。

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
