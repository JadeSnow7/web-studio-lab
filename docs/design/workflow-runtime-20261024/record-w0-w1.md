# W0+W1 执行记录（2026-10-24）

范围：冻结 P0a 合同与验收输入（W0），在 `apps/service` 内实现真实 QuickJS WASM 的运行内核与测试（W1）。不含产品接线、真实 Harness、写类调用、UI。

## 交付物

W0（合同与验收输入）：

- `contract-p0a.md`：DSL 源格式（meta 首句 + 单个 `export default async function main`）、primitives 语义、结果/错误联合、预算表、取消/续跑语义、Journal 记录、只读边界、依赖锁定。
- `fixtures/workflow/`：14 个黄金脚本 + 期望（含 MockHarness 响应计划）+ `faults.json` 故障矩阵。

W1（实现，`apps/service/src/workflow/`）：

- `contract.ts`：合同转写（类型/常量/canonical/contentKey）。
- `analyze.ts`：Acorn 静态校验（模块形状、meta 字面量、禁用标识符/import()/import.meta）。
- `vm-worker.mjs`：worker_threads 内跑 quickjs-emscripten RELEASE_SYNC；`__hostCall/__hostPhase/__hostLog/__hostWarn` 宿主函数；VM 内实现 `agent/parallel/pipeline/phase/log/args`；fanout/log 预算；Deferred Promise outbox + executePendingJobs 泵；内存/段时间/累计时间/jobs 四重限制。
- `vm-bridge.ts`：就绪握手、send/deliver/dispose、迟到消息忽略、1s 优雅期后 terminate 兜底。
- `kernel.ts`：callSeq 按 outbox 接收序分配；opts 校验；顺序派发；仅 `{timeout, crash, empty_output, schema_mismatch}` 可重试；call_end 落盘后才 deliver（commit-before-deliver）；按 callSeq 有序交付；16 MiB 交付缓冲；祖先链续跑缓存（直接父校 scriptHash/argsHash，近祖先优先，`cachedFromRunId` 保留出处）；deadline/stop；JSON Schema 有界子集校验器。
- `journal-jsonl.ts`：逐条 append+fsync，写串行化（P0a 用 JSONL；`node:sqlite` 留给后续 Journal 工作包评估）。
- `call-adapter.ts` / `mock-harness.ts` / `test-helpers.ts`：结构化调用端口与确定性 Mock（label→prompt→fallback、per-attempt 响应序列、unplanned_call）。
- 6 个测试文件（golden × 14、determinism、resume、sandbox、stop、analyze）。

依赖：`apps/service/package.json` 增加 `quickjs-emscripten@0.32.0`、`acorn@8.19.0`（均发布 ≥7 天）；`pnpm-lock.yaml` 相应更新。无其他既有文件改动。

## 验证（主 Agent 独立复跑）

| 命令                                                                                                                          | 结果                                                 |
| ----------------------------------------------------------------------------------------------------------------------------- | ---------------------------------------------------- |
| `pnpm --filter @wsl/service exec vitest run src/workflow`                                                                     | 6 文件 68 测试通过，约 31s（call-budget 单项约 20s） |
| `pnpm --filter @wsl/service typecheck`                                                                                        | 通过                                                 |
| `pnpm exec eslint apps/service/src/workflow`                                                                                  | 通过                                                 |
| `pnpm exec prettier --check "apps/service/src/workflow/**" "fixtures/workflow/**" "docs/design/workflow-runtime-20261024/**"` | 通过（3 个 fixture 空白问题已修复）                  |

真实 WASM 路径已被测试覆盖（非 mock/skip）：模块求值、Promise 桥、内存/CPU/jobs 预算、Date/Math.random/eval/Function 禁用、停止与迟到消息、缓存续跑。

## 实施期对合同的澄清（均已并入合同或实现注释）

- `result_too_large` 并入 RunFailureCode 闭集（§3/§6 已规定其运行级语义，闭集列举补上；见合同 §6）。
- MockHarness `schema_bad` 计划项映射为 `schema_mismatch`（可重试集成员）。
- 文本结果 + schema 且不可解析 JSON → `schema_mismatch`；空文本 + schema → `empty_output`。
- main 返回时仍有未交付调用 → `script_error`（worker 上报 pendingCalls，内核双重校验）。
- 无法派发的调用（invalid opts/超预算）照常写 call_start/call_end，contentKey 尽力计算（有效字段规范化，缺失字段缺席）。
- P0a 派发为严格顺序（一次一个在途），有序交付与 `parallel`/`pipeline` 的确定性语义不受影响；物理并行留待 Lane 工作包。

## 未做（按计划留给后续包）

Main 侧 WorkflowApplication、`lab.workflow.*` MCP 入口、TaskRun 挂接、真实 Harness 适配、写类/lane/shared 隔离、回推指挥会话、跨项目缓存授权、Ultra。本产品验收无关 MockHarness：不据此声称产品通过。
