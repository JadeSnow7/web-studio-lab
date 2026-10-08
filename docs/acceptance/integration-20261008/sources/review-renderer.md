# Renderer、测试与工具链审查

审查基准为 `9e1df45d9ea42a9bf5df76a1babf451e5cafc530` 的冻结副本。下表记录逐文件审查对象及断言索引；索引不等于逐项执行通过，Main/service/protocol 实现由主线程独立审查。Phase1/Phase2 更改另行补评。

## 文件覆盖范围

|类别|文件|审查范围|
|---|---|---|
|toolchain|`apps/desktop/electron-builder.yml`|执行入口/环境门槛、产物路径、具名配置与离线/live范围|
|toolchain|`apps/desktop/package.json`|执行入口/环境门槛、产物路径、具名配置与离线/live范围|
|tests|`apps/desktop/src/main/chat-service.test.ts`|断言与触发条件审核：send ACK 后服务退出仍推送不可用与会话失败; 终端活动期间服务退出必须发布未知清理失败并拒绝伪成功关闭; 模型失败但cleanup已有确认时服务退出不阻止关闭; terminal open ACK本身是权威快照，服务退出不得遗漏未清理会话|
|tests|`apps/desktop/src/main/ipc-guard.test.ts`|断言与触发条件审核：开发模式只信任 dev server origin; 打包后只信任 renderer/index.html 本身; 接受主窗口顶层工作台页面; 拒绝 Browser 区视图、子 frame 与未知来源|
|tests|`apps/desktop/src/main/ipc-resources.test.ts`|断言与触发条件审核：accepts only stable resource identity; renderer cannot inject captured content; rejects a preview webContents even when it knows a valid command; does not turn navigation capture failure into a successful save; rejects the retired space-chat slot and dynamic slots on every legacy chat command|
|tests|`apps/desktop/src/main/preview/controller-construction.test.ts`|断言与触发条件审核：|
|tests|`apps/desktop/src/main/preview/controller-migration.test.ts`|断言与触发条件审核：closed; message; forwards native focus without layout updates manufacturing focus; focus|
|tests|`apps/desktop/src/main/preview/controller-resource.test.ts`|断言与触发条件审核：did-start-navigation; did-navigate; 公开页面保持无 preload 的 sandbox 与隔离，不扩大窗口或子框架权限; will-frame-navigate|
|tests|`apps/desktop/src/main/preview/preview-pure.test.ts`|断言与触发条件审核：按 scheme + host 比较自定义协议; 拒绝其他 host、其他协议与无效地址; 端口不同视为不同来源; 映射到目录内文件，目录请求补 index.html|
|tests|`apps/desktop/src/main/preview/public-document.test.ts`|断言与触发条件审核：仅 HTTPS 默认端口且没有用户凭据; 拒绝私网、保留网、IPv4 映射及转换网段; DNS 的所有地址都必须是公网，连接固定到已校验的 IP; 解析与请求受同一取消期限约束|
|tests|`apps/desktop/src/main/preview/public-protocol.test.ts`|断言与触发条件审核：源页面和子资源不能绕过 GET 主框架 broker，另一个 webContents 也不能复用; allows only the owning DevTools bundled GET frontend, never another view or remote resource; 跳转先通知浏览器最终 URL，只有最终 URL 响应才能成为可捕获文档; 导航中的晚到响应不能恢复旧文档|
|tests|`apps/desktop/src/main/preview/public-request.test.ts`|断言与触发条件审核：保留 URL 主机和默认 TLS 校验，单 IP lookup 不触发地址族重选，忽略浏览器凭据; data; end|
|tests|`apps/desktop/src/main/window-close.test.ts`|断言与触发条件审核：closes after confirmed guest cleanup even when workbench initialization failed; keeps the window open when guest cleanup remains unconfirmed|
|tests|`apps/desktop/src/main/workbench/application.test.ts`|断言与触发条件审核：restores business records from old snapshots while discarding per-space sidebar preferences; rejects stale draft revision and does not overwrite newer text; does not expose or later persist a failed metadata mutation; deduplicates runtime side effects and rejects changed payloads|
|tests|`apps/desktop/src/main/workbench/host-migration.test.ts`|断言与触发条件审核：resolves menu reload/devtools from active pane instead of the last layout; forwards focus with immutable workspace/resource/instance/generation ownership; disposes and removes a controller if initial loading throws, then permits retry; binds capture to the native page at operation start and saves only that returned snapshot|
|tests|`apps/desktop/src/main/workbench/layout.test.ts`|断言与触发条件审核：focuses an already visible tab without duplicating it; closing a pane removes only that view; closing a tab leaves an empty pane; rejects a fifth pane and duplicate visible tabs|
|tests|`apps/desktop/src/main/workbench/migration-followup.test.ts`|断言与触发条件审核：R6 reload returns local snapshot while public resource refresh stays pending; R3 reloads the just-focused native browser without an intervening snapshot drain|
|tests|`apps/desktop/src/main/workbench/migration-regressions.test.ts`|断言与触发条件审核：R5 does not publish a failed browser instance and retries the next command; R6 permits local history when external session registration is unavailable; R6 coalesces explicit initialization retry after a repository failure; R4 carries request identity through pick and refuses replaced capture callbacks|
|tests|`apps/desktop/src/main/workbench/public-resources-migration.test.ts`|断言与触发条件审核：deduplicates a pending command retry without another capture or collection mutation; preserves the previous collection on failure, shows the cause, and clears it after explicit retry; does not inherit, rename or operate on TaskFlow public resources in another workspace|
|tests|`apps/desktop/src/main/workbench/recovery-facts.test.ts`|断言与触发条件审核：persists interrupted run and cancelled capture once, preserving fact time and receipt across two read-only restarts; exposes a recovery save failure while preserving original bytes and avoiding initialization or execution replay|
|tests|`apps/desktop/src/main/workbench/repository.test.ts`|断言与触发条件审核：rejects corrupt and future schema without overwriting original bytes; treats only a missing file as new workspace|
|tests|`apps/desktop/src/main/workbench/run-notification-migration.test.ts`|断言与触发条件审核：extracts only the current turn from cumulative same-generation messages and tools; keeps viewing, reading, validation and review separate and persists only notification receipts; rejects a mismatched session/run locator without changing the active space; rejects structurally valid logs owned by a different session and leaves the file intact|
|tests|`apps/desktop/src/main/workbench/runtime-outcomes.test.ts`|断言与触发条件审核：reports pending until screenshot completion and publishes completion for exactly that request; keeps an old failure/cancellation from changing the replacement request outcome; preserves confirmed terminal output and cleanup on failure, rejecting duplicate and old sequence updates|
|implementations|`apps/desktop/src/renderer/index.html`|presentation primitives、React/Node boundary、引用与状态使用，未发现独立业务写入口|
|implementations|`apps/desktop/src/renderer/src/App.tsx`|六页mount生命周期、系统主题、native occlusion集合、菜单事件与地址目标|
|implementations|`apps/desktop/src/renderer/src/components/Badges.tsx`|presentation primitives、React/Node boundary、引用与状态使用，未发现独立业务写入口|
|implementations|`apps/desktop/src/renderer/src/components/Icon.tsx`|presentation primitives、React/Node boundary、引用与状态使用，未发现独立业务写入口|
|tests|`apps/desktop/src/renderer/src/demo/runScenarios.test.ts`|断言与触发条件审核：全部符合协议，且都标记为 demo; 每个演示入口都有对应记录; 工具故障记为无法判断，不出现业务失败的检查结果; 取消中的记录仍有未退出进程；已取消的记录全部退出|
|implementations|`apps/desktop/src/renderer/src/demo/runScenarios.ts`|presentation primitives、React/Node boundary、引用与状态使用，未发现独立业务写入口|
|implementations|`apps/desktop/src/renderer/src/demo/sampleData.ts`|presentation primitives、React/Node boundary、引用与状态使用，未发现独立业务写入口|
|implementations|`apps/desktop/src/renderer/src/env.d.ts`|presentation primitives、React/Node boundary、引用与状态使用，未发现独立业务写入口|
|implementations|`apps/desktop/src/renderer/src/lib/store.ts`|presentation primitives、React/Node boundary、引用与状态使用，未发现独立业务写入口|
|implementations|`apps/desktop/src/renderer/src/lib/time.ts`|presentation primitives、React/Node boundary、引用与状态使用，未发现独立业务写入口|
|implementations|`apps/desktop/src/renderer/src/lib/viewport.ts`|presentation primitives、React/Node boundary、引用与状态使用，未发现独立业务写入口|
|implementations|`apps/desktop/src/renderer/src/main.tsx`|presentation primitives、React/Node boundary、引用与状态使用，未发现独立业务写入口|
|implementations|`apps/desktop/src/renderer/src/pages/ConversationsPage.tsx`|独立个人chat/draft与演示contacts范围|
|implementations|`apps/desktop/src/renderer/src/pages/HomePage.tsx`|个人输入与Main空间卡片、新空间editor来源|
|implementations|`apps/desktop/src/renderer/src/pages/ResourcesPage.tsx`|Main集合投影、显式page匹配、removeConfirm失败保留、个人隔离|
|implementations|`apps/desktop/src/renderer/src/pages/SettingsPage.tsx`|空间主题唯一入口、CLI环境事实与能力unknown|
|implementations|`apps/desktop/src/renderer/src/pages/SpacePage.tsx`|presentation primitives、React/Node boundary、引用与状态使用，未发现独立业务写入口|
|implementations|`apps/desktop/src/renderer/src/pages/TasksPage.tsx`|全空间只读历史及原会话定位、demo独立|
|implementations|`apps/desktop/src/renderer/src/shell/ChatMessages.tsx`|presentation primitives、React/Node boundary、引用与状态使用，未发现独立业务写入口|
|implementations|`apps/desktop/src/renderer/src/shell/Composer.tsx`|个人接收方、IME Enter与pending、发送后focus|
|implementations|`apps/desktop/src/renderer/src/shell/Overlays.tsx`|dialog初始/回收focus、确认失败可见与busy禁止cancel|
|implementations|`apps/desktop/src/renderer/src/shell/RightPanel.tsx`|未读数、pin显隐、Esc top-source及打开通知的focus|
|implementations|`apps/desktop/src/renderer/src/shell/TitleBar.tsx`|presentation primitives、React/Node boundary、引用与状态使用，未发现独立业务写入口|
|implementations|`apps/desktop/src/renderer/src/shell/Workshop.tsx`|全局rail与空间标签组、hover160/300ms、focus内保留、取消timer|
|implementations|`apps/desktop/src/renderer/src/shell/routes.ts`|presentation primitives、React/Node boundary、引用与状态使用，未发现独立业务写入口|
|tests|`apps/desktop/src/renderer/src/state/capture.test.ts`|断言与触发条件审核：opens the target before capture, and after screenshot completion locates the frozen owner; replacement creates a new request ID and cancellation identifies only that request; failed target opening releases ownership and never starts picking; failed capture receipt releases completion subscription|
|implementations|`apps/desktop/src/renderer/src/state/capture.ts`|采集请求identity替换/取消、receipt完成route、unsubscribe|
|tests|`apps/desktop/src/renderer/src/state/chat.test.ts`|断言与触发条件审核：旧查询与 reset 前的迟到事件不能覆盖新会话; 个人与空间消息互不迁移|
|implementations|`apps/desktop/src/renderer/src/state/chat.ts`|个人chat seq/pending错误、reset晚到消息及scope|
|tests|`apps/desktop/src/renderer/src/state/drafts.test.ts`|断言与触发条件审核：全局输入保持个人作用域，不沿用后台空间; 个人会话目录不包含空间可写入口; 首页输入只指向个人会话; 不同会话的草稿互不替换|
|implementations|`apps/desktop/src/renderer/src/state/drafts.ts`|personal-only reception与分会话草稿|
|implementations|`apps/desktop/src/renderer/src/state/errors.ts`|有界可见错误、transport invoke-prefix净化|
|implementations|`apps/desktop/src/renderer/src/state/execution.ts`|presentation primitives、React/Node boundary、引用与状态使用，未发现独立业务写入口|
|implementations|`apps/desktop/src/renderer/src/state/location.ts`|原workspace/session/version/run身份和导航token|
|tests|`apps/desktop/src/renderer/src/state/occlusion.test.ts`|断言与触发条件审核：blocks layout while waiting, publishes only after confirmed hide, keeps other sources active; does not expose a failed or cancelled opening and does not clear another source|
|implementations|`apps/desktop/src/renderer/src/state/occlusion.ts`|pending即block、await hide ACK、token取消与多源top|
|tests|`apps/desktop/src/renderer/src/state/panels.test.ts`|断言与触发条件审核：starts with a docked left panel and collapsed notification, restores only pin preferences; opening does not pin, closing preserves pin, unpinning collapses, narrow projection preserves preference|
|implementations|`apps/desktop/src/renderer/src/state/panels.ts`|pinned/hidden/peek pure projection与仅pin restore|
|tests|`apps/desktop/src/renderer/src/state/shell.test.ts`|断言与触发条件审核：⌘B 只切换显隐，不改变固定; 未固定时 ⌘B 打开或关闭临时覆盖层; 悬停展开不影响已固定的布局; 在覆盖层里固定后进入布局|
|implementations|`apps/desktop/src/renderer/src/state/shell.ts`|pin独立持久化、close显隐、pending取消、focus独立|
|implementations|`apps/desktop/src/renderer/src/state/space-ui.ts`|switcher/menu/editor barrier交接与trigger恢复|
|implementations|`apps/desktop/src/renderer/src/state/ui.ts`|presentation primitives、React/Node boundary、引用与状态使用，未发现独立业务写入口|
|tests|`apps/desktop/src/renderer/src/state/workspace.test.ts`|断言与触发条件审核：资源业务错误仅消费Main投影，失败保留集合，成功重试清Main错误; 资源成功不能清除并发无关命令的错误，即使文案相同; 定位不被旧草稿队列延迟，随后切空间不会被迟到定位覆盖; 初始权威快照恢复所选空间，旧seq及旧epoch事件不能覆盖|
|implementations|`apps/desktop/src/renderer/src/state/workspace.ts`|seq/epoch投影、按workspace metadata queue、navigation token、blocked browserLayout|
|implementations|`apps/desktop/src/renderer/src/styles/app.css`|presentation primitives、React/Node boundary、引用与状态使用，未发现独立业务写入口|
|implementations|`apps/desktop/src/renderer/src/workbench/RunViews.tsx`|historicaldemo原始data仅显示；报告状态不映射真实Main结果|
|implementations|`apps/desktop/src/renderer/src/workspace/Browser.tsx`|实际host geometry同步、显式会话采集、native show/hide与公开快照入口|
|implementations|`apps/desktop/src/renderer/src/workspace/Notifications.tsx`|通知原空间/session/taskVersion/run定位，markRead与执行审阅独立|
|implementations|`apps/desktop/src/renderer/src/workspace/Panes.tsx`|presentation primitives、React/Node boundary、引用与状态使用，未发现独立业务写入口|
|implementations|`apps/desktop/src/renderer/src/workspace/RunDetails.tsx`|真实run消息/evidence缺口明确，不伪造diff/检查通过|
|implementations|`apps/desktop/src/renderer/src/workspace/Session.tsx`|草稿串行保存、不可变任务确认、run/history/version选择、采集与检查审阅|
|implementations|`apps/desktop/src/renderer/src/workspace/Sidebar.tsx`|固定/正常标签排序、拖拽、键盘导航、关闭资源重开|
|implementations|`apps/desktop/src/renderer/src/workspace/SpaceSwitcher.tsx`|混合搜索、结果按workspace/tab身份定位、modal和focus|
|implementations|`apps/desktop/src/renderer/src/workspace/Terminal.tsx`|实例绑定input/resize、output reset、主题与focus恢复；输出淘汰复位将在观察适配时复核|
|implementations|`apps/desktop/src/renderer/src/workspace/icons.ts`|presentation primitives、React/Node boundary、引用与状态使用，未发现独立业务写入口|
|toolchain|`apps/desktop/tsconfig.node.json`|执行入口/环境门槛、产物路径、具名配置与离线/live范围|
|toolchain|`apps/desktop/tsconfig.web.json`|执行入口/环境门槛、产物路径、具名配置与离线/live范围|
|toolchain|`apps/service/package.json`|执行入口/环境门槛、产物路径、具名配置与离线/live范围|
|tests|`apps/service/src/codex-chat.test.ts`|断言与触发条件审核：校验已知事件，不把未知事件当成完成; 显式无效路径不回退到已安装 CLI; 同会话恢复身份，个人与空间隔离，reset 清除上下文; shutdown 同步关闭接收入口，清理立即发送的请求|
|tests|`apps/service/src/guest-browser-bridge.test.ts`|断言与触发条件审核：requires explicit startup authorization and refuses mounts or another sandbox; rejects arbitrary URLs, sandbox names and command parameters; rejects body, identity, screenshot and sandbox-proof substitutions; rejects unknown result fields and accepts a bounded explicit dependency failure|
|tests|`apps/service/src/guest-browser.live.test.ts`|断言与触发条件审核：采集真实 DOM/PNG、保存空间资源并经 guest stdio MCP 精确读取|
|tests|`apps/service/src/guest-browser.test.ts`|断言与触发条件审核：只接受固定操作、URL、sandbox 与 UUID，拒绝任意参数; 拒绝跨域、凭据、其它协议/端口、POST、子框架、redirect 与后续导航; 错误摘要不包含 URL 用户信息、query 或 fragment; UTF-8 正文上限不切断码点，截断标记准确|
|tests|`apps/service/src/initialization-migration.test.ts`|断言与触发条件审核：answers local read/status/register requests while sbx initialization remains pending|
|tests|`apps/service/src/resource-agent.live.test.ts`|断言与触发条件审核：真正调用 list_resources/read_resource，读取未放入 prompt 的 nonce 并确认清理;  |
|tests|`apps/service/src/resource-chat.test.ts`|断言与触发条件审核：binds only the fixed space to an immutable per-turn bundle; binds a host-registered dynamic session to TaskFlow resources and freezes its workspace; another registered workspace has no TaskFlow capability; personal conversation receives an empty capability without listing a space|
|tests|`apps/service/src/resource-dispatch.test.ts`|断言与触发条件审核：持久化完成及失效旧上下文后才允许启动下一轮，随后 cancel 仍按请求顺序到达; 保存失败回传错误，不失效旧上下文，后续合法请求仍能执行; 活动轮次拒绝变更，幂等保存不切断上下文|
|tests|`apps/service/src/resource-mcp.live.test.ts`|断言与触发条件审核：非法 start frame 在启动子进程前返回明确 error 与 cleanup; \n|
|tests|`apps/service/src/resource-mcp.test.ts`|断言与触发条件审核：rejects cross-space, stale versions, paths, writes and malformed bundles|
|tests|`apps/service/src/resource-store.test.ts`|断言与触发条件审核：持久化真实快照；同 URL 内容重复幂等，正文变化递增版本; 资源身份随空间隔离，删除后不可读，其他空间不变; 显式更新只接受同 URL 的已有身份; 拒绝路径空间、摘要伪造、导航身份错绑与 UTF-8 超量正文|
|tests|`apps/service/src/sbx-contract.test.ts`|断言与触发条件审核：聊天状态保留选定 sandbox 与 guest cwd; 终端 open / 输入 / resize / close 和状态事件均有 schema|
|tests|`apps/service/src/sbx.live.test.ts`|断言与触发条件审核：PTY尺寸、持久cwd、CtrlC保留shell、close清理后台job; 非TTY cancel与控制stdin EOF均确认清理所属后台job|
|tests|`apps/service/src/sbx.test.ts`|断言与触发条件审核：拒绝挂载host的目标而不调用Codex; 仅接受与目标sandbox匹配的启动说明; initialize probe未确认清理时保持登记并拒绝shutdown; 失败版本probe已有清理确认时允许正常shutdown|
|toolchain|`apps/service/tsconfig.json`|执行入口/环境门槛、产物路径、具名配置与离线/live范围|
|tests|`e2e/chat.spec.ts`|断言与触发条件审核：fixture：续聊、新对话隔离、共享消息、IME、重复提交和取消; fixture：非零退出、坏 JSON、缺完成事件显示失败并可继续; CLI 不存在时明确不可用并保留草稿; live：中文对话、上下文续聊、新会话隔离|
|tests|`e2e/public-document.spec.ts`|断言与触发条件审核：controlled-network fixture：真实 Electron 协议跳转、显示、绑定与空间持久化; error; data; end|
|tests|`e2e/resources-live.spec.ts`|断言与触发条件审核：live：真实公开网页保存到空间并由 Docker Sandbox Codex 通过只读 MCP 枚举和读取|
|tests|`e2e/resources.spec.ts`|断言与触发条件审核：fixture UI：公开快照保存、重复、更新、失败恢复、移除确认、个人隔离与窄窗键盘|
|tests|`e2e/sbx.spec.ts`|断言与触发条件审核：PTY 文本：规范化控制字符后只匹配完整输出行; sbx：空间提供独立终端标签，切换时隐藏原生预览; sbx：对话显示执行来源，连接失败不允许发送; 空间会话：执行器不可用时保留草稿并记录失败运行|
|tests|`e2e/space-remake.spec.ts`|断言与触发条件审核：SR01/02/07/09：六个入口、空间专属标签、设置主题、草稿与原实例保持; SR03/04/06/10：左右气泡、原生遮挡集合、通知不自动固定、关闭恢复焦点; SR10：通知与窗格菜单共存、switcher交接editor、快速开关resize不复活原生网页; SR05/11：独立固定偏好、窄窗投影不改分割树、重启只恢复pin|
|tests|`e2e/workbench.spec.ts`|断言与触发条件审核：启动：窗口、安全边界与 Browser 区真实加载; 点选：明确目标后采集摘要、截图与页面身份，先采集后确认不会崩溃; 任务确认：中文目标生成权威不可变版本，重复点击不生成双版本; 导航：页面跳转后旧现场失效，历史版本仍保留原目标|
|tests|`e2e/workspace-debug.spec.ts`|断言与触发条件审核：工作台启动：窄preload接口与真实导航控件|
|tests|`e2e/workspace-migration.spec.ts`|断言与触发条件审核：R1 可见导航进入真实任务历史，查看日志/diff/报告不执行; R2 通信栏菜单控制通知，独立专注入口控制布局; R1 通知定位后台同一运行，打开与已读分离且重启保持回执; R7 首页空间卡片由当前快照生成，按稳定身份切换|
|tests|`e2e/workspace-runtime.spec.ts`|断言与触发条件审核：A06 / A07 fixture执行中关闭标签后重新打开仍是同一运行，重复发送不启动两次; live：真实PTY与单Agent执行跨空间保持归属，检查和审阅独立; A11 重启恢复布局与草稿和历史，运行不重放，明确旧模型上下文未恢复|
|tests|`e2e/workspace-upgrade.spec.ts`|断言与触发条件审核：A01 / A12 空间切换器独立于侧栏，浮层使原生网页让位并恢复焦点; A03 / A04 / A05 统一标签与四窗格不重复创建网页实例，关闭窗格保留标签; A12 键盘、主题、窄窗和专注模式恢复原布局; A02 / A11 真实UI新建空间与会话，草稿隔离，搜索定位与无结果不切换|
|tests|`e2e/workspace-visual.spec.ts`|断言与触发条件审核：A12 三窗格、切换器、暗暖主题与窄窗真实窗口截图|
|toolchain|`package.json`|执行入口/环境门槛、产物路径、具名配置与离线/live范围|
|toolchain|`packages/protocol/package.json`|执行入口/环境门槛、产物路径、具名配置与离线/live范围|
|tests|`packages/protocol/src/protocol.test.ts`|断言与触发条件审核：接受完整的任务版本; 预算不能超过计划默认值（3 次 attempt、15 分钟）; 没有验收条件或允许范围时拒绝; 接受结果必须绑定任务版本与源码快照|
|tests|`packages/protocol/src/resources.test.ts`|断言与触发条件审核：keeps host records unchanged and preserves guest identity in resources and bundles; rejects crossed host/guest variants and every unrecognized field; rejects malformed capture provenance, stale page binding and unsafe URL forms; accepts the registered TaskFlow capability and an empty capability for another space|
|tests|`packages/protocol/src/workspace-preferences.test.ts`|断言与触发条件审核：accepts the workspace theme and rejects the retired sidebar write interface|
|toolchain|`packages/protocol/tsconfig.json`|执行入口/环境门槛、产物路径、具名配置与离线/live范围|
|toolchain|`pnpm-lock.yaml`|执行入口/环境门槛、产物路径、具名配置与离线/live范围|
|toolchain|`scripts/check-docs.mjs`|执行入口/环境门槛、产物路径、具名配置与离线/live范围|
|toolchain|`scripts/sbx-prepare-guest.sh`|执行入口/环境门槛、产物路径、具名配置与离线/live范围|
|toolchain|`scripts/sbx-read-smoke.py`|执行入口/环境门槛、产物路径、具名配置与离线/live范围|

|toolchain|`tests/vertical-slice/contracts.ts`|固定任务字面合同/不可变允许路径、产品事件与identity原始日志严格schema|
|toolchain|`tests/vertical-slice/run.ts`|runDir与before/after镜像、B01-B05固定门槛、超时/cleanup及失败证据出口|
|toolchain|`tests/vertical-slice/cdp.ts`|loopback discovery/about:blank target、先订阅load再navigate、request/response/exception与截图PNG|
|toolchain|`tests/vertical-slice/evidence.ts`|artifact SHA/完整性、生命周期顺序、日志身份、B05分支重评B04；独立B03/B04门槛P2已复现|
|toolchain|`tests/vertical-slice/postcondition.ts`|URL/runId/readyState/唯一可见精确greeting/exception独立判定|
|tests|`tests/vertical-slice/selftest.test.ts`|合成失败负控/混合run/hash/篡改/缺artifact、CDP readiness真实算法；不运行产品|
|tests|`apps/service/src/resource_mcp_tests.py`|exact finite read-only tools、metadata无权限、guest variant/version/digest、Linux-only sealed memfd真实stdio|
|docs|`demo/README.md`|静态演示与实际TaskFlow/C2/C3/母模板和业务验收边界|
|implementations|`demo/taskflow/app.js`|固定task内插渲染与故意deadline/C2按钮演示，不接API|
|implementations|`fixtures/vertical-slice/page/src/App.tsx`|固定唯一greeting初态与唯一允许改动路径|
|implementations|`fixtures/vertical-slice/page/src/main.tsx`|React root装配固定页面|
|implementations|`fixtures/vertical-slice/page/index.html`|固定root/module入口|
|toolchain|`fixtures/vertical-slice/page/package.json`|固定loopback Vite启动，无产品adapter|

|toolchain|`apps/desktop/electron.vite.config.ts`|冻结版本的构建/类型/单元或Electron执行入口、产物范围、live门槛与源码依赖边界|
|toolchain|`vitest.config.ts`|冻结版本的构建/类型/单元或Electron执行入口、产物范围、live门槛与源码依赖边界|
|toolchain|`playwright.config.ts`|冻结版本的构建/类型/单元或Electron执行入口、产物范围、live门槛与源码依赖边界|
|toolchain|`eslint.config.js`|冻结版本的构建/类型/单元或Electron执行入口、产物范围、live门槛与源码依赖边界|
|toolchain|`tsconfig.json`|冻结版本的构建/类型/单元或Electron执行入口、产物范围、live门槛与源码依赖边界|
|toolchain|`tsconfig.e2e.json`|冻结版本的构建/类型/单元或Electron执行入口、产物范围、live门槛与源码依赖边界|
|toolchain|`pnpm-workspace.yaml`|冻结版本的构建/类型/单元或Electron执行入口、产物范围、live门槛与源码依赖边界|

## 已复现问题

1. P2：`workspace/Sidebar.tsx:54–57` 对标签自身 drop 会先删除自身，再以目标索引 -1 插入；三标签 `[web, terminal, session]` 实际变为 `[terminal, web, session]`。真实 Electron fixture 调用了组件事件和 Main command，原始数据见 `sidebar-selfdrop-probe.json`。应让自身 drop 无操作，并保留其他标签排序。

2. P2：`workspace/Session.tsx:64–68` 已定位 run 的优先级高于所选版本，版本选择仅修改 selectedVersionId。真实 Electron 确认 v1、运行 v1、确认 v2、定位 v1 run 后选 v2：任务标题为 v2，日志/执行状态仍是 v1。原始 UI 与标识见 `history-version-probe.json`。版本变化应重置 run，run 变化同步版本，通知定位保持指定版本/run。

3. E2E 等待缺口：`e2e/workbench.spec.ts:198–209` 等待单窗格及 native.visible，不证明 ResizeObserver 的布局请求已应用。四轮真实 Electron 窄窗观测，首轮 19ms 时 DOM 宽 870 / native 宽1085，46ms 两者收敛；后续轮一致。见 `narrow-probe.json`。应等待完整 native/DOM bounds 收敛后执行原断言，不能删除断言或放宽 1px。未复现持久的产品布局错误。

## 证据强度与边界

Renderer 正文审查覆盖六页装配及展示状态、原生 Browser ResizeObserver/隐藏恢复、Terminal 实例/输入/主题、Session 草稿/任务/运行、切换器搜索与焦点、整组左栏 hover/focus 延迟、右通知独立定位/已读/固定、遮挡 barrier、导航保留挂载与设置主题归属。静态图标/演示数据按展示用途检查；其内容不授予业务权限。

测试索引核对了用例触发条件与断言对象、负向调用断言、跳过条件和 mock 边界。resource-dispatch 正文验证提交完成→失效→send→cancel 顺序及失败后不失效；resource-chat 正文验证动态会话宿主注册/空间冻结、其他空间及个人会话无 TaskFlow 能力、读取中的 reset/shutdown 不启动迟到 guest、cleanup unknown 阻止新轮及 MCP 证据保留/限额；ipc-resources 正文验证具名稳定身份、拒绝 renderer 内容伪造/preview来源/退休 IPC 和失败传播。这些是假连接单元证据，不能证明真实模型或远端清理。该条为首批审查时的进度记录；后续补评（一）至（四）及Renderer补评已完成全部非live测试正文，live正文由主线程覆盖。

工具链检查了 pnpm/version/命令入口、Electron sandbox preload 构建、service 打包路径、单 worker E2E、unit include 范围与显式 live 环境开关。check-docs 仅核对固定入口/本地链接/空白，不证明全文可读性；baseline:selftest 不证明产品。sbx prepare 限 Linux ARM/pinned Node，smoke 使用隔离目录/nonce、真实事件和退出码，并保存失败/超时证据。E2E helper 独立临时 profile、Main/Renderer 错误监听、关闭核验；renderer/native 分图不等于 OS 窗口合成截图。

本代理没有修改产品源码，没有把 baseline 历史通过扩大为当前分阶段验收；完整 Electron、live 与架构验收由主线程汇总原始测试记录。

## Core 测试正文补评（一）

- recovery-facts：真实临时JSON仓库两次重启核对 interrupted/cancelled 的持久事实、时间戳/已读回执稳定和 save 仅一次；磁盘满注入后核对原始文件字节、错误可见、无 load/save/send 重放。5ms仅使时间变化能被发现，不是同步通过手段。
- run-notification-migration：同generation累计消息/重复toolId按turn抽取；关闭标签、换空间、定位、已读与执行严格独立；实文件证明仅保存receipt、不保存派生notifications；错配版本/run拒绝且不换空间；stale/not_run/blocked验证不能接受，日志会话错属拒读且原文件保留。
- runtime-outcomes：picking变false尚无截图不等于采集完成；旧request错误/取消不能写新request；terminal旧seq/相同seq均不能覆盖现快照，失败保留output/cleanup事实。
- migration-followup：未完成publicResourcesList不能阻塞retryInitialization；新原生focus立即reload正确view且另一view未调用。50ms race是局部非阻塞时限，不能作为性能验收。
- initialization-migration：永不完成sbx初始化时，register/status/get/resources/terminal五个具名本地读接口均响应；检查请求ID全集而非单个ready布尔。
- window-close：工作台初始化失败仍必须等待guest确认cleanup再close/dispose；cleanup unknown时close与getSnapshot均未调用，不能用工作台失败绕过执行器清理。
- controller-construction：native attach及protocol安装分别注入失败，核对view关闭/ChildView移除/协议与webRequest/download监听注销，随后再次构造成功；覆盖局部构造回滚，但native对象仍为fake。
- workspace-preferences：合法theme精确parse；退休sidebarMode写入拒绝，不保留兼容入口。

这些正文补评未发现新缺陷；Main/Service真实行为仍需要相应Electron/live记录，单元mock不提供该证明。

## Core 测试正文补评（二）

- layout/repository/ipc-guard：聚焦已显示标签不改树、关窗格与关标签区分、第五窗格/重复标签拒绝；损坏/未来schema实文件不覆盖；缺文件才新建；顶层来源/端口/精确file页面与未知frame拒绝。
- public-protocol：Main GET主框架webContents归属、owner DevTools bundled路径及遍历拒绝；redirect仅最终响应可采集，旧epoch响应不回写；失败不伪造document；dispose取消协议与request监听。Electron session仍是fake。
- codex-chat/sbx/sbx-contract：真正启动fixture子进程验证personal/space恢复隔离、坏JSON/缺完成/空回复失败、取消迟到输出隔离、reset/shutdown竞态；注入cleanup不确认后拒绝新send/reset/close，generation/messages事实保留；PTY中文/控制字符/resize与旧session写拒绝；无sandbox/无效binary不回退host。这里的fixture不是实际模型/sandbox。
- resources/protocol：strict host/guest变体及身份绑定、URL/未知字段/预算/长度/多余参数、personal/dynamic capability约束均有正反例；结构schema接受绑定sourceState并不证明实际基线/校验运行。
- resource-store：实临时文件重载、并发16记录不丢、overflow不破坏此前集合、空间隔离、内容摘要/UTF8限制；近集合上限矩阵必须同时出现accepted与rejected且accepted可容纳最长turn身份；guest完整artifact变化逐字段递增version、键顺序幂等、host/guest往返不保留旧provenance，伪摘要不替换原集合。
- resource-mcp：调用Python -I执行实际测试源码，要求exit0与unittest OK；断言有效性仍取决于Python测试正文，主线程已覆盖Python工具实现，本记录不借该一条包装断言宣称覆盖全部能力。
- guest-browser-bridge：明确合成PNG/frame测试；tamper body/id/screenshot/namespace/seccomp/cleanup逐项拒绝，startup权限/挂载/sandbox名边界；实artifact SHA与stored version/idempotent核对。不能作为浏览器像素/真实sandbox证据。

本批正文审查没有发现新的正确性缺陷。

## 固定 VS001 / Python MCP 审查

resource_mcp_tests.py 全文已读：8组纯协议/内容/身份正反例与Linux-only sealed memfd真实stdio测试；macOS运行明确skip memfd，不宣称sealed descriptor已验证。metadata _meta只接受对象并不增加权限，readOnly tools精确两项，版本/删除与cross-space错误均有失败断言。

VS001六个脚本/测试正文已读：contracts冻结字面任务、允许唯一App.tsx路径；run独立临时runDir、before/after源码镜像、固定B01-B05、先订阅load再导航、异常与cleanup记录；postcondition校验run/url/唯一可见文本；CDP只loopback/about:blank指定target，真实request/response记录；evidence验证每个artifact hash、事件顺序/日志身份、重评B04和screenshot响应；selftest拒绝伪事件/混合run、隐藏/重复/错误文本、缺失artifact，合成transport测试等待顺序，不调用模型。

发现 P2：verifyManifest 只在B05 passed分支里重评DOM证据，B03单独passed但identity=null、无observation/CDP仍被接受，见vs001-verifier-probe.json及/tmp脚本。runner正常顺序不生成这种证据，但独立复核器无法拒绝该局部伪pass，selftest目前只测全部passed和B05passed。应按各check的passed独立要求对应证据/perform一致性，版本化修订并保留旧证据。是否修改封存VS001由主线程决定。

## Core 测试正文补评（三）

application.test.ts 931行完整核对：旧sidebar字段剥离但tabs/layout/draft/theme保留，stale revision拒绝、不发布失败metadata，commandId去重副作用，跨空间资源拒绝；run跨空间/闭标签仍按generation更新，真正validation缺失保持blocked；实文件restore不重放执行/PTY，嵌套会话/version/target错属与重复version逐项拒读且不改文件；cancel/terminalStop先持久化、异步cleanup期间草稿/切空间仍可达、save失败反断言不调用runtime；旧terminal关闭回执不能覆盖新实例，unknown cleanup不创建替代进程；MRU独立tab排序和same-space locate不隐藏native均有实际断言。URL危险地址用runtime.validateBrowserUrl故障注入，仅证明副作用前校验顺序，地址真实校验由public-request测试负责。

host-migration完整核对active pane菜单行为、focus闭包捕获不可变身份、构造load失败dispose后可retry；公开采集在开始时绑定原page，错误不save。migration-regressions完整核对创建失败不发布instance、离线register不阻塞本地history、显式retry coalesce、替换capture request旧回调拒绝、独立run日志恢复、locate/readReceipt schema独立。上述未发现新增缺陷。

## Core 与 Electron 测试正文补评（四）

guest-browser.test.ts 622行完整审查：固定请求/出站GET及origin/port/redirect/frame拒绝；UTF8完整截断；Chromium诊断完整标签/冲突/TSYNC不可冒充、renderer seccomp与namespace更强要求；owned PID复用/权限错误不伪退出或乱kill；响应gate全3xx failRequest、不降级continueResponse、不回显任意错误；loader/request/mainframe对应、DOM mutation/截图前后observer一致；真正Node stdio多帧/EOF/node-e失败，网络readiness tentative/DAD/stability/deadline/取消timer清理。这里CDP与隔离证明仍合成，只有stdio是真子进程。

chat-service完整正文：ACK与事件都是cleanup事实；未ACK/未initialized退出保留未知占用，已确认失败可正常关闭；shutdown ACK后kill且还须utility exit；坏消息拒绝pending并发布不可用。public-document/public-request完整正文：DNS全集公网与pinned IP/TLS hostname/default认证、取消期限、逐redirect校验、MIME/UTF8/编码/尺寸限制；剥除主动HTML并检查摘要，实际Node DNS回调contractprobe故意中止连接；不是公网证据。controller-resource/migration全文：sandbox无preload、公开doc broker成功/epoch/title匹配才能保存；旧截图成功/失败/inspect-exit不得改新pick，cancel/navigation/dispose使回调失效；DevTools属主先登记再load且dispose。public-resources-migration：旧初始化revision不能覆盖新capture/remove，pending相同command仅调用一次，失败集合保留且显式retry清错，其他空间不继承TaskFlow资源能力。未新增问题。

非live E2E 正文完整审查：workspace-upgrade/debug/migration/visual、space-remake、workspace-runtime fixture/restart、public-document controlled network、resources controlled DTO、workbench串行、chat fixture、sbx fixture。覆盖六页直达、保存草稿/criteria/version、native click采集、背景run重开同身份、snapshot/菜单activefocus、DevTools两view隔离、notification locate/read与restart、pin/peek/Esc/focus/1080投影、theme及xterm背景、异常门槛负控、IME composition与取消。controlled DTO仅UI，controlled network真实protocol/store但非公网；visual生成截图并无像素比对断言，人工/实际窗口验收须独立；窄窗bounds等待缺口仍按前述记录待修。live正文及门槛由主线程另审。

## Renderer 单元与固定展示数据补评

8个renderer/demo单元文件595行正文已读：capture先open再pick且收到截图完成后才定位冻结owner；新request、同URL代次、跨页替换、失败/取消均释放旧subscription；workspace seq/appInstance、不同空间队列/expectedRevision、B迟到响应与无关错误不能被布局/资源成功擦除；draft个人目录不含空间写入口；occlusion等待hide确认再展示、失败/撤销不复活且多source独立；panel只持久pin，close不改pin、narrow只投影；six-route导航不改业务。shell.test的hover部分是局部辅助函数，实际timer/focus行为靠space-remake真实E2E。demo run测试要求origin=demo、inconclusive错误不冒充业务fail、取消中/已退出分开、revalidate无模型；固定图标与resourceIcons只展示。

TaskFlow静态app.js正文核对固定tasks、故意deadline错误和C2编辑按钮；由专属wsl-demo协议读取，不调用API、不构成C2/C3验收。VS001四个页面fixture唯一可见greeting为Hello baseline，固定App.tsx允许路径不改变。根构建/类型/测试配置已从9e1df45的git object补冻结到07-bf64/config-baseline，hash列于覆盖JSON，避免把Phase1包配置变化混为旧基线。

剩余未审边界：Task5 324个非dirty旧文件实际字节不可核对；这些只有committed fallback。文档语义由主线程同步、历史sealed证据保留。Phase2及随后修复的新源码/测试需要按实际diff补评；本报告静态覆盖不替代新版本测试或native/live验收。
