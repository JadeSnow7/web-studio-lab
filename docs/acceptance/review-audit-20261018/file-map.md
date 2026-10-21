# 固定 PR 范围：252 文件 → 入口/职责 → 计划出口 → 证据

输入为 `b5531e1ac3b3da7adf000f6ba61f2c5b19a0755f..e6bb391df4c1d6c0c6a884d6acdc4061e3027b3b`。本表是定位索引，不是逐函数完整审计或通过声明；完整声明、行号及内容摘要见 [JSON](file-map.json)，证据代号/出口见 [审计入口](README.md)。定位取固定 head 中与差异新行相交的声明/测试/章节；已有声明覆盖了变化区间，不表示该声明每行均改动。

## Linux必跑报告工作流

| 文件                                                                              | 固定head定位入口（节选）                                            | 计划出口 | 证据 | 本轮审查状态          |
| --------------------------------------------------------------------------------- | ------------------------------------------------------------------- | -------- | ---- | --------------------- |
| [A .github/workflows/linux-guest.yml](../../../.github/workflows/linux-guest.yml) | `name` L1；`on` L2；`permissions` L7；`concurrency` L9；另1项见JSON | R1       | E04  | indexed；未逐文件重审 |

## macOS完整检查与默认E2E工作流

| 文件                                                                        | 固定head定位入口（节选）                                            | 计划出口 | 证据      | 本轮审查状态          |
| --------------------------------------------------------------------------- | ------------------------------------------------------------------- | -------- | --------- | --------------------- |
| [A .github/workflows/validate.yml](../../../.github/workflows/validate.yml) | `name` L1；`on` L2；`permissions` L7；`concurrency` L9；另1项见JSON | R2       | E05 / E11 | indexed；未逐文件重审 |

## Vitest产物.vitest忽略

| 文件                                | 固定head定位入口（节选）             | 计划出口   | 证据 | 本轮审查状态          |
| ----------------------------------- | ------------------------------------ | ---------- | ---- | --------------------- |
| [M .gitignore](../../../.gitignore) | `.gitignore module/configuration` L1 | R2.context | E05  | indexed；未逐文件重审 |

## 精确冻结输入格式例外

| 文件                                          | 固定head定位入口（节选）                  | 计划出口 | 证据      | 本轮审查状态          |
| --------------------------------------------- | ----------------------------------------- | -------- | --------- | --------------------- |
| [M .prettierignore](../../../.prettierignore) | `.prettierignore module/configuration` L1 | R2       | E05 / E11 | indexed；未逐文件重审 |

## Harness入口/授权/真实与离线验证边界

| 文件                              | 固定head定位入口（节选）                                                                                                              | 计划出口           | 证据 | 本轮审查状态          |
| --------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------- | ------------------ | ---- | --------------------- |
| [M AGENTS.md](../../../AGENTS.md) | `工作与交付` L30；`Electron 宿主中的窗口测试` L40；`外部 edu-web 接入与定向复验` L50；`外部 mota-web 接入与定向复验` L61；另5项见JSON | candidate.contract | E11  | indexed；未逐文件重审 |

## 开发/单写入者/验证与交付规范

| 文件                                          | 固定head定位入口（节选）    | 计划出口           | 证据 | 本轮审查状态          |
| --------------------------------------------- | --------------------------- | ------------------ | ---- | --------------------- |
| [M CONTRIBUTING.md](../../../CONTRIBUTING.md) | `5. 当前命令与验证门槛` L48 | candidate.contract | E11  | indexed；未逐文件重审 |

## 产品能力/历史演示/运行边界入口

| 文件                              | 固定head定位入口（节选）                                                                        | 计划出口           | 证据            | 本轮审查状态          |
| --------------------------------- | ----------------------------------------------------------------------------------------------- | ------------------ | --------------- | --------------------- |
| [M README.md](../../../README.md) | `Web Studio Lab` L1；`本轮场景与材料（2026-10-16）` L5；`当前状态` L21；`环境` L47；另3项见JSON | candidate.contract | E01 / E02 / E03 | indexed；未逐文件重审 |

## 导入、双页与任务授权交互合同

| 文件                                        | 固定head定位入口（节选）                                                                                                                     | 计划出口                                    | 证据            | 本轮审查状态          |
| ------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------- | --------------- | --------------------- |
| [M UX-CONTRACT.md](../../../UX-CONTRACT.md) | `本次标准 App 公开研究（2026-10-15）` L64；`魔塔受限 AI 任务（2026-10-15）` L75；`空间 App 描述` L121；`外部工程导入入口（2026-10-14）` L127 | candidate.import-ui / candidate.mota / P0.D | E01 / E02 / E13 | indexed；未逐文件重审 |

## edu发音验证/音频权限/恢复

| 文件                                                                                                                                                              | 固定head定位入口（节选）                                                                                                                                                                                                                                           | 计划出口                                     | 证据      | 本轮审查状态          |
| ----------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ | -------------------------------------------- | --------- | --------------------- |
| [A apps/desktop/EDU-VERIFICATION.md](../../../apps/desktop/EDU-VERIFICATION.md)                                                                                   | `edu pronunciation verification in the desktop` L1                                                                                                                                                                                                                 | candidate.edu-verification / candidate.audio | E15 / E14 | indexed；未逐文件重审 |
| [A apps/desktop/src/main/preview/edu-audio-monitor.test.ts](../../../apps/desktop/src/main/preview/edu-audio-monitor.test.ts)                                     | `document` L6；`run` L35；`describe: document-start native audio ownership` L38；`it: stops originals, track clones and stream clones using saved native methods/getter` L39；另5项见JSON                                                                          | candidate.edu-verification / candidate.audio | E15 / E14 | indexed；未逐文件重审 |
| [A apps/desktop/src/main/preview/edu-audio-monitor.ts](../../../apps/desktop/src/main/preview/edu-audio-monitor.ts)                                               | `eduAudioMonitorSource` L5；`ReceiptSchema` L101；`EduAudioReceipt` L110；`EvaluationSchema` L111；另7项见JSON                                                                                                                                                     | candidate.edu-verification / candidate.audio | E15 / E14 | indexed；未逐文件重审 |
| [A apps/desktop/src/main/preview/edu-audio-policy.test.ts](../../../apps/desktop/src/main/preview/edu-audio-policy.test.ts)                                       | `binding` L3；`request` L18；`describe: edu audio permission tuple` L26；`it: allows only the current student audio main frame` L27；另4项见JSON                                                                                                                   | candidate.edu-verification / candidate.audio | E15 / E14 | indexed；未逐文件重审 |
| [A apps/desktop/src/main/preview/edu-audio-policy.ts](../../../apps/desktop/src/main/preview/edu-audio-policy.ts)                                                 | `EduAudioBinding` L1；`EduAudioRequest` L16；`allowsEduAudio` L25                                                                                                                                                                                                  | candidate.edu-verification / candidate.audio | E15 / E14 | indexed；未逐文件重审 |
| [A apps/desktop/src/main/workbench/edu-verification-workbench.test.ts](../../../apps/desktop/src/main/workbench/edu-verification-workbench.test.ts)               | `deferred` L20；`setup` L27；`command` L128；`state` L146；另27项见JSON                                                                                                                                                                                            | candidate.edu-verification / candidate.audio | E15 / E14 | indexed；未逐文件重审 |
| [A apps/desktop/src/renderer/src/workspace/verification-presentation.test.ts](../../../apps/desktop/src/renderer/src/workspace/verification-presentation.test.ts) | `view` L4；`describe: 发音验证呈现` L24；`it: shows bounded time and remaining calls without unlocking an expired lease` L25；`it: distinguishes stopped, restoring, recovery-only and ended states` L39；另1项见JSON                                              | candidate.edu-verification / candidate.audio | E15 / E14 | indexed；未逐文件重审 |
| [A apps/desktop/src/renderer/src/workspace/verification-presentation.ts](../../../apps/desktop/src/renderer/src/workspace/verification-presentation.ts)           | `verificationPresentation` L3                                                                                                                                                                                                                                      | candidate.edu-verification / candidate.audio | E15 / E14 | indexed；未逐文件重审 |
| [A apps/service/EDU-VERIFICATION.md](../../../apps/service/EDU-VERIFICATION.md)                                                                                   | `Short pronunciation verification in the execution service` L1；`Service API` L9；`Durable recovery` L46；`Private host configuration` L133；另2项见JSON                                                                                                           | candidate.edu-verification / candidate.audio | E15 / E14 | indexed；未逐文件重审 |
| [A apps/service/src/edu-admission-recovery.test.ts](../../../apps/service/src/edu-admission-recovery.test.ts)                                                     | `fixture` L12；`snapshot` L18；`open` L50；`describe: admission-only durable recovery (simulated interruption)` L83；另7项见JSON                                                                                                                                   | candidate.edu-verification / candidate.audio | E15 / E14 | indexed；未逐文件重审 |
| [A apps/service/src/edu-assessment.ts](../../../apps/service/src/edu-assessment.ts)                                                                               | `ASSESSMENT_PREFIX` L4；`MAX_ASSESSMENT_FRAME` L5；`MAX_ASSESSMENT_RESULT` L6；`uuid` L7；另12项见JSON                                                                                                                                                             | candidate.edu-verification / candidate.audio | E15 / E14 | indexed；未逐文件重审 |
| [A apps/service/src/edu-provider.ts](../../../apps/service/src/edu-provider.ts)                                                                                   | `absolute` L7；`remotePath` L11；`ProviderConfigSchema` L15；`ProviderConfig` L31；另6项见JSON                                                                                                                                                                     | candidate.edu-verification / candidate.audio | E15 / E14 | indexed；未逐文件重审 |
| [A apps/service/src/edu-recovery-journal.test.ts](../../../apps/service/src/edu-recovery-journal.test.ts)                                                         | `identity` L8；`status` L9；`record` L16；`it: a persisted verification journal locks a fresh service before async loading` L24；另2项见JSON                                                                                                                       | candidate.edu-verification / candidate.audio | E15 / E14 | indexed；未逐文件重审 |
| [A apps/service/src/edu-recovery-journal.ts](../../../apps/service/src/edu-recovery-journal.ts)                                                                   | `loopback` L10；`RecoveryRecordSchema` L13；`RecoveryRecord` L28；`AdmissionRecoveryRecordSchema` L29；另8项见JSON                                                                                                                                                 | candidate.edu-verification / candidate.audio | E15 / E14 | indexed；未逐文件重审 |
| [A apps/service/src/edu-verification-app-boundary.test.ts](../../../apps/service/src/edu-verification-app-boundary.test.ts)                                       | `provider` L17；`fixture` L27；`describe: verification uses the real strict AppService project boundary` L184；`it: AppService rejects begin identity as a project key; service begin/end and reconcile project it without weakening strictness` L185；另7项见JSON | candidate.edu-verification / candidate.audio | E15 / E14 | indexed；未逐文件重审 |
| [A apps/service/src/edu-verification-recovery.test.ts](../../../apps/service/src/edu-verification-recovery.test.ts)                                               | `source` L10；`original` L11；`leased` L12；`record` L13；另10项见JSON                                                                                                                                                                                             | candidate.edu-verification / candidate.audio | E15 / E14 | indexed；未逐文件重审 |
| [A apps/service/src/edu-verification.test.ts](../../../apps/service/src/edu-verification.test.ts)                                                                 | `source` L13；`config` L14；`identity` L24；`lease` L25；另40项见JSON                                                                                                                                                                                              | candidate.edu-verification / candidate.audio | E15 / E14 | indexed；未逐文件重审 |
| [A apps/service/src/edu-verification.ts](../../../apps/service/src/edu-verification.ts)                                                                           | `safeCode` L14；`Apps` L16；`EduVerificationService` L28；`EduVerificationService.constructor` L46；另19项见JSON                                                                                                                                                   | candidate.edu-verification / candidate.audio | E15 / E14 | indexed；未逐文件重审 |
| [A docs/architecture/edu-audio.md](../../../docs/architecture/edu-audio.md)                                                                                       | `edu 学生录音权限与回收` L1；`验证边界` L11                                                                                                                                                                                                                        | candidate.edu-verification / candidate.audio | E15 / E14 | indexed；未逐文件重审 |
| [A packages/protocol/src/edu-verification.test.ts](../../../packages/protocol/src/edu-verification.test.ts)                                                       | `fixtureId` L3；`nextFixtureId` L4；`target` L5；`describe: short pronunciation verification contract` L6；另2项见JSON                                                                                                                                             | candidate.edu-verification / candidate.audio | E15 / E14 | indexed；未逐文件重审 |
| [A packages/protocol/src/edu-verification.ts](../../../packages/protocol/src/edu-verification.ts)                                                                 | `uuid` L3；`EduVerificationIdentitySchema` L4；`EduVerificationBeginSchema` L8；`EduVerificationTargetSchema` L12；另8项见JSON                                                                                                                                     | candidate.edu-verification / candidate.audio | E15 / E14 | indexed；未逐文件重审 |

## 安装包入口/文件清单/权限声明

| 文件                                                                              | 固定head定位入口（节选） | 计划出口            | 证据 | 本轮审查状态          |
| --------------------------------------------------------------------------------- | ------------------------ | ------------------- | ---- | --------------------- |
| [M apps/desktop/electron-builder.yml](../../../apps/desktop/electron-builder.yml) | `files` L10；`mac` L33   | candidate.packaging | E01  | indexed；未逐文件重审 |

## 公开研究/正文读取/来源回执（不属于P2全部实现）

| 文件                                                                                                                                                      | 固定head定位入口（节选）                                                                                                                                                       | 计划出口 | 证据 | 本轮审查状态          |
| --------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ | -------- | ---- | --------------------- |
| [A apps/desktop/src/main/chat-research.test.ts](../../../apps/desktop/src/main/chat-research.test.ts)                                                     | `transport` L4；`call` L30；`reply` L50；`returned` L55；另5项见JSON                                                                                                           | S5b      | E01  | indexed；未逐文件重审 |
| [A apps/desktop/src/main/preview/controller-public-open.test.ts](../../../apps/desktop/src/main/preview/controller-public-open.test.ts)                   | `mocks` L7；`getURL` L26；`getTitle` L29；`isLoading` L32；另22项见JSON                                                                                                        | S5b      | E01  | indexed；未逐文件重审 |
| [M apps/desktop/src/main/preview/public-document.ts](../../../apps/desktop/src/main/preview/public-document.ts)                                           | `fetchPublicDocument` L172；`read` L179                                                                                                                                        | S5b      | E01  | indexed；未逐文件重审 |
| [M apps/desktop/src/main/preview/public-protocol.test.ts](../../../apps/desktop/src/main/preview/public-protocol.test.ts)                                 | `setup` L6；`describe: 隔离公开文档协议` L39；`it: does not begin DNS or HTTPS work for an already cancelled read` L40；`it: 导航中的晚到响应不能恢复旧文档` L119；另5项见JSON | S5b      | E01  | indexed；未逐文件重审 |
| [M apps/desktop/src/main/preview/public-protocol.ts](../../../apps/desktop/src/main/preview/public-protocol.ts)                                           | `PublicProtocolOptions` L5；`PublicDocumentProtocol` L35；`PublicDocumentProtocol.handle` L88；`PublicDocumentProtocol.settle` L144；另1项见JSON                               | S5b      | E01  | indexed；未逐文件重审 |
| [A apps/desktop/src/main/workbench/research.test.ts](../../../apps/desktop/src/main/workbench/research.test.ts)                                           | `grant` L6；`capture` L17；`state` L32；`describe: bounded Main research ownership and history` L34；另4项见JSON                                                               | S5b      | E01  | indexed；未逐文件重审 |
| [A apps/desktop/src/main/workbench/research.ts](../../../apps/desktop/src/main/workbench/research.ts)                                                     | `ResearchFailure` L5；`ResearchFailure.constructor` L6；`ResearchOwner` L23；`ResearchOwners` L32；另10项见JSON                                                                | S5b      | E01  | indexed；未逐文件重审 |
| [A apps/desktop/src/renderer/src/workspace/ResearchSources.tsx](../../../apps/desktop/src/renderer/src/workspace/ResearchSources.tsx)                     | `ResearchSources` L4                                                                                                                                                           | S5b      | E01  | indexed；未逐文件重审 |
| [A apps/desktop/src/renderer/src/workspace/research-presentation.test.ts](../../../apps/desktop/src/renderer/src/workspace/research-presentation.test.ts) | `app` L22；`resource` L34；`workspace` L47；`target` L48；另13项见JSON                                                                                                         | S5b      | E01  | indexed；未逐文件重审 |
| [A apps/desktop/src/renderer/src/workspace/research-presentation.ts](../../../apps/desktop/src/renderer/src/workspace/research-presentation.ts)           | `ResearchWorkspace` L3；`WorkbenchTaskVersion` L4；`researchDraftEligible` L7；`researchVersionEligible` L26；另5项见JSON                                                      | S5b      | E01  | indexed；未逐文件重审 |
| [A apps/service/src/research-runtime.test.ts](../../../apps/service/src/research-runtime.test.ts)                                                         | `sessionId` L12；`workspaceId` L13；`refs` L14；`grant` L15；另15项见JSON                                                                                                      | S5b      | E01  | indexed；未逐文件重审 |
| [A apps/service/src/research-runtime.ts](../../../apps/service/src/research-runtime.ts)                                                                   | `recordNativeSearch` L14；`validateResearchReply` L42                                                                                                                          | S5b      | E01  | indexed；未逐文件重审 |
| [A packages/protocol/src/research.test.ts](../../../packages/protocol/src/research.test.ts)                                                               | `uuid` L21；`now` L22；`contentHash` L24；`otherHash` L25；另28项见JSON                                                                                                        | S5b      | E01  | indexed；未逐文件重审 |
| [A packages/protocol/src/research.ts](../../../packages/protocol/src/research.ts)                                                                         | `MAX_RESEARCH_SOURCES` L4；`MAX_RESEARCH_BYTES` L5；`MAX_RESEARCH_TEXT_BYTES` L6；`MAX_NATIVE_SEARCH_RECORDS` L7；另40项见JSON                                                 | S5b      | E01  | indexed；未逐文件重审 |

## 原候选Main/IPC/迁移集成回归（未归已完重构包）

| 文件                                                                                                                | 固定head定位入口（节选）                                                                                                                                                                                                                                                    | 计划出口              | 证据 | 本轮审查状态          |
| ------------------------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | --------------------- | ---- | --------------------- |
| [M apps/desktop/src/main/chat-service.test.ts](../../../apps/desktop/src/main/chat-service.test.ts)                 | `describe: Mota exact control bridge` L71；`binding` L72；`it: rejects a receipt for another page generation and keeps cleanup unknown` L85；`it: treats exact pre-model rejection as executor not started but still releases the Mota lease separately` L113；另31项见JSON | candidate.integration | E01  | indexed；未逐文件重审 |
| [M apps/desktop/src/main/chat-service.ts](../../../apps/desktop/src/main/chat-service.ts)                           | `ChatService` L69；`ChatService.setAdmissionRecoveryListener` L76；`ChatService.setVerificationGuard` L82；`ChatService.assertMaintenance` L85；另26项见JSON                                                                                                                | candidate.integration | E01  | indexed；未逐文件重审 |
| [M apps/desktop/src/main/index.ts](../../../apps/desktop/src/main/index.ts)                                         | `openWorkbench` L31                                                                                                                                                                                                                                                         | candidate.integration | E01  | indexed；未逐文件重审 |
| [M apps/desktop/src/main/preview/preview-pure.test.ts](../../../apps/desktop/src/main/preview/preview-pure.test.ts) | `describe: managed app navigation lease` L26；`it.each(['/', '/student', '/student?mode=practice#record']): retains the exact app origin while navigating %s` L27；`it.each([                                                                                               |

    'http://127.0.0.1:49153/student',
    'http://localhost:49152/student',
    'http://name:password@127.0.0.1:49152/student',
    'https://127.0.0.1:49152/student',
    'file:///tmp/student',
    'not a url',

]): rejects another authority or invalid URL: %s`L30 | candidate.integration | E01 | indexed；未逐文件重审 |
| [M apps/desktop/src/main/window-close.test.ts](../../../apps/desktop/src/main/window-close.test.ts) |`fixture` L3；`describe: window shutdown` L87；`it: binds the research reader to Main with the exact call and cancellation signal` L95；`it: keeps the service available until workbench ending-source operations settle`L160；另4项见JSON | candidate.integration | E01 | indexed；未逐文件重审 |
| [A apps/desktop/src/main/workbench/observation-admission.test.ts](../../../apps/desktop/src/main/workbench/observation-admission.test.ts) |`setup` L8；`command` L69；`file` L75；`result`L92；另9项见JSON | candidate.integration | E01 | indexed；未逐文件重审 |
| [M apps/desktop/src/main/workbench/runtime-outcomes.test.ts](../../../apps/desktop/src/main/workbench/runtime-outcomes.test.ts) |`setup` L29；`describe: edu page task binding and application` L176；`it.each([
'current',
'noop',
'receipt-project',
'receipt-instance',
'receipt-profile',
'receipt-source-missing',
'navigation',
'instance',
'candidate',
'source',
'cancel',
'late-navigation',
'late-cancel',
'late-stop',
'late-cancel-idle',
]): applies only the confirmed current candidate: %s`L177 | candidate.integration | E01 | indexed；未逐文件重审 |
| [M apps/service/src/initialization-migration.test.ts](../../../apps/service/src/initialization-migration.test.ts) |`fixture` L8；`directories` L52；`describe: R6 service boundary initialization` L63；`openWithJournal` L109；另4项见JSON | candidate.integration | E01 | indexed；未逐文件重审 |

## run-patch通道来源校验回归

| 文件                                                                                          | 固定head定位入口（节选）                                                                 | 计划出口 | 证据 | 本轮审查状态          |
| --------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------- | -------- | ---- | --------------------- |
| [M apps/desktop/src/main/ipc-guard.test.ts](../../../apps/desktop/src/main/ipc-guard.test.ts) | `describe: 源码 diff 窄查询` L36；`it: 常规注册、严格拒绝路径参数，并校验返回值预算` L37 | P0.D     | E12  | indexed；未逐文件重审 |

## run-patch查询来源校验与应用用例分派

| 文件                                                                    | 固定head定位入口（节选） | 计划出口 | 证据 | 本轮审查状态          |
| ----------------------------------------------------------------------- | ------------------------ | -------- | ---- | --------------------- |
| [M apps/desktop/src/main/ipc.ts](../../../apps/desktop/src/main/ipc.ts) | `registerIpc` L44        | P0.D     | E12  | indexed；未逐文件重审 |

## 截图NativeImage/PNG预算与CDP滚动坐标/命中/取消导航回归

| 文件                                                                                                    | 固定head定位入口（节选）                                                                               | 计划出口    | 证据 | 本轮审查状态          |
| ------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------ | ----------- | ---- | --------------------- |
| [M apps/desktop/src/main/preview/app-ui.test.ts](../../../apps/desktop/src/main/preview/app-ui.test.ts) | `fakePage` L48；`describe: AppUiDriver screenshot` L201；`validPng` L202；`fixture` L204；另11项见JSON | E2E.context | E01  | indexed；未逐文件重审 |

## Mota状态/动作与通用截图PNG预算/CDP坐标/命中/取消导航

| 文件                                                                                          | 固定head定位入口（节选）                                                                                           | 计划出口         | 证据      | 本轮审查状态          |
| --------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------ | ---------------- | --------- | --------------------- |
| [M apps/desktop/src/main/preview/app-ui.ts](../../../apps/desktop/src/main/preview/app-ui.ts) | `AppUiDriver` L200；`AppUiDriver.mota` L201；`AppUiDriver.motaState` L217；`AppUiDriver.motaAct` L220；另5项见JSON | R4 / E2E.context | E03 / E01 | indexed；未逐文件重审 |

## edu页面录音权限/生命周期回归

| 文件                                                                                                                        | 固定head定位入口（节选）                                             | 计划出口        | 证据 | 本轮审查状态          |
| --------------------------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------- | --------------- | ---- | --------------------- |
| [A apps/desktop/src/main/preview/controller-audio.test.ts](../../../apps/desktop/src/main/preview/controller-audio.test.ts) | `mocks` L5；`constructor` L30；`setup` L39；`check` L87；另9项见JSON | candidate.audio | E14  | indexed；未逐文件重审 |

## DevTools/原生焦点迁移回归

| 文件                                                                                                                                | 固定head定位入口（节选）                                                                                                                                                                                                                                                | 计划出口  | 证据 | 本轮审查状态          |
| ----------------------------------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | --------- | ---- | --------------------- |
| [M apps/desktop/src/main/preview/controller-migration.test.ts](../../../apps/desktop/src/main/preview/controller-migration.test.ts) | `mocks` L5；`describe: R4 deferred inspect exit ownership` L166；`it: coalesces reopen requests until the old native DevTools connection finishes closing` L201；`it: revokes a queued DevTools reopen on disposal and ignores a late close callback` L219；另1项见JSON | E2E.focus | E09  | indexed；未逐文件重审 |

## 原生导航/公开研究/edu录音/Mota接入与DevTools重开时序

| 文件                                                                                                  | 固定head定位入口（节选）                                                                                      | 计划出口                                           | 证据            | 本轮审查状态          |
| ----------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------- | -------------------------------------------------- | --------------- | --------------------- |
| [M apps/desktop/src/main/preview/controller.ts](../../../apps/desktop/src/main/preview/controller.ts) | `NativeNavigation` L25；`PublicRead` L26；`publicReadError` L40；`PreviewControllerOptions` L52；另25项见JSON | S5b / candidate.audio / candidate.mota / E2E.focus | E01 / E09 / E14 | indexed；未逐文件重审 |

## Mota四工具/页面输入/任务授权与lease

| 文件                                                                                                                                                        | 固定head定位入口（节选）                                                                             | 计划出口 | 证据 | 本轮审查状态          |
| ----------------------------------------------------------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------- | -------- | ---- | --------------------- |
| [A apps/desktop/src/main/preview/mota-page.test.ts](../../../apps/desktop/src/main/preview/mota-page.test.ts)                                               | `snapshot` L7；`fixture` L30；`onSend` L49；`send` L60；另28项见JSON                                 | R4       | E03  | indexed；未逐文件重审 |
| [A apps/desktop/src/main/preview/mota-page.ts](../../../apps/desktop/src/main/preview/mota-page.ts)                                                         | `MOTA_STATE_EXPRESSION` L5；`Point` L34；`MotaPagePort` L35；`KEYS` L45；另19项见JSON                | R4       | E03  | indexed；未逐文件重审 |
| [A apps/desktop/src/main/workbench/mota-managed-app.test.ts](../../../apps/desktop/src/main/workbench/mota-managed-app.test.ts)                             | `constructor` L48；`roots` L76；`required` L81；`deferred` L85；另38项见JSON                         | R4       | E03  | indexed；未逐文件重审 |
| [A apps/desktop/src/renderer/src/workspace/mota-task-presentation.test.ts](../../../apps/desktop/src/renderer/src/workspace/mota-task-presentation.test.ts) | `app` L5；`game` L17；`workspace` L31；`target` L32；另9项见JSON                                     | R4       | E03  | indexed；未逐文件重审 |
| [A apps/desktop/src/renderer/src/workspace/mota-task-presentation.ts](../../../apps/desktop/src/renderer/src/workspace/mota-task-presentation.ts)           | `MOTA_PLAY_SCOPE` L3；`MOTA_MAP_SCOPE` L4；`MotaTaskScope` L5；`motaTaskScopes` L8；另2项见JSON      | R4       | E03  | indexed；未逐文件重审 |
| [A apps/service/src/mota-control.test.ts](../../../apps/service/src/mota-control.test.ts)                                                                   | `binding` L6；`request` L19；`ack` L26；`describe: Mota run control ownership` L34；另4项见JSON      | R4       | E03  | indexed；未逐文件重审 |
| [A apps/service/src/mota-control.ts](../../../apps/service/src/mota-control.ts)                                                                             | `Owner` L10；`MotaControls` L12；`MotaControls.constructor` L18；`MotaControls.key` L19；另7项见JSON | R4       | E03  | indexed；未逐文件重审 |
| [A packages/protocol/src/mota-control.ts](../../../packages/protocol/src/mota-control.ts)                                                                   | `MOTA_PLAY_SCOPE` L3；`MOTA_MAP_WRITE_SCOPE` L4；`id` L6；`generation` L7；另24项见JSON              | R4       | E03  | indexed；未逐文件重审 |

## managed App origin/实例lease导航校验

| 文件                                                                                                                | 固定head定位入口（节选）     | 计划出口                               | 证据      | 本轮审查状态          |
| ------------------------------------------------------------------------------------------------------------------- | ---------------------------- | -------------------------------------- | --------- | --------------------- |
| [M apps/desktop/src/main/preview/navigation-policy.ts](../../../apps/desktop/src/main/preview/navigation-policy.ts) | `isAllowedManagedAppUrl` L21 | candidate.lifecycle / candidate.import | E01 / E13 | indexed；未逐文件重审 |

## Mota授权/dispatch/清理与空截图回归

| 文件                                                                                                                  | 固定head定位入口（节选）                                                                                                                                                                                                                                                   | 计划出口         | 证据 | 本轮审查状态          |
| --------------------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ---------------- | ---- | --------------------- |
| [M apps/desktop/src/main/workbench/app-control.test.ts](../../../apps/desktop/src/main/workbench/app-control.test.ts) | `describe: AppControl scenarios` L434；`it: replays deterministically with evidence bound to revision and app instance` L447；`it: an empty screenshot is an evidence error, is not saved, and stops subsequent scenario steps` L464；`test.ports.ui: r` L466；另6项见JSON | R4 / E2E.context | E03  | indexed；未逐文件重审 |

## Mota授权/dispatch/mapwrite/settleRun与空截图失败

| 文件                                                                                                        | 固定head定位入口（节选）                                                                         | 计划出口         | 证据 | 本轮审查状态          |
| ----------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------ | ---------------- | ---- | --------------------- |
| [M apps/desktop/src/main/workbench/app-control.ts](../../../apps/desktop/src/main/workbench/app-control.ts) | `AppControlContext` L47；`AppUiPort` L59；`AppControlPorts` L105；`AppControl` L185；另4项见JSON | R4 / E2E.context | E03  | indexed；未逐文件重审 |

## edu/通用来源采集与导入入口

| 文件                                                                                                                          | 固定head定位入口（节选）                                                                                                                                                                                                                                                         | 计划出口         | 证据      | 本轮审查状态          |
| ----------------------------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ---------------- | --------- | --------------------- |
| [A apps/desktop/src/main/workbench/app-import-flow.test.ts](../../../apps/desktop/src/main/workbench/app-import-flow.test.ts) | `source` L8；`deferred` L16；`fixture` L23；`workspace` L90；另16项见JSON                                                                                                                                                                                                        | candidate.import | E13 / E01 | indexed；未逐文件重审 |
| [A apps/desktop/src/main/workbench/edu-source-git.test.ts](../../../apps/desktop/src/main/workbench/edu-source-git.test.ts)   | `mock` L8；`fixture` L13；`describe: source selection cannot execute repository-configured host helpers` L37；`it.each(['filter', 'partial-clone', 'submodule', 'config-error'] as const): rejects %s before inspecting worktree status` L38；另1项见JSON                        | candidate.import | E13 / E01 | indexed；未逐文件重审 |
| [A apps/desktop/src/main/workbench/edu-source.test.ts](../../../apps/desktop/src/main/workbench/edu-source.test.ts)           | `repository` L9；`fixture` L10；`identity` L19；`describe: Main-owned edu source capture` L21；另5项见JSON                                                                                                                                                                       | candidate.import | E13 / E01 | indexed；未逐文件重审 |
| [A apps/desktop/src/main/workbench/edu-source.ts](../../../apps/desktop/src/main/workbench/edu-source.ts)                     | `exec` L18；`hash` L19；`repositoryIdentity` L21；`git` L22；另3项见JSON                                                                                                                                                                                                         | candidate.import | E13 / E01 | indexed；未逐文件重审 |
| [A apps/desktop/src/main/workbench/import-source.test.ts](../../../apps/desktop/src/main/workbench/import-source.test.ts)     | `input` L6；`describe: static edu profile preview` L16；`it: reports supported metadata without exposing script values or source bytes` L17；`it.each(['[]', '{}', '{', '{"scripts":{"build":1,"typecheck":"tsc"}}']): rejects unsupported package metadata %s` L26；另4项见JSON | candidate.import | E13 / E01 | indexed；未逐文件重审 |
| [A apps/desktop/src/main/workbench/import-source.ts](../../../apps/desktop/src/main/workbench/import-source.ts)               | `ImportFailure` L11；`ImportFailure.constructor` L12；`describeImport` L21；`describeImport` L22；另2项见JSON                                                                                                                                                                    | candidate.import | E13 / E01 | indexed；未逐文件重审 |
| [A apps/service/src/app-imports.test.ts](../../../apps/service/src/app-imports.test.ts)                                       | `roots` L10；`files` L14；`request` L17；`target` L35；另23项见JSON                                                                                                                                                                                                              | candidate.import | E13 / E01 | indexed；未逐文件重审 |
| [A apps/service/src/app-imports.ts](../../../apps/service/src/app-imports.ts)                                                 | `targetSchema` L18；`legacyRecordSchema` L25；`recordSchema` L34；`journalSchema` L43；另24项见JSON                                                                                                                                                                              | candidate.import | E13 / E01 | indexed；未逐文件重审 |
| [A apps/service/src/edu-app.live.test.ts](../../../apps/service/src/edu-app.live.test.ts)                                     | `it.skipIf(process.env['WSL_EDU_LIVE'] !== '1'): real edu service import, runtime identity, restart and source export` L9                                                                                                                                                        | candidate.import | E13 / E01 | indexed；未逐文件重审 |
| [A apps/service/src/edu-helper.test.ts](../../../apps/service/src/edu-helper.test.ts)                                         | `files` L10；`metadata` L11；`profile` L16；`fixture` L25；另12项见JSON                                                                                                                                                                                                          | candidate.import | E13 / E01 | indexed；未逐文件重审 |
| [A apps/service/src/edu-import-helper.test.ts](../../../apps/service/src/edu-import-helper.test.ts)                           | `files` L12；`metadata` L16；`profile` L21；`receiptSchema` L30；另59项见JSON                                                                                                                                                                                                    | candidate.import | E13 / E01 | indexed；未逐文件重审 |
| [A packages/protocol/src/app-import.ts](../../../packages/protocol/src/app-import.ts)                                         | `EduAppImportPreviewSchema` L5；`MotaAppImportPreviewSchema` L17；`AppImportPreviewSchema` L28；`AppImportViewSchema` L29；另14项见JSON                                                                                                                                          | candidate.import | E13 / E01 | indexed；未逐文件重审 |
| [A packages/protocol/src/edu-app.test.ts](../../../packages/protocol/src/edu-app.test.ts)                                     | `target` L6；`source` L7；`profile` L12；`snapshot` L13；另6项见JSON                                                                                                                                                                                                             | candidate.import | E13 / E01 | indexed；未逐文件重审 |

## 工作台权威用例；三包仅类型与研究片段，另含原候选导入/源码/edu/Mota与R4结算

| 文件                                                                                                        | 固定head定位入口（节选）                                                                          | 计划出口                                                          | 证据                  | 本轮审查状态          |
| ----------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------- | --------------------- | --------------------- |
| [M apps/desktop/src/main/workbench/application.ts](../../../apps/desktop/src/main/workbench/application.ts) | `SourceRun` L95；`EduTaskRun` L96；`standardAppProfile` L109；`sameAppProfile` L110；另76项见JSON | S7.P1 / S7.P2 / P0.D / R4 / candidate.import / candidate.edu-task | E06 / E07 / E01 / E11 | indexed；未逐文件重审 |

## Browser原生焦点/窗口迁移；R3等为旧场景编号

| 文件                                                                                                                        | 固定head定位入口（节选）                                                                                                                                                                                                                                                                                                                     | 计划出口  | 证据 | 本轮审查状态          |
| --------------------------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | --------- | ---- | --------------------- |
| [M apps/desktop/src/main/workbench/host-migration.test.ts](../../../apps/desktop/src/main/workbench/host-migration.test.ts) | `describe: R3/R5 native host migration baseline` L65；`it: resolves menu reload/devtools from active pane instead of the last layout` L66；`it: forwards focus with immutable workspace/resource/instance/generation ownership` L99；`it: disposes and removes a controller if initial loading throws, then permits retry` L121；另5项见JSON | E2E.focus | E09  | indexed；未逐文件重审 |

## 类型回调依赖迁移及原候选原生导入/研究/受管实例适配

| 文件                                                                                          | 固定head定位入口（节选）                                                                                   | 计划出口                       | 证据            | 本轮审查状态          |
| --------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------- | ------------------------------ | --------------- | --------------------- |
| [M apps/desktop/src/main/workbench/host.ts](../../../apps/desktop/src/main/workbench/host.ts) | `WorkbenchHost` L37；`WorkbenchHost.appSelectImportSource` L38；`matches` L50；`capture` L69；另36项见JSON | S7.P1 / candidate.import / S5b | E06 / E01 / E13 | indexed；未逐文件重审 |

## Browser实例lease/edu音频与admission恢复回归

| 文件                                                                                                                            | 固定head定位入口（节选）                                             | 计划出口                                                           | 证据            | 本轮审查状态          |
| ------------------------------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------- | ------------------------------------------------------------------ | --------------- | --------------------- |
| [A apps/desktop/src/main/workbench/managed-app-host.test.ts](../../../apps/desktop/src/main/workbench/managed-app-host.test.ts) | `audio` L8；`target` L25；`running` L26；`stopped` L36；另14项见JSON | candidate.lifecycle / candidate.audio / candidate.edu-verification | E01 / E14 / E15 | indexed；未逐文件重审 |

## Main-owned edu导入/页面导航/default执行兼容回归

| 文件                                                                                                                  | 固定head定位入口（节选）                                                  | 计划出口                               | 证据      | 本轮审查状态          |
| --------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------- | -------------------------------------- | --------- | --------------------- |
| [M apps/desktop/src/main/workbench/managed-app.test.ts](../../../apps/desktop/src/main/workbench/managed-app.test.ts) | `eduInput` L8；`eduSelection` L16；`setup` L32；`send` L101；另12项见JSON | candidate.import / candidate.lifecycle | E01 / E13 | indexed；未逐文件重审 |

## Browser原生焦点/DevTools迁移；R3等为旧场景编号

| 文件                                                                                                                                | 固定head定位入口（节选）                                                                                                                         | 计划出口  | 证据 | 本轮审查状态          |
| ----------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------ | --------- | ---- | --------------------- |
| [M apps/desktop/src/main/workbench/migration-followup.test.ts](../../../apps/desktop/src/main/workbench/migration-followup.test.ts) | `describe: migration review followup baseline` L101；`it: R3 reloads the just-focused native browser without an intervening snapshot drain` L109 | E2E.focus | E09  | indexed；未逐文件重审 |

## Mota来源清单/预算/导入基线

| 文件                                                                                                                  | 固定head定位入口（节选）                                                                                                     | 计划出口         | 证据 | 本轮审查状态          |
| --------------------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------- | ---------------- | ---- | --------------------- |
| [A apps/desktop/src/main/workbench/mota-source.test.ts](../../../apps/desktop/src/main/workbench/mota-source.test.ts) | `owned` L10；`fixture` L14；`put` L20；`signal` L25；另10项见JSON                                                            | candidate.import | E02  | indexed；未逐文件重审 |
| [A apps/desktop/src/main/workbench/mota-source.ts](../../../apps/desktop/src/main/workbench/mota-source.ts)           | `hash` L19；`unchanged` L20；`collectMotaSource` L30；`assertRoot` L41；另4项见JSON                                          | candidate.import | E02  | indexed；未逐文件重审 |
| [A packages/protocol/src/mota-app.test.ts](../../../packages/protocol/src/mota-app.test.ts)                           | `target` L8；`importOperationId` L9；`motaSource` L10；`motaRequest` L14；另12项见JSON                                       | candidate.import | E02  | indexed；未逐文件重审 |
| [A packages/protocol/src/mota.test.ts](../../../packages/protocol/src/mota.test.ts)                                   | `metadata` L19；`source` L20；`payload` L21；`describe: isolated mota source data contract` L23；另8项见JSON                 | candidate.import | E02  | indexed；未逐文件重审 |
| [A packages/protocol/src/mota.ts](../../../packages/protocol/src/mota.ts)                                             | `MOTA_SOURCE_MAX_FILES` L3；`MOTA_SOURCE_BYTES` L4；`MOTA_SOURCE_FILE_BYTES` L5；`MOTA_SOURCE_BASE64_BYTES` L6；另21项见JSON | candidate.import | E02  | indexed；未逐文件重审 |

## 研究用例提取/共享64调用预算

| 文件                                                                                                                                          | 固定head定位入口（节选）                                                                                                                                                                                                                                                                                                                                | 计划出口 | 证据 | 本轮审查状态          |
| --------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | -------- | ---- | --------------------- |
| [M apps/desktop/src/main/workbench/observation-application.test.ts](../../../apps/desktop/src/main/workbench/observation-application.test.ts) | `describe: environment refresh publication invariants` L826；`it: queries and validates every identical refresh without changing seq or publishing snapshots` L827；`it: publishes changed capabilities and prevents subsequent file observations` L837；`it: an unchanged newer success still invalidates an older changed response` L859；另2项见JSON | S7.P2    | E07  | indexed；未逐文件重审 |
| [A apps/desktop/src/main/workbench/research-application.test.ts](../../../apps/desktop/src/main/workbench/research-application.test.ts)       | `deferred` L20；`unused` L27；`digest` L30；`page` L31；另26项见JSON                                                                                                                                                                                                                                                                                    | S7.P2    | E07  | indexed；未逐文件重审 |
| [A apps/desktop/src/main/workbench/research-use-case.ts](../../../apps/desktop/src/main/workbench/research-use-case.ts)                       | `ResearchHost` L17；`ResearchUseCase` L45；`ResearchUseCase.constructor` L46；`ResearchUseCase.failure` L47；另2项见JSON                                                                                                                                                                                                                                | S7.P2    | E07  | indexed；未逐文件重审 |

## App事件落盘/保留stop事实/租约迟到错误回归

| 文件                                                                                                                              | 固定head定位入口（节选）                                                  | 计划出口            | 证据 | 本轮审查状态          |
| --------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------- | ------------------- | ---- | --------------------- |
| [A apps/desktop/src/main/workbench/onapp-persistence.test.ts](../../../apps/desktop/src/main/workbench/onapp-persistence.test.ts) | `audio` L13；`constructor` L24；`roots` L55；`required` L60；另13项见JSON | candidate.lifecycle | E01  | indexed；未逐文件重审 |

## 七能力端口与11回调；原候选导入/研究/Mota/edu能力签名

| 文件                                                                                            | 固定head定位入口（节选）                                                                                                  | 计划出口                   | 证据      | 本轮审查状态          |
| ----------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------- | -------------------------- | --------- | --------------------- |
| [M apps/desktop/src/main/workbench/ports.ts](../../../apps/desktop/src/main/workbench/ports.ts) | `RunDispatchFailure` L39；`RunDispatchFailure.constructor` L40；`ImportProgress` L48；`EduImportSource` L49；另18项见JSON | S7.P1 / candidate.contract | E06 / E01 | indexed；未逐文件重审 |

## RunSourceRepository基线/捕获/readPatch与assertResearchHistory

| 文件                                                                                                      | 固定head定位入口（节选）                                                                                                                         | 计划出口   | 证据      | 本轮审查状态          |
| --------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------ | ---------- | --------- | --------------------- |
| [M apps/desktop/src/main/workbench/repository.ts](../../../apps/desktop/src/main/workbench/repository.ts) | `assertCatalogBindings` L44；`WorkbenchRepository` L106；`FileWorkbenchRepository` L116；`FileWorkbenchRepository.constructor` L119；另3项见JSON | P0.D / S5b | E12 / E01 | indexed；未逐文件重审 |

## 任务源码快照与diff（独立于源码导出合同）

| 文件                                                                                                                                        | 固定head定位入口（节选）                                                                                                                                                                                                                                | 计划出口 | 证据      | 本轮审查状态          |
| ------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | -------- | --------- | --------------------- |
| [A apps/desktop/src/main/workbench/run-source-application.test.ts](../../../apps/desktop/src/main/workbench/run-source-application.test.ts) | `deferred` L24；`resolve` L31；`roots` L37；`required` L41；另49项见JSON                                                                                                                                                                                | P0.D     | E12 / E01 | indexed；未逐文件重审 |
| [A apps/desktop/src/main/workbench/run-source-repository.test.ts](../../../apps/desktop/src/main/workbench/run-source-repository.test.ts)   | `exec` L11；`directories` L12；`target` L17；`source` L18；另15项见JSON                                                                                                                                                                                 | P0.D     | E12 / E01 | indexed；未逐文件重审 |
| [A apps/desktop/src/main/workbench/run-source-repository.ts](../../../apps/desktop/src/main/workbench/run-source-repository.ts)             | `TreeSchema` L21；`BaselineSchema` L25；`nullFile` L26；`gitConfig` L27；另17项见JSON                                                                                                                                                                   | P0.D     | E12 / E01 | indexed；未逐文件重审 |
| [A apps/desktop/src/main/workbench/sha-main-fixture.ts](../../../apps/desktop/src/main/workbench/sha-main-fixture.ts)                       | `state` L6；`setup` L24；`command` L76；`capture` L84                                                                                                                                                                                                   | P0.D     | E12 / E01 | indexed；未逐文件重审 |
| [A apps/desktop/src/renderer/src/components/PatchView.test.ts](../../../apps/desktop/src/renderer/src/components/PatchView.test.ts)         | `it: renders at most 500 patch lines even when the bounded evidence contains over 100000 short lines` L7；`it: preserves small and empty/demo patch rendering without pagination controls` L24                                                          | P0.D     | E12 / E01 | indexed；未逐文件重审 |
| [A apps/desktop/src/renderer/src/components/PatchView.tsx](../../../apps/desktop/src/renderer/src/components/PatchView.tsx)                 | `PatchFile` L4；`diffLineClass` L6；`PagedPatch` L14；`PatchView` L59                                                                                                                                                                                   | P0.D     | E12 / E01 | indexed；未逐文件重审 |
| [M apps/desktop/src/renderer/src/workbench/RunViews.tsx](../../../apps/desktop/src/renderer/src/workbench/RunViews.tsx)                     | `DiffView` L44                                                                                                                                                                                                                                          | P0.D     | E12 / E01 | indexed；未逐文件重审 |
| [A apps/service/src/app-source-snapshot_test.py](../../../apps/service/src/app-source-snapshot_test.py)                                     | `SourceSnapshotTests` L16；`setUp` L17；`write` L34；`snapshot` L40；另28项见JSON                                                                                                                                                                       | P0.D     | E12 / E01 | indexed；未逐文件重审 |
| [A apps/service/src/p0-preflight.live.test.ts](../../../apps/service/src/p0-preflight.live.test.ts)                                         | `live` L4；`describe.skipIf(!live): P0 guest preflight without a model` L6；`it: uses the product bash PTY with OSC command integration and confirms cleanup` L7                                                                                        | P0.D     | E12 / E01 | indexed；未逐文件重审 |
| [A apps/service/src/source-python-isolation.test.ts](../../../apps/service/src/source-python-isolation.test.ts)                             | `it.each(['cwd', 'pythonpath', 'user-site']): isolates controller and source helper imports from synthetic %s modules` L10                                                                                                                              | P0.D     | E12 / E01 | indexed；未逐文件重审 |
| [A apps/service/src/source-snapshot.live.test.ts](../../../apps/service/src/source-snapshot.live.test.ts)                                   | `mutateOwnedFixture` L13；`it.skipIf(process.env['WSL_SOURCE_SNAPSHOT_LIVE'] !== '1'): live: stopped/running source helpers preserve the owned standard App and produce a host-only diff without a model` L31；`record` L62；`capture` L66；另1项见JSON | P0.D     | E12 / E01 | indexed；未逐文件重审 |
| [A apps/service/src/source-snapshot.test.ts](../../../apps/service/src/source-snapshot.test.ts)                                             | `deferred` L11；`resolve` L18；`temporary` L24；`target` L28；另15项见JSON                                                                                                                                                                              | P0.D     | E12 / E01 | indexed；未逐文件重审 |
| [A apps/service/src/source-snapshot.ts](../../../apps/service/src/source-snapshot.ts)                                                       | `SourceSnapshotReader` L11；`SourceSnapshotReader.accept` L19；`SourceSnapshotReader.result` L53                                                                                                                                                        | P0.D     | E12 / E01 | indexed；未逐文件重审 |
| [A packages/protocol/src/source-change.test.ts](../../../packages/protocol/src/source-change.test.ts)                                       | `target` L14；`file` L15；`describe: source evidence protocol` L17；`it: accepts empty snapshots and the 20000-file bound, independently from App export` L18；另10项见JSON                                                                             | P0.D     | E12 / E01 | indexed；未逐文件重审 |
| [A packages/protocol/src/source-change.ts](../../../packages/protocol/src/source-change.ts)                                                 | `SOURCE_MAX_BYTES` L4；`SOURCE_MAX_FILES` L5；`SOURCE_MAX_DIRECTORIES` L6；`SOURCE_CHUNK_BYTES` L7；另25项见JSON                                                                                                                                        | P0.D     | E12 / E01 | indexed；未逐文件重审 |

## 标准/edu源码导出与预算边界

| 文件                                                                                                                      | 固定head定位入口（节选）                                                                                 | 计划出口 | 证据      | 本轮审查状态          |
| ------------------------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------- | -------- | --------- | --------------------- |
| [A apps/desktop/src/main/workbench/source-export.test.ts](../../../apps/desktop/src/main/workbench/source-export.test.ts) | `hash` L9；`target` L10；`source` L11；`describe: Main-owned source export publication` L28；另3项见JSON | R5       | E01 / E11 | indexed；未逐文件重审 |
| [A apps/desktop/src/main/workbench/source-export.ts](../../../apps/desktop/src/main/workbench/source-export.ts)           | `hash` L14；`exportAppSource` L15；`protectedFiles` L53                                                  | R5       | E01 / E11 | indexed；未逐文件重审 |

## runPatch窄IPC桥接

| 文件                                                                              | 固定head定位入口（节选） | 计划出口 | 证据 | 本轮审查状态          |
| --------------------------------------------------------------------------------- | ------------------------ | -------- | ---- | --------------------- |
| [M apps/desktop/src/preload/index.ts](../../../apps/desktop/src/preload/index.ts) | `studio` L21             | P0.D     | E12  | indexed；未逐文件重审 |

## 验证锁定时阻止发送的呈现

| 文件                                                                                                            | 固定head定位入口（节选） | 计划出口                   | 证据 | 本轮审查状态          |
| --------------------------------------------------------------------------------------------------------------- | ------------------------ | -------------------------- | ---- | --------------------- |
| [M apps/desktop/src/renderer/src/shell/Composer.tsx](../../../apps/desktop/src/renderer/src/shell/Composer.tsx) | `Composer` L27           | candidate.edu-verification | E15  | indexed；未逐文件重审 |

## verification维护锁与命令错误处理

| 文件                                                                                                            | 固定head定位入口（节选）                                              | 计划出口                                         | 证据      | 本轮审查状态          |
| --------------------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------- | ------------------------------------------------ | --------- | --------------------- |
| [M apps/desktop/src/renderer/src/state/workspace.ts](../../../apps/desktop/src/renderer/src/state/workspace.ts) | `verificationLocked` L31；`runtimeCommands` L47；`executeCommand` L73 | candidate.edu-verification / candidate.import-ui | E15 / E13 | indexed；未逐文件重审 |

## 导入面板/源码diff/研究来源样式

| 文件                                                                                                    | 固定head定位入口（节选）                                                                                                         | 计划出口                         | 证据            | 本轮审查状态          |
| ------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------- | -------------------------------- | --------------- | --------------------- |
| [M apps/desktop/src/renderer/src/styles/app.css](../../../apps/desktop/src/renderer/src/styles/app.css) | `.app-import-panel ` L2430；`.app-import-panel h3 ` L2438；`.app-import-stage ` L2442；`.app-import-summary ` L2445；另7项见JSON | candidate.import-ui / P0.D / S5b | E13 / E12 / E01 | indexed；未逐文件重审 |

## App名称/说明元数据弹窗在创建时检查verification维护锁

| 文件                                                                                                                      | 固定head定位入口（节选）    | 计划出口                   | 证据 | 本轮审查状态          |
| ------------------------------------------------------------------------------------------------------------------------- | --------------------------- | -------------------------- | ---- | --------------------- |
| [M apps/desktop/src/renderer/src/workspace/AppEditor.tsx](../../../apps/desktop/src/renderer/src/workspace/AppEditor.tsx) | `AppEditor` L11；`save` L45 | candidate.edu-verification | E15  | indexed；未逐文件重审 |

## 导入/App管理交互与错误呈现

| 文件                                                                                                                                    | 固定head定位入口（节选）                                                                      | 计划出口                                  | 证据      | 本轮审查状态          |
| --------------------------------------------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------- | ----------------------------------------- | --------- | --------------------- |
| [A apps/desktop/src/renderer/src/workspace/AppImportPanel.tsx](../../../apps/desktop/src/renderer/src/workspace/AppImportPanel.tsx)     | `ImportView` L3；`CommandPayload` L4；`AppImportAction` L5；`appImportActive` L9；另2项见JSON | candidate.import-ui / candidate.lifecycle | E13 / E01 | indexed；未逐文件重审 |
| [M apps/desktop/src/renderer/src/workspace/ManagedAppDialog.tsx](../../../apps/desktop/src/renderer/src/workspace/ManagedAppDialog.tsx) | `ManagedAppDialog` L41；`close` L93；`act` L100；`currentDialog` L117；另2项见JSON            | candidate.import-ui / candidate.lifecycle | E13 / E01 | indexed；未逐文件重审 |

## 源码差异/研究来源/验证状态展示

| 文件                                                                                                                        | 固定head定位入口（节选）                                 | 计划出口                                | 证据            | 本轮审查状态          |
| --------------------------------------------------------------------------------------------------------------------------- | -------------------------------------------------------- | --------------------------------------- | --------------- | --------------------- |
| [M apps/desktop/src/renderer/src/workspace/RunDetails.tsx](../../../apps/desktop/src/renderer/src/workspace/RunDetails.tsx) | `CapturedRunPatch` L46；`RunDiff` L83；`RunDetails` L108 | P0.D / S5b / candidate.edu-verification | E12 / E01 / E15 | indexed；未逐文件重审 |

## 任务源码与研究同意/Mota授权/edu验证展示

| 文件                                                                                                                  | 固定head定位入口（节选）                                                                         | 计划出口                                     | 证据                  | 本轮审查状态          |
| --------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------ | -------------------------------------------- | --------------------- | --------------------- |
| [M apps/desktop/src/renderer/src/workspace/Session.tsx](../../../apps/desktop/src/renderer/src/workspace/Session.tsx) | `Session` L176；`resetResearchConsent` L183；`taskScopes` L202；`saveCriteria` L216；另5项见JSON | P0.D / S5b / R4 / candidate.edu-verification | E12 / E01 / E03 / E15 | indexed；未逐文件重审 |

## verification期间终端准入显示

| 文件                                                                                                                    | 固定head定位入口（节选） | 计划出口                   | 证据 | 本轮审查状态          |
| ----------------------------------------------------------------------------------------------------------------------- | ------------------------ | -------------------------- | ---- | --------------------- |
| [M apps/desktop/src/renderer/src/workspace/Terminal.tsx](../../../apps/desktop/src/renderer/src/workspace/Terminal.tsx) | `Terminal` L13           | candidate.edu-verification | E15  | indexed；未逐文件重审 |

## 源码diff/edu清理状态事实回归

| 文件                                                                                                    | 固定head定位入口（节选）                                                                                                                                                                                                                                                                                                                      | 计划出口                  | 证据      | 本轮审查状态          |
| ------------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------- | --------- | --------------------- |
| [M apps/desktop/src/shared/status/facts.test.ts](../../../apps/desktop/src/shared/status/facts.test.ts) | `describe: projectFacts: 运行` L662；`it: 源码证据状态不把差异当成检查通过或用户接受，raw 不含路径和内容` L665；`it: reports unresolved source cleanup independently and does not confuse an active ending collector with executor cleanup` L700；`it: keeps edu and source helper cleanup as independent unresolved facts` L724；另1项见JSON | P0.D / candidate.edu-task | E12 / E15 | indexed；未逐文件重审 |

## 源码diff/edu清理状态事实投影

| 文件                                                                                          | 固定head定位入口（节选）                                        | 计划出口                  | 证据      | 本轮审查状态          |
| --------------------------------------------------------------------------------------------- | --------------------------------------------------------------- | ------------------------- | --------- | --------------------- |
| [M apps/desktop/src/shared/status/facts.ts](../../../apps/desktop/src/shared/status/facts.ts) | `sourceChangeStatus` L638；`runFacts` L660；`projectFacts` L906 | P0.D / candidate.edu-task | E12 / E15 | indexed；未逐文件重审 |

## sourceChangeStatus公开导出

| 文件                                                                                          | 固定head定位入口（节选）           | 计划出口 | 证据 | 本轮审查状态          |
| --------------------------------------------------------------------------------------------- | ---------------------------------- | -------- | ---- | --------------------- |
| [M apps/desktop/src/shared/status/index.ts](../../../apps/desktop/src/shared/status/index.ts) | `index.ts module/configuration` L1 | P0.D     | E12  | indexed；未逐文件重审 |

## App控制/受管生命周期/保存错误处理

| 文件                                                                                            | 固定head定位入口（节选）                                                                                                                                                  | 计划出口                 | 证据      | 本轮审查状态          |
| ----------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------ | --------- | --------------------- |
| [M apps/service/src/app-control-mcp.test.ts](../../../apps/service/src/app-control-mcp.test.ts) | `mcpCases` L6；`it.each(mcpCases): guest MCP / CLI transport: %s` L24；`it: Mota native MCP 参数边界与 Main 权威 schema 一致，不接受模型指定身份、路径或任意状态写入` L50 | candidate.lifecycle / R4 | E01 / E03 | indexed；未逐文件重审 |

## 导入/源码快照/受管导出与profile启动helper

| 文件                                                                        | 固定head定位入口（节选）                                                                | 计划出口                     | 证据            | 本轮审查状态          |
| --------------------------------------------------------------------------- | --------------------------------------------------------------------------------------- | ---------------------------- | --------------- | --------------------- |
| [M apps/service/src/app-helper.py](../../../apps/service/src/app-helper.py) | `edu_excluded` L47；`edu_path` L51；`edu_metadata` L63；`edu_profile` L86；另30项见JSON | P0.D / R5 / candidate.import | E01 / E12 / E11 | indexed；未逐文件重审 |

## App完成链R3分组与原候选edu/导入/实例回归

| 文件                                                                                    | 固定head定位入口（节选）                                                | 计划出口                                   | 证据            | 本轮审查状态          |
| --------------------------------------------------------------------------------------- | ----------------------------------------------------------------------- | ------------------------------------------ | --------------- | --------------------- |
| [M apps/service/src/app-service.test.ts](../../../apps/service/src/app-service.test.ts) | `key` L18；`eduFiles` L20；`eduSource` L23；`fixture` L36；另60项见JSON | R3 / candidate.import / candidate.edu-task | E01 / E11 / E15 | indexed；未逐文件重审 |

## 受管导入/edu任务/Mota/快照与R3异步完成链；R3只对应完成链区域

| 文件                                                                          | 固定head定位入口（节选）                                                             | 计划出口                                                           | 证据                  | 本轮审查状态          |
| ----------------------------------------------------------------------------- | ------------------------------------------------------------------------------------ | ------------------------------------------------------------------ | --------------------- | --------------------- |
| [M apps/service/src/app-service.ts](../../../apps/service/src/app-service.ts) | `helper` L55；`AppSnapshot` L69；`Entry` L88；`AppServiceOptions` L116；另54项见JSON | R3 / P0.D / candidate.import / candidate.edu-task / candidate.mota | E01 / E02 / E11 / E12 | indexed；未逐文件重审 |

## Linux清理/身份透传与必跑报告回归

| 文件                                                                                                  | 固定head定位入口（节选）                                                                                                                                     | 计划出口 | 证据 | 本轮审查状态          |
| ----------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------ | -------- | ---- | --------------------- |
| [M apps/service/src/app_cli_transport_tests.py](../../../apps/service/src/app_cli_transport_tests.py) | `cleanup` L231                                                                                                                                               | R1       | E04  | indexed；未逐文件重审 |
| [M apps/service/src/guest-workspace.test.ts](../../../apps/service/src/guest-workspace.test.ts)       | `cleanupFailureStimulus` L48；`cleanupSignatureCheck` L54；`startProbe` L63；`describe: guest cleanup stimulus (portable Python boundary)` L97；另17项见JSON | R1       | E04  | indexed；未逐文件重审 |

## Mota违规/能力/MCP限制与研究会话传输

| 文件                                                                                                | 固定head定位入口（节选）                                                                                                                                                                                                                                                                                                | 计划出口 | 证据            | 本轮审查状态          |
| --------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | -------- | --------------- | --------------------- |
| [M apps/service/src/codex-chat.test.ts](../../../apps/service/src/codex-chat.test.ts)               | `describe: 真实子进程生命周期（fixture）` L48；`it: ordinary chat does not enable strict edu candidate snapshots` L103；`describe: edu candidate round trip (offline transport fixture)` L131；`it.each(['complete', 'cancel', 'retain-failure']): retains candidate before terminal publication: %s` L132；另3项见JSON | R4 / S5b | E03 / E01 / E11 | indexed；未逐文件重审 |
| [M apps/service/src/codex-chat.ts](../../../apps/service/src/codex-chat.ts)                         | `EventSchema` L39；`parseCodexLine` L65；`boundedMcpOutput` L71；`Turn` L263；另14项见JSON                                                                                                                                                                                                                              | R4 / S5b | E03 / E01 / E11 | indexed；未逐文件重审 |
| [A apps/service/src/codex-mota-policy.test.ts](../../../apps/service/src/codex-mota-policy.test.ts) | `session` L9；`otherSession` L10；`workspaceId` L11；`success` L12；另33项见JSON                                                                                                                                                                                                                                        | R4 / S5b | E03 / E01 / E11 | indexed；未逐文件重审 |
| [M apps/service/src/resource_mcp.py](../../../apps/service/src/resource_mcp.py)                     | `load_sealed` L181；`validate_research_args` L227；`app_tool` L274；`mota_tool` L333；另5项见JSON                                                                                                                                                                                                                       | R4 / S5b | E03 / E01 / E11 | indexed；未逐文件重审 |
| [M apps/service/src/resource_mcp_tests.py](../../../apps/service/src/resource_mcp_tests.py)         | `MotaResourceMcpTests` L196；`setUp` L197；`tearDown` L201；`test_mota_lists_exactly_four_tools_with_own_rules` L204；另13项见JSON                                                                                                                                                                                      | R4 / S5b | E03 / E01 / E11 | indexed；未逐文件重审 |
| [M apps/service/src/sbx.ts](../../../apps/service/src/sbx.ts)                                       | `guestHelper` L21；`GuestStart` L54；`GuestProcess` L101；`GuestProcess.constructor` L113；另5项见JSON                                                                                                                                                                                                                  | R4 / S5b | E03 / E01 / E11 | indexed；未逐文件重审 |

## edu源码准备/候选应用/取消/所属进程回执

| 文件                                                                                                    | 固定head定位入口（节选）                                                                                                                                                                                          | 计划出口                  | 证据            | 本轮审查状态          |
| ------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------- | --------------- | --------------------- |
| [A apps/service/src/edu-owned-process.py](../../../apps/service/src/edu-owned-process.py)               | `process_identity` L12；`same_process` L20；`receipt_path` L25；`atomic` L35；另10项见JSON                                                                                                                        | candidate.edu-task / P0.D | E15 / E12 / E01 | indexed；未逐文件重审 |
| [A apps/service/src/edu-owned-process.test.ts](../../../apps/service/src/edu-owned-process.test.ts)     | `it: guest receipts bind exact PID/startTicks, refuse missing owners and keep the revoke request narrow` L4；`it: boot replacement durably proves old owners ended without touching same-number current PIDs` L44 | candidate.edu-task / P0.D | E15 / E12 / E01 | indexed；未逐文件重审 |
| [A apps/service/src/edu-task-operations.test.ts](../../../apps/service/src/edu-task-operations.test.ts) | `deferred` L7；`resolve` L16；`reject` L20；`binding` L27；另20项见JSON                                                                                                                                           | candidate.edu-task / P0.D | E15 / E12 / E01 | indexed；未逐文件重审 |
| [A apps/service/src/edu-task-operations.ts](../../../apps/service/src/edu-task-operations.ts)           | `Child` L4；`Helper` L5；`EduTaskOperationOwner` L11；`EduTaskOperations` L20；另12项见JSON                                                                                                                       | candidate.edu-task / P0.D | E15 / E12 / E01 | indexed；未逐文件重审 |
| [A apps/service/src/edu-task.test.ts](../../../apps/service/src/edu-task.test.ts)                       | `files` L5；`metadata` L9；`binding` L10；`describe: edu task source gate` L23；另2项见JSON                                                                                                                       | candidate.edu-task / P0.D | E15 / E12 / E01 | indexed；未逐文件重审 |
| [A apps/service/src/edu-task.ts](../../../apps/service/src/edu-task.ts)                                 | `eduTaskMetadata` L8；`assertEduTaskSource` L17；`assertEduTaskCandidate` L24；`EduTaskCandidates` L30；另3项见JSON                                                                                               | candidate.edu-task / P0.D | E15 / E12 / E01 | indexed；未逐文件重审 |
| [A packages/protocol/src/edu-task.test.ts](../../../packages/protocol/src/edu-task.test.ts)             | `binding` L6；`app` L19；`oldRun` L30；`describe: edu task cleanup contracts with source evidence` L45；另7项见JSON                                                                                               | candidate.edu-task / P0.D | E15 / E12 / E01 | indexed；未逐文件重审 |
| [A packages/protocol/src/edu-task.ts](../../../packages/protocol/src/edu-task.ts)                       | `EduTaskBindingSchema` L6；`EduTaskBinding` L21；`EduTaskOperationSchema` L23；`EduTaskOperationResultSchema` L24；另4项见JSON                                                                                    | candidate.edu-task / P0.D | E15 / E12 / E01 | indexed；未逐文件重审 |

## verification准入前drainTerminals

| 文件                                                                                              | 固定head定位入口（节选）                                               | 计划出口                   | 证据 | 本轮审查状态          |
| ------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------- | -------------------------- | ---- | --------------------- |
| [M apps/service/src/environment-resources.ts](../../../apps/service/src/environment-resources.ts) | `EnvironmentResources` L41；`EnvironmentResources.drainTerminals` L347 | candidate.edu-verification | E15  | indexed；未逐文件重审 |

## leader_identity清理、edu候选快照、研究调用者身份、Mota只读模式与duplex传输

| 文件                                                                            | 固定head定位入口（节选）                                                                           | 计划出口                                  | 证据            | 本轮审查状态          |
| ------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------- | ----------------------------------------- | --------------- | --------------------- |
| [M apps/service/src/guest-helper.py](../../../apps/service/src/guest-helper.py) | `snapshot_workspace` L87；`walk` L95；`owned_members` L154；`ownership_identity` L193；另8项见JSON | R1 / P0.D / S5b / R4 / candidate.edu-task | E04 / E01 / E03 | indexed；未逐文件重审 |

## 入口准入/13路由合同及Mota门禁回归

| 文件                                                                        | 固定head定位入口（节选）                                                    | 计划出口                                | 证据            | 本轮审查状态          |
| --------------------------------------------------------------------------- | --------------------------------------------------------------------------- | --------------------------------------- | --------------- | --------------------- |
| [M apps/service/src/index.test.ts](../../../apps/service/src/index.test.ts) | `fixture` L20；`terminal` L81；`roots` L92；`completions` L93；另58项见JSON | S7.P3 / R4 / candidate.edu-verification | E08 / E11 / E15 | indexed；未逐文件重审 |

## 统一准入/verification与Mota启动门禁；13路由装配

| 文件                                                              | 固定head定位入口（节选）                                                                  | 计划出口                                | 证据            | 本轮审查状态          |
| ----------------------------------------------------------------- | ----------------------------------------------------------------------------------------- | --------------------------------------- | --------------- | --------------------- |
| [M apps/service/src/index.ts](../../../apps/service/src/index.ts) | `eduCandidates` L39；`researchCalls` L100；`abort` L113；`sourceCalls` L132；另14项见JSON | S7.P3 / R4 / candidate.edu-verification | E08 / E11 / E15 | indexed；未逐文件重审 |

## edu verification维护准入门

| 文件                                                                                    | 固定head定位入口（节选）                                                                                                        | 计划出口                   | 证据 | 本轮审查状态          |
| --------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------- | -------------------------- | ---- | --------------------- |
| [A apps/service/src/maintenance-gate.ts](../../../apps/service/src/maintenance-gate.ts) | `MaintenanceGate` L2；`MaintenanceGate.acquire` L6；`MaintenanceGate.release` L11；`MaintenanceGate.admission` L14；另4项见JSON | candidate.edu-verification | E15  | indexed；未逐文件重审 |

## Mota传输/受管实例生命周期

| 文件                                                                                              | 固定head定位入口（节选）                                                                                    | 计划出口       | 证据      | 本轮审查状态          |
| ------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------- | -------------- | --------- | --------------------- |
| [A apps/service/src/mota-app-service.test.ts](../../../apps/service/src/mota-app-service.test.ts) | `roots` L10；`digest` L14；`request` L15；`key` L36；另16项见JSON                                           | candidate.mota | E02 / E03 | indexed；未逐文件重审 |
| [A apps/service/src/mota-transfer.test.ts](../../../apps/service/src/mota-transfer.test.ts)       | `hash` L14；`clean` L15；`request` L16；`deferred` L33；另23项见JSON                                        | candidate.mota | E02 / E03 | indexed；未逐文件重审 |
| [A apps/service/src/mota-transfer.ts](../../../apps/service/src/mota-transfer.ts)                 | `MOTA_TRANSFER_PREFIX` L6；`MOTA_TRANSFER_CHUNK_BYTES` L7；`INPUT_LIMIT` L8；`START_LIMIT` L9；另41项见JSON | candidate.mota | E02 / E03 | indexed；未逐文件重审 |

## Mota受限静态服务/导入保护/两文件保存（R6目标关联）

| 文件                                                                                    | 固定head定位入口（节选）                                                                | 计划出口                   | 证据      | 本轮审查状态          |
| --------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------- | -------------------------- | --------- | --------------------- |
| [A apps/service/src/mota-helper.py](../../../apps/service/src/mota-helper.py)           | `_integer` L37；`_hash` L41；`_uuid` L45；`_path` L52；另25项见JSON                     | candidate.mota / R6.target | E02 / E11 | indexed；未逐文件重审 |
| [A apps/service/src/mota-helper_test.py](../../../apps/service/src/mota-helper_test.py) | `load_helper` L16；`digest` L32；`json_bytes` L36；`source_profile` L40；另44项见JSON   | candidate.mota / R6.target | E02 / E11 | indexed；未逐文件重审 |
| [A apps/service/src/mota-server.cjs](../../../apps/service/src/mota-server.cjs)         | `http` L7；`fs` L8；`{ constants }` L9；`path` L10；另67项见JSON                        | candidate.mota / R6.target | E02 / E11 | indexed；未逐文件重审 |
| [A apps/service/src/mota-server.test.ts](../../../apps/service/src/mota-server.test.ts) | `serverFile` L22；`floorName` L23；`originalFloor` L24；`editedFloor` L25；另56项见JSON | candidate.mota / R6.target | E02 / E11 | indexed；未逐文件重审 |

## nativeMota工具回执与预算回归

| 文件                                                                                        | 固定head定位入口（节选）                                                                                           | 计划出口 | 证据 | 本轮审查状态          |
| ------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------ | -------- | ---- | --------------------- |
| [M apps/service/src/resource-chat.test.ts](../../../apps/service/src/resource-chat.test.ts) | `motaState` L53；`motaMcp` L87；`recordMcp` L100；`describe: native Mota MCP duplicate evidence` L109；另6项见JSON | R4       | E03  | indexed；未逐文件重审 |

## 13路由内部处理表（不含保留的R4分支）

| 文件                                                                                        | 固定head定位入口（节选）                                                                | 计划出口 | 证据 | 本轮审查状态          |
| ------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------- | -------- | ---- | --------------------- |
| [A apps/service/src/routes/environment.ts](../../../apps/service/src/routes/environment.ts) | `environmentRoutes` L3                                                                  | S7.P3    | E08  | indexed；未逐文件重审 |
| [A apps/service/src/routes/index.ts](../../../apps/service/src/routes/index.ts)             | `DuplicateMethods` L9；`routes` L13；`handlers` L19；`isRoutedRequest` L21；另1项见JSON | S7.P3    | E08  | indexed；未逐文件重审 |
| [A apps/service/src/routes/observation.ts](../../../apps/service/src/routes/observation.ts) | `observationRoutes` L3                                                                  | S7.P3    | E08  | indexed；未逐文件重审 |
| [A apps/service/src/routes/replies.ts](../../../apps/service/src/routes/replies.ts)         | `replyRoutes` L3                                                                        | S7.P3    | E08  | indexed；未逐文件重审 |
| [A apps/service/src/routes/terminal.ts](../../../apps/service/src/routes/terminal.ts)       | `terminalRoutes` L3                                                                     | S7.P3    | E08  | indexed；未逐文件重审 |
| [A apps/service/src/routes/types.ts](../../../apps/service/src/routes/types.ts)             | `RoutedMethod` L5；`Requests` L20；`RoutedRequest` L21；`PendingReply` L22；另4项见JSON | S7.P3    | E08  | indexed；未逐文件重审 |

## assertMotaCapability固定版本拒启回归

| 文件                                                                    | 固定head定位入口（节选）                                                                                                                                                                                 | 计划出口 | 证据 | 本轮审查状态          |
| ----------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | -------- | ---- | --------------------- |
| [M apps/service/src/sbx.test.ts](../../../apps/service/src/sbx.test.ts) | `describe: R4 Mota native capability admission` L16；`it.each([null, 'codex-cli 0.160.0', 'codex-cli 0.159.0', 'codex-cli 0.161.0']): rejects unverified native restrictions for %s before dispatch` L17 | R4       | E11  | indexed；未逐文件重审 |

## verification/所属进程shutdown回归

| 文件                                                                              | 固定head定位入口（节选）                                                                                                                                                                                                                                                                              | 计划出口                                         | 证据      | 本轮审查状态          |
| --------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------ | --------- | --------------------- |
| [M apps/service/src/shutdown.test.ts](../../../apps/service/src/shutdown.test.ts) | `it: retains nested aggregate and cause diagnostics in the RPC message and preserves original failures` L36；`it: bounds cyclic error references without hiding the other cleanup diagnostics` L75；`it: continues rejecting failed cleanup and permits a fresh retry once the owner is repaired` L93 | candidate.edu-verification / candidate.lifecycle | E01 / E15 | indexed；未逐文件重审 |

## verification回收与service所属进程关闭

| 文件                                                                    | 固定head定位入口（节选）                               | 计划出口                                         | 证据      | 本轮审查状态          |
| ----------------------------------------------------------------------- | ------------------------------------------------------ | ------------------------------------------------ | --------- | --------------------- |
| [M apps/service/src/shutdown.ts](../../../apps/service/src/shutdown.ts) | `shutdownErrorMessage` L2；`shutdownServiceOwners` L14 | candidate.edu-verification / candidate.lifecycle | E01 / E15 | indexed；未逐文件重审 |

## 历史演示/参赛材料与整合记录

| 文件                                                                                                            | 固定head定位入口（节选）                                                                                                                               | 计划出口        | 证据 | 本轮审查状态          |
| --------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------ | --------------- | ---- | --------------------- |
| [M demo/README.md](../../../demo/README.md)                                                                     | `内置静态演示页面` L1                                                                                                                                  | history.context | E01  | indexed；未逐文件重审 |
| [M docs/acceptance/consolidation-20261011/PR.md](../../../docs/acceptance/consolidation-20261011/PR.md)         | `feat: 整合受管 App、统一状态与 Code Wiki` L1                                                                                                          | history.context | E01  | indexed；未逐文件重审 |
| [M docs/acceptance/consolidation-20261011/README.md](../../../docs/acceptance/consolidation-20261011/README.md) | `全分支与未提交内容整合（2026-10-11）` L1                                                                                                              | history.context | E01  | indexed；未逐文件重审 |
| [M docs/submission/README.md](../../../docs/submission/README.md)                                               | `参赛材料 · 2026-10-16 本地审阅稿` L1；`交付链接登记` L9；`编辑与导出` L23；`后续更新原则` L29；另1项见JSON                                            | history.context | E01  | indexed；未逐文件重审 |
| [A docs/submission/demo-guide.md](../../../docs/submission/demo-guide.md)                                       | `演示与复现说明` L1；`先准备环境与版本` L5；`场景一：已有魔塔工程` L21；`场景二：从模板生成手帐` L32；另3项见JSON                                      | history.context | E01  | indexed；未逐文件重审 |
| [M docs/submission/oschina-2026-evidence.md](../../../docs/submission/oschina-2026-evidence.md)                 | `参赛证据索引 · 2026-10-16` L1；`E01` L5；`E02` L9；`E03` L18；另6项见JSON                                                                             | history.context | E01  | indexed；未逐文件重审 |
| [M docs/submission/oschina-2026.md](../../../docs/submission/oschina-2026.md)                                   | `2026 上海开源软件应用创新大赛作品介绍` L3；`从已有游戏到可核对的修改` L9；`从标准模板生成可保存的手帐` L17；`工程上怎样组织这条路径` L29；另2项见JSON | history.context | E01  | indexed；未逐文件重审 |

## 相应历史验收或合同入口（非通过声明）

| 文件                                                                                                      | 固定head定位入口（节选）                                                                                   | 计划出口        | 证据 | 本轮审查状态          |
| --------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------- | --------------- | ---- | --------------------- |
| [M docs/acceptance/README.md](../../../docs/acceptance/README.md)                                         | `首个 vertical slice 验收基线` L1                                                                          | history.context | E01  | indexed；未逐文件重审 |
| [A docs/acceptance/submission-20261016/README.md](../../../docs/acceptance/submission-20261016/README.md) | `参赛交付 PR 整合 · 2026-10-16` L1；`候选与纳入范围` L5；`本次回归` L16；`演示与证据边界` L55；另1项见JSON | history.context | E01  | indexed；未逐文件重审 |

## 冻结历史closeout保全

| 文件                                                                                                                                  | 固定head定位入口（节选）                                                                                                               | 计划出口   | 证据      | 本轮审查状态          |
| ------------------------------------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------- | ---------- | --------- | --------------------- |
| [A docs/acceptance/consolidation-20261011/closeout-20261014.md](../../../docs/acceptance/consolidation-20261011/closeout-20261014.md) | `工作树保全、main 同步与合并收尾（2026-10-14）` L1；`合并与检查范围` L5；`持久本地保全入口` L21；`主工作树与独立分支` L38；另2项见JSON | R2.context | E01 / E11 | indexed；未逐文件重审 |

## edu导入UI历史验收

| 文件                                                                                                                                      | 固定head定位入口（节选）                                                                                  | 计划出口            | 证据 | 本轮审查状态          |
| ----------------------------------------------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------- | ------------------- | ---- | --------------------- |
| [A docs/acceptance/import-entry-20261014/README.md](../../../docs/acceptance/import-entry-20261014/README.md)                             | `edu 导入入口：本地交付与验收` L1；`源码与证据边界` L5；`用户可观察结果` L13；`验收矩阵` L19；另2项见JSON | candidate.import-ui | E13  | indexed；未逐文件重审 |
| [A docs/acceptance/import-entry-20261014/validation-summary.json](../../../docs/acceptance/import-entry-20261014/validation-summary.json) | `validation-summary.json module/configuration` L1                                                         | candidate.import-ui | E13  | indexed；未逐文件重审 |

## Mota历史集成或opt-in路线验收

| 文件                                                                                                                                                  | 固定head定位入口（节选）                                                                                             | 计划出口       | 证据      | 本轮审查状态          |
| ----------------------------------------------------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------- | -------------- | --------- | --------------------- |
| [A docs/acceptance/mota-ai-20261015/README.md](../../../docs/acceptance/mota-ai-20261015/README.md)                                                   | `2026-10-15 魔塔受限 AI 操作验收` L1；`能力与授权范围` L7；`固定路线与预期` L22；`分阶段执行与证据` L41；另9项见JSON | candidate.mota | E02 / E03 | indexed；未逐文件重审 |
| [A docs/acceptance/mota-integration-20261015/README.md](../../../docs/acceptance/mota-integration-20261015/README.md)                                 | `2026-10-15 隔离整合、onApp 修复与魔塔接入` L1；`来源和修改范围` L5；`魔塔行为` L12；`真实窗口验收` L20；另2项见JSON | candidate.mota | E02 / E03 | indexed；未逐文件重审 |
| [A docs/acceptance/mota-integration-20261015/verification-summary.json](../../../docs/acceptance/mota-integration-20261015/verification-summary.json) | `verification-summary.json module/configuration` L1                                                                  | candidate.mota | E02 / E03 | indexed；未逐文件重审 |

## 实际运行时能力与未实现边界

| 文件                                                                                    | 固定head定位入口（节选）                                                                                                | 计划出口           | 证据            | 本轮审查状态          |
| --------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------- | ------------------ | --------------- | --------------------- |
| [M docs/architecture/current-runtime.md](../../../docs/architecture/current-runtime.md) | `当前运行时与目标架构的边界` L1；`2026-10-16 场景补充` L5；`已有能力和缺口` L13；`4.1 窗口与视图配置` L34；另10项见JSON | candidate.contract | E01 / E02 / E03 | indexed；未逐文件重审 |

## 任务源码差异P0.D计划

| 文件                                                                                    | 固定head定位入口（节选）                                                                                  | 计划出口 | 证据 | 本轮审查状态          |
| --------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------- | -------- | ---- | --------------------- |
| [A docs/plans/2026-10-15-p0-run-diff.md](../../../docs/plans/2026-10-15-p0-run-diff.md) | `P0 D：任务页真实 diff` L1；`已确认的设计调整` L5；`文件与契约` L21；`不变量与异常边界` L32；另12项见JSON | P0.D     | E12  | indexed；未逐文件重审 |

## R1–R6/S1–S7目标及合并出口

| 文件                                                                                                            | 固定head定位入口（节选）                                                                                                             | 计划出口         | 证据 | 本轮审查状态          |
| --------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------ | ---------------- | ---- | --------------------- |
| [A docs/plans/2026-10-16-post-review-update-plan.md](../../../docs/plans/2026-10-16-post-review-update-plan.md) | `评审后修改计划 · 修订版` L1；`一、范围与合并次序` L7；`二、合并前修复：R1–R6` L16；`R1 · Linux 清理回归与必跑检查` L20；另9项见JSON | first-stage-exit | E11  | indexed；未逐文件重审 |

## 第一轮三个模块化小包计划与后续方向

| 文件                                                                                                        | 固定head定位入口（节选）                                                                                                                          | 计划出口              | 证据            | 本轮审查状态          |
| ----------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------- | --------------------- | --------------- | --------------------- |
| [A docs/plans/2026-10-17-modular-refactor-plan.md](../../../docs/plans/2026-10-17-modular-refactor-plan.md) | `模块化轻量重构计划 · 第一轮（行为不变）` L1；`0. 起点与授权` L7；`1. 范围` L21；`2. 当前职责、依赖与写入者（与本轮相关的部分）` L34；另9项见JSON | S7.P1 / S7.P2 / S7.P3 | E06 / E07 / E08 | indexed；未逐文件重审 |

## 桌面白名单诊断/历史结论更正

| 文件                                                                                                              | 固定head定位入口（节选）                                                                                                                                                    | 计划出口       | 证据 | 本轮审查状态          |
| ----------------------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | -------------- | ---- | --------------------- |
| [A docs/plans/2026-10-18-review-audit-corrections.md](../../../docs/plans/2026-10-18-review-audit-corrections.md) | `2026-10-18 提交前审计更正` L1                                                                                                                                              | E2E.focus / N4 | E09  | indexed；未逐文件重审 |
| [A e2e/ioreg-state.test.ts](../../../e2e/ioreg-state.test.ts)                                                     | `assertValue` L4；`session` L12；`describe: ioreg diagnostic whitelist` L13；`it: separates root and inline session lock states without private suffixes` L14；另11项见JSON | E2E.focus / N4 | E09  | indexed；未逐文件重审 |
| [A e2e/ioreg-state.ts](../../../e2e/ioreg-state.ts)                                                               | `IoregLocks` L2；`Value` L9；`Dict` L10；`registry` L12；另8项见JSON                                                                                                        | E2E.focus / N4 | E09  | indexed；未逐文件重审 |

## A07原生焦点与桌面状态失败诊断（保留原断言）

| 文件                                                                          | 固定head定位入口（节选）                                                                                                                                                                        | 计划出口       | 证据 | 本轮审查状态          |
| ----------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | -------------- | ---- | --------------------- |
| [M e2e/app-control-harness.spec.ts](../../../e2e/app-control-harness.spec.ts) | `test: reference implementation: describe, snapshot→act, stale refs/leases/runs, schema errors, user takeover, cancel, replay, stale source` L170；`test.info().attach: a07-desktop-state` L408 | E2E.focus / N4 | E09  | indexed；未逐文件重审 |

## opt-in真实guest导入/双页/持久化/取消/正常导出

| 文件                                                            | 固定head定位入口（节选）                                                                                                                                                  | 计划出口                        | 证据      | 本轮审查状态          |
| --------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------- | --------- | --------------------- |
| [A e2e/edu-app-live.spec.ts](../../../e2e/edu-app-live.spec.ts) | `run` L10；`hash` L11；`test: real edu import, owned native pages, metadata and data persistence, cancellation and Workbench export` L13；`portMappings` L39；另9项见JSON | candidate.edu-live / R5.context | E01 / E13 | indexed；未逐文件重审 |

## 原生picker/静态预览/来源变化/取消与重试UI

| 文件                                                        | 固定head定位入口（节选）                                                       | 计划出口            | 证据 | 本轮审查状态          |
| ----------------------------------------------------------- | ------------------------------------------------------------------------------ | ------------------- | ---- | --------------------- |
| [A e2e/edu-app-ui.spec.ts](../../../e2e/edu-app-ui.spec.ts) | `owner` L19；`dialog` L24；`importButton` L25；`previewReady` L26；另4项见JSON | candidate.import-ui | E13  | indexed；未逐文件重审 |

## edu原生音频权限/音轨清理独立harness（无guest/model/backend）

| 文件                                                      | 固定head定位入口（节选）                                                                                                                                                                                       | 计划出口        | 证据 | 本轮审查状态          |
| --------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | --------------- | ---- | --------------------- |
| [A e2e/edu-audio.spec.ts](../../../e2e/edu-audio.spec.ts) | `PermissionCall` L10；`test: edu native audio permissions and actual track cleanup (explicit synthetic device or physical mode)` L27；`test.step: launch native audio harness` L85；`execute` L99；另3项见JSON | candidate.audio | E14  | indexed；未逐文件重审 |

## edu导入UI的来源变化/重试fixture

| 文件                                                              | 固定head定位入口（节选）                                                                  | 计划出口            | 证据 | 本轮审查状态          |
| ----------------------------------------------------------------- | ----------------------------------------------------------------------------------------- | ------------------- | ---- | --------------------- |
| [A e2e/edu-import-fixture.ts](../../../e2e/edu-import-fixture.ts) | `exec` L11；`createEduImportFixture` L14；`git` L36；`sourceTreeDigest` L56；另14项见JSON | candidate.import-ui | E13  | indexed；未逐文件重审 |

## edu opt-in guest数据库身份/文件hash/所属进程审计fixture

| 文件                                                                          | 固定head定位入口（节选）                     | 计划出口           | 证据      | 本轮审查状态          |
| ----------------------------------------------------------------------------- | -------------------------------------------- | ------------------ | --------- | --------------------- |
| [A e2e/fixtures/edu-guest-audit.py](../../../e2e/fixtures/edu-guest-audit.py) | `edu-guest-audit.py module/configuration` L1 | candidate.edu-live | E01 / E13 | indexed；未逐文件重审 |

## 替代Codex进程的无模型工具测试注入

| 文件                                                                                              | 固定head定位入口（节选）                          | 计划出口            | 证据 | 本轮审查状态          |
| ------------------------------------------------------------------------------------------------- | ------------------------------------------------- | ------------------- | ---- | --------------------- |
| [A e2e/fixtures/mota-model-turn-injection.ts](../../../e2e/fixtures/mota-model-turn-injection.ts) | `controlledTurn` L7；`motaModelTurnInjection` L56 | candidate.mota-live | E03  | indexed；未逐文件重审 |

## 测试桩workspace开始/结束帧回执

| 文件                                                    | 固定head定位入口（节选） | 计划出口           | 证据 | 本轮审查状态          |
| ------------------------------------------------------- | ------------------------ | ------------------ | ---- | --------------------- |
| [M e2e/fixtures/sbx.mjs](../../../e2e/fixtures/sbx.mjs) | `finish` L21             | P0.D / E2E.context | E12  | indexed；未逐文件重审 |

## P0.D source.snapshot派发/先落baseline/宿主路径不泄漏审计fixture

| 文件                                                                                      | 固定head定位入口（节选） | 计划出口 | 证据 | 本轮审查状态          |
| ----------------------------------------------------------------------------------------- | ------------------------ | -------- | ---- | --------------------- |
| [A e2e/fixtures/source-dispatch-audit.ts](../../../e2e/fixtures/source-dispatch-audit.ts) | `sourceDispatchAudit` L6 | P0.D     | E12  | indexed；未逐文件重审 |

## P0.D固定源码快照fixture

| 文件                                                                                          | 固定head定位入口（节选）   | 计划出口 | 证据 | 本轮审查状态          |
| --------------------------------------------------------------------------------------------- | -------------------------- | -------- | ---- | --------------------- |
| [A e2e/fixtures/source-snapshot-fixture.ts](../../../e2e/fixtures/source-snapshot-fixture.ts) | `sourceSnapshotFixture` L1 | P0.D     | E12  | indexed；未逐文件重审 |

## 显式模板依赖就绪预检（不安装）

| 文件                                                  | 固定head定位入口（节选） | 计划出口 | 证据      | 本轮审查状态          |
| ----------------------------------------------------- | ------------------------ | -------- | --------- | --------------------- |
| [A e2e/global-setup.ts](../../../e2e/global-setup.ts) | `globalSetup` L5         | R2       | E05 / E11 | indexed；未逐文件重审 |

## Mota/source fixtures/独立证据目录/原生焦点与桌面采样

| 文件                                        | 固定head定位入口（节选）                                                                               | 计划出口                            | 证据            | 本轮审查状态          |
| ------------------------------------------- | ------------------------------------------------------------------------------------------------------ | ----------------------------------- | --------------- | --------------------- |
| [M e2e/helpers.ts](../../../e2e/helpers.ts) | `screensDir` L27；`launchApp` L36；`NativeFocusSnapshot` L516；`nativeFocusSnapshot` L522；另4项见JSON | P0.D / E2E.context / candidate.mota | E12 / E09 / E03 | indexed；未逐文件重审 |

## Mota固定路线/检查点/有界清理辅助

| 文件                                                                        | 固定head定位入口（节选）                                                                        | 计划出口            | 证据 | 本轮审查状态          |
| --------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------- | ------------------- | ---- | --------------------- |
| [A e2e/mota-agent-live-helpers.ts](../../../e2e/mota-agent-live-helpers.ts) | `MotaRouteState` L10；`motaRouteState` L26；`MotaRouteDriver` L44；`Position` L51；另20项见JSON | candidate.mota-live | E03  | indexed；未逐文件重审 |

## Mota opt-in独占输入与guest运行审计

| 文件                                                                        | 固定head定位入口（节选）                                        | 计划出口            | 证据 | 本轮审查状态          |
| --------------------------------------------------------------------------- | --------------------------------------------------------------- | ------------------- | ---- | --------------------- |
| [A e2e/mota-agent-live-runtime.ts](../../../e2e/mota-agent-live-runtime.ts) | `exec` L11；`motaHash` L12；`Port` L13；`Port` L14；另9项见JSON | candidate.mota-live | E03  | indexed；未逐文件重审 |

## Mota tools/model二选一opt-in路线；不证明原生工具限制或OS隔离

| 文件                                                                  | 固定head定位入口（节选）                                                         | 计划出口            | 证据 | 本轮审查状态          |
| --------------------------------------------------------------------- | -------------------------------------------------------------------------------- | ------------------- | ---- | --------------------- |
| [A e2e/mota-agent-live.spec.ts](../../../e2e/mota-agent-live.spec.ts) | `workspaceId` L37；`Floor` L38；`parseFloor` L39；`ToolReceipt` L48；另5项见JSON | candidate.mota-live | E03  | indexed；未逐文件重审 |

## 历史HTTP正常人工保存/双页/owned stop-restart；缺R6安全负例

| 文件                                                              | 固定head定位入口（节选）                                                   | 计划出口                        | 证据 | 本轮审查状态          |
| ----------------------------------------------------------------- | -------------------------------------------------------------------------- | ------------------------------- | ---- | --------------------- |
| [A e2e/mota-app-live.spec.ts](../../../e2e/mota-app-live.spec.ts) | `exec` L12；`sha256` L13；`workspaceId` L14；`floorPath` L15；另24项见JSON | candidate.mota-live / R6.target | E02  | indexed；未逐文件重审 |

## opt-in模型源码diff/无模型恢复P0.D

| 文件                                                                                | 固定head定位入口（节选）                                                       | 计划出口 | 证据 | 本轮审查状态          |
| ----------------------------------------------------------------------------------- | ------------------------------------------------------------------------------ | -------- | ---- | --------------------- |
| [A e2e/p0-run-diff-model-live.spec.ts](../../../e2e/p0-run-diff-model-live.spec.ts) | `required` L19；`auditSchema` L23；`hashes` L43；`appSource` L47；另13项见JSON | P0.D     | E12  | indexed；未逐文件重审 |

## 真实宿主Git+替代guest/model的P0.D源码diff

| 文件                                                          | 固定head定位入口（节选）                                              | 计划出口 | 证据 | 本轮审查状态          |
| ------------------------------------------------------------- | --------------------------------------------------------------------- | -------- | ---- | --------------------- |
| [A e2e/p0-run-diff.spec.ts](../../../e2e/p0-run-diff.spec.ts) | `required` L26；`setup` L31；`close` L47；`command` L77；另10项见JSON | P0.D     | E12  | indexed；未逐文件重审 |

## Electron退出fixture有界回收/所属child信号/清理诊断

| 文件                                                    | 固定head定位入口（节选）                                                             | 计划出口         | 证据 | 本轮审查状态          |
| ------------------------------------------------------- | ------------------------------------------------------------------------------------ | ---------------- | ---- | --------------------- |
| [M e2e/shutdown.spec.ts](../../../e2e/shutdown.spec.ts) | `bounded` L11；`closeShutdownFixture` L25；`running` L26；`attempt` L28；另3项见JSON | R2 / E2E.context | E01  | indexed；未逐文件重审 |

## P0.D不可用文案与替代展示快照的edu验证倒计时清理

| 文件                                                                | 固定head定位入口（节选）                                                                                                                                                                                                                             | 计划出口                          | 证据      | 本轮审查状态          |
| ------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | --------------------------------- | --------- | --------------------- |
| [M e2e/status-surface.spec.ts](../../../e2e/status-surface.spec.ts) | `test: 会话「运行记录 ⌄」：视图收为五项，Tab 到触发器、Enter 打开，方向键 / Home / End 移动，Esc 回到触发器；原生网页让位后恢复` L1371；`test: 发音倒计时：长期关闭后首 tick 前刷新，关闭重开且清理计时器` L2653；`Handler` L2681；`transform` L2685 | P0.D / candidate.edu-verification | E12 / E15 | indexed；未逐文件重审 |

## E2E截图证据目录迁移

| 文件                                                                    | 固定head定位入口（节选）                                                                                                                                                                   | 计划出口   | 证据 | 本轮审查状态          |
| ----------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ | ---------- | ---- | --------------------- |
| [M e2e/workshop-actions.spec.ts](../../../e2e/workshop-actions.spec.ts) | `test: Workshop typed creation persists resources and restores modal focus` L7；`test: Workshop App dialog creates, exports, reports startup failure and restores persisted ownership` L65 | R2.context | E01  | indexed；未逐文件重审 |

## 双页原生focus失败诊断/DevTools状态观察；旧R3场景编号

| 文件                                                                          | 固定head定位入口（节选）                                                                                                                                                                                     | 计划出口  | 证据 | 本轮审查状态          |
| ----------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ | --------- | ---- | --------------------- |
| [M e2e/workspace-migration.spec.ts](../../../e2e/workspace-migration.spec.ts) | `test: R3 双网页原生focus事件决定地址与刷新目标，布局更新保持焦点` L164；`windowState` L268；`test.info().outputPath: r3-native-focus-failure.json` L312；`test.info().attach: r3-native-focus-failure` L314 | E2E.focus | E09  | indexed；未逐文件重审 |

## App完成链窄Promise规则及冻结CDP风格例外

| 文件                                            | 固定head定位入口（节选）                   | 计划出口 | 证据            | 本轮审查状态          |
| ----------------------------------------------- | ------------------------------------------ | -------- | --------------- | --------------------- |
| [M eslint.config.js](../../../eslint.config.js) | `eslint.config.js module/configuration` L1 | R3 / R2  | E05 / E10 / E11 | indexed；未逐文件重审 |

## 检查链/冻结/调度/默认E2E准备

| 文件                                                    | 固定head定位入口（节选）                                                  | 计划出口 | 证据      | 本轮审查状态          |
| ------------------------------------------------------- | ------------------------------------------------------------------------- | -------- | --------- | --------------------- |
| [M package.json](../../../package.json)                 | `package.json module/configuration` L1                                    | R2       | E05 / E11 | indexed；未逐文件重审 |
| [M playwright.config.ts](../../../playwright.config.ts) | `playwright.config.ts module/configuration` L1                            | R2       | E05 / E11 | indexed；未逐文件重审 |
| [M vitest.config.ts](../../../vitest.config.ts)         | `include` L3；`observation` L4；`mcp` L5；`localTerminal` L6；另1项见JSON | R2       | E05 / E11 | indexed；未逐文件重审 |

## 四Mota专用工具名称/等级/输入schema

| 文件                                                                                    | 固定head定位入口（节选）                                                  | 计划出口 | 证据      | 本轮审查状态          |
| --------------------------------------------------------------------------------------- | ------------------------------------------------------------------------- | -------- | --------- | --------------------- |
| [M packages/protocol/src/app-control.ts](../../../packages/protocol/src/app-control.ts) | `AppToolNameSchema` L33；`APP_TOOL_LEVEL` L54；`AppToolInputSchemas` L217 | R4       | E03 / E11 | indexed；未逐文件重审 |

## RunPatchResult与StudioApi.runPatch窄查询

| 文件                                                                          | 固定head定位入口（节选） | 计划出口 | 证据 | 本轮审查状态          |
| ----------------------------------------------------------------------------- | ------------------------ | -------- | ---- | --------------------- |
| [M packages/protocol/src/bridge.ts](../../../packages/protocol/src/bridge.ts) | `StudioApi` L16          | P0.D     | E12  | indexed；未逐文件重审 |

## Mota/edu/研究与候选源码会话协议

| 文件                                                                      | 固定head定位入口（节选）                                                                                                                 | 计划出口           | 证据      | 本轮审查状态          |
| ------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------- | ------------------ | --------- | --------------------- |
| [M packages/protocol/src/chat.ts](../../../packages/protocol/src/chat.ts) | `ChatConversationSchema` L44；`ChatSendSchema` L72；`MotaTaskDispatchRejectionSchema` L109；`ChatServiceRequestSchema` L119；另1项见JSON | candidate.contract | E01 / E03 | indexed；未逐文件重审 |

## 新增真实共享合同公开导出

| 文件                                                                        | 固定head定位入口（节选）           | 计划出口           | 证据 | 本轮审查状态          |
| --------------------------------------------------------------------------- | ---------------------------------- | ------------------ | ---- | --------------------- |
| [M packages/protocol/src/index.ts](../../../packages/protocol/src/index.ts) | `index.ts module/configuration` L1 | candidate.contract | E01  | indexed；未逐文件重审 |

## workbench:run-patch IPC通道

| 文件                                                                    | 固定head定位入口（节选） | 计划出口 | 证据 | 本轮审查状态          |
| ----------------------------------------------------------------------- | ------------------------ | -------- | ---- | --------------------- |
| [M packages/protocol/src/ipc.ts](../../../packages/protocol/src/ipc.ts) | `invokeChannels` L26     | P0.D     | E12  | indexed；未逐文件重审 |

## edu/Mota profile与来源预算/路径/受管App元数据

| 文件                                                                                    | 固定head定位入口（节选）                                                                          | 计划出口              | 证据            | 本轮审查状态          |
| --------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------- | --------------------- | --------------- | --------------------- |
| [M packages/protocol/src/managed-app.ts](../../../packages/protocol/src/managed-app.ts) | `EDU_SOURCE_BYTES` L4；`EDU_ROOT_FILES` L5；`EDU_REQUIRED_FILES` L6；`excluded` L14；另11项见JSON | candidate.import / R5 | E01 / E02 / E11 | indexed；未逐文件重审 |

## source/edu cleanupPending与sourceChangeState投影合同

| 文件                                                                          | 固定head定位入口（节选）  | 计划出口                  | 证据      | 本轮审查状态          |
| ----------------------------------------------------------------------------- | ------------------------- | ------------------------- | --------- | --------------------- |
| [M packages/protocol/src/status.ts](../../../packages/protocol/src/status.ts) | `RunStatusRawSchema` L120 | P0.D / candidate.edu-task | E12 / E15 | indexed；未逐文件重审 |

## 源码变更/研究授权/Mota和edu状态合同

| 文件                                                                                | 固定head定位入口（节选）                                                                                                                | 计划出口                                     | 证据                  | 本轮审查状态          |
| ----------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------- | -------------------------------------------- | --------------------- | --------------------- |
| [M packages/protocol/src/workspace.ts](../../../packages/protocol/src/workspace.ts) | `WorkbenchTaskVersionSchema` L52；`WorkbenchRunSchema` L74；`WorkbenchResourceSchema` L169；`WorkspaceSnapshotSchema` L185；另4项见JSON | P0.D / S5b / R4 / candidate.edu-verification | E12 / E01 / E03 / E15 | indexed；未逐文件重审 |

## Electron音频输入签名权限

| 文件                                                                            | 固定head定位入口（节选）                         | 计划出口       | 证据      | 本轮审查状态          |
| ------------------------------------------------------------------------------- | ------------------------------------------------ | -------------- | --------- | --------------------- |
| [A packaging/app-entitlements.plist](../../../packaging/app-entitlements.plist) | `app-entitlements.plist module/configuration` L1 | packaged.audio | E01 / E14 | indexed；未逐文件重审 |

## accessibility命令与导入入口UI验收索引

| 文件                                          | 固定head定位入口（节选）                  | 计划出口            | 证据 | 本轮审查状态          |
| --------------------------------------------- | ----------------------------------------- | ------------------- | ---- | --------------------- |
| [M premium-ui.json](../../../premium-ui.json) | `premium-ui.json module/configuration` L1 | candidate.import-ui | E13  | indexed；未逐文件重审 |

## 固定旧head的Promise负例装置（本轮B1修复前）

| 文件                                                                                  | 固定head定位入口（节选）                                          | 计划出口        | 证据      | 本轮审查状态          |
| ------------------------------------------------------------------------------------- | ----------------------------------------------------------------- | --------------- | --------- | --------------------- |
| [A scripts/check-app-promises.test.mjs](../../../scripts/check-app-promises.test.mjs) | `root` L6；`filePath` L7；`eslint` L8；`floating` L9；另3项见JSON | R3 / B1.pre-fix | E05 / E10 | indexed；未逐文件重审 |

## 规范文档入口/本地链接/尾随空白检查

| 文件                                                        | 固定head定位入口（节选）                | 计划出口 | 证据      | 本轮审查状态          |
| ----------------------------------------------------------- | --------------------------------------- | -------- | --------- | --------------------- |
| [M scripts/check-docs.mjs](../../../scripts/check-docs.mjs) | `requiredDocuments` L9；`checkDocs` L55 | R2       | E05 / E11 | indexed；未逐文件重审 |

## 规范文档入口/链接/尾随空白检查正反例

| 文件                                                                  | 固定head定位入口（节选）                                                                                                                                                                                                                                                   | 计划出口 | 证据      | 本轮审查状态          |
| --------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | -------- | --------- | --------------------- |
| [A scripts/check-docs.test.mjs](../../../scripts/check-docs.test.mjs) | `fixture` L8；`test: requires the revised current plan rather than silently skipping an absent file` L18；`test: new ADRs join the normative inventory without editing the checker` L25；`test: retains link checks without interpreting code examples as prose links` L34 | R2       | E05 / E11 | indexed；未逐文件重审 |

## 模板实际安装树/锁/安装回执/tsx-esbuild预检

| 文件                                                                | 固定head定位入口（节选）                                                  | 计划出口 | 证据      | 本轮审查状态          |
| ------------------------------------------------------------------- | ------------------------------------------------------------------------- | -------- | --------- | --------------------- |
| [A scripts/check-e2e-deps.mjs](../../../scripts/check-e2e-deps.mjs) | `template` L8；`checkTemplateDependencies` L10；`read` L11；`inspect` L21 | R2       | E05 / E11 | indexed；未逐文件重审 |

## 模板安装树/锁/回执/tsx-esbuild预检负例

| 文件                                                                          | 固定head定位入口（节选）                                                                                                                                                                                               | 计划出口 | 证据      | 本轮审查状态          |
| ----------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | -------- | --------- | --------------------- |
| [A scripts/check-e2e-deps.test.mjs](../../../scripts/check-e2e-deps.test.mjs) | `json` L8；`fixture` L12；`test: validates the installed graph, including scoped and nested packages, while allowing absent optional packages` L39；`test: tsx alone does not satisfy the full lockfile inventory` L80 | R2       | E05 / E11 | indexed；未逐文件重审 |

## 固定来源Git对象/精确路径/内容哈希门禁

| 文件                                                            | 固定head定位入口（节选）                                                      | 计划出口 | 证据      | 本轮审查状态          |
| --------------------------------------------------------------- | ----------------------------------------------------------------------------- | -------- | --------- | --------------------- |
| [A scripts/check-frozen.mjs](../../../scripts/check-frozen.mjs) | `root` L9；`manifest` L10；`frozenInputs` L12；`directories` L15；另4项见JSON | R2       | E05 / E11 | indexed；未逐文件重审 |

## 固定来源/精确路径/内容哈希篡改负例

| 文件                                                                      | 固定head定位入口（节选）                                                                                                                                | 计划出口 | 证据      | 本轮审查状态          |
| ------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------- | -------- | --------- | --------------------- |
| [A scripts/check-frozen.test.mjs](../../../scripts/check-frozen.test.mjs) | `root` L14；`original` L15；`fixture` L18；`test: pinned provenance and the complete original inventory pass without modifying inputs` L28；另4项见JSON | R2       | E05 / E11 | indexed；未逐文件重审 |

## Linux报告完整性/5必跑用例门禁

| 文件                                                                      | 固定head定位入口（节选）                             | 计划出口 | 证据 | 本轮审查状态          |
| ------------------------------------------------------------------------- | ---------------------------------------------------- | -------- | ---- | --------------------- |
| [A scripts/check-linux-guest.mjs](../../../scripts/check-linux-guest.mjs) | `requiredGuestTests` L7；`checkLinuxGuestReport` L15 | R1       | E04  | indexed；未逐文件重审 |

## Linux报告完整性/5必跑用例门禁负例

| 文件                                                                                | 固定head定位入口（节选）                                                                                                                                                                                                                                                        | 计划出口 | 证据 | 本轮审查状态          |
| ----------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | -------- | ---- | --------------------- |
| [A scripts/check-linux-guest.test.mjs](../../../scripts/check-linux-guest.test.mjs) | `reportFixture` L11；`test: requires all five process boundaries and accepts a complete passing inventory` L31；`test: rejects NOT_RUN labels, duplicate names and inconsistent counts` L60；`test: rejects missing, malformed, empty, wrong-file and failed-suite reports` L73 | R1       | E04  | indexed；未逐文件重审 |

## Vitest进程测试分组唯一归属与顺序回归

| 文件                                                                                        | 固定head定位入口（节选）                                                                                                                                                                                                  | 计划出口 | 证据      | 本轮审查状态          |
| ------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | -------- | --------- | --------------------- |
| [A scripts/check-test-scheduling.test.mjs](../../../scripts/check-test-scheduling.test.mjs) | `projects` L6；`owners` L7；`test: runs Mota process boundaries exactly once, after ordinary suite contention` L13；`test: keeps ordinary coverage and existing process groups separate without duplicate scheduling` L24 | R2       | E05 / E11 | indexed；未逐文件重审 |

## edu手动源码snapshot/verify/三方merge与冲突产物CLI；未含旧PR9独有resolve

| 文件                                                        | 固定head定位入口（节选）                                                                            | 计划出口                       | 证据 | 本轮审查状态          |
| ----------------------------------------------------------- | --------------------------------------------------------------------------------------------------- | ------------------------------ | ---- | --------------------- |
| [A scripts/edu-source.mjs](../../../scripts/edu-source.mjs) | `MAX_FILES` L12；`MAX_SOURCE_BYTES` L13；`MAX_BASE64_CHARS` L14；`MAX_PATH_CHARS` L15；另44项见JSON | candidate.edu-cli / R5.context | E01  | indexed；未逐文件重审 |

## edu手动源码CLI白名单/256文件/524288字节及三方merge边界回归

| 文件                                                                  | 固定head定位入口（节选）                                            | 计划出口                       | 证据 | 本轮审查状态          |
| --------------------------------------------------------------------- | ------------------------------------------------------------------- | ------------------------------ | ---- | --------------------- |
| [A scripts/edu-source.test.mjs](../../../scripts/edu-source.test.mjs) | `run` L23；`hash` L24；`REPOSITORY` L25；`SCRIPT` L26；另39项见JSON | candidate.edu-cli / R5.context | E01  | indexed；未逐文件重审 |

## 14个冻结输入路径/来源提交/SHA清单

| 文件                                                                | 固定head定位入口（节选）                     | 计划出口 | 证据      | 本轮审查状态          |
| ------------------------------------------------------------------- | -------------------------------------------- | -------- | --------- | --------------------- |
| [A scripts/frozen-inputs.json](../../../scripts/frozen-inputs.json) | `frozen-inputs.json module/configuration` L1 | R2       | E05 / E11 | indexed；未逐文件重审 |

## 外置构建ASAR打包回归/越界link排除/声明尾字节等待

| 文件                                                                                                | 固定head定位入口（节选）                                                                                     | 计划出口            | 证据            | 本轮审查状态          |
| --------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------ | ------------------- | --------------- | --------------------- |
| [A scripts/packaging/external-output.test.mjs](../../../scripts/packaging/external-output.test.mjs) | `require` L12；`{ getMainFileMatchers }` L13；`{ computeFileSets }` L14；`{ AsarPackager }` L15；另9项见JSON | candidate.packaging | E01 / E09 / E08 | indexed；未逐文件重审 |

## guest/template载荷权限规范化与归档权限审计

| 文件                                                                                                  | 固定head定位入口（节选）                                                                                                                                                   | 计划出口             | 证据      | 本轮审查状态          |
| ----------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | -------------------- | --------- | --------------------- |
| [M scripts/packaging/guest-platform.mjs](../../../scripts/packaging/guest-platform.mjs)               | `requiredGuestExecutables` L10；`auditGuestDirectory` L58；`auditGuestArchive` L71                                                                                         | packaged.permissions | E01 / E02 | indexed；未逐文件重审 |
| [M scripts/packaging/guest-platform.test.mjs](../../../scripts/packaging/guest-platform.test.mjs)     | `fixture` L26；`test: pnpm platform pruning removes only macOS/Windows targets and preserves Linux ARM64 native bytes` L42；`changeTarMode` L119；`text` L123；另3项见JSON | packaged.permissions | E01 / E02 | indexed；未逐文件重审 |
| [M scripts/packaging/payload-lib.mjs](../../../scripts/packaging/payload-lib.mjs)                     | `payloadMode` L162；`assertPayloadPermissions` L165；`normalizePayloadPermissions` L170；`deterministicArchive` L204；另1项见JSON                                          | packaged.permissions | E01 / E02 | indexed；未逐文件重审 |
| [M scripts/packaging/prepare-payloads.mjs](../../../scripts/packaging/prepare-payloads.mjs)           | `preparePayloads` L19                                                                                                                                                      | packaged.permissions | E01 / E02 | indexed；未逐文件重审 |
| [M scripts/packaging/template-payload.mjs](../../../scripts/packaging/template-payload.mjs)           | `auditTemplateArchive` L14                                                                                                                                                 | packaged.permissions | E01 / E02 | indexed；未逐文件重审 |
| [M scripts/packaging/template-payload.test.mjs](../../../scripts/packaging/template-payload.test.mjs) | `changeTarMode` L40；`text` L44；`test: template archive rejects private dependency directories, unreadable files and owner-only execute modes` L58                        | packaged.permissions | E01 / E02 | indexed；未逐文件重审 |

## 默认E2E日志/指纹门禁及packaged输入指纹

| 文件                                                  | 固定head定位入口（节选）                                                                    | 计划出口                  | 证据      | 本轮审查状态          |
| ----------------------------------------------------- | ------------------------------------------------------------------------------------------- | ------------------------- | --------- | --------------------- |
| [A scripts/run-e2e.mjs](../../../scripts/run-e2e.mjs) | `repository` L23；`sha256` L24；`childEnvironment` L26；`summarizeReport` L33；另10项见JSON | R2 / packaged.fingerprint | E05 / E11 | indexed；未逐文件重审 |

## E2E启动器/报告/漂移与合成packaged指纹负例

| 文件                                                            | 固定head定位入口（节选）                                                                                                                                                                                                                                                                                         | 计划出口                  | 证据      | 本轮审查状态          |
| --------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------- | --------- | --------------------- |
| [A scripts/run-e2e.test.mjs](../../../scripts/run-e2e.test.mjs) | `report` L9；`test: removes Electron Node mode only from the child and retains explicit caller configuration` L44；`test: summarizes actual skip reasons and does not count skipped tests as passes` L55；`test: rejects malformed or inconsistent reports instead of inventing a green result` L63；另3项见JSON | R2 / packaged.fingerprint | E05 / E11 | indexed；未逐文件重审 |
