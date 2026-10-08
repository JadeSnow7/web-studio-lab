# VS001 产品适配器接入与验证记录

本轮基于 PR #3 合并后的 main `3e631a9e387190da5a2241945bbf7e14edbd5707`，接入固定 [VS001](../VS001.md) 的真实产品入口。记录日期采用 Asia/Shanghai：2026-10-09。本环境缺少真实 sbx/Codex 和桌面运行条件；本轮不能认定 Agent → Electron → CDP 闭环通过。

## 实现范围

- `src/vertical-slice/adapter.ts` 显式导出 `ExecuteTask`。使用已安装的 Vite 构建现有 Node 服务代码，保持冻结契约、根配置和依赖清单不变。
- 服务入口复用 `SbxConnection`、`GuestProcess` 和 Codex JSON 解析器。向已有、无 host 挂载的 Codex sandbox 传入运行副本，在独占的临时 guest 目录中执行一次 `codex exec`，不恢复旧会话、不重试模型调用。
- guest helper 在确认所属进程停止后回传完整文件清单。适配器核对新增、删除和修改；只有允许的 `src/App.tsx` 变化才能进入页面启动阶段。安全的 App 修改在非零退出或取消时也保留，其他路径违规会阻止继续执行。
- guest 清理或输出排空未确认时，明确返回 `cleanup=false`，保留独占目录和已有修改，并在原始传输帧中记录 runId、目录与原因；不会由临时目录析构器删除仍可能被 Agent 使用的目录。确认停止后才回传快照并删除目录。
- Electron 薄宿主复用产品 `PreviewController` 的原生 Browser 页面。通过该实际 WebContents 的 `Target.getTargetInfo` 取得 targetId，立即解除该调试连接，保持 `about:blank`，由冻结执行器订阅后导航、读取 DOM、执行 postcondition 和截图。
- 页面复用现有 Vite；使用立即登记清理的回环 port=0 探针选择端口，释放后显式 `strictPort` 绑定。释放与绑定之间如有竞争会失败，不回退到其他页面或固定开发端口。显式预优化已有 React 依赖，避免冷启动依赖发现使请求或取消收尾悬挂。
- 临时目录、连接、guest 子进程、Vite 服务和 Electron 进程在创建后立即登记清理。取消禁止新的动作；验收收尾等待异步执行结束和所属资源清理。失败日志不依赖成功返回。

这是 VS001 的适配入口；没有把比赛 C1–C3、项目写入许可、任务页执行或安装包接入算作已完成。

## 边界

`workspace-write` 是 Codex 对独立 guest 工作目录的策略，文件白名单由完整前后审计落实。它不提供同 UID 的逐文件操作系统隔离，也不证明 Agent 在过程中没有暂时写过其他字节。guest 继承已有 sandbox 的 provider/认证配置；没有读取、复制或记录 host 凭据。模型必须用 `WSL_VS001_MODEL` 显式选择，并与实际命令一起记录。

原始 stdout/stderr、传输帧、guest 文件清单和失败阶段保存在本次运行的 `product-diagnostics.ndjson`，位于 `work/` 外并纳入原执行器的 manifest。真实 `thread.started` 到达后，harness.started/log/exited 使用该会话身份；启动前失败不会虚构会话或 Electron 生命周期事件。诊断文件不能充当 DOM 观察或截图。

`webContentsId → targetId` 映射仍需审阅宿主代码；独立 CDP 核验不能单独证明这个映射。暂只支持 macOS/Linux 的所属进程组清理；平台限制应在调用 Agent 前明确拒绝。

## 实现前回执

在创建 adapter 前实际执行冻结入口：runId `f051323e-5b2f-43f8-b8e1-47a9654a4654`，退出码 1，B01–B05 全部 `failed / target_missing / performed=false`。这表示入口缺失，没有调用真实 Agent 或 Electron。

基准指纹为 `94536a5749212a9526ef89c53a3c4b8e39b8f06a2f69d996eff46d0369e3e332`，覆盖原有 14 个冻结文件。[原始回执](before-run/report.json)、[manifest](before-run/manifest.json) 及 [命令输出](commands/baseline-before.stdout.txt) 原样新增归档；`work/` 不属于 manifest，未复制。历史回执、VS001、tests/vertical-slice、fixture、package 和锁文件保持原字节。

## 当前运行条件与结果

[实际运行条件](runtime-conditions.json)：Linux x86_64，Node v24.19.0；安装固定 pnpm 10.34.6 的锁定依赖成功。未发现 sbx、host Codex、Docker、Xvfb 或显示会话，也未配置 `WSL_SBX_NAME`、`WSL_SBX_BIN`、`WSL_VS001_MODEL`。已安装 Electron 44.5.1 的 npm 包，本机 Electron 二进制缺失。host Codex 不是生产通路所需工具，关键缺口是已认证的 guest Codex 和 sandbox。

实际执行的检查如下；[验证汇总](verification.json)绑定最终源码及命令回执的 SHA-256。

| 命令或检查                                                       | 真实结果                                                | 原始记录                                                                                           |
| ---------------------------------------------------------------- | ------------------------------------------------------- | -------------------------------------------------------------------------------------------------- |
| 固定 pnpm 安装锁定依赖                                           | exit 0                                                  | [install](commands/install.stdout.txt)                                                             |
| `pnpm typecheck`                                                 | exit 0，含产品、E2E 和冻结基线类型                      | [typecheck-final](commands/typecheck-final.stdout.txt)                                             |
| `pnpm build`，最终 helper 修改后 `pnpm build:service`            | 均 exit 0；Electron 窗口未启动                          | [build](commands/build.stdout.txt)、[build-service-final](commands/build-service-final.stdout.txt) |
| 5 个相关 Vitest 文件                                             | 52 passed / 2 skipped / 54 total，exit 0                | [test-adapter](commands/test-adapter.stdout.txt)                                                   |
| `pnpm test` 全仓                                                 | 446 passed / 9 failed / 10 skipped / 465 total，exit 1  | [stdout](commands/test-all.stdout.txt)、[stderr](commands/test-all.stderr.txt)                     |
| `pnpm baseline:selftest` 原脚本                                  | exit 1，tsx CLI 的 Unix socket listen EPERM，未进入自检 | [stderr](commands/baseline-selftest-final.stderr.txt)                                              |
| `node --import tsx --test tests/vertical-slice/selftest.test.ts` | 原样自检 12/12，0 skipped，exit 0                       | [baseline-selftest-node](commands/baseline-selftest-node.stdout.txt)                               |
| 修改的 6 个 TS 文件 lint / 格式                                  | 均 exit 0                                               | [lint](commands/lint-changed.exit.txt)、[format](commands/format-changed.stdout.txt)               |
| Python 语法、文档与源码 diff 检查                                | 均 exit 0                                               | [verification](verification.json)、[docs](commands/docs.stdout.txt)                                |
| 全仓 lint / 格式                                                 | exit 1；217 lint errors；格式当次扫描 740 个文件有问题  | [lint](commands/lint-all.stdout.txt)、[format](commands/format-all.stderr.txt)                     |

相关测试实际构建、导入 service 入口和薄 Electron 宿主；用同一生产 Vite 配置请求未改动的 fixture、main/App/JSX 依赖并确认关闭；检查真实 host 子进程组的 EOF 和 TERM 收尾。合成协议与失败刺激只用于单位检查，未接入冻结验收，也未用来证明真实 Agent。冻结自检只证明检查器的合成拒绝能力。

两个新增组件测试未执行，是因为当前宿主 `/proc` 的 PPID/session 与进程系统调用不一致，见[进程表条件](process-table-condition.json)。在该条件下直接运行 actual helper 的取消探针得到 `guest output drain not confirmed / cleanup=false`，原始[输出](commands/helper-close-environment.stdout.txt)和[回执](commands/helper-close-environment.result.json)已保留；只清理了探针明确创建的子进程。这份探针回执绑定其当时 helper 哈希，早于最后的目录保留修正。最终组件检查另以明确标记的清理确认失败刺激，验证 helper 退出后目录和修改仍保留；真实 sbx guest 的 close/EOF 后代清理仍未验证。

全仓失败来自 4 个既有测试文件：local-terminal-detached 的 2 项进程身份测试、local-terminal 的 5 项 PTY 测试、observation-socket 的 1 项 Unix socket 测试，以及 resource-mcp 的 1 项测试（本 Python 缺少 `fcntl.F_ADD_SEALS`）。相关源文件和测试未修改，也未把这些失败改为跳过。全仓 10 项跳过包含原有 8 项未启用的 live 测试及上述 2 项组件前置条件跳过。全仓 lint/格式检查也未通过；没有自动格式化冻结文件、历史或新增原始回执。源码的 diff 空白检查通过；整个暂存区的检查返回 2，仅报告新增原始命令输出中的尾部空行和一处尾随空格，这些输出保持原字节。

## 实现后原执行器的前置条件回执

由于 tsx CLI 的 socket 权限限制，用同一已安装加载器直接执行未改动的入口：`node --import tsx tests/vertical-slice/run.ts`。runId `a29c205a-7ec1-41df-98cd-f7c6ba32fafb`，exit 2；适配器实际构建、导入后因缺少 `WSL_VS001_MODEL` 拒绝启动。没有调用模型、Electron 或 CDP，没有 observation、postcondition 或 PNG。

| ID  | 原执行器 status / code     | performed |
| --- | -------------------------- | --------- |
| B01 | failed / product_failure   | true      |
| B02 | undetermined / not_reached | false     |
| B03 | undetermined / not_reached | false     |
| B04 | undetermined / not_reached | false     |
| B05 | undetermined / not_reached | false     |

B01 的 `performed=true` 表示执行器已尝试调用适配器，不代表真实 Agent 已运行；这是前置条件拒绝检查，不是五项真实场景的复验。[report](after-preflight-run/report.json)、[产品诊断](after-preflight-run/product-diagnostics.ndjson)与 [manifest](after-preflight-run/manifest.json)按原字节新增归档。事件为空，页面副本没有变化，cleanupErrors 为空；两个归档 manifest 均通过原 `verifyManifest`，前后基准指纹一致，见[指纹核对](baseline-verification.json)。

真实场景仍需逐项执行：

| 产品检查 | 本轮真实场景状态 | 尚需实际执行                                                  |
| -------- | ---------------- | ------------------------------------------------------------- |
| B01      | not_run          | 已认证 guest Codex 一次修改、真实会话/命令/退出及允许路径变化 |
| B02      | not_run          | 实际 Electron 进程、回环 CDP 发现及同页身份                   |
| B03      | not_run          | 原执行器从指定 target 读取真实 DOM、URL 和 runId              |
| B04      | not_run          | 原 postcondition 对原始观察及异常窗口的判定                   |
| B05      | not_run          | 同 CDP session 的 PNG、原始日志、清理和 manifest 核验         |

## 在具备运行条件的机器上复验

按[已有安装说明](../../development/dependencies.md)准备现有、已认证的 mountless Codex sandbox 和 Electron 桌面权限。确认 guest Codex 支持本次记录的 `exec --json --sandbox workspace-write --model` 参数。适配器不创建、停止或删除整个 sandbox，不复制认证信息，不通过关闭 Chromium sandbox 来绕过系统权限。

从仓库根目录执行：

```sh
npx --yes pnpm@10.34.6 install --frozen-lockfile
npx --yes pnpm@10.34.6 typecheck
npx --yes pnpm@10.34.6 baseline:selftest
WSL_SBX_NAME="<已有沙箱名>" WSL_VS001_MODEL="<实际模型ID>" npx --yes pnpm@10.34.6 baseline
```

`WSL_SBX_BIN` 仅在需要指定已有 sbx 可执行文件时设置。每次运行产生新的 `records/vertical-slice/<runId>/`。对照本轮基准指纹并复核原始 Codex 输出、全部文件变化、Electron 身份、CDP、PNG、manifest 和清理错误；B01–B05 全部 passed 后才能认定这个固定场景通过。缺少运行条件或只通过离线检查不能记为端到端通过。
