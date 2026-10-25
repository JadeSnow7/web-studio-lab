# W4 执行记录：最小可信产品入口（P0b）

日期：2026-10-26 前后。实现：worker；审阅与独立验证：主线程。

## 交付面

固定任务入口打通 `protocol → service → Main → preload → renderer` 全链：

- **protocol**：`workflow:*` invoke（`tasks/run/resume/stop/reconcile/status/runs`）+ `workflow:update` tick 事件；Main↔service 消息面 `workflow-run`/`workflow-stop`/`workflow-event-ack`（请求）与 `workflow-event`/`workflow-done`（消息）。
- **service** `workflow-host.ts`：`ServiceWorkflowHost` 持有共享 `WorkflowEngine`；每条 journal 事件 `workflow-event`→等 `workflow-event-ack` 才继续（ack 拒绝 → append 抛错 → `internal_error`）；终态经 `workflow-done` 单独发布。
- **Main** `service-engine-port.ts`：`ServiceWorkflowEnginePort implements WorkflowEnginePort`——剥离 journal 发请求；事件按 run 串行落 SQLite 再回执；子进程退出把未结清 done 以 `internal_error` 落定（不伪造 journal）；`application.ts` 加 `onEvent` tick（落盘后触发）与 `input` 透传、`runRow`/`listRuns`；`fixed-tasks.ts` 两个固定任务（`diagnose-input` 正常 / `diagnose-slow` 含 `[slow]` 供停止验证）；`index.ts` 装配 `userData/workflow/journal.sqlite` + `recoverOpenRuns()`。
- **preload/renderer**：`studio.workflow` 窄接口；`WorkflowsPage`（任务卡 hash/脚本/输入清单 + 运行记录 + calls 表含 cached/usage + 停止/标记已停止/续跑）。
- **构建**：`vite.config.ts` closeBundle 插件把 `vm-worker.mjs` + quickjs-emscripten 运行闭包复制进 `out/`（worker_threads 需要真实文件路径，不进单文件 bundle）。
- **usage**：`turn.completed` 的 usage 经 adapter→kernel 写入 `attempt_end`，状态投影透出；fixture sbx 的 `turn.completed` 补 `usage`。

## 授权语义

「运行」按钮即一次性授权：任务卡展示脚本源码/meta/args/输入文件/hash；受理时 Main 重算 `scriptHash`/`argsHash` 并写入 run 行；续跑按 taskId 取同一固定定义，hash 不一致即 `resume_mismatch`。无自由脚本编辑器。

## 审阅中处理的问题

1. **W4 引入的回归（已修）**：`window-close.test.ts` 的 ChatService mock 缺 `setWorkflowListener`/`onExit`/`workflowRequest`——port 构造抛错使 `openWorkbench` 中断、close 监听器从未注册。给 mock 补上三个方法，8/8 转绿。
2. **审查时的假阴性**：`pnpm --filter @wsl/desktop exec vitest` 以 `apps/desktop` 为 cwd 运行，`review-lifecycle.test.ts` 里 `path.resolve('e2e/fixtures/sbx.mjs')` 相对 repo 根解析失败（`sbx 不可执行`）。从根目录 `pnpm exec vitest run apps/desktop/src/main` 全量 728/728 通过。注意：desktop 测试须从 repo 根运行（根 `pnpm test`/`vitest` 如此）。

## 独立验证（主线程复跑）

| 命令                                                               | 结果                                                                                                    |
| ------------------------------------------------------------------ | ------------------------------------------------------------------------------------------------------- |
| `vitest run src/workflow src/workflow-host.test.ts`（service）     | 96/96                                                                                                   |
| `vitest run src/main`（desktop，根目录）                           | 728/728（54 文件）                                                                                      |
| `vitest run src/workflow.test.ts`（protocol）                      | 3/3                                                                                                     |
| typecheck ×3（protocol/service/desktop）                           | 通过                                                                                                    |
| eslint（全部触及文件） / prettier `--check`（显式 ignore-path）    | 通过                                                                                                    |
| `pnpm build` + `out/vm-worker.mjs`、`out/node_modules`             | 通过                                                                                                    |
| `env -u ELECTRON_RUN_AS_NODE playwright test e2e/workflow.spec.ts` | 3/3：完成+usage 可见；停止清理确认→cached 续跑→再停止；关应用→重启 needs_reconciliation→标记已停止→续跑 |
| `node scripts/check-docs.mjs`                                      | 通过                                                                                                    |

## 边界（如实声明）

只读、固定任务、并发 1、Codex-only（ACP 无 `argvForIsolation`）。E2E 用 fixture sbx，**不构成**真实模型/sbx live 验收。未实现：自由脚本入口、写类调用、并行 lane、MCP workflow 面、Ultra。service shutdown 不停 workflow guest——遗留 run 重启后 `needs_reconciliation` 由用户核对（设计语义）。无 commit/push。
