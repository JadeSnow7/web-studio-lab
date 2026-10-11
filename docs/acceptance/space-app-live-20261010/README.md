# 空间 App 真实沙箱与模型链路验证

真实 App 创建、原生元素采集、产品任务调用真实模型修改源码、同一工程重启与新页面验证的完整链路通过。尝试 02 曾被 `401 token_expired` 阻塞；用户完成 OAuth 后，尝试 03 用原验收脚本复跑通过，历史失败收据保留。

工作树：`/private/tmp/web-studio-lab-space-app-model`；分支：`codex/space-app-model`；基线：v0.1.5 (`cf62dc74f49e7f9e81598be7b9e5109cf5946e9c`)。本轮获得真实模型调用授权，不提交、推送或发布。固定范围见 [SPEC](SPEC.md)，上一轮实现与本地测试见 [实现验收](../space-app-model-20261010/README.md)。

## 实际结果

| 检查                                                                                  | 结果                                                                                                                                                      | 证据                                                                                                        |
| ------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------- |
| 真实 App 创建、启动、原生 Browser 身份、数据库隔离与持久化、重启/窗口恢复、导出、取消 | 1 passed，4.2 分钟；最终 awake 端口映射为空                                                                                                               | [运行日志](runtime-01.log)、[详细收据](runtime-01/evidence.json)、[原生页面](runtime-01/native-browser.png) |
| 模型链路尝试 01                                                                       | 测试定位同时匹配隐藏示例页和当前 App，采集前失败；未调用模型。已修正为可见容器与 resourceId 联合定位，原断言保留                                          | [失败日志](model-01.log)、[收据](model-01/evidence.json)                                                    |
| 模型链路尝试 02                                                                       | 实际 h1 捕获、页面身份、App 工程绑定及任务确认通过；真实模型返回 `401 token_expired`，零工具调用，run=failed、cleanupPending=false；所属 App 进程清理为空 | [失败日志](model-02.log)、[收据](model-02/evidence.json)                                                    |
| 全量类型检查                                                                          | 通过                                                                                                                                                      | [日志](typecheck.log)                                                                                       |
| 应用持久化/任务状态相关单测                                                           | 4 文件、21 项通过                                                                                                                                         | [日志](focused-regression.log)                                                                              |

尝试 03：`1 passed (2.7m)`，见 [运行日志](model-03.log) 与 [完整收据](model-03/evidence.json)。产品内任务捕获 `div#root > main > h1`，真实模型执行一次工具命令，修改绑定工程的 `src/App.tsx`，退出码 0。源码清单只有该文件散列变化，字节比较仅有一次标题替换，见 [源码差异](model-03/source.diff)、[修改前](model-03/App.before.txt) 和 [修改后](model-03/App.after.txt)。

App 工程 `958a7f2a-0474-450f-a938-3a006accedee` 停止并重新构建后，原生页面显示 `WSL_APP_MODEL_b026b5a262064f4bb4618886392fe946`；项目及 Browser 资源身份不变，运行实例更新，健康接口身份与 Main 一致。主线程检查了 [重启后的原生页面截图](model-03/native-after.png)。最终 run=completed、cleanupPending=false；App=stopped、cleanupConfirmed=true，所属 App 进程为空、cleanupErrors 为空。清理后额外保持 guest 活跃并只读查询端口映射，确认映射为空，两个运行实例健康地址均不可达，见 [清理后复核](model-03/post-cleanup.json)。测试保留 validation=not_run、review=null，外部验收通过不伪造产品内独立检查或用户接受。

补充回归：App 表单与 Browser 元素任务 Electron 测试 13 项通过，见 [日志](e2e-regression.log)。默认未设置真实模型授权标志时 1 skipped，不启动 App 或调用模型，见 [门控日志](default-live-gate.log)。

沙箱沿用 `wsl-sbx-smoke-20261006`，每次使用独立用户数据目录及新 App 工程。未经处理的 profile 和 App 源码保留在 `/private/tmp/wsl-space-app-live-20261010-runtime-01` 及 `/private/tmp/wsl-space-app-model-live-20261010/<nonce>`，本目录仅归档验收收据与截图，不复制登录凭据。

## 本轮变更与复现

新增 [真实模型链路测试](../../../e2e/space-app-model-live.spec.ts)。测试从产品 UI 创建 App、采集原生页面元素、确认任务并启动模型；只读观察 guest 源码前后哈希，要求仅 `src/App.tsx` 标题发生一次替换，然后停止/启动同一工程并核对原生页面。测试不直接调用独立模型、不代写目标文件、不将运行完成视作用户接受。

上一轮 14 个源码及测试文件哈希全部保持一致，见 [核对记录](starting-source-verification.json)。本轮开始时的工作树差异见 [状态](starting-status.txt) 与 [差异](starting-tracked.patch)。

使用 pnpm 10.34.6，以下命令均在上述独立工作树运行。`ARCHIVE` 指向本机既有 `/private/tmp/wsl-v015-signed-verification/Web Studio Lab.app/Contents/Resources/runtime/template-dependencies.tar.gz`；其归档与模板锁文件散列见 SPEC。

```sh
ARCHIVE='/private/tmp/wsl-v015-signed-verification/Web Studio Lab.app/Contents/Resources/runtime/template-dependencies.tar.gz'
PATH=/private/tmp/wsl-pnpm10:$PATH WSL_APP_LIVE=1 \
WSL_SBX_NAME=wsl-sbx-smoke-20261006 WSL_APP_DEPENDENCY_ARCHIVE="$ARCHIVE" \
WSL_APP_EVIDENCE=/private/tmp/wsl-space-app-live-20261010-runtime-01 \
pnpm exec playwright test e2e/managed-app-live.spec.ts

PATH=/private/tmp/wsl-pnpm10:$PATH WSL_APP_MODEL_LIVE=1 \
WSL_SBX_NAME=wsl-sbx-smoke-20261006 WSL_APP_DEPENDENCY_ARCHIVE="$ARCHIVE" \
WSL_APP_MODEL_EVIDENCE=/private/tmp/wsl-space-app-model-live-20261010 \
pnpm exec playwright test e2e/space-app-model-live.spec.ts

PATH=/private/tmp/wsl-pnpm10:$PATH pnpm typecheck
PATH=/private/tmp/wsl-pnpm10:$PATH pnpm exec vitest run \
  apps/desktop/src/main/workbench/managed-app.test.ts \
  apps/desktop/src/main/workbench/space-app-persistence.test.ts \
  apps/desktop/src/main/workbench/observation-persistence.test.ts \
  apps/desktop/src/main/workbench/runtime-outcomes.test.ts
PATH=/private/tmp/wsl-pnpm10:$PATH pnpm exec playwright test e2e/space-app.spec.ts e2e/workbench.spec.ts
PATH=/private/tmp/wsl-pnpm10:$PATH pnpm exec playwright test e2e/space-app-model-live.spec.ts
```

本轮未改产品源码，运行上一轮构建产物；完整类型检查和定向回归已重跑。新增测试的定向 ESLint、Prettier、文档链接和 diff 检查通过。未重跑全仓 Lint/格式检查，上一轮已记录的历史失败仍不能算通过。运行日志中的 Electron GPU mailbox 警告原样保留；真实原生页面截图和 DOM 校验通过，窗口 `capturePage` 不合成子 WebContentsView 的画面，因此原生页面另行截图。

尝试 02 后的审阅补强仅涉及测试收据与清理：失败时立即写收据、按任务版本找回尚未捕获 runId 的所属执行、检查清理后执行仍存在且 cleanupPending=false，并独立尝试停止 App。该补强通过静态检查、默认跳过检查及尝试 03 真实模型复跑；原始失败收据未改写。尝试 03 前再次核对，14 个已有源码/测试文件及 live 脚本均与上次记录的 SHA256 一致，没有为复验调整目标或放宽断言。本次登录后的续验未修改产品代码，也未重复运行已经通过且源码未变的全量回归。

用户已通过 `sbx secret set openai --oauth` 完成浏览器登录；未读取或复制令牌。此次结果证明该指定沙箱、当前源码和单次标题修改的完整运行链路；不扩展为任意 App 修改、自动范围强制隔离或完整比赛业务验收。未做安装包、提交、推送、发布、部署或用户接受。
