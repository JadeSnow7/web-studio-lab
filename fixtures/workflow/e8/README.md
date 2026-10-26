# E8 结构化输出验收夹具（W5，live 未授权）

本目录是 E8 验收的离线输入：`scripts/workflow-e8.mjs` 的 prompts × schemas 矩阵。

## 实验定义

- 矩阵：30 条只读诊断/审查类 prompt（`prompts.json`）× 5 个不同形状的 JSON schema（`schemas.json`）= 150 个调用。
- 每个调用经内核 `opts.schema` 校验：首次输出不满足 schema（`schema_mismatch`）→ 追加一次修复 prompt 重试一次，仍不合记 failed。
- 判据：150 个调用中**修复后**合法 ≥147，并报告首次合法率（firstRate）、修复后合法率（repairedRate）、失败类别与不确定性。
- 未过判据只说明该 Harness/model/schema 组合未达标，不推及整个 Harness。

## 文件

- `prompts.json` — 30 条 prompt，覆盖诊断、审查、评估、分析四类措辞；全部为只读任务。
- `schemas.json` — 5 个 schema：嵌套对象数组、枚举+分数、平铺 kv 数组、诊断修复对象、计数对象。

## 类别口径

per-call 记录 `{promptIdx, schemaIdx, firstOk, repairedOk, category, attempts}`：

- `firstOk`：首次输出即通过 schema 校验。
- `repairedOk`：首次 schema_mismatch 后，一次修复重试通过。
- `category`：`ok`（firstOk）/`repaired`/`schema_mismatch`（修复后仍不合）/其他 CallFailureCode（timeout、crash、empty_output、rate_limit 等）。
- `attempts`：实际执行次数（1 或 2）。

汇总：`{total, firstOk, repairedOk, totalValid, firstRate, repairedRate, byCategory}`。

## 不确定性

- prompt 措辞与 schema 形状耦合带来的方差：同一 prompt 在不同 schema 上的失败不能相互背书；报告按 (promptIdx, schemaIdx) 全量列出。
- live 需要真实模型与 sandbox：`WSL_WORKFLOW_LIVE=1` + `WSL_SBX_BIN` + `WSL_SBX_NAME` 显式设置才会执行；否则 runner 打印拒绝并非零退出。
- `--fixture` 模式是 MockHarness 自检：验证 runner 全链路（kernel + schema 校验 + 修复重试 + 报告形状），不产生模型结论。
