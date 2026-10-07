# 演示页面

`taskflow/` 是一组静态页面，只供工作台 Browser 区在没有生成 App 时演示加载、刷新、导航、点选与截图。

- 由 Electron 主进程通过 `wsl-demo://taskflow/` 协议提供，只注册在 Browser 区的独立 session 上。
- 不是母模板（`templates/task-app`，待 T03 实现），不读写数据库，也不调用任何 API。
- 页面里的任务、成员和截止日期都是固定示例。“截止日期”一列故意读取了错误字段 `deadline`，用来演示 C3 的现象和控制台错误采集，不代表 C3 fixture。
- 不参与固定验收，也不能作为任何用例通过的证据。
