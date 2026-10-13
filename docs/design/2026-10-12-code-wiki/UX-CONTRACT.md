# Code Wiki 原型交互契约

只读本地原型。业务依据：仓库 `docs/ARCHITECTURE.md`、`docs/architecture/current-runtime.md` 与当前引用文件。摘录含未提交修改；不是全仓快照或运行验收。

| Capability | Canonical owner                   | Source of truth        | Allowed variants             | Verification           |
| ---------- | --------------------------------- | ---------------------- | ---------------------------- | ---------------------- |
| Scrollbar  | styles.css 全局规则               | DESIGN.md / CSS tokens | 图与源码独立滚动             | 浏览器计算样式         |
| Search     | app.js renderList                 | URL hash query         | 模块名/职责/路径，本地筛选   | IME / 清除 / 空结果    |
| Navigation | app.js change                     | URL hash               | 页面/模块/关系类型/流程/步骤 | 刷新恢复               |
| Dialog     | native dialog + app.js openSource | sources.js             | 只读源码                     | Escape / focus restore |

选择模块与导航共享状态；源码弹窗不会改变当前选中。搜索不执行任务，不改变业务事实。清除立即返回输入焦点；IME 输入完成后筛选。无结果给出清除恢复方式。所有可用动作均有 hover 与 focus-visible，图的等价模块/连接索引可键盘操作。手机图保留独立横向滚动，页面自然垂直滚动。

每条静态流程只改变阅读步骤；取消命令与停止确认分别呈现。无远程 API、授权、CRUD、异步业务请求，故对应能力不适用。
