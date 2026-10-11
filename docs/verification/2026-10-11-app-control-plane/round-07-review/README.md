# 控制面独立审阅与复验（2026-10-11）

本轮在 Claude 交付的 dirty 工作树上审阅并修复控制面边界，不覆盖既有改动，不提交或推送。目录 `/Users/huaodong/workspace/web-studio-lab`，分支 `codex/app-control-plane`，HEAD `ea3bad9e6602ccec3484cc55b247bae5815975b4`。用户在本轮明确授权真实模型与 sandbox live。

初始状态见 [initial-status.txt](initial-status.txt)、[已有 tracked diff](initial-tracked.patch) 与 [初始源码散列](initial-source-sha256.txt)；复验源码见 [final-source-sha256.txt](final-source-sha256.txt)。这些散列覆盖源码、模板、测试和脚本，不把 HEAD 当作完整 dirty 快照。固定 task/scenario/reference 的散列仍与 round-06 一致，未修改冻结基准。

## 审阅发现及修复

| 问题 | 原实现行为 | 修复与证据 |
| --- | --- | --- |
| 用户暂停未覆盖所有写入 | `paused_by_user` 只在页面动作内拦截，seed/reset/restart 仍可产生副作用 | `AppControl.writable` 统一检查同 run 的暂停；重启保留恢复 stale 源码的用途 |
| 取消与排队期间状态变化 | 已取消请求、排队请求以及等待修订查询的请求可能继续向后端写入，再返回取消；预取消的 service 调用仍发请求或启动 guest | 出队和异步检查后重新核对 run、实例、网页与取消；Main/service 对预取消请求在副作用前短路。修复前 15 个新增负例失败，修复后同基准 81/81 通过 |
| CDP 动作与通道错误 | mouseMoved 回包后取消仍继续按下；等待元素消失会吞掉 CDP 断开错误而误判成功 | 在新副作用前复核取消、暂停和文档；已按下的按钮/按键仍配对释放；waitFor 只处理元素不存在，通道错误向上传递。新增负例修复前 9 failed/7 passed，之后 16/16 passed |
| 场景证据的源码归属 | 结束时读取 currentRevision 并标记整个轨迹，可能把旧页面行为记到新源码 | 轨迹固定起始 manifest 修订，结束核对另存 `revision-check.json`；变化或无法核对时原本 passed 降为 error。负例修复前失败，修复后通过 |

源码改动由 coder 完成，主线程审阅并独立运行下列验证。修改路径为 `apps/desktop/src/main/workbench/app-control.ts`、`main/chat-service.ts`、`main/preview/app-ui.ts`、`apps/service/src/app-service.ts` 及其四个测试文件；另新增 `e2e/app-control-model-live.spec.ts`。没有改产品 UI 外观、固定基准、协议 schema 或模板源码。

负例与回归日志见 [commands](commands/)。`gates-before.log` 开头被同一代理先前挂起的 npx 网络错误覆盖，完整失败断言和最终计数仍在；此原始文件保持原样，见 `gates-notes.log`。主线程首次全量输出 `test-local-pnpm.log` 也保留了相关失败断言及环境限制。

## 已完成的复验

环境：macOS arm64，Node v26.5.0，pnpm 10.34.6。全局 pnpm 为 11.25.0，实际最终命令把 `/Users/huaodong/.npm/_npx/168ca33e231eaaf0/node_modules/.bin` 前置到 PATH 后调用固定版本。npx 的联网失败另存日志，不当作产品失败。

| 命令 | 结果 | 原始证据与范围 |
| --- | --- | --- |
| `pnpm typecheck` | passed | `commands/typecheck-final.log` |
| `pnpm test` | passed | `commands/test-final.log`：Vitest 662 passed / 15 skipped；packaging 27 passed；external-builds 6 passed |
| `pnpm build` | passed | `commands/build-unrestricted.log`；构建输出按仓库既有链接写入外部缓存 |
| `pnpm baseline:selftest` | passed，12/12 | `commands/baseline-selftest-unrestricted.log`；只证明离线固定基线自检 |
| 模板 `npm run check` / `npm run test:agent` | passed，6/6 与 7/7 | `commands/template-check.log`、`commands/template-agent.log`，含真实 PGlite 与两种构建模式 |
| 模板 `npm run template:verify` / `npm run agent:check` | passed | 模板内容 SHA-256 仍为 `f1e2fd604fb1f7df7ba8a98edccb5d75a370da4e94b80f0600a2f23ff1efa06f` |
| `pnpm exec playwright test e2e/app-control-harness.spec.ts` | passed，2/2 | `commands/harness.log` 与 [harness/results.json](harness/results.json)；真实本地 Electron/CDP、原版负例与参考实现，不使用模型或 sandbox |
| `pnpm exec playwright test` | passed，84 passed / 9 skipped / 0 failed，3.5 分钟 | [commands/e2e-final.log](commands/e2e-final.log)；未设置 live/model 开关。R3 焦点用例本轮通过，历史失败未复现，不据此宣称时序问题永久消除 |
| `pnpm lint` | failed，2011 个既有错误 | `commands/lint.log`；本轮修改文件定向 ESLint passed |
| `pnpm format:check` | failed，794 个既有文件 | `commands/format-check.log` 与 `commands/format-check-closing.log`；文件集合与 round-02 完全相同。中间的 `format-check-final.log` 多出本轮刚更新的验收矩阵，已按 Prettier 格式化，原始失败日志保留 |

普通执行沙箱阻止了 Unix socket、回环监听、文件监听及外部构建输出写入；失败原文分别保留在 `test-local-pnpm.log`、`baseline-selftest.log`、`build.log`。经执行工具批准在允许相应本地能力的环境重跑后通过，没有删除断言或改变固定验收。

产品窗口 sandbox 复验见 [round-08](../round-08-live-review/README.md)：A03/A07 通过；真实模型与独立 Host 固定验收见 [round-09](../round-09-model-live/README.md)：A11 的 16 步场景与数据库核对通过。Codex 命令沙箱内 `wsl-app describe` 返回 `transport_unavailable`，CLI 入口仍有该限制；真实 MCP 链路成功。真人输入、完整比赛闭环、打包安装与用户接受没有因此通过。

收尾检查见 [commands/final-checks.json](commands/final-checks.json)，包含文档、diff、冻结源码与运行输入的一致性核对。改动均为本地未提交、未暂存。
