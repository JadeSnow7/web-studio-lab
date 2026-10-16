# 全分支与未提交内容整合（2026-10-11）

2026-10-14 状态：PR #6 已合并 main，Node 24.21 的 validate_only CI 已完成；保全档案迁移与本地主工作树同步见[收尾记录](closeout-20261014.md)。下文是 2026-10-11 的历史记录，“本地候选、未推送、Node 24 未验证、旧 PR 开放”均描述当时状态，不适用于当前主线；原正文、失败与回执保持历史含义。

以下保留 2026-10-11 候选的历史结论；2026-10-13 的新候选、状态界面修复、Code Wiki 与实际复验见[当前 PR 说明](PR.md)，不要用本页旧结果代替新版本验证。

候选已整合空间资源、受管 App 控制面和 App 元数据，修复审查发现的迟到响应、取消与迁移问题。限定范围内的验证已完成，候选可作为一个 PR 推送；全树静态检查的已知失败在下文明确保留。交付范围为一个本地 PR 分支，暂不推送、创建远端 PR、发布或部署。

## 分支与审阅入口

候选分支 `codex/consolidate-review-20261011`，独立工作树 `/private/tmp/wsl-consolidate-review-20261011`；继承 `ea3bad9e6602ccec3484cc55b247bae5815975b4` 的七个未发布提交。目标基线为本轮 `git ls-remote` 确认的远端 `main=f77ff9620d3d83d78eb4f62490c684b8155e48b2`。结束前再次只读核对 9 个远端分支与 6 个 tag，目标 main 未变化，原始结果见 [远端记录](remote-final.txt)。PR #2、#4 开放，#1、#3、#5 已合并；本轮未修改它们。

先读 [PR 说明](PR.md)，再按 [来源去向](source-disposition.md) 查看 16 个本地分支和 24 个原工作树的处理结果。[独立复核](independent-review.md)记录具体缺陷与关闭依据，[失败到通过的索引](coder-validation/red-green-index.json)区分实际原始日志和仅存于本轮工具输出的红测证据。

## 整合结果

- 沿用已有资源目录、收藏与空间连接、不可变引用、Main 状态所有权、模板/安装与退出清理实现；保留现有六板块和 Browser/Workshop 界面结构。
- 导入主树未提交的受管 App 控制面：App CLI、数据与 UI 操作、来源/实例约束、取消及清理回执、模板 Agent 开发桥接和生产构建剔除。Python 缓存（含历史目录里的字节码存档副本）和根目录旧 audit 输出不纳入。
- 将空间 App 分支的名称、说明、revision、编辑表单与任务目标绑定适配到当前运行时。编辑描述不启动/停止实例；任务冻结 App/project/guestCwd 与结构化页面/元素上下文，组合 prompt 超预算在创建运行前拒绝。
- 修复 Main 等待结果后的归属复核、UI 查询/桥接及对象清理等待后的失效检查、CLI admission 持久化期间取消造成的迟发进程。停止必须依据进程和清理事实。
- 统一保存 schema 4；显式识别主线带 catalog 与空间 App 分支无 catalog 两种 schema 3，保全账户资源、App 元数据、publicResources 和旧文件原字节备份。损坏来源和未来格式拒绝覆盖。

旧分支内容按提交关系、路径哈希和实际行为去重；已被后续实现替代的旧状态所有者不重新引入。签名诊断仍保留在原独立分支。既有公开摘要之外的 443 个私有原始验收文件继续留在原树及备份，不复制进候选。58 个空间 App 历史文档/证据按原字节纳入，但其 live 结果仅是历史，不是本轮产品验收。

## 原内容保全

[源清单](source-inventory.json)冻结 24 个原工作树，其中 10 个有未提交内容，共 2669 个 dirty/untracked 路径。备份位于 `/private/tmp/wsl-consolidation-20261011`，含 status、暂存/未暂存 binary patch、文件归档、SHA-256 及原 refs bundle；备份路径仅用于本地恢复。原树没有用于写入、安装依赖或执行测试。候选中的 939 份历史文件与来源哈希一致，5 个缓存副本明确排除，见[历史字节核对](historical-bytes-check.json)。历史文档引用的 14 个 ignored 日志另按原字节纳入并登记[哈希](ignored-evidence-imports.json)；[本地证据链接核对](evidence-links-final.json)未发现缺失。

[最终保全核对](original-preservation.json)：24 个原 HEAD、34 个原分支/远端引用/tag 均未变；23 个原树 status 逐字节相同，2668 个未提交路径的内容或删除状态匹配冻结记录。Documents 下 source-15 的完整 status 超时，`apps/service/src/ssh-terminal.test.ts` 最终哈希读取也超时；其 index、untracked 路径和其余 48 个 dirty 路径相同。该一个文件有初始原字节备份，但最终物理字节复核为 `undetermined`，未据此宣称全量哈希通过。

工具最初创建的空托管工作树因不可写已归档；它不属于这 24 个原工作树。实际候选经写入探针验证可写。

## 本轮验证

环境为 macOS、Node 26.5.0、pnpm 10.34.6、Electron 44.5.1；仓库期望的 Node 24 未另行验证。根依赖使用 `pnpm install --frozen-lockfile`，模板使用 `npm ci --ignore-scripts`。Electron 下载未完成，复用原树同版本的二进制到候选依赖目录；源码与锁文件没有为此更改。

| 检查                 | 结果与证据                                                                                                                                                                                                          |
| -------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 文档入口、类型与构建 | `node scripts/check-docs.mjs`、`pnpm typecheck`、`pnpm build` 通过；[检查索引](final-validation/checks.json)、[最终类型检查](final-validation/typecheck-final.txt)                                                  |
| 产品及工具测试       | `pnpm test` 通过：82 文件 / 723 测试通过，15 跳过；另 27 打包逻辑、6 构建目录测试通过；[原始日志](final-validation/test.txt)                                                                                        |
| 定向负例与迁移       | 11 文件 / 195 测试通过；双来源 schema3 原始红测 2 失败，修复后 3 文件 / 20 测试通过；[绿测](coder-validation/schema3-dual-source-green.txt)                                                                         |
| 固定离线基线         | `pnpm baseline:selftest` 12/12 通过；[日志](final-validation/baseline-selftest.txt)，不代表真实模型完成任务                                                                                                         |
| 标准模板             | `npm run check` 11 通过、`npm run test:agent` 7 通过，模板哈希、生产桥接剔除和 Agent 构建存在性检查通过；执行证据见[实现记录](coder-validation/implementation-report.md)                                            |
| Electron 窗口        | 最终 `pnpm exec playwright test`：87 通过、14 跳过；[日志](final-validation/e2e-final.txt)、[命令结果](final-validation/e2e-final-result.json)。复用首轮成功构建，仅 E2E 步骤更改；live/packaged 项按范围跳过       |
| UI 静态审计          | premium strict 0 findings；[报告](final-validation/premium-final.json)。真实截图另作目视复核，不以此报告代替窗口验证                                                                                                |
| 全树 lint / 格式     | `failed`：初始与最终 lint 均 217 个错误，逐文件/规则无新增。最终格式 801，初始为 794，新增的 7 个均为导入历史证据的原字节文件；当前新增/修改源码与规范的定向检查通过。详见[差异](final-validation/check-delta.json) |

全量暂存 diff 的 whitespace 检查也命中保留原字节的 patch 和命令日志；当前源码、测试与规范路径的定向 `git diff --cached --check` 通过，详见[分项结果](final-validation/staged-diff-check-summary.json)。

全树检查命中封存 probe、历史源文件与既有固定基线；遵守 CONTRIBUTING，保留原字节和失败状态，不删除断言或扩大 ignore 来制造通过。`pnpm check` 不能称为通过，也不能将本分支称为全部 CI 绿色。

## 验收边界

本轮未执行真实模型、sandbox live、签名/公证、打包 App 验收或发布；没有将历史 live 记录计为当前版本结果。Electron 用例验证本地真实窗口、Main 路径及明确标记的 fixture/harness，不能证明当前真实模型完成比赛任务。完整比赛闭环与独立业务验证仍是现有产品缺口；用户接受为 `not_run`。

`final-validation/tested-source-hashes.json` 固定本轮测试对应的 369 个源码、测试及配置文件。后续文档整理及本地提交不改变这些字节；若源文件再次变化，相关验证须重跑。

## 窗口复核

首轮 Electron 中 App 三项用例均通过；[浅色窄窗编辑](screens/space-app-editor-narrow.png)和[深色长文本/IME](screens/space-app-editor-dark-long-ime.png)经过实际图像复核：标题、名称/说明字段、保存与取消按钮可见可达，长说明在字段内滚动。浅色图下方 sbx 不可用提示来自刻意缺失执行器的负例，证明失败草稿与已登记 App 可继续编辑，不是 live 成功截图。

首轮完整 suite 另有一项 Workshop 用例未适配本窗空间选择，已保留[原始失败](final-validation/e2e-first.txt)和错误上下文。修订仅为 E2E 交互步骤，产品源码未改；完整 Workshop 文件定向 3/3 通过，取消、空空间可用和迟到失败归属断言保持。

结束前核对测试对应的 369 个源码/测试/配置哈希未漂移。候选文件按私钥、OpenAI/GitHub token 与 AWS access key 的四组格式检查未命中，单文件无超过 50 MiB；这项有限模式检查不是完整安全审计，见[记录](publication-scan-final.json)。
