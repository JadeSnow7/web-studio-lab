# ADR-0004：Mota 可信人工编辑入口与 Main 保存授权（提案）

状态：**Proposed / 未实现**。日期：2026-10-18。依据版本：`e6bb391df4c1d6c0c6a884d6acdc4061e3027b3b`。本页只整合 R6 设计，不授权实施、关闭现有保存能力或运行 guest/模型；R6 仍未完成。编号 0003 沿用[模块化计划](../../plans/2026-10-17-modular-refactor-plan.md)中对可插拔 Harness ADR 的预留，本提案使用 0004。

本提案遵循[修订计划 R6](../../plans/2026-10-16-post-review-update-plan.md)、[架构基线](../../ARCHITECTURE.md)与[ADR-0002](0002-app-control-plane.md)。保留人工编辑 MT1 与配置并保存到隔离副本的能力；执行结束、验证通过与用户接受仍分别记录。R4 的违规/撤权/启动能力门禁、S4 的 OS 隔离和默认 E2E 出口分别结算，本设计不关闭其中任何一项。

## 当前事实与问题

当前调用链为：原生目录选择 → Main `collectMotaSource` 冻结 manifest/字节 → service 内置 helper 建立 guest 副本 → 内置 Node HTTP 服务 → 导入 `editor.html` 与导入脚本 → XHR `POST /writeFile` → `parseWrite` / nonce / baseline / lease → `writeSafe` / rename。

| 现状                                   | 定位与含义                                                                                                                                                                                                                                                                                       |
| -------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| Main 决定宿主来源，保存只写 guest 副本 | [host](../../../apps/desktop/src/main/workbench/host.ts#L38)、[collector](../../../apps/desktop/src/main/workbench/mota-source.ts#L137)、[helper](../../../apps/service/src/mota-helper.py#L12)；不回写原工作树或 Downloads 原件                                                                 |
| 导入编辑器不是可信产品代码             | [profile 必需文件](../../../packages/protocol/src/mota.ts#L9)、[protected 基线检查](../../../apps/service/src/mota-helper.py#L299)；摘要只证明内容等于导入基线，未证明脚本安全或人工意图                                                                                                         |
| game/editor 使用同一受管 origin        | [资源装配](../../../apps/desktop/src/main/workbench/application.ts#L1804)、[host](../../../apps/desktop/src/main/workbench/host.ts#L515)、[受管请求策略](../../../apps/desktop/src/main/preview/public-protocol.ts#L58)；分开的 Browser partition 与无 preload 不阻止同源 game 读取 editor HTML  |
| nonce 在可读取的 HTML/script 中        | [bootstrap](../../../apps/service/src/mota-server.cjs#L597)、[HTML 注入](../../../apps/service/src/mota-server.cjs#L665)、[HTTP 校验](../../../apps/service/src/mota-server.cjs#L858)；它选择读取快照，不能授权人工写入，服务不知道实际 frame/文档代次                                           |
| 既有写入约束应复用                     | [parseWrite / writeSafe](../../../apps/service/src/mota-server.cjs#L319)、[写入队列与 AI lease](../../../apps/service/src/mota-server.cjs#L705)；保留两文件、256 KiB、UTF-8/JSON、expected hash、路径/链接/目录身份、临时文件 sync + rename                                                      |
| guest 与宿主监听范围不同               | [guest port](../../../apps/service/src/app-helper.py#L587)、[Node listener](../../../apps/service/src/mota-server.cjs#L933)、[宿主映射](../../../apps/service/src/app-service.ts#L1007)；guest 为 `0.0.0.0:<guestPort>`，宿主发布为 `127.0.0.1:<hostPort>`，两者不可混称，也没有据此证明公网暴露 |

以上是固定源码的静态事实和风险路径定位，不是全仓安全审查或本轮真实攻击验证。历史正常保存通过不能证明恶意导入脚本拿不到写能力。

## 建议决定：一个产品编辑页，一条保存入口

首选实现为**专用原生 WebContentsView + 产品固定 `wsl-editor://mota/index.html` 入口**，使用单独 partition、专用窄 preload 和专用 sender guard。不同时建设工作台内 React 编辑器。若后续产品决定改用已有可信工作台 renderer 组件，先修订本 ADR 再实施，不把两套 UI 状态机并建。完整上游编辑 UX 只有在许可与整套传递依赖经过审查、固定为产品资产之后才另行评估。

产品页先保留 MT1 地图数据编辑、配置编辑、明确保存、冲突处理及游戏刷新核对。导入 HTML/JS、`project/*.js`、`libs`、`extensions`、`_server` 不得在有写能力的上下文执行。MT1 的赋值文本只按固定前缀 + JSON 解码，保留对象其余字段，不用 `eval` 或项目初始化代码。外来字符串只进入 `textContent`/表单值；预览仅使用有界被动栅格图片，不内联 SVG/HTML。

```text
人工点击产品编辑页的保存
  → editor 专用 read/save/close/status 窄桥
  → Main WorkbenchApplication 具名用例
  → service 人工编辑端口（与 AI Mota tools 分开）
  → 当前 App 进程私有 duplex 通道
  → guest 编辑会话与同一写入队列
  → 身份/版本/内容/lease 检查 → 唯一 writeSafe → 具名回执
```

game 继续使用无 preload 的原生 Browser。两个逻辑资源 `game/editor` 与资源 ID 保留；可信 editor 的实际最终 URL 将改为产品协议入口，不能宣称仍在执行原 `/editor.html`。旧 `/editor.html` 如保留，只是无写能力的来源内容展示。实现时同步更新资源 URL 契约、重开/重启和 E2E，不给导入页安装产品 preload。

三个边界分别成立：

- 产品资产协议只从构建内固定清单返回可信 HTML/JS/CSS；锁定全部可执行传递依赖、构建摘要与许可。禁止任意路径拼接、guest/import 代理、重定向或回落到导入 editor。打包从只读安装资产加载；开发 Vite 源属于开发者信任前提，不能视为任意同 origin 页面均可信。
- 编辑文档 CSP 以 `default-src 'none'; script-src 'self'; style-src 'self'; connect-src 'none'; frame-src 'none'; frame-ancestors 'none'; object-src 'none'; base-uri 'none'; form-action 'none'; worker-src 'none'` 为基线，图片仅按实际需要增加固定产品或解码栅格来源。禁止 inline/eval、外来脚本、iframe 和远程 fetch；开发策略单列。CSP 缩小加载面，不是保存授权。
- Main 每次校验登记的实际 WebContents、当前顶层 frame、最终固定入口、资产版本和导航代次。拒绝子 frame、about:blank/srcdoc、旧 frame、其他同 origin 路径与导入页 postMessage 代理。现有[主窗口 guard](../../../apps/desktop/src/main/ipc-guard.ts#L29)不扩为所有 Browser 白名单；编辑器单独检查 sender，不因此获得其他工作台 IPC。

新正常人工保存链与旧 HTTP `/writeFile`/写 nonce bootstrap 的关闭在**同一个实施和验收阶段**切换。HTTP 不创建编辑写会话，不提供保存能力；只读请求也不能提升为保存。不能以端口、Cookie、bearer、DOM nonce、Origin/Referer 或无请求范围限制的 `Network.setExtraHTTPHeaders` 替代实际来源与文档校验。

## Main 权威会话、绑定与撤销

`WorkbenchApplication` 是编辑授权唯一写入者；Host 只报告原生文档/句柄事实，service/guest 执行并报告事实。拟定用例为 `openMotaEditor`、`readMotaEditorFile`、`saveMotaEditorFile`、`closeMotaEditor`、`motaEditorOperationStatus`，不提供任意路径/HTTP/脚本代理。

| 对象     | 有效资源表与每次校验                                                                                                                                                                                                                           |
| -------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 编辑会话 | Main 根据当前映射创建，固定 workspace/environment/project/AppInstance/resource、browserInstance/generation、实际 webContents、顶层 frame process/routing、finalTrustedUrl、资产版本/摘要、documentGeneration、navigationEpoch、editorSessionId |
| 读取快照 | 只允许 `project/floors/MT1.js` 与 `_server/config.json`；返回文件与 expectedHash，配置不存在用显式 null，read 不授予 save                                                                                                                      |
| 保存请求 | 固定会话与文件枚举，携带 requestId、expectedHash、内容长度/contentHash；renderer 不指定 root、项目归属、AI 身份或可扩大预算                                                                                                                    |
| 当前实例 | service 再核对 running/project/AppInstance/所属进程/确认的私有 pipe，参考[现有 Mota 实例检查](../../../apps/service/src/app-service.ts#L1911)，不伪造 AI runId 或借用模型租约                                                                  |
| 写入许可 | guest 提交点再次核对会话 active、App identity、版本、内容与 AI lease；UI 禁用按钮不替代互斥                                                                                                                                                    |

会话状态为 `opening → active → revoked`；操作状态独立为 `staging → submitted → committed / failed / unknown`。editorSessionId/nonce 只索引 Main 记录，单独持有它不是授权。最终顶层文档完成且资产一致后才 active；已 revoked ID 不原地复活。现有 [beginNavigation](../../../apps/desktop/src/main/preview/controller.ts#L285) 已在导航开始同步推进私有 `navigationEpoch`；当前 `PageIdentity` 未公开它。专用编辑入口需接入/复用这一事实，使 Main 编辑会话绑定该代次并同步撤权，不能只等提交后的 `documentGeneration` 或 did-navigate 才关入口。

导航开始、redirect、frame 替换/最终文档不符、重载、关闭编辑 View、App stop/restart/instance 更换、资源 generation 更换、service/guest 失联都先撤销新动作。关闭 View 只撤编辑权限，保留未保存草稿与 running App；现有 [closeTab](../../../apps/desktop/src/main/workbench/application.ts#L2950) 和[历史窗口用例](../../../e2e/mota-app-live.spec.ts#L421)的生命周期边界须保留。重开恢复草稿但重新 read、重新绑定当前 hash；冲突保留双方内容。迟到响应只归原会话/操作，不更新新实例。

撤销先拒绝新动作并丢弃尚未提交暂存，随后等待所属撤销/操作回执。已在撤销前核对并派发的 commit 若先提交，按原会话记录成功；取消不承诺回滚。guest 在写入队列的 commit 校验点线性化，保存执行中到达的撤销不得被伪称已阻止 rename。若后续要求“导航开始后未 rename 的写入一律不得提交”，须另行明确 prepare/commit 与可抢占 revoke 的合同和时序测试。

## 私有通道与唯一写入点

现有 [stdin 帧](../../../apps/service/src/mota-server.cjs#L944) 上限 4096 字节，不能装入 256 KiB 文件。首选专用 `editor.open/read/stage/commit/revoke/status` 消息，独立于四个 AI 工具；不扩大 AI 帧或普通源码导出预算。

stage 使用分块：建议每块原始内容最多 1024 字节，同时检查完整 JSON 编码帧（含 LF）不超过既有 4096 字节，不能只按原始块估算。总原始内容不超过现有 256 KiB；完整 length/contentHash 匹配后才可 commit。实施前冻结会话数、每 App 在途 stage 数、帧数、总暂存、过期与截止预算，并验证外层 guest transport 的真实上限；缺失/乱序/超预算均不写目标。此处不批准修改既有超时或断言。

guest 会话只能由私有通道创建；stage 不写目标。commit 进入现有唯一队列，复用白名单、UTF-8/JSON、当前哈希、路径/链接/目录身份、lease 与 `writeSafe`，不新增直接 `fs.writeFile` 路径。保存成功使 AI 旧 expectedHash 失效，AI 改图也使人工旧快照冲突。

回执绑定 session/request/file/beforeHash/afterHash/contentHash/AppInstance。相同 requestId+载荷返回原结果，不重写；不同载荷冲突。超时/断线保留 unknown 与所属占用，查询原操作，不自动重放。rename 后目录 sync/close、持久化或通知失败仍保留已提交事实，参考 [AI 已提交回执处理](../../../apps/service/src/mota-server.cjs#L814)，不能抹成未写或再次覆盖。

## 实施阶段与待验证矩阵

1. 冻结协议、资产来源、文件语义、身份、撤销线性化点与有界传输；保存现有 nonce/HTTP 路径的失败基线。
2. 串行完成可信产品页/专用 Host guard、Main 用例/service 协议/guest 同队列提交，逐文件单写入者；不改模型能力门禁。
3. 同阶段切换新正常保存与关闭旧 HTTP 写入口，更新两个资源显示目标/生命周期合同，不产生中间不可保存版本。
4. 先完成以下定向正反例，再做离线与真实 Electron/guest 检查。guest、模型、packaged 分别遵守授权；静态审查不能替代执行。

以下全部为 **待实现 / not_run**：

| 场景                    | 要区分的输入与必须保留的证据                                                                                                                 |
| ----------------------- | -------------------------------------------------------------------------------------------------------------------------------------------- |
| 正常保存                | MT1 与配置存在/缺失；具名 Main 调用、相同身份回执、before/after hash、仅两目标变化、游戏刷新/重开读回、宿主原件不变                          |
| 恶意 game / 导入 editor | fetch editor、旧 HTTP、桥探测、postMessage、导入 libs/project 插件；产品有写页从未执行外来字节，目标 hash 不变                               |
| 资产与 frame            | 产品依赖替换/缺失、iframe 同 URL、about:blank/srcdoc、伪造 sender；加载/授权拒绝，清单与真实 frame 证据可核对                                |
| 最终文档与旧授权        | redirect、导航失败、其他 path、reload、in-page 导航、关闭后重发；导航开始撤权，旧会话不复活                                                  |
| 关闭重开                | 草稿保留、后台 save 被拒、App 仍 running；重新 read/授权后处理冲突                                                                           |
| 错项目/实例/代次        | project/workspace/resource/session 伪造、App restart、迟到响应；各边界拒绝，旧响应不污染新对象                                               |
| 直接 HTTP               | 伪造 Host/Origin/Referer/nonce/Cookie/header；无写会话与写入，两个文件 hash 不变                                                             |
| 内容与路径              | MT2、穿越/编码/链接、非法 UTF-8/JS/JSON、超长/人工协议信封未知字段；合法 floor/config 扩展数据字段保留，拒绝时不执行内容，保留两文件/256 KiB |
| 版本与 AI lease         | 同 h 两次保存、外部改/删/建配置、AI acquire/commit 交错；冲突保留草稿，互斥与旧 hash 失效成立，未知 lease 不释放                             |
| 分块与撤销              | 缺失/乱序/重复/超预算/超时；stage/commit 与 close/revoke 交错，不完整不写；实际线性化和 rename 可核对                                        |
| 幂等与未知              | 同/异载荷 requestId、掉回执、guest 崩溃；不重复写，unknown 查询原操作                                                                        |
| 提交后失败              | rename 后 sync/close、持久化或通知失败；提交 hash/回执保留，错误可查，不自动重放                                                             |
| 生命周期                | 关闭资源、stop/restart、shutdown 交错；先拒新动作，再核对所属清理，资源身份与正确显示目标持续成立                                            |

本轮依据为独立只读 R6 审查及 60 处引用核验，原材料在本机 `.local/refactor/2026-10-18T16-38-37Z-b1-n4-r6-w7kdrl04/r6/`。本页没有新增运行证据；正常保存目标未删减，R6、安全能力、第一阶段出口与用户接受仍各自待完成。
