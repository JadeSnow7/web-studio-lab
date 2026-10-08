# Web Studio 接入 sbx：对话与交互终端

2026-10-06，来源：用户要求“测试让 Web Studio 使用 sbx 内部的 codex cli 和终端环境”。本轮在当前 Electron Lab 工作树实现并测试。保留既定 UI/UX 和全部既有未提交内容，不提交、推送或修改历史验证记录。

## 目标和边界

1. Web Studio 的真实对话经独立 Node 服务调用指定 sbx 中的 Codex；界面显示 sandbox 名称与 guest 工作目录。该配置不成功时明确不可用，不退回宿主执行。
2. 增加真正的交互终端，支持持久 shell、键盘输入、Ctrl-C、尺寸变化和关闭；终端与 Codex 共享 `/home/agent/workspace`。
3. 使用上一轮已经安装组件的 `wsl-sbx-smoke-20261006` 做 live 测试。以启动环境 `WSL_SBX_NAME` 显式选择现有 sandbox，`WSL_SBX_BIN` 仅在需要时指定 CLI。应用不自动创建、删除或停止整个 sandbox，也不读取 host 凭据或挂载 host 目录。
4. 保持 Electron contextIsolation/sandbox/nodeIntegration 安全设置和预览页无 preload 的边界。renderer 只通过明确 IPC 访问服务；实际 sbx 参数由服务构造。
5. 本轮允许 Codex 在 guest 工作目录内使用工具，内层采用 workspace-write；不开放 host 工作目录。这里只接通沙箱对话和终端，不宣称任务编排、项目预览代理、C1–C3 或多租户安全验收完成。

交互终端原计划为 P1；本次用户明确要求测试终端环境，将这一最小交互切片纳入当前授权范围。无需整体重排 UI 或引入原生 Swift 代码。

## 设计约束

- `packages/protocol` 是跨进程契约唯一来源；sbx 连接、远端进程与数据流由 `apps/service` 负责，Electron main/preload 只转发，renderer 负责展示与输入。
- 采用 xterm.js 渲染；PTY 在 Linux guest 中创建，由小型 Python 标准库 helper 经 `sbx exec -i` 传送输入、输出、resize 与结束回执，避免增加 Electron native ABI 依赖。helper 仅服务本次 Codex/终端两种进程，不扩展成通用 Agent runtime。
- 取消和关闭必须清理所属 guest 会话，正常结束需收到清理确认。宿主 sbx 进程退出不能单独证明 guest 进程已退出；缺少确认时显示失败并阻止把它当作成功取消。
- 普通 fixture/unit 回归不访问真实 sbx 或模型；live 测试显式启用。测试创建专用 guest 目录和无敏感随机值，提示不包含期望值。

## 固定验收基准

| 编号       | 检查与通过条件                                                                                                                                        |
| ---------- | ----------------------------------------------------------------------------------------------------------------------------------------------------- |
| APP-SBX-01 | 当前实现前的基线记录证明 Codex 直接在 host 启动、terminal 未实现；新增契约测试在实现前失败，原有单元检查结果保留。                                    |
| APP-SBX-02 | fixture 验证连接配置、guest cwd、CLI 参数及消息转发；缺 sbx/未选 sandbox/远端异常明确失败，不能意外调用 host Codex。                                  |
| APP-SBX-03 | 构建后的 Electron UI 对话能经真实 sbx 返回；终端显示 Linux、实际 Node/Codex 版本和 guest cwd。                                                        |
| APP-SBX-04 | 通过应用终端生成随机文件；给应用聊天的提示只含 guest 路径；Codex 工具读取并回复实际随机值。终端和 Codex 看到同一文件，host canary 不可达。            |
| APP-SBX-05 | 终端持久 shell 的 cwd/环境可持续、尺寸变化生效、Ctrl-C 可终止前台任务、切标签后输出保留、关闭后已登记进程确认退出。对话取消、续聊和新对话状态不回退。 |
| APP-SBX-06 | 类型、lint、格式、单元、build 及受影响 Electron fixture/live E2E 通过；实际观察宽窄窗口的终端/对话，记录截图和限制。                                  |

应用试用与本次测试绑定到原有 dirty baseline 文件指纹：`.local/sbx-app-verification/2026-10-06/baseline.json`。实现前后证据分别保留；单元/fixture、真实模型和 UI 观察分开报告。
