# W0 执行记录 · sandbox 工作区写入许可

合同见 [SPEC](SPEC.md)。基线 `origin/main` `38af329`（起草于 `5037363`，PR #16 变基后复验），2026-10-22 变基到 `ebf4391`（PR #17），分支 `agent/project-write-lease`。本记录只说明静态检查和离线测试结果，不代表真实 sandbox 复验或用户接受。

## 改动

| 路径                                                   | 变化                                                                                                                                               |
| ------------------------------------------------------ | -------------------------------------------------------------------------------------------------------------------------------------------------- |
| `apps/desktop/src/main/workbench/guest-write-lease.ts` | 新增 `GuestWriteLease`：纯内存许可，`acquire` / `observe` / `sendRejected` / `current`，以及 `conflictMessage`                                     |
| `apps/desktop/src/main/chat-service.ts`                | 发送前取得许可；采信新快照时交给许可判断释放；service 明确拒绝时按最新快照释放，通信失败时保留；新增 `writeHolder()`；服务已失败或关闭时不取得许可 |
| `apps/desktop/src/main/workbench/ports.ts`、`host.ts`  | `WorkbenchRuntime` 增加可选 `writeHolder()`，host 转发 ChatService                                                                                 |
| `apps/desktop/src/main/workbench/application.ts`       | `startRun` 在创建 TaskRun 前检查许可，被其他会话占用时以 `conflict` 拒绝，消息含会话标题与身份                                                     |
| 三个测试文件                                           | 见下文                                                                                                                                             |

行为变化：不同会话（含个人对话与空间会话）不能再同时向同一个 sandbox guest 工作区发起 Agent 轮次；后发起者收到 `conflict`，原有同会话规则不变。

## 验收对应

| #      | 测试                                                                                                                      |
| ------ | ------------------------------------------------------------------------------------------------------------------------- |
| L1、L2 | `chat-service.test.ts`“另一会话运行中时拒绝且不发请求，完成并确认清理后放行”                                              |
| L3     | 同文件“取消或失败但清理未确认时继续占用”                                                                                  |
| L4、L6 | 同文件“service 明确拒绝未启动的发送时立即释放；同一会话重复发送不额外拒绝”                                                |
| L5     | 同文件“早于取得许可时的旧快照不释放”；`guest-write-lease.test.ts`                                                         |
| L7     | `application.test.ts`“rejects startRun before creating a run while another session holds the sandbox write lease (W0 L7)” |
| 补充   | `chat-service.test.ts`“服务通信失败后保留许可，并以原始故障拒绝后续发送”                                                  |

## 变基到 PR #17（`ebf4391`，2026-10-22）

PR #17 新增 `RunDispatchFailure`，区分“service 已接纳但清理未知”与“从未启动”（`knownNotSent`），并收紧启动回执校验（核对 `conversationSlot`，形状或归属不符时置 `unknownCleanup`）。合并时以 PR #17 的判定为准，许可只做增量：

| 情况                                                                 | 许可                                    |
| -------------------------------------------------------------------- | --------------------------------------- |
| 服务已失败或正在关闭（`RunDispatchFailure(…, false, true)`，发送前） | 不取得                                  |
| 发送前                                                               | 照常取得，被其他会话占用时 `conflict`   |
| 被拒绝且 `knownNotSent`                                              | 按最新快照 `sendRejected`（L4/L6 不变） |
| 已接纳但清理未知、回执形状/归属不符、传输失败、服务退出              | 保留                                    |
| 已接纳且有更新快照表明已停止并确认清理                               | 由 `remember()` 经 `observe` 释放       |

测试调整：

- 新增 `chat-service.test.ts` W0 组的五个用例，分别覆盖上表的 `knownNotSent` 释放、已接纳未确认保留、已接纳已确认按 observe 释放、回执形状不符与归属不符保留。原 L1–L6 与通信失败用例的断言未改，在新语义下照常通过。
- PR #17 的 `source dispatch receipt ownership > never lets an A response publish a fake cleanup fact into a concurrent B error|exit` 原本让另一个会话槽 A 在 B 进行中并发 `send`。W0 之后这种并发在离开 Main 前就被 `conflict` 拒绝（语义确实改变），因此改为：断言 A 的 `send` 以 `conflict` 拒绝且不发请求；伪造的 B 回执改由 A 的 `cancel` 回复携带（同样按 `conversationSlot` 校验）。B 仍须以 `cleanupPending: true, knownNotSent: false` 拒绝，该测试原有目的不变。

## 实际运行（2026-10-22，macOS）

环境：macOS 26.6.2（25G83）arm64，Node v26.5.0（产品期望 Node 24，本机实际版本如实记录），pnpm 10.34.6，Python 3.15.0，Electron 44.5.1。基线 `origin/main` `ebf4391`（PR #17），被测提交 `f66c43d`；之后只追加了本记录的文档提交，未改代码。命令按交接清单逐项独立执行，单项失败不中断后续项。

| 命令                                                                                     | 结果                                                                                                                                                                                                                                                                                                                     |
| ---------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `pnpm install --frozen-lockfile`                                                         | 通过                                                                                                                                                                                                                                                                                                                     |
| `pnpm typecheck`                                                                         | 通过                                                                                                                                                                                                                                                                                                                     |
| `pnpm exec eslint apps packages e2e scripts templates/standard-app`                      | 通过                                                                                                                                                                                                                                                                                                                     |
| `pnpm exec prettier --check apps packages e2e scripts templates/standard-app`            | 通过                                                                                                                                                                                                                                                                                                                     |
| `pnpm exec vitest run`                                                                   | 1280 通过、15 跳过、1 失败：`setup-adapter.test.ts` 的 “accepts actual sanitized sbx inspect shape, rejects mounts and daemon drift” 在全量并行下超过 5 秒超时；未改动的 `origin/main` `ebf4391` 上同样超时，本组其他分支的同一命令中有的通过，与本包无关。`setup-adapter-failure.test.ts` 在 macOS 上运行并通过（4 项） |
| `pnpm test:packaging` / `test:external-builds` / `test:edu-source` / `baseline:selftest` | 40 / 6 / 57 / 12 项全部通过                                                                                                                                                                                                                                                                                              |
| `node scripts/check-docs.mjs`                                                            | 通过                                                                                                                                                                                                                                                                                                                     |
| `pnpm build`                                                                             | 通过                                                                                                                                                                                                                                                                                                                     |
| `env -u ELECTRON_RUN_AS_NODE pnpm exec playwright test`                                  | 171 通过、16 跳过（8.9 分钟）                                                                                                                                                                                                                                                                                            |
| `git diff --check origin/main...HEAD`                                                    | 通过                                                                                                                                                                                                                                                                                                                     |

- 变基冲突解决后，在该提交上单独运行 `chat-service.test.ts` 与 `apps/desktop/src/main/workbench`：25 个文件 396 项通过。

以下容器结果保留为历史。

## 实际运行（2026-10-21，Linux x86_64 容器，Node 24.22.0，pnpm 10.34.6）

| 命令                                                                                       | 结果                                                                                                                                                                |
| ------------------------------------------------------------------------------------------ | ------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `pnpm typecheck`                                                                           | 通过                                                                                                                                                                |
| `pnpm exec eslint apps packages e2e scripts templates/standard-app`                        | 通过                                                                                                                                                                |
| `pnpm exec prettier --check apps packages e2e scripts templates/standard-app` 及本目录文档 | 通过                                                                                                                                                                |
| `pnpm exec vitest run`                                                                     | 1106 通过、16 跳过、1 失败：`setup-adapter-failure.test.ts` 的磁盘空间用例，因本机不是 macOS 而先报 `unsupported-system`；未改动的 `5037363` 上同样失败，与本包无关 |
| `pnpm test:packaging` / `test:external-builds` / `test:edu-source` / `baseline:selftest`   | 40 / 6 / 57 / 12 项全部通过                                                                                                                                         |
| `node scripts/check-docs.mjs`                                                              | 通过                                                                                                                                                                |
| `pnpm build`                                                                               | 通过                                                                                                                                                                |

## 未运行

- Electron E2E：容器中未运行（未下载 Electron 二进制）；2026-10-22 已在 macOS 上运行，结果见上。打包后的 E2E（`pnpm test:e2e:packaged`）未运行。
- 真实 sandbox 下两个会话并发的复验：需要授权和已配置的 sbx，按 SPEC 不是本包的完成条件。
- `pnpm check` 全仓 `lint` 与 `format:check`：在未改动的基线上已分别有 217 个 lint 错误和 802 个格式问题（主要在 `tests/vertical-slice`、`fixtures` 等非维护目录），PR 门禁只检查维护目录和变更文件，本包按门禁口径执行。

## 未实现

受管 App 的创建、导入、构建与数据操作，以及 guest 终端中的用户命令，仍不受此许可约束（SPEC §3）。

## 2026-10-26 · pending send 回执归属修复

以 `655af05dd12ac8dd57d20ff55cae9050cc3debee` 为失败基线，确认仅凭更新的 idle 快照无法判断 send 是否已被 service 处理：初始化等待期间的 `get`、上一轮完成、取消回执，以及同槽另一个 send 的拒绝，都可能发生在当前 send 仍排队时。

- 新增 L9–L12 宿主负例在旧实现上 4/4 失败；每次 send 现在独立登记票据，只有对应的已校验 service 回执结算。尚有票据、执行仍活动或清理未确认时继续占用。迟到旧票据不影响新许可。
- L13 补充发送前 schema 验证：原行为把未发送的非法输入当作清理未知；现于取得许可前拒绝，不影响同槽已有发送。该负例的首次失败也保留。
- 这是 Main 写入许可修复，不改变 service 的会话并发能力、取消流程、真实执行器或超时。上方历史结果和 PR #17 记录保留，不追认为本轮通过。
- 本轮定向结果和最终提交绑定由交付报告记录；未运行真实 sandbox、模型或窗口验收。单元测试只使用 Mock。

独立审查随后发现同一时序也影响源码任务：未 ACK send → `get` 返回 idle → 服务断连，原 `RunDispatchFailure` 会误报清理完成，任务提前结束并解除项目占用。补充修复使未确认 send 在断连时保持清理未知；同时修补 `startApp` 对失败执行器清理未知的既有阻塞条件，日志基线存在不再被当作放行依据。本包没有把全局 Agent 许可扩展到所有 App 写入入口。

- 三类无对应发送回执的快照（get/cancel/event）和 ChatService→WorkbenchApplication 源码任务联动，共 4 个负例在补充修复前失败；明确拒绝后的恢复对照通过。第一轮新增对照夹具的实例身份错误也保留在独立日志中。
- 补充定向回归为 4 文件 124/124 通过，无跳过；前一轮 87/87 只覆盖初始许可补丁，不追认为完整修复已通过。Main 源码任务的假清理/假成功关闭已复现；实际服务故障仍会拒绝后续启动，未声称复现 guest 并发写入。


### 取消先回执的同链补充

独立复核进一步确认：pending send → `cancelRun` → clean 取消回执 → send 回执前断连时，许可仍在，但 TaskRun 已提前结束并采集源码。三个正式负例在此前补丁上全部失败，原日志保留。

Main 现在保留该 run 的未结算发送事实，在匹配 send 回执前不采纳 clean 终态，不释放结束采集/项目占用。成功 ACK 即使晚于取消，也建立 generation/turn 绑定；另一负例确认缺少此绑定会让迟到旧轮次终态失去隔离。明确拒绝、匹配 ACK 后清理完成均可恢复，断连仍保留清理未知。新回归通过公开命令重新启动应用、采集与确认现场，覆盖后续新执行及旧事件隔离；未改变超时、权限或真实执行器。

本轮四文件相关回归为 128/128 通过；首次恢复夹具沿用已停止应用的旧现场、以及再次启动仍运行的夹具 App 所产生的失败均单独保留。此前 124/124 不是本轮新增取消边界的验收。完整默认门禁、窗口、真实模型/guest 和打包验收未运行。
