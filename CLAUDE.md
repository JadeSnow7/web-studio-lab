# CLAUDE.md

本文件写给在本仓库工作的 AI Agent（Claude Code 等），人类贡献者请看 [CONTRIBUTING.md](CONTRIBUTING.md)。

## 项目现状

Web Studio Lab 是 OSCHINA 开源大赛 2026 的比赛版。目标是做成一个 Electron 桌面工作台，以运行页面为中心跑通这条闭环：

> 点选页面元素 → 采集现场 → 确认目标与验收 → Codex CLI 修改代码 → 启动与检查 → 预算内修复 → 展示差异、结果和证据，由开发者决定是否接受

在唯一母模板上完成三个固定用例（详见任务计划第 6 节）：

- C1：给任务新增 `priority`（low / medium / high，默认 medium），持久化。
- C2：任务修改权限收紧为只有 owner 可以修改。
- C3：修复前端 `deadline` 与固定契约 `dueDate` 的失配。

当前已有第一版 Electron 界面（`apps/desktop`），Browser 区仍使用演示数据。Codex 对话与交互终端经独立 Node 服务使用指定 sbx sandbox；任务执行编排、母模板、fixture 与固定验收尚未实现。聊天不能作为任务执行或验收通过。排期以任务计划为准：10/11 主闭环止损，10/14 功能冻结，10/16 提交。只做任务计划中的 P0 任务；用户于 2026-10-06 明确要求测试 sbx 终端，当前最小终端切片属于该授权，其余 P1 和排除项不主动去做。

2026-10-06 用户另行明确授权实现并复测公开网页到空间资源、再到既有 Docker Sandbox 的只读访问链路。该扩展的范围、安全边界与验收见 [公开资源合同](docs/verification/2026-10-06-public-resources/SPEC.md)；实现存在不等于真实联网或模型验收已通过。原有任务 run 与比赛固定验收边界不变。

必读文档：

- [docs/plans/2026-10-os2026-task-plan.md](docs/plans/2026-10-os2026-task-plan.md)：比赛版范围、排期与验收的依据。任务编号 T01–T15，三个用例的验收标准，裁剪规则。
- [docs/ARCHITECTURE.md](docs/ARCHITECTURE.md)：进程边界、依赖方向、Electron 安全基线、run 与证据约定。
- [CONTRIBUTING.md](CONTRIBUTING.md)：环境、提交、代码规范、合并前自查。
- `Web_Studio_macOS_Interaction_Design_v0.2`（docx / pdf，仓库根目录）：长期交互设计。本轮只借用其中的壳与交互规则，不整体纳入。

## 目录

| 路径                       | 内容                                                                                | 状态                   |
| -------------------------- | ----------------------------------------------------------------------------------- | ---------------------- |
| `apps/desktop`             | Electron，含 main、preload、renderer（React + Vite）                                | 第一版界面             |
| `packages/protocol`        | Zod schema，所有跨进程数据的唯一定义                                                | 最小协议               |
| `demo/`                    | 演示页面，只供 Browser 区加载演示，与真实运行数据分开                               | 已有                   |
| `apps/service`             | 独立 Node 服务：sbx Codex 对话与终端；run 编排和正式证据管理待实现。不依赖 Electron | 对话已接入；T04 待实现 |
| `templates/task-app`       | 唯一母模板（React + Vite + Hono + Drizzle + PGlite），独立项目，有自己的锁文件      | 待实现（T03）          |
| `fixtures/`、`acceptance/` | 用例初始状态和固定验收。**Agent 不得修改**                                          | 待实现（T03）          |
| `.local/`                  | 运行时工作空间和证据，不提交                                                        | —                      |

## 命令

所有命令都从仓库根目录执行。**入口存在之前不要声称已经运行过。**

```bash
pnpm install --frozen-lockfile
pnpm dev          # 启动 Electron 工作台（开发模式）
pnpm check        # 类型检查 + lint + 格式检查 + 单元测试
pnpm build        # 构建桌面应用（不打安装包）
pnpm test:e2e     # 先 build，再用 Playwright 驱动真实 Electron 窗口
pnpm package      # 生成 macOS Apple Silicon 试用包（未签名）
pnpm test:e2e:packaged  # 对 pnpm package 生成的 .app 重跑同一套 e2e
```

`pnpm verify`、`pnpm revalidate`、`pnpm demo:run` 等入口待 T04 / T09 实现。

## 硬性规则

1. **不修改 `acceptance/` 和 `fixtures/` 来让测试通过**，也不放宽 schema、不预写期望数据、不在重启前重新 seed。确实需要修改时，停下来问用户。
2. **如实报告。** 没跑过的就说没跑过，失败要附上输出。单次成功不能写成通用成功率。历史查看不能说成重新运行。演示数据必须带演示标识，不能冒充真实运行结果。
3. **遵守 Electron 安全基线**：`contextIsolation: true`、`sandbox: true`、`nodeIntegration: false`。预览视图没有 preload，使用独立 session。preload 不直接暴露 `ipcRenderer`。不得为了方便而关闭这些设置。
4. **遵守依赖方向**：
   - `apps/service` 不 import `electron`；
   - renderer 不使用 Node 或 Electron API；
   - `templates/task-app` 和 `acceptance/` 不 import 内部包。
5. **跨进程数据先在 `packages/protocol` 中定义 Zod schema**，类型从 schema 推导。
6. **不自研 Agent 推理循环**，也不做通用运行时、沙箱或多 Agent 编排。主 harness 是 Codex CLI，只通过一个薄 adapter 接入。
7. **子进程必须登记到所属 run**。取消或超时时要等进程真正退出，不按进程名或端口批量结束进程。
8. **不接触密钥。** 不读取、打印或写入 `.env*` 和模型密钥；日志与证据要脱敏。
9. **新增依赖前先确认任务计划的技术栈表**（第 2.2 节）。锁文件与代码同一提交。
10. **从原 Web Studio 仓库迁移内容时写明来源**（基线 `f377db8`），并更新第三方声明。不迁入上游 Swift / Metal / Ghostty 代码。

## 工作方式

- 文档和注释用中文，代码标识符用英文，与现有文件保持一致。
- 提交遵循 Conventional Commits。只有用户要求时才提交或推送。
- 实现与架构约束冲突时，先指出冲突，提出对文档的修改建议，不要静默偏离。
- 任务对应任务计划中的编号时（例如 T04），在提交说明或汇报中注明编号。
