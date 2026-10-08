# 当前运行时与目标架构的边界

本记录对应 2026-10-08 [空间页重制 SR-1](../acceptance/space-remake/SPEC.md)。当前工作树以 `2466936` 为HEAD，引入 `4ab5581` 旧布局后，按文件指纹移植 `eb15` 的空间工作台和后续R1–R7修复。来源指纹、阶段检查和当前完成边界见[本轮记录](../acceptance/space-remake/task-summary.md)。目标职责以[架构基线](../ARCHITECTURE.md)为准；历史通过结果不替代本轮实测。

## 已有能力和缺口

- `apps/desktop/src/main/workbench` 持有空间、标签、资源、窗格、会话、任务版本、运行、阅读回执及持久快照。Host将应用端口接到原生网页和服务；renderer只持有快照投影与展示状态。
- 全局保留首页、空间、资源、会话、任务和设置；空间页使用垂直标签与最多四窗格。左右栏是全局展示容器，固定偏好属于本设备，不属于空间业务。主题仍按空间保存，设置页是唯一编辑入口。
- `apps/service` 提供 sbx 会话、guest PTY、空间资源存储与只读 MCP；`guest-browser-bridge.ts` 与 `guest-browser.cjs` 是隔离浏览器采集切片，尚未完成生产 UI 挂载验证。
- `packages/protocol` 是跨进程schema来源；空间操作经workbench命令，旧空间/预览/运行/资源/终端renderer控制器随消费者迁移退役。个人会话仍使用窄chat接口。
- `tests/vertical-slice`、`fixtures/vertical-slice/page` 与 [VS001](../acceptance/README.md) 保留 main 的固定验收与负例。`src/vertical-slice/adapter.ts` 尚不存在；基线自检通过不代表真实 Agent→应用→CDP 闭环通过。
- 空间元数据、草稿、任务版本、历史运行与阅读回执可以恢复；重启不重放任务和PTY。空间运行、取消、检查与审阅为独立事实；独立检查器尚未接入时明确blocked，不能接受结果。
- 母模板、priority业务API、C1–C3完整固定验收、真实diff/报告产物及VS001产品adapter仍有缺口。SSH和文件资源适配器未实现；演示页面和历史演示记录不能当作这些能力的通过证据。

## 现有契约与目标约束的协调

真实运行使用workspace协议中的工作台运行记录；演示 `RunRecord` 只服务于明确标注的历史样本。执行完成、检查passed/current、用户接受分别保存；通知打开和标记已读不推导这些状态。日志归属明确的run；缺少diff或检查证据时展示原因。旧计划中的 `replay` 只读历史概念不意味着启动新run；固定比赛验收和VS001属于不同范围。

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
| session                | 默认 session     | 独立内存分区 `preview-<workspaceId>-<instanceId>`，与工作台隔离                                                                                    |
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

- workbench：读取/重载快照、提交具名命令、订阅事件；空间网页、PTY、资源和任务均经此入口。
- 应用信息与执行服务状态（只读）。
- 个人对话：查询CLI状态、读取/发送/取消/重置个人会话，订阅会话快照与不可用状态；空间会话由Main工作台管理。
- 菜单命令事件（例如 ⌘B 切换 Workshop）。
- 不暴露旧的单预览/单终端/公开资源renderer写接口，也不暴露任意IPC通道或宿主文件路径执行器。

main process 对每个 IPC 请求做两项检查：

- 用 `protocol` 中的 Zod schema 校验参数，校验失败直接抛错，不做兜底。
- 检查 `event.sender` 是主窗口的 webContents，且 `event.senderFrame` 是顶层工作台页面；Browser 区视图发来的 IPC 一律拒绝。

新增 IPC 通道必须先在 `protocol` 中定义 schema。

### 4.3 页面现场与同页控制

- 点选、截图和以后的读取 / 点击 / 输入都通过同一个 Browser 区 `webContents` 的 CDP 完成，现场记录 `webContents` 身份、文档代次、URL、采集时间。
- 页面导航（包括同文档导航）后，文档代次加一，旧现场标记失效，确认任务前必须重新采集。
- 人工打开 DevTools 等原因导致 CDP 断开时，界面显示原因，暂停页面自动操作；重新附着后重新采集现场。
- 原生网页点击携带实例身份同步活动窗格；刷新和DevTools按活动窗格执行，不回退后台网页。
- 点选请求携带requestId并冻结接收空间、会话、资源、实例和文档身份；迟到截图不能写入后来请求。
- 浮层统一登记遮挡来源，等待Main隐藏网页成功后显示可点击内容；关闭最后一个浮层才恢复。固定栏只重新测量DOM矩形，不隐藏原生网页；不以迟到截图改变可见性。

## 5. 服务接口

### sbx 对话与终端（2026-10-06 接入）

`apps/service` 独立构建为 Node 产物，main 通过 `utilityProcess.fork` 启动，核心不依赖 Electron。跨进程契约统一定义在 `packages/protocol`；renderer 仅持有快照投影，不能选择宿主任意命令。`WSL_SBX_NAME` 选择已存在的 mountless Codex sandbox，`WSL_SBX_BIN` 可指定 sbx CLI；未配置、目标不符或连接失败直接报告不可用。

`SbxConnection` 负责定位 sbx、核验目标身份/挂载、读取 guest Codex 版本；`GuestProcess` 负责传输和退出回执。实际 Codex 与 shell 都在 `/home/agent/workspace` 内运行。认证保留模板的 provider 与代理配置，不读取或复制 host 凭据。应用不创建、删除或停止整个 sandbox；组件准备见[依赖说明](../development/dependencies.md)。

每次进程调用通过 `sbx exec -i` 启动内置 Python 标准库 helper。helper 在 guest 内管理所属进程、PTY 与清理；stdin 控制帧和模型 prompt 分开，stdout 使用明确帧封装。终端使用 xterm.js 与 fit addon 展示 guest PTY，不依赖 Electron native node-pty ABI。输入、尺寸和会话身份在 IPC 边界校验；隐藏终端保留同一 shell，关闭时等待远端清理确认。

Codex 首轮使用 `exec --json`，续轮显式 `exec resume <threadId>`，采用 `workspace-write` 并启用 guest 工具。消息历史按应用会话隔离，但各会话和终端共享 guest 文件系统；开始新对话不删除文件。服务拥有 generation、threadId、turnId 与序号，保留有界工具结果和非致命警告，截断结果明确标示。成功要求助手文本、会话身份、完成事件、正常退出和远端清理确认。

每会话最多一个活动回复。取消、重置、终端关闭和窗口退出均等待已登记guest进程清理；宿主sbx进程退出不等于远端清理成功。缺少回执时显示失败并保留占用。空间消息历史、草稿和运行事实持久化；恢复历史不等于恢复模型上下文。重启后终端需显式重连，活跃运行记为中断，不自动重放。CLI自身会话和guest文件仍由CLI/sandbox管理。

连接检查不调用模型；普通测试使用确定性sbx fixture，真实模型和真实guest生命周期须显式启用。该接入不等于完整业务闭环或固定验收完成。

### 公开网页与空间资源（2026-10-06 授权实现）

公开页面使用单独的 HTTPS 获取与只读文档路径：main 对全部 DNS 地址和每次跳转校验公网范围，连接固定到已验证 IP，保留 TLS 证书校验。解析响应后仅把转义后的标题和正文放入固定模板；原站脚本、属性、样式、Cookie、网络提示和子资源不会进入 Browser。界面明确标注只读文档，真实页面快照含原始字节和正文散列，不宣称原站布局或动态交互。

用户主动加入的公开文档由服务保存在固定空间资源文件中。renderer 只传空间和预览页面身份；main 捕获已显示的同一代文档，服务验证快照并提供幂等新增、版本更新与删除。Main 按实际空间身份调用服务，资源集合按空间隔离；入口为 workbench 命令与快照，资源结构权威在 `packages/protocol/src/resources.ts`。

空间会话由Main注册所属空间，服务在调用开始时冻结有界资源包；个人会话是空包。guest helper把资源包放入sealed memfd，单次Codex调用加载有限stdio MCP，仅枚举与按资源身份/版本读取。没有host mount、Docker socket、新凭据或持久MCP配置。资源内容是非可信数据，不授予写权限。活动回复期间禁止变更，变更后切断旧CLI thread，下一轮获得新资源包。共享guest的既有同UID文件系统不提供OS级空间保密，已进入历史的内容也无法撤回。

实现和验收边界见 [公开资源合同](../verification/2026-10-06-public-resources/SPEC.md)。完成状态只能依据该轮实测证据，MCP 客户端通过不能代替真实模型工具调用。

## Guest 浏览器与验证边界

[Guest 浏览器合同](../verification/2026-10-07-sandbox-browser/SPEC.md)保留 Chromium sandbox、资源身份及同版本散列读取要求。历史 final-code-live-03 只证明当时版本的单次链路；本次整合只重新运行所列离线检查，不扩大为模型调用或生产 UI 验收。

系统Node要求见根 `.nvmrc` 和 `package.json`，产品计划期望主版本24。当前验证的实际版本和打包边界见本轮执行记录；构建通过不能替代未运行的平台或打包验证。固定依赖保持来源声明，不升级。
