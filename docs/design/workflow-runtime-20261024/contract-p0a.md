# P0a 冻结合同：Workflow 离线执行内核

状态：2026-10-24 定稿，作为 W1–W2 的唯一实施依据。上游设计见 [修订设计](design.md)，缺陷依据见 [审查记录](README.md)，阶段门槛见 [计划](plan.md)。本合同只覆盖 P0a：顺序执行、仅 readonly、MockHarness、离线无产品接线。任何未列出的能力一律视为不支持，不许以“将来会有”为由提前实现。

- DSL 版本：`lab-workflow/1`。版本变更使既有缓存与运行身份失效。
- 实施边界：只允许写 `apps/service/src/workflow/` 新文件、`fixtures/workflow/` 与本文档；`apps/service/package.json` 只增列 §9 锁定的依赖。不得修改现有源码、配置、GuestWriteLease、协议包或锁文件之外的内容；不得接 UI、真实模型、sandbox live、网络/文件 API 或 Ultra 开关。

## 1. 源格式与静态校验

脚本是单个标准 ES module 文本（UTF-8，≤64 KiB）：

```js
export const meta = { name: '…', description: '…', phases: ['…'], size: 'small' | 'medium' | 'large' };

export default async function main() {
  // 全部脚本逻辑
}
```

加载前用 acorn 解析（`ecmaVersion: 'latest'`，`sourceType: 'module'`），规则全部为拒绝条件：

1. 第一条语句必须是 `export const meta = <纯字面量>`；字面量只含 JSON 可表达的值（对象/数组/字符串/数字/布尔/null），无 spread、无计算键、无标识符引用、无模板字符串。meta 序列化后 ≤4 KiB。
2. 第二条且唯一另一条顶层语句必须是 `export default async function main() {}`；不许有其他 export、import（静态或 `import()`）、顶层副作用语句。函数声明内允许任意合法 JS。
3. `meta.name`、`meta.description` 必填非空字符串；`meta.phases` 可选但出现时必须是非空字符串数组；`phases` 中的标题集合就是合法的 `phase()` 标题全集。
4. 禁用标识符（出现在任何位置即拒绝）：`import`、`require`、`process`、`fetch`、`XMLHttpRequest`、`WebSocket`、`WebAssembly`、`crypto`、`setTimeout`、`setInterval`、`setImmediate`、`queueMicrotask`、`Atomics`、`SharedArrayBuffer`、`Worker`。注释与字符串字面量中的出现不拒绝，但标识符位置的 `Date`、`Math`、`eval`、`Function`、`globalThis` 在 VM 内另有运行时处置（§5）。
5. 静态校验失败的结构化错误：`{ code: 'script_rejected', reason, line, column }`。不进入运行、不写 journal。

示例正例与反例各见 `fixtures/workflow/scripts/` 与 §8 黄金集清单。

## 2. 注入 API 合同

VM 内注入的全局只有 `agent`、`parallel`、`pipeline`、`phase`、`log`、`args` 与 §5 的宿主 prelude；其余标准 intrinsics 保留（Promise、JSON、Array 等），无宿主对象/prototype 泄漏。

### 2.1 结果类型

```ts
type CallId = string; // `${runId}:c${callSeq}`

type AgentResult<T = unknown> =
  | { status: 'ok'; value: T; callId: CallId }
  | { status: 'failed'; code: CallFailureCode; message: string; callId: CallId | null }
  | { status: 'conflict'; files: string[]; candidateRef: string; callId: CallId }; // P0a 永不产出，类型保留

type CallFailureCode =
  | 'invalid_args' // prompt/opts 结构或取值违法，未派发
  | 'unsupported_option' // 当前阶段不支持的能力取值（如 isolation≠'readonly'、未知 harness）
  | 'schema_invalid' // opts.schema 本身不是合法 JSON Schema 子集
  | 'schema_mismatch' // 重试耗尽后输出仍不满足 schema（按 attempts 逐次记录）
  | 'timeout'
  | 'crash'
  | 'rate_limit'
  | 'permission_denied'
  | 'empty_output'
  | 'stopped' // 所属 run 停止时仍在途
  | 'result_too_large' // 单条结果 >1 MiB
  | 'call_budget_exceeded'
  | 'unplanned_call' // MockHarness 无预定响应（测试防护）
  | 'internal';
```

`agent()` 对执行失败永不抛出，只返回 `failed`。抛出只用于 §3 的合同违约。

### 2.2 `agent(prompt, opts?)`

- `prompt`：非空 string，≤32 KiB。
- `opts`：必须是普通对象或缺省。字段：

| 字段             | 规则（P0a）                                                                         | 违约                    |
| ---------------- | ----------------------------------------------------------------------------------- | ----------------------- |
| `harness`        | string；缺省 `'mock'`。P0a 注册表只含 `mock`，其他值 → `failed{unsupported_option}` | 同左                    |
| `profile`        | string ≤64 字符；只记入有效执行语义与 contentKey，不路由                            | 类型错 → `invalid_args` |
| `model` / `tier` | 互斥；tier ∈ `small                                                                 | medium                  | big`；model 为 string ≤64 | 同设 → `invalid_args` |
| `schema`         | JSON 对象 ≤32 KiB，禁止 `$ref`/`$dynamicRef` 键                                     | → `schema_invalid`      |
| `isolation`      | 仅 `'readonly'`；`lane`/`shared` → `failed{unsupported_option}`                     | 同左                    |
| `label`          | string ≤128                                                                         | 类型错 → `invalid_args` |
| `phase`          | 必须 ∈ `meta.phases`                                                                | → `invalid_args`        |
| `timeoutMs`      | 整数 1_000–300_000，缺省 60_000                                                     | → `invalid_args`        |
| `retries`        | 整数 0–5，缺省 0；含义见 §4                                                         | → `invalid_args`        |
| `tools`          | string[] ≤32 项、单项 ≤64 字符                                                      | → `invalid_args`        |

- 校验失败与 `unsupported_option` 的调用照常分配 callSeq、写 `call_start`/`call_end{status:'failed', attempts:0}`，不派发。
- 同一运行内调用总数上限 1_000：第 1_001 个起每次 `agent()` 立即返回 `failed{call_budget_exceeded}`（仍占 seq 并记 journal，由 VM/jobs 预算兜底脚本失控循环）。

### 2.3 `parallel(thunks)` / `pipeline(items, ...stages)`

两者都是 **VM 内 prelude 库函数**，由 `agent()` + Promise 组合实现；宿主不按批次特判。确定性完全由 §3 的交付顺序保证。

- `parallel(thunks)`：`thunks` 为数组，长度 ≤4_096（超出抛 `WorkflowContractError('fanout_too_large')`）。按数组顺序同步调用各 thunk；每个槽位收集 thunk 返回 promise 的落定值；thunk 抛异常或 promise reject → 该槽位为 `{status:'failed', code:'branch_rejected', message, callId:null}`。resolve 值为输入顺序数组。其余分支不受影响。
- `pipeline(items, ...stages)`：`items` ≤4_096（同抛）；stages 可为空（空 → 每项槽位 `{status:'ok', value:item, callId:null}`）。每个元素独立走完自己的 stage 链：第 0 个 stage 的输入是 item 本身；stage k 的 `ok` **value**（不是整个 AgentResult）是 stage k+1 的输入。某槽位在某 stage 得到非 `ok` 的 `AgentResult` → 该元素后续 stage 跳过，槽位=该结果。stage 返回值不是 `AgentResult` → 槽位 `{status:'failed', code:'stage_contract', callId:null}`；stage 抛/reject → `{status:'failed', code:'stage_error', callId:null}`。槽位最终值 = 最后一个成功 stage 的 `AgentResult`（`ok`）或首个失败/冲突结果。
- 语义代价（作者须知）：stage 是脚本闭包，host 每推进一个 stage 都要把上阶段结果送回 VM；在按 callSeq 交付下 pipeline 物理上呈阶段主序，不承诺元素间自由流水。`Promise.race/allSettled` 等未禁止，但 race 在确定性交付下退化为“先登记者赢”，作者文档须注明。

### 2.4 `phase(title)` / `log(message)` / `args`

- `phase(title)`：`title` 必须是字符串且 ∈ `meta.phases`，否则抛 `WorkflowContractError('phase_not_declared')`。只允许在没有活动 fan-out 的主流程调用；在 parallel/pipeline 分支内调用抛 `'phase_in_branch'`。每次合法调用写一条 `phase` 事件。
- `log(message)`：转 string，单条截断到 4 KiB；累计 >256 KiB 或 >2_000 条后丢弃，第一次丢弃时写一条 `log_budget_exceeded` 警告事件。不写日志本身以外的语义。
- `args`：创建运行时传入的 JSON 值深拷贝注入并深冻结；缺省 `null`；其 hash 参与运行身份。

## 3. 确定性、交付与合同违约

- `callSeq`：内核按收到 VM `call` 消息的顺序从 1 递增分配（VM 单线程发出，顺序即脚本调用顺序）。
- 交付：内核/桥把每个 `agent()` 的终态结果（ok/failed/cached 统一）放进按 callSeq 排序的交付队列；VM 每轮 jobs 泵干后，桥只交付“下一个 callSeq”的结果——低序号未交付时高序号的物理完成结果先暂存。这保证：相同 DSL 版本 + 脚本 + args + 输入身份 + 各调用相同终态 ⇒ 相同调用序列与脚本路径。物理启动次序、耗时、token 不参与相等。
- 脚本不可观测：宿主时间、物理完成顺序、调度统计。`Promise.race` 语义因此退化为登记序（§2.3）。
- 悬空调用：main 返回时仍有已登记未交付的调用 → 视为脚本错误，run `failed{script_error}`，已派发 attempt 照常取消清理。
- 合同违约（`WorkflowContractError` 及语法/类型错）在脚本内可被 catch；未被捕获使 main reject → run `failed`，code ∈ `contract_violation`（合同规则）或 `script_error`（其他异常）。资源超限类的 run 失败码单列：§6。
- main 的返回值必须可 JSON 序列化且 ≤1 MiB，超出 → run `failed{result_too_large}`。

## 4. 调用生命周期与重试（P0a）

每次 `agent()` 被校验接受后：分配 callSeq → `call_start` → 查缓存（续跑时）→ 命中：`call_end{cached}` 引用原记录；未命中：逐 attempt 派发直到成功或耗尽。

- attempt 预算 = `1 + retries`，每 attempt 写 `attempt_start`/`attempt_end`。可重试失败：`timeout`、`crash`、`empty_output`、`schema_mismatch`。`rate_limit`、`permission_denied` 不重试，立即 `call_end{failed}`。schema 校验由内核做：MockHarness 产出 `json` 时直接校验；产出 `text` 时若带 schema 尝试解析为 JSON，解析失败按 `empty_output`/`schema_mismatch` 计。
- `stopped`：run 停止时在途 attempt 标记 `stopped`，调用 `call_end{stopped}`；永不在续跑中命中。
- 派发前冻结有效执行语义（harness、profile、model/tier、tools 的解析值）写入 `call_start.effective`；重试不更换。

## 5. 沙箱与资源（VM 侧）

- quickjs-emscripten **非 asyncify** release variant（锁定见 §9），运行在 service 的独立 `worker_threads` 线程；宿主只经有界消息与它通信。
- 注入前处置 intrinsics：`Date`、`Math.random`、`eval`、`Function`、`globalThis` 的能力面收缩为——`Date.now()`/`new Date()` 等一切时间入口、`Math.random()` 调用即抛带指引的 Error；`eval`、`Function` 全局绑定删除；其余 `globalThis` 不变。残留逃逸面（`.constructor.constructor` 链等）属 E2 探测目标，发现可利用即升级设计。
- 内存：`setMemoryLimit(64 MiB)`；超限运行失败 `vm_out_of_memory`。
- CPU：worker 用 `setInterruptHandler` 计量当前同步段 wall-time，>2 s 中断 → `vm_cpu_segment`；累计 VM 执行 wall-time >30 s → `vm_budget_exceeded`。等待 agent 的时间不计。
- jobs：每轮泵循环计数；累计 jobs >100_000 → `jobs_budget_exceeded`（无限微任务链由此兜底）。
- 桥缓冲：已物理完成待交付的结果总量 >16 MiB → `bridge_buffer_exceeded`。

## 6. 预算表与错误码（初值，E5 实测前不定稿）

| 资源                   | 上限                           | 超限结果                                                    |
| ---------------------- | ------------------------------ | ----------------------------------------------------------- |
| 脚本源                 | 64 KiB                         | 加载拒绝 `script_too_large`                                 |
| meta 序列化            | 4 KiB                          | 加载拒绝 `script_rejected`                                  |
| args JSON              | 256 KiB                        | 创建拒绝 `invalid_args`                                     |
| prompt / schema        | 32 KiB / 32 KiB                | `failed{invalid_args}` / `failed{schema_invalid}`           |
| tools / label          | 32×64 / 128 字符               | `failed{invalid_args}`                                      |
| 单结果 / 最终返回      | 1 MiB / 1 MiB                  | `failed{result_too_large}` / run `failed{result_too_large}` |
| VM 堆                  | 64 MiB                         | run `failed{vm_out_of_memory}`                              |
| 单次同步段             | 2 s                            | run `failed{vm_cpu_segment}`                                |
| 累计 VM 时间 / jobs    | 30 s / 100_000                 | `vm_budget_exceeded` / `jobs_budget_exceeded`               |
| 交付缓冲               | 16 MiB                         | `bridge_buffer_exceeded`                                    |
| 逻辑调用数             | 1_000                          | `failed{call_budget_exceeded}`                              |
| parallel/pipeline 规模 | 4_096                          | 抛 `fanout_too_large`                                       |
| 日志                   | 4 KiB/条、256 KiB/2_000 条合计 | 截断/丢弃 + 警告事件                                        |
| 整轮 deadline          | 600 s（可配置更小）            | run `failed{run_deadline_exceeded}`                         |
| 单调用 timeout         | 默认 60 s，最大 300 s          | `failed{timeout}`，按 retries 重试                          |

RunFailureCode（闭集）：`script_error`、`contract_violation`、`result_too_large`（最终返回 >1 MiB）、`vm_out_of_memory`、`vm_cpu_segment`、`vm_budget_exceeded`、`jobs_budget_exceeded`、`bridge_buffer_exceeded`、`run_deadline_exceeded`、`internal_error`。用户停止不是失败：run 状态 `stopped`。

## 7. Journal 与续跑（P0a 持久化）

P0a 用追加式 JSONL 文件实现 journal 端口；每条记录落盘（flush）后才继续后续动作。SQLite 版属 W2，记录形状保持不变：

```ts
type JournalEvent =
  | { t: 'run'; runId; parentRunId: null | string; scriptHash; argsHash; dslVersion; status; failureCode?; result? }
  | { t: 'phase'; runId; seq; title }
  | { t: 'log'; runId; seq; message }
  | { t: 'call_start'; runId; callSeq; callId; phase; label; contentKey; effective; promptHash }
  | { t: 'attempt_start'; runId; callSeq; attempt }
  | { t: 'attempt_end'; runId; callSeq; attempt; status: 'ok' | 'failed' | 'stopped'; code? }
  | { t: 'call_end'; runId; callSeq; status: 'ok' | 'failed' | 'stopped' | 'cached'; code?; result?; cachedFromRunId? }
  | { t: 'deliver'; runId; callSeq }
  | { t: 'warn'; runId; seq; code; message };
```

- `contentKey = sha256(canonical({prompt, effective, schema, isolation:'readonly', label, tools, dslVersion}))`；canonical = 递归排序键的 JSON.stringify。P0a 无写调用，无 writeKey/snapshot 字段（W6 扩展）。
- 续跑：`resumeFrom(parentRunId)` 新建 run，`parentRunId` 链接；要求 scriptHash、argsHash 与被续跑一致，否则拒绝 `resume_mismatch`。沿祖先链载入 `call_end{ok}` 建立 contentKey→result 映射（近祖先优先）。命中即写 `call_start`+`call_end{cached, cachedFromRunId}` 后照常进入交付队列；不得立即 resolve、不得跳过 journal。
- run 的 `status` ∈ `running|stopping|stopped|completed|failed`；`paused` 不在 P0a。
- 停止语义：置 `stopping` → 取消在途 attempt 并等确认 → `call_end{stopped}`、dispose worker、`run{stopped}`。清理未确认不得标 stopped。

## 8. 边界、黄金集与故障矩阵

组件边界（P0a 全在 `apps/service/src/workflow/` 内，Electron 无关）：

- `contract.ts` — 本合同的类型与常量（唯一来源，禁止实现层改写）。
- `vm-worker.mjs` + `vm-bridge.ts` — worker 与桥；只做 VM 生命周期、消息、预算中断；无业务判断。
- `kernel.ts` — 运行状态机、seq/缓存/journal/重试/schema 校验/派发表；通过端口依赖 adapter 与 journal。
- `call-adapter.ts`（端口）+ `mock-harness.ts` — `run(call, signal): AsyncIterable<CallEvent>`；MockHarness 按 `label`（缺省按 prompt 全等）匹配预定响应序列（per-attempt），无匹配 → `fail{unplanned_call}`。
- `journal-jsonl.ts` — 追加+flush 的 journal 适配器。

黄金集（`fixtures/workflow/`；`expected/*.json` 记期望的 callSeq→label→status 序列、run 终态与返回值）：

| 脚本                                                  | 覆盖                                |
| ----------------------------------------------------- | ----------------------------------- |
| `seq-two-calls`                                       | 顺序、phase 边界、return 汇总       |
| `args-echo`                                           | args 注入                           |
| `schema-ok` / `schema-retry`                          | schema 校验与带校验错误的重试       |
| `failed-continue`                                     | failed 结果不中断脚本               |
| `parallel-collect`                                    | 输入序收集                          |
| `pipeline-ok` / `pipeline-mid-fail`                   | 阶段传播、失败槽位短路              |
| `while-until-done`                                    | 数据依赖循环                        |
| `call-budget`                                         | 第 1_001 次调用即失败、脚本正常退出 |
| `result-too-large`                                    | 超限结果 → failed                   |
| `phase-undeclared` / `fanout-4097` / `date-forbidden` | 负例：违约抛出 → run failed         |

故障矩阵（`fixtures/workflow/faults.json` 为机器可读版）：在 attempt k 派发前/中/后、journal 写前后、交付前、VM dispose 后迟到回调、死循环、微任务炸弹、巨型结果、`__proto__` 键的 args 注入点。每点给预期行为；P0a 出口按 plan.md E1/E2/E3 只读子集判据核对。

## 9. 锁定依赖与命令

- `quickjs-emscripten@0.32.0`（发布于 2026-02-16）+ 其传递依赖 `@jitl/quickjs-wasmfile-release-sync@0.32.0`（非 asyncify）。
- `acorn@8.19.0`（发布于 2026-10-05）。只进 `apps/service/package.json` 的 dependencies，lockfile 由 `pnpm --filter @wsl/service add` 生成。
- 验证命令：`pnpm --filter @wsl/service exec vitest run src/workflow`（或仓库相应 vitest 入口）；类型检查 `pnpm typecheck`。
- 禁止替换：若真实 WASM 加载失败，记录失败与环境事实，不得退回 node:vm、mock VM 或删除断言。
