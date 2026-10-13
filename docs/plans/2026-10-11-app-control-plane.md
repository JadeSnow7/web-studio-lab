# 受管 App 控制面实施与验收计划（阶段 A）

阶段 A 在 standard-app Web 上实现 L0–L3、MCP/CLI 两个入口、场景运行器、测试与检查脚本。设计以[控制面设计 v1](../design/2026-10-11-app-control-plane.md)和 [ADR-0002](../architecture/adr/0002-app-control-plane.md) 为准。日期 2026-10-11（Asia/Shanghai）。本轮授权：设计与阶段 A 实现、离线检查；真实 sandbox live、真实模型链路未获授权时记 `not_run`。不提交、不推送、不发布。

## 1. 基线

- 目录 `/Users/huaodong/workspace/web-studio-lab`，origin `https://github.com/JadeSnow7/web-studio-lab.git`，HEAD `ea3bad9e6602ccec3484cc55b247bae5815975b4`，新分支 `codex/app-control-plane`（由 `codex/c1-development-20261010` 创建，未切换内容）。
- 开始时 dirty：仅未跟踪构建产物 `apps/desktop/out`、`apps/desktop/release`、`apps/desktop/release-internal`、`apps/service/out`、`packaging/cache`、`packaging/generated`；读取期间 `.gitignore` 出现非本任务修改（改为忽略上述路径），保持原样不纳入本次改动。
- 改动前检查（Node v26.5.0，pnpm 10.34.6 经 `npx`）：`pnpm typecheck` 0；`pnpm test` 0（Vitest 595 passed / 15 skipped）；`pnpm lint` 1（2011 个既有错误，主要在被忽略的 `records/` 运行副本和 VS001 存档）；`pnpm format:check` 1（794 个既有文件）。本次改动用定向 lint/格式检查区分新问题。
- 委派：`AGENTS.md` 要求源码交给 `coder`；本会话没有 `coder` 代理类型，按规定注明后由主线程自行实施，每个文件仍只有一个写入者。

改动前关键文件 SHA-256：

| 路径                                             | SHA-256                                                            |
| ------------------------------------------------ | ------------------------------------------------------------------ |
| `packages/protocol/src/workspace.ts`             | `04103191bb1e3133ae4e349f17ee824411954c92ab84b452d9fbeedf33b03879` |
| `packages/protocol/src/preview.ts`               | `42ca2620fe4b7bbf0f09bc461a55627aa9cf6838a1535e3eaf9b236bde6c2e23` |
| `packages/protocol/src/chat.ts`                  | `08906525772800fbb61eb72d76f40db266ba654c89538822c9caa5b253cadfba` |
| `apps/desktop/src/main/workbench/application.ts` | `d90d0cab0e17f69d28bc0703912b9594421a38f0e42576b03aff767d2e0c094b` |
| `apps/desktop/src/main/workbench/host.ts`        | `f9f1bd2b4a26cc5f4a5d93d827e0d205d644e90670031779e3b69fd47bbad46f` |
| `apps/desktop/src/main/workbench/ports.ts`       | `2709c616e108cd33f95e3674386632c1a3855a641ad8824c9796344666eb3a98` |
| `apps/desktop/src/main/preview/controller.ts`    | `3f2310add611e8891381aa514dd1adf0a8551e06eb45161195882dbbbdc89531` |
| `apps/desktop/src/main/chat-service.ts`          | `fce38247c977a5d05afcfaaf505f5557d4a95545efe56180da7c0b9185d2f88e` |
| `apps/service/src/app-service.ts`                | `c9f666d6fcfe47d2c08fe26320c0edfc955fd91ba8e86a4b4c2a8a0d2e6697e3` |
| `apps/service/src/app-helper.py`                 | `e0f6b8be535f9c79cc99ebf57328d37af6266c255be66ec4395c5c63595f92dc` |
| `apps/service/src/codex-chat.ts`                 | `c22d80846dc28034f0ca2e265778622069c3065d4bf998f3253f16c08ab8092b` |
| `apps/service/src/resource_mcp.py`               | `ee0205404fccefc40d5d34093423ccb8124efa78702b706eabc0195803cccfae` |
| `apps/service/src/guest-helper.py`               | `d77dae764d1b677e1866368d483cde396a3363464823a4de7642d0a8009a3f8b` |

## 2. 工作包与文件责任

主线程串行实施与审查；共享 protocol/Main/service 接线按包顺序修改。

| 包               | 允许修改路径                                                                                                                                                                                                                     | 交付                                                                                                                                                            | 依赖与停止点                                         |
| ---------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------- | ---------------------------------------------------- |
| A0 协议          | `packages/protocol/src/app-control.ts`（新）、`index.ts`、`chat.ts`（新消息/请求）、`preview.ts`（`agentControl`）、`workspace.ts`（`resumeAgent`）及其测试                                                                      | 工具输入输出、错误码、引用/代次、审计、场景/轨迹、agent-cli 输出 schema                                                                                         | 无；协议测试通过后进入 A1                            |
| A1 模板          | `templates/standard-app/**`（不含 `node_modules`、`dist`）                                                                                                                                                                       | registry/bridge/commands、agent-cli、server agent 路由、manifest 导出与 `--check`、testid、`build:agent`、生产排除检查、模板测试、版本 1.1.0 与 `template:hash` | A0；`npm run check`、`template:verify`、排除检查通过 |
| A2 Main          | `apps/desktop/src/main/workbench/app-control.ts`（新）、`application.ts`、`ports.ts`、`host.ts`、`preview/app-ui.ts`（新）、`preview/controller.ts`、`chat-service.ts`、`index.ts` 及测试；renderer `workspace/Browser.tsx` 指示 | dispatcher、授权、CDP 快照/动作/bridge、用户接管、审计、场景                                                                                                    | A0、A1 的 bridge 协议                                |
| A3 Service/guest | `apps/service/src/app-service.ts`、`app-helper.py`、`codex-chat.ts`、`index.ts`、`resource_mcp.py`、`guest-helper.py` 及测试                                                                                                     | app-call 路由、HTTP/agent-cli 执行、日志、MCP 工具、`wsl-app` CLI                                                                                               | A0；与 A2 共享消息协议                               |
| A4 场景          | Main `app-control.ts` 场景部分；`tests/app-control/fixed-task/**`（新，固定基准）                                                                                                                                                | 场景运行、轨迹/截图/状态 diff、固定任务与基准场景                                                                                                               | A2                                                   |
| A5 整合          | `e2e/app-control-*.spec.ts`（新）及 harness、README、current-runtime、UX-CONTRACT、验证记录                                                                                                                                      | 真实 Electron CDP 集成、回归、文档、证据                                                                                                                        | 全部                                                 |

不可改动：VS001 基线（`docs/acceptance/**` 既有文件、`tests/vertical-slice/**`、`fixtures/vertical-slice/**`）、既有 `browser.*/files.*/terminal.*` 合同与预算、受管 App create/start/stop/export 语义（仅允许新项目改用 `build:agent`）、固定基准文件在冻结后不得为通过而修改。

## 3. 固定样例（冻结）

读取 `templates/standard-app/src/App.tsx` 与 `server/app.ts` 后确定：模板已有开发会话 A/B 与按用户隔离的 `GET/PUT /api/kv/:key`，seed 为 A、B 写入 `welcome=Ready`，首页只有健康状态卡片。固定修改任务（文本冻结于 `tests/app-control/fixed-task/task.json`）：

> 在首页“应用服务”区块下方新增“欢迎语”卡片：以开发会话 A 读取 kv 键 `welcome` 显示于 `data-testid="welcome-value"`；提供输入框 `data-testid="welcome-input"` 与“保存欢迎语”按钮 `data-testid="welcome-save"`；点击后经 `PUT /api/kv/welcome` 保存并显示新值；去除首尾空白后为空时显示“请输入欢迎语”（`data-testid="welcome-error"`）且不发请求；刷新页面后仍显示已保存值；用 `exposeState('welcome', …)` 暴露 `{value, saving, error}`。不修改其他 API 与测试基准。

固定基准位于本仓库 `tests/app-control/fixed-task/`（guest Agent 写入范围外）：`scenario.json` 依次导航首页、等待 `welcome-value`、空值点击断言错误提示、输入“固定验收 2026”并保存、断言显示、重新导航后断言仍显示、断言无 console 错误、截图；Host 另以 `app.data.query` 核对 A 的 `welcome` 值。基准在原版模板上应于第 2 步失败（`element_not_found`），作为“原版检出不满足”的证据。Agent 自写场景不计验收。

## 4. 验收矩阵

状态初始全部 `not_run`，结果按实际填写于证据目录的 `acceptance-matrix.md`。

| 编号 | 操作                                                                                | 通过标准                                                                                                   | 证据类型                                                    |
| ---- | ----------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------- |
| A01  | `app.describe` / `wsl-app describe`                                                 | 返回页面、数据模型、命令 JSON Schema、状态、testid；`manifestRevision`、`buildRevision` 与当前源码修订一致 | 模板测试（真实 agent-cli）+ Main 单测 + live                |
| A02  | 修改源码后不重建 manifest 调用写操作                                                | 返回 `manifest_stale` 并拒绝；仅重建 manifest 后为 `build_stale`；`app.restart` 重建后恢复                 | 模板测试 + Main 单测 + live                                 |
| A03  | `ui.snapshot` → `ui.act` 完成固定流程                                               | 真实 Electron + 真实 CDP 中完成，截图与状态 diff 留证；产品窗口 + sandbox 需 live                          | 真实 Electron harness e2e；产品 live                        |
| A04  | 导航后旧引用；停止实例后旧租约；无活动 TaskRun 写入                                 | 均明确拒绝且无副作用                                                                                       | Main 单测 + harness e2e                                     |
| A05  | `command.invoke` 非注册名/非法参数；要求任意 JS                                     | 拒绝，schema 错误可读；协议无脚本/坐标字段                                                                 | 协议/Main 单测 + harness e2e                                |
| A06  | agent-cli `db query` 写语句；`data.reset` 无授权                                    | 拒绝；有授权时只影响本实例数据目录                                                                         | 模板测试（真实 PGlite）+ Main 单测                          |
| A07  | 用户在 Browser 区操作时 AI 正在 act                                                 | 返回 `paused_by_user`；指示可见；不抢焦点                                                                  | harness e2e（`sendInputEvent` 模拟用户输入）；产品窗口 live |
| A08  | 取消进行中的 `scenario.run`                                                         | 停止新步骤，核实 CDP 指令返回、guest 子进程清理，保留已产生修改并报告实际状态                              | Main 单测 + harness e2e                                     |
| A09  | 同一场景回放两次                                                                    | 轨迹步骤一致，证据绑定修订与 appInstanceId                                                                 | Main 单测 + harness e2e                                     |
| A10  | 模板 `npm run build` 后检查产物                                                     | `dist/client` 无 `__WSL_AGENT__` 与桥接标记；agent 模式产物有                                              | 模板测试 + 检查脚本                                         |
| A11  | 真实 Codex 在 guest 中仅凭 describe + 工具完成固定修改并自验                        | 经 UI 验证通过；无无关文件变更                                                                             | 需用户授权真实模型与 sandbox；否则 `not_run`                |
| R01  | 既有 `browser.*`、`files.*`、`terminal.*`、VS001、受管 App create/start/stop/export | 行为与权限不变                                                                                             | 既有单测/全量测试、`baseline:selftest`、MCP python 测试     |

## 5. 验证命令与证据

先跑受影响包的定向测试和负例，再分别执行并记录原始退出码：

```sh
node scripts/check-docs.mjs
pnpm typecheck
pnpm lint
pnpm format:check
pnpm test
pnpm build
pnpm baseline:selftest
git diff --check
```

模板目录内另跑 `npm run check`、`npm run template:verify`、`npm run build && node scripts/agent-exclusion-check.mjs dist/client`。真实 Electron harness：`pnpm build` 后 `pnpm exec playwright test e2e/app-control-harness.spec.ts`。真实窗口产品流程、真实模型、sandbox live 仅在获授权后执行。

证据目录：`docs/verification/2026-10-11-app-control-plane/`，每轮一个 `round-NN/` 子目录（命令、退出码、截图、轨迹）；`acceptance-matrix.md` 按编号链接证据，填写 passed/failed/undetermined/not_run。不得通过删断言、改固定基准或放宽 schema 制造通过。

## 6. 停止点

- D1–D3 后自审（见设计 §9），无阻断问题则进入 A0。
- 若 CDP 写操作与人工 DevTools、页面现场采集无法在不破坏既有合同下共存，停止实现并交回决定。当前设计按既有合同处理：CDP detach 时拒绝写入并要求重新附着。
