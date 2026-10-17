# 当前运行时与目标架构的边界

本记录以 PR #6 合并后的 main（`b5531e1`）为基线，描述当前候选整合 P0 D、edu-web、导入入口、受限 mota-web 与研究能力后的接线。当前候选分支为 `agent/submission-20261016`，实现 commit 为 `120d34777db305b99e9501951363fe64e049a69f`，版本与回归见[PR 整合记录](../acceptance/submission-20261016/README.md)。主线合并及保全迁移见[2026-10-14 收尾记录](../acceptance/consolidation-20261011/closeout-20261014.md)；历史整合及魔塔手动接入的验证见[2026-10-15 整合记录](../acceptance/mota-integration-20261015/README.md)，随后新增的专用 AI 工具及验证范围见[AI 阶段验收](../acceptance/mota-ai-20261015/README.md)。P0 D 的来源验证见[任务页真实 diff 计划](../plans/2026-10-15-p0-run-diff.md)。[PR 合并前说明](../acceptance/consolidation-20261011/PR.md)、[2026-10-11 整合记录](../acceptance/consolidation-20261011/README.md)、[INTEGRATION-1](../acceptance/integration-20261008/SPEC.md)和[SR-1](../acceptance/space-remake/SPEC.md)保留各自基线与失败，历史通过不能替代本树复验。

## 2026-10-16 场景补充

本节补充本地候选的场景路径，不改变下文状态所有权。手帐由新的标准 App 经真实模型生成，模板 `server/db.ts` 使用 PGlite 数据目录。公开研究在 `apps/service/src/resource_mcp.py` 与 `research-runtime.ts` 中区分打开正文和显式纳入；协议有候选 URL 字段，不代表本次搜索日志实际提供了该字段。正式生成、17 日研究保存、18 日补录和完整彩排分开验收；130 秒手帐成片已完成，18 日 AI 保存及两次刷新核对通过，见[证据索引](../submission/oschina-2026-evidence.md)。

魔塔继续走专用工具和受限地图写入，不能作为标准 App 任意源码修改或 P0 D diff 的实现证据。build03 model03 与 build04 录像是两个独立模型运行；源码/构建、工具回执、页面画面、数据刷新和 Main validation 分别记录，不相互替代。SSH、多会话与其他 Provider 的源码入口不算本次场景实证。模型工具成功不补足 OS 隔离探针缺失；完整独立检查器和报告缺口保持下文定义。

本次收尾回执中 App stopped 与 run clean、宿主 PID 不存在、sandbox/端口恢复是不同事实。原 keeper 退出方式未知，sandbox 已停止且端口偏离原基线；宿主冻结核对通过不能替代完整清理通过，整体保全为 `undetermined`。原魔塔成片占位文件本轮未重算哈希，见证据索引 E08。

## 已有能力和缺口

- `apps/desktop/src/main/workbench` 持有空间、标签、资源、窗格、会话、任务版本、运行、阅读回执及持久快照。Host将应用端口接到原生网页和服务；renderer只持有快照投影与展示状态。
- 状态呈现经两层只读投影：`apps/desktop/src/shared/status` 由 Main 快照推导业务事实（Main 与 Renderer 共用），Renderer `state/status-view.ts` 叠加展示状态并分配常驻 / 问题 / 提示通道；诊断通道 `debug:status` 仅在开发服务器或 `WSL_DEBUG_STATUS=1` 时注册。见[状态降噪设计](../design/2026-10-11-status-surface/README.md)。
- 全局保留首页、空间、资源、会话、任务和设置；空间页使用垂直标签与最多四窗格。左右栏是全局展示容器，固定偏好属于本设备，不属于空间业务。主题仍按空间保存，设置页是唯一编辑入口。
- `apps/service` 提供 sbx 会话、guest PTY、捕获适配与只读 MCP；账户资源目录由 Main 单点写入；`guest-browser-bridge.ts` 与 `guest-browser.cjs` 是隔离浏览器采集切片，尚未完成生产 UI 挂载验证。
- `packages/protocol` 是跨进程schema来源；空间操作经workbench命令，旧空间/预览/运行/资源/终端renderer控制器随消费者迁移退役。个人会话仍使用窄chat接口。
- `tests/vertical-slice`、`fixtures/vertical-slice/page` 与 [VS001](../acceptance/README.md) 保留 main 的固定验收与负例。`src/vertical-slice/adapter.ts` 已复用 sbx/Codex、Vite 和产品 Browser 接入冻结契约；[本轮记录](../acceptance/integrated-app-installer-public-20261009/README.md)区分最终整合验证与历史离线验证。
- 空间元数据、草稿、任务版本、历史运行与阅读回执可以恢复；重启不重放任务和PTY。空间运行、取消、检查与审阅为独立事实；独立检查器尚未接入时明确blocked，不能接受结果。
- 固定母模板与受管App第一工作包已接入，见下文；任务页已接入下述宿主真实diff证据；priority业务API、C1–C3完整固定验收及独立报告产物仍有缺口；VS001 adapter 的代码接入不能替代真实五项复验。独立文件、终端观察和SSH/SFTP Provider、Main/MCP及空间界面已接入，验收仍按本轮阶段记录判断；Provider单元测试不证明可见功能或生产远端验收。演示页面和历史记录不能当作真实闭环证据。

## 现有契约与目标约束的协调

真实运行使用workspace协议中的工作台运行记录；演示 `RunRecord` 只服务于明确标注的历史样本。执行完成、检查passed/current、用户接受分别保存；通知打开和标记已读不推导这些状态。日志归属明确的run；缺少diff或检查证据时展示原因。旧计划中的 `replay` 只读历史概念不意味着启动新run；固定比赛验收和VS001属于不同范围。

原产品合同的进程安全、公开资源和聊天边界继续适用，具体实现如下。任务编排的未来状态机以架构基线为约束，未实现的 CLI 入口不得报告为可用。

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
| 权限请求               | 默认拒绝         | 默认拒绝；受管 edu 学生页 `/student` 的纯音频请求，仅在当前实例、文档、可见性及音轨监控等门禁满足时例外授权，见下文 edu profile          |
| `window.open` / 新窗口 | 拒绝             | 拒绝                                                                                                                                     |
| 导航                   | 只允许本应用页面 | 当前允许 `wsl-demo://taskflow`；用户授权的公开 HTTPS 采用下述只读文档代理路径。受管沙箱应用仅注册本次实例的精确回环 origin，停止立即撤销 |

其他要求：

- 工作台 renderer 设置 CSP：`default-src 'self'`，只放行本应用资源与 `data:` 截图。
- 不使用 `remote` 模块，不关闭 `webSecurity`，不启用 `allowRunningInsecureContent`。
- 生产加载使用本地文件；开发时才加载 Vite dev server。
- 演示页面通过只注册在 Browser 区 session 上的自定义协议提供，只读取 `demo/` 目录内的文件。

### 4.2 preload 与 IPC

preload 只暴露以下几类能力，请求一律使用 `ipcRenderer.invoke`，事件订阅返回取消函数，不直接暴露 `ipcRenderer`：

- workbench：读取/重载快照、列出环境、请求观察、提交具名命令、订阅事件；空间网页、PTY、资源和任务均经此入口。`runPatch(workspaceId, runId)` 只读已采集的运行 diff，不接受路径，Main 复核归属、文件类型、预算和 SHA-256，Main/preload 两端校验结果。
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

每会话最多一个活动回复。取消、重置、终端关闭和窗口退出均等待已登记guest进程清理；宿主sbx进程退出不等于远端清理成功。缺少回执时显示失败并保留占用。空间消息历史、草稿和运行事实持久化；恢复历史不等于恢复模型上下文。重启后终端需显式重连，活跃运行记为中断，不自动重放。CLI自身会话和guest文件仍由CLI/sandbox管理。

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

系统 Node 要求见根 `.nvmrc` 和 `package.json`，主版本为 24。[validate_only CI 38400211740](https://github.com/JadeSnow7/web-studio-lab/actions/runs/38400211740) 已在 macOS arm64 / Node 24.21 检查最终 PR 提交 `13d3ea4`；签名、公证、安装包和发布步骤均跳过。历史全树 lint / format 失败及 DevTools 间歇性失败继续保留，不能据此称全部 `pnpm check` 通过。构建通过不能替代未运行的平台或打包验证，具体边界见[收尾记录](../acceptance/consolidation-20261011/closeout-20261014.md)。固定依赖保持来源声明，不升级。

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

停止先在 guest child 仍存活时核验并删除自己的 loopback 映射，再关闭进程并等清理回执；VM重启导致映射变化或回执缺失时保留未知状态，禁止猜测清理其他映射。注册表绑定真实 sandbox 名称，只恢复项目描述，不自动重放服务。首次准备执行 seed，普通重启只迁移、检查和构建，磁盘 dataDir 保持。源码导出需停服确认，输出实际完整源码目录和同级 manifest，不混入运行数据或 node_modules。

App 退出处理覆盖完成回调后的清理、持久化与通知失败，错误保留在所属实例的 `failed` 快照中；通知通道本身失败时仍可查询同进程快照，不递归重试通知，也不声称失败的落盘已成功。退出处理有独立在途句柄，显式停止先等它完成，再继续取消有限 helper、核对清理与必要的 edu 恢复；重启不能越过这些在途操作。`done` 拒绝只表示结果未知，不是退出回执，不能因此丢弃尚未确认关闭的句柄。清理在持久化之后、撤销端口之前再次检查进程连续性；持久化失败既不伪造清理成功，也不抹去已有清理确认。旧进程/旧实例的迟到结果不污染新实例，恢复不自动重放启动，Mota 未确认租约门禁仍保留。

工具链、模板服务、产品窗口与唯一模型调用的证据分别见[本轮记录](../acceptance/integrated-app-installer-public-20261009/README.md)。本包未实现比赛业务验收、正式签名公证发布、全套任务源码写入流程或统一观察中该 sandbox Browser 的额外授权；不能把母模板健康检查视为 AI 生成完整业务。

### 任务源码基线与真实 diff（2026-10-14 实现，2026-10-15 续接）

- `source-change.ts` 将有界原始源码 DTO 与既有 `app.export` 分开。具名 `app.source.snapshot` / `app.source.cancel` 只由 Main 调用，guest/model 不拥有基线或 diff 接口。每份快照最多 200 MiB 原始字节、20000 个文件；guest 每块 48 KiB，编码传输总计最多 352 MiB，完整回执、模式、路径、数量和字节在 service 与 Main 重新校验。二进制原始字节用规范 base64 保留，不强制作为 UTF-8 文本解码。
- 只读 helper 通过目录 fd、`O_NOFOLLOW` 与项目 identity 固定 `/home/agent/workspace/.wsl-apps/<projectId>`，不执行项目代码，不读取工程 `.git`，不服从 `.gitignore`。任意层级固定排除 `node_modules`、`dist`、`.data`、`data`、`.vite`、`.git`、`.wsl-*`，以及凭据惯用名称 `.env`、`.env.*`（包括 `.env.example`）、`.npmrc`、`.netrc`、`.pypirc`、`.git-credentials`、`.ssh`、`.aws`、`.azure`、`.gnupg`、`.codex`、`.docker`、`id_rsa`、`id_dsa`、`id_ecdsa`、`id_ed25519`、`id_ecdsa_sk`、`id_ed25519_sk`；排除按大小写不敏感的路径段匹配，host DTO 也拒绝这些路径。普通鉴权实现如 `src/auth.ts` 仍参与，不提供任意源码内的秘密识别或脱敏保证；此证据不覆盖上述排除文件。
- 符号链接、硬链接、特殊文件、不安全模式、非 UTF-8/NFC 路径、大小写或文件目录冲突，以及采集中检测到的文件变化均使整份快照不可用，不静默省略。路径另限 1024 UTF-8 字节、64 层，目录最多 20000 个、单目录条目最多 40000 个。guest controller 和 App helper 使用 Python `-I`，防止当前目录、`PYTHONPATH` 和 user-site 中的同名模块在可信采集前被导入；不改 guest 持久配置。
- service 的源码 helper 具有独立句柄、取消和 120 秒采集期限；成功必须同时收到完整内容、退出码 0 和 helper 清理确认。失败回执也携带明确 target 与 `cleanupConfirmed`，不靠错误文案推断清理。未知清理保留句柄并禁止同项目重复采集，shutdown 仍尝试清理。不占用或修改受管 App 的长期进程、状态或日志；App 运行或停止都可采集，源码正文不写入 App 日志。
- Main 先持久化 starting 元数据，再在元数据队列之外注册/采集。`run-source-repository.ts` 在 `userData/runs/<runId>/` 排他建目录，将实际原始字节用 `fast-import` 导入专用 bare Git 对象库，保存不可覆盖的 `baseline.json`；不用 guest 的树或 patch，也不在 host 物化 guest 路径。对象写入启用 Git fsync，基线与 patch 文件排他创建并 fsync。证据从不挂载到 sandbox，不把路径、基线正文或树作为模型/service 输入。
- 宿主 Git 只使用固定 plumbing argv、隔离环境与进程级配置；忽略系统/用户 Git 配置、清除继承的 `GIT_*`，禁用模板/hooks、attributes 文件、外部 diff 和 textconv，不触碰全局配置。没有宿主 Git、源快照超限或基线保存失败且 helper 清理已确认时，将 `sourceChange` 设为 unavailable，仍允许任务启动。helper 回执损坏、失联、归属不符或明确清理未确认则阻止模型派发和同项目新写入。
- 基线回队列后复核 run/project 占用和取消，持久基线先于 prompt。取消发生在注册期间不派发模型；采集中取消会中止自己的 helper 并等待其结果，迟到快照不能启动任务或写到新 run。只有已确认无执行器的启动拒绝可直接结束；传输失联的启动维持 cleanupPending，不能假称清理成功。
- completed/failed/cancelled 均在模型 `executorState` 和合并 cleanup 均确认后采集结束状态；App 操作清理不能代替模型退出或源码 helper 清理。结束采集的不确定清理单独持久化为 `sourceCleanupPending`，保留已经 completed/failed 的执行事实与已有审阅，不假称取消完成。直到结束采集完成，同项目新 run 与采集期的用户构建仍被拒绝，其他项目/空间可继续。退出先取消模型并等待在途采集，再关闭 service；无法确认退出时留下 unavailable 原因并继续使用既有退出确认界面。
- host 按两个树计算增改删、重命名、二进制及完整行数。Git 50% 相似度识别改名，昂贵的非精确配对最多 200 个候选；超限仍保留增删事实。摘要最多 200 文件，patch 最多 256 KiB，按 UTF-8 边界截断并明确标记；二进制沿用 Git 判定、不输出二进制正文。若 Git 把非 UTF-8 字节判为文本导致 patch 不可合法解码，则整项 diff unavailable，不用替换字符伪装证据。
- 工作台 schema 4 可选 `sourceChange` / `sourceCleanupPending`，正常旧记录不补默认字段、不为读取而改写。重启发现未完成基线/结束采集时记为 unavailable（“重启前未完成采集”），不重新采集或重启模型；未确认的源码清理继续阻止同项目写入，不能由 App-only 回执解除。Renderer 只在 captured 时按 workspace/run/hash 查询 patch；切换记录后丢弃旧响应。`RunDetails` 与明确标注的演示 `DiffView` 共用 `PatchView`，每页最多渲染 500 行并提供首末页和前后页导航，不改存储的完整有界 patch、行数或 SHA-256；事实文案经 shared/status 投影。
- 这只是宿主保留的前后内容证据：当前源码仍来自不可信 guest，不证明作者身份，不是跨进程原子文件系统快照，也不能阻止其他 guest 入口在读取期间改文件。diff 不改变 validation/review。确定性检查、sandbox live、限定模型验证和用户接受分别记录；独立检查器、源码清理/保留期限、200 MiB 全量压力测试、安装包/其他平台复验不能由这些局部检查推导，见[实施记录](../plans/2026-10-15-p0-run-diff.md)。

### 外部 edu-web 源码 profile（2026-10-13）

这是额外授权的外部源码适配，不复制私仓业务代码，也不增加内置模板。2026-10-14 的产品入口使用 `previewAppImport` → `confirmAppImport` 两阶段用例；旧 `importEduApp` 只作为预览别名，不能绕过确认。renderer 不传宿主路径；Main 原生选择目录、静态识别 edu-web 支持范围、获取 Git commit/dirty，双次核验白名单与内容稳定性。预览仅保存 Main 内存中的来源能力和临时 `appImport` 投影，不创建 App、连接 guest 或执行工程脚本。确认携带 previewId/sourceSha256，Main 再核对原目录内容，变化即拒绝，service 再核对传入基线。固定 `/usr/bin/git`、隔离配置及属性、拒绝外部过滤器/partial clone/submodule，避免目录选择触发宿主 Git 执行助手。源码上限仍为 256 文件 / 524288 字节，拒绝链接、危险路径、缺少必需文件及变化中的来源。

Main 投影分别表达选择、检查、预览、复制、启动、取消与终态；guest 成功发布之前不登记为已导入 App。`cancelAppImport` 绑定同一预览身份，停止新动作并等待所属复制/启动清理；发布前取消不留下登记项目，发布后已导入副本保留，取消只停止启动。`retryAppImport` 根据 Main 的可重试和发布事实决定重试导入或仅重试启动，不凭 UI 推断或创建第二份副本。关闭界面不取消操作，也不丢弃未确认预览。确认后自动启动但不激活网页；只有 Renderer 仍处于同一次可见对话框、同一空间及导航时才显式打开学生页，迟到成功不抢焦点。导入入口的验收范围见[本轮记录](../acceptance/import-entry-20261014/README.md)。

`edu-web` profile v1 保存不可变导入基线，App 快照另存当前已确认的源码散列；service 注册表 v3 保存 profile 与实例/端口清理身份，兼容读取旧 v1/v2；导入操作另有有界持久日志。Main 的工作台持久格式为 schema 4。启动/导出只接受 `admin/src/` 内变化；后端、锁或构建配置变化须在新空间显式重新导入。该校验不是 guest 内同 UID 程序的 OS 写入隔离，当前也没有受管的就地 Git 同步或完整任务写入控制。

guest 需预先准备 Python 3.12（实测 3.12.3；安装器尚不负责此工具链），每个项目用指向 guest 固定解释器的独立 venv，按哈希锁安装，执行 pip check、后端 pytest、前端 typecheck/build，复核构建前后的源码，再运行 `server.wsl_runtime`。数据库固定于项目 `.data/edu.db`；AI 强制关闭。不复制宿主 venv、账号或生产数据；标准 Hono/PGlite 命令不用于此 profile。依赖准备失败、保护文件变化、错误来源/就绪/健康回执必须失败，不回退到标准模板。

Main 用实际启动操作和实例身份管理原生浏览器租约。旧实例、不同空间/profile 的事件不能替代当前停止事实；终态不能被迟到的活动事件恢复。已停止 App 的被动布局不重新申请浏览器，显式导航仍被拒绝。管理员 `/` 与学生 `/student` 共用受管 origin 和隔离 session；设备权限默认拒绝，但受管学生页的纯音频请求有受限例外。Host 先核对资源实例代次、当前 AppInstance 与实例验证允许录音状态；`allowsEduAudio` 再要求运行中的当前 App 绑定、活动空间、可见视图、当前文档音轨监控就绪、匹配的 WebContents 与 origin、主 frame、当前和请求路径均为 `/student`，且 mediaTypes 仅含 `audio`。导入本身不授予录音权限，其他页面、视频或混合媒体请求仍被拒绝。上述页面限制是产品门禁，不是 OS 页面级隔离；本轮未实测 TCC 和物理麦克风，签名声明变化见[候选记录](../acceptance/submission-20261016/README.md)。

正常停止并确认清理后，Main 在用户数据目录中新建 `exports/<project>-<exportId>/source` 和 `manifest.json`，包含 `sourceKind: workbench-export`、profile、workspace/project/environment、导入基线和逐文件散列；不输出 venv、数据库、依赖、构建缓存、环境文件或链接。窗口正常退出先清理再保存，重开只恢复描述，不自动启动。真实异常强退后的恢复/残留映射、全套迁移业务回归、录音授权与音轨释放、当前打包产物、两轮 Agent 维护及导出制品部署仍需单独验收。

`e2e/edu-app-live.spec.ts` 用独占 guest 和私有 Electron profile 验证真实 Main/service/sbx/Browser；仅原生目录选择响应由测试提供。它记录导出清单、重启后的数据库摘要、端口和进程审计，并明确列出未覆盖范围。opt-in 参数和定向回归命令见根 [AGENTS](../../AGENTS.md)。源码/UI 的存在、首次通过和无模型测试都不是完整维护闭环或用户接受；本任务私仓保留逐轮结果与失败，公仓不携带私仓业务源码或服务器材料。

### 外部魔塔源码 profile（2026-10-15）

`mota-web` profile v1 是外部工程副本，沿用 App 对话框的“导入已有工程”和两阶段导入事务。Main 原生选择目录，根据必需文件识别 profile；静态预览不执行工程脚本、不连接 guest，renderer 只拿到来源摘要与预算。确认时重新采集并核对摘要，再发送冻结的文件字节；已发布副本的取消保留项目并核对停止，不能把停止描述为复制回滚。魔塔不要求 Git，支持的内容上限为 512 文件、64 MiB 总量、12 MiB 单文件；只接纳固定页面和 `project/`、`libs/`、`extensions/`、`_server/`、`_docs/` 范围，排除链接、凭据/环境文件、依赖、原存档与来源工程服务脚本。Main 的 `import-source.ts`/`mota-source.ts` 与 protocol 的 `mota.ts` 共同定义识别及字节身份，edu 的来源合同与预算不变。

service 使用随产品提供的 `mota-helper.py` 和 `mota-server.cjs`，在独立 guest 项目目录运行受限 Node 服务；不运行工程自带 Python/Node 服务、npm scripts、安装或网络发布命令。guest 需预先具备 Node/Python 3。随机 guest 端口发布到宿主回环地址后，必须完成本次完整实例身份的 origin 绑定回执与健康检查，才能报告 running。每次启动重新核对受保护源码；编辑器写入只允许 `project/floors/MT1.js` 和 `_server/config.json`，经路径、内容与当前文件版本检查后原子替换。其他文件写入、任意路径与发布端点不开放。这是受限 HTTP 服务边界，不是共享 guest 同 UID 文件系统的 OS 写入隔离。

同一 project/AppInstance 对应两个稳定的网页资源：`appPage: game` 固定 `/index.html`，`appPage: editor` 固定 `/editor.html`。两者共享受管服务与工程文件，各自拥有 Browser 实例；重复打开只聚焦已有资源，不把两页导航到同一个根 URL。关闭标签仅关闭视图，服务继续运行。显式停止须核实所属服务与端口清理，并撤销两页租约；重启保留 resourceId 与 appPage，用新 AppInstance 和正确页面 URL 重新绑定。导入后的自动启动不无条件抢焦点；用户关闭对话框或切换空间后，迟到完成不得打开旧页面。

用户在编辑器保存后，需刷新或重新开始游戏验证副本中的地图变化。该手动保存没有 Agent TaskRun，不属于上文 P0 D 的 Agent-run diff，也不产生验证通过或用户接受记录。新增 Mota 受限 AI 任务只提供下述专用操作；任意代码修改、标准 App 控制工具和源码导出继续拒绝，标准/edu 的能力和预算不直接扩展到魔塔。当前不提供任意楼层、全编辑器文件写入或回写宿主原件。

`e2e/mota-app-live.spec.ts` 是手动接入的显式 opt-in 真实窗口验收入口，环境变量及命令见根 [AGENTS](../../AGENTS.md)。它要求临时源码副本、全新私有 profile、独立证据目录与指定已有 guest；仅原生目录选择响应自动提供，实际 Main/service/guest/Browser、编辑器保存、游戏输入及所属进程审计不 mock。打包模式只接受独立核验后原样复制的 runtime 描述，不合成 ready，也不证明 Setup UI。模型、导出、麦克风、Azure 与手动编辑的 D diff 均不在该用例覆盖范围；上一阶段实际输入、失败和结果保留于[整合记录](../acceptance/mota-integration-20261015/README.md)，不能替代新增 AI 接线的验证。

### Mota 专用 AI 工具与执行边界

Session 沿用确认任务与发送入口，默认不授予操作权限。`app.mota.play` 允许受限游戏状态/输入（含重新开始）；`app.mota.map.write` 额外允许固定地图改格，依赖 play。目标必须为当前 project 的运行 game 资源；Main 从实时 Browser 冻结 workspace、environment、project、AppInstance、run、session、resource、Browser instance/generation、webContents 和文档代次，不接受模型指定归属。Mota 任务不依赖 DOM 元素现场，旧版本不能借当前草稿新增权限。

R4 修复候选的 Mota 模型入口按能力未知拒绝启动。安装合同固定 `codex-cli 0.160.0`，但当前没有核验该二进制的 `exec` 原生工具集限制的有效回执；匹配版本、`--sandbox read-only`、提示词及 MCP 工具白名单都不能替代该证明。`SbxConnection.assertMotaCapability()` 对固定版本与其他/未知版本均返回 `mota_native_tools_unverified`，没有环境变量放行或提示词回退。service 在取得租约和调用 `chat.send` 前检查门禁，返回 `executorStarted: false` 的具名拒绝；`CodexChat.send` 与底层 Mota 启动也独立检查，拒绝时保留原会话、thread 和消息。标准/edu 对话及手动游戏/编辑器入口不受此门禁影响；这不宣称编辑器授权边界已通过 R6。

原有 Mota 启动路径保留独立只读 scratch、清除旧 threadId、禁止 resume、无 `wsl-app` CLI 回退等约束，但本树不会在原生限制未知时执行它。Mota MCP 现在恰好列出并接受四个专用工具，连只读 `list_resources` / `read_resource` 也拒绝；失去 socket 时不回退为资源工具。纯离线生命周期测试显式替代能力门禁，以验证事件和清理行为，不证明真实 Codex 支持该模式。恢复模型入口需要对固定二进制及实际 `exec` 参数/配置另行取得有效原生能力证据，再绑定启动配置；不能仅凭帮助文本或某个配置键未报错就宣布支持。

`item.started`、`item.updated`、`item.completed` 中的 `command_execution` 统一触发 `policy_violation`，禁止的 MCP 服务/工具及原生搜索同样失败。检测同步关闭后续派发、撤销在途调用信号并启动所属进程关闭；迟到工具结果或成功事件不能覆盖失败。关闭拒绝/完成链异常保留可见错误与未确认占用，旧轮次帧不污染新轮次。Main 等待模型、原生输入和租约分别确认，即使用户在此时点击停止，违规终态仍为失败而非取消；清理错误与违规原因同时保留，已有合法地图修改及回执不回滚、不丢弃。

事件检测是事后保护，不是执行前审批；只读执行策略及工具白名单不改变共享 guest 同 UID 文件系统本身的隔离边界。2026-10-15 的独立 OS 探针因 CLI 缺少 `--permission-profile` 在沙箱内探针执行前退出（内层 exit 2）；canary 未变及外层 sbx exit 0 不证明写入或网络已被阻断，也不能据此推导 `exec` 参数能力。

| 原生 MCP 工具       | Main 工具名         | 能力边界                                                          |
| ------------------- | ------------------- | ----------------------------------------------------------------- |
| `app_mota_state`    | `app.mota.state`    | 固定只读投影游戏状态、角色、地图与画布；不接受任意脚本或文件路径  |
| `app_mota_act`      | `app.mota.act`      | 固定 tile、continue、newGame、有限按键，经真实 CDP 输入并返回状态 |
| `app_mota_map_read` | `app.mota.map.read` | 读取本实例 MT1 的有界地图及 SHA-256                               |
| `app_mota_map_set`  | `app.mota.map.set`  | 额外 map scope 下，仅将 MT1 指定空格 `0` 改为金币 `53`            |

状态由 Main 的固定 `MotaPageDriver` 投影读取；动作校验当前实例、文档和画布后发送实际输入，不给模型 `evaluate`、角色赋值或内部移动/回放接口。开始新局通过真实页面加载与开始按钮，让游戏执行自身逻辑；返回的文档代次随之更新，旧请求不得继续写入。沿用用户接管、暂停与取消边界，动作不抢焦点。

地图写入走受管服务的精确 run 租约与单一写入者；请求带 expectedSha256，固定路径、当前散列和空格条件均需通过。重复 operationId 不重复应用，异载荷冲突拒绝；成功回执包含操作身份、改格以及前后散列。租约期间编辑器保存不能与 AI 写入竞争；恢复后过期编辑器须重新加载。取消、导航失效、App 更换或退出停止新动作并核对所属工具、模型和租约清理；未确认不能解除占用，已保存的改格不伪装为回滚。

Mota TaskRun 明确将标准源码 diff 标为 unavailable；地图修改保留独立操作回执，不生成 P0 D 的标准 App 前后 Git diff，也不自动标记 validation 通过或用户接受。`e2e/mota-agent-live.spec.ts` 将工具驱动（仅替代 Codex 进程）和真实模型分为两种互斥 opt-in 模式，均使用产品 dispatcher、受管服务和原生 Browser。当前只支持 build 验收。tools03 以 53/55 次工具调用通过；独立 model03 使用 build03 与真实原生 MCP，未替代模型进程，以 59/61 次调用完成普通/金币两次新局，各 12 个有序检查点通过：MT4 `(11,10)`、HP926、money7/14、coin0/1。MT1 仅 `(6,10)` 从 0 改为 53，两 run 自然 completed，所属 App、进程、端口和租约清理确认。产品会话确认、service 注册与取得/释放租约、CDP 及地图保存均走真实通路，只有原生目录响应自动提供。model03 的逐条采集回执完整，后续 UI 聚合输出仍触发记录上限，不能由此声明永久完整历史或 OS 隔离通过。tools01/02、model01/02 的失败链和独立结果见[本阶段验收](../acceptance/mota-ai-20261015/README.md)。

### 安装包中的标准应用

安装器配置与应用服务共用一个 `SbxConnection`；`runtimeTarget()` 只返回已初始化的 binary/sandbox，App 导入和端口操作不另行搜索 PATH。显式空配置保持不可用，不回退环境变量。Main 从包内 `runtime/dependencies.json` 派生只读模板依赖配置，校验模板源码、独立锁与归档后传给执行服务。损坏载荷在原设置页显示错误并禁止 sandbox 连接。模板存于包内 `templates/standard-app`，Linux ARM64/glibc 依赖包存于 runtime；归档准备审计实际 ELF、外来平台、必需 native 模块和执行位，并收集依赖许可。

窗口退出独立尝试安装操作与工作台/服务这一组清理；后一组先等 Main 取消运行和结束源码采集，再关闭 service，不能把这两步作为并发 owners。Main 清理失败后仍尝试 service 清理。service 内部先清理源码 helper，再逐项尝试受管应用、对话与环境资源清理，单一失败不会跳过其他所有者。成功后等待 Main 持久化队列回执再关闭。清理失败或等待超过 30 秒时，原生对话框显示具体原因，提供“重试清理”“取消退出”“仍然退出”，默认取消；取消保留窗口，但服务已进入关闭状态，不能继续新操作。超时不代表清理停止，重试等待在途尝试；实际失败后可重新尝试。只有明确选择“仍然退出”才允许未确认时退出本地应用，提示未确认进程可能继续运行，不把清理状态改成成功。异常注册表保留原文件并报错，不自动迁移或丢弃历史资源；持久化使用已验证的非空 sandbox 身份。实现与回归证据见[退出问题验证](../verification/2026-10-10-shutdown.md)。公开只读 origin 和受管 App 可写 origin 仍分别按精确实例 lease 校验。

2026-10-15 默认 E2E 首轮发现退出聚合错误丢失叶子原因，以及启动退出诊断把 Mota marker 策略错误用于 standard/edu。当前修复递归保留 AggregateError/cause 中的具体原因并处理循环引用；普通 standard/edu 启动仅附加有界 stderr 尾部，每次启动重置，不混入 stdout、验证输出或改变 Mota marker 限制。清理顺序、失败门禁和端口归属不变。定向回归及修复后 build04 默认窗口 E2E02 均通过，后者为 168 通过、22 跳过、0 失败；build03 的 model03 证据不代表 build04 已重跑模型。失败、修复、R3 根因未定的边界及回执见[本阶段验收](../acceptance/mota-ai-20261015/README.md)。

## 受管 App 控制面（2026-10-11 阶段 A）

设计、计划与取舍见[控制面设计](../design/2026-10-11-app-control-plane.md)、[实施计划](../plans/2026-10-11-app-control-plane.md)与 [ADR-0002](adr/0002-app-control-plane.md)；本轮验证结果见[验证记录](../verification/2026-10-11-app-control-plane/README.md)。

- 通道：guest MCP 的 `app_*` 保留观察的临时 Unix socket；每轮安装的 `wsl-app` CLI 通过 `WSL_APP_CHANNEL` 使用私有临时目录内四槽文件 IPC，适配仍禁止 socket 连接的 Codex 命令沙箱。两者合计共享 64 次/4 在途预算，CLI 只承载既有 `app.*`，不重试或回退，不调整沙箱权限。service `CodexChat` 把 `app.` 开头的调用改发 `app-call`，Main `ChatService` 交 `WorkbenchApplication.appControlForTurn`，唯一 dispatcher 为 `workbench/app-control.ts`。观察工具的路径与 `ObservationRecord` 不变。轮次清理先取消在途调用并释放通道、删除临时目录，再确认成功。
- 授权：`appControlContext` 只认 Main 冻结的轮次 scope，run 须为 `starting/running` 且非 `cancelling`；写操作另需请求 `appInstanceId` 等于当前运行实例、host 租约有效、未被用户暂停。除用于恢复的 `app.restart` 外，还需 manifest 与运行构建均不 stale；UI 写还需当前文档代次；`app.data.reset` 需任务版本 `allowedScopes` 含 `app.data.reset`。出队与异步修订读取后复核归属及取消；seed/reset 在能力查询及 pending 持久化完成后、实际派发前再次复核 run、实例、租约和用户暂停。若此时拒绝，只撤回本次确定未派发的记录；撤回持久化失败继续保留保护。run 结束时 dispatcher 中止该 run 的在途调用并解除 Browser 操控指示。
- 执行：L1 与前端 L2 由 `preview/app-ui.ts` 在受管 App 的同一 Browser `webContents` 上经 CDP 执行，页面函数固定、参数仅作 JSON 值；`WorkbenchHost.appUi` 只给 standard-app profile 下、`appBrowserProjects` 中当前租约有效的资源，edu/mota 不因持有浏览器租约获得此能力。L0/后端 L2 由 service `AppService.agent/logs` 执行：运行实例走回环 HTTP 与每次启动随机生成的实例令牌，停止时经 `app-helper.py` 的只读 `agent` 操作在 guest cwd 执行 agent-cli。
- 数据写入完成事实：Main 在派发 seed/reset 前持久保存 operationId、实例及原任务归属；模板声明 `operationTrackingVersion: 1`，按实例登记、去重和查询终态，记录最多 1024 条且不驱逐。取消先到留下墓碑，已开始的操作继续到真实终态；取消回执、断线或 not_found 不证明结束。取消保持 App 运行，立即及每秒核对，单轮最多 30 秒，未知继续阻止控制面写入、启动、重启和导出。原任务的 `reconcileRunCleanup` 可在无模型 scope 时再核对。
- 清理投影：TaskRun 保存独立模型执行事实，Conversation 与 TaskRun 合并模型、App 清理占用，全部确认前保持 `cancelling / cleanupPending`。CLI 未确认或异常保留句柄，应用进程或端口的成功不能覆盖它。`app-control/pending.json` 只持久保存身份、不保存令牌；重启不重放操作。旧模型进程缺少停止证据时，即使 App 已结清仍保留未知，不能借 App 终态宣称模型退出。
- 快照身份：元素引用必须为 `{ref, snapshotId}`，`{testid}` 形状不变。新成功快照原子替换引用表；失败、取消不覆盖旧成功表，导航、detach、实例更换使引用失效。数据库快照递归排序对象键并保留嵌套值与数组顺序，全部行参与散列，样本最多 20 行。
- 用户接管：`PreviewController.agentControl` 由 `input-event` 判定用户点击/输入并锁存 `paused_by_user`，经 `PreviewState.agentControl` 投影到 Browser 区指示；只有 renderer 的 `browserAction: resumeAgent` 能恢复。
- 重启导航：Main 内部 AI 重启完成后通过既有 `ensureBrowser` 重建受管网页实例，不激活 App 标签，也不恢复旧布局覆盖等待期间的新导航；用户显式 `startApp` 仍打开 App 网页。用户留在会话时可继续使用原“取消回复”按钮。
- 证据：审计与场景轨迹写在用户数据目录 `app-control/<runId>/`（追加 `audit.jsonl`，场景 `scenarios/<id>/trace.json`、`revision-check.json` 与截图排他创建）。轨迹固定起始 manifest 修订；结束时源码变化或无法核对，不能报告 passed。证据不进入 `workbench.json` 快照，不改变 TaskRun 的 validation 状态。
- 模板：standard-app 1.1.0 内建 registry/bridge、agent-cli、`/api/__agent` 与 manifest；受管启动对含 `build:agent` 的项目改用 agent 构建，旧 1.0.0 项目照旧生产构建并返回 `unsupported`。健康检查接受 1.0.0 与 1.1.0。
- 验证：修复后的 A03/A07 无模型 live 通过；[A11 真实模型与 Host 固定复验](../verification/2026-10-11-app-control-plane/round-09-model-live/README.md) 通过，真实 MCP describe、UI、state、query 链路已运行。[round-10](../verification/2026-10-11-app-control-plane/round-10-cli/README.md) 在保持 `workspace-write` 与 Main 权限不变的前提下改用 CLI 文件通道，真实命令沙箱 11 项检查（含两项 Main 拒绝）、MCP 及 Host 固定 16 步通过；所属进程、映射和通道清理确认。[round-11](../verification/2026-10-11-app-control-plane/round-11-cli-cancel/README.md) 通过实际产品按钮取消真实在途 CLI，核对 11 个所属进程退出、通道删除、45 个源码文件保留及下一轮真实 CLI 的迟到响应隔离；按钮为 Playwright 自动点击，返回帧延迟由测试启动层控制。
- 缺口：独立产品检查器仍未接入，测试内 Host 复验不写入 TaskRun 的 validation，也不构成用户接受；真人输入、安装包复验未在本轮执行；Expo（阶段 B）与 Android（阶段 C）未实现。

### edu 页面任务的候选写回

确认 edu 网页任务时，Main 将项目、运行实例、网页实例与文档代次、当前源码摘要及非 `admin/src/` 文件清单冻结到任务版本。执行沿用 CodexChat 和 GuestWorkspace：服务复查实例及源码后，将源码复制到独占候选目录，模型的 workspace-write 范围为该候选。完成回执之前先把完整候选保存到服务私有目录 `edu-task-candidates/<runId>.json`；取消及拒绝也保留，不纳入公共仓库证据。

Main 仅对同一执行、仍有效的网页与运行实例准备写回。准备阶段只读取源码、校验并暂存候选，且不占住 Main 元数据队列；取消、停止和导航仍可被处理。准备回执后 Main 重新读取实时网页和实例状态，并在没有 await 的同一同步片段中派发 commit，作为明确授权切点；切点之前失效不会写入。服务与 guest helper 在 commit 阶段再次核对源码摘要和保护清单，只替换 `admin/src/` 内容；源码竞争、保护文件变化及链接拒绝写回。无法导出安全清单的候选保留 guest 目录并返回诊断。写回完成不代表构建、验收或用户接受；需独立停止/重建和复验。实际 sandbox 对活动工程不可写仍需对应 live 负例验证。

`node scripts/edu-source.mjs verify --bundle <bundle>` 和 `merge` 现在接受产品的 `workbench-export`，严格校验 workbench 身份、导入基线及受保护文件。三方合并输出始终为 `manual-merge-candidate`，须重新导入并由产品导出后才能作为最终工作台制品。离线工具测试纳入 `pnpm test`。
