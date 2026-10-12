# 统一状态接口规格（修订 2）

基线 `917f375`。本文件定义状态的两层投影、键、通道、映射与调试通道。呈现规则见 [design.md](design.md)。修订原因逐条见 [review-response.md](review-response.md)。

## 1. 分层与落点

```
Main 快照 / ChatStatus / SetupSnapshot / ExecutionStatus
        │
        ▼
① projectFacts()   业务事实投影：纯函数，Main 与 Renderer 共用
        │  StatusFact[]
        ├──────────────► Main：转换计算 → debug:status / NDJSON
        ▼
② presentStatus()  展示投影：纯函数，仅 Renderer；输入 = 事实 + 展示状态
        │  StatusView[]
        ▼
useStatusView(scope) → StatusDot / StatusSlot / 标题栏按钮 / 诊断面板（Toast 只承载一次性失败，不来自事实）
```

| 层 | 职责 | 输入 | 落点 |
| -- | ---- | ---- | ---- |
| ① 业务事实 | 把已发布的业务快照翻译成带键的事实：phase、kind、label、动作、白名单 raw | 仅 Main 已发布的快照，不含任何界面状态 | `apps/desktop/src/shared/status/`（新模块，公开入口 `index.ts`） |
| ② 展示 | 决定每条事实此刻以哪条通道、哪个级别呈现；叠加历史选择、确认、一次性提示、界面错误 | 事实 + 展示状态（§6） | `apps/desktop/src/renderer/src/state/status-view.ts` |
| DTO | 跨进程传输的 `StatusFact`、`StatusTransition`、`DebugStatusSnapshot` schema | — | `packages/protocol/src/status.ts`，只含 schema 与类型 |

落点依据 `docs/ARCHITECTURE.md` §3：`packages/protocol` 只容纳跨进程 schema、DTO 与事件信封，不放文案、优先级或选择逻辑。`src/shared/status` 被 Main 与 Renderer 同时导入，需要把 `src/shared/**/*.ts` 加入 `tsconfig.node.json` 与 `tsconfig.web.json` 的 `include`；不依赖 React、Electron、Node API。它有两个真实消费者，不是通用框架。

两层都**只读**：不写回 Main，不持久化业务状态；展示状态是 Renderer 自有的 UI 状态，符合「业务状态单点写入，UI 只拥有展示状态」。组件不再自行判断状态，只调用 `useStatusView`。

## 2. 事实（第 ①层）

```ts
// packages/protocol/src/status.ts —— 仅 DTO
export type StatusPhase = 'idle' | 'pending' | 'active' | 'ok' | 'degraded' | 'failed' | 'unknown';
export type StatusKind =
  | 'progress'      // 进行中且可能需要等待或取消：执行中、取消中、连接中、启动中
  | 'control'       // 用户与 AI 的控制权：AI 操控中、已暂停
  | 'unresolved'    // 事实未确认：清理待确认、进程退出未确认、SSH 未确认
  | 'problem'       // 失败、已失效、断开、拦截、覆盖不完整
  | 'confirmation'  // 终态确认：已关闭且进程已确认退出
  | 'steady'        // 健康稳态：已连接、运行中、检查通过
  | 'capability';   // 能力说明，不是故障：比赛执行与验收服务尚未接入

export interface StatusFact {
  key: string;            // §3
  domain: StatusDomain;
  facet: string;          // 同一实体上的条件名；主状态为 'state'
  scope: StatusScope;
  phase: StatusPhase;
  kind: StatusKind;
  priority: number;       // 仅在同一通道内比较
  label: string;
  detail?: string;
  action?: StatusAction;
  instanceToken: string;  // 实体实例身份，用于确认失效，§6.3
  raw: StatusRaw;         // 按 domain 白名单定义的结构，§8
}

// apps/desktop/src/shared/status/index.ts
export function projectFacts(input: FactInput): StatusFact[];
export interface FactInput {
  snapshot: WorkbenchSnapshot | null;
  chat: ChatStatus | null;
  setup: SetupSnapshot | null;
  execution: ExecutionStatus | null;
}
```

映射表以 `satisfies Record<枚举, Mapping>` 声明，协议新增枚举值而未映射时编译失败。

## 3. 键

`key = <domain>:<entityId>:<facet>`。每个同时可能成立的条件有自己的 facet，因此同一实体的多个条件不会重键。React 列表 key、展示状态里的确认记录、Main 的转换计算都使用这个 key。

| domain | entityId | facet |
| ------ | -------- | ----- |
| `chat` / `setup` / `execution` / `storage` | `global` | `state`；setup 另有 `error`、`login`、`restart` |
| `web` | resourceId | `state`（loading）、`load-error`、`pick-error`、`blocked-nav`、`cdp`、`agent-control`、`picking`、`unavailable`、`console` |
| `terminal` | resourceId | `state`、`cleanup`、`unavailable`（输出缺口在第 ②层，见 §6） |
| `app` | workspaceId | `state`、`cleanup` |
| `run` | runId | `state`、`process-cleanup`、`app-cleanup` |
| `validation` | runId | `state`、`applicability` |
| `review` | runId | `state` |
| `context` | sessionId | `applicability`、`capture`、`history-restored` |
| `observation` | requestId | `state`、`coverage` |
| `file` | resourceId | `hint` |

测试要求：构造每个 domain 所有 facet 同时成立的输入，断言 key 两两不同；任一 facet 消失只影响自己的 key。

## 4. 映射（第 ①层）

`label` 即界面文案，尽量沿用合同与现有测试使用的措辞。kind 决定第 ②层的通道（§5）。

### 4.1 全局

| key | 条件 | phase | kind | label | 动作 |
| --- | ---- | ----- | ---- | ----- | ---- |
| `chat:global:state` | `null` | pending | steady | 正在读取对话状态 | — |
| | `available: true` | ok | steady | 对话可用（detail：版本 · 沙箱 · cwd） | — |
| | `available: false` | failed | problem | 对话不可用（detail：reason） | 查看设置 |
| `execution:global:state` | 任意 | idle | capability | 比赛执行与验收（T04）：尚未接入（detail：reason） | — |
| `setup:global:state` | `stage !== 'ready'` | degraded | problem | 比赛环境未就绪 | 打开安装 |
| `setup:global:error` | `error` | failed | problem | 环境安装出错（detail：message） | 打开安装 |
| `setup:global:login` | `pendingLogin` | active | progress | 等待 {provider} 登录完成 | — |
| `setup:global:restart` | `restartRequired` | degraded | problem | 设置已保存，重启后生效 | — |
| `storage:global:state` | `storageError` | failed | problem | 持久化失败：{storageError}。当前状态仅保留在内存中 | — |

`ExecutionStatus` 的 `available: false` 在基线中是固定返回值，含义是「固定比赛执行与验收服务（T04）尚未接入」，**不是**空间 Codex Runner 故障；Runner 可用性由 `ChatStatus` 报告（`main/execution.ts`、`protocol/execution.ts` 注释）。因此它是 `capability`：只在设置页按现状展示，不进 Toast、标题栏或状态槽，不提供动作。

### 4.2 终端

| key | 条件 | phase | kind | label | 动作 |
| --- | ---- | ----- | ---- | ----- | ---- |
| `terminal:<id>:state` | `idle` | idle | steady | 尚未连接 | 连接终端 |
| | `starting` | pending | progress | 正在连接… | — |
| | `running` | ok | steady | 已连接（detail：沙箱全名 · 绝对 cwd） | — |
| | `closing` | pending | progress | 正在关闭并核实进程… | — |
| | `closed` | idle | confirmation | 已关闭，所属进程已确认退出 | 连接终端 |
| | `failed` | failed | problem | 连接失败（detail：error） | 连接终端 |
| `terminal:<id>:cleanup` | `cleanupPending` 且 state ∈ {`failed`, `closed`, `idle`} | unknown | unresolved | 所属进程退出未确认 | — |
| `terminal:<id>:unavailable` | `unavailableReason` | degraded | problem | {unavailableReason} | — |

`cleanupPending` 在源码中表示「所属进程尚未确认退出」，进程存活期间始终为 true（`apps/service/src/terminal.ts` 启动时置位），因此只在进程应已结束的状态产出未确认事实；`starting` / `running` / `closing` 由 state 文案表达（运行同理，见 §4.5；实施期修订，用户确认）。SSH 断线后远端进程状态不明属于 `terminal:<id>:cleanup`（`unresolved`）：只要事实未变就持续显式，不因交互降级。此时「连接终端」动作为 `disabled`，与合同「重连明确拒绝」一致。

### 4.3 网页 `PreviewState`

| key | 条件 | phase | kind | label | 动作 |
| --- | ---- | ----- | ---- | ----- | ---- |
| `web:<id>:agent-control` | `active` | active | control | AI 正在操控此页面（{lastAction}）。你在页面中点击或输入会立即暂停 AI | — |
| | `paused_by_user` | degraded | control | 已暂停 AI 操控：检测到你在页面中的操作 | 允许 AI 继续 |
| `web:<id>:picking` | `picking` | active | progress | 选择中 · Esc 取消 | 取消选择 |
| `web:<id>:load-error` | `loadError` | failed | problem | 页面加载失败：{description} | 重新加载 |
| `web:<id>:pick-error` | `pickError` | failed | problem | 元素选择失败：{pickError} | — |
| `web:<id>:blocked-nav` | `blockedNavigation` | degraded | problem | 已拦截导航：{url 去除查询串} | — |
| `web:<id>:cdp` | `detached` | degraded | problem | 页面控制已断开 | 重新附着 |
| `web:<id>:unavailable` | `unavailableReason` | degraded | problem | {unavailableReason} | — |
| `web:<id>:state` | `loading` | active | steady | 正在加载 | — |
| `web:<id>:console` | `consoleIssueCount > 0` | degraded | steady | 页面有 {n} 条错误或警告 | — |

problem 内优先级：load-error > pick-error > cdp > blocked-nav > unavailable。

### 4.4 受管 App

| key | 条件 | phase | kind | label | 动作 |
| --- | ---- | ----- | ---- | ----- | ---- |
| `app:<ws>:state` | 无 `managedApp` | idle | steady | 尚未创建 App | 新建 App |
| | `created` / `stopped` | idle | steady | 已创建 / 已停止（实施期：「未启动」由可见的「启动应用」按钮表达，`e2e/workshop-actions.spec.ts` 精确断言「已创建」） | 启动应用 |
| | `starting` / `stopping` | pending | progress | 正在启动应用… / 正在停止应用… | — |
| | `running` | ok | steady | 服务运行中 | — |
| | `failed` | failed | problem | 应用运行失败（detail：error） | 管理 App |
| `app:<ws>:cleanup` | `cleanupConfirmed: false` 且 state ∈ {`failed`, `stopped`} | unknown | unresolved | 应用进程清理未确认 | — |

`workspace.app` 的名称与说明是内容，不是状态；名称在对话框首行加粗显示（对话框标题仍为「管理 App / 新建 App」），说明为空时不显示占位。服务端把清理未确认记为 `failed` + `cleanupConfirmed: false`（停止后清理未确认、注册表与重启恢复路径），因此 cleanup 事实同时覆盖 failed 与 stopped（实施期修订，用户确认）。失败时完整错误在对话框「错误详情」折叠区中作为内容提供。

### 4.5 运行

| key | 条件 | phase | kind | label | 动作 |
| --- | ---- | ----- | ---- | ----- | ---- |
| `run:<id>:state` | `starting` | pending | progress | 正在启动… | 取消回复 |
| | `running` | active | progress | 正在执行… | 取消回复 |
| | `cancelling` | pending | progress | 正在取消并核实退出… | — |
| | `completed` | ok | steady | 执行完成 | — |
| | `cancelled` | idle | steady | 已取消 | — |
| | `failed` | failed | problem | 执行失败（detail：error） | — |
| | `interrupted` | failed | problem | 执行中断 | — |
| `run:<id>:process-cleanup` | `cleanupPending` 且 state ∈ {`completed`, `cancelled`, `failed`, `interrupted`} | unknown | unresolved | 正在核实所属进程退出… | — |
| `run:<id>:app-cleanup` | `appCleanupPending` | unknown | unresolved | `executorState.cleanupPending === false` 时「模型已停止，App 数据操作仍待确认」；否则（含重启恢复时执行器状态缺失或未确认）「App 数据操作结果待确认」 | 重新核对（`cleanupRetryAvailable` 时出现，`cleanupReconciling` 时禁用） |

`run:<id>:state` 为 `cancelling` 与 `run:<id>:app-cleanup` 可同时成立，两条都显示，对应合同「会话保持取消中，行内显示模型已停止…」。

### 4.6 检查与审阅

| key | 条件 | phase | kind | label |
| --- | ---- | ----- | ---- | ----- |
| `validation:<id>:state` | `not_run` | idle | steady | 尚未检查 |
| | `running` | active | progress | 正在检查… |
| | `passed` | ok | steady | 检查通过 |
| | `failed` | failed | problem | 检查未通过（detail：reason） |
| | `blocked` | degraded | problem | 检查无法执行（detail：reason） |
| `validation:<id>:applicability` | `stale` | degraded | problem | 检查已不适用于当前版本 |
| | `unknown` | unknown | steady | 检查适用性未知 |
| `review:<id>:state` | `null` / `accepted` / `changes_requested` | idle / ok / idle | steady | 尚未审阅 / 已接受 / 已要求修改 |

### 4.7 会话上下文

| key | 条件 | phase | kind | label | 动作 |
| --- | ---- | ----- | ---- | ----- | ---- |
| `context:<sid>:applicability` | `current` | ok | steady | 现场适用性：有效 | — |
| | `stale` | degraded | problem | 现场适用性：已失效 | 重新选择元素 |
| | `unknown` | unknown | steady | 现场适用性：未知 | — |
| `context:<sid>:capture` | `pending` | active | progress | 正在采集… | 取消采集 |
| | `failed` | failed | problem | 采集失败（detail：error） | — |
| `context:<sid>:history-restored` | `historyRestored` | degraded | confirmation | 历史已恢复；新执行不会自动延续旧模型上下文。 | — |

查看历史版本时的「现场适用性：历史采集（不表示当前现场）」由第 ②层根据选择状态改写（§6.1），不属于业务事实。

### 4.8 观察与文件

| key | 条件 | phase | kind | label |
| --- | ---- | ----- | ---- | ----- |
| `observation:<req>:state` | `pending` | active | progress | 正在读取…（动作：取消读取） |
| | `failed` | failed | problem | 读取失败：{错误标签} |
| `observation:<req>:coverage` | `partial` | degraded | problem | 覆盖不完整（detail：reasons） |
| | `unknown` | unknown | problem | 覆盖情况未知 |
| | `complete` | ok | steady | 覆盖完整 |
| `file:<id>:hint` | 任一 change | degraded | problem | 文件可能变化 · {变化标签}；请重新读取 |

来源、环境、时间、范围与**版本 / 散列**属于结果元数据，不是状态：在结果的「来源」折叠区中显示（合同要求散列可见）。`evidenceRef` 等内部引用只在诊断面板。

错误标签与变化标签沿用修订 1 的对照（`unauthorized` 无权限、`stale_ref` 已过期请重新读取、`root_replaced` 根目录被替换等），实现时作为 `satisfies Record` 表。

## 5. 通道（第 ②层）

每个窗格的 StatusSlot 分三条通道，按 kind 分配：

| 通道 | kind | 规则 |
| ---- | ---- | ---- |
| **常驻通道** | `control`、`unresolved`、`progress` | **全部显示、不折叠、不因交互降级**；事实消失才消失。顺序 control > unresolved > progress。每条带自己的动作（允许 AI 继续、重新核对、取消回复）。 |
| **问题通道** | `problem` | 显示 priority 最高的一条，其余为「另有 N 项」可展开列表。 |
| **提示通道** | `confirmation`、展示层 hint | 同时只显示一条；被确认后消失（§6.3）。 |

`steady` → StatusDot（环境级）；`capability` → 设置页与诊断面板。全局（无窗格归属）的 problem 是持续条件，进**标题栏**（channel `titlebar`）：对话不可用为「Codex CLI · 对话不可用」，setup 类取最高优先级一条为「环境 · {label}」，均进入设置页；`storage` 进底部横幅。Toast 只承载一次性失败（界面操作失败、工作区命令错误）。（实施期修订，2026-10-11 用户确认：持续条件放进 Toast 会在开发与 E2E 默认环境常驻并遮挡输入区。）

由此，AI 操控提示、暂停后的「允许 AI 继续」、取消中与清理未确认**永远不会**被其他错误折叠或压过。

### 5.1 侧栏标签行尾（实施期补充）

侧栏标签行尾只画一个 StatusDot，由展示层 `tabStatus` 选出，与会话页的历史选择无关：

| 标签 | 取值 | 画点 |
| ---- | ---- | ---- |
| 会话 | 该会话最新 run 的 `run:<id>:state` | 进行中为缺口环、失败 / 中断为三角；完成、已取消、无 run 不画 |
| 终端 / SSH | `terminal:<id>:state` | 已连接为成功色实心点（决策 2）、连接中 / 关闭中为缺口环、失败为三角；`closed` / `idle` 但存在 `terminal:<id>:cleanup` 时为虚线环（所属进程退出未确认）；其余空闲不画 |
| 网页 | `web:<id>:load-error` / `pick-error` | 仅 failed 问题画三角；加载中、拦截、AI 操控等留在窗格状态槽 |
| 文件 | — | 不画 |

状态文字以视觉隐藏文本输出，并作为标签按钮的 `aria-describedby`；按钮名称保持标签标题。

## 6. 展示状态（第 ②层输入）

Renderer 新增 `statusPresentationStore`（UI 自有状态），组件只能通过下列具名动作写入：

```ts
interface PresentationState {
  selections: Record<SessionId, { taskVersionId?: string; runId?: string }>;
  acks: Record<StatusKey, string>;            // key → 确认时的 instanceToken
  hints: Hint[];
  terminalGaps: Record<ResourceId, { instanceId: string; sessionId: string }>;
  uiErrors: UiError[];                        // 原 errorStore
  workspaceError: string | null;              // 原 workspaceStore.error
  occlusion: readonly string[];
}
interface Hint {
  key: string;                                // ui:<resourceId|sessionId>:<name>
  scope: StatusScope;
  label: string;
  source: 'capture-guidance' | 'bookmark' | 'snapshot' | 'reference' | 'first-use';
  until: 'ack' | 'navigation';
}
```

### 6.1 历史选择

Session 的版本 / 运行选择从组件局部 state 移入 `selections`。第 ②层：存在选择时，该会话的 run / validation / review 视图取所选运行；`context:<sid>:applicability` 改写为「现场适用性：历史采集（不表示当前现场）」，kind 改为 steady。选择不存在或所选运行已不在快照中时，显示「指定历史记录已不可用」problem（现有文案）。

### 6.2 一次性提示

Browser 的采集指引、收藏结果、保存快照结果、Files 首次说明等不再由组件局部 state 渲染，改为 `hint()` 写入，`until: 'ack'` 的在用户点击关闭或与该窗格交互后清除，`until: 'navigation'` 的在切换标签 / 空间时清除。

### 6.3 确认与失效

- `confirmation` 事实在用户与所在窗格交互（pointerdown、keydown、标签激活）时记录 `acks[key] = fact.instanceToken`。
- `instanceToken` 由第 ①层给出：终端为 `instanceId:sessionId`，运行为 `runId`，网页为 `instanceId:documentGeneration`，上下文的 applicability / capture 为 `sessionId:captureRequest.requestId`，history-restored 为 `sessionId`（与采集无关，确认后不因新采集重现）。实例更换后 token 变化，旧确认自动失效，新的确认事实重新显示。
- 切换空间清除不属于新空间的 `until: 'navigation'` hint；会话从快照消失时删除其 `selections`；终端实例或 PTY 会话变化时删除 `terminalGaps` 项（与现有 `terminalDelta` 重建同时发生）。

### 6.4 接口

```ts
export function presentStatus(facts: readonly StatusFact[], state: PresentationState): StatusView[];
export interface StatusView extends StatusFact {
  channel: 'persistent' | 'problem' | 'notice' | 'ambient' | 'titlebar' | 'banner' | 'settings';
  visible: boolean;        // 问题通道折叠项为 false
}
export function useStatusView(scope: StatusScope): { persistent: StatusView[]; problem: StatusView | null; more: StatusView[]; notice: StatusView | null; ambient: StatusView[] };
```

## 7. 动作

`StatusActionId` 只映射到现有命令或现有界面动作，执行时使用事实里冻结的 scope：

| id | 执行 |
| -- | ---- |
| `terminal.connect` | `terminalOpen` |
| `web.reload` / `web.reattach` / `web.resumeAgent` | `browserAction: reload / reattach / resumeAgent` |
| `web.cancelPick` | `cancelContextCapture` |
| `run.cancel` | `cancelRun` |
| `run.reconcileCleanup` | `reconcileRunCleanup` |
| `context.recapture` | `captureContext` |
| `observation.cancel` | 现有观察取消 |
| `app.start` / `app.manage` / `app.create` | `startApp` / 打开 ManagedAppDialog / `openAppEditor` |
| `nav.settings` / `nav.setup` | 进入设置页（首版不定位到区块，实施期确认） |

## 8. 调试通道与数据边界

### 8.1 启用条件

`debugStatusEnabled = rendererSource().kind === 'dev-server' || process.env.WSL_DEBUG_STATUS === '1'`

- 「开发构建」指 `pnpm dev` 的开发服务器（沿用 `main/window.ts` 现有判定）。E2E 使用的 `pnpm build` 产物虽未打包，但不是开发服务器，**默认关闭**，因此 `workspace-debug.spec.ts:7` 的六键断言不变。
- 正式包默认关闭；显式设置 `WSL_DEBUG_STATUS=1` 才开启。
- 未启用时不注册 `debug:status` 通道，不出现菜单项，preload 不增加 `debug` 键。Main 通过 `webPreferences.additionalArguments: ['--wsl-debug-status']` 告知 preload。

### 8.2 raw 白名单

`raw` 不是任意对象：每个 domain 在 `packages/protocol/src/status.ts` 中有严格 schema，只允许下列字段，其余一律不进入。

| domain | 允许字段 |
| ------ | -------- |
| web | `instanceId`、`documentGeneration`、`cdpState`、`agentControlState`、`loadErrorCode`、`consoleIssueCount` |
| terminal | `instanceId`、`sessionId`、`state`、`cleanupPending`、`environmentId`、`outputOffset` |
| app | `appInstanceId`、`projectId`、`state`、`cleanupConfirmed`、`guestPort` |
| run | `state`、`cleanupPending`、`appCleanupPending`、`executorState`、`cleanupRetryAvailable`、`cleanupReconciling`、`taskVersionId` |
| validation / review | `state`、`applicability`、`decision`、`candidateId` |
| context | `applicability`、`captureRequestId`、`captureState` |
| observation / file | `tool`、`state`、`coverageStatus`、`revisionStrength`、`errorCode`、`change` |
| chat / setup / execution | `available`、`stage`、`busy`、`errorCode`、`harnessState`、`restartRequired` |

明确排除：页面截图与 PageCapture、终端输出、消息正文与草稿、文件内容、观察结果正文、凭据与环境变量、完整 URL 查询串与片段。

### 8.3 三种出口的边界

| 出口 | 内容 | 处理 |
| ---- | ---- | ---- |
| 诊断面板（内存） | 事实 + 白名单 raw + 转换；另可在面板内按需查看当前会话的 PageCapture | PageCapture 来自 Renderer 已有的会话快照，只在面板内显示，标注「不可导出」，不进入复制或日志 |
| 复制 JSON / 导出 | 事实 + 白名单 raw + 转换 | 经 §8.4 脱敏 |
| NDJSON（`WSL_STATUS_LOG`） | 首行 `snapshot`（仅事实，不含 WorkbenchSnapshot），后续 `transition` | 经 §8.4 脱敏；大小上限 §8.5 |

### 8.4 脱敏

- URL：保留协议、主机、路径；去掉查询串与片段；`file:` URL 按本地路径处理。
- 本地路径：家目录替换为 `~`；授权根内路径改为相对根路径。
- SSH 主机与用户：替换为 `ssh:<sha256 前 8 位>`。
- `label` / `detail` / 错误文本：截断至 300 字符；匹配私钥块、OpenAI / GitHub token、AWS access key 的片段替换为 `[redacted]`（与 `publication-scan` 相同的四组模式）。
- ID（runId、instanceId 等随机标识）保留，排障需要。

### 8.5 大小

| 项 | 上限 |
| -- | ---- |
| `label` | 120 字符 |
| `detail` | 300 字符 |
| 单条 `raw` 序列化 | 2 KiB，超出截断并标 `truncated: true` |
| 转换环形缓冲 | 500 条 |
| NDJSON 文件 | 5 MiB；到达上限写一行 `{"type":"limit"}` 后停止写入，不轮转、不删除 |

日志写入失败只记录一次 Main 错误并停用，不影响应用。

### 8.6 协议

```ts
// invoke 'debug:status'
interface DebugStatusSnapshot { appInstanceId: string; seq: number; generatedAt: string; facts: StatusFact[]; transitions: StatusTransition[] }
// event 'debug:status'
interface StatusTransition { key: string; from: { phase; kind; label } | null; to: { phase; kind; label } | null; at: string; seq: number }
// preload，仅启用时
studio.debug = { status(): Promise<DebugStatusSnapshot>; onTransition(listener): () => void; onTogglePanel(listener): () => void };
// event 'debug:panel'（payload 'toggle'）：菜单「诊断」（CmdOrCtrl+Alt+Shift+D）通知 Renderer 切换面板；与 debug:status 一样只在启用时注册。
// 首版面板提供「复制 JSON」；mockups 中的「暂停刷新」「导出 NDJSON」按钮不做，NDJSON 由 WSL_STATUS_LOG 开启。
```

## 9. DOM 约定

- 每个状态元素带 `data-status="<domain>:<phase>"`、`data-status-key="<key>"`、`data-status-channel="<channel>"`。
- 环境级 `label` 以 `sr-only` 视觉隐藏文本输出（进入屏幕阅读器与 `textContent`）。
- 常驻与问题通道的条目**视觉可见**，验收用 `toBeVisible()` 与键盘可达性断言，不只用 `data-status` 或隐藏文本（plan.md §5）。
- 输入框可访问名称不变：Session 仍为 `aria-label="会话消息"`，「发送到 · …」改为 `aria-describedby` 指向的视觉隐藏描述；Composer 的 `<label>` 保留为视觉隐藏，名称不变。

## 10. 文件布局（计划）

| 文件 | 内容 |
| ---- | ---- |
| `packages/protocol/src/status.ts` | DTO 与 raw 白名单 schema；`debug:status` 通道 schema 加入 `ipc.ts` |
| `apps/desktop/src/shared/status/index.ts`、`facts.ts`、`facts.test.ts`、`redact.ts`、`redact.test.ts` | 第 ①层与脱敏 |
| `apps/desktop/src/renderer/src/state/status-view.ts`、`status-view.test.ts` | 第 ②层、展示状态 store |
| `apps/desktop/src/renderer/src/components/Status.tsx` | StatusDot、StatusSlot（三通道） |
| `apps/desktop/src/renderer/src/shell/DebugPanel.tsx`、`state/debug.ts`、`state/debug.test.ts` | 诊断面板与其展示状态 |
| `e2e/debug-status.spec.ts` | 启用矩阵、通道、面板与日志 E2E |
| `apps/desktop/src/main/debug-status.ts`、`.test.ts` | 转换、缓冲、NDJSON、大小上限 |
| `apps/desktop/tsconfig.node.json`、`tsconfig.web.json` | `include` 增加 `src/shared/**/*.ts` |
