# 状态降噪与统一状态接口（审核稿 · 修订 2）

状态：**设计已确认，未实现**。本目录只包含方案与设计，不包含源码改动。

- 基线：`codex/consolidate-review-20261011` @ `917f375`（所有行号、字段与测试引用均按此提交核对）
- 修订 1：2026-10-11 首稿
- 修订 2：2026-10-11 按审核意见修订，逐条处理见 [review-response.md](review-response.md)
- 交互画布（同内容的可视版本）：https://claude.ai/artifact/3oahkPNsNSgNBJhLuUkCNm

## 目标

1. **降噪**：健康的稳态不再以常驻文字占据界面；需要用户处理、或改变了用户可做之事的状态显式出现；控制权、进行中与未确认的事实从不被折叠。
2. **统一状态接口**：业务事实投影（Main 与 Renderer 共用）+ 展示投影（Renderer），界面、诊断面板、调试 IPC 与日志共用同一份事实。

不改变的东西：Main 的业务状态所有权、IPC 业务命令、六板块外壳与视觉 token、取消 / 清理 / 归属等运行时语义。

## 决策记录

| # | 问题 | 决定 |
| - | ---- | ---- |
| 1 | 诊断面板入口 | 仅 `pnpm dev` 开发服务器，或显式设置 `WSL_DEBUG_STATUS=1` 时可用；E2E 用的 build 产物与正式包默认关闭（修订 2 细化，2026-10-11 已确认） |
| 2 | 健康终端在侧栏的标记 | 保留绿色实心点 |
| 3 | UX-CONTRACT / DESIGN 中要求常驻显示的条款 | 同意修订，草案见 [contract-changes.md](contract-changes.md) |
| 4 | 实施 | 修订 2 已确认；按 [implementation-prompt.md](implementation-prompt.md) 在独立工作树 `agent/status-surface` 中实施 |

## 修订 2 的主要变化

- 状态槽改为**常驻 / 问题 / 提示**三通道：AI 操控与暂停、进行中、清理或进程未确认不再与错误竞争，也不因交互降级。
- 状态投影拆为**业务事实层**（`apps/desktop/src/shared/status`）与**展示层**（Renderer），补齐历史选择、确认、一次性提示与重置规则；`packages/protocol` 只放 DTO。
- 状态键改为 `domain:entityId:facet`，同一实体的并发条件不再重键。
- `ExecutionStatus` 按原语义作为「能力未接入」说明，不报警。
- 诊断启用判定、raw 白名单、脱敏与大小上限。
- 输入框可访问名称保持不变。
- 新增同数据异常稿与可见性 / 键盘验收清单。

## 阅读顺序

1. [review-response.md](review-response.md)：审核意见逐条处理。
2. [design.md](design.md)：问题清单、状态种类与三通道、各区域改造。
3. [status-interface.md](status-interface.md)：两层投影、键、逐枚举映射、展示状态、诊断通道与数据边界。
4. [plan.md](plan.md)：P0–P4、诊断启用矩阵、E2E 调整、可见性与键盘验收、风险。
5. [contract-changes.md](contract-changes.md)：UX-CONTRACT 与 DESIGN 修订草案。
6. [mockups/](mockups/)：静态设计稿，HTML 可直接用浏览器打开，PNG 为对应截图。
7. [implementation-prompt.md](implementation-prompt.md) 与 [agents.json](agents.json)：Claude Code 实施启动方式与 prompt（主代理 Opus 5.5 / high，子代理 Sonnet 5.5 / high）。

| 设计稿 | 内容 |
| ------ | ---- |
| `before` | 现状空间页，标注 12 处常驻状态 / 规则说明 |
| `after` | 降噪后的空间页（健康状态），编号与现状一一对应 |
| `after-anomaly` | 降噪后的空间页（与 before 相同的异常集合），展示三通道如何保留异常 |
| `tiers` | 状态种类、三通道、StatusDot、按域映射 |
| `flow` | 两层投影的数据流 |
| `status-api` | 接口、落点与数据边界摘要 |
| `debug-panel` | 诊断面板（设计稿标注 ⌥⌘D；实施改为 ⌥⇧⌘D，因 ⌥⌘D 为 macOS 系统快捷键） |
| `rollout` | 分阶段落地、风险与决策 |

设计稿中的任务名、回复内容、ID 与时间为占位或示例数据，不是运行结果。
