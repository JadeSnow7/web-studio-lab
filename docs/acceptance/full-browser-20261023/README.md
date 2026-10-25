# 应用内完整浏览验证记录

> 发布整理说明（2026-10-25）：下文保留来源工作树的历史实现与验证记录，并非当前整合提交的复验结果。截图、原始日志、DOM/机器回执及其审查材料仅在本地证据归档保留，本次未公开；文中的相对证据路径仅用于本地追溯，不能作为已交付的可访问证据。当前分批整合未运行 Electron 窗口、真实模型或 guest 写入，且继承 Harness #18、#22、#23 的未解决审查阻塞，不能据这些历史记录判断可合并。

普通网页已改为应用内 Chromium 原生浏览；受控网站完整流程及公网百度回车搜索已在真实 Electron 中验证。最后一次点击可见搜索按钮已提交并跳转，但百度要求验证码，结果断言未通过。合同为 [BROWSER-1](SPEC.md)，日期为 2026-10-23。真实第三方账号登录、全部网站兼容性和打包版本未验收。

## 改动范围

- `apps/desktop/src/main/preview/controller.ts`：原生 HTTP/HTTPS、frame 与受控应用内弹窗；弹窗保持 opener/postMessage，关闭所属实例时销毁；显式保存当前可见正文。
- 新增 `preview/browser-session.ts`：共享 session 的网络监听按视图登记与释放；普通网页允许原生网络请求，受管 App 保持精确 origin 与有效租约限制。
- `workbench/host.ts`：普通网页采用按空间持久分区；受管 App 继续使用独立临时分区。`navigation-policy.ts` 校验原生网页 URL；`demo-protocol.ts` 在同一 session 只安装一次。
- `renderer/src/workspace/Browser.tsx` 与新 `browser-address.ts`：域名补全、关键词搜索、清空地址；保留已有草稿、IME 与迟到响应处理。
- `packages/protocol/src/resources.ts`：新增严格的宿主 DOM 快照变体，保留历史与 guest 变体。
- 删除退役的 `public-document.ts`、`public-protocol.ts` 及只读代理专属测试；原 `e2e/public-document.spec.ts` 由真实 HTTP 的 `full-browser.spec.ts` / `fixtures/full-browser-server.ts` 替代。既有原字节已备份。
- 更新 README、UX-CONTRACT 与 current-runtime；没有重做工作台样式。`Browser.tsx` 的 `.status-slot` 点击变更属于并行已有工作，不归本轮实现。

起点 HEAD 为 `fe3684f96c45e826af1071eb2058184c4aca4bf8`。本轮开始前已有大量 dirty/untracked 内容；原文件、起始状态及完整起始 diff 保存在 `/private/tmp/wsl-full-browser-20261023-baseline/`。未 reset、stash、提交、推送或发布。

## 实际验证

主线程审阅实现增量后独立运行；测试使用构建后的 Electron 和临时用户配置，不使用真实账号、模型或 sandbox live。

| 检查                                                                                       | 实际结果与证据                                                                                                                                                        |
| ------------------------------------------------------------------------------------------ | --------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `pnpm typecheck`                                                                           | 通过，含产品与 E2E 类型检查及基线 TS；日志（本地保留：`evidence/typecheck.log`）                                                                                      |
| `pnpm build`                                                                               | 通过；日志（本地保留：`evidence/build.log`）。存在依赖 PURE 注释警告，不影响构建                                                                                      |
| `pnpm exec vitest run --maxWorkers=2`                                                      | 112 套、1535 项通过；8 套、26 项按已有条件跳过；日志（本地保留：`evidence/vitest-unrestricted.log`）                                                                  |
| `node --test scripts/packaging/*.test.mjs`                                                 | 40 项通过；日志（本地保留：`evidence/packaging-tests.log`），不是安装包验收                                                                                           |
| `pnpm test:external-builds` / `pnpm test:edu-source`                                       | 分别 6 / 57 项通过；外置构建（本地保留：`evidence/external-builds.log`）、源码导出（本地保留：`evidence/edu-source.log`）                                             |
| `pnpm baseline:selftest`                                                                   | 12 项通过；日志（本地保留：`evidence/baseline-selftest-unrestricted.log`），不是比赛任务或真实模型验收                                                                |
| `playwright test e2e/full-browser.spec.ts`，开启 `WSL_BROWSER_PUBLIC_NETWORK=1`            | 本地完整流程与公网回车搜索 2/2 通过；日志（本地保留：`evidence/browser-confirmed.log`）、JSON（本地保留：`evidence/browser-confirmed.json`）                          |
| `playwright test e2e/review-regressions.spec.ts --grep 'address\|navigation deduplicates'` | 13/13 通过，含拒绝、重复提交、组合输入事件、乱序响应、标签/空间切换；日志（本地保留：`evidence/address-regressions.log`）。组合输入事件为测试合成，未验证操作系统 IME |
| `playwright test e2e/workspace-migration.spec.ts --grep 'R3 双网页'`                       | 1/1 通过；两个原生网页的焦点、地址与刷新目标保持正确；日志（本地保留：`evidence/two-browser-regression.log`）                                                         |
| 本轮 TS 文件 ESLint / Prettier                                                             | 通过；lint（本地保留：`evidence/lint-scoped.log`）、格式（本地保留：`evidence/format-scoped.log`）                                                                    |
| `node scripts/check-docs.mjs`、`git diff --check`、`git diff --cached --check`             | 通过；文档检查仅检查入口、链接目标与空白                                                                                                                              |

Electron 命令统一使用 `env -u ELECTRON_RUN_AS_NODE`，并允许测试启动本地窗口/临时端口。完整命令的输出目录前缀为 `/private/tmp/wsl-full-browser-20261023-evidence/`。全默认 E2E、打包启动、真实模型与 sandbox live 为 `not_run`，本轮未请求这些验收范围。

受控 HTTP 的 实际请求及快照证据（本地保留：`evidence/controlled-http-evidence.json`） 覆盖 CSS、SVG 图片、JS、iframe/srcdoc、fetch、Worker、Service Worker、WebSocket、GET 搜索、POST 登录、持久 Cookie/localStorage、同空间共享、跨空间及工作台隔离、重启、两种弹窗、target blank、父实例销毁、前进/后退/刷新、900px 窗口、断连恢复与正文快照重启读取。账号、密码与 Cookie 都是专用 fixture 假值。网页内 `studio` / `require` / `process` 不可见；外部浏览器调用计数为零。快照排除表单、密码、可编辑内容及隐藏节点。

主线程分别检查宿主截图与原生网页截图，不能用宿主截图的空白区域代表网站渲染。恢复登录后的受控网站（本地保留：`evidence/full-browser-fixture-recovered.preview.png`） 显示 authenticated 与 persistent-login；百度原生结果页（本地保留：`evidence/full-browser-public-baidu-search.preview.png`） 显示完整样式、图片与搜索结果。公网回车搜索返回 15 个结果节点，证据在 网站结果（本地保留：`evidence/public-network-evidence.json`）。

## 原始失败与复跑

1. 实现阶段 `-first` 至 `-seventh` 原始失败保存在 `/private/tmp/wsl-full-browser-e2e-*`，后续 `-eighth` 及 `-final` 通过。发现并修复过非法协议导航取消后正文快照不可保存的产品问题；另修正了测试标签选择、菜单/地址定位与空间切换 setup。失败记录未删除。
2. 主线程首次 `pnpm test` 在受限终端内为 1526 通过 / 9 失败 / 26 跳过，并有一个未处理监听错误；原日志（本地保留：`evidence/test.log`） 保留 `EPERM` 本地端口/Unix socket、`EMFILE` 文件监听和 Git 测试超时。允许本地能力且降低并发后的同组 Vitest 全部通过；不能据此单独断言每个初次失败的唯一根因。其后的包装、外置构建和源码导出检查分别完成。
3. 基线自检首次因 tsx 临时 IPC `EPERM` 未执行；原日志（本地保留：`evidence/baseline-selftest.log`） 保留，允许临时管道后 12 项通过。
4. 公网首轮 Example 原断言依赖已经更换的正文；实际页面已加载。首轮日志（本地保留：`evidence/independent-browser.log`） 保留，按当前文档用途文案更新断言后通过。
5. 百度旧 `#kw` / `#su` 仍存在但尺寸为零，误点旧按钮后没有导航；失败日志（本地保留：`evidence/public-retry.log`）、带截图诊断日志（本地保留：`evidence/browser-diagnostics.log`） 保留。实际可见输入为 `#chat-textarea`，按钮为 `#chat-submit-button`；DOM 诊断（本地保留：`evidence/baidu-before-submit-dom.json`） 记录位置与焦点。原生 Enter 路径随后成功，未把旧按钮点击计为通过。
6. 后续复跑曾在多标签加载错误检查失败，并在公网首次加载的 5 秒等待上限超时；日志（本地保留：`evidence/browser-final.log`）。新 fixture 误用共享 helper 读取第一网页状态，现按可见 webContents ID 读取，并确认断连请求确实到达服务、地址命令已结束；网络等待为有界 30 秒。相同 loadError 断言保留并通过。

全树 `pnpm lint` 未通过，2011 项错误主要来自封存证据/复制源码/生成记录，另有既有 `tests/vertical-slice/cdp.ts`；完整日志（本地保留：`evidence/lint.log`）。`pnpm format:check` 初次报告 843 个文件，包含历史归档和既有文档；日志（本地保留：`evidence/format.log`）。新 SPEC 的格式已修正，本轮 TS 定向格式检查通过，没有格式化历史证据。premium 严格审计前后均只有既有 `HarnessProfiles.tsx:137` 表单校验归属错误；前（本地保留：`evidence/premium-before.json`） / 后（本地保留：`evidence/premium-after.json`）。因此不宣称全仓 `pnpm check` 通过。

7. 最终测试改为定位实际可见控件并点击搜索按钮，确认输入值和 `/s?` 导航成功；之后被站点重定向到 `wappass.baidu.com` 的“百度安全验证”，所以搜索结果断言失败。保留最终按钮测试日志（本地保留：`evidence/public-button.log`）、完整结果（本地保留：`evidence/public-button.json`）、可见控件（本地保留：`evidence/baidu-visible-controls.json`）、挑战页诊断（本地保留：`evidence/baidu-button-challenge.json`）与原生截图（本地保留：`evidence/baidu-button-challenge.preview.png`）。未绕过验证码，也未把站点限制改写成测试通过；此前回车搜索成功记录不被覆盖。最终默认离线 fixture 不依赖公网测试，公网测试仍须显式 opt-in。

## 验收边界

真实第三方账号、验证码、跨站 OAuth 提供方策略未实测；本地 fixture 证明表单与持久登录机制、opener/postMessage 流程。权限请求继续默认拒绝，下载未开放。网站证书、同源和混合内容约束保持启用；没有绕过站点风控。用户最终接受与打包分发状态仍未确认。
