# 本项目的 Agent 控制面（自动生成，勿手改）

源码修订 `a8b86f3784ad2c06797c21fff279ddb0a5fbd33f6e2ebd749d0998f2b551b58e`。由 `npm run agent:manifest` 或受管启动的 `build:agent` 生成；源码变化后本文件与 `app.manifest.json` 即过期（stale），依赖它的写操作会被拒绝，需重新生成并重启实例。

## 分工规则

- 语义命令只用于准备数据与观察状态：seed、读 state、读日志、读库。
- 判定“用户能完成某操作”必须经 `app.ui.act` 的 UI 动作，再用状态断言佐证；禁止用语义命令直接制造被验收的行为结果。
- 固定验收基准在你的写入范围之外；自己写的场景只是开发辅助，不算验收通过。
- 新增可交互元素必须带唯一 `data-testid`；新增命令先在 `src/agent/commands.ts` 登记 zod 输入。提交前运行 `npm run agent:check`。

## 工具

MCP 工具 `app_describe`、`app_status`、`app_logs`、`app_restart`、`app_state_read`、`app_command_list`、`app_command_invoke`、`app_ui_snapshot`、`app_ui_act`、`app_data_query`、`app_data_seed`、`app_data_reset`、`app_scenario_run`；shell 中同名 `wsl-app <tool> '<JSON参数>'`。写操作需携带 `appInstanceId`，UI 写动作还需快照返回的 `documentGeneration`；引用目标必须为 `{ref, snapshotId}`，snapshotId 取自最近成功快照；新快照或导航后旧引用失效，须重新快照。

## 页面与 testid

- `app-instance-id`（dd，src/App.tsx:84）
- `health-refresh`（Button，src/App.tsx:64）
- `health-status`（p，src/App.tsx:60）
- `project-id`（dd，src/App.tsx:78）

## 命令

- `health.refresh`：重新请求 /api/health 并返回应用服务连接状态（只读观察）

## 状态

- `app.health`

## API 路由

- `POST /api/dev/session`
- `GET /api/health`
- `GET /api/kv/:key`
- `PUT /api/kv/:key`

## 数据模型

- `records`：user_id text not null，key text not null，value text not null
- `sessions`：token text not null，user_id text not null，expires_at bigint not null

## 检查结果

- （无）
