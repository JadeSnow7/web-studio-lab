# Workflow P0a 黄金集与故障注入输入

本目录是 [P0a 冻结合同](../../docs/design/workflow-runtime-20261024/contract-p0a.md) §8 的机器可读输入：黄金脚本、每脚本的 MockHarness 响应计划与期望运行结果、故障注入点清单。仅供离线测试与 CI 使用，不含真实模型调用。

## 目录

- `scripts/*.mjs` — 黄金脚本，标准 ES module 形式（`export const meta` + `export default async function main`）。
- `expected/*.json` — 每脚本一个期望文件：`status`（run 终态）、`calls`（期望的 `callSeq → label → status` 序列，含 cached）、`result`（main 返回值，深度相等比较）。
- `faults.json` — 故障注入点与预期行为；测试驱动器在每个注入点拆分运行并断言。

## 约定

- MockHarness 按计划按 `label`（脚本必须给每个 `agent()` 调用稳定 label）匹配响应；`attempts` 数组逐次消费，耗尽后重复末项。无匹配 → `unplanned_call`。
- 响应形状：`{ "text": "…" }` 纯文本；`{ "json": … }` 结构化（参与 schema 校验）；`{ "fail": "timeout|crash|rate_limit|empty_output|schema_bad|permission_denied" }`。
- 期望中的 `calls` 只断言逻辑序列与终态，不断言物理启动次序或耗时。
- 负例脚本的期望 `status` 为 `failed` 并带 `failureCode`。
