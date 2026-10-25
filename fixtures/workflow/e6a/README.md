# W6b（E6A）候选应用黄金场景

本目录是 W6b「候选发布 → 显式应用到受管 App」的机器可读输入：`scenarios.json` 列出确定性场景与期望结果，由 `apps/desktop/src/main/workflow/application.test.ts` 的 W6b 单测用例和 `e2e/workflow.spec.ts` 的 apply 用例共同实现与断言。仅供离线测试，不含真实模型调用。

## 约定

- `result` 列使用 `WorkflowApplicationError.code`：`ok` / `apply_conflict` / `project_busy` / `app_unavailable` / `apply_failed` / `run_busy` / `candidate_unavailable`。
- `order` 列断言应用事务序：获取项目写租约 → 受管 App 快照 → `computeTree == candidate.baseTree` 核对 → 候选物化 → helper 应用 → journal `apply` 事件 → 释放租约。
- `applyCalled` 断言 helper 是否被调用——冲突、忙、不可用必须在 helper 之前拒绝，候选一字节不写。
- `leaseReleased` 断言所有拒绝路径都释放租约，不留写者占用。
- E6A-11 断言 lane 调用在无 `appTarget` 绑定时内核直接 `call_end failed{unavailable}`，不派发 attempt。

## 覆盖映射

| 场景                        | 单测                                           | E2E                         |
| --------------------------- | ---------------------------------------------- | --------------------------- |
| E6A-01/02/03/04/06/07/08/09 | application.test.ts W6b describe               | workflow.spec.ts apply 用例 |
| E6A-05                      | application.test.ts（appResolver 缺失）        | —                           |
| E6A-10                      | application.test.ts（leaseHeld）               | —                           |
| E6A-11                      | e7-corpus.test.ts E7-114（reject:unavailable） | —                           |
