# 标准应用的 Agent 约定

本项目由 Web Studio Lab 标准模板生成，内建 Agent 控制面。具体页面、命令、状态、API 和数据模型清单由构建生成在 [agent/AGENTS.md](agent/AGENTS.md) 与 `agent/app.manifest.json`；先调用 `app_describe`（或 `wsl-app describe`）确认它们与当前源码一致（未 stale）。

## 规则

1. 语义命令（`app_command_invoke`、`app_data_*`）只用于准备数据与观察状态：seed、读 state、读日志、读库。
2. 判定“用户能完成某操作”必须通过 `app_ui_snapshot` → `app_ui_act` 的 UI 动作完成，再用 `app_state_read` 或 `app_data_query` 佐证。禁止用语义命令直接制造被验收的行为结果。
3. 固定验收基准在你的写入范围之外；你写的 `app_scenario_run` 场景只是开发辅助，不算验收通过。
4. 写操作都要带当前 `appInstanceId`；UI 写动作还要带快照返回的 `documentGeneration`。引用目标必须为 `{ref, snapshotId}`，snapshotId 取自最近成功快照；新快照、导航或实例重启后旧引用失效，须重新快照。返回 `paused_by_user` 时用户正在操作页面，停止 UI 动作并说明原因。
5. 修改源码后 manifest 与运行实例都会过期：运行 `npm run agent:manifest` 更新描述，用 `app_restart` 让实例按当前源码重建，再用 `app_status` 等待运行。
6. 新增可交互元素必须带唯一的 `data-testid`；新增命令先在 `src/agent/commands.ts` 登记说明与 zod 输入，再在组件里用 `useAgentCommand` 绑定；只读状态用 `useAgentState` 暴露。完成前运行 `npm run agent:check` 与 `npm run check`。
7. `app_data_reset` 会清空本实例数据，只有用户在任务允许范围中写明 `app.data.reset` 时可用。

## 后端 CLI

`npm run agent -- <命令>` 在应用停止时直接操作本实例数据目录；应用运行时会拒绝打开被占用的数据目录，请改用控制面工具。命令：`describe`、`manifest [--write|--check]`、`db migrate|seed|reset|snapshot`、`db query "<只读 SQL>"`、`api call <方法> </api/...> [--body JSON] [--as A|B]`。输出为单行 JSON。
