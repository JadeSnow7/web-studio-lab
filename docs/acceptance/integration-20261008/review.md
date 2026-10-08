# 主线程审查记录

基准为 9e1df45；下述发现与阶段验收分开，未解决项不能作为通过。

| ID  | 发现与证据                                                                                                                                                                      | 状态                                                               |
| --- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------ |
| F01 | Electron全量44通过/1失败；窄窗900×700，原生网页与DOM容器width差196。相同workbench文件重跑9通过/1同失败。原文 evidence/baseline/electron-unsandboxed.json、workbench-repeat.json | 已确认测试时序：4轮原生探针34–46ms内全部bounds收敛；待改为条件轮询 |
| F02 | 候选router固定taskflow-demo、Browser webcontents:N、Terminal sessionId、File source/read/watch身份不同，不能用于多空间                                                          | Phase1/2适配                                                       |
| F03 | 候选Browser监听没有dispose；需释放事件和拒绝关闭后迟到结果                                                                                                                      | Phase1已修复并验证                                                 |
| F04 | 当前ARCHITECTURE仍有“未落地应用源码”、已退役state/runs路径、任务权威定位与实际Main不符；远端606参赛材料也绑定仅VS001的旧main                                                    | 最后按最终源码同步当前文档，保留历史事实                           |
| F05 | 全树lint固定VS001 cdp.ts prefer-const；format失败包含封存证据、VS001及当前文档。不能通过自动改写证据制造通过                                                                    | 已分类，最终仍独立报告全树结果                                     |

主线程已亲读基准检查的原始命令、退出码、stdout/stderr，以及Main application/host/repository/IPC/preload/窗口/菜单、native PreviewController/公开文档代理、service进程/chat/PTY/资源存储、协议及候选核心Provider。完整逐文件覆盖汇总随最终源码补齐，不将文件清单当作已审查。

## Phase1 审查结论

主线程逐行阅读16项源码、测试与依赖差异，检查稳定资源身份、取消/关闭后的迟到结果、文件root descriptor与符号链接边界、watch释放、VT游标/缺口、SSH host pin与SFTP预算。审查补入Terminal dispose后拒绝resize与晚输出。原始负例5失败证明旧候选不满足当前契约；最终typecheck、全量unit（341通过/8 live跳过）、定向lint/format与build均通过且执行期间revision不变。证据与源码SHA见[evidence/phase1-source-manifest.json](evidence/phase1-source-manifest.json)。此阶段Provider尚未接入产品界面，不能作为集成验收通过。

| ID  | 后续发现                                                                                                                                                   | 状态                                                                                  |
| --- | ---------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------- |
| F06 | Sidebar自落点拖拽先删除自身后indexOf=-1，真实窗口中首标签移位；sources/sidebar-selfdrop-probe.json                                                         | 待Phase3修复                                                                          |
| F07 | Session选择v2后selectedRunId仍指v1，任务正文与运行日志错配；sources/history-version-probe.json                                                             | 待Phase3修复                                                                          |
| F08 | VS001 verifyManifest 只在 B05 passed 分支重评观察证据；单独 B03 passed 且无 identity/observation/CDP 的合成负例仍被接受；sources/vs001-verifier-probe.json | 待独立修复复核器，固定目标、fixture、postcondition 与历史指纹不变；新方法版本单独记录 |
| F09 | 远程文件图片结果误标 disk，文本结果正确标 sftp                                                                                                             | Phase2a 已修复，负例与最终回归通过                                                    |
| F10 | LocalTerminal helper 未确认清理后 child=null，及 SSH 断线后 shell=null，close/shutdown 仍可返回成功，令未知进程被当作已关闭                                | Phase2a 已修复；启动前、启动中及关闭中断线均保留 unknown，失败及复验原文保留          |
| F11 | sandbox Terminal 输出截断未增加 outputOffset；超过 262144 字符后 renderer 不能判断新窗口偏移                                                               | Phase2a 同一 PTY 连续输出回归通过；Phase3 消费者接线待完成                            |

## 全量静态覆盖

来源审查的 2974 条文件台账见 [sources/file-ledger.json](sources/file-ledger.json)；这是来源差异裁决，不代表 2974 个独立产品文件。Renderer、非 live 测试、配置与固定展示内容的 138 文件正文审查见 [sources/review-renderer.md](sources/review-renderer.md)。

主线程另行读取 Main 工作台 application/host/repository/ports/layout、启动与关闭、IPC/来源校验/preload/菜单、PreviewController 和公开文档代理、所有既有协议，以及 service 的 Codex/PTY/sbx/资源存储、guest 浏览器与 Python MCP。重点核对单一状态归属、持久化与失败回滚、跨空间代次、取消/清理确认、网络与文件边界；新代码按各阶段 manifest 补评，不能沿用基准结论。

现有 live 测试正文已逐项核对：真实对话两轮及 reset；sandbox 前台/后台进程、EOF 与 PID 清理；资源 nonce 不进入 prompt、要求实际 MCP 调用和精确内容；guest 浏览器 DOM/PNG 摘要与 sealed memfd 负例；空间运行及 PTY 跨页/跨空间实例保持。发现 guest-browser live 证据路径写死在旧目录、sbx UI live 未清理本轮 guestDir，交后续测试工作包修复。正文审查不构成 live 已执行通过。

## Phase2a 审查结论

主线程审查 26 个源码及测试文件，并核对最终 manifest 的全部 SHA256 与当前字节一致。最终 typecheck、build、改动文件 lint/format 与全量 unit（367 passed、8 live skipped）均通过；各回执执行期间 revision 稳定。原文为 `evidence/phase2a-final-*.json`。此结论只覆盖环境及服务适配，Main 与 MCP 接线尚未完成。

| ID  | 发现与证据                                                                                                                                                                                       | 修复与复验                                                                                                                                                                                                |
| --- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| F12 | 原 local helper 仅按原进程组清理；脱离后代仍活着时曾回报成功。`phase2a-detached-process-before.json` 的进程探针退出码 0 仅代表探针执行完毕，`owned_detached_child_alive=true` 才是该场景失败依据 | 按本轮随机继承标记、用户及进程出生身份识别后代，发信号前再次核对；不可核实时保留 unknown。相同探针最终 cleanup=true 且 child_alive=false。另测出生身份改变和标记不可读时不发信号；未声称实际制造 PID 重用 |
| F13 | 中文输入按字符数通过 TypeScript 边界后，UTF-8 字节超出 helper 预算，导致 PTY 异常退出                                                                                                            | 边界改为 UTF-8 字节预算；超额输入拒绝后，同一 PTY 仍可执行下一条命令。before 失败原文保留，最终回归通过                                                                                                   |

本地终端以当前用户权限运行，指定目录只是起始目录；文件观察的授权根是读取边界。这不是操作系统沙箱，也不保证清除主动移除继承标记的恶意进程。

基准 `9e1df45` 的 apps/packages/scripts/e2e/tests/fixtures 共 169 个执行源码文件：原 138 文件表映射其中 119 个；主线程补读 45 个，其余 5 个（service 与 e2e 的 Codex/sbx fixture、raw.d.ts、service Vite 配置）由独立审查补齐。没有剩余未读执行源码。fixture 的进程和清理回执是确定性模拟，不能作为 live 清理证据；新增代码仍按阶段独立审查。

## MCP 候选专项审查（尚待接线复验）

冻结来源 `14-_worktrees/apps/service/src/` 的代码审查发现以下缺口；当前结论是源码路径分析，不把它记作已执行的运行失败。

| ID  | 触发与来源                                                                                                                                                                   | 当前处置                                                                                       |
| --- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------- |
| F14 | codex-chat.ts 的 observation reader 没有 AbortSignal（117–119、348、424–428）；取消只关闭 guest/丢结果；guest-helper.py 195–198 的 socket 超时只删除客户端，宿主观察仍可继续 | 2b 迁入时按 turn/request 传播取消、超时和断开，补 Main/provider 负例                           |
| F15 | codex-chat.ts 347–357 未限制完整返回帧；guest-helper.py 239–241 先拒绝超过 1 MiB 控制 buffer，255–257 的结果降级来不及执行；大结果可终止整条 helper 通道                     | 2b 写入前按完整 JSON 的 UTF-8 字节预算返回有界工具错误，Python 独立校验；补多字节输入/结果负例 |

迁入保留最多 4 个在途 socket 客户端、每轮 64 次、16 KiB 请求、唯一 call ID 及 process/cancel 的迟到保护。socket/client/临时目录改为明确 finally 释放；没有把对象隐式释放记成已复现的持久泄漏。

## Phase2b Main 中途复审

| ID  | 发现                                                                                                                       | 证据与当前处理                                                                                                                     |
| --- | -------------------------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------- |
| F16 | 观察跨 I/O 持有 record 引用；无关命令回滚替换快照后可能写入脱离对象。Provider schema 合法仍可能串回其他 workspace/instance | 改为每次归并按冻结请求重新定位；比较完整资源身份；补回滚和错误来源回归，待阶段终验                                                 |
| F17 | Provider 结果先完成，但归档延迟期间取消会改为 cancelled，导致记录与归档语义冲突                                            | `phase2b-archive-budget-before.json` 确认失败。按首次 Main 元数据归并确定完成/取消先后，完成后的取消不改变已确定结果；待同场景复验 |
| F18 | 历史窗口会移出 Provider 已完成但仍在归档的活动记录，最终写回找不到记录                                                     | 同一 before 原文确认失败；移出候选必须排除活动请求。200 是近期窗口，不是终身读取额度；旧证据继续保留                               |
| F19 | 每轮 64 次预算从可淘汰历史计数；滚动窗口后计数归零，可继续调用                                                             | 同一 before 原文确认失败；改为运行独立计数，待同场景复验                                                                           |

`phase2b-archive-before.json` 包含早期 run fixture 缺少 toolExecutions 的失败，不能单独证明 F19；修正 fixture 后的 `phase2b-archive-budget-before.json` 为 3 failed/6 passed，明确复现上述三个实际窗口。

Host、ports、ChatService、具名 IPC/preload 和协议经独立只读审查：实际 WebContents、Main 实例 binding、AbortSignal 传递、监听释放及 IPC 来源边界未发现新增可确认缺陷。该子段仍须以最终 manifest 对比，并以回归验证运行行为。

| ID  | 后续边界复查                                                                                                                                                     | 当前处置                                                                                                             |
| --- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------- |
| F20 | sandbox TerminalWrite 在宿主按 65536 字符校验，guest helper 按 65536 UTF-8 字节校验；大量中文输入可过宿主后令 helper 退出。LocalTerminal 的 F13 修复未覆盖此通路 | 统一 TerminalWrite 与工作台写输入边界的 UTF-8 字节预算；补拒绝大中文输入后同一终端继续工作的负例，待阶段及 live 复验 |

| ID  | 恢复边界复查                                                                                                                                                                                            | 当前处置                                                                                              |
| --- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------- |
| F21 | startRun 仅比较旧 TaskVersion.capture 的 webContentsId/documentGeneration；Electron 重启重用数字 ID、Controller 从零计数时，直接启动旧版本可能误认现场当前有效。Session 的 stale 标记只保护重新确认入口 | 补保存/恢复后重用两个数字 ID 的负例；新版本冻结 Main 实例绑定，旧版本无绑定需重新采集确认，历史不删除 |

## Phase2b 最终复审

主线程完成 41 个源文件和旧测试差异审查，并逐项核验 v2 manifest SHA256。独立补审覆盖 Main 恢复、完成/取消顺序、归档窗口、运行预算和终态释放，未发现新增可确认缺陷。schema 1 明确迁移到 2；旧文件/SSH 占位不授予环境，持久化去除活动句柄，不重放进程。浏览文件的 sessionId/runId 明确为空，空间会话与 MCP 则冻结真实身份。

F14–F21 的对应回归在最终全量单元 393 passed / 8 既有 live skipped 中通过；类型、构建、改动文件 lint/format、Python 语法及 diff 检查通过。原始回执执行期间 revision 一致，源码及命令见 [v2 清单](evidence/phase2b-final-source-manifest-v2.json)。v1 清单和失败原文保留为历史。F20 的早期 before 因 fixture 时序尚未进入中文断言，不作为实际中文故障证明；最终边界回归确实覆盖拒绝后同一 PTY 继续工作。

| ID  | 收尾发现                                                                              | 处理与证据                                                                                                                                                                                                           |
| --- | ------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| F22 | Python 观察仅限制参数长度，未计算工具名/外壳/换行；向断开客户端 sendall 时静默吞错    | 完整 UTF-8 帧在连接前拒绝；断开明确 emit cancel、关闭该客户端。before 两个断言失败；after 三个 Python 场景通过。实际 Unix socket 与 socketpair 已运行，后者执行源代码提取的 delivery 分支，不等于完整 guest 生命周期 |
| F23 | guest helper 在拆换行之前限制累计控制 buffer 为 1 MiB，多条合法大帧合并读取时可能误拒 | 源码分析待验证；列入 Phase4 每帧预算及完整 guest 通路回归，尚未修复或宣称通过                                                                                                                                        |

此工作包未执行 renderer 产品、Electron、packaged 或真实模型验收；整体仍为 undetermined。

## Phase3 中途界面复审

初始 `phase3-presentation-before.json` 为 4 failed：自拖移位、历史版本对话以及两个终端增量断言。前两项直接证明原展示问题；后两个用例误把 outputOffset 当输出终点，不能作为真实 Provider 契约证据。独立复审核对 local/sandbox/SSH 的 outputOffset 实为已裁掉前缀长度，即保留窗口起点。

按真实语义新增 `phase3-provider-offset-before.json`，原文为 1 failed / 4 passed，证明 offset=0 且输出从 abc 增至 abcd 时新字符 d 被漏写。修复须按 previousEnd=previous.offset+previous.output.length、nextStart=next.offset 算区间；最终还需实际本地 PTY→xterm 可见输出复验。原始错误假设的记录保留，不改写为有效 Provider 证明。

Files/Observation/新建环境表单预审要求：IME确认不提交；截图和文件图片显示实际只读预览而非base64正文；目录与搜索结果使用请求冻结的路径；缺配置按 capability 禁用，不用默认环境掩盖失败。当前仍在实施，尚未作为界面通过。

当前文档独立阅读发现的三项实际误导已修正：旧机器OAuth/smoke只代表历史；sbx只为sandbox能力所需；Provider级SSH回环不等于产品链路或外部主机验收。另一个审稿意见把尚待Phase4的VS001修复当作已实现，经工作树与源码核对后纠正，E06现在明确F08尚待修复。导出工具迁入前标为待接入。最终文档验收仍须对应完成源码。

| ID  | 观察准备阶段竞态                                                                                                                                                                                                              | 处置                                                                                                                                                           |
| --- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| F24 | observe 先等待环境查询，后登记 record/controller；此间 UI 已可取消，但 Main 尚无记录而拒绝取消。`phase3-preflight-cancel-before.json` 按用例名过滤，1 failed / 13 未选择，直接断言 cancelled.ok=false；未选择不是新增测试skip | 沿现有 Main 记录先冻结完整身份并保存，再在队列外刷新环境能力。取消不能启动Provider；环境失败须终结同一记录并释放活动slot，列表不能混入后创建资源。修复与复验中 |

## Phase3 首次正式回归

本阶段首轮类型、构建、改动文件 lint/format、严格 UI 静态审计通过，全量 unit 为 403 passed / 8 既有 live skipped；回执执行期间指纹稳定。这些是首次冻结版本的阶段结果，不能代替修复后的最终验证。

`phase3-final-electron.json` 原文为 41 passed / 6 failed / 2 live skipped，另有一个 worker teardown timeout。新增八个文件/观察窗口场景通过，包括只读 PNG 实际解码、续读与可点击搜索、失败表单重试、原会话归属、真实本地 PTY 增量和裁剪窗口、程序 composition 保护。程序拖放与 composition 事件不构成真实原生拖拽或中文候选窗验收。

| ID  | 发现                                                                                                                                                   | 处置                                                                                                    |
| --- | ------------------------------------------------------------------------------------------------------------------------------------------------------ | ------------------------------------------------------------------------------------------------------- |
| F25 | 首次启动查询到 sandbox 正在检查的环境快照后，状态变为可用却未更新 Main 环境投影；Terminal 持续禁用。失败窗口顶部显示对话已连接，面板仍显示正在检查 sbx | 修复 Main 状态变化到环境快照的更新/广播链路；不让 renderer 引入独立能力判断，不在测试中手动刷新绕过故障 |

其余失败须分别解释：未启动资源的 terminal 为 null，负例调用要求快照存在的 helper 是测试假设错误；一次保存对话框点击时 Electron 提前关闭并伴随 worker 清理超时，原因仍待同场景复验。主线程另发现 sbx live 首页输入框误用了空间会话的 aria-label，要求恢复准确定位；该 live 用例尚未执行，不能称为已复现的模型失败。所有失败原文保留，下一轮重新冻结后独立运行验证。

## Phase3 最终源码审查与环境缺口

26 个源文件由主线程逐项复读并核对 [v3 manifest](evidence/phase3-final-source-manifest-v3.json) 的全部 SHA256；9 份 v2 回执和 52 份证据附录指纹均一致。文件标签与会话上下文观察接入 Main，原生 select 明确环境，图片以只读 raster 显示，续读/搜索/失败重试可见。F06 自拖、F07 历史版本/运行/对话、F11 终端绝对输出区间、F24 观察预处理取消与归属已完成相应回归。

F25 已修复：Main 在执行器状态改变时刷新权威环境、增加 seq 并广播；旧查询的成功或失败均不能覆盖新结果。首次启动不可用时终端保持 null，UI 明确禁用；新鲜 profile 下首次连接及关闭场景复验通过。最终全量单元 406 passed / 8 既有 live skipped；类型、构建、改动 lint/format、diff 和严格 UI 静态审计通过。v2 产品源码在 v3 清单中保持相同字节。

Electron 相关子集为 46 passed / 1 failed / 2 live skipped，不是全部 Electron 测试。剩余 R3 原生 WebContents 焦点失败在独立复跑中重现。只读探针显示窗口始终 visible=true/minimized=false、Window.isFocused=false、无 focused WebContents；Main 已正确切换 activePane，未见浮层晚恢复或 F25 导致的 blur。应用 focus/show 对照也未获得系统焦点。

F26 的环境前置由主线程 CUA 直接确认：Mac 已锁定且自动解锁失败，见 [原生工具记录](evidence/phase3-native-lock.json)。因此原生焦点、实际拖拽和中文候选窗验收为 blocked_environment / undetermined；原焦点实现和测试断言保持不变。用户已收到手动解锁请求，解锁后重跑。仅本轮探针 PID 50142 在精确可执行文件/profile 核对后关闭并确认退出；诊断收尾 dispatcher 报错保留，不冒充产品正常关闭证据。

本阶段形成可继续整合的本地工作包，仍需 Phase4 工具修复、真实 SSH 产品链路、全部 Electron、packaged、live 和解锁后的原生验收。阶段回执指纹冻结的是当时源码与文档；本节后写的审查说明不能宣称已被这些回执重新验证。

## Phase4a 工具边界修复预审

F08：独立通过的 B03/B04 现在分别要求实际观察及匹配的 Runtime.evaluate、后条件重算及异常一致；任一 passed 必须 performed。原 VS001 固定目标、样本、断言及历史证据保持不变。`phase4a-verifier-before.json` 中 B04/performed 用例先被合法 JSON 字段顺序误拒，不能作为对应缺陷的复现证据；隔离旧 verifier 的 `phase4a-verifier-before-v2.json` 使用校正后的合法夹具，三项负例均到达预期缺口。独立 `phase4a-identity-order-before.json` 保存字段顺序误拒，修复以契约解析后的字段值比较身份。

F23：guest 控制输入按每条完整消息和未完成尾段分别限制 1 MiB，避免合并读取时将两个合法消息共用预算。原始失败 `phase4a-parser-before.json` 驱动的是实际 stdin 分支抽取，修后用 64 KiB 分块验证合法跨块消息和超限拒绝；这不等同于完整 guest 生命周期验收。

同包迁入参赛稿件导出工具，保留历史 URL、PDF 内部证据索引及明确本地文件链接；导出运行和版面验收分别记录。live 测试去掉过期主树输出路径，按本轮 UUID 目录清理，清理错误与原测试失败均保留；build 专用的受控传输测试明确不用于 packaged 产品。正式终验以本阶段新回执为准。

Phase4a 经主线程逐文件和原始回执复核，以 `46cab72` 保存。`phase4a-v2-unit.json` 捕获文件监听测试错误地要求只有一个提示：OS 在 closed 前产生合法 rename，不能因此推定 Provider 失败。修后验证每条提示的身份/序号、closed 恰一次且最后、两次 close 与关闭后读取拒绝；Provider 未改。v3 为 406 pass/8 live skip，文件定向 13 pass，类型及本包 lint/format/diff 通过；未变工具/生产字节的 v2 构建、自检和文档回执范围在 manifest 单列。新 VS001 方法指纹为 `94536a5749212a9526ef89c53a3c4b8e39b8f06a2f69d996eff46d0369e3e332`，不替换 E09 历史指纹。

Phase4a PDF 独立复核覆盖全部九页，15 处现有 E 索引跳转、E01–E14 标题、中文嵌入字体与跨页表头均正常。PNG 与来源指纹保存在 `evidence/phase4a-pdf-review/`；生成 PDF 在 output/submission，未作为代码或历史成功证明提交。

独立文档走查校正了两处会影响新维护者的操作：当前 host 仅注册 demo 与受控公开 HTTPS 文档，不支持 localhost 运行预览或 guest 服务端口转发；本地文件读取经 PATH 的 Python 3 做 openat/dir_fd，而本地 PTY 固定使用 `/usr/bin/python3`。结论由当前 `host.ts`、`observation-files.ts` 和 `local-terminal.ts` 的实际调用复核，不从规划文字推断能力。

F27 精确探针在五轮中四轮复现：一次 members 提交使 initial index 与 members 两次 loadURL Promise 重叠；旧 Promise 先报 error.url=members，旧 index 的迟到 did-fail-load 随后使新 Promise 报 index 的 -3，虽然最终页面成功。`phase4b-navigation-probe-1.json` 同时保存唯一 submit、load ID、IPC commandId 和结果；这比旧 focus probe 提供了完整归因，修复与复验另记。
