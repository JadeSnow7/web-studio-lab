# W7 执行记录：多 Harness 调度（路由范围 + Profile 单活动 + 有界排队）

日期：2026-10-28 前后。实现：worker；审阅与独立验证：主线程。本包把 workflow 调用适配器从「单 codex native」扩展为按受理授权路由的 Harness × Profile 池，落实设计 §83（解析先于键）、§117（Profile 单活动）、§119（排队消耗统一预算、换 Profile 不重置 deadline、禁止无限换账号）、§129（路由范围属运行授权）。

## 交付面

**协议（`@wsl/protocol`）**

- `RouteScopeMemberSchema`：`{harnessId, profileId, profileDir|null}` strict——成员是运行授权的一部分；`profileDir` 由 Main 按 `profileDirOf` 解析（builtin→null），service/helper 各自校验。
- `WorkflowRouteScopeSchema`：`{defaultHarness: HarnessIdSchema(缺省 'codex'), members: RouteScopeMemberSchema[] ≤32}` strict。
- `workflow-run` 消息新增可选 `routeScope`：缺省 → service 维持单适配器语义（`opts.profile` 只记录不路由），MockHarness 与既有全部测试零回归。
- `attempt_start` journal 事件新增可选 `route:{harnessId, profileId}`：原始镜像持久化，不加 SQLite 投影列。
- `call_start.effective` 沿用 `record` 形状：resolved `profile`（string）与 `profileAuto`（boolean）直接容纳，不改 schema。

**service**

- `workflow/routed-pool.ts`（新）：`RoutedAdapterPool implements WorkflowCallAdapter`。
  - `harnessId = defaultHarness`（兼容内核现有引用）；`membersOf`/`supportsHarness` 供校验与测试。
  - `resolveRoute(requested)`：显式 profile → 必须存在于该 harness 成员表，否则 `{code:'unsupported_option'}`；缺省 → 选 占用+等待数 最少的成员（并列按成员表登记序，确定性路由、不读额度），无成员 → `unsupported_option`。
  - `run(call, signal)`：按 `call.effective.profile` 找成员（找不到 → `failed{internal}`，解析与执行不一致属内部错误）；同一 profileId 任意时刻在飞 ≤1——忙时在首个 `next()` 内 FIFO 等待（登记序），signal/iterator.return 可中断（静默返回，内核分别记 stopped/timeout）；拿到槽位后委托成员适配器，拿到终态即释放槽位并移交队首等待者（内核消费终态后可能遗弃迭代器，槽位必须在此之前释放）。
- `kernel.ts`：`CreateRunOptions.routeScope`（`{defaultHarness, members:[{harnessId,profileId}]}`）；`validateOpts` 按范围闭集校验 `opts.harness`（缺省→`defaultHarness`）与显式 `opts.profile`（必须是该 harness 成员 profileId），越界 → `failed{unsupported_option}`；校验通过后、`contentKey`/`call_start` 之前调 `adapter.resolveRoute?.()`，解析结果冻结进 `effective`（auto 加 `profileAuto:true`）并进调用身份；`attempt_start` 写 `route`；lane 调用同样走路由。
- `engine.ts`：spec 增 `routeScope`（`WorkflowRouteScopeSchema` 复核，parse 顺带落实 defaultHarness 缺省），透传内核。
- `workflow-host.ts`：deps `harness` 单值 → `harnesses: readonly NativeHarnessAdapter[]`；`createAdapter` 在 `spec.routeScope` 存在时构建 `RoutedAdapterPool`——成员必须解析到表内 native 且 `argvForIsolation('readonly')` 非空（ACP spec-harness 天然进不了表），不满足的成员剔除；剔除后空池仍受理，调用 `failed{unsupported_option}`。不存在时维持原单适配器路径。
- `index.ts`：宿主装配改为 `REGISTERED_HARNESSES` 中 `kind==='native'` 的适配器表（当前即 codex）。
- `mock-harness.ts`：`MockHarnessOptions.harnessId`（缺省 `'mock'` 不改语义），供路由池成员区分 Harness。

**Main**

- `WorkflowApplication` deps 增 `routeScopeProvider(): RouteScopeMember[]`；run/resume 受理时取一次快照注入 `spec.routeScope`（`defaultHarness:'codex'`），provider 缺省 → 不下发（单适配器现状）。
- `index.ts` 装配：provider 从 `HarnessProfileStore` 快照过滤 `WORKFLOW_CAPABLE_HARNESSES=['codex']`（如实写死并注释：claude-code 是 ACP spec-harness，无 `argvForIsolation`，不能进 workflow 成员表；对它声明的调用由内核/路由池 `unsupported_option` 拒绝）。`profileDir` 按 `profileDirOf` 计算（builtin→null）；logged_out profile 仍入列——额度/登录在执行期诚实失败，受理不预选；快照不可读时回退内置 `codex:default`，不阻断受理。
- `engine-port.ts` spec 增 `routeScope`；`service-engine-port` 经 `workflow-run` 消息透传（`...rest` 展开，无新通道）。

## routeScope 语义（冻结与预算）

- 路由范围随 spec 受理冻结；`resolveRoute` 在登记期每调用解析一次，结果进 `call_start.effective` 与 contentKey——显式 profile 总进键；auto 解析以 `profileAuto` 标记同进键。同 prompt 不同解析 → 不同 contentKey：续跑换范围解析不同即不命中既有缓存（安全方向，不静默复用别的 profile 的结果）。
- `attempt_start.route` 记录实际成员，重试不更换；重试重新排队（消耗统一 attempt/时间预算），`deadlineMs` 从受理起算不被排队/重试/换 Profile 重置。
- 等待者绑定冻结的 profile：成员忙时 FIFO 等待，即使其他 profile 空闲也不改派；等待超时由内核 `timeoutMs` 定界 → `failed{timeout}`（可重试），abort → `stopped`。

## E5 场景覆盖（`fixtures/workflow/e5/scenarios.json` → `scheduler-e5.test.ts`）

矩阵 3 Harness（ha/hb/hc）× 2 Profile（`:default` + 固定 UUID），MockHarness 成员驱动 RoutedAdapterPool + 真实内核。

| 场景                       | 断言                                                                                                                                                              |
| -------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| E5-01 混合负载             | 200 调用 completed；逐成员在飞 ≤1；每 `attempt_start` 携带 `route` 且与 `call_start.effective` 冻结一致；显式 harness/profile 落在声明成员；auto 加 `profileAuto` |
| E5-02 永久 429             | `call_end failed{rate_limit}`、`attempts=1`（不重试）、不静默改派；其他成员调用 ok                                                                                |
| E5-03 全池耗尽（timeout）  | 全成员 hang：全部 `failed{timeout}` 有限终态，无无限排队                                                                                                          |
| E5-04 全池耗尽（deadline） | `run_deadline_exceeded`：绝对 deadline 先于「排队×重试」更长路径生效，不被重置                                                                                    |
| E5-05 权限拒绝             | `failed{permission_denied}`、`attempts=1`                                                                                                                         |
| E5-06 资源不足             | 范围外 harness 与范围内空成员表（宿主剔除后空池）均 `failed{unsupported_option}`、不派发 attempt                                                                  |
| E5-07 Profile 忙           | 同 profile 并发调用 FIFO 串行（peak=1，登记序）                                                                                                                   |
| E5-08 停止等待者           | stop → 在飞与等待调用 `stopped`；等待者从未派发成员 attempt                                                                                                       |
| E5-09 冻结语义             | `effective.profile == route.profileId == 实际成员`；成员忙时等待不改派空闲 profile                                                                                |

`routed-pool.test.ts`（10 条）补池级单测：resolveRoute 显式/auto/越界/空表、单活动、FIFO 移交、abort 与内核式 `return()` 唤醒等待者、成员缺失 → `failed{internal}`。内核级路由用例（同文件第二 describe）覆盖：auto 解析冻结 + route 记录、越界 harness/profile `unsupported_option`、同 prompt 不同 resolved profile → 不同 contentKey、续跑换解析不命中缓存（安全方向）、无 routeScope 时单适配器零回归（profile 只记录、无 `profileAuto`/`route`）。

## 验证

| 命令                                                                                                          | 结果                                          |
| ------------------------------------------------------------------------------------------------------------- | --------------------------------------------- |
| `pnpm exec vitest run apps/service/src/workflow apps/service/src/workflow-host.test.ts packages/protocol/src` | 22 文件 264/264                               |
| `pnpm exec vitest run apps/desktop/src/main/workflow`                                                         | 4 文件 152/152（含 W7 注入/缺省、E7-116~120） |
| `pnpm exec vitest run apps/desktop/src/main`                                                                  | 55 文件 861/861                               |
| `pnpm --filter @wsl/protocol typecheck` / `@wsl/service` / `@wsl/desktop`                                     | 通过                                          |
| eslint + prettier（触及文件）                                                                                 | 通过                                          |
| `pnpm build`                                                                                                  | 通过                                          |
| `node scripts/check-docs.mjs`                                                                                 | 通过                                          |
| `env -u ELECTRON_RUN_AS_NODE WSL_E2E_SKIP_FOREGROUND=1 pnpm exec playwright test e2e/workflow.spec.ts`        | 7/7（SKIP_FOREGROUND 仅跳过 OS 前台断言）     |

## 边界（如实声明）

- 真实矩阵仍是 `codex:default` 单成员：当前只有 codex native 适配器提供 `argvForIsolation`；claude-code/ACP 无 NativeHarnessAdapter，进不了成员表——对它声明 harness/profile 的调用 `unsupported_option`，不静默改派。
- Profile 容量按「单活动执行」实现（成员槽位）；额度/登录状态不参与路由选择（auto 只看占用+等待数），logged_out 成员在执行期诚实失败。
- 排队等待消耗 per-attempt `timeoutMs`（可重试）与 run `deadlineMs`（不重置）；成员适配器的清理确认有界性沿 IsolatedGuestAdapter 既有语义。
- journal `route` 只进原始镜像，无投影列/UI 展示；Profile 选择的用户界面入口未做（路由范围由 Main 从 Profile 快照注入，脚本内显式声明经 `opts.harness/profile`）。
- E5 为 MockHarness + 内核的确定性离线覆盖；真实模型/sbx live 的 E8 未授权未执行。
- 无 commit/push。

## 2026-10-25 整合注记

本文是冻结来源中的历史 WF 记录。原文日期“2026-10-28 前后”晚于当前整合日，保留该异常，不据此推算真实执行时间。原 W7 报告的历史真实运行证据仅覆盖 `codex:default`，不据此推断当前成员表。当前隔离适配器仅 Codex native，成员表由 Main 每次受理时冻结的 Profile 快照生成；当前候选未做真实多 Profile 矩阵验收，多成员 fixture 不等于 E8 真实矩阵。本协调说明不修改原日期或原结果，不据文档存在判定当前接受。
