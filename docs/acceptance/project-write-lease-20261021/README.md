# W0 执行记录 · sandbox 工作区写入许可

合同见 [SPEC](SPEC.md)。基线 `origin/main` `38af329`（起草于 `5037363`，PR #16 变基后复验），分支 `agent/project-write-lease`。本记录只说明静态检查和离线测试结果，不代表真实 sandbox 复验或用户接受。

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

- Electron E2E（`playwright test`）：容器未下载 Electron 二进制，且 PR 门禁在 macOS ARM64 上运行。需在 macOS 上执行 `pnpm build && env -u ELECTRON_RUN_AS_NODE pnpm exec playwright test`。
- 真实 sandbox 下两个会话并发的复验：需要授权和已配置的 sbx，按 SPEC 不是本包的完成条件。
- `pnpm check` 全仓 `lint` 与 `format:check`：在未改动的基线上已分别有 217 个 lint 错误和 802 个格式问题（主要在 `tests/vertical-slice`、`fixtures` 等非维护目录），PR 门禁只检查维护目录和变更文件，本包按门禁口径执行。

## 未实现

受管 App 的创建、导入、构建与数据操作，以及 guest 终端中的用户命令，仍不受此许可约束（SPEC §3）。
