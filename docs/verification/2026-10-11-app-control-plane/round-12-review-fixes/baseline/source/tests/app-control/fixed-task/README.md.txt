# 固定任务基准：欢迎语卡片（app-control-fixed-welcome v1）

本目录是[受管 App 控制面计划](../../../docs/plans/2026-10-11-app-control-plane.md) §3 的冻结基准，位于 guest Agent 写入范围之外。

- `task.json`：冻结的任务文本、允许范围、验收条件、前置数据与 Host 只读核对查询。
- `scenario.json`：Host 经 `app.scenario.run` 确定性回放的固定场景；只用 testid 定位，判定经 UI 动作完成，状态断言仅作佐证。
- `reference/App.tsx`：参考实现，仅用于证明基准能接受正确实现（真实 Electron 集成测试把它复制到临时项目副本），不进入模板或 Agent 上下文。

在原版模板上，场景应在第 2 步（等待 `welcome-value`）失败；在参考实现上全部通过。冻结后不得为通过而修改本目录；方法错误需保留旧版本并另起版本号。
