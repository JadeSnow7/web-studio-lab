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

面向开发者的 macOS 工具工作台，中文界面、系统中文字体、低饱和边框和语义状态文字。以运行页面和工作现场为中心；白、暗、暖主题保持同一层级。避免营销大标题、装饰渐变和浮动终端窗口。

## Colors

`apps/desktop/src/renderer/src/styles/app.css` 是运行时 token 权威；本文件只镜像白色主题的 `--content`、`--text`、`--accent`。`html[data-theme]` 切换共享语义 token，跟随系统读取 matchMedia。xterm 直接从 CSS 读取这三个 token 及 `--accent-soft`，主题改变时同步；不维护独立主题值。主题只在设置页编辑，并明确归属当前空间。

## Typography

UI 使用系统中文字体；命令、路径、shell 输出使用 `--mono`。长路径和错误可换行，终端保留字符格宽和自身滚动。

## Layout

全局保留首页、空间、资源、会话、任务和底部设置，56px 按钮列与空间内252px垂直标签作为整组左栏。52px 顶栏保留红绿灯和拖动区域；空间名称只打开切换器，没有重复横向标签。其他页面保持原有页面分组，不显示空间标签。

左栏与340px通知栏各自支持固定、临时浮层、收起，图钉是固定偏好的唯一控制。气泡沿左右边缘出现，原生网页为临时浮层让位；固定时参与布局。通知按钮也是独立气泡，不承载会话输入。1080px以下只展示活动窗格并以浮层使用侧栏，不修改已保存的分割树与固定偏好；放宽恢复。终端为普通空间标签，滚动由 xterm viewport 拥有。

## Elevation & Depth

沿用白色内容面、线条和既有控件阴影，不增加装饰层级。

## Shapes

沿用既有按钮和 10px 内容面边角。

## Components

复用 `.btn`、`.row`、`.muted`、共享 Icon 和 app-owned dialog。左右容器使用相同的固定/浮层状态规则。终端开关、忙态、关闭后的远端清理确认和错误见 `UX-CONTRACT.md`；chat 工具详情用原生 details 按需展开。全局滚动条由 app.css 控制，保留 forced-colors 系统选择。

## Do's and Don'ts

文件标签和会话观察区使用现有内容面、系统字体、语义token和行内状态；来源、范围、失败与更新提示服务于用户判断。环境选择使用既有原生select习惯，凭据与宿主内部调用不进入常规产品流程。不要为观察功能重建外壳、右侧会话或独立配色系统。
