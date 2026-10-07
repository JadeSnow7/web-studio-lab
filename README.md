# Web Studio Lab

Web Studio Lab 是基于 [Web Studio](https://github.com/JadeSnow7/Web-Studio) 既有设计与工程经验规划的 Electron 桌面工作区，面向 [OSCHINA 开源大赛 2026](https://www.oschina.net/os2026/) 的新路线探索。

当前工作树处于初始化阶段，包含项目说明、架构与开发规范、文档检查脚本、忽略规则与 Apache-2.0 许可证。以下应用能力均为规划目标；本工作树没有可运行的 Electron 应用、依赖清单或安装步骤。其他本地分支及主 checkout 的未提交实现与本树分开记录，见[审查基线](docs/architecture/baseline-2026-10-06.md)。

## 规划目标

- **Workshop / Browser 双区**：Browser 展示和操作网页、文件、终端等工作资源；Workshop 承载当前会话、任务进展、修改和审阅。导航入口不等同于业务模块。
- **TypeScript 全栈**：用 TypeScript 组织桌面主进程、preload 桥接、界面和共享数据契约。
- **实时渲染与调试**：规划开发服务生命周期管理、文件变化与构建状态、热更新预览、前后端诊断及调试上下文关联。

Electron 宿主、浏览器内核与终端适配所需的原生能力会单独选型；“TypeScript 全栈”表示应用层的实现方向。

首版只打通固定 TypeScript 全栈模板、单项目、单 Agent 串行的“提出需求 → 修改代码 → 运行 → 验证 → 审阅”。优先复用现成 Harness，不要求当前依赖 Rein、Veriflow 和原生 Web Studio 三个仓库。

## 开发与架构入口

- [AGENTS.md](AGENTS.md)：人类与 AI Agent 开始工作的约束和实际命令。
- [CONTRIBUTING.md](CONTRIBUTING.md)：开发流程、编码要求、风险验证、完成标准。
- [架构基线](docs/ARCHITECTURE.md)：业务模块、分层、状态所有权、进程与权限。
- [ADR-0001](docs/architecture/adr/0001-modular-monolith.md)：重要取舍及与旧草案的过渡。
- [增加任务优先级的用例走查](docs/architecture/task-priority-walkthrough.md)：文档级责任与交接验证。
- [基线与验收记录](docs/architecture/baseline-2026-10-06.md)：当前事实、检查结果与未实现项。

当前本地检查（需 Node，无 npm 安装步骤）：

```sh
node scripts/check-docs.mjs
git diff --check
```

这些命令只检查规范文档入口、链接和空白；不代表应用类型检查、架构源码检查或产品验收已通过。首次接入源码和工具链时必须同步上述入口；历史计划中的 `pnpm` 命令不能直接当成本树已有脚本。

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

本项目采用 [Apache License 2.0](LICENSE)。原项目在上述固定基线下也提供 [Apache-2.0 许可证](https://github.com/JadeSnow7/Web-Studio/blob/f377db874f0ecba3390804146776b5e5786d2f86/LICENSE)；其第三方依赖适用各自许可证，可查阅原项目的 [第三方声明](https://github.com/JadeSnow7/Web-Studio/blob/f377db874f0ecba3390804146776b5e5786d2f86/THIRD-PARTY-NOTICES.md)。当前初始化未引入这些依赖。
