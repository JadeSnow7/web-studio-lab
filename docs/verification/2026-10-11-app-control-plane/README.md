# 受管 App 控制面阶段 A 验证记录（2026-10-11）

当前审查修复见 [round-12](round-12-review-fixes/README.md)：操作终态与持久占用、CLI 清理归属、snapshotId 引用和完整 JSON 散列均已实现；本轮自动检查与真实执行分别登记。以下旧轮次的结果只适用于对应历史源码，原失败记录保留。

对象：[控制面设计](../../design/2026-10-11-app-control-plane.md)与[实施计划](../../plans/2026-10-11-app-control-plane.md)阶段 A。分支 `codex/app-control-plane`，HEAD `ea3bad9e6602ccec3484cc55b247bae5815975b4` 加本地未提交改动，未提交、未推送。环境：macOS arm64，Node v26.5.0，pnpm 10.34.6（经 `npx`），Electron 44.5.1。逐项结论见[验收矩阵](acceptance-matrix.md)。

最新结果：[round-07 独立审阅](round-07-review/README.md) 补充负例并修复暂停、取消、CDP 错误处理和场景修订归属；[round-08 产品窗口 sandbox 复验](round-08-live-review/README.md) 通过；用户随后明确授权的 [round-09 A11 真实模型与独立 Host 验收](round-09-model-live/README.md) 通过。[round-10 CLI 修复与真实验证](round-10-cli/README.md) 已将 CLI 改为每轮有界文件通道，真实 Codex 命令沙箱的 11 项 CLI 检查、MCP 与 Host 固定 16 步通过；原权限与共享 64/4 预算不变。round-09 的 socket 失败和 round-10 首次预算耗尽失败均保留。[round-11 产品在途 CLI 取消](round-11-cli-cancel/README.md) 已通过：修复 AI 重启抢占会话后，真实按钮取消、所属进程和通道清理、45 个源码文件保留，以及下一轮真实 CLI 的迟到响应隔离均通过；自动点击与受控延迟的边界见记录。下列 round-01 至 round-06 保留为历史证据，不代表修复后最终源码。

round-11 最终非 live Playwright 为 84 passed / 10 skipped / 0 failed，含新增取消 live 的默认跳过；R3 焦点历史失败未复现。Vitest 666 passed / 15 skipped，构建与类型检查通过。命令和收尾证据见 [round-11](round-11-cli-cancel/README.md)；固定基线自检沿用 round-07、Linux guest CLI/MCP 单测沿用 round-10，本轮相关输入未变。

## 轮次

| 轮次                                         | 内容                             | 结果                                                                                                                                                                                                                     |
| -------------------------------------------- | -------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| [round-01](round-01/commands/exit-codes.txt) | 首次全量检查                     | `pnpm test` 失败 8 项：7 项为本次回归（两个既有测试的 `CodexChat`/`WorkbenchApplication` 模拟缺少新增的 `setAppControlReader`/`setAppControl`），1 项为真实本地 PTY 时序用例，在单独重跑与 round-02 中通过。原始输出保留 |
| [round-02](round-02/commands/exit-codes.txt) | 补全模拟、应用自审修复后全量重跑 | 见下表                                                                                                                                                                                                                   |

round-01 后的自审修复：模板的 manifest 新鲜度门禁测试从 `npm run check`（受管启动每次运行，早于 `build:agent` 重建 manifest）移到 `npm run test:agent`，否则任何源码修改都会让应用启动失败；dispatcher 先确认 run 归属再校验参数，使被拒绝的请求也写入审计；数据测试不再固定 seed 行数。

## round-02 命令与原始退出码

| 命令                                                        | 退出码 | 说明                                                                                                                                                                                    |
| ----------------------------------------------------------- | ------ | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `pnpm typecheck`                                            | 0      |                                                                                                                                                                                         |
| `pnpm lint`                                                 | 1      | 2011 个错误，与改动前基线数量相同，均在既有 `records/` 运行副本、VS001 与整合存档；本次文件定向 ESLint 0 错误                                                                           |
| `pnpm format:check`                                         | 1      | 改动前 794 个文件；本轮首次运行多出 round-01 原始证据 JSON，把本证据目录加入 `.prettierignore` 后[复查](round-02/commands/format-check-after-evidence-ignore.log)与基线文件集合完全相同 |
| `pnpm test`                                                 | 0      | Vitest 81 文件 passed / 6 skipped，637 tests passed / 15 skipped；另含 packaging 与 external-builds node 测试                                                                           |
| `pnpm build`                                                | 0      |                                                                                                                                                                                         |
| `pnpm baseline:selftest`                                    | 0      | VS001 离线自检，不调用模型                                                                                                                                                              |
| 模板 `npm run check`                                        | 0      | 前后端类型检查 + 6 个进程内测试                                                                                                                                                         |
| 模板 `npm run test:agent`                                   | 0      | 7 个：manifest 门禁、CLI 子进程（真实 PGlite）、两种构建模式排除                                                                                                                        |
| 模板 `npm run template:verify` / `npm run agent:check`      | 0 / 0  | 模板内容 SHA-256 `f1e2fd604fb1f7df7ba8a98edccb5d75a370da4e94b80f0600a2f23ff1efa06f`，版本 1.1.0                                                                                         |
| 生产构建排除检查                                            | 0      | `vite build` 到临时目录后 `scripts/agent-exclusion-check.mjs` 无标记                                                                                                                    |
| `pnpm exec playwright test e2e/app-control-harness.spec.ts` | 0      | 2 passed；结果 [round-02/harness/results.json](round-02/harness/results.json)，轨迹与截图在同目录                                                                                       |

`node scripts/check-docs.mjs` 与 `git diff --check` 在本记录写完后运行，结果见[收尾检查](round-02/commands/final-checks.txt)。

## 产品窗口 + sandbox live（2026-10-11，用户授权 sandbox live，未授权模型）

命令（`pnpm build` 后）：`WSL_APP_CONTROL_LIVE=1 WSL_SBX_NAME=wsl-sbx-smoke-20261006 WSL_SBX_BIN=/opt/homebrew/bin/sbx WSL_APP_DEPENDENCY_ARCHIVE=<repo>/packaging/generated/runtime/template-dependencies.tar.gz pnpm exec playwright test e2e/app-control-live.spec.ts`。依赖归档 SHA-256 `fa12446d82c6e4c069f8bd4540ff4ed489e39460b73ee6931d8a7231fe983e4f`，锁文件 SHA-256 与模板一致（`741d02cb…`）。不调用模型：测试引导（`e2e/fixtures/app-control-injection.ts`）只在 Main↔service 边界拦截被模拟会话的 `send`/`cancel` 并注入 `app-call`，其余为真实产品路径；实际转发到 service 的控制面方法为 `app.create/app.start/app.agent/app.stop`。

| 轮次                                          | 结果                                          | 说明                                                                                                                                                                                                                                                                                                                                        |
| --------------------------------------------- | --------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| [round-03-live](round-03-live/results.json)   | 测试 passed，发现缺陷                         | 全部断言通过，但截图显示 AI 发起 `app.restart` 期间出现“unavailable: 应用实例已停止或需要重新启动”错误提示：Browser 标签可见时，停止期间的尺寸变化让 renderer 向已释放的网页发送布局                                                                                                                                                        |
| [round-04-live](round-04-live/playwright.log) | failed                                        | 首版修复在“应用运行但实例未建”时也跳过布局，而布局同步正是创建原生网页的入口，网页未出现                                                                                                                                                                                                                                                    |
| [round-05-live](round-05-live/results.json)   | passed                                        | 修复改为仅在受管 App 非 running 且无实例时跳过布局（读取最新快照，覆盖清理）；新增断言重启期间无该提示。A03/A07 结论见验收矩阵；本 run 的审计 21 条与 3 次场景轨迹复制在 `round-05-live/app-control/`                                                                                                                                       |
| [round-06-live](round-06-live/exit-codes.txt) | live passed；非 live e2e 83 passed / 1 failed | round-05 后的非 live 回归发现 `sbx.spec.ts` 预览隐藏用例因新增的布局效果依赖（`resource.instanceId`）失败：演示网页首次建实例时多出一次隐藏-显示。撤回该依赖（守卫读取最新快照即可）后在最终代码上重跑 live 与全量非 live e2e。唯一失败的 R3 焦点用例在未改动 HEAD 的临时 worktree 上同样失败（[记录](round-05-live/head-baseline-R3.txt)） |

窗口截图由 `BrowserWindow.capturePage()` 取得，不含原生 WebContentsView 内容（显示为空白区）；页面实际内容见场景截图（如 `round-05-live/app-control/*/scenarios/*/15-fixed-welcome-saved.png`）。sandbox 中残留的两条 `8081` 端口映射不属于本测试（本测试实例使用 `PORT=0` 动态端口，停止后 `cleanupConfirmed: true`），未处理。最终代码的非 live Playwright 回归见 [round-06-live/e2e-regression.log](round-06-live/e2e-regression.log)，收尾检查见 [final-checks.txt](round-06-live/final-checks.txt)。

## 固定基准

[固定任务](../../../tests/app-control/fixed-task/README.md)位于 guest 写入范围外。最终 SHA-256：`task.json` `21f44e2e39162ae876b3a5f84c820cafed78ced0729dd90e50ffcdde6293102c`，`scenario.json` `47045475157bf4e7ecfdb76c1cff742b7a549a3a69dbbbff803a3bf36ea86b91`，`reference/App.tsx` `8a526d2b2fabf1765dd42af6e197a7720bcd11789cd9306b71637a29ecdffdd1`（冻结后仅做过 Prettier 格式化，任何基准运行都在格式化之后）。原版模板上场景第 2 步失败，参考实现上两次通过。

## 未运行与限制

- 真实模型和 guest MCP 链路已于 round-09 执行，独立 Host 固定场景通过；工具记录与任务能力验收分别留证，见该轮说明。
- round-10 已打通 Codex 命令沙箱内 CLI；权限拒绝与无副作用复读通过。命令进程退出/超时有真实 Linux 子进程测试，真人取消整个模型任务时的在途 CLI 产品验收仍未运行。
- `input-event` 对用户输入的判定在 Harness 与 live 中均以 `sendInputEvent` 模拟用户；真实人手操作未测。AI 派发窗口（含 150 ms 余量）内的人为输入可能被归为 AI。
- 独立检查器未接入：场景结果不写入 TaskRun 的 validation，不构成“验证通过”或“用户接受”。
- 阶段 B（Expo Web）与阶段 C（Android）未实现，仅有协议 `surface` 预留与设计。
