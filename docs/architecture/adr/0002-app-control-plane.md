# ADR-0002：受管 App 控制面的工具命名空间与 dispatcher 落点

状态：已采纳，2026-10-11。适用范围：[受管 App 控制面设计](../../design/2026-10-11-app-control-plane.md)阶段 A（standard-app Web），阶段 B/C 沿用。

## 背景

guest Codex 已能经每轮临时 Unix socket 调用 `workspace.list_sources`、`browser.*`、`files.*`、`terminal.*` 等只读观察工具，路径为 guest MCP → guest-helper → service `CodexChat` → Main `observeForTurn`。这些工具的合同是只读：MCP 说明写明“no actions or arbitrary code are accepted”，Main 把每次调用记为 `ObservationRecord`，`browser.*` 对演示页、公开只读文档和受管 App 一视同仁。

控制面需要写动作（UI 动作、App 命令、数据 seed/reset、场景回放），而且只能作用于当前空间正在运行的受管开发实例。授权所需事实——活动 TaskRun、任务版本授权标记、受管 App 状态、实例租约、Browser 资源与文档代次——全部由 Main `WorkbenchApplication` 持有；CDP 只在 Main；guest 进程、sbx 与 App 回环地址只在 service。

## 决定

1. **新增 `app.*` 命名空间，不扩展 `browser.*`。** `app.ui.snapshot` 与 `browser.snapshot` 分开：前者只针对受管 App，返回带 testid、可见/禁用状态的短引用（`e12`），引用绑定 `appInstanceId` 与文档代次；后者保持现有资源通用的只读合同、引用格式与预算。截图和运行事件继续使用 `browser.screenshot`/`browser.read_events`，场景运行器在 Main 内复用同一 `BrowserObservation`。这样既有工具的行为和权限（R01）不变，读写边界也能从工具名直接判断。
2. **唯一 dispatcher 放在 Main `apps/desktop/src/main/workbench/app-control.ts`。** 它负责工具输入校验、授权、风险分级、调用表、取消、审计和场景运行，不导入 Electron；授权上下文由 `WorkbenchApplication` 在元数据队列中计算并冻结。执行器经 `WorkbenchRuntime` 端口注入：host 的 CDP 驱动（`preview/app-ui.ts`）和经 ChatService 转发到 service `AppService` 的 HTTP/agent-cli 执行。service 只做帧路由与执行，不持有 run 或授权状态。
3. **通道复用。** guest MCP socket 与 guest→service 帧格式不变；service 对 `app.` 开头的工具发 `app-call` 帧，Main 以 `app.reply` 回复；Main 调 service 使用 `app.agent`、`app.logs`、`app.agent.cancel` 请求。2026-10-11 round-10 修订：真实 Codex 命令沙箱拒绝 socket connect，因此 `wsl-app` 显式使用每轮私有临时目录内的四槽文件 IPC；它与 MCP 合计共享 64 次/4 在途预算、同一 scope、dispatcher 与审计。不放宽网络或文件权限，不自动回退或重放副作用。具体传输、取消与验证见[round-10](../../verification/2026-10-11-app-control-plane/round-10-cli/README.md)。
4. **页面内调用只走固定 bridge 入口。** Main 以源码中固定的函数调用 `window.__WSL_AGENT__.call`，Agent 输入只作为 JSON 值；不提供任意 `Runtime.evaluate`、坐标或选择器脚本。

## 备选与理由

- **在 `browser.*` 中增加 `browser.act`**：复用最多，但把写能力混入一个同时服务公开只读文档的资源通用命名空间，读写边界需要逐参数判断，R01 的“权限不变”难以证明。不选。
- **dispatcher 放在 service**（任务说明的初始设想）：service 必须先回调 Main 取得 run/租约/任务授权，再请 Main 执行 CDP，一次写动作要两次跨进程往返，授权事实与执行时点分离，迟到结果与取消也要在两处判断；还会让 service 开始持有任务语义，违背 ADR-0001 修订后“Main 唯一业务事实、service 只承载适配器”的分工。故改为 Main，service 保留执行与传输职责。
- **通过 `observe()` 管道承载 `app.*`**：会把写调用记成观察记录并受观察的只读校验约束，语义不符。不选；只复用其冻结 scope 与 socket。

## 后果

- 新工具的 schema 先在 `packages/protocol/src/app-control.ts` 定义，Main 与 service 在各自边界校验。
- Main 增加一个应用层模块和一个 CDP 适配器；`WorkbenchApplication` 只增加提供授权上下文与释放 run 的公开入口，不承载控制面逻辑。
- 控制面调用不进入 `ObservationRecord` 窗口，审计另存为每 run 的追加日志与场景证据；观察的 64 次/4 在途预算由 guest 与 service 共同计数。
- 阶段 B（Expo Web）直接复用；阶段 C（Android）在 Main dispatcher 下增加 `surface: 'android'` 执行器，不新增 dispatcher。
