# 当前运行时与目标架构的边界

本记录对应 2026-10-07 版本整合。产品来源为 checkpoint `8a7f9d9`；规范来源为 `0318a62`；main 基线为 `2466936`（包含 PR1 修复 `729bf58`）。目标职责、状态所有权和未来接口以 [架构基线](../ARCHITECTURE.md) 为准；本页说明已有实现，不宣称全面满足目标分层。

## 已有能力和缺口

- `apps/desktop/src/main`、`preload`、`renderer` 提供 Electron 壳、演示任务页面、页面现场采集、聊天和终端入口。
- `apps/service` 提供 sbx 会话、guest PTY、空间资源存储与只读 MCP；`guest-browser-bridge.ts` 与 `guest-browser.cjs` 是隔离浏览器采集切片，尚未完成生产 UI 挂载验证。
- `packages/protocol` 是跨进程 schema 来源；保留现有类型和调用，不为架构术语改名或引入第二套状态。
- `tests/vertical-slice`、`fixtures/vertical-slice/page` 与 [VS001](../acceptance/README.md) 保留 main 的固定验收与负例。`src/vertical-slice/adapter.ts` 尚不存在；基线自检通过不代表真实 Agent→应用→CDP 闭环通过。
- 母模板、C1–C3 固定验收、统一 TaskRun 编排、项目写入许可、重启恢复和结果审阅仍待实现。UI 演示状态不得视为任务执行结果。

## 现有契约与目标约束的协调

现有 `RunRecord`/`RunStatus` 保持兼容；目标架构区分执行、验证和审阅结果，后续接入时映射，不能以本次文档整合宣称 schema 已迁移。旧计划中的 `replay` 只读历史概念不再意味着启动新 run；已有历史证据保持原样。固定比赛验收和 VS001 属于不同范围，不能互相代替。

原产品合同的进程安全、公开资源和聊天边界继续适用，具体实现如下。任务编排的未来状态机以架构基线为约束，未实现的 CLI 入口不得报告为可用。

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

`SbxConnection` 负责定位 sbx、核验目标身份/挂载、读取 guest Codex 版本；`GuestProcess` 负责传输和退出回执。实际 Codex 与 shell 都在 `/home/agent/workspace` 内运行。认证保留模板的 provider 与代理配置，不读取或复制 host 凭据。应用不创建、删除或停止整个 sandbox；组件准备见[依赖说明](../development/dependencies.md)。

每次进程调用通过 `sbx exec -i` 启动内置 Python 标准库 helper。helper 在 guest 内管理所属进程、PTY 与清理；stdin 控制帧和模型 prompt 分开，stdout 使用明确帧封装。终端使用 xterm.js 与 fit addon 展示 guest PTY，不依赖 Electron native node-pty ABI。输入、尺寸和会话身份在 IPC 边界校验；隐藏终端保留同一 shell，关闭时等待远端清理确认。

Codex 首轮使用 `exec --json`，续轮显式 `exec resume <threadId>`，采用 `workspace-write` 并启用 guest 工具。消息历史按应用会话隔离，但各会话和终端共享 guest 文件系统；开始新对话不删除文件。服务拥有 generation、threadId、turnId 与序号，保留有界工具结果和非致命警告，截断结果明确标示。成功要求助手文本、会话身份、完成事件、正常退出和远端清理确认。

每会话最多一个活动回复。取消、重置、终端关闭和窗口退出均等待已登记 guest 进程清理；宿主 sbx 进程退出不等于远端清理成功。缺少回执时显示失败并保留占用，不能把未知状态伪装成可重新开始。应用内消息与终端投影只在本次启动保存，CLI 自身会话和 guest 文件仍由 CLI/sandbox 管理。

连接检查不调用模型；普通测试使用确定性 sbx fixture，真实模型和真实 guest 生命周期须显式启用。该接入不等于下述任务 run 编排或固定验收完成。

### 公开网页与空间资源（2026-10-06 授权实现）

公开页面使用单独的 HTTPS 获取与只读文档路径：main 对全部 DNS 地址和每次跳转校验公网范围，连接固定到已验证 IP，保留 TLS 证书校验。解析响应后仅把转义后的标题和正文放入固定模板；原站脚本、属性、样式、Cookie、网络提示和子资源不会进入 Browser。界面明确标注只读文档，真实页面快照含原始字节和正文散列，不宣称原站布局或动态交互。

用户主动加入的公开文档由服务保存在固定空间资源文件中。renderer 只传空间和预览页面身份；main 捕获已显示的同一代文档，服务验证快照并提供幂等新增、版本更新与删除。当前只对已有 TaskFlow 空间开放 IPC；接口权威在 `packages/protocol/src/resources.ts`。

空间会话开始时，服务按固定 conversationId→spaceId 映射冻结有界资源包；个人会话是空包。guest helper 把资源包放入 sealed memfd，单次 Codex 调用加载有限 stdio MCP：仅枚举与按资源身份/版本读取。没有 host mount、Docker socket、新凭据或持久 MCP 配置。资源内容为非可信数据；资源包不赋予写权限。活动回复期间禁止变更，变更后切断旧 CLI thread，下一轮获得新资源包。共享 guest 的既有同 UID 文件系统不提供 OS 级空间保密，已进入历史的内容也无法撤回。

实现和验收边界见 [公开资源合同](../verification/2026-10-06-public-resources/SPEC.md)。完成状态只能依据该轮实测证据，MCP 客户端通过不能代替真实模型工具调用。


## Guest 浏览器与验证边界

[Guest 浏览器合同](../verification/2026-10-07-sandbox-browser/SPEC.md)保留 Chromium sandbox、资源身份及同版本散列读取要求。历史 final-code-live-03 只证明当时版本的单次链路；本次整合只重新运行所列离线检查，不扩大为模型调用或生产 UI 验收。

系统 Node 要求见根 `.nvmrc` 和 `package.json`，产品计划期望主版本 24。本机本次实际使用 Node 26.5.0；构建通过不能替代 Node 24 和打包兼容验证。固定依赖版本保持两条来源的声明，不升级。
