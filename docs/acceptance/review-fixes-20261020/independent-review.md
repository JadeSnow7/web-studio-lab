# 独立审阅的脱敏摘录

原 R6 最终证据复核结论为 **ACCEPT DEFAULT AUTHORIZED SCOPE**，无 actionable finding；它接受的是当时固定 R6 候选的默认本地 Electron 范围，不是完整安全验收。前两节为原审阅的忠实摘要，原审阅者当时未审阅本次新增文档；末节单独记录本次文档整理的独立审查及修正。

原文只保留在本地，未随本目录交付。以下 SHA-256 对应原始 Markdown 字节，宿主路径链接未转录；[结构化回执](receipt.json)同时保存来源摘要与输入绑定。

| 来源 ID                                                                                     | 原文 SHA-256                                                       | 原包装器时间（UTC）            |
| ------------------------------------------------------------------------------------------- | ------------------------------------------------------------------ | ------------------------------ |
| `r6-trusted-editor-save-20261019T231256525294Z/agents/independent-final-evidence-review.md` | `da6f72bdef045619505eb5e1ae1b910ba332e44ab30734fa52cb82220cbb5ea4` | 2026-10-20T00:14:18Z–00:17:16Z |
| `r6-trusted-editor-save-20261019T231256525294Z/agents/independent-csp-admission-review.md`  | `b6788a7fc47d0a908e05023217c887f97587454f0ac4eb64f436f7af23cd39dd` | 2026-10-19T23:53:28Z–23:54:29Z |

## 最终证据复核

原审阅独立重算 5,210 个源码与 14 个构建哈希，与[历史已验证输入清单](validated-inputs.json)一致；核对匹配候选的原始日志、回执和日志摘要，支持 Vitest 2248 通过/18 跳过、Node 177、external 6、自检 12 及定向窗口 8/8。默认 `run-jknbt5` 为 185 通过/22 跳过/0 失败/0 flaky，原 201 项无遗漏，恰加六项 R6，每项一次执行、零重试；默认命令执行新构建并匹配最终产物，配置和预算不变。

原审阅接受默认本地 Electron 门槛：实际提交回执、文件读回、撤权后拒绝、真实 `frame-src` 事件及原生 guard 的 `defaultPrevented` 从 false 到 true 均有记录；后续使用有效旧基线的保存被拒绝且无新增 stage。HTTP 403、独立 preload 与 Main 权威边界保持。fixture 转发实际编译 server 私有帧，导入/启动/映射仍为替代部分。

原审阅确认该续验仅三个声明路径变化，保护输入与批准计划哈希相同，八个历史目录封存摘要匹配，完整保全报告无差异；依赖快照仅 Vitest 结果缓存变化、没有安装记录。清理记录中的 1,060 个已观察所属 PID 均不存在；这不是所有宿主进程的审计。

183/22/2、CSP 5/1、首次 MCP stimulus 失败均独立保留。后续通过不解决 MCP、R5 超时或四个历史单测的未知根因；旧地址归因仍为 likely。桌面证据包括用户确认、所属原生探针和同期观测；缺失 CG 状态仍 unknown，不证明持续真人交互。

真实 guest、产品模型/live、S4 与 packaged 为 not_run，完整 R6 安全验收不完整，用户产品接受不推定。原审阅只读，未执行测试、构建、GUI、网络或远端操作。

## CSP/Main 续验源码审阅

该审阅只比较三个续验路径与当轮 intake：`e2e/mota-editor.spec.ts`、`apps/desktop/src/main/workbench/application.ts`、`apps/desktop/src/main/workbench/mota-managed-app.test.ts`；结论为 scoped source accept，无 actionable finding。

审阅确认默认预算的轮询等待真实 CSP 异步事件，事件记录有界，未合成事件或弱化导航/保存断言。Main 在撤权前校验空间与版本，合法全局隐藏覆盖各空间编辑器，admission counters 阻止排队重授权，后台 Browser 显示仍受限；共享错误映射保留 `pane_limit`。新增反例覆盖两项兼容性、伪造/过期请求与 prequeue 保存拒绝。

该源码审阅结束时 controller 最终运行结论仍待证据，因此其原文的“验收 pending”保留为当时状态；后续最终证据复核才接受默认范围。两者不能互换。包装器记录实际 CLI `--model gpt-6.1-sol --sandbox read-only`，只证明参数选择，不是后端身份认证。

## 本次文档整理与提交准备

首次独立审查为 `CHANGES REQUIRED`：公开聚合算法未明确 Unicode 转义，清单的 160 个非 ASCII 路径在转义和非转义 JSON 下产生不同摘要。P2 修正只补明精确的 `ensure_ascii=True` 序列化、UTF-8 和无尾随换行要求，未改变历史映射或聚合值。

后续只读复核独立执行公开示例，重现 source/build 原摘要，核对实际格式、链接、一致性检查和原始绑定后给出 **P2 CLOSED — ACCEPT DOCUMENTATION/COMMIT READINESS**，无剩余发现。初始审查还确认五组计划树覆盖全部 74 个 dirty 路径、5,214 个最终文件，R5/R6 共享文件按冻结版本分阶段暂存；当时真实 index 为空，尚未提交或推送。

| 来源 ID                                                                               | 原文 SHA-256                                                       |
| ------------------------------------------------------------------------------------- | ------------------------------------------------------------------ |
| `submission-readiness-20261020T014526329597Z/agents/independent-submission-review.md` | `2140719c88f049b43560f7462c14d3651bbe1d2edd57e16fca4be4de2afed5f1` |
| `submission-readiness-20261020T014526329597Z/agents/independent-encoding-followup.md` | `848f1f45b8142d5843912e587a6b2f8c77bfe9e23500be5934878efa29345589` |

复核接受 controller 在此真实结论后补充本摘要和行政状态，并在提交前再次核对文档与最终树。接受范围限于文档收尾及相同产品字节的默认验证；真实 guest/模型、S4、packaged、远端 CI 与用户接受没有被补齐。审查使用真实 CLI `--model gpt-6.1-sol --sandbox read-only`，未运行产品测试、构建、GUI 或 Git 写操作；原始审查材料仍只保留在本地。
