# Web Studio Lab

Web Studio Lab 是基于 [Web Studio](https://github.com/JadeSnow7/Web-Studio) 既有设计与工程经验规划的 Electron 桌面工作区，面向 [OSCHINA 开源大赛 2026](https://www.oschina.net/os2026/) 的新路线探索。

当前仓库尚无可运行的 Electron 应用。已建立[首个 vertical slice 验收基线](docs/acceptance/README.md)，包含固定页面 fixture、Zod 契约、测试依赖和实现前失败记录；其中的安装与运行命令只用于验收基准。以下产品能力均为规划目标，尚未实现。

## 规划目标

- **Workshop / Browser 双区**：Workshop 承载项目编辑、Agent 协作、终端与构建诊断；Browser 承载持续的页面预览、导航与调试。
- **TypeScript 全栈**：用 TypeScript 组织桌面主进程、preload 桥接、界面和共享数据契约。
- **实时渲染与调试**：规划开发服务生命周期管理、文件变化与构建状态、热更新预览、前后端诊断及调试上下文关联。

Electron 宿主、浏览器内核与终端适配所需的原生能力会单独选型；“TypeScript 全栈”表示应用层的实现方向。

## 来源与继承边界

原项目：[JadeSnow7/Web-Studio](https://github.com/JadeSnow7/Web-Studio)。

参考基线固定为 [`f377db874f0ecba3390804146776b5e5786d2f86`](https://github.com/JadeSnow7/Web-Studio/tree/f377db874f0ecba3390804146776b5e5786d2f86)。本仓库从独立 Git 历史开始，当前没有迁入原项目源码、设计文档正文或二进制资产。

优先参考以下已形成的设计契约：

- 工作区、资源描述、运行实例与可见区域分别拥有身份和生命周期。
- 资源切换保留会话；关闭视图与关闭底层资源分开处理。
- Agent 请求使用显式确认的有界快照，保持请求不可变，忽略取消后的迟到结果。
- 持久化恢复描述，不自动恢复终端进程；保存需要处理版本与并发修订冲突。

原项目的通用双栏布局与 Swift/macOS 实现需要重新设计或适配，不能直接视为已完成的 Workshop / Browser 或 Electron 实现。

固定基线下的设计入口：

- [产品与结构设计（DESIGN.md）](https://github.com/JadeSnow7/Web-Studio/blob/f377db874f0ecba3390804146776b5e5786d2f86/DESIGN.md)
- [交互契约（UX-CONTRACT.md）](https://github.com/JadeSnow7/Web-Studio/blob/f377db874f0ecba3390804146776b5e5786d2f86/UX-CONTRACT.md)
- [源码架构导览](https://github.com/JadeSnow7/Web-Studio/blob/f377db874f0ecba3390804146776b5e5786d2f86/docs/source-guide/README.md)

后续迁移将逐项确认资产来源与适用许可，保留对应版权和第三方声明。原项目的本地运行记录、构建产物、环境配置和凭据不属于迁移内容。

## 许可证

本项目采用 [Apache License 2.0](LICENSE)。原项目在上述固定基线下也提供 [Apache-2.0 许可证](https://github.com/JadeSnow7/Web-Studio/blob/f377db874f0ecba3390804146776b5e5786d2f86/LICENSE)；其第三方依赖适用各自许可证，可查阅原项目的 [第三方声明](https://github.com/JadeSnow7/Web-Studio/blob/f377db874f0ecba3390804146776b5e5786d2f86/THIRD-PARTY-NOTICES.md)。本仓库未迁入这些上游依赖；本次新增测试依赖及版本由 `package.json` 和 `package-lock.json` 单独记录，适用各自许可证。
