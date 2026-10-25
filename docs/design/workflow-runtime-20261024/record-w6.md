# W6 执行记录：串行候选写与恢复（lane 发布 + 显式应用）

日期：2026-10-27 前后。实现：worker；审阅与独立验证：主线程。本包是路线图第一个引入写能力的交付，拆为 W6a（lane 隔离执行 + 候选发布链）与 W6b（候选条件应用 + 产品接线）两个有序子包。

## 交付面

### W6a：lane 候选发布

**执行隔离**：lane attempt 在 helper 物化的独立目录运行（`codex exec --sandbox workspace-write`，runId 绑定的冻结输入）；child 退出 0 后 helper 开采集窗口，适配器写 `{type:'collect'}` 帧，collect 帧（runId 复核）回传的文件集才构成候选。close/超时/身份不匹配/turn_failed 一律 `failed{crash}` 或 snapshot 回退 + 清理，120s 有界。

**发布链**：内核在 `call_end` 前调 `publishCandidate` 端口 → Main `RunSourceRepository`（`userData/workflow/runs`，Lab 管理 git 对象存储）写 `source-{callSeq}.patch` 与 after 树 → journal `publishCandidate` 事务：基线核对 + 链上前驱推导 + publications 行 + `runs.candidate_tree` CAS。同一 (run,callSeq) 同树重发幂等、异树 `journal_event_invalid`。

**串行约束**：analyze 拒绝 `parallel/pipeline` 实参内 `isolation:'lane'`（`lane_not_serializable`）；内核运行时 `laneInFlight` 排他（lane 仅在 inFlight 空时派发、在飞时阻塞一切）——写安全不依赖 lint 单点。受理期 `bindLane`：lane 声明的脚本以受管 App 实时源码快照为冻结输入与 baseTree；无 App 时 run 仍受理（`requiresApp/writes` 标记），lane 调用以 `unavailable` 诚实结束。

**已知设计代价**：发布行先于 `call_end` 提交（两事务而非设计 §105 字面的单事务）。崩溃窗口可能留"无 call_end 的孤儿 publication"——续跑时同内容幂等过、异内容诚实拒绝，等价达成"不丢、不重、可解释"。

### W6b：候选条件应用

**写许可公开入口**（`workbench/application.ts`）：`projectWriteBlocker(target)`——closing/App 不存在或解绑/恢复未确认 → `unavailable:`；生命周期在途/清理未确认 → `busy:`；`running` 不阻塞（与任务执行写工程同口径）。`acquireProjectWriter(projectId, ownerId)` 与任务执行/源码采集共用 `projectWriters` 互斥表，同步原子获取，release 幂等且只释放本人租约。

**应用用例**（`WorkflowApplication.applyCandidate`）：租约持有整个临界区——终态门 → 候选存在 → 绑定核对 → 幂等短路（同树同目标 → no-op）→ `appBusy` → `acquireWriter` → 实时快照 → `computeTree` 对比 `candidate.baseTree`（偏离即 `apply_conflict` 零写入）→ `materialize` → `app.source.apply` → journal `apply` 事件（投影 `runs.applied_at`）→ `finally` 释放。错误码闭集：`run_not_found`/`run_busy`/`candidate_unavailable`/`app_unavailable`/`project_busy`/`apply_conflict`/`apply_failed`。

**guest 写路径**（`app-helper.py` `operation:'apply'`）：身份核对后 `source_apply` 以 dir-fd + `O_NOFOLLOW`/`O_NONBLOCK` 遍历——载荷校验（路径/`..`/排除名/重复/父路径冲突/预算），源码命名空间内缺席文件删除、空目录后序剪枝、文件↔目录类型替换，`.wsl-*`/`node_modules`/`.data`/凭证类永不触碰；`AppService.sourceApply` 与 `sourceSnapshot` 共用 `sourceProcesses` 串行槽，拒绝生命周期在途/运行中/清理未确认，回执 64KiB 有界 + `applied:true` 校验 + 清理确认才释放槽位。

**协议与产品面**：`app.source.apply` 请求/回执 schema（`AppSourceApplyFilesSchema` ≤256 文件/≤512KiB，复用 `sourceCalls` 取消命名空间）；`workflow:apply`/`workflow:patch` 具名窄通道（仅 runId——点击即授权）；journal schema v3（`requires_app`/`writes`/`applied_at`/`app_target_json`，v2→v3 迁移单事务）；renderer 候选面板——文件清单、baseTree→currentTree、diff 预览（只读）、终态+绑定才显示「应用候选到应用」，`appliedAt` 展示；`listRuns`/`runRow` 并入候选投影。

**fixture 与 E2E**（`e2e/fixtures/sbx.mjs`）：受管 App create/source-snapshot/apply/export/collect 全链 + 跨进程持久化；排除名过滤与真 helper 同口径（`.npmrc` 等保留）；`DIE` sentinel 保证 exit/cleanup 帧在排队写冲刷后才退出。

**E6A 场景表**（`fixtures/workflow/e6a/scenarios.json`）：publish→apply 事务序、源冲突、工程忙、生命周期在途、App 不可用、helper 失败、幂等重放——由应用用例单测与 E2E 共用驱动。

## 审阅中处理的问题（主线程发现并修复）

1. **`scriptDeclaresLane` 误报（已修）**：原正则 `/isolation\s*:\s*['"]lane['"]/` 会命中字符串/注释里的字面量 → 误绑定 App 并错换冻结输入。改为状态机剥离注释、把引号字符串折叠为 `''`（内容恰为 `lane` 的保留 `'lane'`）；模板字符串整体剔除。残余误报/漏报方向均收敛到「不绑定/不派发」一侧（内核 `validateOpts` 仍是运行时权威）。16 条边界用例验证（字符串/注释/转义/模板/`'lane'+'x'`/fanout 内）。
2. **西班牙语文档注释（已修）**：`run-source-repository.ts`（3 处 docstring + 1 行内）、`journal-sqlite.ts`（2 处）、`application.ts`（3 处）worker 混入西语注释，统一改回中文。

### worker 自修复项（审阅复核认可）

- `DIE` sentinel 修掉 fake「exit 后回 handler 继续走 prompt 逻辑」导致的未确认清理；
- fixture 排除名与真 helper 对齐（`.npmrc` 曾进快照致 `app_unavailable`）；
- `listRuns` 并入候选投影（renderer 候选面板此前拿不到数据）；
- `index.ts` `appBusy` 区分 `workbench === null`（unavailable）与健康 `null` 阻塞——`?? 'unavailable'` 曾把健康 null 变错误；
- E2E 按当前 projectId 索引 fixture 状态（避免读到其他 spec 残留的共享状态）。

## 独立验证（主线程复跑）

| 命令 | 结果 |
| --- | --- |
| `vitest run apps/desktop/src/main`（根目录，全量） | 55 文件 854/854（含 W6b 用例：绑定/事务序/冲突/忙/不可用/幂等/非终态/无候选） |
| `vitest run src/workflow src/app-service.test.ts`（service） | 12 文件 217/217 |
| `vitest run apps/desktop/src/main/workflow + run-source-repository.test.ts` | 5 文件 165/165 |
| typecheck ×3（protocol/service/desktop） | 通过 |
| eslint（main/renderer/service/e2e 触及面） | 通过 |
| prettier（触及路径，Python 除外） | 通过；`app-helper.py` 以 `py_compile` 验证 |
| `pnpm build` | 通过 |
| `node scripts/check-docs.mjs` | 通过 |
| `env -u ELECTRON_RUN_AS_NODE WSL_E2E_SKIP_FOREGROUND=1 playwright test e2e/workflow.spec.ts` | 7/7：候选发布→diff→显式应用→fixture 工程含 `lane-change.txt`；同基线第二候选 `apply_conflict` 拒绝且未应用 |

`WSL_E2E_SKIP_FOREGROUND=1` 仅跳过 OS 前台断言（本环境另一应用持有焦点），不削弱其余断言；正常 GUI 会话下不带该标记的复跑仍待做，作为最终界面验收的一部分。

## 边界（如实声明）

- lane 是唯一的写隔离级别；`shared`、并行写、跨候选合并/选择应用（仅当前发布指针）、自动跨 Harness 回退均未做。
- `apply` 只承诺「helper 退出 0 且清理已确认」；运行中 App 的并发文件访问由 service 侧 `busy` 拒绝兜底（blocker 放行 running 但 sourceApply 仍拒——双层口径，严格侧生效）。
- 候选树与 live 树比较只反映路径+内容（统一 100644）；文件模式差异不参与冲突判断。
- fixture E2E ≠ 真实模型/sbx live 验收；E8 活跑未授权未执行。
- 无 commit/push。
