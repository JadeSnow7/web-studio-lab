# Codex CLI 对话验证记录

2026-10-06。当前工作树已接入真实 Codex CLI 对话，并已在 Electron 输入框完成中文回复、上下文续聊和新会话隔离实测。验收依据是同目录 [SPEC.md](SPEC.md)；本记录仅覆盖普通对话切片，不代表任务执行或整款产品验收。

## 交付与源码基线

- 交付目录：`/Users/huaodong/.codex/worktrees/9630/web-studio-lab`；初始 HEAD `536f0a1948e522a09310aa20784ec512476dc7be`。
- 已有 UI 来自主 checkout `/Users/huaodong/workspace/web-studio-lab` 的未提交快照，来源 HEAD `643c1e2baedbc0129c21404665de8ff69c69b472`。快照为 231 个文件；导入前指纹和原始文件备份位于 `.local/codex-chat-baseline/`。不能用这两个 Git HEAD 代替未提交源码的身份。
- 实现后按原指纹复查来源 231 个文件，全部未变；证据为 `.local/codex-chat-evidence/source-preservation.json`。没有回写主 checkout、提交、推送或发布。
- 普通对话通过独立 Node service 调用 CLI，Electron main 装配服务，受限 preload 提供具名 API，renderer 投影服务会话。个人与空间使用不同会话；首页、会话页和空间右栏复用消息组件。

## 检查与实测

| 范围                       | 结果与证据                                                                                                                                                                                                                                                                  |
| -------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 实现前基线                 | 类型检查、构建、46 个单元测试及 10 个 Electron E2E 通过。原 `check` 因封存设计 JS 被 lint 扫描失败，原格式问题及沙箱启动失败均保留于 `.local/codex-chat-baseline/`。                                                                                                        |
| 类型、lint、格式及单元测试 | `cleanup-check.log`：全部通过，10 文件、63 测试，包含清理失败后禁止重置/新发送/假成功关闭的回归。                                                                                                                                                                           |
| 构建与 Electron 回归       | `cleanup-e2e.log`：构建成功；13 通过、1 条真实模型测试按默认策略跳过。涵盖聊天 fixture、原 Browser/点选/任务确认/草稿/菜单/窄窗口回归。最后加强的窄窗口测试另见 `narrow-fixture-e2e.log`，1/1 通过。                                                                        |
| 真实 CLI                   | `.local/codex-chat-evidence/cli/`：真实中文回复；显式 resume 恢复线程，第二轮正确返回第一轮提供的校验词。初次 stderr 中模型目录请求曾超时，随后推理成功，不把目录请求报告为成功。                                                                                           |
| 真实 Electron 对话         | `.local/codex-chat-evidence/live-electron-final.log`：最终构建 1 通过，41.2 秒（早一版的成功日志保留为 `live-electron.log`）。通过可见输入框发送随机校验词，次轮正确回忆；开始新对话后回答没有先前校验词。测试退出码为 0。                                                  |
| UI 检查                    | 主线程查看 `chat-live-multiturn-final.png`、`chat-live-new-final.png` 与原首页基线，确认沿用原布局、消息可读、输入与新会话操作可达。fixture 窄窗口截图为 `chat-fixture-final.png`：关闭既有右栏浮层后，通过普通点击新建对话和发送按钮得到回复，未用强制点击替代可达性验证。 |
| 自动 UI 审计               | 实现前后均为 322 项既有发现；其中 7 项涉及应用，其余主要来自封存设计原型。未新增发现，不把该审计报告为整体通过。原型没有为通过审计而重写。                                                                                                                                  |

上述日志位于 `.local/codex-chat-baseline/`（若表内无其他前缀）；截图另存于 `.local/codex-chat-evidence/`。这些本机证据被 Git 忽略，不含登录凭据；不承诺随源码克隆分发。

源码指纹保存于 `.local/codex-chat-baseline/final-source-SHA256SUMS`（相对导入快照的 38 个实现文件），最终测试后复核一致。主线程复核 renderer/IPC/构建差异，独立复核 service/desktop 生命周期；发现的准备阶段取消竞态、关闭入口、终止升级、清理失败传播均已修复并复验。没有把该限定审查扩展为全仓库审查。

固定验收项的证据边界：CHAT-01/02 使用真实模型；CHAT-03/04 的取消、迟到消息、缺 CLI、协议及退出错误使用受控真实子进程 fixture 和 Electron 窗口；CHAT-05/06 使用会话投影、草稿、键盘事件和窗口测试。模拟 IME composing 事件通过，不等于对所有系统输入法的人工测试。

## 当前限制

- 本机 CLI 为 `codex-cli 0.160.0`，复用已有 ChatGPT 登录；没有固定或验收具体模型名称。系统开发工具运行于 Node 26.5.0，Electron 44.5.1 内嵌 Node 24.21；尚未在独立 Node 24 开发环境复验，也未验证本次变更的安装包。
- 应用消息只保留本次启动；新建对话清空当前应用槽位，不删除 CLI 自己管理的历史文件。空间对话尚不自动附带项目文件或 Browser 现场。
- JSONL 按完成消息显示回复，没有伪造逐 token 流式输出。真实任务执行、自动修改代码、固定验收和接受流程仍未接入。
- 普通取消和正常关闭有进程清理验证；service 硬崩溃或被 SIGKILL 后，其 detached Codex 子进程组没有由 main 接管清理。本轮没有证明完整硬崩溃恢复。

## 复验入口

```bash
pnpm check
pnpm test:e2e
WSL_LIVE_CODEX=1 pnpm exec playwright test e2e/chat.spec.ts --grep 'live：'
```

真实模型命令要求已登录 CLI、网络及原生 Electron 窗口权限，会实际请求模型。默认回归使用 fixture，不消耗模型。启动入口为仓库根目录 `pnpm dev`。已另行启动当前构建并通过原生窗口确认首页显示 `Codex CLI · 对话已连接`，空白输入框可供直接试聊。
