# 当前运行时与目标架构的边界

本记录以2026-10-13候选树为基础，后续切片在对应段落更新实际接线；本轮范围、审查修复、验证与未运行项见[当前 PR 说明](../acceptance/consolidation-20261011/PR.md)。[2026-10-11 整合记录](../acceptance/consolidation-20261011/README.md)保留当时的来源去向与验证边界。2026-10-08[INTEGRATION-1](../acceptance/integration-20261008/SPEC.md)和[SR-1](../acceptance/space-remake/SPEC.md)保留各自源码基线与历史窗口证据，历史通过不能替代当前版本复验。

## 已有能力和缺口

- `apps/desktop/src/main/workbench` 持有空间、标签、资源、窗格、会话、任务版本、运行、阅读回执及持久快照。Host将应用端口接到原生网页和服务；renderer只持有快照投影与展示状态。
- 状态呈现经两层只读投影：`apps/desktop/src/shared/status` 由 Main 快照推导业务事实（Main 与 Renderer 共用），Renderer `state/status-view.ts` 叠加展示状态并分配常驻 / 问题 / 提示通道；诊断通道 `debug:status` 仅在开发服务器或 `WSL_DEBUG_STATUS=1` 时注册。见[状态降噪设计](../design/2026-10-11-status-surface/README.md)。
- 全局保留首页、空间、资源、会话、任务和设置；空间页使用垂直标签与最多四窗格。左右栏是全局展示容器，固定偏好属于本设备，不属于空间业务。主题仍按空间保存，设置页是唯一编辑入口。
- `apps/service` 提供 sbx 会话、guest PTY、捕获适配与只读 MCP；账户资源目录由 Main 单点写入；`guest-browser-bridge.ts` 与 `guest-browser.cjs` 是隔离浏览器采集切片，尚未完成生产 UI 挂载验证。
- `packages/protocol` 是跨进程schema来源；空间操作经workbench命令，旧空间/预览/运行/资源/终端renderer控制器随消费者迁移退役。个人会话仍使用窄chat接口。
- `tests/vertical-slice`、`fixtures/vertical-slice/page` 与 [VS001](../acceptance/README.md) 保留 main 的固定验收与负例。`src/vertical-slice/adapter.ts` 已复用 sbx/Codex、Vite 和产品 Browser 接入冻结契约；[本轮记录](../acceptance/integrated-app-installer-public-20261009/README.md)区分最终整合验证与历史离线验证。
- 空间元数据、草稿、任务版本、历史运行与阅读回执可以恢复；重启不重放任务和PTY。空间运行、取消、检查与审阅为独立事实；独立检查器尚未接入时明确blocked，不能接受结果。
- 固定母模板与受管App第一工作包已接入，见下文；priority业务API、C1–C3完整固定验收及独立报告产物仍有缺口；标准 App 的任务源码证据与真实 diff 读取已接线，见[源码证据合同](../plans/2026-10-15-p0-run-diff.md)，当前测试与产品验收仍须分别确认；VS001 adapter 的代码接入不能替代真实五项复验。独立文件、终端观察和SSH/SFTP Provider、Main/MCP及空间界面已接入，验收仍按本轮阶段记录判断；Provider单元测试不证明可见功能或生产远端验收。演示页面和历史记录不能当作真实闭环证据。

## 现有契约与目标约束的协调

真实运行使用workspace协议中的工作台运行记录；演示 `RunRecord` 只服务于明确标注的历史样本。执行完成、检查passed/current、用户接受分别保存；通知打开和标记已读不推导这些状态。日志归属明确的run；缺少diff或检查证据时展示原因。旧计划中的 `replay` 只读历史概念不意味着启动新run；固定比赛验收和VS001属于不同范围。

原产品合同的进程安全、公开资源和聊天边界继续适用，具体实现如下。任务编排的未来状态机以架构基线为约束，未实现的 CLI 入口不得报告为可用。

## 标准任务源码基线与差异

标准受管 App 的任务在执行前由独立只读 helper 采集源码，Main 先持久化采集意图，再尝试将实际内容保存为宿主独占 Git 对象基线。普通基线采集或宿主 Git 失败、但 helper 清理已确认时，按既有合同将 `sourceChange` 标为 unavailable 并允许执行继续；基线成功不是模型派发的无条件前置。清理未知仍阻止派发。基线存在且执行与所属清理确认后再次采集，生成不可覆写的摘要和 patch；同项目占用保持到结束采集完成。collector 与长期 App 的句柄、状态和日志分开，取消回执不能代替退出/清理确认。采集清理未知时保留 `sourceCleanupPending` 和项目占用；执行器清理未决同样不释放项目。重启不重放副作用，也不清除模型或 collector 的未知清理状态。没有 source 字段的旧 schema 4 历史继续显示未记录。

采集限制为 200 MiB 原始字节、20000 文件/目录、48 KiB 分块与 352 MiB 传输；宿主摘要最多 200 文件、UTF-8 patch 最多 256 KiB，超出时明确标记。它与标准源码导出的 256 文件/524288 字节合同独立。固定排除凭据与运行/构建产物，不服从工程 Git 排除规则；拒绝路径别名、链接、特殊文件及不完整帧。宿主 Git 环境隔离，不运行工程 hooks、外部 diff 或 textconv；内容只进入对象库，不向 guest 暴露宿主证据路径。

任务页通过具名 `workbench.runPatch` 读取真实 patch，Main 校验空间/run、文件身份和哈希，Renderer 再绑定返回身份并忽略迟到旧响应。源码状态来自 shared status；失败允许显式重新读取，正文每页最多 500 行，完整证据保留在宿主。源码差异不改变独立检查或审阅事实。完整合同、测试入口与未验证边界见[标准 App 任务源码证据](../plans/2026-10-15-p0-run-diff.md)；确定性 fixture 不等于真实 guest/model 验收。

## 4. Electron 安全基线

当前 Browser 区承载演示页面、受控公开 HTTPS 只读文档和当前空间受管沙箱应用，统一按不可信内容处理。应用运行地址须经服务身份健康检查和 Main 实例租约授权，以下隔离边界保持不变。

### 4.1 窗口与视图配置

| 配置                   | 工作台 renderer  | Browser 区视图                                                                                                                           |
| ---------------------- | ---------------- | ---------------------------------------------------------------------------------------------------------------------------------------- |
| `contextIsolation`     | `true`           | `true`                                                                                                                                   |
| `sandbox`              | `true`           | `true`                                                                                                                                   |
| `nodeIntegration`      | `false`          | `false`                                                                                                                                  |
| `webSecurity`          | `true`           | `true`                                                                                                                                   |
| preload                | 仅工作台 preload | **无**                                                                                                                                   |
| session                | 默认 session     | 独立内存分区 `preview-<workspaceId>-<instanceId>`，与工作台隔离                                                                          |
| 权限请求               | 默认拒绝         | 默认全部拒绝                                                                                                                             |
| `window.open` / 新窗口 | 拒绝             | 拒绝                                                                                                                                     |
| 导航                   | 只允许本应用页面 | 当前允许 `wsl-demo://taskflow`；用户授权的公开 HTTPS 采用下述只读文档代理路径。受管沙箱应用仅注册本次实例的精确回环 origin，停止立即撤销 |

其他要求：

- 工作台 renderer 设置 CSP：`default-src 'self'`，只放行本应用资源与 `data:` 截图。
- 不使用 `remote` 模块，不关闭 `webSecurity`，不启用 `allowRunningInsecureContent`。
- 生产加载使用本地文件；开发时才加载 Vite dev server。
- 演示页面通过只注册在 Browser 区 session 上的自定义协议提供，只读取 `demo/` 目录内的文件。

### 4.2 preload 与 IPC

preload 只暴露以下几类能力，请求一律使用 `ipcRenderer.invoke`，事件订阅返回取消函数，不直接暴露 `ipcRenderer`：

- workbench：读取/重载快照、列出环境、请求观察、提交具名命令、订阅事件；空间网页、PTY、资源和任务均经此入口。
- 应用信息与执行服务状态（只读）。
- 个人对话：查询CLI状态、读取/发送/取消/重置个人会话，订阅会话快照与不可用状态；空间会话由Main工作台管理。
- 菜单命令事件（例如 ⌘B 切换整组左栏）。
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

每会话最多一个活动回复。个人与空间会话均在共享清理状态未知时拒绝新发送和重置，正常会话仍可并行。取消等待所属传输的完成回执及同步终态发布；单独cleanup帧不提前确认清理，完成或发布异常保留原失败原因与尚未确认的占用。取消、重置、终端关闭和窗口退出均等待已登记guest进程清理；宿主sbx进程退出不等于远端清理成功。缺少回执时显示失败并保留占用。空间消息历史、草稿和运行事实持久化；恢复历史不等于恢复模型上下文。重启后终端需显式重连，活跃运行记为中断，不自动重放。CLI自身会话和guest文件仍由CLI/sandbox管理。

连接检查不调用模型；普通测试使用确定性sbx fixture，真实模型和真实guest生命周期须显式启用。该接入不等于完整业务闭环或固定验收完成。

### 账户资源、空间连接与固定参考（2026-10-10）

Main 的 `resource-catalog` 管理本地账户拥有的资源、主动收藏、空间连接和不可变内容版本。账户身份在首次初始化时创建并持久化，renderer 不能指定所有者。`WorkbenchResource.resourceId` 继续标识原空间运行绑定，`catalogResourceId` 指向账户资源；标签和运行实例保留独立生命周期。文档分类目前提供已有授权环境的文件入口收藏与重开；浏览目录是展示状态，不自动写账户描述，本轮不含将任意当前文件另存为收藏、文件导入或正文归档。页面实现及本轮验证边界见[资源归属验证记录](../acceptance/resource-ownership-20261010/README.md)。

`workbench.json` schema 4 同时保存工作台、空间 App 描述和账户目录，完整格式、摘要和关系校验通过后原子替换。schema 1/2/3 及旧 `chat/space-resources.json` 仅作迁移来源：旧工作台另存不可覆盖的备份，旧资源文件原样保留；带 catalog 的 schema 3 保持原账户、收藏、连接及版本；空间 App 分支的无 catalog schema 3 以每个空间显式合法的 app 字段识别，保全 App 元数据与 publicResources 后按既有规则迁移目录。缺少这组来源标记的损坏文件拒绝迁移。App 元数据迁移不启动实例；损坏或未来格式拒绝覆盖。正常 schema 4 重启不因读取而额外保存。

公开页面仍使用受控 HTTPS 获取与只读文档路径：Main 校验 DNS 地址与每次跳转的公网范围，固定已验证 IP 并校验证书，只把转义标题和正文放入固定模板。原站脚本、属性、样式、Cookie 和子资源不进入 Browser。收藏 HTTP/HTTPS 链接只保存描述，不访问网络；实际打开和正文捕获继续服从现有能力限制。

账户命令使用独立目录 revision 与幂等 commandId。收藏、连接、打开、捕获正文、选择参考、关闭标签、停止实例和解除连接分别执行。捕获由 Main 核对真实页面身份并追加版本；浏览器从 A 导航到 B 后保存的内容不会覆盖 A。列表事件只含摘要，正文和历史运行的固定引用按需查询。旧 service `ResourceStore` 及空间集合写入接口退役，不保留第二个写入者。

Main 在发送前冻结已选的 resourceId/version：空间会话读取该空间连接上明确选择的版本；个人会话读取明确选择的收藏版本，默认空包。service 核验注册会话归属后附加 generation/turnId，再交只读 MCP。每轮最多 16 项、单正文 64 KiB、完整 JSON 包 512 KiB；收藏数量不受 16 项约束，预算超限在启动执行前拒绝。新版本与新选择只影响后续轮次，历史固定证据保留。

资源内容属于非可信数据，不授予工具或环境权限。guest sealed memfd、有限 stdio MCP、无 host mount 和既有认证边界继续有效；共享 guest 的同 UID 文件系统不提供操作系统级空间保密，已有模型历史内容也不能撤回。[旧公开资源合同](../verification/2026-10-06-public-resources/SPEC.md)保留历史来源与隔离证据，其旧空间归属及固定 demo 范围已由[新合同](../acceptance/resource-ownership-20261010/SPEC.md)替代。

## Guest 浏览器与验证边界

[Guest 浏览器合同](../verification/2026-10-07-sandbox-browser/SPEC.md)保留 Chromium sandbox、资源身份及同版本散列读取要求。历史 final-code-live-03 只证明当时版本的单次链路；2026-10-08 整合曾获真实模型与 sandbox live 授权，是否运行及结果见该轮记录；这不构成 2026-10-10 账户资源改造的 live 授权。授权、代码存在和历史通过均不能替代本轮实测，也不推导生产UI挂载或外部SSH验收。

系统Node要求见根 `.nvmrc` 和 `package.json`，产品计划期望主版本24。当前验证的实际版本和打包边界见本轮执行记录；构建通过不能替代未运行的平台或打包验证。固定依赖保持来源声明，不升级。

## 环境、观察与恢复的当前接线

可信进程环境声明本地授权根、sandbox 名称及 SSH agent/host pin。环境列表只描述配置与能力，不建立 SSH 连接。Main 决定每个资源的空间、环境、实例 UUID 和代次，服务按绑定取得文件或 PTY。旧文件/SSH 占位不会被自动授权。本地终端以当前用户权限运行，授权根只约束文件读取；它不是 OS 沙箱。

观察请求在 Main 元数据队列中冻结归属，Provider I/O 在队列之外执行；完成时重新定位请求并核对完整实例身份。空间会话入口包含真实 sessionId；模型调用还包含真实 runId，源列表在运行启动时冻结。独立文件标签的 sessionId/runId 明确为空，只允许文件读取，不伪造匿名会话。每个运行的调用计数与 200 条近期观察窗口分开，终态释放 scope 与计数。

Browser 观察来自对应资源的 WebContents；终端 UI 和 headless VT 使用同一 PTY 输出。文件观察保留授权根、内容散列、续读游标和有损变化提示，失效/缺口明确返回。SSH/SFTP使用可信host-key pin和现有agent，连接中断不推定远端进程已退出。若服务在取得终端适配器前失败，它按当前实例发送未创建进程的明确状态，Main允许重试；未收到同一实例证明的失败继续保留cleanupPending，不能以错误文字或旧实例事件解除。

service→Main 的 MCP 请求沿具名消息和 AbortSignal 传递；guest使用每轮临时Unix socket，限制4个在途请求、64次调用和完整报文预算。图像在当前文本模型通路只返回证据元数据，不声称模型看到了截图。完整guest控制流与真实模型仍须以最终live记录判断。

持久化 schema 2 明确迁移旧网页到 local、旧终端到 sandbox，保留资源/标签/布局身份；旧 file/ssh 保持无环境。空间快照不保存凭据或活动原生/PTY句柄，不自动重放进程。历史观察保留原绑定作为证据，不能据此恢复活动实例。新任务版本同时冻结 appInstanceId、实例 UUID 和代次；重启后旧现场必须重新采集确认。

观察证据在用户数据目录的 observations 子目录用新 UUID 和排他创建写入，历史不覆写。近期窗口可移出已归档记录，但不会驱逐仍在请求或归档中的对象。结果完成与取消在第一次 Main 归并时决定先后，稍后的取消不改写已完成证据。存储失败可见，不能冒充成功归档。

空间文件标签通过 `Files` 提供只读列表、搜索、读取和续读；空间会话的上下文通过 `SessionObservation` 选择实际资源并显示范围、结果和历史。新建文件/终端必须选已配置环境，初始检查到就绪的环境投影由 Main 广播刷新，旧异步查询不能覆盖新结果。关闭标签不会清除资源身份，原生浮层和六页外壳继续遵循 SR-1。

## 标准应用与受管服务（2026-10-09 第一工作包）

`templates/standard-app` 是唯一工程母模板，React/TS/Vite、Node/Hono、Drizzle/PGlite、Zod 与 Tailwind 使用独立 npm 锁与版本内容哈希。空白起点只包含健康检查、数据库迁移、开发 A/B 会话与隔离的存储探针，不包含 TaskFlow 业务。正式服务由 Hono 单端口提供构建后的页面和 API，开发命令仍保留 Vite。

空间侧栏顶部的 App 图标打开创建与管理对话框，通过现有 workbench 命令提交 createApp/updateApp/startApp/stopApp/exportApp；原侧栏底部“标准应用”区域移除。Main 唯一拥有 workspace/project/App 快照。空间 App 描述持久保存稳定 appId、projectId、名称、说明和 revision；编辑带版本条件且不调用运行时。任务版本固定 App/project/guestCwd 及完整非截图页面/元素上下文，执行前校验身份及组合 prompt 的 32000 字符预算；旧任务缺少绑定时不猜测当前焦点。独立 Node 服务中的 AppService 复用 SbxConnection/GuestProcess 管理持久 guest cwd，应用进程不归单轮 Codex 清理。实际 guest PORT=0 分配端口，服务验证同一 child 的 ready 身份、端口回执与健康身份后，Main 仅给对应 Browser 资源授予当前 origin 的写请求能力。公开文档仍只读，其他 webContents 不能复用授权。

停止先在 guest child 仍存活时核验并删除自己的 loopback 映射，再关闭进程并等清理回执；VM重启导致映射变化或回执缺失时保留未知状态，禁止猜测清理其他映射。注册表绑定真实 sandbox 名称，只恢复项目描述，不自动重放服务。AppService 对所属 child 的正常完成与拒绝分别处理：拒绝不视为退出或远端清理确认，启动的端口与健康等待后重新核对进程连续性；停止在端口查询返回后再次核对，未知时不删除可能重绑定的映射。异常退出的清理、持久化和同步/异步快照发布组成同一收尾，停止等待其结束，收尾期间拒绝新启动、导出和控制面派发；迟到旧 child 结果不能修改新实例。收尾失败保持可查询的失败状态；持久化或通知失败不改写已确认的实际清理结果，未知清理仍阻止新派发。上述生命周期收尾、清理及异步通知失败的累计诊断，对每个新原因保留前 1000 个 UTF-16 code unit、累计保留最新 4000 个（沿用启动诊断预算）；该限制不覆盖创建失败和 CLI 结果等其他错误写入路径，也不是协议的统一长度限制。诊断截断不改变清理事实或占用。有限 helper 的关闭拒绝可显式重试停止，不将状态卡在 stopping。创建/启动和依赖导入的非等待通知只接收所属快照的异步发布失败，不延迟原派发，也不因通知失败改写进程或清理事实；同步发布抛错仍沿原调用链处理。首次准备执行 seed，普通重启只迁移、检查和构建，磁盘 dataDir 保持。源码导出需停服确认，输出实际完整源码目录和同级 manifest，不混入运行数据或 node_modules。标准 App 导出在协议、service 与 helper 间固定为最多 256 个文件、524288 字节解码内容，不接受 profile 或预算覆盖；helper 按剩余预算加一有界读取。Desktop 在创建目录前核验全部输入、编码、哈希、预算及路径冲突（含大小写、NFC 与父目录别名），在已验证的 macOS 上按最近存在祖先解析的实际完整路径（含 manifest 后缀与 NUL）核验 1024 字节系统上界，拒绝导出根符号链接，保留原路径、0700 目录及 0600 文件；这些输入检查不保证磁盘 I/O 失败的事务性，也不承诺对抗并发目录替换或完整模拟 APFS 排序规则。

工具链、模板服务、产品窗口与唯一模型调用的证据分别见[本轮记录](../acceptance/integrated-app-installer-public-20261009/README.md)。本包未实现比赛业务验收、正式签名公证发布、全套任务源码写入流程或统一观察中该 sandbox Browser 的额外授权；不能把母模板健康检查视为 AI 生成完整业务。

### 安装包中的标准应用

安装器配置与应用服务共用一个 `SbxConnection`；`runtimeTarget()` 只返回已初始化的 binary/sandbox，App 导入和端口操作不另行搜索 PATH。显式空配置保持不可用，不回退环境变量。Main 从包内 `runtime/dependencies.json` 派生只读模板依赖配置，校验模板源码、独立锁与归档后传给执行服务。损坏载荷在原设置页显示错误并禁止 sandbox 连接。模板存于包内 `templates/standard-app`，Linux ARM64/glibc 依赖包存于 runtime；归档准备审计实际 ELF、外来平台、必需 native 模块和执行位，并收集依赖许可。

窗口退出分别尝试安装操作与工作台服务清理；服务内部先逐项尝试受管应用清理，再尝试对话与环境资源清理，单一失败不会跳过其他所有者。成功后等待 Main 持久化队列回执再关闭。清理失败或等待超过 30 秒时，原生对话框显示具体原因，提供“重试清理”“取消退出”“仍然退出”，默认取消；取消保留窗口，但服务已进入关闭状态，不能继续新操作。超时不代表清理停止，重试等待在途尝试；实际失败后可重新尝试。只有明确选择“仍然退出”才允许未确认时退出本地应用，提示未确认进程可能继续运行，不把清理状态改成成功。异常注册表保留原文件并报错，不自动迁移或丢弃历史资源；持久化使用已验证的非空 sandbox 身份。实现与回归证据见[退出问题验证](../verification/2026-10-10-shutdown.md)。公开只读 origin 和受管 App 可写 origin 仍分别按精确实例 lease 校验。

## 受管 App 控制面（2026-10-11 阶段 A）

设计、计划与取舍见[控制面设计](../design/2026-10-11-app-control-plane.md)、[实施计划](../plans/2026-10-11-app-control-plane.md)与 [ADR-0002](adr/0002-app-control-plane.md)；本轮验证结果见[验证记录](../verification/2026-10-11-app-control-plane/README.md)。

- 通道：guest MCP 的 `app_*` 保留观察的临时 Unix socket；每轮安装的 `wsl-app` CLI 通过 `WSL_APP_CHANNEL` 使用私有临时目录内四槽文件 IPC，适配仍禁止 socket 连接的 Codex 命令沙箱。两者合计共享 64 次/4 在途预算，CLI 只承载既有 `app.*`，不重试或回退，不调整沙箱权限。service `CodexChat` 把 `app.` 开头的调用改发 `app-call`，Main `ChatService` 交 `WorkbenchApplication.appControlForTurn`，唯一 dispatcher 为 `workbench/app-control.ts`。观察工具的路径与 `ObservationRecord` 不变。轮次清理先取消在途调用并释放通道、删除临时目录，再确认成功。
- 授权：`appControlContext` 只认 Main 冻结的轮次 scope，run 须为 `starting/running` 且非 `cancelling`；写操作另需请求 `appInstanceId` 等于当前运行实例、host 租约有效、未被用户暂停。除用于恢复的 `app.restart` 外，还需 manifest 与运行构建均不 stale；UI 写还需当前文档代次；`app.data.reset` 需任务版本 `allowedScopes` 含 `app.data.reset`。出队与异步修订读取后复核归属及取消；seed/reset 在能力查询及 pending 持久化完成后、实际派发前再次复核 run、实例、租约和用户暂停。若此时拒绝，只撤回本次确定未派发的记录；撤回持久化失败继续保留保护。run 结束时 dispatcher 中止该 run 的在途调用并解除 Browser 操控指示。
- 执行：L1 与前端 L2 由 `preview/app-ui.ts` 在受管 App 的同一 Browser `webContents` 上经 CDP 执行，页面函数固定、参数仅作 JSON 值；`WorkbenchHost.appUi` 只给 `appBrowserProjects` 中当前租约有效的资源。L0/后端 L2 由 service `AppService.agent/logs` 执行：运行实例走回环 HTTP 与每次启动随机生成的实例令牌，停止时经 `app-helper.py` 的只读 `agent` 操作在 guest cwd 执行 agent-cli。
- 数据写入完成事实：Main 在派发 seed/reset 前持久保存 operationId、实例及原任务归属；模板声明 `operationTrackingVersion: 1`，按实例登记、去重和查询终态，记录最多 1024 条且不驱逐。取消先到留下墓碑，已开始的操作继续到真实终态；取消回执、断线或 not_found 不证明结束。取消保持 App 运行，立即及每秒核对，单轮最多 30 秒，未知继续阻止控制面写入、启动、重启和导出。原任务的 `reconcileRunCleanup` 可在无模型 scope 时再核对。
- 清理投影：TaskRun 保存独立模型执行事实，Conversation 与 TaskRun 合并模型、App 清理占用，全部确认前保持 `cancelling / cleanupPending`。CLI 未确认或异常保留句柄，应用进程或端口的成功不能覆盖它。`app-control/pending.json` 只持久保存身份、不保存令牌；重启不重放操作。旧模型进程缺少停止证据时，即使 App 已结清仍保留未知，不能借 App 终态宣称模型退出。
- 快照身份：元素引用必须为 `{ref, snapshotId}`，`{testid}` 形状不变。新成功快照原子替换引用表；失败、取消不覆盖旧成功表，导航、detach、实例更换使引用失效。数据库快照递归排序对象键并保留嵌套值与数组顺序，全部行参与散列，样本最多 20 行。
- 用户接管：`PreviewController.agentControl` 由 `input-event` 判定用户点击/输入并锁存 `paused_by_user`，经 `PreviewState.agentControl` 投影到 Browser 区指示；只有 renderer 的 `browserAction: resumeAgent` 能恢复。
- 重启导航：Main 内部 AI 重启完成后通过既有 `ensureBrowser` 重建受管网页实例，不激活 App 标签，也不恢复旧布局覆盖等待期间的新导航；用户显式 `startApp` 仍打开 App 网页。用户留在会话时可继续使用原“取消回复”按钮。
- 证据：审计与场景轨迹写在用户数据目录 `app-control/<runId>/`（追加 `audit.jsonl`，场景 `scenarios/<id>/trace.json`、`revision-check.json` 与截图排他创建）。轨迹固定起始 manifest 修订；结束时源码变化或无法核对，不能报告 passed。证据不进入 `workbench.json` 快照，不改变 TaskRun 的 validation 状态。
- 模板：standard-app 1.1.0 内建 registry/bridge、agent-cli、`/api/__agent` 与 manifest；受管启动对含 `build:agent` 的项目改用 agent 构建，旧 1.0.0 项目照旧生产构建并返回 `unsupported`。健康检查接受 1.0.0 与 1.1.0。
- 验证：修复后的 A03/A07 无模型 live 通过；[A11 真实模型与 Host 固定复验](../verification/2026-10-11-app-control-plane/round-09-model-live/README.md) 通过，真实 MCP describe、UI、state、query 链路已运行。[round-10](../verification/2026-10-11-app-control-plane/round-10-cli/README.md) 在保持 `workspace-write` 与 Main 权限不变的前提下改用 CLI 文件通道，真实命令沙箱 11 项检查（含两项 Main 拒绝）、MCP 及 Host 固定 16 步通过；所属进程、映射和通道清理确认。[round-11](../verification/2026-10-11-app-control-plane/round-11-cli-cancel/README.md) 通过实际产品按钮取消真实在途 CLI，核对 11 个所属进程退出、通道删除、45 个源码文件保留及下一轮真实 CLI 的迟到响应隔离；按钮为 Playwright 自动点击，返回帧延迟由测试启动层控制。
- 缺口：独立产品检查器仍未接入，测试内 Host 复验不写入 TaskRun 的 validation，也不构成用户接受；真人输入、安装包复验未在本轮执行；Expo（阶段 B）与 Android（阶段 C）未实现。

## edu 导入 / R5 切片（本地实现）

从 `130066850086ffab6295d46e410ae152294a654f` 按行为提取 edu-only 导入、运行和导出链，叠加在已合并标准 source 链之上。Main collector 只读采集原生选择的 Git 根，固定 Git 配置且拒绝外部过滤器、partial clone、submodule、链接和超预算目录；256 文件 / 524288 解码字节限制保持。renderer 只提交预览身份和确认散列。

Main 持久化未决操作，service journal 与 guest staging / 原子发布 / receipt 核对同一 workspace、project、operation 和源码身份。取消、退出未确认或重启期间不释放未知占用，不自动重放副作用。edu 运行使用既有所属进程记录与恢复通道，默认 AI0，要求 guest Python 3.12。每次启动先只读采集并冻结当前源码清单摘要；持久化记录、所属进程、启动请求和就绪回执必须绑定同一摘要，guest 在创建构建目录前复核。启动前后校验保护文件，锁定依赖安装、测试和构建发生在 guest，可能访问依赖下载网络。

源码与编码传输分别限额：通用 guest start 的 JSON 加 LF 上限为 3 MiB（原为 1 MiB），宿主先编码并按 UTF-8 字节预检，再创建子进程；当次注入的受管应用 helper 的 JSON 编码最多 128 KiB。内层应用请求同为 3 MiB，导入回执聚合最多 1 MiB，错误码最多 100 字符。按 256 文件、524288 解码字节、每路径最多 500 个 UTF-16 单元推导，base64 合计最多 699732 字节；包含两份路径清单、JSON 转义和固定字段余量，内层至多 2276436 字节，外层至多 2703700 字节，导入回执至多 802560 字节。guest 首帧使用线性 bytearray 逐字节读取并在 LF 停止，不预读后续控制帧。该调整只扩大有限 start 编码容量，不承诺任意 start 参数都可传输；后续控制帧的 1 MiB 上限、输入队列、源码/磁盘清单预算、路径检查与超时不变。导出含 base64 的回执独立于导入回执限额，继续由既有有界日志及完整源码校验接收；不混用 1 MiB 导入回执上限。

R5 edu 导出保留 main 已合入的线性有界编码检查、NFC/大小写路径别名、文件/目录冲突和 UTF-8 完整路径预检。输出实际源码字节、实际文件清单和不可变 importBase；标准 App 的原输出布局不变。只有 `admin/src/` 差异允许，其他来源文件增删改必须重新导入。

本片不接 edu 模型候选、任务写回或发音验证；Main、service 和 UI 明确拒绝相应任务入口。Mota/R6 权限、保存、撤权和攻击防护仍须作为后续完整切片；research 与纯模块化整理未迁移。离线 fixture 覆盖不代表真实 guest、真实模型、已安装应用或用户产品验收；实际执行结果随候选提交单独记录。
