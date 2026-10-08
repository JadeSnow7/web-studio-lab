---
version: alpha
name: Web Studio Lab
description: 沙箱对话和交互终端沿用现有 macOS 白色工作台
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

用户已经确定 UI/UX。此文件记录既有身份与本次终端切片；原设计与 v0.3 原型仍保留在 `docs/design/2026-10-06-workbench-v0.3/`，不重新定义其历史交付。

## Overview

面向开发者的 macOS 工具工作台，中文界面、系统中文字体、白色内容面、低饱和边框和语义状态文字。以运行页面和工作现场为中心。避免营销大标题、装饰渐变、全局深色重绘和浮动终端窗口。

## Colors

`apps/desktop/src/renderer/src/styles/app.css` 是运行时 token 权威；本文件只镜像 `--content`、`--text`、`--accent`。xterm 直接从 CSS 读取这三个 token 及 `--accent-soft`；不维护独立主题值。

## Typography

UI 使用系统中文字体；命令、路径、shell 输出使用 `--mono`。长路径和错误可换行，终端保留字符格宽和自身滚动。

## Layout

沿用 44px 顶栏、56px 导航、360px Workshop 和 340px 通信栏；1024px 窄窗沿用现有覆盖侧栏逻辑。终端加入空间既有标签，终端滚动由 xterm viewport 拥有，不改变运行日志视图。

## Elevation & Depth

沿用白色内容面、线条和既有控件阴影，不增加装饰层级。

## Shapes

沿用既有按钮和 10px 内容面边角。

## Components

复用 `.tab`、`.btn`、`.row`、`.muted` 和共享 Icon。终端开关、忙态、关闭确认和错误见 `UX-CONTRACT.md`；chat 工具详情用原生 details 按需展开。全局滚动条由 app.css 控制，保留 forced-colors 系统选择。
