---
version: alpha
name: Web Studio Lab
description: 保留全局板块的 macOS 工作台，空间内使用统一垂直标签与多窗格
colors:
  background: '#ffffff'
  text: '#1d1d1f'
  primary: '#0a67d1'
typography:
  sans:
    fontFamily: "-apple-system, BlinkMacSystemFont, 'SF Pro Text', 'PingFang SC', 'Hiragino Sans GB', 'Helvetica Neue', sans-serif"
  mono:
    fontFamily: "'SF Mono', Menlo, Consolas, monospace"
omitted:
  - section: spacing
    reason: 沿用现有 app.css 几何，不建立第二套 token
  - section: rounded
    reason: 沿用现有共享组件
  - section: components
    reason: 组件契约见下文与 UX-CONTRACT.md
---

# Web Studio Lab 设计上下文

用户已经确定 UI/UX。本轮按 [SR-1](docs/acceptance/space-remake/SPEC.md) 恢复升级前的全局布局，空间内部保留升级视觉与切换逻辑。原设计与 v0.3 原型仍保留在 `docs/design/2026-10-06-workbench-v0.3/`，不重新定义其历史交付；重制历史见[SR-1记录](docs/acceptance/space-remake/task-summary.md)；后续资源与观察整合见[INTEGRATION-1](docs/acceptance/integration-20261008/SPEC.md)，继续使用同一视觉与六板块结构。

## Overview

面向开发者的 macOS 工具工作台，中文界面、系统中文字体、低饱和边框，健康状态用语义形状，需要处理的状态用文字。以运行页面和工作现场为中心；白、暗、暖主题保持同一层级。避免营销大标题、装饰渐变和浮动终端窗口。

## Colors

`apps/desktop/src/renderer/src/styles/app.css` 是运行时 token 权威；本文件只镜像白色主题的 `--content`、`--text`、`--accent`。`html[data-theme]` 切换共享语义 token，跟随系统读取 matchMedia。xterm 直接从 CSS 读取这三个 token 及 `--accent-soft`，主题改变时同步；不维护独立主题值。主题在设置页编辑，并明确归属当前空间；B5 快捷键命令面板增加当前空间白 / 暗 / 暖主题循环命令，沿用同一 setPreferences 与 token，不新增偏好所有者。该阶段窗口验证结果见 [B5 审查历史记录](docs/acceptance/simplify-ops-20261022/README.md)（原审查材料仅本地保留）。

## Typography

UI 使用系统中文字体；命令、路径、shell 输出使用 `--mono`。长路径和错误可换行，终端保留字符格宽和自身滚动。

## Layout

全局保留首页、空间、资源、会话、任务和底部设置，56px 按钮列与空间内252px垂直标签作为整组左栏。52px 顶栏保留红绿灯和拖动区域；空间名称只打开切换器，没有重复横向标签。其他页面保持原有页面分组，不显示空间标签。

空间侧栏标题右侧集中放置网页、终端、会话和 App 四个图标按钮，使用共享 Icon、icon-btn 与主题 token，提供中文可访问名称和悬停提示。长空间名让出按钮空间并可查看完整名称。App 创建与管理在按需打开的对话框中展示，不再常驻侧栏底部；底部通用新建标签入口保留文件与 SSH 等类型。按 [OPS-1](docs/acceptance/simplify-ops-20261022/SPEC.md) 合同：底部新建标签已改为 Main 原生菜单列出全部类型（B2 已实施），选择类型后打开预选该类型的既有表单并预填有效默认环境；网页、终端、会话三个侧栏按钮直接创建并自动命名。终端仅在默认环境有效时直接创建，否则回到表单显式选择；文件与 SSH 等需要补充信息的类型仍打开既有表单。底部表单允许自定义网页名称与地址，该名称保持手动模式；快捷新网页跟随页面标题，双击、F2 与标签菜单共用侧栏就地重命名。标签悬停或键盘焦点进入时显示关闭按钮，预留几何避免标题移动；编辑复用 field、btn 和现有主题 token。浮动侧栏鼠标单击立即激活标签、延迟 500ms 收起以允许双击，键盘激活仍立即收起。实现与本轮验证见 [B5 剩余项审查历史记录](docs/acceptance/simplify-ops-20261022/README.md)（原审查材料仅本地保留）。原生菜单使用系统外观，不新增自绘菜单样式；App 按钮图标本轮不变。

左栏与340px通知栏各自支持固定、临时浮层、收起，图钉是固定偏好的唯一控制。左上标题栏的品牌标识按钮控制 Workshop，右上铃铛按钮控制通知；收起时不保留边缘把手或空栏，内容区使用释放的宽度。原生网页为临时浮层让位；固定时参与布局，临时浮层贴内容区左右8px。通知不承载会话输入。1080px以下只展示活动窗格并以浮层使用侧栏，不修改已保存的分割树与固定偏好；放宽恢复。终端为普通空间标签，滚动由 xterm viewport 拥有。

## Elevation & Depth

沿用白色内容面、线条和既有控件阴影，不增加装饰层级。

## Shapes

沿用既有按钮和 10px 内容面边角。

## Components

品牌标识采用四笔流动 W 与半透明冷色磨砂玻璃圆角底板，渐变只属于标识资产，不扩展为工作台配色。可编辑源在 `apps/desktop/resources/branding/logo.svg`，24px 顶栏与 favicon 使用简化的 `logo-small.svg`；首页沿用原问候语，旁置 64px 标识。两处通过共享 `BrandLogo` 展示；顶栏标识属于可聚焦的侧栏按钮，首页标识仍为装饰。Dock 与 macOS 安装包沿用同一资产导出，外部圆角之外保留透明像素。

导出工具与资产边界见[资产说明](apps/desktop/resources/branding/README.md)，本轮验证见[品牌实装记录](docs/verification/2026-10-10-branding.md)。

复用 `.btn`、`.row`、`.muted`、共享 Icon、StatusDot / StatusSlot 和 app-owned dialog。左右容器使用相同的固定/浮层状态规则。终端开关、忙态、关闭后的所属进程清理确认和错误见 `UX-CONTRACT.md`；chat 工具详情用原生 details 按需展开。全局滚动条由 app.css 控制，保留 forced-colors 系统选择。

[账户资源归属合同](docs/acceptance/resource-ownership-20261010/SPEC.md)保持以上外壳与 token：全局“资源”页呈现用户主动收藏，按开发资源、网页和文档浏览；空间页在活跃标签之外用折叠区呈现空间资源及连接。后台实例继续单独显示运行事实，不能用收藏状态暗示正在运行。空间连接、收藏和参考版本采用相同的共享按钮、行内状态及原生 select，不新增全局导航或专用配色。

## Do's and Don'ts

文件标签和会话观察区使用现有内容面、系统字体、语义token和状态槽；失败与更新提示显式呈现，来源、范围与散列按需展开。不要把 ID、原始枚举、内部证据引用或结构化现场 JSON 放进产品界面；它们属于诊断面板。环境选择使用既有原生select习惯，凭据与宿主内部调用不进入常规产品流程。不要为观察功能重建外壳、右侧会话或独立配色系统。
