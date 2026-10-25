# W7（E5）多 Harness 调度黄金场景

本目录是 W7「多 Harness 调度」的机器可读输入：`scenarios.json` 列出 3 Harness × 2 Profile 路由矩阵下的确定性场景与期望结果，由 `apps/service/src/workflow/scheduler-e5.test.ts` 用 RoutedAdapterPool + 真实内核（MockHarness 成员）实现与断言。仅供离线测试，不含真实模型调用。

## 约定

- 矩阵 harnessId 用 `ha`/`hb`/`hc`，profileId 用 `<harness>:default` 与固定 UUID（均符合 `HarnessProfileIdSchema`）。
- `hang` 成员不产终态（模拟资源/账号不可用且永不放行）；其他成员用 MockHarness 响应计划。
- 断言统一口径：同一 profileId 任意时刻在飞 ≤1；绝对 deadline 不被排队/重试/换 Profile 重置；所有场景有限终态；每个 `attempt_start` 记录 `route`；显式 Harness/Profile 不被静默替换。

## 覆盖映射

| 场景     | 断言要点                                        |
| -------- | ----------------------------------------------- |
| E5-01    | 200 混合调用完成、逐成员在飞 ≤1、route 记录一致 |
| E5-02    | 永久 429 有限失败、不重试、不改派               |
| E5-03/04 | 全池耗尽 → call timeout / run deadline 有限终态 |
| E5-05    | permission_denied 不重试                        |
| E5-06    | 越界 harness → unsupported_option（含空池路径） |
| E5-07    | 同 profile FIFO 串行                            |
| E5-08    | stop 停止等待者，未派发即 stopped               |
| E5-09    | 冻结语义：effective.profile == route == 成员    |
