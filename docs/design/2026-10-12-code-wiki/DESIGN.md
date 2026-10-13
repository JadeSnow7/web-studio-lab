---
version: alpha
colors:
  primary: '#0a67d1'
  paper: '#ffffff'
  sidebar: '#f6f7f9'
  text: '#222d3b'
  muted: '#697587'
  border: '#e1e5eb'
typography:
  body:
    fontFamily: '-apple-system, BlinkMacSystemFont, "PingFang SC", "Microsoft YaHei", sans-serif'
    fontSize: '14px'
    lineHeight: '1.65'
  code:
    fontFamily: '"SFMono-Regular", Consolas, monospace'
rounded:
  surface: '10px'
omitted:
  - section: spacing
    reason: 'Geometry is owned by scoped runtime CSS.'
  - section: components
    reason: 'Buildless read-only prototype, no external component system.'
---

## Overview

只适用于本目录的 Code Wiki 交互原型，沿用仓库工程工具语汇：白纸、浅灰侧栏、细线与蓝色选择。视觉中心为点网格上的模块关系；不使用营销 hero、装饰渐变与虚构统计。

## Colors

`styles.css :root` 是运行时 token 权威。上面值对应 `--blue / --paper / --sidebar / --ink / --muted / --line`；使用 CSS 变量，无独立主题副本。强制颜色模式保留系统颜色。

## Typography

中文系统字体用于说明，monospace 用于路径、版本、源码。正文14px，模块说明12px，地图次要说明11px；页面标题26px。遵循现有产品中文字体约定。

## Layout

桌面左栏220px，地图加右侧292px详情。窄屏侧栏成为顶部导航，地图独立横向滚动，详情自然排列。源码对话框独立滚动，页面不横向溢出。

## Elevation & Depth

界面靠细边框建立层次；模块节点轻微阴影，选中边与节点用蓝色，且提供文本及 aria 状态。

## Shapes

主表面10px圆角，节点8px，控制6px。无 pill 堆叠。

## Components

Native button 与 input 承担交互；浏览器 dialog 管理焦点隔离，应用管理源码内容与关闭焦点恢复。全局滚动条 token 覆盖所有本应用滚动区。

## Do's and Don'ts

原型必须明确区分运行通信与源码 import、静态接线与验收。所有按钮都产生可观察结果，不展示模型执行或应用停止按钮。
