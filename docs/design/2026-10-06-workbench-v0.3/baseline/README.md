# Web Studio 工作台设计 · v0.3 基线导出

本目录是 v0.3 增量设计的**基线**：把 claude.ai 上的「Web Studio 工作台设计」artifact 按已发布文件原样导出，供后续在本地副本上增量修改。基线文件不做任何改写；增量修改请复制到本目录之外进行。

## 出处

| 项目     | 内容                                                                                                                                              |
| -------- | ------------------------------------------------------------------------------------------------------------------------------------------------- |
| Artifact | https://claude.ai/code/artifact/8b93cd88-9837-4b1b-a1e3-919ad9fb929e（服务端同一对象也以 https://claude.ai/artifact/JEfair7hR8hvWWLyYmNNHb 寻址） |
| 类型     | Design（canvas），类型发布 `1791227765-3624`，contract `0.2.47`                                                                                   |
| 导出版本 | `1791260337-7503`（导出时的最新版本，即本会话最后一次发布：画板 01 改为可点击原型）                                                               |
| 导出日期 | 2026-10-06                                                                                                                                        |
| 导出方式 | Artifact 服务 `read`（按已发布路径逐个取回）→ 按原路径逐字节复制到 `artifact/`                                                                    |
| 完整性   | `artifact/` 下 27 个文件的 SHA256 与 artifact 服务读取时报告的 SHA256 全部一致；清单见 [SHA256SUMS](SHA256SUMS)                                   |

导出时 artifact 没有上传的资源（asset store 为空），也没有评论线程。

## 目录

```text
baseline/
├── README.md           本说明（非原始文件）
├── board-map.json      画板编号 / 名称 / 文件 / 画布位置 / SHA256 映射（由 canvas.json 生成，非原始文件）
├── SHA256SUMS          artifact/ 与 tools/ 下全部文件的 SHA256（非原始文件）
├── artifact/           ← 原始导出，路径与已发布路径一一对应，未做任何改动
│   ├── project/
│   │   ├── canvas.json         画布索引：标题、11 张画板的位置与尺寸、顺序、画布便签
│   │   └── *.dc.html           11 张画板源文件（HTML + 内联样式 + <helmet> 样式 + 交互脚本）
│   ├── index.html              Design 类型的画布外壳页面
│   ├── SKILL.md                Design 类型的说明
│   └── artifact-type/          Design 类型发布的固定文件（运行时、样式、参考文档）
│       ├── dc-runtime.js       画板运行时（内含 React / ReactDOM）
│       ├── app.js / app.css    画布编辑器
│       ├── reference/*.md
│       └── thumbnail/thumbnail.json
└── tools/
    └── serve-local.mjs         本地预览服务（非原始文件，见下文）
```

`artifact/project/` 是本 artifact 自己的内容。`index.html`、`SKILL.md` 与 `artifact-type/` 属于 Design 类型的发布方，原样保留只为本地渲染与对照，不属于本项目的设计源文件，增量修改时不要改动它们。

## 11 张画板映射

画布坐标单位为 CSS px，每张画板 1440×900、圆角 12；行 A 在 y=0，行 B 在 y=1400，行 C 在 y=2420。

| 编号 | 画板名称（canvas.json `title`） | 文件                            | 画布位置 x, y | 可交互 | SHA256（前 12 位） |
| ---- | ------------------------------- | ------------------------------- | ------------- | ------ | ------------------ |
| 01   | P0 工作台 · 可点击原型          | `project/Main.dc.html`          | 0, 0          | 是     | `97cf5c74a6ba`     |
| 02   | P0 验收通过 · 证据包            | `project/RunPassed.dc.html`     | 1520, 0       | 否     | `f469df82522e`     |
| 03   | P0 失败重试 · 取消等待退出      | `project/RunCancel.dc.html`     | 3040, 0       | 否     | `1aaf8d4f03b9`     |
| 04   | P0 历史记录 · 无模型复验        | `project/RunHistory.dc.html`    | 4560, 0       | 否     | `c4e8f957b6fb`     |
| 05   | 首页 · H-01                     | `project/Home.dc.html`          | 0, 1400       | 否     | `d1236f4d0629`     |
| 06   | 空间 · 平铺与折叠 · S-01        | `project/Space.dc.html`         | 1520, 1400    | 否     | `6734f1829f5d`     |
| 07   | 顶部地址浮层 · Workshop 展开    | `project/Overlay.dc.html`       | 3040, 1400    | 否     | `b8570cb79f2e`     |
| 08   | 资源 · 添加到空间 · R-01        | `project/Resources.dc.html`     | 4560, 1400    | 否     | `022c03bdc306`     |
| 09   | 会话 · C-01                     | `project/Conversations.dc.html` | 0, 2420       | 否     | `4334895a30b4`     |
| 10   | 任务 · T-01                     | `project/Tasks.dc.html`         | 1520, 2420    | 否     | `c606ec3a3c2e`     |
| 11   | 设置 · A-01                     | `project/Settings.dc.html`      | 3040, 2420    | 否     | `a7d3e2d8ec4d`     |

完整 SHA256、字节数与尺寸见 [board-map.json](board-map.json)。画布便签（`canvas.json` 的 `notes`）有三条：行 A 标题、行 B 标题和一条“全部画板均为交互设计示意”的蓝色便签。

注意：各画板 HTML 的 `<title>` 与画布标题不完全相同。例如 01 的 `<title>` 仍是“P0 工作台 · run 验收中”，画布标题是“P0 工作台 · 可点击原型”。这是原稿状态，按原样保留。

## 画板源文件格式

每个 `*.dc.html` 是一张完整的 Design Component 页面：

- `<head>` 中的 `<script src="./support.js">` 加载画板运行时；
- `<x-dc>` 内是画板标记，样式写在元素的内联 `style` 上，公共样式写在 `<helmet><style>` 里；
- 末尾的 `<script type="text/x-dc" data-dc-script data-props='…'>` 是逻辑类（`class Component extends DCLogic`）与属性声明。`{{…}}`、`<sc-for>`、`<sc-if>`、`onClick="{{…}}"` 由运行时解释；
- 01 号画板的交互（切换 C1–C3、Tab 切换、取消 run、新建 run、右栏切换）全部写在它自己的逻辑类里；
- 画板之间的 `<a href="X.dc.html">` 是原型跳转链接。

格式规则详见 [artifact/artifact-type/reference/format.md](artifact/artifact-type/reference/format.md)。

## 在本地打开

```bash
node docs/design/2026-10-06-workbench-v0.3/baseline/tools/serve-local.mjs
```

然后在浏览器打开 `http://127.0.0.1:4173/`。首页列出 11 张画板，点开即可查看单张画板；也可以直接访问 `http://127.0.0.1:4173/project/Main.dc.html`。建议把窗口或视口设为至少 1440×900，画板是固定尺寸。

`serve-local.mjs` 只用 Node 内置模块，不需要安装依赖。它做两件事：

1. 以 `artifact/` 为根目录，按原路径提供文件，不改写内容；
2. 把 `/project/support.js` 映射为 `artifact-type/dc-runtime.js`。

2026-10-06 的实测结果（Claude 内置浏览器，视口 1440×900）：

- 11 张画板都能渲染，宽度 1440，控制台无错误；
- 01 号画板的交互可用：切到 C3 后标题随之变化；点“取消 run”约 3 秒后进入 `cancelled`，并出现“新建 run”；
- 页面没有发起外部网络请求（dc-runtime 自带 React 与 ReactDOM）。

## 缺失项与限制

- **`support.js` 不在导出中。** 画板引用的 `./support.js` 不是 artifact 的已发布文件，由 claude.ai 画布在运行时提供，无法导出。本地预览用 `dc-runtime.js` 代替它，这个映射是本地假设，不等同于原平台行为；视觉以 claude.ai 上的原 artifact 为准。
- **画布外壳 `index.html` 不能离线使用。** 在本地服务下打开它只显示空画布，并有 2 个 404。它依赖 claude.ai 提供的画布数据与接口。本地只能逐张查看画板，不能复现画布的平移、缩放、便签、Play 模式或属性面板。
- **没有导出共享数据库内容。** 类型声明了 `db` 能力，但必须知道集合名才能读取，无法枚举；本设计没有写入过数据库。
- **没有导出编辑器状态与历史版本。** 只导出了当前版本 `1791260337-7503`；之前的版本（画板 01 的静态稿等）没有导出。
- **没有截图或 PDF 导出。** 按要求只导出源文件。

## 临时源对照

本会话发布 artifact 时使用的本地源文件位于会话临时目录 `…/scratchpad/webstudio-canvas/project/`（会话结束后可能被清理）。这 12 个文件（canvas.json 与 11 张画板）与本次导出的 `artifact/project/` 逐字节一致，所以没有另行复制：

| 文件                  | SHA256                                                             |
| --------------------- | ------------------------------------------------------------------ |
| canvas.json           | `7eb8742f6136537b528ae19ffc8a7565f250f6d1ac3a8ece432e10200bbeeda1` |
| Main.dc.html          | `97cf5c74a6baa29ace80db9f92ef2e33511cf8ec6483a73dfa648d584c57e826` |
| RunPassed.dc.html     | `f469df82522eb962bf23d7093785befc2cafd95a4e1536f9abfffb2eaabde829` |
| RunCancel.dc.html     | `1aaf8d4f03b9ab6b103909e0ca0cfddc42dc245e81382078b09cf03601dd66f3` |
| RunHistory.dc.html    | `c4e8f957b6fb9911b54ebfb8ad67d669760e295f3369baa0a6a1562e360d9ce0` |
| Home.dc.html          | `d1236f4d0629ae612138b0eb6f59dede0cdb82d6a30e4efee98b97ac37251738` |
| Space.dc.html         | `6734f1829f5db3c21b1daebc9ce5a40a647f9acd71583444140ead7157d3d8b9` |
| Overlay.dc.html       | `b8570cb79f2eaa3567d64cac565886ced7619b24daf069777c3b7427f19a8c31` |
| Resources.dc.html     | `022c03bdc3062b1704fa94055a89e15c9f966ea96b66491fcd0f7d70f7c2f5fe` |
| Conversations.dc.html | `4334895a30b41b5811516bdfa09e38be05524504f54bfd00bdf25998028f9dd7` |
| Tasks.dc.html         | `c606ec3a3c2e7e22b218c23af24e7d81787f03cbd44955fc89ebec436a333a00` |
| Settings.dc.html      | `a7d3e2d8ec4ddd5c452684f31fef89a01552d9d5486022682a41cafff23176b1` |

## 校验

```bash
cd docs/design/2026-10-06-workbench-v0.3/baseline && shasum -a 256 -c SHA256SUMS
```
