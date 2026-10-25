# W5 执行记录：有界并发派发 + 已保存命令与审批绑定（P1）

日期：2026-10-27 前后。实现：worker；审阅与独立验证：主线程。

## 交付面

**内核有界并发**（`apps/service/src/workflow/kernel.ts`）：

- 单在途 `inFlightSeq` 升级为 `inFlight: Set<callSeq>` + `inFlightAborts`；`maxInFlight` 缺省 `LIMITS.MAX_CONCURRENT_CALLS = 4`，越界截断到 `[1, 上限]` 不报错。
- 派发/交付次序不变式保持：callSeq 按 outbox 接收序分配、`call_end` 先于 `deliver` 落盘、deliver 严格按 callSeq 排干 `deliverables`——并发上限只改变**物理**执行次序，逻辑序列与缓存谱系不受影响（含并发下 `cachedFromRunId` 续跑语义，见 `concurrency.test.ts`）。
- abort 先于 `attempt_start` 落盘注册（`inFlight.add`→`controller.set` 全程同步），stop/timeout 对所有在途 attempt 生效。

**已保存命令与审批绑定**（`apps/desktop/src/main/workflow/`）：

- `commands-store.ts`：`userData/workflow/commands.json`，临时文件 + rename 原子写、严格 Zod 校验；文件损坏 fail-closed——内置命令仍可用、saved 全不可用并记录错误。
- `commands.ts`：内置/saved 统一解析为 `commandId`；saved 首次运行需 `approvedHash` 与当前脚本+args 哈希一致；**任何编辑使批准失效**（改 `script`/`args`/`deadlineMs` 清 `approvedHash`）；续跑不查批准（父 run 的 hash 已是身份）。
- IPC 面（`packages/protocol/src/ipc.ts`、`apps/desktop/src/main/ipc.ts`）：`workflow:commands`、`workflow:run`（按 `commandId`）、`workflow:command-save/-approve/-delete`；renderer 无法再提交任意脚本/args。
- `fixed-tasks.ts` 新增内置 `diagnose-parallel`（`parallel` 扇出 2 调用），renderer 命令卡含 saved CRUD 与批准状态。

**E7 授权语料**（`e7-corpus.test.ts`，≥100 条版本化语料）：篡改命令文件、schema 注入、isolation 拒绝、批准失效、重复受理、续跑 hash 链、正控 allow 路径。

**E8 历史实验材料**（本地归档路径 `scripts/workflow-e8.mjs`、`fixtures/workflow/e8/`）：原阶段准备过 prompts/schemas 语料与采集脚本；本次分批提交不包含这些材料，也未执行 E8 真实模型实验。

**静态分析**：`analyze.ts` 拒绝 `agent({isolation})` 非 `'readonly'` 字面量。

## 审阅中处理的问题（主线程发现并修复）

1. **隔离保证被 saved 命令削弱（已修）**：无 `input` 的 saved 命令 → adapter 省略 `workspace` → guest-helper 回落共享 `/home/agent/workspace`，可读其他 run 物化残留。修法：
   - `readonly-guest-adapter.ts`：`workspace` 恒发送（`files: input?.files ?? []`）。
   - `guest-helper.py`：`0 < len(files)` 放宽为 `len(files) <= 256`——空 files 合法，仍物化独立 mkdtemp 目录。
   - `readonly-guest-adapter.test.ts` 断言同步更新；helper 结构测试是 Linux-only（本机跳过），改动收窄到边界条件本身。
2. **lint/format 收尾**：`commands.ts` `import type`、kernel/docs prettier 空白（含早期 record/contract 文件归一化）。

## 独立验证（主线程复跑）

| 命令                                                                                                                   | 结果                                                                                                                                                                                                             |
| ---------------------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `vitest run apps/service/src/workflow apps/desktop/src/main/workflow packages/protocol/src/workflow.test.ts`（根目录） | 15 文件 241 测试通过                                                                                                                                                                                             |
| `vitest run apps/desktop/src/main`（根目录，全量）                                                                     | 55 文件 842/842                                                                                                                                                                                                  |
| typecheck ×3（protocol/service/desktop）                                                                               | 通过                                                                                                                                                                                                             |
| eslint + prettier（全部触及路径）                                                                                      | 通过                                                                                                                                                                                                             |
| `pnpm build`                                                                                                           | 通过                                                                                                                                                                                                             |
| `env -u ELECTRON_RUN_AS_NODE playwright test e2e/workflow.spec.ts`                                                     | 5/5：`diagnose-input` 完成+usage；`diagnose-parallel` 并发派发+停止清理确认；saved 命令 新建→待批准→批准→运行、编辑→批准失效→再批准→运行；`diagnose-slow` cached 续跑；重启 needs_reconciliation→标记已停止→续跑 |
| `node scripts/check-docs.mjs`                                                                                          | 通过                                                                                                                                                                                                             |

验证方式注意：desktop 测试须从 repo 根目录运行（`e2e/fixtures/sbx.mjs` 相对根解析）；`--filter` 方式会产生假阴性（W4 已记录）。

## 边界（如实声明）

- 并发上限 4 是**派发**层；交付语义仍严格 callSeq 有序——`Promise.race` 对脚本作者是"先登记者赢"，非"先完成者赢"（P0a 合同已声明）。
- `pipeline` 阶段主序是语义代价（stage 是 VM 闭包，须回送结果才能算下一阶段 prompt），产品面如实暴露。
- E8 活跑、真实 sbx live、写类调用、lane/shared 候选目录、ACP workflow、MCP 面、回推指挥会话、Ultra 均未做。无 commit/push。
