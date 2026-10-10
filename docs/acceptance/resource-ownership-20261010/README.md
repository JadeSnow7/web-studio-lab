# 账户资源归属改造：实现与验证

资源已改为本地账户拥有；个人收藏、空间连接、正文版本、运行实例和标签分别记录。源码由同一 coder 分 F1–F3 实现，主线程冻结合同、审查并独立验证。2026-10-11 完成源码阶段及解锁补验；同一源码下 82 个已启用离线 Electron 用例均有通过证据（全量运行 81 项，加原生焦点单项补验），另 7 项保持跳过。用户接受、真实模型和 sandbox live 不在通过结论内。

## 冻结与交付范围

- 合同：[RESOURCE-OWNERSHIP-1](SPEC.md)，R01–R14 在实现前冻结。SPEC SHA-256：`a440ba370ffb4637c6090e705a441acd2a68138b766bbaedeb35ea5987d3dbb7`，实施期间未改写。
- 基线：`cf62dc74f49e7f9e81598be7b9e5109cf5946e9c` 加既有未提交内容。`/private/tmp/wsl-resource-ownership-baseline/` 保存 3539 个 tracked / 非忽略 untracked 文件副本、SHA-256、Git 状态和原 diff；不含依赖与用户运行数据。
- 保留既有安装、退出清理、标题栏、品牌和 Workshop 操作改动。[保全核对](evidence/preservation.json)记录 3465 个基线文件字节不变，任务外没有源码修改或文件丢失；并行产生的 Workshop 验证文档归原任务，本报告不据此扩大验收。未提交、推送、签名、发布或部署。
- 本轮源码差异以 [文件指纹](evidence/final-source-sha256.json) 和 [相对冻结基线的补丁](evidence/resource-ownership.patch) 为准；不是相对 HEAD 的整个 dirty diff。

## 已实现的行为

Main 的账户目录是唯一业务写入者；schema 3 原子保存目录及工作台，提交前验证完整格式、来源、摘要和关系。旧 workbench schema 1/2 与旧 service 资源集合仅用于迁移，旧 ID、正文版本、摘要、运行绑定与历史证据保留，默认不自动收藏。旧 workbench 原始字节另存不可覆盖的只读备份，旧资源集合文件不再写入；正常 schema 3 读取不触发多余保存。

全局“我的资源”只列主动收藏，支持网页、文档入口、开发入口分类，搜索、分页、改名、详情、连接空间、取消收藏和删除。空间页独立折叠区显示本空间连接与参考版本；活跃标签和后台实例分别呈现。收藏地址不访问网络；连接不打开；捕获正文不自动收藏或交给 Agent。关闭标签、停止实例、解除连接与删除有各自依赖校验。

空间会话只使用已连接且明确选中的正文版本；个人会话只使用明确选择的收藏版本。Main 在发送前冻结包，service 核对会话归属，只读 MCP 按本轮身份读取。新正文版本不替换历史或在途 v1。每轮 16 个参考、单正文 64 KiB、完整 JSON 512 KiB 的限制保留，收藏数量不受 16 条限制。

文档功能限于已有授权环境的文件入口收藏与重开，包含旧具体路径迁移；不新增文件导入、任意当前文件另存或正文归档。开发入口保留项目及原授权环境约束，不把 App 临时预览 URL 当成可独立启动的项目。网页实例关闭释放对应原生浏览器；文件观察关闭仅释放对应租约，不停止其他空间共享的环境。

实现中补充目录摘要 `versions: number[]`，只列实际存在的版本号；旧数据可能仅保留 v4，不能推断 v1–v3。它不包含正文，也不改变冻结合同。旧空间集合写命令、service ResourceStore 与 renderer publicResources 状态已退役，仅迁移读取保留旧 schema。

## 实际验证

使用 Node 26.5.0、固定 pnpm 10.34.6。下文 `pnpm` 均指 `node /Users/huaodong/.npm/_npx/168ca33e231eaaf0/node_modules/pnpm/bin/pnpm.cjs`，未安装或更新依赖。受限环境的 watcher/socket 检查曾因 EMFILE/EPERM 失败；相关离线验证在宿主权限下复跑，不把权限错误算作产品通过。

| 命令/检查                                                                                                | 结果         | 证据与边界                                                                                                                                                                                                               |
| -------------------------------------------------------------------------------------------------------- | ------------ | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `pnpm typecheck`                                                                                         | passed       | [输出](evidence/final-typecheck.log.txt)，产品、E2E、VS001 类型检查                                                                                                                                                      |
| `pnpm test`，主线程最终复跑                                                                              | passed       | [输出](evidence/final-test.log.txt)：589 passed / 15 skipped，另 packaging 27 passed                                                                                                                                     |
| `pnpm build`，coder 修复空地址后重建                                                                     | passed       | [输出](evidence/final-build.log.txt)，随后主线程用该构建运行 Electron；不是签名包                                                                                                                                        |
| 全量 Electron，锁屏时的主线程复跑                                                                        | 历史失败保留 | [输出](evidence/final-electron.log.txt)：81 passed / 1 failed / 7 skipped；当时唯一失败为 R3 原生系统焦点，已由下项在同一源码补验通过                                                                                    |
| 解锁后重新构建及原 R3 补验                                                                               | passed       | [构建](evidence/unlocked-build.log.txt)、[R3 输出](evidence/unlocked-r3.log.txt)：1 passed / 2.5s；[核对记录](evidence/unlocked-verification.json)确认 80 个源码指纹不变、无其他源码变化、原测试和焦点逻辑未改           |
| 配置的 accessibility：`pnpm exec playwright test e2e/sbx.spec.ts e2e/chat.spec.ts e2e/resources.spec.ts` | passed       | [输出](evidence/final-accessibility.log.txt)：14 passed / 2 skipped；是项目既定子集，不是 WCAG 审计                                                                                                                      |
| `pnpm baseline:selftest`                                                                                 | passed       | [输出](evidence/final-vs001.log.txt)：12 passed，仅离线合成基线                                                                                                                                                          |
| 对改动文件执行 `eslint <76个TS/TSX>`、`prettier --check <77个TS/TSX/CSS>`                                | passed       | 主线程独立检查全部现存变更源文件，含 live 文件静态检查；[lint](evidence/final-source-lint.log.txt)、[format](evidence/final-source-format.log.txt)，不运行 live                                                          |
| `pnpm check` / `pnpm lint`                                                                               | **failed**   | [check 原记录](evidence/final-check-failed.log.txt)、[最终全仓 lint](evidence/final-lint-all-failed.log.txt)：3781 条来自历史证据/归档副本、打包和 Vite 产物以及未改基线脚本；本轮未使用变量已修复，不扩大修改到这些文件 |
| `pnpm format:check`                                                                                      | **failed**   | [输出](evidence/final-format-all-failed.log.txt)：当次 796 个文件有格式差异，包括历史副本与文档；不整体重排历史或改写冻结 SPEC。变更源码格式另验通过                                                                     |
| premium strict 静态审计                                                                                  | passed       | [JSON](evidence/final-ui-audit.json)：0 findings；不替代实际窗口检查                                                                                                                                                     |
| `node scripts/check-docs.mjs` / `git diff --check`                                                       | passed       | [输出](evidence/final-docs-diff.log.txt)，18 个规范文件的入口/本地链接/空白；不代表产品验收                                                                                                                              |

最终 Electron 实际命令为 `pnpm exec playwright test --grep-invert '^R3 双网页原生focus'`：原意单列锁屏项，但锚定表达式没有匹配 Playwright 带文件名前缀的标题，所以实际仍执行全部 89 项，R3 仍失败。报告依据实际结果，不把该次命令当作已排除 R3 或单次全量通过。用户随后确认解锁，主线程重新构建并执行 `pnpm exec playwright test e2e/workspace-migration.spec.ts --grep 'R3 双网页原生focus'`，1 项通过。累计 82 项的证据来自同一源码的全量运行与单项补验，不声称重新执行了一次全绿全量套件。原 `pnpm test:e2e` 首轮也完整保留。

## 冻结验收对照

| 基准    | 已验证的行为与主要证据                                                                                                                                                      |
| ------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| R01–R02 | 目录模型与真实 Main Electron 验证收藏无网络请求、连接不启动、跨空间独立运行绑定和实例；重复命令幂等。                                                                       |
| R03–R04 | 取消收藏保留 A/B；真实 UI 关闭标签→关闭网页实例→仅移除 B；活动依赖拒绝解除/删除并在对话框显示具体原因；文件租约隔离测试。                                                   |
| R05–R06 | Main/service 实际传送选择的 v1，追加 v2 后在途/历史仍为 v1；个人 UI 点击发送捕获实际 chat:send v1；未选择/跨空间资料不进入包。                                              |
| R07–R08 | 17 个收藏允许；17 个参考及完整 JSON 超预算拒绝且不启动；伪造所有者、会话、空间、资源、来源、摘要及未知字段拒绝。                                                            |
| R09     | 旧双文件、只读备份、重复启动、保存失败、未来格式、损坏摘要测试；Electron 验证稀疏旧 v4 只有 v4 可选。                                                                       |
| R10     | 目录冲突、迟到捕获、A→B 导航归属、布局版本独立；UI 两段异步打开/切空间均不得覆盖后续路由。                                                                                  |
| R11     | Electron 实际收藏、分类并跨空间重开文件/开发入口；Main 验证旧具体文件路径保留；权限不随连接扩张。                                                                           |
| R12     | Electron 独立临时 profile 重启后收藏、连接和参考恢复，旧运行句柄不持久化，不自动运行终端或任务；退出前关闭外部网页，重启装好网络 fixture 后再由 UI 打开，避免意外公网请求。 |
| R13     | 空态、无结果、搜索清除、失败保留、忙态、IME、确认取消焦点/Escape/恢复、窄窗长标题与深色截图；主线程检查实际窗口图像。                                                       |
| R14     | 最终类型、定向 lint/格式、全量单测、构建、Electron、VS001 和文档检查见上表；全仓 check/format 失败单列；R3 锁屏限制已通过解锁后的原样单项补验解除。                         |

核心自动化位置：`apps/desktop/src/main/workbench/resource-catalog*.test.ts`、`public-resources-migration.test.ts`、service 参考与环境资源测试、`e2e/resources.spec.ts`、`e2e/public-document.spec.ts`。R3 原生焦点用例保留原断言，解锁后原样通过，不以排除后的其余通过代替。测试未删除冻结断言来制造通过；旧空间集合接口的用例改为账户目录语义，并保留替代覆盖。

## 阶段及失败证据

F0 旧基线：类型与构建通过；[单测](evidence/baseline-unit.log.txt) 571 passed / 15 skipped，另 packaging 27；[全量 Electron](evidence/baseline-electron-all.log.txt) 79 passed / 7 skipped。原 resources-fixture-narrow 实际已导航到首页，主线程核对后以[首页图](evidence/baseline-home-after-resources-narrow.png)保存，不将其作为改造前资源页证据。

F1：[模型 red](evidence/f1-model-red.log.txt)、[迁移 red](evidence/f1-migration-red.log.txt) 因实现模块缺失失败；[green](evidence/f1-green.log.txt) 11 项通过，主线程独立复跑同基准。审查补齐来源/摘要关系、项目入口迁移及单一可写权威。

F2：主线程[最终定向复跑](evidence/f2-primary-final.log.txt) 7 文件 62 项通过；coder [全量通过](evidence/f2-full-green.log.txt) 584 passed / 15 skipped、packaging 27。审查修复正常重启无条件保存、A→B 页面身份、完整 JSON 预算、持久历史证据等问题。[失败输出](evidence/f2-full-failed.log.txt)保留，包含测试 fixture 缺少标签及回执白名单扩张，修复后回到原断言。

F3：保留[早期失败](evidence/f3-ui-failed-before-review.log.txt)及[新增路径用例失败](evidence/wsl-f3-e2e-failed-sparse-placeholder.log.txt)。另保留 [fixture 早期记录](evidence/wsl-f3-e2e-failed-file-empty-and-sparse-auth.log.txt)和[观察结果名称记录](evidence/wsl-f3-e2e-failed-result-label.log.txt)。稀疏版本个人会话使用已配置的离线 Codex fixture；观察断言使用实际可见名称。末次两项失败为空目录无法成为可见列表、版本下拉框应包含显式选择占位项的 fixture/断言问题；分别补入真实文件和保留占位项，同时继续断言只有 v4 内容版本。早期“重启所有实例必须为空”改为核对持久文件无运行句柄、终端/任务不重放以及用户明确打开产生新网页实例，符合冻结生命周期。未把改断言后的通过扩大为真实网络或模型通过。

主线程全量 Electron 首轮 81 passed / 1 failed / 7 skipped，发现留空网页地址被目录校验拒绝，见[原失败](evidence/final-electron-failed.log.txt)及[错误现场](evidence/final-electron-failed-context.md)。coder 仅在 createTab 边界将省略/空字符串明确转为原演示页，再走原 URL 校验；新增正例并保留空白、非法文本等负例。原 R3 测试未改。修复后两次原样复跑均越过创建/导航，停在原生 isFocused 断言；[系统状态](evidence/native-focus-environment.json)确认锁屏，[精简诊断](evidence/native-focus-diagnostic-summary.json)显示主窗口和所有内容均未聚焦、activePane 和 bounds 正常。当时未修改产品焦点逻辑，原生焦点验收记为 undetermined。用户确认解锁后，主线程核对全部 80 个源码指纹及其余源码均无变化，重新构建；原 R3 完整通过，包含原生焦点、布局变化、地址/刷新目标与 DevTools 所有权断言。该环境阻塞现已解除，失败记录仍保留。

## 窗口检查与边界

主线程读取并目视检查[个人资源页](evidence/my-resources.png)、[空间连接](evidence/space-connections.png)、[个人参考](evidence/personal-reference.png)、[深色窄窗顶部](evidence/narrow-dark-top.png)与[详情](evidence/narrow-dark-detail.png)。复查修正了空间资源挤掉活跃标签、选中收藏无视觉状态、删除触发器卸载后焦点丢失以及共享对话框错误不具体的问题。图片来自本轮 Electron fixture；截图中的网页层不作为外部网站内容真实性证明。

未运行真实模型、sandbox live、外部 SSH、新安装包/签名或发布验证。Python MCP 离线 harness 在 macOS 跳过 Linux sealed-memfd 分支，不能声称本轮验证了该 Linux 分支。配置中的 accessibility 命令是项目既定 Electron 子集，不等于 WCAG 全面审计。离线测试与窗口检查支持已验证的本轮实现范围；原 R3 已解锁补验通过，仍不替代用户接受或整个比赛闭环验收。
