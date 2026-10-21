# W0 · sandbox 工作区写入许可

状态：2026-10-21 用户指令“开始”授权实施。来源：[多 Harness 协作计划](../../plans/2026-10-21-multi-harness-collaboration.md) W0；设计依据见[多 Harness 协作设计](../../design/2026-10-21-multi-harness-collaboration.md) §6.1 与 [ARCHITECTURE §5](../../ARCHITECTURE.md)“同项目统一写入控制”。基线：`origin/main` `38af329`。

## 1. 现状事实（静态读取）

- 所有 Codex 轮次都在同一个 guest 目录 `/home/agent/workspace` 内以 `workspace-write` 运行（`apps/service/src/guest-helper.py` 的 `CWD` 与 `Popen(cwd=...)`），与发起它的空间和会话无关；受管 App 源码位于其中的 `.wsl-apps/`。
- 轮次有两个入口：空间会话的 TaskRun（`WorkbenchApplication.startRun` → `WorkbenchRuntime.send`）和旧个人对话（`ipc.ts` 的 `chat:send`，不经过 WorkbenchApplication）。两者都进入 Main `ChatService.send`。
- 2026-10-21 PR #14 在 service 层保留了“正常会话仍可并行”（`codex-chat-lifecycle.test.ts`）。用户于 2026-10-22 确认：Lane 落地前保留 W0，会话之间先串行写入；service 层行为与测试不变，限制只加在 Main。
- 现有并发限制只有两层：Main 拒绝同一会话的第二个活动 TaskRun；service `CodexChat` 拒绝同一会话槽的第二个活动轮次。不同会话之间、以及个人对话与空间会话之间，可以同时写同一个 guest 目录。

## 2. 范围

本工作包只控制 **Agent 轮次** 对 sandbox guest 工作区的写入：

1. 同一时刻，整个 sandbox guest 工作区只允许一个会话槽持有写入许可。许可在 Main 内存中，由 `ChatService` 这个所有轮次的唯一汇合点持有。
2. 另一个会话槽在许可被占用时发送轮次，在请求离开 Main 之前即被拒绝，错误码 `conflict`，消息说明工作区正被哪个会话写入、如何解除。
3. 许可只在持有者出现**比取得许可时更新**的快照、且该快照状态不是 `running`/`cancelling`、`cleanupPending` 为 `false` 时释放。取消、失败但清理未确认时继续占用。
4. 发送请求被拒绝时：若之后没有更新的快照（轮次未启动），立即释放；若已有更新快照，按第 3 条判断；服务通信已失败时不释放。
5. `startRun` 在创建 TaskRun 记录之前检查许可：被其他会话占用时以 `conflict` 拒绝，不留下失败的执行记录。检查与发送之间的竞争由第 2 条兜底，按现有“启动被拒绝”路径记为失败。

落点说明：ARCHITECTURE 把写入许可归任务与执行模块。本包把它放在 Main `ChatService`，是因为旧个人对话入口不经过 WorkbenchApplication，放在 WorkbenchApplication 会漏掉一个写入者。W2 引入 HarnessBinding 与 Lane 后，许可按 `(写入根, laneId)` 迁到任务与执行模块，旧入口届时一并收敛。

## 3. 不在本包

- 受管 App 的创建、导入、构建、数据 seed/reset 等 Lab 发起的写入，以及 guest 终端中用户自己的命令。这些仍按现有规则执行，属于 ARCHITECTURE §5 剩余缺口，W5（Lane）前另行处理。
- 跨重启持久化许可。重启后 service 以 `cleanupPending` 初始化并拒绝新轮次，现有恢复规则不变。
- 本机与 SSH 环境：当前 Agent 只在 sandbox 执行。
- 排队或自动重试。冲突只拒绝，不排队（首版不做后台队列）。

## 4. 验收

| #   | 场景                                    | 期望                                                          |
| --- | --------------------------------------- | ------------------------------------------------------------- |
| L1  | 会话 A 轮次运行中，会话 B 发送          | B 被拒绝（`conflict`），不向 service 发请求；A 不受影响       |
| L2  | A 完成且清理确认                        | B 可以发送                                                    |
| L3  | A 已取消或失败但 `cleanupPending: true` | B 仍被拒绝；清理确认后才可发送                                |
| L4  | A 的发送在 service 侧被拒绝（未启动）   | 许可立即释放                                                  |
| L5  | 早于取得许可时的旧快照到达              | 不释放许可                                                    |
| L6  | 同一会话连续发送                        | 行为与现在相同（由 service 的会话槽规则处理），许可不额外拒绝 |
| L7  | 个人对话运行中，空间会话 `startRun`     | 以 `conflict` 拒绝，不创建 TaskRun                            |
| L8  | 现有串行用例                            | 相关单元测试与类型检查全部通过                                |

默认测试不调用模型、不连接真实 sandbox。真实 guest 并发复验需要授权，不属于本包的完成条件；未运行时在执行记录中如实标注。
