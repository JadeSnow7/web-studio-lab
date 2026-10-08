# Web Studio 工作台增量设计 v0.3

本轮交付独立设计与工程交接。运行、文件改动、证据、人工决定和无模型复验均为确定性“交互演示”，不表示 Electron 已接通真实执行。

## 阅读顺序

1. [D01–D16 差异表](handoff/difference-table.md)：保留、调整、新增、后置及依据。
2. [关键画板与可编辑原型](prototype/README.md)：11 张 Design Component；[本地目录](prototype/index.html)，[主画板源码](prototype/Main.dc.html)。
3. [工程交接表](handoff/engineering-handoff.md)：动作、前置、结果、恢复、数据与依赖。
4. [比赛演示顺序](handoff/demo-script.md)：先真实采集与内存确认，再明确切换交互演示。
5. [实际验证报告](evidence/verification-report.md)：主线程点击结果、发布回读、限制与工程待办。

[原设计](https://claude.ai/code/artifact/8b93cd88-9837-4b1b-a1e3-919ad9fb929e)及其[原始导出](baseline/README.md)保留。[新版副本](https://claude.ai/artifact/XDWKqWoTCxbsq4hf1PRmeZ)已发布（原账号登录可见），版本见 [publication.json](evidence/publication.json)。发布后实际点击发现Claude Design会用Esc退出播放；本地弹窗Esc通过，发布版该项未通过，详见验证报告。

本地 `prototype/` 是本轮权威来源；发布文件必须与 [source-manifest.json](prototype/source-manifest.json) 对应。

## 启动与编辑

在本目录运行 `python3 prototype/serve.py --port 4183`，打开 `http://127.0.0.1:4183/Main.dc.html`。服务仅监听本机，不调用模型、真实业务 API 或进程。若端口已占用，可换其他本机端口。

编辑 `prototype/template.html` 与 `prototype/logic.js`，运行 `python3 prototype/generate.py` 生成11张画板，再运行 `node prototype/check.mjs` 检查状态契约。完整流程在 Main 内保持状态；其余画板是独立起点，切板不继承运行状态。页面外控可重置、推进阶段或注入异常。

产品窗口为1440×900或1024×720；外部演示控制条额外48px，故画布容器高948px，本地完整截图分别为1440×948与1024×768。产品仍使用44顶栏、56导航、360/320 Workshop、340右栏。窄窗右栏默认收起，覆盖面板互斥。

## 本轮变化

从未采集空间页开始；固定C1 priority、C2 owner API权限、C3 dueDate契约；增加现场有效性、固定任务版本、阶段与累计预算、失败反馈、取消清理、证据可读状态、人工决定与来源复验关系。C1完整可点击；C2/C3展示冻结目标及检查定义，执行入口明确说明本轮未制作它们的完整演示路径。资源、会话、设置保持占位，交互终端P1。

新增截图弹窗键盘约束、页面导航/CDP中断恢复、迟到截图和窄窗布局变体。接受只绑定在线通过记录的任务版本与源码；复验记录人工决定为不适用，不继承来源接受。

## 交付边界

只在本设计包新增/修改文件。应用、协议、固定验收、Git忽略规则及历史验证未更改；125个原有文件与28个导出基线文件的摘要复核见 [integrity-result.json](evidence/integrity-result.json)。未提交、推送或打包发布应用。

原始平台虚拟 `support.js` 无法导出，本地以原样 `dc-runtime.js` 映射运行。原画布编辑器外壳、旧版本历史及未枚举的共享数据库未离线导出，详见基线限制。原始设计本身没有上传资源或数据库使用。

原始导出含第三方运行时，Claude导出会话发现仓库全局lint/格式检查会扫描它们而失败。本轮保留原始字节，未改仓库配置；后续工程集成需明确设计归档的检查边界。这不属于应用功能回归通过声明。
