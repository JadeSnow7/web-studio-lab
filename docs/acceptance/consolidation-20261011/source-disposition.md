# 全来源内容去重审查（2026-10-11）

结论：当前主线 ea3bad9 加主树未提交 App 控制面之后，source-01 空间 App 描述与任务绑定功能已适配整合，并完成最终独立静态复核。旧 detached/checkpoint 和两个统一观察树的当前文件哈希全部命中既有 2026-10-08 来源台账，不是新出现的内容；逐主题比对当前代码确认已有后续替代，不整树恢复。diagnostics 保留独立分支，不纳入产品增量。

本报告只读调查；未修改候选或任何原树源码，未执行测试。来源使用本轮冻结 manifest/status/patch，HEAD 内容使用 git 对象；不读取 Task5 clean 物理文件。下文“已包含/替代”是源码与来源结论，不是运行验收。

## source-01：已适配整合

基于 cf62dc7 的15个源码/测试改动路径均与 source-00 冻结内容不同，且不等于 ea3bad9 祖先同路径 blob。具体语义核对（以下指冻结source00，非最终候选）：主树 startRun（冻结 application.ts 1960后）只有 element.text，缺少结构化 page/element 与 App/guestCwd 冻结、组合 prompt 长度前置检查；当前 managed-app/workspace protocol 无 SpaceAppSchema/workspace.app/updateApp；当前 App 控制面负责工具与执行权限，不提供名称说明模型和编辑表单。

| 来源路径                                                          | 去向 / 冲突处理                                                                                                                                       | 冻结 SHA256                                                        |
| ----------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------ |
| `apps/desktop/src/main/workbench/application.ts`                  | 移植描述唯一写入、身份校验、创建持久化失败回滚、updateApp、任务App/guestCwd冻结与结构化观察及组合prompt限额。保留现catalog和异步runLaunch取消状态机。 | `fdbf6ae7dea3c695815988dbd8736eea1bb2d0a0c17f1558a21571cde2560ac3` |
| `apps/desktop/src/main/workbench/managed-app.test.ts`             | 移植描述编辑、失败/冲突、任务冻结、过长prompt等增量；适配现catalog测试仓储。                                                                          | `4e98391e7ddff1cb058dc7a04e1702dda159d7d921aed423bd316935bcd4b4b4` |
| `apps/desktop/src/main/workbench/observation-persistence.test.ts` | 随最终schema调整断言，保留原来runtime句柄不落盘检查；不能只复制3版本号。                                                                              | `2f528713116a22e0e56b0ec257e8c3344031cfc71a3f4ad5e675e7543e9c8bd3` |
| `apps/desktop/src/main/workbench/repository.ts`                   | 已实现schema4：分别识别含catalog与仅含snapshot的两种schema3来源，保全catalog/App/旧资源和原字节备份。                                                 | `ac65c6819e97ff411f7d0c82494cd378a3c9bc97cf2e44accf0f9a02db9aecd5` |
| `apps/desktop/src/renderer/src/pages/SpacePage.tsx`               | 移植稳定挂载AppEditor，保留现布局/遮挡逻辑。                                                                                                          | `b873426bcd5557b09a4aa4819302071dc1311be5cd551ba55e41af3098d64063` |
| `apps/desktop/src/renderer/src/shell/Overlays.tsx`                | 增加AppFormDialog焦点陷阱与焦点恢复；不替换其他对话框。                                                                                               | `f705ec031db1dfc68e1108dd6e6600ae91184f742ec6ddc5494c92bdf98ba527` |
| `apps/desktop/src/renderer/src/state/space-ui.ts`                 | 增加冻结打开目标和防重复打开/遮挡确认。                                                                                                               | `e78366721672b05b0ab19a1fc3d23a8cc367b2429c17e0997ba0e484f2097d62` |
| `apps/desktop/src/renderer/src/workspace/Sidebar.tsx`             | 移植名称说明展示、创建/编辑入口；适配当前受管App控件，不恢复旧侧栏。                                                                                  | `950eeb113758c2edf39fc76ac0754ae5063cfcafbfa296db66b2542d89536b4f` |
| `e2e/managed-app-live.spec.ts`                                    | 适配创建App表单交互，保留当前packaged/port清理验收逻辑。                                                                                              | `f2b2ff1f31d6ec29efdccb36794234dbf90e221b4496c783935cadbde5edbf76` |
| `packages/protocol/src/managed-app.ts`                            | 增加SpaceAppSchema稳定appId、projectId、名称、说明、revision。                                                                                        | `f209af03f5292605233bc82eba66efd4b17f188badff8deac3bf953db21cc8f2` |
| `packages/protocol/src/workspace.ts`                              | 增加workspace.app、taskVersion.appTarget、createApp参数、updateApp revision契约；保留catalog与控制面字段。                                            | `c0018859e5a209d43566a5b1b3d481638dabc3c9fd4aaa90f456730da8202f14` |
| `apps/desktop/src/main/workbench/space-app-persistence.test.ts`   | 新增并适配最终schema和catalog持久化接口，验证旧身份迁移与恢复。                                                                                       | `1ef295eaafc7abc8ec3efcc24863a84020f52f57d34c8ea14d58a002c1c7912c` |
| `apps/desktop/src/renderer/src/workspace/AppEditor.tsx`           | 新增稳定表单组件，保留失败草稿/IME/busy/创建失败后转编辑语义。                                                                                        | `90f7ecb58fe9191b71b10fbc3fd5554b296b154e6aefef67a441129f8effd6f0` |
| `e2e/space-app-model-live.spec.ts`                                | 保留opt-in真实模型测试，不默认运行。                                                                                                                  | `949d9370605d75326072484da5d5550af2c0dc0601897b5074df48849cac6461` |
| `e2e/space-app.spec.ts`                                           | 移植受控UI fixture回归；适配当前shell导航和catalog接口。                                                                                              | `a5b5b48d5d513a9e234c54d91012dd4baca2f56df0590140bfeaae89698942c3` |

source01 的 README、UX-CONTRACT、current-runtime 说明已同步为最终事实；其 space-app-model/live 历史记录保持来源身份，不计为本轮执行。来源与适配记录见[源清单](source-inventory.json)、上表及[历史导入哈希](history-imports.json)。

## 旧 detached/checkpoint 与统一观察：哈希证据

本轮 manifest 的每个文件以 `(path, sha256)` 对照已提交 `docs/acceptance/integration-20261008/sources/file-ledger.json`。以下不是仅看文件存在，而是整个来源文件集逐字节命中历史冻结记录：

| 本轮来源  | 对应旧主题                       | manifest 文件数 | 命中旧台账 | 源码/测试路径数与旧裁决                                                       |
| --------- | -------------------------------- | --------------: | ---------: | ----------------------------------------------------------------------------- |
| source-04 | 7ba6 设计原型                    |             228 |        228 | 79; superseded=25, covered_exact=29, covered_adaptation=13, retire=12         |
| source-07 | 9630 旧sbx壳                     |             321 |        321 | 109; covered_exact=43, superseded=23, covered_adaptation=28, retire=15        |
| source-11 | eb15 空间升级                    |             544 |        544 | 159; covered_exact=114, covered_adaptation=3, covered_redesign=39, retire=3   |
| source-15 | Documents/task-5 统一观察        |             373 |        373 | 160; covered_exact=57, covered_adaptation=46, adapt=23, migrate=22, retire=12 |
| source-19 | lab-unified-observation-delivery |             378 |        378 | 165; covered_exact=57, adapt=26, covered_adaptation=43, migrate=27, retire=12 |

历史台账中的 adapt/migrate 只是当时计划，不能单独证明今日实现。当前补充核对的实际替代路径：

- 旧 Renderer-owned demo/工作台业务状态由 Main `workbench/application.ts`、`workspace.ts` 投影和 `workspace/{Session,Sidebar,Panes,Terminal}.tsx` 替代；旧 `state/terminal.ts`、`workbench/TerminalPanel.tsx` 不恢复。
- 旧 `ObservationRouter` 写死 taskflow-demo/workspace 和环境资源表；现 `environment-resources.ts` 使用完整 resource instance 身份、lease/retired、AbortSignal；Main application 负责会话/run scope和预算。protocol/observation.ts 实际新增 requestId/sessionId/runId/instanceGeneration、cancelled/budget_exceeded 及字节预算。重新引入旧 router 会绕开新边界。
- 旧 `ObservationPanel` / `observation-hints` 全局 UI 改为 `workspace/Observation.tsx`，由 `Session.tsx` 挂载；Main 的 onFileHint 检查工作空间、实例及watchGeneration/sequence，维护workspace.fileHints；现UI按resource读取并展示失效提示。旧 hardcoded files:local 与全局store不恢复。
- delivery 的 frame/AX/DOM补充在 current `preview/observation.ts`、frame/navigation相关测试；终端OSC与输出序列在 observation-terminal、terminal-output、shell integration脚本；bounded watch/root replacement 在local-file-watch；观察证据/预算/取消在application与environment-resources。已具体检查这些实现，未发现需恢复旧入口的独立新增功能。
- root AGENTS/CLAUDE/架构旧“本树没有源码/无pnpm入口”在后续改为明确当前运行时；本轮主树Harness兼容改动是更新增量。旧规则不能覆盖当前事实。
- 旧 source04/07/11全部文档/历史文件也命中旧台账；原始source-diffs与sha保存在仓库历史来源目录。设计PNG和旧premium-audit已明确作为视觉参考/淘汰，不将旧audit当当前验收。

## minimal-app-loop（source20）

已逐路径核对未提交产品/标准模板内容与0503e33对象。模板所有26文件均与0503e33、5c4edb7、ea3bad9对应blob完全相同（本轮主树控制面后续模板更新可另存增量），managed-app协议相同。其余已改源码中preview/controller、public-protocol及test、host-migration、migration-followup、renderer workspace/Browser/Sidebar、workspace protocol在0503e33完全相同。

13个不等于0503e33的源码/测试具体diff表明0503e33是后续集成：ChatService新增具名runtime配置和appGet；application新增service权威恢复而非盲设stopped；host支持packaged模板；ports增加appGet；service入口绑定RuntimeConfig/SbxConnection/template依赖；AppService复用runtimeTarget并清理原persistent端口request；live/e2e增加packaged环境、恢复、keeper核验端口；managed-app tests增加恢复负例；CSS统一field样式。source20没有发现独立有效缺失，不恢复旧版本。

其提交5c95c07的VS001核心 `desktop/main/vertical-slice.ts`、service vertical-slice/adapter、guest-helper、guest-workspace test均与当前ea3bad9对应文件相同；sbx.ts仅后续显式运行配置/runtimeTarget新增。原始adapter evidence在0503e33采取公开摘要与私有原始证据边界，不能盲目恢复删除的全量真实运行档案。

## submission 与 diagnostics

606556c四个submission文件经过后续具体改写：README和两份源稿从10-07公开快照/未实现描述变为10-08本地整合事实；export_pdf从生成固定GitHub快照链接改为真实本地链接并标注本地文件，稿件日期与历史证据日期分开。旧版本无需额外整合。稿件内容若落后当前功能，应本轮另行同步，不回滚旧稿。

5217571/fb71ab7两独有提交新增三个文件：signing-diagnostics.yml、signing-diagnostics.mjs、signing-diagnostics.test.mjs。功能是导入临时keychain后查询公开身份/证书有效期/离线信任，输出脱敏结构，always cleanup；不公证、不发布。workflow仅push旧专用分支触发，整入新PR/main没有可用入口。脚本无新增产品行为，且依赖敏感CI导入流程，不为本轮产品整合增设自动动作。裁决：保留该独立分支和来源理由，三文件不纳入最终功能。未运行该workflow，未读取证书、密钥或密码。

## 验证方式与限制

使用 git for-each-ref/log/rev-list/merge-base/cherry/show/ls-tree/cat-file、本轮manifest SHA256与历史file-ledger精确匹配、具体diff/相关实现审阅。没有fetch/commit/push、没有运行产品/模型/沙箱；远端最新状态由根线程独立ls-remote/PR调查负责。本报告说明源内容去向；候选最终diff与测试仍由主线程审查，source01最终文件已再次静态复核，详情见[独立复核](independent-review.md)。

## 全覆盖去向表

source10是本轮新建候选而非原来源，故24个原工作树编号为00–24排除10。

| 来源      | 原工作树                                                                    | HEAD      | 去向                                                                                           |
| --------- | --------------------------------------------------------------------------- | --------- | ---------------------------------------------------------------------------------------------- |
| source-00 | `/Users/huaodong/workspace/web-studio-lab`                                  | `ea3bad9` | 适配：主树未提交App控制面为本轮主要增量；保留所有源码/历史来源。                               |
| source-01 | `/private/tmp/web-studio-lab-space-app-model`                               | `cf62dc7` | 已整合：空间App模型15源码路径及对应文档纳入；schema4保全catalog，双来源schema3迁移已修复复核。 |
| source-02 | `/Users/huaodong/.codex/worktrees/1799/web-studio-lab`                      | `2466936` | 已包含：干净PR1合并点2466936。                                                                 |
| source-03 | `/Users/huaodong/.codex/worktrees/4820/web-studio-lab`                      | `2466936` | 已包含：干净PR1合并点2466936。                                                                 |
| source-04 | `/Users/huaodong/.codex/worktrees/7ba6/web-studio-lab`                      | `643c1e2` | 后续替代/仅历史：228/228哈希命中旧ledger。                                                     |
| source-05 | `/Users/huaodong/.codex/worktrees/89a8/web-studio-lab`                      | `536f0a1` | 已包含：干净初始main祖先536f0a1。                                                              |
| source-06 | `/Users/huaodong/.codex/worktrees/95ba/web-studio-lab`                      | `0318a62` | 后续替代：architecture checkpoint规范已整合，旧无源码宣称更新。                                |
| source-07 | `/Users/huaodong/.codex/worktrees/9630/web-studio-lab`                      | `536f0a1` | 后续替代/仅历史：321/321哈希命中旧ledger。                                                     |
| source-08 | `/Users/huaodong/.codex/worktrees/b8ac/web-studio-lab`                      | `2466936` | 已包含：干净PR1合并点2466936。                                                                 |
| source-09 | `/Users/huaodong/.codex/worktrees/bf64/web-studio-lab`                      | `b1e4f43` | 已包含HEAD；排除唯一dirty premium-audit.json（旧审计，仅历史，不是当前验收）。                 |
| source-11 | `/Users/huaodong/.codex/worktrees/eb15/web-studio-lab`                      | `2466936` | 后续替代/仅历史：544/544哈希命中旧ledger。                                                     |
| source-12 | `/Users/huaodong/.codex/worktrees/f0c5/web-studio-lab`                      | `c0edaf6` | 后续替代：c0edaf6旧比赛计划/README已有后续版本。                                               |
| source-13 | `/Users/huaodong/.codex/worktrees/fcd0/web-studio-lab`                      | `2466936` | 已包含：干净PR1合并点2466936。                                                                 |
| source-14 | `/Users/huaodong/.codex/worktrees/fd9f/web-studio-lab`                      | `536f0a1` | 已包含：干净初始main祖先536f0a1。                                                              |
| source-15 | `/Users/huaodong/Documents/Codex/2026-10-07/task-5/web-studio-lab`          | `4ab5581` | 后续替代：373/373哈希命中旧ledger；当前Main scope/lease观察实现已适配。                        |
| source-16 | `/Users/huaodong/workspace/_worktrees/integrated-app-installer-20261009`    | `5c4edb7` | 已包含HEAD；仅历史/排除公开：336个未提交原始acceptance文件，见下文。                           |
| source-17 | `/Users/huaodong/workspace/_worktrees/lab-integration-20261007`             | `4ab5581` | 后续替代：干净4ab checkpoint，后续Main observation/space整合实现。                             |
| source-18 | `/Users/huaodong/workspace/_worktrees/lab-pr1-review-fixes-20261007`        | `729bf58` | 已包含：干净PR1测试修复729bf58。                                                               |
| source-19 | `/Users/huaodong/workspace/_worktrees/lab-unified-observation-20261007`     | `4ab5581` | 后续替代：378/378哈希命中旧ledger，delivery独立观察修复经当前接口适配。                        |
| source-20 | `/Users/huaodong/workspace/_worktrees/minimal-app-loop-20261009`            | `5c95c07` | 已包含/后续替代：源码与模板已由0503增强纳入；107个原始acceptance文件只保留本地。               |
| source-21 | `/Users/huaodong/workspace/_worktrees/release-smoke-fix-20261009`           | `cf62dc7` | 已包含：cf62dc7及所有release修复均为ea3祖先。                                                  |
| source-22 | `/Users/huaodong/workspace/_worktrees/signing-diagnostics-20261009`         | `fb71ab7` | 排除本PR：独立签名诊断2提交保留原分支。                                                        |
| source-23 | `/Users/huaodong/workspace/_worktrees/web-studio-public-resources-20261006` | `8a7f9d9` | 后续替代：干净guestbrowser checkpoint，当前原生浏览器/sbx资源实现。                            |
| source-24 | `/Users/huaodong/workspace/web-studio-lab/.local/competition-installer`     | `d792ee5` | 已包含：competition-installer由PR5进入origin/main。                                            |

16本地分支覆盖：

| 分支组                                                                                    | 去向                                                                        |
| ----------------------------------------------------------------------------------------- | --------------------------------------------------------------------------- |
| `app-control-plane / c1-development-20261010`                                             | ea3bad9候选主线；source00增量适配                                           |
| `checkpoint-architecture-20261007`                                                        | 后续规范替代；source06                                                      |
| `checkpoint-guestbrowser-20261007`                                                        | 后续产品替代；source23                                                      |
| `competition-installer`                                                                   | 已包含于origin/main；source24                                               |
| `integrate-lab-checkpoints-20261007 / unified-observation / unified-observation-delivery` | 提交checkpoint后续替代；source17干净、source15/19未提交内容已逐字节历史对照 |
| `integrated-app-installer-20261009`                                                       | 已包含HEAD；source16原始acceptance保留本地                                  |
| `minimal-app-loop-20261009`                                                               | 0503后续集成替代；source20                                                  |
| `release-smoke-fix-20261009 / space-app-model`                                            | cf62dc7已包含；source01独立App增量适配、source21干净                        |
| `signing-diagnostics-20261009`                                                            | 独立诊断原分支保留，本PR排除；source22                                      |
| `space-remake-integration-20261008`                                                       | 已包含；source09旧premium audit排除                                         |
| `docs/dev-conventions`                                                                    | 后续规范替代，source04相关历史留存                                          |
| `main`                                                                                    | 旧536f0a1祖先；最终PR base为远端f77ff96                                     |

### source16 与 source20 原始验收文件

source16未提交acceptance共336文件：integrated-app-installer-20261009 123、minimal-app-loop-20261009 107、vs001-adapter-20261009 106。source20的107文件均属于minimal-app-loop-20261009。已使用git对象核对：这些路径在0503e33和ea3bad9均不存在，不宜笼统说“0503删除全部336文件”（其中大量原本就是未跟踪文件）。正确结论是0503公开提交主动选择公开派生摘要和hash索引，原始记录保留本地，没有纳入该公开提交。

实际依据：0503的commit body明确“Keep private runtime evidence and unsigned package artifacts local”；其新建 `integrated-app-installer-public-20261009/README.md` 首段明确原始日志/profile/截图/运行目录/导出/安装包含个人绝对路径与运行现场，不随提交上传。对应evidence-index包含17项原始关键记录SHA256，availability均标为 retained locally；不是336文件都已有公开逐文件索引。故本轮保留冻结tar/manifest和原树；不将336+107原始材料全量恢复到可推送PR，也不以公开摘要替代本轮新验收。

## 补充：origin/main..ea3bad9 未由本轮coder覆盖的静态审查

截至本次审查未确认新的可复现阻断。范围与实际核对：

- 资源目录：resource-catalog.ts 的命令revision/idempotency、owner、活动依赖、revision digest/source identity；resource-catalog-repository.ts 的legacy collection版本/身份迁移和load digest；repository.ts 的runtime binding与reference ownership、保存备份/原子rename；application.ts catalogContext、capture前后instance/generation/page核对、materialize、disconnect/delete持久任务绑定与事务回滚。
- 引用权限：protocol ResourceBundle完整JSON大小/16项/身份schema；Main个人引用要求library、空间引用来自已连接且选定版本；service CodexChat.send对注册会话/workspace及正文hash复核；resource_mcp.py只读sealed每轮bundle，不能从工具参数读取文件系统/任意资源。
- 退出：Main ExitCoordinator超时不取消原cleanup，retry加入原attempt；shutdownOwners尝试独立owner；service shutdownServiceOwners实际先等App清理再关闭共享chat连接与环境，排除并行抢先关闭connection的怀疑；service shutdown先停止模型新send admission。
- installer/packaging：0503后续显式SbxConnection配置和runtimeTarget、packaged模板源码/独立lock/archive hash核验、electron-builder模板filter、release validate-only分支与正式签名/公证/资产校验边界。没有触发发布、读取凭据或执行真实安装。

这是静态审查结果，不等于全仓正确性或产品验收。未运行新测试；本轮source01适配和主树控制面执行链由主线程/coder另行验证。

## source01最终状态复核

上述15条源码/测试路径的业务增量已进入候选，表中“移植/适配”描述的是最终采用的映射，不再是待办。已核对SpaceApp metadata、updateApp与失败回滚、Task appTarget/guestCwd冻结和组合prompt预算、AppEditor表单接线；资源目录保持当前主线实现。双来源schema3修复保留来源01显式workspace.app与publicResources，并保留带catalog主线v3的完整校验，统一备份后写schema4。新增来源01实际无catalog输入的App=null/非空两例，原始红日志2失败4通过，绿日志3文件20通过；这里只复核源码与coder日志，未执行新测试。当前未发现来源01仍遗漏或本审查范围剩余的具体阻断；最终全检查及Electron验收由根线程负责。
