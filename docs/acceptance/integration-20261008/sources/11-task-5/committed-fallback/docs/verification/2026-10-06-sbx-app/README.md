# Web Studio 使用 sbx 内 Codex 与交互终端

2026-10-06，应用接入验证通过。当前 Electron Lab 对话和终端使用同一个指定 sbx 环境：终端创建随机文件，真实 Codex 通过工具读取并准确回复；终端交互与已登记进程清理通过。本结论限于下述范围；此前独立 CLI 的[安装与读取实验](../2026-10-06-sbx/README.md)保持原样，不作为应用接入证据。

## 范围与实现

固定验收见 [SPEC](SPEC.md)。应用由独立 Node 服务调用 `sbx exec -i`，在 Linux guest 内用 Python 标准库 helper 启动 Codex 或 PTY。两者初始目录均为 `/home/agent/workspace`，不挂载 host 项目。终端 `cd` 会保留在该 shell 内，不改变新 Codex 进程的初始目录；它们共享文件系统。

`WSL_SBX_NAME` 必填，`WSL_SBX_BIN` 可覆盖可执行文件路径；连接核验 sandbox 名称、Codex agent、运行状态与空挂载列表。缺失配置或连接失败时明确不可用。生产通路不再使用 host Codex。对话使用 guest Codex 的 `workspace-write` 模式，保留模板 provider 和宿主 OAuth 代理，不读取或复制 host 认证。

xterm.js 展示真实 guest PTY。取消回复、关闭终端和退出窗口须等待 helper 清理回执；主进程独立记录 `cleanupPending`，服务异常退出不能被当作远端已经停止。helper 清理其所属 session、子孙进程和被 subreaper 接管的孤儿；这不代表停止整个 sandbox 或其他会话。

## 环境与复现

- host：macOS Apple Silicon；构建工具实际为 Node 26.5.0、pnpm 10.34.6，Electron 44.5.1。Node 24 是文档建议版本，本轮没有替换 host Node。
- sbx：`/opt/homebrew/bin/sbx`，v0.47.0；sandbox：`wsl-sbx-smoke-20261006`，Codex agent，2 CPU / 4 GiB，`runtime_mounts: []`。见[测试前 inspect](evidence/sandbox-before.txt)。
- guest 已准备 Node 24.21.0、Codex CLI 0.160.0、Python 3.14.4；具体安装命令见[依赖说明](../../development/dependencies.md)。本轮未重新授权或复制凭据。
- 本轮测试启动显式设置 `WSL_CODEX_BIN=/missing/host-codex-must-not-run`。真实执行仍需结合 guest 版本、工具输出和实际 sbx 路径判断，不能仅凭界面标签判断来源。

从仓库根目录运行：

```bash
npx pnpm@10.34.6 check
npx pnpm@10.34.6 build
npx pnpm@10.34.6 exec playwright test

# 真实 guest 生命周期，不调用模型。
WSL_LIVE_SBX=1 WSL_SBX_NAME=wsl-sbx-smoke-20261006 \
  npx pnpm@10.34.6 exec vitest run apps/service/src/sbx.live.test.ts

# 真实 Electron UI 与模型调用，两个用例按顺序运行。
WSL_LIVE_SBX=1 WSL_LIVE_CODEX=1 \
  WSL_SBX_NAME=wsl-sbx-smoke-20261006 WSL_SBX_BIN=/opt/homebrew/bin/sbx \
  npx pnpm@10.34.6 exec playwright test e2e/sbx.spec.ts e2e/chat.spec.ts --grep 'live：'

# 用户试用。
WSL_SBX_NAME=wsl-sbx-smoke-20261006 npx pnpm@10.34.6 dev
```

实际执行使用本机已缓存的 pnpm 10.34.6 入口；默认 PATH 的 pnpm 版本不同，不能以其结果代替固定版本检查。普通测试默认不调用 sbx 或模型。

## 验证结果

| 基准       | 结果与证据                                                                                                                                                                                                                                                            |
| ---------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| APP-SBX-01 | 通过。实现前契约与原生 UI 失败记录保留，初始 267 个文件没有丢失。                                                                                                                                                                                                     |
| APP-SBX-02 | 通过。fixture 覆盖 sbx 配置、guest cwd、参数、缺 CLI、异常协议、取消与服务退出；禁用 host Codex 路径。                                                                                                                                                                |
| APP-SBX-03 | 通过。真实应用内中文多轮、新对话隔离通过；终端输出 Linux、Node 24.21.0、Codex 0.160.0 和 guest cwd。                                                                                                                                                                  |
| APP-SBX-04 | 通过。应用终端生成随机 nonce；提示仅提供 guest 文件路径，Codex `cat` 该文件并精确回复。宿主测试文件不可见。[原始对话及工具记录](evidence/sbx-live-conversation.txt)、[原始终端](evidence/sbx-live-terminal.txt)、[独立对照判定](evidence/live-evidence-summary.txt)。 |
| APP-SBX-05 | 通过。真实 PTY 从 46×79 调整到 40×75（行×列），Ctrl-C 后 PID 266 不存在、shell 继续运行；切页输出保留，终端关闭为 closed、cleanupPending=false。活动终端直接退出应用的 fixture 通过；真实 helper 后台/脱离 session 后代清理另有独立测试。                             |
| APP-SBX-06 | 通过本次接入范围。类型、lint、格式、92 单元、构建通过；最终 UI 结果由相同产品构建上的回归与定点复验组成，见下文。宽窄终端及真实聊天截图已实际查看。严格 UI 审计仍有 7 项既有问题，见证据边界。                                                                        |

最终文件为 `/home/agent/workspace/wsl-ui-c7c9bcc0-25e5-4610-82f8-8346e0a2f7af/nonce.txt`，随机内容为 `69d40778-8127-4a1f-84e8-273094e36d3f`。工具命令、输出、exitCode=0、最终回复与终端输出相符；聊天最终 idle、error=null、cleanupPending=false。这不依赖只检查助手文本。

截图：[宽窗口终端](evidence/sbx-terminal-live-wide.png)、[窄窗口终端与 Ctrl-C](evidence/sbx-terminal-live-narrow.png)、[真实文件读取回复](evidence/sbx-chat-live-read.png)、[真实续聊](evidence/chat-live-multiturn.png)、[新对话](evidence/chat-live-new.png)。宽窗口来源、终端内容和按钮清晰可见；窄窗口收起右侧通信浮层后可正常输入、调整尺寸和关闭。Python 的 KeyboardInterrupt 是本次 Ctrl-C 测试的预期输出。

最终 [inspect](evidence/sandbox-final.txt) 显示 sandbox 为 running、0 sessions、无运行时挂载。测试应用已退出；本轮没有停止或删除整个 sandbox，guest 工具与测试文件保留。

已保留的基线和检查：

- [实现前契约失败](evidence/backend-baseline-red.txt)、[实现前 UI 失败](evidence/ui-baseline-red.txt)证明本轮新能力在原实现中不可用。
- [类型、lint、格式与单元检查](evidence/check.txt)：92 项单元通过，2 项显式 live 检查默认跳过；[构建](evidence/build.txt)通过。
- [Electron fixture 回归](evidence/ui-fixture.txt)：16 项通过，2 项真实模型用例默认跳过。
- 最终产品构建的[整套 UI 执行](evidence/ui-live-second.txt)中 17 个 fixture 与真实多轮聊天通过，文件共享用例因 PTY 文本解析失败；修正测试解析后又因多条合法 Agent 消息的定位歧义失败，见[第三次记录](evidence/ui-live-third.txt)。最终[定点复验](evidence/ui-shared-file-verified.txt)的纯 PTY 解析、终端 fixture、真实文件共享共 3 项全部通过。后两次只改测试，产品与构建没有变化；不将不同命令的记录合并伪称一次全绿运行。
- [真实 guest 生命周期](evidence/guest-lifecycle-live.txt)：2 项通过，覆盖 PTY 尺寸、持久 cwd、Ctrl-C、普通后台进程和自行 setsid 的后代、非 TTY 取消及控制 stdin EOF。清理后再次在 guest 中检查目标 PID 不存在。

## 保留的失败与修复

首轮 fixture UI 验证发现隐藏的 PreviewHost 仍覆盖终端点击，以及新增 tabpanel 语义造成测试定位歧义；修复后使用原有验收断言复验通过。[首轮失败](evidence/ui-fixture-first-failures.txt)保留。

独立审阅发现主进程若只检查业务状态，会遗漏 failed 状态下尚未确认退出的进程。增加权威 `cleanupPending`、未返回快照的启动请求与初始化 probe 登记。保留 [4 项失败反例](evidence/cleanup-pending-red.txt)、[初始化失败反例](evidence/init-cleanup-red.txt)与[修复后 40 项受影响检查](evidence/cleanup-green.txt)。

首次真实 UI：中文多轮对话通过；终端版本检查失败。xterm 开启 screenReaderMode 时不消费 Playwright `keyboard.insertText` 发出的单独 input 事件，Enter 因而只执行空命令；改为实际按键路径 `pressSequentially`，保留原断言。真实系统粘贴走独立 paste handler，本次失败不证明粘贴失效，系统剪贴板粘贴也尚未验收。该失败后的窗口关闭还发生超时。新增“终端仍运行时直接 app.close”用例在原构建上再次失败；stderr 明确显示服务以 0 退出，但主进程未收到 shutdown 回复。见[真实 UI 首次失败](evidence/ui-live-first.txt)与[活动终端关窗反例](evidence/ui-active-close-red.txt)。修复后由 service 发送清理成功回执并保持存活，main 收到回执才结束本地 utility 并等待退出；同一[活动终端关窗反例复验通过](evidence/ui-active-close-green.txt)。保留[握手顺序单元反例](evidence/shutdown-ack-red.txt)，最终单元回归同时要求 ACK 前退出即使代码为 0 也必须失败。未改动 Electron quit 生命周期，也没有以退出码 0 代替 guest 清理回执。

PTY 的 ANSI 控制序列与 `CRLF+CR` 只在测试断言视图中规范化，原始证据不改写；nonce、PID、canary 和退出标记均匹配完整输出行，纯解析反例防止误匹配回显命令。文件读取时 Codex 可以先发说明，再发最终回答；测试等待最后一条回答，完成后再精确核验该回答与工具记录。

## 证据边界

本轮只验收指定 sandbox 的应用对话、终端和所属进程生命周期。未验收 guest 服务到 Browser 的端口转发、任务 run 编排、C1–C3 固定验收、打包后的安装包、多租户或恶意代码对抗。Browser 仍加载演示页面。对话历史各自独立，文件系统共享；新对话不清除 guest 文件。

Codex 保留模板的非致命警告：`mcp_servers.mcp-gateway.headers/type` 不识别，见原始对话。未修改供应商配置；文件读取通过不代表 MCP gateway 能力通过。一次 inspect 还出现 Docker Hub refresh lock 超时警告，命令返回 0；最终 inspect 和 live 执行成功，未因此修改认证或网络策略。

严格 UI 静态审计仍有 7 项既有问题，均位于本轮未改动的 Composer、BrowserToolbar、RunSummary、TaskSection；[文件指纹比较](evidence/premium-baseline-comparison.txt)确认与基线一致，[完整审计](evidence/premium-audit.txt)保留。它们是表单 noValidate 与 textarea resize 标记，不将 scoped 接入通过写成整个仓库审计通过。

原始临时日志在 `.local/sbx-app-verification/2026-10-06/`；本目录 evidence 保存可复查的测试记录。初始 267 个文件的[基线指纹](evidence/baseline.txt)用于区分本轮修改与既有未提交工作；[最终比较](evidence/baseline-comparison.txt)显示其中 31 个相关文件改变、无文件丢失，旧验证记录未改写。[源码与构建指纹](evidence/tested-source.txt)绑定本轮被测产物。未提交或推送。
