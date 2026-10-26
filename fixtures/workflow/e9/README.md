# E9 端到端收益对照输入（W9，live not_run）

本目录是 E9 分层对照实验（plan.md §62-72）的离线输入与预注册门槛：固定任务集、
B/C 组 workflow 脚本、组级预算表与报告机械的输入口径。**本包不含真实模型调用**；
E9 活跑需要真实模型与 sandbox 授权，未授权前标记 `not_run`——本包只交付输入、
报告机械与预注册门槛。

## 分组定义（plan.md §63-66）

- **A 单 Agent**：每个任务以单个 Agent 调用完成；同 Harness、同模型/推理配置、同工具权限、同输入、同验收、同总预算。
- **B 手写 workflow**：`group-b/<taskId>.mjs`——人工编写的确定性 DSL 脚本（readonly 为主，经得起 analyze）。与 A 共享全部条件，只测编排本身是否有价值。
- **C Ultra 指挥**：`group-c/<taskId>.mjs`——与 B 同构 + `meta.ultra: true` + 指挥提示变体（先判断是否值得编排，指挥调用计入总预算）。固定与 B 相同的单 Harness 条件，单独测规划可靠性与人工介入，不混入模型路由收益。
- **D 多 Harness**：C 之上启用多 Harness 路由；固定各自版本、成本口径与可用路由，单独报告异构能力和成本变化，不能直接归因于 Ultra。

## 配对与记录规则

1. **每组每任务 3 次配对先导**（paired runs）：同一任务的 A/B/C/D 各 3 次，执行顺序随机化；随机化序列与实际时段（`window.startedAt/endedAt`、逐条 `ranAt`）必须随结果记录。
2. 模型别名无法固定实际版本时，记录供应商标识与时间窗口，明确可复现性限制。
3. 规划、失败重试、被停止调用及恢复**全部计入总预算**；超预算（`overBudget`）与基础设施失败（`infraFailure`）分别记账，不从失败分母中删除。
4. 预埋缺陷、期望输出与独立验收脚本提前封存，不给被测 Agent 查看真值；新增批次不重选最优结果。

## 预注册门槛（逐对比较）

对每一对 `挑战组/基准组`（**B/A、C/B、D/C**）分别判定，不能以 B 通过替 C 的失败背书：

- ≥3/4 任务通过率不低于基准组；
- 审计召回（`audit:true` 任务合并口径 TP/期望）严格高于基准组；
- 审计误报率（FP/(TP+FP)）不高于基准组；
- 人工干预（每运行平均 interventions）不增加。

数据不足（任一任务在某组缺 ≥3 次记录）→ 该对判 `insufficient_data`。
**未冻结成本容许值前，E9 只报告数据，不批准 Ultra 默认启用。**

## 文件

- `tasks.json` — 4 个预注册任务：id、描述、工程快照路径、验收判定方式、预算；`audit:true` 标记审计口径任务（预埋真值清单，报告 TP/FP）。
- `group-b/*.mjs` — B 组每任务一份手写 workflow 脚本。
- `group-c/*.mjs` — C 组同构脚本 + `meta.ultra: true` 与指挥提示变体（`direct` 指挥阶段）。
- `budget.json` — 组级预算表；token/成本在成本容许值冻结前记 `unknown`（null）。
- `sample-runs.json` — `scripts/e9-report.mjs` 输入形状的样例记录（供自测，非真实数据）。

## 报告机械输入 schema（scripts/e9-report.mjs）

```jsonc
{
  "schemaVersion": 1,
  "window": { "startedAt": "ISO-8601", "endedAt": "ISO-8601" },
  "groups": {
    "A": { "runs": [RunRecord] },
    "B": { "runs": [RunRecord] },
    "C": { "runs": [RunRecord] },
    "D": { "runs": [RunRecord] }
  }
}
```

`RunRecord`：`{ taskId, pair(≥1 整数，配对序号), ranAt?, passed, overBudget?, infraFailure?,
interventions(≥0 整数), audit?: { expectedFindings, truePositives, falsePositives },
budget: { attempts, wallMs, inputTokens|null, outputTokens|null, cost|null } }`。

用法：`node scripts/e9-report.mjs --input <runs.json> [--report <out.json>]`。
输出逐对比较表与门槛判定（`meets_gate` / `below_gate` / `insufficient_data`）——纯数据机械，
不跑真实模型、不批准任何默认启用。

## Report validation boundaries

The report retains each registered task's `id` and `audit` declaration. Only `audit:true` tasks contribute to recall and false-positive metrics. Audit data on a non-audit task is invalid input. Every required audit task must provide the complete matched pair set with equal truth counts within each pair; missing samples or incompatible truth counts produce `insufficient_data`. Impossible true-positive counts and non-finite, negative or overflowing measurements are rejected. Thresholds (3/4 tasks and at least three paired runs per task) are unchanged.

The existing `sample-runs.json` deliberately remains unchanged. It has no audit samples for `type-fix`, although that task is registered as `audit:true`; all pair verdicts now correctly remain `insufficient_data`. Tests use a separate complete synthetic input to verify the positive and below-gate cases without inventing missing original evidence.

Offline regression entry: `pnpm test:workflow-e9`; it is included in `pnpm test`. The library `buildReport` requires task declarations containing both `id` and `audit`; an id-only list cannot define the audit gate.

Both the pure API and CLI validate task declarations against the committed four-task registration. `--tasks` may read an equivalent copy (order and additional descriptive fields do not matter), but cannot shrink the task set or change an audit flag. It is not a custom-experiment override. Invalid optional failure flags are rejected rather than silently treated as false.

`interventions` is a required non-negative safe integer on every run. Missing or `null` counts are invalid input, never an observed zero; an actual zero remains valid.
