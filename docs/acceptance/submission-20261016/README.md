# 参赛交付 PR 整合 · 2026-10-16

本记录是文档提交前的本地验收快照，区分当前代码候选的回归与之前的真实模型、窗口及录像验收。远端提交和最终 CI 结果由对应 PR 描述及 Actions 回执登记，可从仓库的 [PR 列表](https://github.com/JadeSnow7/web-studio-lab/pulls)与[Actions](https://github.com/JadeSnow7/web-studio-lab/actions)定位；下文 `not_run` 限定到本地记录时点，不表示持续在线状态。既有失败、人工介入和保全限制保持原结论，不因新候选的检查通过而改写。

## 候选与纳入范围

- 仓库：`JadeSnow7/web-studio-lab`；目标分支 `main`，整合开始时远端基线为 `b5531e1ac3b3da7adf000f6ba61f2c5b19a0755f`。
- 独立候选分支：`agent/submission-20261016`；实现 commit 为 `120d34777db305b99e9501951363fe64e049a69f`。本记录封存本地回归；文档提交后创建 Draft PR 并运行 validate-only，远端提交与 CI 结果以对应 PR 回执为准，不声明已发布或已合并。
- 来源：`agent/mota-preparation-20261015` 的本地修改快照；保留原工作树、录像与手帐数据。按清单搬运的 90 个已有修改文件与 121 个新文件逐项内容和权限匹配；此计数是文档整合前快照，不是最终提交文件数。
- 本次范围：App/外部工程接入、受管魔塔游戏与编辑器、onApp 保存异常处理、受限真实 Agent、公开研究搜索与保存修复、源码 diff，以及相关协议、测试和文档。无扩展功能或通用重构。
- 共享打包修复：`payload-lib` 规范化 guest 与标准模板 tar 的权限，目录和可执行文件为 `755`、数据文件为 `644`；`guest-platform` 增加权限审计。这会改变载荷归档 hash，不只是 edu/Python 测试调整；没有扩大原流水线的下载、执行或发布能力，本轮未签名、公证或发布 Release。
- 麦克风签名声明：主 App 和普通 helper 的签名配置新增 `audio-input`，并增加 `NSMicrophoneUsageDescription`。自定义 plist 的 3 个 JIT/library 项与 electron-builder 26.15.3 默认值一致，Python 仍使用独立空 entitlements，`signIgnore` 不变。学生页范围由产品门禁限制，不是 OS 页面级隔离；本轮未实测 TCC、物理麦克风或签名发布。
- 排除：7 个 VS001 固定基线文件的格式改动、P0 D 的 16 个原始诊断文件、录像、私人数据、凭据、构建产物及许可未核清的魔塔工程资产。原件仍在本地保留；P0 D 历史摘要见[计划](../../plans/2026-10-15-p0-run-diff.md)。
- 最终文档补丁在独立树中应用前，6 个既有输入的 SHA-256 与原字节基线完全匹配，新文件不存在，`git apply --check` 通过。补丁基于原未提交文档，不是干净 HEAD；应用后另更新候选状态与本记录。

## 本次回归

实际环境：macOS Apple Silicon（darwin arm64），Node 26.5.0，pnpm 10.34.6，本机 Python 3.9.6。项目期望 Node 24；当前机器版本与目标版本的差别保留，不能把 Node 26 的结果称为 Node 24 验收。

| 检查                                | 当前结果                  | 说明                                                                                                                                         |
| ----------------------------------- | ------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------- |
| `pnpm install --frozen-lockfile`    | passed                    | 锁文件安装完成；保留依赖构建脚本被忽略的警告，不把警告称为安装失败                                                                           |
| `pnpm check`                        | failed（exit 1）          | 完整类型检查通过后，lint 在固定 VS001 的 `tests/vertical-slice/cdp.ts:16:9` 报 `prefer-const`；未继续格式和测试                              |
| `pnpm typecheck`（由 `check` 执行） | passed                    | 3 个 workspace、E2E TypeScript 与 TS 5.9 baseline 均通过                                                                                     |
| `pnpm test` 首轮                    | failed（exit 1）          | 94.34 秒；文件 7 failed / 131 passed / 8 skipped，测试 11 failed / 1962 passed / 18 skipped（共 1991）；首步 Vitest 失败，后续命令未执行     |
| 七个失败 suite 的单 worker 复跑     | failed（exit 1）          | 61.27 秒；6 个文件通过 / 1 个失败，95 个测试通过 / 1 个失败；仅聚合 MCP wrapper 用时 6,327ms 超过默认 5 秒，不覆盖首轮失败                   |
| 修后完整 `pnpm test`（默认并发）    | passed（exit 0）          | Vitest 57.28 秒；138 个文件通过 / 8 个跳过（146），1986 个测试通过 / 18 个跳过（2004）                                                       |
| `pnpm test` 后续 Node 检查          | passed                    | packaging + edu-source 69/69；external-builds 6/6，均由完整命令实际执行                                                                      |
| `pnpm format:check`                 | failed（exit 1）          | 8 个文件：7 个固定 VS001 文件，以及携入的历史 `docs/acceptance/consolidation-20261011/closeout-20261014.md`；范围说明见下文                  |
| 194 个实现路径定向格式              | passed（exit 0）          | 精确清单执行 `prettier --check --ignore-unknown`；暂存 diff 空白检查也通过                                                                   |
| 修后 service 类型检查               | passed（exit 0）          | `pnpm --filter @wsl/service typecheck`；完整类型检查已在此前 `pnpm check` 阶段通过                                                           |
| `pnpm build`                        | passed（exit 0）          | 保留 Zod PURE 注释的 Rollup 警告，不记作零警告构建                                                                                           |
| `pnpm baseline:selftest`            | passed（12/12，exit 0）   | 仅离线基线自检，不替代产品验收                                                                                                               |
| 默认 Electron E2E 首轮              | failed（exit 1）          | 9.6 分钟，190 项：166 passed、22 opt-in skipped、1 failed、1 did not run；命令与原因见下文                                                   |
| 模板独立依赖安装                    | passed（exit 0）          | `npm ci --ignore-scripts`（npm 11.17.0），92 包；模板源码与锁文件 Git 状态未变                                                               |
| 模板补装后定向 E2E                  | passed（exit 0）          | 2 项通过，1.2 分钟；reference 34.7 秒、原模板 32.9 秒，独立输出目录保留首轮 error-context                                                    |
| 文档与 diff 检查                    | passed                    | `node scripts/check-docs.mjs` 检查 19 个规范入口、`git diff --check` 通过；另对 9 份授权文档的本地链接与尾随空白补充核查                     |
| 194 个实现路径暂存审查              | passed（限定范围）        | 193 个文件与来源字节一致，唯一差异为 MCP 测试拆分；未见二进制、实值凭据、魔塔资产或 P0 原始证据，14 个 Python 用例集合一致，不是完整许可审计 |
| 远端提交与 CI                       | not_run（本地记录封存时） | 文档提交后创建 Draft PR、运行 validate-only；后续结果以对应 PR 回执为准                                                                      |

上述 lint 失败位于本次明确排除、与 `b5531e1` 字节一致的固定 VS001 文件；没有修改其断言或基线来制造通过。后续格式与测试独立运行，结果不由 `pnpm check` 的部分执行推定。

格式检查的 7 个 VS001 文件保持冻结基线字节；另一个 `closeout-20261014.md` 是本次携入的旧阶段未跟踪收尾文档，并非 `b5531e1` 中已有的 tracked 文件。该历史档案保留来源快照原字节，没有批量格式化；不能将全部 8 项统称为主线既有文件问题。

同机按 `b5531e1` 的四个输入文件对照，原 Python 14/14 通过（4.805 秒），候选 Python 14/14 通过（5.598 秒），没有 Python 断言失败。修复仅将 `app-control-mcp.test.ts` 中的 14 个 Python 用例分别映射为 Vitest case，并校验完整用例集合；不修改 Python 断言、默认单用例超时或默认并发。原 1 个聚合 case 拆为 14 个，总测试数增加 13，业务覆盖没有新增。修后完整 `pnpm test` 通过；首轮另外 10 项失败在定向与完整复跑均通过，但不能确定全部由资源争用引起，失败记录继续保留。

模板依赖的只读 npm audit 提示 1 个 low、其他等级为 0：锁定的传递依赖 esbuild，公告 `GHSA-g7r4-m6w7-qqqr`，描述 Windows 开发服务器场景的任意文件读取，范围 `0.27.3–0.28.0`。这是原锁定依赖的审计提示，不是本次新增依赖；本轮未改锁、未执行 audit fix，也不由该摘要推定全面安全。

默认 Electron E2E 使用 `env -u ELECTRON_RUN_AS_NODE pnpm exec playwright test`，全新 profiles 与 fixture，未启用真实 live flags。首次失败是 `app-control-harness` 的 reference 用例缺少标准模板独立依赖 `tsx`；根 pnpm 安装不安装该独立模板，同行 serial 第二项因此未运行。22 项是 live/packaged opt-in 跳过，不能计作通过。模板补装与定向复跑不改产品源码，完整首轮的 error-context 保留。补装后两项定向复验通过，与首轮合计覆盖 168 个可运行用例，另有 22 个 opt-in 跳过；这不是一次 190 项全通过，也没有重新运行完整套件。主线程目视核验暗色窄窗导入预览截图无遮挡；合成 fixture 截图仅本地保留，不纳入 PR。

本次 PR 整理新增修改仅为 MCP 测试拆分及文档修正；产品源码保持来源快照内容。实现提交 `120d34777db305b99e9501951363fe64e049a69f` 按核准清单包含 194 个文件，新增 41,331 行、删除 633 行；文档另行提交，避免将后续文档提交号用作此前模型录像的身份。

历史 P0、edu、Mota、真实模型及录像的检查只适用于各自源码/构建。此次没有新的真实模型或 sandbox live 回执，也没有签名、公证、Release 或跨平台导出验收。

## 演示与证据边界

[材料入口](../../submission/README.md)、[演示与复现](../../submission/demo-guide.md)和[E01–E08 证据索引](../../submission/oschina-2026-evidence.md)登记历史运行。84 秒魔塔视频与 130 秒手帐视频已在本地完成，尚无评委可访问的公开链接，本 PR 不上传视频。

手帐正式生成、17 日业务验收与 18 日补录是不同运行。人工目标采集、切页、独立刷新、补录和分段间隔均保留说明；网站 UNESCO 403、Wikivoyage 回执缺陷、未录到的输入开头和历史操作失败不被删去。来源为重新读取的已知商业资料，搜索回执未投影候选 URL，不能证明正文 URL 来自该次搜索，也不构成官方旅游事实核验。

Mota 是用户提供兼容工程的受限接入，不是通用项目导入或 AI 自主路线规划。源码与演示不证明强 OS 隔离；原隔离探针未执行到有效验证阶段。完整产品检查器及报告闭环仍有缺口，历史 Main validation 的 `not_run` 保留。第三方魔塔资产许可仍待核清，PR 不包含这些资产。

## 保全限制与人工待办

录像收尾时，旧手帐四日记录六字段、339 个源码文件和 8 个构建文件在列明范围内一致；这是当时时点核对，不是本 PR 候选字节与录像源码永久相同的证明。Electron 正常菜单 Quit 已发出，之后两个目标 PID 不存在；原 owner/keeper 退出方式及退出码未知。恢复时 sandbox 已停止、端口为空且偏离原四条映射基线，原 owner cleanup gate 未通过。旧魔塔成片是 dataless 云端占位文件，本轮未读取、下载或重算哈希。宿主冻结通过，整体保全仍为 `undetermined`。

仍需人工确认评委可访问的视频/脱敏证据链接、第三方素材许可和最终参赛提交；Draft PR 审阅、合并及 Release 均另行处理。本记录不把这些待办视为已完成。

onApp 保存异常修复限于 Desktop 监听路径；service 的 `apps/service/src/app-service.ts` 中 `child.done.then` 保存拒绝风险本轮未修改，仍需后续处理，不能宣称所有异步保存异常已覆盖。
