# R6：可信 Mota 编辑入口与 Main 保存授权实施计划

状态：**计划，未实施**。本次仅准备计划；下述路径、协议和用例是后续工作，不是已实现或已验收事实。本计划落实[修订计划 R6](2026-10-16-post-review-update-plan.md)与 [ADR-0004 首选提案](../architecture/adr/0004-mota-trusted-editor-save.md)，遵守 [AGENTS](../../AGENTS.md)、[开发规范](../../CONTRIBUTING.md)、[架构](../ARCHITECTURE.md)、[设计](../../DESIGN.md)和[交互契约](../../UX-CONTRACT.md)。

## 1. 交付目标与产品取舍

采用 ADR 首选的**专用 WebContentsView、固定产品入口 `wsl-editor://mota/index.html`、专用窄 preload、Main 具名保存用例**。本包只建设这一条人工保存链。

用户仍能在同一 Mota App 中打开游戏与编辑资源，编辑 `project/floors/MT1.js` 和 `_server/config.json`，明确保存、处理冲突并刷新游戏核对。首版产品页提供两文件的文本/JSON 数据编辑、保存状态及冲突对照；MT1 按固定赋值前缀加 JSON 解析，保留全部合法扩展字段。完整上游素材、插件、多楼层设计器及原导入编辑器 UI 的资产移植不在本包；若必须保留那套完整 UX，应先调整产品范围，不能给原导入页加写桥后宣布完成。

新正常保存通路可用与旧 HTTP 写入口关闭必须在**同一个候选切换阶段**完成。不能以临时禁用人工保存作为 R6 交付，也不保留默认可启用的旧写入口回退。

game 继续是无 preload 的不可信网页；导入 HTML/JS、libs、project、extensions 和 `_server` 内容均不能在有写能力的产品编辑页执行。两资源 ID 与 `appPage: game/editor` 保持，editor 实际 URL 改为产品入口；来源 `/editor.html` 如继续提供，只作为无写能力的来源内容。

## 2. 当前基线与保全

| 项目               | 计划编写时事实                                                                                                                                     |
| ------------------ | -------------------------------------------------------------------------------------------------------------------------------------------------- |
| 工作树             | `/Users/huaodong/workspace/_worktrees/wsl-review-fixes-20261016`                                                                                   |
| 仓库 / 分支 / HEAD | `JadeSnow7/web-studio-lab` / `agent/refactor-modular-20261017` / `e6bb391df4c1d6c0c6a884d6acdc4061e3027b3b`                                        |
| R6 计划新增前输入  | 5184 项，源码 aggregate `54a8397b1d90abf12f7a564a0b97d246e00cbae5d5fdd93ffca466cc3ad94835`；含原 14 候选、R5 八文件及 R5 计划，不能只检出干净 HEAD |
| R5 构建            | 8 项，aggregate `5728ee0b709fed981ebe9e85cc996155b9ec6b897f33e34001e80409455d3359`                                                                 |
| R5 已验收范围      | 51 项回归、347 项关联、完整 check（2126/18，Node 174，external 6）、12 项自检；新默认 E2E 179 通过/22 跳过/0 失败，201 收集；独立复核通过          |

最近本机回执为 `.local/refactor/r5-export-contract-20261019T101517914991Z/`；实施/离线及反例为 `r5-export-contract-20261019T082235828832Z/`。这些是本地封存证据，不假定别的 checkout/CI 已持有。

本次计划编写前已核对全部 5184 个输入与 R5 最终清单相同。实施开始仍须重新核对 HEAD、分支、remote、dirty/untracked、实际工具链及完整指纹；本计划新增后应重新冻结输入，不能沿用上表 aggregate 冒充新目录。

原七个保护文件（包括 ADR-0004、旧两份计划、B1 检查测试和审计映射）、所有已封存证据继续只读。ADR 仍保留原 Proposed 文本；后续若采纳此路线，在新决策/实施回执记录用户指令与实际范围，不覆写保护输入来制造“已批准/已实现”。

R6 将涉及 R5 也使用的 `app-service.ts`，只允许改本计划列出的 Mota 接线区域；R5 导出合同及四个生产区域保持。地址修复七文件默认只读，现有回归不得删弱；若确需改其中的共用夹具/布局，先说明必要性和增量，保留修复语义及逐项对照。不得 reset、stash、clean、覆盖用户修改或使用主工作树源码。

## 3. 当前代码核对与必须补齐的接线

| 落点                                                                                                                          | 已核对事实 / R6 要处理的差异                                                                                                                                                       |
| ----------------------------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| [mota-server.cjs](../../apps/service/src/mota-server.cjs)                                                                     | GET 来源 editor 时建立 nonce 快照并注入 bootstrap；`POST /writeFile` 用该 nonce、baseline 和 lease 保存。同源 game 可取得这种 HTML；nonce 不证明可信 frame 或人工意图。            |
| 同一 server                                                                                                                   | `parseWrite` 已有两文件、256 KiB、UTF-8/JSON 限制；`writeSafe` 有路径/链接/目录身份、expected hash、临时文件 sync、rename 及提交回调。复用唯一源文件写入口与同一队列，不新建旁路。 |
| [application.ts](../../apps/desktop/src/main/workbench/application.ts)                                                        | `managedResourceUrl` 将 editor 映射到 guest `/editor.html`；`enqueueCommand` 串行等待用例；`closeTab` 当前只更新布局。新增撤权不能排在一个长时间 await 的保存之后。                |
| [host.ts](../../apps/desktop/src/main/workbench/host.ts) / [controller.ts](../../apps/desktop/src/main/preview/controller.ts) | 现有 Browser 按 guest origin 校验并使用普通无 preload 视图；导航开始推进私有 navigationEpoch。需要专用 editor 分派和原生导航事实，不能全局放开普通 Browser URL/权限。              |
| [ipc-guard.ts](../../apps/desktop/src/main/ipc-guard.ts)                                                                      | 当前只接受主窗口顶层 frame。保持原边界；editor 另建专用 guard，不把所有 Browser 加入工作台白名单。                                                                                 |
| [ports.ts](../../apps/desktop/src/main/workbench/ports.ts)                                                                    | 已按能力分组，并用精确 key/可选性断言保留旧接口。新增 editor 能力要列出新增集合并验证旧集合不变，不能删断言绕过类型门禁。                                                          |
| [app-service.ts](../../apps/service/src/app-service.ts) / [mota-control.ts](../../apps/service/src/mota-control.ts)           | Mota 已有受 AppInstance 约束的私有 duplex pipe；MotaControls 是 AI run 绑定，不可借用或伪造 runId。新增人工协议需独立解析、归属及 unknown 状态。                                   |
| 现有帧解析                                                                                                                    | server stdin 单行上限 4096 bytes（现有检查不含 LF）；service 对运行 App stdout 的完整/未完成行均有 65536-byte 限制。**读取回复与保存上传均须分块**，不能直接发送 256 KiB 文件。    |
| [electron.vite.config.ts](../../apps/desktop/electron.vite.config.ts)                                                         | 当前只有工作台 renderer 和通用 preload 构建入口；尚无可信 editor bundle/专用 preload。新增产物及其清单必须进入实际构建与指纹。                                                     |
| 当前 E2E                                                                                                                      | 有 `mota-app-live.spec.ts`，没有 `e2e/fixtures/sbx-mota-app.mjs` 这一离线夹具。默认真实 Electron 的 R6 保存测试需要最小新夹具，不能把不存在的路径当可复用能力。                    |

以上是静态现状，不是本轮已经执行攻击或保存验证。

## 4. 信任与资产合同

```text
用户在产品编辑页发起保存
  → editor 专用 read/save/close/status 窄桥
  → 原生 sender/frame/文档检查
  → Main 具名用例及权威会话/操作记录
  → service 人工编辑端口
  → 当前 App 私有 pipe：editor.open/read/stage/commit/revoke/status
  → guest 同一写入队列 → writeSafe → 原操作回执
```

1. 产品协议仅安装在专用 editor partition，只服务构建内固定 HTML/JS/CSS 清单，不代理 guest/import/HTTP，不回落到来源 editor。清单及可执行依赖的摘要须锚定到同一可信 Main 构建；不能运行时对当前资产生成“期望哈希”。
2. handler 返回**已读取并校验的同一份字节**，不先验 hash 再用 net.fetch 重读可变文件。缺失、替换、越界路径/链接、未知资产均拒绝。把入口、传递依赖、许可及版本纳入构建证据。
3. 开发阶段也优先加载该构建入口，避免为 HMR 放开任意 Vite 同 origin 页面、unsafe-eval 或网络 fetch。开发者可写安装资产是开发环境信任前提，不宣称 OS/签名隔离。
4. CSP 基线采用 ADR 的 default/script/style/connect/frame/object/base/form/worker 限制；首版编辑页不加载导入图片、SVG、HTML 或脚本。外来字符串只进入文本/表单值，JSON 只作为数据，不能合并为权限、路径或执行配置。
5. `nodeIntegration=false`、contextIsolation、sandbox、默认拒绝权限、窗口创建/下载/外部导航等约束覆盖新视图。固定顶层 URL 不携带授权 query/hash；同 origin 的其他 path、iframe、about:blank/srcdoc、redirect 均不取得写能力。
6. editor preload 仅暴露具名 read/save/close/status；没有任意 IPC/URL/路径/脚本代理，没有工作台 window.studio、Node 或 Electron 对象。game、来源 editor 与其 postMessage 均不能借此转发保存。
7. 实际 sender 必须是登记 WebContents 的**当前顶层 frame**，匹配 process/routing、固定最终入口、资产版本、resource instance/generation、documentGeneration/navigationEpoch。路径白名单、CSP、nonce、Cookie、Origin/Referer、isTrusted 或用户激活字段均不能单独授予保存。
8. 专用 editor 不成为通用 Agent/AppControl/资源工具的脚本执行或输入目标；Mota 任务继续只绑定 game。人工刷新、重开和关闭经具名路径处理，不能为了复用工具栏而给普通 Browser 增加产品页代理能力。

## 5. 状态、用户交互与撤销

Main WorkbenchApplication 为授权唯一写入者，可将实现放在它持有的 `workbench/mota-editor.ts`。Host 只持原生句柄并报告事实，service/guest 只执行已绑定操作并返回事实。草稿仍是 UI 状态。

编辑页使用中文可访问标签、原生键盘操作及既有状态/错误通道；保存结果不抢焦点，文件版本对照可在详情查看。内部 session/nonce/代次和管线字段不进入常驻业务提示。

用例固定为 `openMotaEditor`、`readMotaEditorFile`、`saveMotaEditorFile`、`closeMotaEditor`、`motaEditorOperationStatus`。renderer 提供会话索引、文件枚举、requestId、expectedHash 和内容；项目/root/AppInstance/原生文档/预算/AI 身份全部由 Main 推导，拒绝额外字段。Main 计算内容 UTF-8 长度及 contentHash。

| 对象/事件      | 行为合同                                                                                                                                                                                         |
| -------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| 会话           | `opening → active → revoked`；固定 workspace/environment/project/AppInstance/resource、原生文档及资产身份。仅最终可信文档就绪且对应 View 可见时 active；旧 ID 不复活。                           |
| 读取           | 两文件枚举；返回原始完整内容及 hash，配置缺失为 null。读取不授予保存，不执行来源 JS。超过编辑上限或非受支持 JSON 的文件保持原件并显示原因，不截断成可保存文本。                                  |
| 草稿           | 同一工作台进程内关闭/隐藏及 App stop/restart 不丢未提交内容。优先保留专用视图的 UI 内存，权限另外撤销；不得为了保草稿保留写授权。删除资源/退出工作台不承诺正文持久化，未确认操作元数据另行恢复。 |
| 保存           | 校验当前 sender/会话/可见归属、只读快照与 expectedHash；每 App 一个在途人工保存，重复按钮/Enter 不产生第二次写入。保存中继续保留草稿。                                                           |
| 导航/替换/隐藏 | 导航开始（包括最终失败或取消）、redirect、reload、frame/资源 generation 变更、关闭/隐藏 View、切空间时同步拒绝新保存并推进 editor 代次。旧文档仍显示不代表授权有效。                             |
| 重新打开       | 同资源 ID，新的授权会话和 read；有脏草稿时不自动用新 hash 覆盖草稿基线。显示本地草稿与当前版本，显式处理冲突。                                                                                   |
| App/连接变化   | stop/restart、AppInstance 更换、service/guest 失联先撤新动作，保留在途/unknown 事实；旧回复只结算原操作，不改新文档或新实例。                                                                    |
| 成功/失败      | 仅 committed 显示已保存；冲突/校验失败保留输入。unknown 显示待核对且不重发写；状态变化不抢焦点，游戏刷新是明确动作，不自动回放游戏或模型。                                                       |

撤权走同步的 Main 会话失效路径，不能把它放进 `enqueueCommand` 等待正在执行的保存。保存采用短准入/登记加异步传输与原操作结算，不占用整条工作台命令队列；每个异步边界在派发下一动作前重核代次。这不是第二套任务执行核心。

原生导航事实直接触发撤权；已经完成来源/身份校验的 close/hide/switch 请求，也须在排入通用命令队列前使原授权失效。不能靠未验证的 renderer ID 撤掉其他对象的会话。操作状态独立为 `staging → submitted → committed / failed / unknown`，撤销会话不删除或改写原操作事实。

**提交/撤销顺序按 ADR 的有界合同实现：** Main 撤权立即阻止新派发；guest 在同一队列的 commit 检查点核对 active、identity、版本和 lease。先被 guest 撤销的 commit 拒绝；已进入提交、抢先完成 rename 的保存按原会话记录 committed，revoke ACK 必须反映已结算事实。没有 ACK/结果时不能显示“已阻止写入”或释放未知占用。本包不承诺“导航开始后任何尚未 rename 的写入必定被抢占”；不能靠等待 did-navigate 或伪造取消成功获得这种表述。

源文件写入继续由 `writeSafe` 唯一执行。rename 为已提交事实；之后目录 sync/close、通知或持久化失败记录为提交后错误，不转成“未写”，不重写目标。AI lease 与人工 commit 使用同一队列和版本检查，保持两边的旧 expectedHash 失效语义。

外部改/删/建引起 `versions` 与实际文件不一致时保留冲突和双方内容。普通 HTTP/read 不得静默重置全局版本或授权；无法在现有规则下确认新基线时，明确要求核对或停止/重启副本后再读，不把单纯重载编辑页描述成已解决冲突，不增加强制覆盖入口。

## 6. 双向传输、预算与幂等

以下是 R6 新协议拟冻结的上限；不改现有 AI 帧、4096/65536 公用解析上限、R5 导出限制或旧测试超时。

| 项目      | R6 约束                                                                                                                                          |
| --------- | ------------------------------------------------------------------------------------------------------------------------------------------------ |
| 文件      | 仅 MT1/config 两文件，读/保存每文件完整解码内容最多 262144 bytes；仍验证既有 UTF-8、固定 MT1 前缀/JSON 与 config 对象语义                        |
| 会话      | 每 AppInstance 最多 1 个未结算人工会话；service 最多 16 个。opening/revoked 但未核实清理也占用，不按 LRU 驱逐                                    |
| 传输      | 每 App 一次 read/stage/commit；每个读/上传原始数据块 ≤1024 bytes、最多 256 块，完整 JSON 帧含 LF ≤4096 bytes                                     |
| 缓存      | 每 App 读快照与 stage 各 ≤256 KiB；service 解码内容累计 ≤8 MiB；编码和 Buffer 副本另计，不能把该内存预算当源文件权限                             |
| 流控/时间 | 每传输至多一个数据块等待应答；单请求应答截止 5s、整个传输及 stage 生存期 30s，自首帧计时且不被新块刷新；这是新增协议预算，不调整旧 Mota/测试阈值 |
| 回执      | 每 AppInstance 最多 1024 条人工操作记录，Main 全局最多 4096 条；达到上限拒绝新写入，不淘汰 submitted/unknown，不构建 S2/S3 通用历史系统          |

open 在私有 pipe 建立绑定；native/frame/资产事实留在 Main 权威表，后续块用已绑定的 session/operation 索引，避免每块复制完整长身份。派发前验证实际编码帧；合法既有 ID 不能为了塞进 4096 被重新编号/缩短。完整 request/result 与外层 guest transport 均计量，不能只测原始 chunk。

读取回复也使用 begin/chunk/end，由 service 有界拼接，避开现有 64 KiB stdout 行门槛；新类型必须在旧 startup-event fallback 前被正确分派。Main/renderer 消费完整经 hash 校验的快照，不把部分回复当可保存文本。

stage 只暂存，不触及目标；以 bytes 拼接，末尾再做完整 UTF-8/JSON 校验，覆盖跨块中文/emoji。缺失、乱序、重复、异操作拼接、length/hash 不符或超预算终止 stage。控制帧及应答数有界，不自动重传 chunk/commit，不扩大全局通道。

幂等范围是绑定的 AppInstance/editorSession/requestId 与 file/expectedHash/length/contentHash。相同身份及载荷返回原结果；同 ID 异载荷拒绝。旧 session 的请求不会在新 session/AppInstance 重新获得执行资格；以单调代次及撤销记录阻止迟到 open 复活会话。

Main 在派发可能写入的 commit 前持久化最小操作元数据（schemaVersion、绑定、ID、hash、length、阶段，不含正文/凭据）；失败则不派发。可沿既有 repository 的原子发布模式增加具名小记录，不改全仓持久化格式。重启将未结算操作恢复为 unknown，不恢复 grant 或自动重放；旧进程停止证明、原操作 status 与当前文件核对分别记录。不能仅凭当前 hash 相同就伪造旧操作的提交回执。

回执保存 committed 与 durability/notification 错误的区别；对已失效会话只允许 Main 受控核对原操作，不复活旧写桥。已终结记录仅在原授权永久失效且旧请求必拒时按明确保留规则回收，过期 ID 不按新写重放。若上述有界恢复无法实现，保持本包 incomplete，不偷换为“点击再保存一次”。

## 7. 文件落点与写入边界

| 区域                                                              | 计划改动                                                                                                                        |
| ----------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------- |
| `packages/protocol/src/mota-editor.ts`（新）及公开出口、`chat.ts` | 专用 editor DTO、文件枚举、内外消息与回执；通用 Mota 描述和四个 AI 工具合同保持                                                 |
| `main/workbench/mota-editor.ts`（新）、`application.ts`           | Main 会话/操作用例，资源 URL 迁移与同步撤权、短准入、迟到结果归属；不重构整个 application                                       |
| `main/workbench/ports.ts` / `host.ts`                             | 具名 editor 能力组、原生事实回调和分派；保留旧成员及可选性证明，新增集合显式列出                                                |
| `main/mota-editor/`（有实际消费者才建）                           | 固定资产协议、专用 WebContentsView、sender guard/IPC 接线；复用布局几何，不把普通 PreviewController 改成有写 preload 的 Browser |
| `preload/mota-editor.ts`、`renderer/mota-editor/`（新）           | 单一产品页与窄桥、文本/JSON编辑、草稿及状态；普通 preload 的权限不扩大                                                          |
| `electron.vite.config.ts` / `main/index.ts`                       | 新独立入口、固定资产及构建 manifest、早期 scheme 注册、启动/退出装配；bundle 纳入实际产物指纹                                   |
| `main/chat-service.ts` / service `index.ts`                       | editor 专用内部 RPC 及完整身份回执检查；不借用 AI runId、MCP 或宽 HTTP 代理                                                     |
| `service/src/mota-editor.ts`（新）、`app-service.ts`              | 人工 pipe 请求/回复及 unknown 所属；仅增加 Mota 生命周期撤权/未结算占用必要接线，R3完成链和非 Mota 行为保持                     |
| `service/src/mota-server.cjs`                                     | 私有 session/read/stage/commit/revoke/status；同队列/唯一 writeSafe；关闭 HTTP write 与写 nonce bootstrap                       |
| 必要的小型操作持久化                                              | 优先既有 repository 原子发布端口，最多一个具名记录实现；与两份 guest 源文件分开，不回写宿主原工程                               |
| 规范/测试/必要打包清单                                            | 同步当前运行时与 UX 的 editor URL/权限/恢复描述；新增 bundle 的打包配置/合成清单测试可以改，真实 packaged 执行不自动授权        |

以上 `main/preload/renderer` 相对 `apps/desktop/src/`，`service/src` 相对 `apps/`。新文件名称为落点建议，实施前给出最终精确可写清单。不同时建设第二套工作台内编辑器，不新建通用授权/状态框架。

默认只读：受保护七文件及旧证据、地址竞态实现/回归、R5 导出区域、Mota/edu 导入 collectors 和来源 required-files/预算、Python 隔离/guest 清理、R4 原生能力门禁。新 R6 代码不得解除 Mota 模型拒绝启动，也不把本包改写为 S4 OS 隔离工程。

## 8. 实施顺序与可检出的验收

**A：冻结合同与失败基线。** 读取最新 R5 回执，记录实际输入/依赖/工具链；冻结本文的资产、双向帧、会话/操作预算、幂等范围和 commit/revoke 顺序。使用真实 `mota-server.cjs` 及独占临时副本复现：同源 game 获取来源 editor HTML/nonce 后发起合法 `/writeFile`，未经过可信 Main 保存却改变目标。记录请求、实际调用链、目标/原件 hash 和事件顺序；不把静态分析当攻击已重现。

**B：一个原子功能切换候选。** 依次完成协议/资产/原生 guard、Main 用例、service 私有通道及 guest 提交，最后同时接入正常产品保存并关闭旧 HTTP 写授权。中途实现可分小 diff 审查，但不能交付“旧入口仍可写”或“新旧都不能正常保存”的候选。

**C：同一攻击与正常路径。** 修复后再次实际发出同一攻击请求，nonce 不再下发也不能让测试提前退出而算通过；直接伪造旧 header/nonce 的 POST 仍须到达被测拒绝边界。原 HTTP 正常保存测试迁移到私有通路，保持文件内容、边界、冲突及回执断言；旧 HTTP 正例变为明确拒绝是授权合同变更，不删除正常保存验收。

| 组                | 必须区分的正反例与证据                                                                                                                                              |
| ----------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 正常人工保存      | MT1/config（存在与缺失），原始 bytes/hash、合法扩展字段、中文/emoji、游戏刷新/重开读回；只改两目标，宿主原件不变                                                    |
| 不可信代码/HTTP   | 恶意 game/来源 editor/libs/project、fetch旧入口、postMessage桥探测、伪造 Host/Origin/Referer/nonce/Cookie/header；无新会话/写入/目标 hash变化，产品页不执行外来字节 |
| 资产与真实 sender | 替换/缺失资产、同URL iframe、其他同origin path、about:blank/srcdoc、伪造或销毁sender；IPC在真实WebContents边界拒绝，普通工作台通道仍拒绝editor/game                 |
| 文档/生命周期     | 导航开始→失败/redirect/reload/in-page变更、关闭/隐藏/切空间、App restart、service/guest断开；同步撤权、草稿保留、App不因关View停止、旧响应不污染新会话              |
| 路径与内容        | MT2、穿越/编码/链接/目录替换、坏UTF-8/JS/JSON、额外字段、256KiB±1及真实编码帧4096边界；拒绝时不改目标，不执行内容                                                   |
| 版本与互斥        | 同一hash两次save、外部改/删/建config、人工与AI acquire/commit交错；不能丢更新，unknown占用不提前释放                                                                |
| 分块与撤销        | 1024边界、跨UTF-8块、缺失/重复/乱序/超量/超期、read与stage身份串线；阻断不写；明确观察guest检查点、rename与revoke/ACK先后                                           |
| 幂等/提交后失败   | 同ID同/异载荷、掉回执、重复Enter、进程崩溃；临时sync失败不提交，rename后sync/close/持久化/通知失败保留提交事实，无自动重放                                          |

优先扩展既有 `mota-server.test.ts`、`mota-app-service.test.ts`、`mota-control.test.ts`、`mota-managed-app.test.ts`、IPC guard 和相关协议测试。新 session/transport/asset 模块有必要才建各自测试，尽量复用夹具；保持 Mota server 既有隔离调度、1000ms 轮询以及其他原断言/超时/worker/retry。

默认真实 Electron 新增精简 `e2e/mota-editor.spec.ts` 及必要的离线 transport 夹具：允许模拟 guest 启动/端口映射，**保存帧必须转发给实际产品 mota-server，并实际读取落盘结果**；不以 canned success、DOM赋值或伪造Main回执替代授权/写入链。正常与恶意页使用真实 WebContents，覆盖专用 preload/guard/CSP；mock 范围明确，不作为 live guest 证据。

新 API 尚不存在时的导入失败不算修复前反例。旧 HTTP 攻击回归用现有可执行入口；新协议、产品页和撤权用例在接线后执行，分开列明。测试输入方法若修正，保留旧失败并重新固定可比对照。

**D：固定候选的默认出口。** 定向新用例及关联回归 → 完整 `pnpm check`（到达 Vitest/Node/external）→ `pnpm baseline:selftest` → 新构建及定向 Electron → 原样 `pnpm test:e2e`。核对旧201项及新用例清单、逐项skip、实际新bundle和全依赖指纹。旧 R5 绿色不代替 R6 验证；真实窗口需当时可交互的桌面，明确锁屏则停止窗口动作并保留现场，不改系统策略。

## 9. 验收层级、权限与交付

本次准备计划不执行代码、窗口或 guest。后续通常实施指令可覆盖上述产品/测试及默认离线、真实 Electron fixture、独立审查；不得从历史命令或旧“确认”继承 opt-in 权限。窗口测试已有执行授权时不重复申请操作许可；根据当前确认（如有）与原生/系统观测建立当轮环境，条件阻塞才请求解锁/确认。缺失 CG 保持 unknown，不据 DOM focus、IOConsoleLocked=false 或事后状态推断失败现场。

**真实 guest 手工保存是独立出口。** 新私有 duplex 链需要在另获明确授权的既有独占 sbx 中完成无模型复验：实际 Main/service/helper/server、真实文件 hash、权限撤销、App stop/restart/所属清理及原件不变。更新 `e2e/mota-app-live.spec.ts` 的可信 editor URL 和交互，保留原游戏/实例/停止断言；不能沿用旧固定 sandbox、路径或 ready 记录冒充新准入。

默认与本地 Node/Electron 成功，只能报告该层通过；真实 guest 未获授权/未执行时，写“R6 默认修复验证通过／真实 guest 保存链 not_run，R6 完整安全出口 incomplete”。Mota 模型、S4 OS 隔离、物理音频、真实 packaged、签名/发布及远端 CI 继续分别授权、分别结算。不要通过跳过真实门槛、启用模型门禁或禁用保存来关闭 R6。

角色沿用已约定模型：主控记录 Harness 实际声明及证明边界；源码/检查脚本的实施者与独立审查者分开，用真实工具 model 字段或 CLI `--model gpt-6.1-sol`。模型不可用如实报告，不静默替代；参数选择不等于后端身份认证。每文件同时一名写入者；构建、测试、共享环境操作串行；检索仅目标树和明确证据，不用其他 worktree 或 memory registry。

本包证据保存于新的 `.local/refactor/r6-trusted-editor-save-<唯一UTC时间戳>/`。提交前提供可定位的规范/验收入口，脱敏本地 raw artifacts 与可交付材料分别标记；记录全部实际命令、起止/退出码、输入/资产/构建/依赖、攻击前后差异、normal保存、审查处理与未知项。四项历史单测根因不因绿色复跑改变，地址及 R5 的旧记录不覆写。

需要改变两文件/256KiB合同、扩张公用帧、放开来源脚本、绕过Main、迁移ID、重构R3或解除R4、覆盖保护输入、放宽旧门槛，或无法实现有界撤销/unknown处理时，先报告具体冲突并修订范围。常规实现选择由实施者在上述合同内解决，不为每个阶段另设审批。

完成本包实现、适用层级验证、独立审查和回执后停止；不自动提交、推送、修改远端 PR、合并、发布、部署或进入 S4/下一包。
