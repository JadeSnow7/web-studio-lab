# 2026-10-10 全面代码审查与缺陷修复

本轮已复现并修复 11 类缺陷，包含服务与 Main 联合测试发现的取消回执错误。最终离线测试 564 项通过，构建版 Electron 76 项通过。打包版 Electron 69 项、真实模型 Electron 5 项通过。本文不代表整仓产品接受。

## 基线与归属

- 仓库：`JadeSnow7/web-studio-lab`，HEAD `cf62dc74f49e7f9e81598be7b9e5109cf5946e9c`，叠加开始时全部未提交和未跟踪内容。
- [初始状态](evidence/initial-status.txt)和[初始指纹](evidence/initial-manifest.json)记录 3,177 个文件。已有 branding、面板、关闭流程修改及历史证据均属于输入基线，不归作本轮修复。
- 主线程负责审查、定级、验收和报告；两个 `coder` 分别承担有明确文件归属的修改；另有独立只读复审。没有提交、推送、发布、签名或公证。
- 继续使用现有 IPC、业务命令和持久化 schema。未改变冻结 VS001、模板锁文件、任务固定验收，未补做尚未实现的比赛功能。

## 已确认缺陷

严重度：P1 表示执行控制、权限或证据事实错误；P2 表示局部交互、恢复或输入保留错误。F01–F11 均已修复并复验关闭；[机器可读验收索引](evidence/validation-summary.json)区分各类检查与未验证范围。下列行号指修复后的源码。每项负例都曾在错误实现上实际失败；早期夹具错误及环境限制日志也保留，不计作产品缺陷证据。

| ID / 等级                                 | 触发及影响                                                                                                                                                                       | 修复位置与行为                                                                                                                                                                                                                  | 判错基线与复验                                                                                                                                                                          |
| ----------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| F01 / P1 终端清理事实未落盘               | 终端停止、自然退出或未创建进程的启动失败后重启；旧 `cleanupPending` 留在磁盘，恢复后永久误判未清理。                                                                             | `apps/desktop/src/main/workbench/application.ts:1783`：生命周期、错误、清理状态变化持久化；纯输出继续合并广播；保存失败显示 `storageError`。                                                                                    | `workbench-setup-corrected-red.txt`；`review-lifecycle.test.ts` 三种重启及保存失败负例；`workbench-setup-green-final.txt`、最终全量回归通过。                                           |
| F02 / P1 撤销 App 租约后旧 GET 放行       | 当前租约撤销或替换，静态 origin 白名单仍允许旧地址 GET，浏览器继续访问不再受管的地址。                                                                                           | `apps/desktop/src/main/preview/public-protocol.ts:55`：有可撤销租约提供器时所有受管请求依赖当前租约；保留 demo 和无租约提供器的固定可信只读地址。                                                                               | `workbench-red.txt`、协议单元回归；修复过程中的固定 VS001 地址误伤也保留并已纠正；冻结 VS001 实际通过。                                                                                 |
| F03 / P2 迟到截图抢回旧导航               | 截图挂起后切空间、全局页面、资源标签，或双窗格中以键盘切会话视图；完成回调强制定位原会话。                                                                                       | `state/capture.ts:23`、`state/workspace.ts:80`、`state/shell.ts:65`、`workspace/Session.tsx:159`：复用既有导航代次；保留原会话证据，仅在代次仍当前时自动定位。采集自己打开目标不会使自己失效。                                  | `renderer-red.txt`、`renderer-e2e-red-host.txt`、修正选择器后的 `renderer-e2e-space-red-host.txt`、`renderer-session-view-red.txt`；最终 10 项新增 Electron 回归及完整构建版通过。      |
| F04 / P1 App 关闭及操作并发               | 关闭后导出、重复停止、停止与启动/导出交错、跨项目注册表写入逆序；可发生新 helper 启动、清理回执混淆或旧状态覆盖新状态。                                                          | `apps/service/src/app-service.ts:161,614,639,664`：关闭同步封闭入口；重复停止共享 promise；锁持续到落盘完成；有限 helper 可立即停止；注册表按调用顺序发布；运行 App 仍先撤映射再关进程。                                        | `service-red-03.txt`、`service-red-export-stop.txt`；`service-green-05.txt`；真实 App 启停、持久化、导出及三种故障清理通过。                                                            |
| F05 / P1 启动 I/O 阻塞取消                | 挂起注册会话、资源预检或前置资源提交；Renderer/Main/Service 队列使取消排在启动后，迟到启动可能执行新动作。                                                                       | `application.ts:1308,1513`、`state/workspace.ts:40`、`apps/service/src/index.ts:77`、`codex-chat.ts:532`：先持久化运行归属，外部启动 I/O 离开元数据队列；取消绕过等待，撤销正在准备及已排队发送；派发和归属检查同一临界段完成。 | `workbench-setup-corrected-red.txt`、`service-red-index-03.txt`、`service-red-queued-send.txt`、`renderer-red.txt`；原门闩、资源提交顺序约束及真实 Electron 启动回执挂起/取消回归通过。 |
| F06 / P1 确认了旧验收条件                 | 当前条件自动保存失败后点击确认/发送，Main 从旧保存状态冻结条件，UI 显示与任务版本不一致。                                                                                        | `workspace/Session.tsx:108,124`：使用现有 `confirmTask` 的 acceptance、allowedScopes 字段冻结当前输入；确认失败不切视图。                                                                                                       | `renderer-e2e-red-host.txt`；注入条件保存失败后分别确认/发送，断言版本精确等于当前输入；最终 Electron 通过。                                                                            |
| F07 / P2 导航失败丢地址输入               | 地址被拒绝或导航失败，提交后立即清空草稿并失焦；迟到成功还可能清除新输入。                                                                                                       | `workspace/Browser.tsx:127`：只对匹配请求和草稿版本的成功回执清理；失败保留输入与焦点；相同挂起提交去重，IME 合成期间不提交。                                                                                                   | `renderer-e2e-red-host.txt`；拒绝地址、重复提交、中文合成事件、新输入覆盖的 Electron 回归通过。                                                                                         |
| F08 / P2 导入失败残留临时归档             | 依赖归档打开后的读取/写入失败发生在原 `try` 之外，留下 `.wsl-deps.tar.gz`，后续导入因独占创建失败。                                                                              | `apps/service/src/app-helper.py:70`：创建、读取和写入纳入同一清理边界；只删除本次成功创建的归档，保留预先存在的文件。                                                                                                           | `service-red-03.txt`；真实 Python helper 故障注入、重试和既有归档保留测试通过。                                                                                                         |
| F09 / P1 Setup 关闭后仍接受新操作         | SetupManager 已 shutdown，后续 check/prepare/save/login 仍可启动检查、修改设置或认证流程。                                                                                       | `apps/desktop/src/main/setup.ts:89,114`：关闭后拒绝新操作；保留内部所属登录清理、恢复和重复 shutdown。                                                                                                                          | `setup-after-shutdown-repro.txt`、`setup-red.txt`；Setup 单元回归与全量回归通过。                                                                                                       |
| F10 / P2 取消后迟到回执清空草稿           | Main 已取消运行，Renderer 仍等待旧 startRun 响应；释放旧 running 快照后错误清空输入。                                                                                            | `workspace/Session.tsx:140`：依据已做序号去重的当前 Main 投影判断是否确认输入，保留取消/失败后的草稿。                                                                                                                          | `renderer-e2e-green-final-host.txt` 中新增第九项失败；`renderer-e2e-green-final-2-host.txt` 9/9、后续 10/10 和完整构建版通过。                                                          |
| F11 / P1 Service 取消回执与 Main 契约不符 | 真正 CodexChat 在预检阶段取消时返回旧 idle/seq/turnId；无历史时 Main 误记 completed，有历史时卡 cancelling。仅 mock cancelled 回执的测试漏检。尚未进入预检的排队发送有同样问题。 | `apps/service/src/codex-chat.ts:527`、`index.ts:177`：发送准备阶段预分配 turnId；发布新序号的 cancelled、cleanupPending=false 回执，保留只读预检期间的资源冻结；排队发送取消同样获得新归属。                                    | `cross-layer-preflight-repro.txt` 区分真实 Main/模拟 Service；`service-receipt-red-02.txt` 为真实 Main+CodexChat 联合负例；`service-receipt-green-03.txt` 88/88；最终全量 564 通过。    |

Renderer 简写路径均位于 `apps/desktop/src/renderer/src/`。工作台应用简称 `application.ts` 位于 `apps/desktop/src/main/workbench/`。

## 覆盖矩阵与边界

| 模块                 | 审阅及验证内容                                                                               | 本轮证据边界                                                                       |
| -------------------- | -------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------- |
| Main / 工作台 / 仓储 | 快照串行写入、失败回滚、任务/运行归属、重启恢复、终端状态、迟到事件                          | 单元故障注入、真实文件仓储和 Electron 恢复；不以模拟保存成功推断断电原子性。       |
| Service / App / 终端 | 启停并发、helper/后代进程、撤映射、清理回执、共享注册表、三层取消                            | 离线门闩及真实 sandbox；真实 Main+Service 联合覆盖回执契约。                       |
| Browser / IPC / 观察 | 主窗口顶层来源、具名输入 schema、租约、导航代次、截图归属、观察超时和迟到结果                | 协议/控制器测试、真实 Electron 原生 view、受控网页；公开网络及模型单独验收。       |
| Renderer             | 草稿、当前验收条件、重复提交、切空间/标签/视图、焦点、原生网页遮挡、退出                     | 完整 E2E及新增 10 项故障回归；中文输入覆盖合成事件，不声称人工中文输入法逐项验收。 |
| 文件 / SSH / MCP     | 授权根、符号链接、版本与续读、传输代次、SSH pin/断线 unknown、只读资源冻结                   | 本地真实文件/PTY、受控 SSH 服务和 MCP 测试；未使用用户真实远端 SSH 账户。          |
| 安装 / 模板 / 打包   | Setup 关闭、中断与失败恢复、载荷 SHA/平台、SQLite 持久化、A/B 隔离、源码导出、构建与打包路径 | 模板检查、27 项打包测试、内部未签名包；不代表签名、发布或陌生机器首次安装接受。    |

没有触发证据的问题不作猜测性修改。`EnvironmentResources` 类可被直接误用为 shutdown 后重新注册，但 Main `ChatService.request` 的同步 stopped 门禁封闭产品路径；在途本地、SSH 和文件初始化也检查归属。详见 [可达性复核](evidence/env-shutdown-repro.txt)，本轮未为不可达路径增设分支。

`guest-browser.live.test.ts` 固定使用历史 sandbox，不能选择本轮环境。本轮不操作该历史环境，不以普通 Browser 或其他 live 测试替代它的验收。

## 检查命令与证据

所有 pnpm 命令使用已存在的 `10.34.6`：

```sh
node /Users/huaodong/.npm/_npx/168ca33e231eaaf0/node_modules/pnpm/bin/pnpm.cjs <script>
```

| 实际命令 / 范围                                                                                                               | 结果                                                                                                                                           | 原始日志（以 .txt 原样保存）                                                                                                                                                                               |
| ----------------------------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `pnpm typecheck`                                                                                                              | 通过，包含协议、Service、Main、Renderer、E2E和冻结基线类型检查                                                                                 | [final-typecheck-02](evidence/final-typecheck-02.txt)                                                                                                                                                      |
| `node node_modules/vitest/vitest.mjs run --maxWorkers=2`，宿主环境                                                            | 73 文件、564 通过；6 文件/15 项显式 live 跳过                                                                                                  | [final-unit-host-02](evidence/final-unit-host-02.txt)                                                                                                                                                      |
| `node --test scripts/packaging/*.test.mjs`                                                                                    | 27/27 通过                                                                                                                                     | [final-packaging-tests](evidence/final-packaging-tests.txt)                                                                                                                                                |
| `node --import tsx --test tests/vertical-slice/selftest.test.ts`                                                              | 12/12 通过；仅离线判错自检                                                                                                                     | [final-selftest](evidence/final-selftest.txt)                                                                                                                                                              |
| `eslint apps/desktop/src apps/service/src packages scripts src e2e`，加 4 个构建/测试配置                                     | 当前源码通过                                                                                                                                   | [final-active-lint-03](evidence/final-active-lint-03.txt)                                                                                                                                                  |
| `prettier --check`，同上源码/配置范围                                                                                         | 当前源码通过                                                                                                                                   | [final-active-format-03](evidence/final-active-format-03.txt)                                                                                                                                              |
| `pnpm lint`、`pnpm format:check`                                                                                              | 整仓不通过；开始时已为 217 lint 错误、730 格式告警，涉及封存源码和固定基线；本轮生成记录也被扫描。没有重写证据、删断言或更改忽略规则制造通过。 | [baseline-lint](evidence/baseline-lint.txt)、[baseline-format](evidence/baseline-format.txt)、[final-global-lint](evidence/final-global-lint.txt)、[final-global-format](evidence/final-global-format.txt) |
| `npm ci --ignore-scripts --no-audit --no-fund --workspaces=false`，模板目录；随后 `npm run check`、`build`、`template:verify` | 通过；磁盘持久化、迁移/seed 幂等、A/B隔离、输入/session边界                                                                                    | [template-check](evidence/template-check.txt)、[template-build](evidence/template-build.txt)、[template-verify](evidence/template-verify.txt)                                                              |
| `pnpm package:unsigned`，内含 `pnpm build`                                                                                    | 最终源码构建及内部打包成功；跳过签名、公证，不发布                                                                                             | [final-package-unsigned](evidence/final-package-unsigned.txt)                                                                                                                                              |
| `playwright test --output=…/e2e-build-results`                                                                                | 76 通过、7 显式 live 跳过                                                                                                                      | [final-e2e-build](evidence/final-e2e-build.txt)                                                                                                                                                            |
| `WSL_E2E_TARGET=packaged … playwright test`                                                                                   | 69 通过、14 按现有环境/目标条件跳过                                                                                                            | [final-e2e-packaged](evidence/final-e2e-packaged.txt)                                                                                                                                                      |
| `node scripts/check-docs.mjs`、严格 UI 静态审计、`git diff --check`                                                           | 已通过，交付前复核；文档/静态 UI 检查不等同运行时验收                                                                                          | [final-docs-check](evidence/final-docs-check.txt)、[final-ui-audit](evidence/final-ui-audit.json)                                                                                                          |

完整命令索引见 [final-command-index](evidence/final-command-index.json)。一次扩大到整个 `apps` 目录的 lint 扫描纳入了本轮生成的 release-internal 打包副本，得到 1,769 个错误，见 [保留日志](evidence/final-active-lint-02.txt)；它不是当前源码检查通过的证据。随后显式检查真实源码和配置通过，没有修改忽略规则。

首次在受限环境跑全量测试出现 PTY/端口 EPERM、文件观察 EMFILE；宿主同套测试最终通过。`baseline-unit-host` 是添加负例期间的中间状态，不冒充未修改基线。旧实现的失败和修复后的通过日志分别保存。

## 真实链路与交付状态

原 `sbx` 登录服务错误在宿主执行权限下解除；未修改全局网络或凭据。第一处独立 sandbox 为 `wsl-review-20261010-5e83a9`，无宿主挂载；打包配置只接受固定 `wsl-competition-UUID`，因此另建本轮独立打包测试环境 `wsl-competition-1f4709e3-2a61-4c96-b4de-3b98ef7c30a1`，不放宽产品 schema。第二处首次创建遇到 Docker Hub 鉴权刷新超时，改用已锁定的镜像 digest 重试成功；原失败与重试日志分别保留，未修改凭据或网络策略。

- 真实 PTY/进程生命周期及只读资源 MCP：6 项通过，见 [live-lifecycle](evidence/live-lifecycle.txt)。
- 真实受管 App：身份、静态资源、A/B隔离、停止/重启持久化、导出 26 个源码文件、清理通过，见 [结果](evidence/live-app/result.json)。导入取消、启动取消、健康检查故障超时三阶段均通过，见 [故障结果](evidence/live-app-failures/failure-lifecycle-result.json)。
- 自动审批曾引用运行中的旧注册表而拒绝故障测试；重新读取确认 `stopped/cleanupConfirmed=true` 后，同一项目限定测试获准执行。没有绕过校验或操作其他项目。
- 真实 Electron 模型 5/5 通过：中文对话/续聊/隔离、Browser+本地文件+沙箱 PTY 统一观察、公开 example.com 资源/MCP、App 终端与 Codex 文件共享、切空间后运行归属及验证/审阅分离。见 [日志](evidence/final-e2e-live.txt)。
- 最终服务真实模型 MCP：实际 `list_resources`、`read_resource` 读取未放入 prompt 的 nonce，`cleanupPending=false`，见 [回执](evidence/final-live-model-mcp.txt)。这是受控内存资源，不冒称公开网页获取链路。
- 冻结 VS001 中间运行 `dbfc7bde-cf9e-47bc-a4db-dd58b388745e` B01–B05 全部通过，模型 `gpt-6-astra`；[证据副本](evidence/vs001-intermediate/manifest.json)保留，最终版本另行复跑 `7fac3715-79a1-43f3-9f1a-53962655713a`，B01–B05 再次全部通过，见 [最终记录](evidence/vs001-final/report.json)及[运行日志](evidence/final-live-vs001.txt)。
- 打包载荷身份负例：仅破坏临时副本的依赖归档，1/1 通过；设置返回 `payload-corrupt`，没有创建受管 App，宿主环境保持干净 PATH 且无 WSL 注入。见 [回执](evidence/package-hash-rejection/hash-rejection.json)和[日志](evidence/final-package-hash-rejection.txt)。
- 打包 App 第一次运行被人工打开的空间浮层干扰，第二次因 sbx exec EOF 及 daemon 重启中断。原始失败、运行数据及清理状态分别保留在 [人工干扰](evidence/packaged-app-interference/evidence.json)、[EOF 失败](evidence/packaged-app-eof/evidence.json)。独立 `sbx stop` 确认沙箱 stopped、sessions=0、ports=[] 后才结束本轮失败窗口；未改写应用的 cleanupConfirmed=false。
- 原生 CUA 实际看到了 App 页面、数据库就绪和正确的身份，以及空间切换浮层取得焦点、原生页面让位；未赶在自动化恢复前关闭浮层，因此不把人工观察算作完整通过。退出失败时也实际看到了“清理未确认”提示。见 [原生观察边界](evidence/native-ui-observation.json)。浮层关闭后的焦点恢复由既有 A12 Electron 测试覆盖。测试退出后原生观察曾额外拉起默认配置窗口（PID 59727），未在其中执行新建、发送或保存操作，随后已关闭；该窗口不计作独立 profile 验收。
- 打包 App 恢复后以独立 profile `wsl-review-packaged-app-20261010-recovered` 复跑，1/1 通过：产品 Browser 显示、身份、A/B隔离、多次启停、关闭窗口/重启恢复、源码逐文件核验、启动取消与清理均通过。`finalAwakePorts=[]`，`cleanupConfirmed=true`。见 [最终回执](evidence/packaged-app-final/evidence.json)、[关闭后注册表](evidence/packaged-app-final/registry-after-shutdown.json)和[日志](evidence/final-e2e-packaged-app-03.txt)。

未完成比赛整体闭环、独立验证适配器接入、签名发布、真实远端 SSH 账户验证及用户接受；这些不能由本轮测试通过推定。完整性结论限定于已审阅路径和实际执行证据，不声称不存在其他隐藏缺陷。

## 变更归属与复核

相对执行前指纹，本轮修改 19 个既有源码/测试文件，新增 3 个回归测试文件；其余 3,158 个初始文件保持原字节，没有初始文件丢失。实际增量见 [review-delta](evidence/review-delta.patch.txt)，不是将整个 dirty diff 归作本轮修改。[归属检查](evidence/preservation-check.json)确认历史证据与冻结基线未变；[源码指纹](evidence/final-source-manifest.json)记录 256 个源码、测试和脚本，[独立复审](evidence/independent-final-review.json)确认无漂移。

内部未签名产物位于 `apps/desktop/release-internal/`，包括 mac-arm64 App、DMG 和 ZIP；[产物指纹](evidence/final-package-manifest.json)绑定本轮测试对象。没有提交、推送、签名、公证、发布或部署。原始 `.log` 另以同字节 `.txt` 保存，保留环境失败、夹具错误、红例、修复后通过及 live 中断的区别。

两处本轮 sandbox 均已停止、会话为 0、无宿主挂载，保留测试数据；见 [第一处最终状态](evidence/final-review-sandbox-stopped.json)和[打包环境最终状态](evidence/final-packaged-sandbox-stopped.json)。两处唤醒状态下端口映射均为空，见 [第一处](evidence/final-review-sandbox-awake-ports.json)和打包 App 的 `finalAwakePorts`。记录的 13 个 Electron PID 均已退出；旧端口 49152 当前由系统 `rapportd`（PID 650）监听，未操作该进程，其他记录端口均不接受连接。见 [宿主归属复核](evidence/final-host-cleanup.json)。EOF 那次应用记录仍保留未确认状态，外部清理证据单独记录，不伪造应用成功回执。

交付复核见 [delivery-verification](evidence/delivery-verification.json)：256 个源码及 4 个内部产物无指纹漂移，报告链接无缺失；全部交付证据的字节指纹见 [evidence-index](evidence/evidence-index.json)。
