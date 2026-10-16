# feat: 整合受管 App、统一状态与 Code Wiki

2026-10-14 状态：[PR #6](https://github.com/JadeSnow7/web-studio-lab/pull/6) 已于北京时间 2026-10-13 22:10:51 合并 main，最终 head 为 `13d3ea44d8b162efec224c6f485cac0fb41a0ffa`，merge 为 `b5531e1ac3b3da7adf000f6ba61f2c5b19a0755f`。Node 24.21 validate_only CI 已通过相应检查，签名、公证、安装包及发布均跳过；详见[收尾记录](closeout-20261014.md)。下文保留合并前文稿及当时授权范围；“未推送、未创建远端 PR、Node 24 未验、旧 PR 开放”均为历史陈述，不作为当前状态。历史全树 lint / format 与 DevTools 间歇性失败仍未解决。

更新日期：2026-10-13。目标 `main` 已通过 GitHub API 核对为 `f77ff9620d3d83d78eb4f62490c684b8155e48b2`；本地候选为 `agent/pr-ready-20261013`，继承 `agent/status-surface` 的 `1bce260` 及此前整合提交。仅授权本地提交，不推送、不创建远端 PR、不发布或部署。

## Summary

- 汇总已有未发布的标准模板、受管 App 生命周期、VS001 adapter、账户资源目录与空间连接；业务事实仍由 Main 单点写入。
- 接入 App CLI / MCP / UI / 数据控制面、空间 App 名称与说明、任务目标冻结，以及两种历史 schema 3 到 schema 4 的保全迁移。执行结束、验证通过和用户接受仍是独立事实。
- 纳入统一状态事实与展示投影，以及尚未提交的六项状态修复：日志不接管旧文件、文件不可用状态归一、诊断实时刷新、SSH 清理未确认时禁用重连、正式 E2E 与证据修正。取消、用户接管、清理未确认保持可见。
- 纳入独立 Code Wiki 原型：8 个模块、运行通信 / 源码依赖、3 条关键流程、搜索与源码弹窗。48 份源码摘录保留 2026-10-12 的历史快照，不冒充当前 PR 的自动依赖图。
- 保留固定验收、历史失败和证据字节，不更新依赖、放宽检查配置或恢复已被后续实现替代的旧状态所有者。

## 本轮审查修复

| 优先级 | 已复现的问题                                                                      | 修复与负例                                                                                                                                                                     |
| ------ | --------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| P1     | `seed/reset` 在能力查询或 pending 持久化等待期间失去执行资格，Main 仍可能派发写入 | 派发前重新核对 run、实例、租约、取消和用户暂停；拒绝时只撤回本次确定未派发的操作，持久化撤回失败继续保留保护。覆盖两种写入、两个等待边界、五种资格变化，另覆盖撤回写盘失败。   |
| P2     | 诊断日志启动后路径被替换为普通文件或硬链接，后续诊断追加到非本进程所有的文件      | 独占创建时保存设备 / inode；每次追加在同一句柄检查普通文件、身份、单硬链接及已写长度。替换、增加硬链接或外部追加后停写，诊断内存继续工作。不是任意外部并发写入的原子隔离承诺。 |
| P2     | Code Wiki 的畸形请求 URL 在异常边界外解析，导致预览进程退出                       | 明确返回 HTTP 400；白名单、回环绑定、GET / HEAD 限制不变。负向请求后再次 GET 成功。                                                                                            |

前两项首先添加负例：原实现的 23 个新增用例全部失败，63 个原用例通过；修复后同一组 86/86 通过，随后补充两项保护边界，最终全量包含 940 个通过的产品测试。红测与首次绿测原始输出保留在会话工具记录中，仓库的本轮全量回执另行链接，不声称已有独立的红测归档文件。源码变更仅落在候选工作树。

## Test plan 与实际结果

环境：macOS ARM64、Node 26.5.0、pnpm 10.34.6、Electron 44.5.1。根依赖 `pnpm install --frozen-lockfile --offline`，模板 `npm ci --ignore-scripts --offline --no-audit --no-fund` 均成功；锁文件不变。Node 24 未单独复验。

本轮命令回执统一复用 [repair-validation](../status-surface-20261011/repair-validation) 下的 `pr-20261013-*` 文件，与原 `final-*` / `sealed-*` 历史结果分开。对应 `.meta.json` 记录完整参数、退出码、起止时间和源码差异哈希；不是把历史结果重新标为当前通过。

| 检查                                        | 结果                                                                                                                        | 回执                                                                                                                                                                       |
| ------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `pnpm typecheck`                            | passed：产品、E2E、固定基线类型                                                                                             | [日志](../status-surface-20261011/repair-validation/pr-20261013-typecheck.txt)                                                                                             |
| `pnpm test`                                 | passed：940 通过、15 显式 live 跳过；另 27 打包逻辑、6 构建目录测试通过                                                     | [日志](../status-surface-20261011/repair-validation/pr-20261013-test.txt)                                                                                                  |
| `pnpm build`                                | passed：service / Main / preload / Renderer；保留既有 Zod / Rollup 警告                                                     | [日志](../status-surface-20261011/repair-validation/pr-20261013-build.txt)                                                                                                 |
| `pnpm baseline:selftest`                    | passed：12/12 离线合成自检，不是实际模型验收                                                                                | [日志](../status-surface-20261011/repair-validation/pr-20261013-baseline.txt)                                                                                              |
| 模板 `npm run check` / `npm run test:agent` | passed：11/11、7/7                                                                                                          | [模板](../status-surface-20261011/repair-validation/pr-20261013-template-check.txt)、[Agent](../status-surface-20261011/repair-validation/pr-20261013-template-agent.txt)  |
| 模板 `template:verify` / `verify:prod`      | passed：内容哈希一致，生产产物不含 Agent 桥接；Agent 测试另验证开发构建确有桥接                                             | [哈希](../status-surface-20261011/repair-validation/pr-20261013-template-hash.txt)、[生产构建](../status-surface-20261011/repair-validation/pr-20261013-template-prod.txt) |
| 产品路径 ESLint                             | passed：`eslint apps packages e2e scripts/packaging --ignore-pattern '**/release-internal/**'`，沿用现有发布工作流范围      | [退出码与参数](../status-surface-20261011/repair-validation/pr-20261013-product-lint.meta.json)                                                                            |
| `pnpm lint`                                 | failed：217 errors、0 warnings；文件集合与源分支封存回执完全相同，无新增                                                    | [日志](../status-surface-20261011/repair-validation/pr-20261013-lint.txt)                                                                                                  |
| `pnpm format:check`                         | failed：801 个文件；与源分支封存回执的文件集合完全相同，无新增                                                              | [日志](../status-surface-20261011/repair-validation/pr-20261013-format.txt)、[集合比对](../status-surface-20261011/repair-validation/pr-20261013-static-delta.json)        |
| Electron 全量窗口回归                       | passed：最终完整运行 155 通过、16 跳过、0 失败；此前环境失败与间歇性失败均保留                                              | [完整回执](../status-surface-20261011/repair-validation/pr-20261013-e2e-final.txt)                                                                                         |
| Code Wiki 语法与 HTTP                       | passed：4 个 JS / MJS 语法检查；GET / HEAD、越界路径、POST、畸形 URL 与服务继续可用                                         | [HTTP 回执](../status-surface-20261011/repair-validation/pr-20261013-wiki-http-v2.txt)                                                                                     |
| Code Wiki 浏览器                            | passed：Chrome 155.0.8059.40，1440px 与 390px；关系图、搜索 / 清除、48 项引用、弹窗 / Escape / 焦点、取消流程末步及刷新恢复 | [浏览器回执](../status-surface-20261011/repair-validation/pr-20261013-wiki-browser-v2.txt)                                                                                 |
| 文档与 diff                                 | passed：文档入口、当前源码 / 规范的定向 diff；全量证据及原始回执空白告警单列，不改写采集内容                                | [文档检查](../status-surface-20261011/repair-validation/pr-20261013-docs.txt)、[定向 diff](../status-surface-20261011/repair-validation/pr-20261013-source-diff.meta.json) |

Code Wiki 的[桌面图](../../design/2026-10-12-code-wiki/evidence/pr-20261013-desktop.png)与[390px 源码弹窗图](../../design/2026-10-12-code-wiki/evidence/pr-20261013-mobile-source.png)已归档。用户明确授权查看这两张图后，完成了布局、可见内容及历史快照说明的目视复核；不扩大为产品窗口全部截图或用户接受。

### 失败和复跑边界

- 首轮完整 Electron 命令为 `failed`：144 失败、1 通过、16 跳过、10 未运行。日志中 Electron 拒绝 `--remote-debugging-port=0`，当前 Harness 实际继承了 `ELECTRON_RUN_AS_NODE=1`。仅对子进程移除此变量后，真实工作台启动检查 1/1 通过；产品与断言未改。[首轮失败](../status-surface-20261011/repair-validation/pr-20261013-e2e.txt)、[独立启动检查](../status-surface-20261011/repair-validation/pr-20261013-e2e-launch.txt) 分别保留，后续全量使用独立输出目录，不覆盖首轮错误上下文。
- 清理环境后的[第一次完整复跑](../status-surface-20261011/repair-validation/pr-20261013-e2e-clean-env.txt)仍为 `failed`：154 通过、16 跳过、1 失败，位置为 `workspace-migration.spec.ts:238` 的 DevTools 重开就绪，不能与旧记录的 `isFocused()` 失败混为一谈。同源码的[独立文件复跑](../status-surface-20261011/repair-validation/pr-20261013-e2e-migration.txt) 8/8 通过，[该用例三次运行](../status-surface-20261011/repair-validation/pr-20261013-e2e-devtools-repeat3.txt) 3/3 通过。本轮没有修改该测试、DevTools 控制器、超时或重试；间歇性原因仍为 `undetermined`，不声称已修复，不用局部结果替代完整 suite。最后一次[独立完整运行](../status-surface-20261011/repair-validation/pr-20261013-e2e-final.txt)为 155 通过、16 跳过、0 失败；它只证明该次运行，不能抹去上述失败或证明间歇性问题消失。
- Code Wiki 验证脚本曾有两次方法错误：原始 TCP 探针提前半关闭连接，及把合法 JS 对象字面量误按 JSON 解析。修正的是检查命令，不是页面或服务器；失败回执 `pr-20261013-wiki-http`、`pr-20261013-wiki-browser` 原样保留，修正后分别以 `*-v2` 独立通过。
- lint / format 对照使用源分支 2026-10-12 的封存回执，不声称本轮重新执行旧工作树基线。历史 probe、源码存档和 VS001 固定文件保持原字节，因此 **不能将 `pnpm check` 或全部 CI 报告为通过**。
- [最终审阅检查](../status-surface-20261011/repair-validation/pr-20261013-final-audit.txt)确认 28 个原 worktree 的 HEAD 未变、固定输入未变、PR 本地链接可在 Git 中解析，待提交源码与测试仍匹配实际运行的散列。全量 PR `git diff --check` 为 exit 2，154 个告警文件均在 docs 证据 / 原始回执内，包含本轮原始 `e2e` / `typecheck` 输出；当前源码与规范的定向检查为 exit 0。未修剪失败日志或 EOF 空行来制造全量通过。
- 产品与 E2E 检查对应 `1bce260` 加 `apps/desktop/src`、`packages/protocol/src`、`e2e` 的差异 SHA-256 `5d67dae7263711cc37eb6a6f7e6a7d79ea49dbd0a74bc68686cac9b29a386bc9`。本轮没有修改 service / 模板 / 依赖源码；该差异不是全仓内容哈希，文档、Wiki 和新增回执另行审阅。

## 全工作树来源与范围裁决

本轮盘点 28 个原 worktree、20 个原本地分支；新增候选不占用任何原工作树。[来源保全复核](../status-surface-20261011/repair-validation/pr-20261013-source-preservation.txt)确认 20 个原分支引用未变，状态修复的 241 个原路径和 Wiki 的 17 个原路径与导入时的 Git 树完全相同；主树 tracked patch 与上轮冻结值相同。此前 24 个来源的逐路径裁决见[历史来源去向](source-disposition.md)，本轮补充如下：

| 来源                                                                  | 本轮处理                                                                                                                                                                                         |
| --------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `codex/app-control-plane` / `codex/c1-development-20261010`，主工作树 | 已有 App 控制面由 `917f375` 继承，不复制旧代码覆盖其审查修复。957 个主树路径与旧整合候选对象相同；纳入新增 Code Wiki。个人 `.devin` 实现代理配置、Python 缓存、根目录旧 audit 留在原处，不纳入。 |
| `codex/space-app-model`                                               | 14 个 tracked 修改与 62 个 untracked 路径仍在原树；status 与 tracked patch 和上轮清单一致。有效 App 元数据增量已在 `917f375` 适配为 schema 4，不回退。                                           |
| `codex/consolidate-review-20261011`                                   | 原树干净、提交 `917f375` 不变；作为状态分支祖先继承，而非重新复制来源树。                                                                                                                        |
| `agent/status-surface`                                                | 继承 13 个状态提交；另纳入 26 个 tracked 修改与 215 份修复回执。导入使用独立 Git index，不修改来源 index；导入前后来源 status / tracked diff 一致。                                              |
| `agent/edu-web-20261012`                                              | 按用户选择独立保留：16 个 tracked 修改、10 个新增路径，涉及外部 Python 项目导入 / 运行；不扩入当前固定 TS 模板 PR，未在本轮运行其验收。                                                          |
| `agent/edu-source-20261012`                                           | 干净的 `be3a9f6`，独立快照 / 三方合并 CLI 及测试保留原分支；不冒充产品导入能力，不纳入本 PR。                                                                                                    |
| 旧 detached / checkpoint / 统一观察与最小闭环来源                     | 可读来源的 status / staged / unstaged patch 与上轮清单一致；沿用已有逐路径替代裁决，不恢复旧 Renderer 业务状态或重复实现。未声称重新逐字节审计全部未跟踪和 ignored 内容。                        |
| Documents 下 `codex/unified-observation`                              | `git status` 在 20 秒、再次检查及 tracked diff 在 10 秒超时；staged patch 与历史相同。其当前完整内容为 **undetermined**，未写入、未从此树导入新内容；此前来源档案仅作历史依据。                  |
| 安装器 / release / competition 分支                                   | 已被候选祖先包含；既定私有原始运行资料继续本地保留。                                                                                                                                             |
| `codex/signing-diagnostics-20261009`                                  | 独立签名诊断仍保留原分支，不触发、不并入产品工作流。                                                                                                                                             |

`origin/main` 的 VS001 固定测试、fixture、根历史 npm 锁、pnpm 锁与工具链 manifest 经 Git 比较未变。本轮检查未检出新增超大 blob；有限私钥 / token 格式扫描仅命中明确的脱敏测试假数据，不构成完整安全审计。

GitHub 上 PR #2 和 #4 仍开放且显示冲突；其文稿 / VS001 有后续整合版本。本轮不合并、关闭、评论或改动它们，不建议将旧差异直接叠加到本候选。

## 未运行与交付边界

- `not_run`：真实模型、sandbox live、packaged E2E、签名、公证、发布、部署、Node 24 单独复验及用户接受；历史 live 证据不能替代这些项目。
- 产品缺口仍在：独立产品检查器、完整比赛 C1–C3 闭环、任务页真实 diff / 报告、Expo / Android。edu 功能按用户决定另行交付。
- 原分支与原 dirty / untracked 内容不 reset、不 stash、不覆盖；所有依赖安装、修复、构建与测试都在新候选目录进行。本 PR 是本地审阅候选，不是已推送 PR 或发布批准。

Generated with [Devin](https://devin.ai)
