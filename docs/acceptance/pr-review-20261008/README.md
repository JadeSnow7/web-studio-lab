# 整合分支 PR 审查

本轮确认并修复四项产品缺陷和一项测试清理缺陷。提交采用 Draft：当前证据不支持完整产品验收通过。本记录是新的审查，不替换封存的整合验收记录。

## 基线与范围

目标始终为 `bf64/web-studio-lab`，分支 `codex/space-remake-integration-20261008`；开始 HEAD 为 `4fc5054741b0c2bf21bbe10455d0a8e0ce649161`，远端 main 为 `2466936454658153e47a430ce1da853826f69f69`。已实际验证目标写权限，没有复制到旧 4820 树。初始唯一未跟踪文件 `premium-audit.json` 保留且不提交。

相对 main 的历史整合差异为 2820 个文件，其中 apps/packages/e2e/scripts/tests 共 212 个文件。审查以全量差异清单划定范围，按风险追踪实际源码、调用链和测试断言：Main 命令队列和唯一状态权威、快照迁移/恢复、空间/资源/会话/运行实例身份、取消和迟到结果、观察及 MCP 帧/并发/轮次预算、文件根撤销和 watch、PTY/SSH 启动与清理确认、六页路由、遮挡和原生 Browser 生命周期。重点复核 `9e1df45` 之后的接线。主线程完成上述风险路径审查与修复 diff 复审；这不是每行代码无缺陷的证明。

历史交付 manifest 的 232 项 SHA-256 在本轮修改前全部与磁盘一致。指纹只证明来源匹配，不把旧审查记录当成本轮通过。Main/UI 的本轮变化已重新测试；历史 live 和打包结果仅说明当时条件，本轮未重跑真实模型、既有 sandbox 或打包。

## 确定性发现

行号对应修复后的源码，用于定位原缺陷所在分支。

| 编号   | 级别与位置                                                     | 触发及用户影响                                                                                                                  | 最小修复与验证                                                                                                                                            |
| ------ | -------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------- |
| PRR-01 | P1，`apps/desktop/src/main/workbench/application.ts:525`       | 无原生实例的网页首先被观察；环境预检取消/不可用或原生构造抛错后，提前发布的实例 ID 残留。后续浏览器操作不再重建，资源无法恢复。 | 使用未发布候选身份；在序列化区重新确认资源未换代、预检成功且未取消，构造后才发布。保留真实错误原因。构造失败后重试、取消、环境拒绝和并发创建均有断言。    |
| PRR-02 | P1，`apps/desktop/src/main/workbench/application.ts:1194`      | 终端启动前保存失败，尚未调用 runtime 却留下 starting/cleanupPending；再次打开被当成忙碌，停止也没有真实会话可清理。             | 只回滚启动前保留的实例/代次/终端状态，保存成功后才请求 runtime。失败复现确认 runtime 未启动，随后可重试。                                                 |
| PRR-03 | P2，`apps/desktop/src/renderer/src/pages/ResourcesPage.tsx:64` | 初次公共资源列表查询暂时失败后，刷新按钮只读取当前快照，不发起 Main 的显式重试；错误与旧版本一直保留。                          | 按钮调用已有 `initializeWorkspace(true)`。Main 单测验证失败列表重新加载到 revision 7；Electron fixture 验证初始错误/版本 0、按钮重试、版本 7 与错误消失。 |
| PRR-04 | P2，`apps/desktop/src/renderer/src/workspace/Terminal.tsx:113` | 连接请求进入 starting 后打开并关闭空间切换器；迟到 running 状态再次聚焦终端，抢走已恢复到切换器触发器的焦点。                   | 聚焦由显式连接点击或窗格激活驱动，移除运行状态触发。受控延迟真实 fixture PTY 请求稳定复现，保留 starting/关闭弹层/running 焦点时间线。                    |
| PRR-05 | P2，测试设施 `e2e/helpers.ts:140`                              | SSH 断线清理未知场景按既有规则强制结束测试进程后，Playwright 对象先销毁；close 再调用 app.process 抛 TypeError，污染整轮结果。  | launch 成功时保存自有 ChildProcess 引用，收尾读取该引用。保留产品错误、renderer 异常和清理断言，未把强退解释为正常产品关闭。                              |

修复前证据：[Main 两项失败](regression-before-fixes.json)、[延迟 PTY 焦点失败](a12-controlled-before-fix.json)、[刷新入口失败](resources-refresh-before-fix.json)。资源入口首次失败测试只确认未调用重试；最终测试额外补齐错误可见的前置断言。SSH 测试清理失败原文保留在 [Electron 整轮](electron-after-fixes.json)。

## 本轮验证

命令独立运行，失败不短路后续检查。固定 pnpm 为 10.34.6，实际 Node 为 26.5.0；没有更新依赖。完整命令、起止时间、退出码、stdout/stderr 和前后源码指纹均在对应 JSON。

| 检查                      | 结果                           | 证据与边界                                                                                                                                    |
| ------------------------- | ------------------------------ | --------------------------------------------------------------------------------------------------------------------------------------------- |
| 文档                      | 通过                           | [docs-final](docs-final.json)，18 个规范入口的本地链接目标和尾随空白，不检查外链或锚点                                                        |
| 类型                      | 通过                           | [typecheck-final-v3](typecheck-final-v3.json)，含产品、E2E 与固定 baseline                                                                    |
| 当前产品/测试 lint 和格式 | 通过                           | [lint](lint-active-final-v2.json)、[format](format-active-final-v2.json)，apps/packages/e2e/scripts；新增测试的中间 lint 失败已修正并保留原文 |
| 全树 lint                 | failed，217 errors             | [原文](lint-full-final-v2.json)，与初始旧诊断一致；未加 ignore 或修改归档                                                                     |
| 全树格式                  | failed，716 files              | [原文](format-full-final-v2.json)，计数对应执行时点，其中 41 项为本轮原始回执/失败产物，675 为其他现存文件；后续追加证据不回写此计数          |
| 全量单元                  | 432 pass / 8 live skip         | [unit-final](unit-final.json)，含新增六项 Main 回归                                                                                           |
| 构建                      | 通过                           | [build-final](build-final.json)；没有打包路径改动，未重跑 package，旧包不代表最终字节验证                                                     |
| VS001 自检                | 12 pass                        | [vs001-final](vs001-final.json)；B01–B05 产品 adapter 缺失是既定未实现能力，未补做 adapter/独立检查器，自检不等于业务验收                     |
| UI 静态审计               | 0 findings                     | [premium-final](premium-final.json)，只证明静态规则，不证明实际交互                                                                           |
| Electron 修复前整轮       | 54 pass / 1 fail / 5 live skip | [before](electron-before-fixes.json)，失败为 A12 焦点竞态                                                                                     |
| Electron 产品修复后整轮   | 56 pass / 1 fail / 5 live skip | [after](electron-after-fixes.json)，唯一失败为 PRR-05 测试收尾；不能改写为整轮通过                                                            |

[定向 Electron](electron-final-focused.json)为 9 pass / 1 fail：SSH 收尾、A12 及既有资源场景通过，新资源前置 fixture 漏传真实 IPC guard 必需的 senderFrame 而失败；补齐后[该单例](resource-event-fixture-final.json)为 1 pass。不是整轮全套通过。[最后观察断言](observation-message-final-v3.json)24 pass；前一轮新增预期遗漏既有 unavailable 前缀的失败保留，没有改动产品消息或减少断言。

[源码对应关系](source-affinity.json)确认最终构建与全量/定向 Electron 执行期间生产字节稳定，之后仅测试和辅助器变更；最终测试字节由类型、定向测试和[本轮 lint](fixes-lint-final.json)/[格式](fixes-format-final.json)覆盖。初始 Electron 运行时只新增了两个单元测试文件，生产字节未变化。

[本轮原生复核](native-root-review.json)通过独立 fixture 窗口检查连接终端、弹层搜索焦点、Escape 后触发器焦点、资源页刷新和终端关闭确认。[隔离窗口](native-window.json)与[清理回执](native-cleanup.json)记录进程归属和退出。原生拖拽、IME、点击穿透未做，仍为 undetermined。

## 视觉与历史边界

主线程查看本轮暖色三窗格、空间切换器和窄窗截图。切换器遮挡提示、搜索框焦点、终端与会话布局可见。名为 resources-fixture-narrow 的截图实际是测试末尾首页，不能用文件名推断资源页视觉通过；Browser 原生内容在 window 截图中未显示，不能作为系统合成层或点击穿透通过证据。

历史 [最终整合验收](../integration-20261008/evidence/final/README.md) 的 live 12 pass / 1 fail（guest 网页网络失败）、build Electron 55 pass / 5 skip、packaged 53 pass / 7 skip 不计入本轮。Main 与 Terminal 改动后的端到端 live 适用性未重新建立。本轮原生窗口未被锁屏阻塞，但真实拖拽、中文 IME 候选窗及原生合成层未执行，仍为 undetermined；有限原生检查和自动化 focus 断言不代替这些项目。SSH 回环验证不代表外部主机。

## 提交边界

只追加本轮明确修复、回归与本目录新证据，不重写旧提交/旧证据。远端 main 提交前重新核对。PR #2 的参赛正文和证据索引与整合分支重叠；新 PR 明确说明此重叠，PR #2 保持原状。保留 Draft，禁止把已知失败、未实现 adapter 或 live/native 缺口表述为全部通过。不合并、不部署、不发布。

[提交前核对](publication-preflight.json)保存基线、最终源码指纹、旧证据未改及有限凭据模式检查；模式未命中不等于完整安全审计。

提交前的暂存区检查另见 [staged-check](staged-check.json)：产品代码与审查正文无空白错误；四个原始 Playwright 失败上下文含 19 处尾随空白，原文保留，整体 staged diff check 仍为 failed。
