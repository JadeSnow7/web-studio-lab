# W2 执行记录（2026-10-24）

范围：Main 任务职责下的 workflow 应用用例 + 持久化适配器（SQLite，Main 单写）+ W1 内核窄端口注入。离线交付：不建 IPC、不接 preload/renderer/Workbench——产品入口与装配属 W4。

## 架构落点

- **Main（`apps/desktop/src/main/workflow/`）** 是 workflow 业务状态机与 Journal 的唯一权威：`application.ts`（幂等受理、P0 并发 1、恢复链、hash 校验、已提交结果复用、进程未确认拒绝续跑）+ `journal-sqlite.ts`（`node:sqlite` DatabaseSync，schema v1 经 `PRAGMA user_version`，未知新版本保留文件拒绝）+ `engine-port.ts`（引擎窄端口接口，DTO 全部来自 protocol）。全部 Electron 无关，可注入 fake 引擎测试。
- **service（`apps/service/src/workflow/`）** 保持执行机制：`engine.ts` 是实现同一端口形状的薄包装（spec 校验 + cache/journal 映射）；`kernel.ts` 增加 `journal`/`resumeCache` 注入（缺省仍走 JSONL，68 个既有测试不动），journal append 失败 → `internal_error`，且 `attempt_start` 未落盘不派发（未被记录的执行不可恢复）；首条 run 事件未提交不发送 load。
- **protocol（`packages/protocol/src/workflow.ts`）** 成为 JournalEvent/RunOutcome/CacheEntry/DSL_VERSION 的跨进程 DTO 唯一来源（zod 判别联合），service `contract.ts` 改为 re-export。

## 关键语义

- `run(requestId, script, args)`：同 requestId+同 scriptHash+argsHash+parentRunId → 返回既有 workflowRunId；不同内容 → `request_conflict`。任何非终态 run（含 `needs_reconciliation`）→ `run_busy`（P0 并发 1，不排队）。
- `resume`：父 run 必须已确认终态；`needs_reconciliation` → `process_unconfirmed`，running/stopping → `run_not_resumable`，hash 不等 → `resume_mismatch`；缓存按祖先链近者优先、出处回溯原成功 run。
- 停止：`handle.stop()` → `done` resolve 即清理确认（worker dispose + 终态事件已入 journal）。
- 重启恢复：`recoverOpenRuns` 把非终态行标 `needs_reconciliation`（恢复标记，不写合成 journal 事件）；P0a 全 readonly 无副作用可核对，`reconcileAsStopped` 结清为 stopped 后才解锁续跑与并发槽。
- Journal：每条事件一个 `BEGIN IMMEDIATE` 事务，events 原始镜像 + runs/calls/attempts 类型化投影同生共死。

## 实施期澄清（worker 决策，主 Agent 已复核接受）

- `runs` 行含 `created_ms`（注入时钟）与 `created_seq`（受理序号）。
- `needs_reconciliation` 计入非终态：未确认进程存续期间不放行新运行（保守，符合 §7"确认前不发起新动作"）。
- 端口 `run()` 返回类型含 `Promise<handle>`（异步 service 引擎与同步 fake 同时满足）。
- 引擎拒绝受理时 run 行标 `failed{engine_rejected}`，不留僵尸并发槽。
- journal 层错误经 `WorkflowJournalError.code` 映射为 `WorkflowApplicationError` 统一抛出。

## 验证（主 Agent 独立复跑）

| 命令                                                                      | 结果                                         |
| ------------------------------------------------------------------------- | -------------------------------------------- |
| `pnpm --filter @wsl/service exec vitest run src/workflow`                 | 7 文件 73 测试通过（68 回归 + 5 新），约 37s |
| `pnpm --filter @wsl/desktop exec vitest run src/main/workflow`            | 2 文件 14 测试通过                           |
| `pnpm --filter @wsl/protocol typecheck` / `@wsl/service` / `@wsl/desktop` | 全部通过（desktop 含 node+web 双 config）    |
| `pnpm exec eslint`（三个触及目录）                                        | 通过                                         |
| `pnpm exec prettier --check`（触及文件）                                  | 通过                                         |

## 边界与未做

- Main↔service 真实 IPC binding（utilityProcess）未建——W4 装配时把 `WorkflowEnginePort` 换成进程通道实现；两侧端口形状本轮已对齐。
- desktop 测试用 contract 级 fake 引擎；app+真内核+真 SQLite 的组合测试属 P0b/W4（真实 Electron + fixture 生命周期门槛）。
- 未运行 repo 级 `pnpm check`/`pnpm build`（工作树有大量并行 dirty 工作；本轮触及的包各自 typecheck/lint/test 已覆盖）。未接 UI、未调真实模型、未跑 sandbox live。无 commit/push。
