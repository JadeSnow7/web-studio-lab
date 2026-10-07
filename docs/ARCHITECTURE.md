# Web Studio Lab 架构约束（草案）

> 状态：2026-10-05 起草，2026-10-06 按新版任务计划修订。本文定义比赛版（OSCHINA 开源大赛 2026）的进程边界、依赖方向、运行与证据约定。范围、排期与验收以[任务计划](plans/2026-10-os2026-task-plan.md)为准；本文只约束“怎么搭”，不重复“做什么、何时做”。
>
> 相对任务计划初稿的调整：
>
> 1. **直接使用 Electron 承载工作台**（2026-10-05），而不是独立浏览器页面加单独启动的 Chromium。
> 2. **代码放在本仓库根目录**（2026-10-05），不再嵌套 `competition/`；所有命令从仓库根目录执行。
> 3. **取消独立的 Hono / WebSocket 工作台服务**（2026-10-06）。桌面与独立 Node 执行服务通过限定 IPC 通信；Hono 只用于生成 App 的 API。
> 4. **主 harness 确定为 Codex CLI**（2026-10-06），非交互调用加薄 adapter，单 Agent。实际 CLI 版本、模型与参数组合待 T02 实测后冻结。
> 5. **macOS Apple Silicon 试用包属于 P0**（2026-10-06），交互终端原列 P1；2026-10-06 按用户明确要求接入最小 sbx 终端切片，采用 xterm.js + guest PTY。
>
> 当前实现状态：`apps/desktop` 有第一版界面，Browser 区加载演示页面；Codex 对话与交互终端已通过独立服务接入 sbx；本轮运行验收见 [sbx 应用验证](verification/2026-10-06-sbx-app/README.md)。任务执行编排、母模板与固定验收尚未实现。

## 1. 目标与边界

比赛版要完成的闭环：开发者在 Browser 区点选页面元素并确认任务，由 Codex CLI 在唯一母模板的生成副本上修改代码，执行服务启动 App 并运行固定验收，输出可复验的证据，最后由开发者决定是否接受。三个固定用例（C1 持久化字段、C2 权限规则、C3 字段契约）见任务计划第 6 节。

设计原则：

- **执行核心不依赖 Electron。** 运行编排、验收与证据都放在可独立运行的 Node 执行服务里。`pnpm verify`、`pnpm revalidate` 和 CI 都不启动 Electron；Electron 是外壳、Browser 区页面容器和同页控制的宿主。
- **只建三个用例所需的边界。** 不做通用运行时、多 Agent 编排、通用沙箱、插件系统。排除项以任务计划第 2.4 节为准。
- **证据真实优先于功能完整。** 任何设计都不能让“看起来通过”替代“实际运行并验收通过”。演示数据必须带演示标识，与真实运行记录分开。

## 2. 进程结构

```text
Electron main process
├── BrowserWindow ── 工作台 renderer（React + Vite）
│                    └── preload：仅暴露窄 API（见 4.2）
├── WebContentsView ── Browser 区页面（独立 session，无 preload）
│                      └── main 通过 webContents.debugger（CDP）点选、截图，后续读取 / 点击 / 输入
└── 执行服务（独立 Node 进程，utilityProcess.fork）  ←── 限定 IPC（消息通道，Zod 校验）
      ├── Codex CLI adapter ──> codex 子进程（cwd = 生成工作空间）
      ├── app runner ─────────> 生成 App：API（Hono + PGlite）+ 前端 dev server
      ├── acceptance runner ──> Playwright + Chromium（全新 browser context）
      └── evidence writer ───> .local/runs/<runId>/

CLI（pnpm demo:run / verify / revalidate / replay）
└── 直接调用同一执行服务核心，无 Electron
```

区域对应：**Workshop** 是左侧导航与工作面板（现场、任务确认、运行阶段、attempt 与审阅）；**Browser** 是 WebContentsView 承载的实际页面，与日志、diff、验收报告共用一条顶部标签栏。右侧是通信栏（空间会话 / 联系人 / 动态）。

renderer 不直接连接执行服务。renderer → preload → main → 执行服务，每一跳都按 `packages/protocol` 的 schema 校验。执行服务不监听网络端口。

## 3. 目录与依赖方向

```text
apps/
  desktop/        Electron：src/main、src/preload、src/renderer
  service/        执行服务：run 编排、Codex adapter、进程与证据管理、CLI 入口（待实现）
packages/
  protocol/       Zod schema：页面现场、任务版本、run / attempt / 审阅、IPC 通道
demo/             演示页面与说明，只用于界面演示
templates/
  task-app/       唯一母模板（独立项目，自带锁文件，不加入根 workspace）（待实现）
fixtures/
  c1-*/ c2-*/ c3-*/   各用例初始代码覆盖 / 补丁、数据 seed、用户意图（待实现）
acceptance/
  c1/ c2/ c3/ shared/ 固定验收（Playwright + API 检查）（待实现）
docs/
.local/           运行时数据，不提交：workspaces/<workspaceId>/、runs/<runId>/
```

允许的依赖方向（箭头表示“可以 import”）：

| 模块                    | 可以依赖                                                            | 禁止依赖                                |
| ----------------------- | ------------------------------------------------------------------- | --------------------------------------- |
| `packages/protocol`     | `zod`                                                               | Node、DOM、Electron API；任何其他内部包 |
| `apps/service`          | `protocol`、Node 库、Playwright                                     | `electron`、`apps/desktop`              |
| `apps/desktop` main     | `protocol`、`electron`、Node 库                                     | `apps/service` 源码（只启动其构建产物） |
| `apps/desktop` preload  | `electron`（`contextBridge`、`ipcRenderer`）、`protocol` 的通道常量 | 业务逻辑、Node 文件 / 进程 API          |
| `apps/desktop` renderer | `protocol`、React                                                   | `electron`、Node API                    |
| `acceptance/`           | Playwright、HTTP 客户端                                             | 母模板源码、`apps/*` 内部实现           |
| `templates/task-app`    | 自身依赖                                                            | 本仓库任何内部包                        |

renderer 的禁止项由 ESLint `no-restricted-imports` 检查（见 `eslint.config.js`），renderer 的 tsconfig 不包含 Node 类型。

母模板与验收都不 import 内部包，原因如下：

- **母模板**：生成工作空间要能脱离本仓库，单独安装、运行和交付（任务计划第 7.1 节要求最终源码快照可独立复验）。
- **验收**：只通过 App 的公开 HTTP / UI 契约验证结果，不受 Agent 修改的实现细节影响。

## 4. Electron 安全基线

Browser 区加载的是 Agent 修改过的代码，因此按不可信内容处理。

### 4.1 窗口与视图配置

| 配置                   | 工作台 renderer  | Browser 区视图                                                                                                                                     |
| ---------------------- | ---------------- | -------------------------------------------------------------------------------------------------------------------------------------------------- |
| `contextIsolation`     | `true`           | `true`                                                                                                                                             |
| `sandbox`              | `true`           | `true`                                                                                                                                             |
| `nodeIntegration`      | `false`          | `false`                                                                                                                                            |
| `webSecurity`          | `true`           | `true`                                                                                                                                             |
| preload                | 仅工作台 preload | **无**                                                                                                                                             |
| session                | 默认 session     | 独立分区，与工作台隔离。真实运行用 `persist:preview-<workspaceId>`；当前演示用内存分区 `preview-demo`                                              |
| 权限请求               | 默认拒绝         | 默认全部拒绝                                                                                                                                       |
| `window.open` / 新窗口 | 拒绝             | 拒绝                                                                                                                                               |
| 导航                   | 只允许本应用页面 | 只允许当前 run 的预览源（`127.0.0.1` / `localhost` 的指定端口）；当前演示允许 `wsl-demo://taskflow`；用户授权的公开 HTTPS 采用下述只读文档代理路径 |

其他要求：

- 工作台 renderer 设置 CSP：`default-src 'self'`，只放行本应用资源与 `data:` 截图。
- 不使用 `remote` 模块，不关闭 `webSecurity`，不启用 `allowRunningInsecureContent`。
- 生产加载使用本地文件；开发时才加载 Vite dev server。
- 演示页面通过只注册在 Browser 区 session 上的自定义协议提供，只读取 `demo/` 目录内的文件。

### 4.2 preload 与 IPC

preload 只暴露以下几类能力，请求一律使用 `ipcRenderer.invoke`，事件订阅返回取消函数，不直接暴露 `ipcRenderer`：

- Browser 区：设置布局与可见性、导航、刷新、前进后退、开始 / 取消点选、重新附着 CDP、读取状态。
- 应用信息与执行服务状态（只读）。
- 普通对话：查询 CLI 状态、读取/发送/取消/重置个人或空间会话，订阅会话快照与不可用状态。
- 菜单命令事件（例如 ⌘B 切换 Workshop）。
- 以后：`revealArtifact(path)`，只允许打开 `.local/runs/` 内的路径。

main process 对每个 IPC 请求做两项检查：

- 用 `protocol` 中的 Zod schema 校验参数，校验失败直接抛错，不做兜底。
- 检查 `event.sender` 是主窗口的 webContents，且 `event.senderFrame` 是顶层工作台页面；Browser 区视图发来的 IPC 一律拒绝。

新增 IPC 通道必须先在 `protocol` 中定义 schema。

### 4.3 页面现场与同页控制

- 点选、截图和以后的读取 / 点击 / 输入都通过同一个 Browser 区 `webContents` 的 CDP 完成，现场记录 `webContents` 身份、文档代次、URL、采集时间。
- 页面导航（包括同文档导航）后，文档代次加一，旧现场标记失效，确认任务前必须重新采集。
- 人工打开 DevTools 等原因导致 CDP 断开时，界面显示原因，暂停页面自动操作；重新附着后重新采集现场。
- 被浮层遮挡时，主进程隐藏原生视图，renderer 显示同一页面的静态快照，不让原生视图盖住浮层。

## 5. 服务接口

### sbx 对话与终端（2026-10-06 接入）

`apps/service` 独立构建为 Node 产物，main 通过 `utilityProcess.fork` 启动，核心不依赖 Electron。跨进程契约统一定义在 `packages/protocol`；renderer 仅持有快照投影，不能选择宿主任意命令。`WSL_SBX_NAME` 选择已存在的 mountless Codex sandbox，`WSL_SBX_BIN` 可指定 sbx CLI；未配置、目标不符或连接失败直接报告不可用。

`SbxConnection` 负责定位 sbx、核验目标身份/挂载、读取 guest Codex 版本；`GuestProcess` 负责传输和退出回执。实际 Codex 与 shell 都在 `/home/agent/workspace` 内运行。认证保留模板的 provider 与代理配置，不读取或复制 host 凭据。应用不创建、删除或停止整个 sandbox；组件准备见[依赖说明](development/dependencies.md)。

每次进程调用通过 `sbx exec -i` 启动内置 Python 标准库 helper。helper 在 guest 内管理所属进程、PTY 与清理；stdin 控制帧和模型 prompt 分开，stdout 使用明确帧封装。终端使用 xterm.js 与 fit addon 展示 guest PTY，不依赖 Electron native node-pty ABI。输入、尺寸和会话身份在 IPC 边界校验；隐藏终端保留同一 shell，关闭时等待远端清理确认。

Codex 首轮使用 `exec --json`，续轮显式 `exec resume <threadId>`，采用 `workspace-write` 并启用 guest 工具。消息历史按应用会话隔离，但各会话和终端共享 guest 文件系统；开始新对话不删除文件。服务拥有 generation、threadId、turnId 与序号，保留有界工具结果和非致命警告，截断结果明确标示。成功要求助手文本、会话身份、完成事件、正常退出和远端清理确认。

每会话最多一个活动回复。取消、重置、终端关闭和窗口退出均等待已登记 guest 进程清理；宿主 sbx 进程退出不等于远端清理成功。缺少回执时显示失败并保留占用，不能把未知状态伪装成可重新开始。应用内消息与终端投影只在本次启动保存，CLI 自身会话和 guest 文件仍由 CLI/sandbox 管理。

连接检查不调用模型；普通测试使用确定性 sbx fixture，真实模型和真实 guest 生命周期须显式启用。该接入不等于下述任务 run 编排或固定验收完成。

### 公开网页与空间资源（2026-10-06 授权实现）

公开页面使用单独的 HTTPS 获取与只读文档路径：main 对全部 DNS 地址和每次跳转校验公网范围，连接固定到已验证 IP，保留 TLS 证书校验。解析响应后仅把转义后的标题和正文放入固定模板；原站脚本、属性、样式、Cookie、网络提示和子资源不会进入 Browser。界面明确标注只读文档，真实页面快照含原始字节和正文散列，不宣称原站布局或动态交互。

用户主动加入的公开文档由服务保存在固定空间资源文件中。renderer 只传空间和预览页面身份；main 捕获已显示的同一代文档，服务验证快照并提供幂等新增、版本更新与删除。当前只对已有 TaskFlow 空间开放 IPC；接口权威在 `packages/protocol/src/resources.ts`。

空间会话开始时，服务按固定 conversationId→spaceId 映射冻结有界资源包；个人会话是空包。guest helper 把资源包放入 sealed memfd，单次 Codex 调用加载有限 stdio MCP：仅枚举与按资源身份/版本读取。没有 host mount、Docker socket、新凭据或持久 MCP 配置。资源内容为非可信数据；资源包不赋予写权限。活动回复期间禁止变更，变更后切断旧 CLI thread，下一轮获得新资源包。共享 guest 的既有同 UID 文件系统不提供 OS 级空间保密，已进入历史的内容也无法撤回。

实现和验收边界见 [公开资源合同](verification/2026-10-06-public-resources/SPEC.md)。完成状态只能依据该轮实测证据，MCP 客户端通过不能代替真实模型工具调用。

### 任务执行（待 T04 实现）

- **进程**：main 用 `utilityProcess.fork` 启动服务，备选 `child_process.fork`。服务不监听网络端口。
- **通信**：消息通道上的请求 / 响应与有序运行事件。所有消息的 schema 在 `packages/protocol` 中定义，两端都校验。
- **接口划分**：创建 run（携带已确认的任务版本）、取消 run、查询 run / manifest、列出证据；运行事件按 `seq` 推送，renderer 断开后可以从 `seq` 续读。
- **并发**：每个工作空间同时只允许一个活动 run，重复创建返回明确错误。
- **CLI**：CLI 入口直接调用服务核心模块，结果与通过桌面调用一致。

在服务接入之前，main 只报告“执行服务未接入”的状态，renderer 据此禁用真实执行按钮并说明原因，不返回伪造的运行结果。

## 6. Run 生命周期与进程管理

### 6.1 状态

```text
queued → preparing → attempt(n): agent → app_starting → app_ready → accepting
                                                              ├─ 通过 → passed（待开发者审阅）
                                                              ├─ 失败且未超预算 → attempt(n+1)，附带失败证据
                                                              └─ 失败且预算用尽 → failed
任意非终态 → cancelled | timed_out
工具故障（无法得到验收结论）→ inconclusive
```

终态为 `passed`、`failed`、`inconclusive`、`timed_out`、`cancelled`。基础设施错误（安装失败、端口冲突、CDP 断开等）导致无法得出验收结论时记为 `inconclusive` 并带 `reason`，**不能记成业务验收失败**。预算默认每个 run 最多 3 次 attempt、总时限 15 分钟，随 run 一起记录。

run、attempt 与开发者审阅是三件事：run 通过只说明固定验收通过；开发者“接受结果”是独立的审阅记录，绑定任务版本与源码快照；“要求修改”产生新的任务版本，不改写旧 run。

### 6.2 进程归属与清理

- run 启动的每个子进程（Codex、App API、前端 dev server、验收）都登记在该 run 的进程组下。POSIX 上使用 `detached: true` 新建进程组，清理时向整个组发信号。
- 取消或超时时先发 `SIGTERM`，等待一段宽限期后发 `SIGKILL`，**并等待进程真正退出**，再进入终态。界面不再有输出不代表进程已清理。
- 端口由服务分配并记录在 run 中，终态后释放。只清理属于该 run 的进程和端口，不按名字或端口号批量结束进程。
- Electron 退出时，先让服务取消所有活动 run 并等待清理完成。

### 6.3 Electron 与服务的关系

- 服务崩溃时 main 在工作台中显示错误，不静默重启后假装 run 仍在进行。
- CLI 与 CI 用系统 Node 运行同一服务核心。系统 Node 的主版本与 Electron 内置 Node 的主版本保持一致（Electron 44.5.1 内置 Node 24）。

## 7. 事件、manifest 与证据

字段定义以任务计划第 7.1 节为准，这里约束实现方式。

- **事件流**：每个 run 一个只追加的 `events.jsonl`。
  - 事件信封为 `{ runId, attemptId?, seq, timestamp, type, payload }`；`seq` 在 run 内严格递增，由服务单点分配。
  - 最小事件类型：任务确认、现场采集 / 失效、`run.started`、`attempt.started`、`agent.event`、`files.changed`、`command.started`、`command.finished`、`app.ready`、CDP 暂停 / 重新附着、`acceptance.result`、`artifact.added`、`run.finished`。
  - Codex 的原始 JSONL 事件放在 `agent.event.payload.raw` 中保留。无法解析的事件照样记录，不能丢弃，也不能把解析失败记成成功。
- **manifest**：每个 run 一个 `manifest.json`，内容包括：
  - `mode`（`online` / `revalidate` / `replay`）、用例、工作空间、`taskVersion`；
  - `sourceState`（基线 commit 加 diff 或内容哈希，不能只记录 HEAD）、`fixtureVersion`、运行前后的 `acceptanceHash`；
  - harness 与模型的名称和版本、预算、各 attempt 摘要、终态与原因；
  - 页面现场引用（URL、`webContents` 身份、采集时间）；
  - artifact 的**相对路径**列表。
- **artifact**：命令日志、App 日志、截图、Playwright trace 和验收报告都写在 `.local/runs/<runId>/` 下。证据包可以整体搬走，不引用开发机上的绝对路径。
- **只追加**：已写入的事件和失败记录不改写、不删除。复验产生新的 run（`mode: revalidate`）；历史查看只读取，界面必须标明“历史记录”。

## 8. 工作空间、模板、fixture 与验收隔离

- **生成工作空间**：每个工作空间在 `.local/workspaces/<workspaceId>/` 下，由「母模板 + 用例 fixture」展开得到。Codex 的 `cwd` 和允许写入的范围限定在这个目录。
- **固定验收**：`acceptance/` 和原始 `fixtures/` 不在 Agent 写入范围内。每次 run 前后都计算 `acceptance/` 的哈希，不一致时直接判为失败。
- **独立安装**：母模板是独立项目，带自己的 `pnpm-lock.yaml`，生成工作空间单独安装。这样导出的最终源码快照包含锁文件和迁移，可以脱离本仓库复验。
- **故意出错的 fixture**：C3 这类 fixture 只在生成副本中展开，不进入根 workspace 的类型检查和默认 CI。
- **验收判定**：验收必须能区分两种情况：“初始状态下预期失败”，以及“修复后仍然失败”。
- **防止放宽验收**：禁止通过修改验收、放宽 schema 或预先写入期望数据让用例通过。这类改动即使出现在 Agent 的 diff 里，也必须判为失败。

## 9. 数据与浏览器生命周期

### 9.1 数据库

- PGlite 由生成 App 的 API 进程持有，每个工作空间使用独立的持久化目录，验收数据和演示数据分开存放。
- API 运行期间，其他进程不能打开同一个数据库目录。核对数据优先走 API；确实需要直接执行 SQL 时，先停掉 API。
- “持久化”验收必须包括停止并重启 API 进程。重启前不能重新 seed，也不能写入期望值。

### 9.2 浏览器

预览和固定验收使用两条不同的浏览器路径：

| 用途                            | 浏览器                                     | 说明                                                                                    |
| ------------------------------- | ------------------------------------------ | --------------------------------------------------------------------------------------- |
| 用户观察、点选与 Agent 同页操作 | Electron Browser 区 WebContentsView        | 用户看到的就是被操作的页面。证据中记录 URL、session 分区、`webContents` 身份和 App 实例 |
| 固定验收 / 无模型复验           | Playwright 自带 Chromium，使用全新 context | 不依赖 Electron，可以在 CI 中 headless 运行。身份和初始数据显式准备                     |

两者的结果分开标注。iframe 或另一个 Chromium 访问同一个 URL，不能证明共享了同一份登录或存储状态。

## 10. 凭据与日志

- 模型凭据由用户按 Codex CLI 的方式自行配置，只传给 Codex 子进程，不写入 manifest、事件、日志、截图或仓库，也不经过 renderer。
- 写入证据前，对命令行参数和环境变量摘要做脱敏处理。
- `.env*`、`.local/`、构建产物与测试输出已被 `.gitignore` 忽略。
- A/B 身份来自受控的测试会话，服务端根据可信会话判断当前用户，不信任客户端传来的用户 ID。

## 11. 不在 P0 范围的 Electron 能力

签名与公证、自动更新、多窗口、托盘、终端多会话与恢复、暗黑与暖色主题。

macOS Apple Silicon 未签名试用包属于 P0（`pnpm package`），打包后必须在包内重复页面加载、点选与执行通路检查。

### 降级路径

如果 Electron 外壳或同页控制阻塞 C1 闭环，按任务计划第 9 节集中修复集成、压缩界面与可选功能，并记录排期影响。执行服务核心、协议、验收和证据不受影响。

## 12. 待验证的决策

| 决策                            | 当前结论 / 候选                                                                          | 在哪一步验证 |
| ------------------------------- | ---------------------------------------------------------------------------------------- | ------------ |
| Electron 构建工具               | electron-vite 5（配 Vite 7），第一版界面已采用                                           | T14          |
| Node / pnpm / Electron 版本组合 | Electron 44.5.1（Node 24.21、Chromium 152）；pnpm 10.34.6；系统 Node 主版本应为 24       | T14          |
| 打包工具                        | electron-builder，mac arm64，未签名                                                      | T14          |
| 执行服务宿主                    | `utilityProcess.fork`；备选 `child_process.fork`                                         | T04          |
| harness 与模型                  | 已确定 Codex CLI；有效版本、模型与参数待实测                                             | T02          |
| 同页控制通道                    | main 通过 `webContents.debugger` 发送 CDP 命令；点选与截图已采用，读取 / 点击 / 输入待接 | T14          |
| fixture 表示方式                | 模板之上的文件覆盖或补丁，加上 seed 数据                                                 | T03          |

每项决策验证后，把结论写回本节和任务计划决策表。

## 2026-10-07 guest 浏览器验收扩展

用户明确批准隔离工作树中的最小 headless guest 浏览器桥接，合同见 [guest 浏览器验收](verification/2026-10-07-sandbox-browser/SPEC.md)。该切片将浏览器与 CDP 控制放入既有 sandbox，宿主仅接收有界产物并复用资源存储。现有 Electron 预览路径及其安全合同保留；本轮不声称完整产品迁移或模型验证已完成。
