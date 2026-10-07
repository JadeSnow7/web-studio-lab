# Web Studio Lab 参赛源稿证据索引

本文配套 [作品介绍源稿](oschina-2026.md)。证据截止日期为 2026-10-07；仓库事实固定在提交 `2466936454658153e47a430ce1da853826f69f69`。相对路径方便本地审阅，固定提交链接供 PDF 和外部审阅使用。

## 快照与判定规则

| 字段 | 值 |
| --- | --- |
| 仓库快照 | `2466936454658153e47a430ce1da853826f69f69` |
| 产品起点 | `536f0a1948e522a09310aa20784ec512476dc7be` |
| 当前方法归档 runId | `78531515-547a-4d5e-a572-ff6efbf2a80b` |
| 归档中的方法修复前 HEAD | `81efecd5c27c94e853db40db206603f1affe5bdc` |
| 当前基准 SHA-256 | `e6e980c11e0ac84baf26c52b5724a9a6706e3de480494aba549293425a2ab928` |
| 当前任务 SHA-256 | `d3e338da7ff71fa7b69dbe778f9e50d1ea904079f359aaf8f3025b5c08180dcf` |
| 当前 manifest SHA-256 | `1aa8af00d1f6028b60286e3912f44218f781ae286fed0253b14df59ca8cce5c8` |

receipt 的 `methodRevisionBase` 和 environment 的 `gitHead` 属于归档时的现场。方法修复当时未提交，manifest 用逐文件 SHA-256 绑定实际基准；本文的仓库快照包含后来合并的内容，不能替换归档 HEAD。

“源码已存在”“合成自检通过”“真实产品运行通过”分别使用各自证据。`failed / target_missing / performed=false` 始终保留原判定，不改写为通过、跳过或已执行的真实产品测试。哈希完整性不等于执行真实性。

## 论点与证据对应

| 源稿论点 | 索引 | 可以支持的范围 |
| --- | --- | --- |
| Electron 产品未实现；双区与 TS 应用层为规划 | E01 | 本仓库当前状态与 README 的明确边界 |
| VS001 固定目标、职责分工与首个 slice 范围 | E02-E04 | 契约、fixture 和冻结成功条件 |
| 页面观察、独立断言与证据校验已有代码 | E05-E07 | 验收端源码及合成反例，非真实 Electron 正向运行 |
| 复现环境、安装与类型检查 | E08-E10 | 固定依赖、归档命令和原始结果 |
| 自检 8/8；B01-B05 全部失败且未执行 | E09-E10 | 方法修复后的同一归档运行 |
| 方法修复与历史证据保留 | E09、E11 | 新旧方法指纹及归档适用范围 |
| Apache-2.0、上游边界、现有治理与缺项 | E12 | 当前文件和目录，不证明成熟社区治理 |
| 评分结构、截止与提交材料 | E13 | 赛事规则的来源与本轮核验限制 |

## 逐项来源

### E01

**仓库状态与规划边界。**

- [本地 README](../../README.md) / [固定 README](https://github.com/JadeSnow7/web-studio-lab/blob/2466936454658153e47a430ce1da853826f69f69/README.md)。明示当前没有可运行 Electron 应用；产品能力均为规划目标。
- [固定目录快照](https://github.com/JadeSnow7/web-studio-lab/tree/2466936454658153e47a430ce1da853826f69f69) / [快照提交](https://github.com/JadeSnow7/web-studio-lab/commit/2466936454658153e47a430ce1da853826f69f69)。包含测试和 fixture，没有 `src/vertical-slice/adapter.ts` 或 Electron 产品入口。

不能支持：已实现桌面工作台、统一 AI 观察产品、完整 IDE、安装包或真实 Agent 闭环。

### E02

**冻结场景、五项验收与执行边界。**

[本地 VS001](../acceptance/VS001.md) / [固定 VS001](https://github.com/JadeSnow7/web-studio-lab/blob/2466936454658153e47a430ce1da853826f69f69/docs/acceptance/VS001.md)。任务只改运行副本的 `src/App.tsx`，一次真实 harness 会话；验收端独立观察与截图。首个 slice 不要求完整 Workshop、编辑器、交互终端、Hono API、多模板或安装包。

这些是成功条件及未来 adapter 的要求，不能作为已经成功执行的证据。

### E03

**实际数据契约。**

[本地 contracts.ts](../../tests/vertical-slice/contracts.ts) / [固定 contracts.ts](https://github.com/JadeSnow7/web-studio-lab/blob/2466936454658153e47a430ce1da853826f69f69/tests/vertical-slice/contracts.ts)。`taskSchema`、`productEventSchema`、`identitySchema`、`rawLogSchema` 和 `observationSchema` 是严格运行时结构；`ExecuteTask` / `AdapterContext` 定义产品接点职责。文档不另立字段定义或放宽目标。

### E04

**固定页面输入。**

[本地页面](../../fixtures/vertical-slice/page/src/App.tsx) / [固定 fixture 目录](https://github.com/JadeSnow7/web-studio-lab/tree/2466936454658153e47a430ce1da853826f69f69/fixtures/vertical-slice/page)。初始标题为 `Hello baseline`，选择器为 `[data-testid="greeting"]`。fixture 是测试输入，不是 Electron 产品或已完成的 Agent 产出。

### E05

**验收调度、CDP 观察与独立断言源码。**

- [本地 run.ts](../../tests/vertical-slice/run.ts) / [固定 run.ts](https://github.com/JadeSnow7/web-studio-lab/blob/2466936454658153e47a430ce1da853826f69f69/tests/vertical-slice/run.ts)：创建副本、分类结果、注册清理和写出报告；入口不存在时五项均设为 failed，performed=false。
- [本地 cdp.ts](../../tests/vertical-slice/cdp.ts) / [固定 cdp.ts](https://github.com/JadeSnow7/web-studio-lab/blob/2466936454658153e47a430ce1da853826f69f69/tests/vertical-slice/cdp.ts)：回环地址边界、Electron discovery、指定 target、导航、原始协议记录与 PNG 采集代码。
- [本地 postcondition.ts](../../tests/vertical-slice/postcondition.ts) / [固定 postcondition.ts](https://github.com/JadeSnow7/web-studio-lab/blob/2466936454658153e47a430ce1da853826f69f69/tests/vertical-slice/postcondition.ts)：URL/runId/就绪状态、唯一性、可见性、精确文本及观测异常断言。

归档没有执行真实 CDP 路径；源码审阅和合成 transport 自检不能证明真实 Electron 集成通过。`webContentsId → targetId` 映射还需审阅未来产品代码。

### E06

**证据绑定与完整性核验源码。**

[本地 evidence.ts](../../tests/vertical-slice/evidence.ts) / [固定 evidence.ts](https://github.com/JadeSnow7/web-studio-lab/blob/2466936454658153e47a430ce1da853826f69f69/tests/vertical-slice/evidence.ts)。关键入口是 `baselineFingerprint`、`ProductTranscript`、`verifyManifest`，覆盖基准指纹、事件顺序与身份、产物字节数和哈希等检查。

完整性检查能发现缺失、改变与串用；无法密码学证明 harness 来源、执行者诚实或产品身份映射。

### E07

**合成自检范围。**

[本地 selftest.test.ts](../../tests/vertical-slice/selftest.test.ts) / [固定自检源码](https://github.com/JadeSnow7/web-studio-lab/blob/2466936454658153e47a430ce1da853826f69f69/tests/vertical-slice/selftest.test.ts)。八项均显式标注 synthetic，覆盖严格契约、postcondition 反例、串用/顺序/生命周期、改动边界、manifest 以及空 DOM、loading、错误 URL 和单匹配等判定逻辑。通过记录见 E10；不是 B01-B05 的真实产品运行。

### E08

**依赖、命令和类型检查范围。**

- [本地 package.json](../../package.json) / [固定清单](https://github.com/JadeSnow7/web-studio-lab/blob/2466936454658153e47a430ce1da853826f69f69/package.json)：Node.js ≥22.12、typecheck/selftest/baseline 入口及固定版本。
- [本地锁文件](../../package-lock.json) / [固定锁文件](https://github.com/JadeSnow7/web-studio-lab/blob/2466936454658153e47a430ce1da853826f69f69/package-lock.json)。
- [本地 tsconfig](../../tsconfig.json) / [固定 tsconfig](https://github.com/JadeSnow7/web-studio-lab/blob/2466936454658153e47a430ce1da853826f69f69/tsconfig.json)：检查 src 的 TS/TSX、测试与 fixture。
- [验收使用说明](../acceptance/README.md) / [固定说明](https://github.com/JadeSnow7/web-studio-lab/blob/2466936454658153e47a430ce1da853826f69f69/docs/acceptance/README.md)。

当前没有实际 adapter 可供编译；将 src 纳入范围不等于已经实现 adapter 或自动验证任意动态导出。

### E09

**2026-10-07 当前方法回执与运行现场。**

[固定当前归档目录](https://github.com/JadeSnow7/web-studio-lab/tree/2466936454658153e47a430ce1da853826f69f69/docs/acceptance/preimplementation/78531515-547a-4d5e-a572-ff6efbf2a80b)。

- [本地 receipt](../acceptance/preimplementation/78531515-547a-4d5e-a572-ff6efbf2a80b/receipt.json) / [固定 receipt](https://github.com/JadeSnow7/web-studio-lab/blob/2466936454658153e47a430ce1da853826f69f69/docs/acceptance/preimplementation/78531515-547a-4d5e-a572-ff6efbf2a80b/receipt.json)：run、任务/基准/manifest 指纹、产品起点、方法修订起点及命令输出哈希。
- [本地 environment](../acceptance/preimplementation/78531515-547a-4d5e-a572-ff6efbf2a80b/run/environment.json) / [固定 environment](https://github.com/JadeSnow7/web-studio-lab/blob/2466936454658153e47a430ce1da853826f69f69/docs/acceptance/preimplementation/78531515-547a-4d5e-a572-ff6efbf2a80b/run/environment.json)：darwin / arm64 / Node v26.5.0、归档 HEAD、未提交方法修复、adapter 哈希为 null。
- [本地 manifest](../acceptance/preimplementation/78531515-547a-4d5e-a572-ff6efbf2a80b/run/manifest.json) / [固定 manifest](https://github.com/JadeSnow7/web-studio-lab/blob/2466936454658153e47a430ce1da853826f69f69/docs/acceptance/preimplementation/78531515-547a-4d5e-a572-ff6efbf2a80b/run/manifest.json)：逐文件基准与产物指纹。

### E10

**2026-10-07 原始判定与命令输出。**

[固定 commands 目录](https://github.com/JadeSnow7/web-studio-lab/tree/2466936454658153e47a430ce1da853826f69f69/docs/acceptance/preimplementation/78531515-547a-4d5e-a572-ff6efbf2a80b/commands)。

| 原始文件 | 可直接读到的结果 |
| --- | --- |
| [typecheck.json](../acceptance/preimplementation/78531515-547a-4d5e-a572-ff6efbf2a80b/commands/typecheck.json) | 命令退出 0 |
| [selftest.json](../acceptance/preimplementation/78531515-547a-4d5e-a572-ff6efbf2a80b/commands/selftest.json) 与 [selftest.stdout.txt](../acceptance/preimplementation/78531515-547a-4d5e-a572-ff6efbf2a80b/commands/selftest.stdout.txt) | 8 pass、0 fail、0 skipped、0 todo，退出 0 |
| [baseline.json](../acceptance/preimplementation/78531515-547a-4d5e-a572-ff6efbf2a80b/commands/baseline.json) | 命令退出 1 |
| [run/report.json](../acceptance/preimplementation/78531515-547a-4d5e-a572-ff6efbf2a80b/run/report.json) / [固定 report](https://github.com/JadeSnow7/web-studio-lab/blob/2466936454658153e47a430ce1da853826f69f69/docs/acceptance/preimplementation/78531515-547a-4d5e-a572-ff6efbf2a80b/run/report.json) | B01-B05 全部 failed、code=target_missing、performed=false；identity=null |

receipt 的解释字段明确：未调用 Agent、启动 Electron、执行 CDP 观察或生成截图。不存在可以引用为本次正向结果的截图或演示视频。空日志边界不表示观察到了“没有运行异常”。

### E11

**2026-10-06 历史方法归档。**

[本地旧 receipt](../acceptance/preimplementation/d1c9bc9e-4092-4697-83cf-d52d334b7686/receipt.json) / [固定旧归档](https://github.com/JadeSnow7/web-studio-lab/tree/2466936454658153e47a430ce1da853826f69f69/docs/acceptance/preimplementation/d1c9bc9e-4092-4697-83cf-d52d334b7686)。旧自检 5/5，产品五项仍失败；旧基准 SHA-256 为 `92ac18313e5a30a5d72570c138f27ac41d6727d80a74f7bcff085cb67f318f6a`。旧内容与回执保留，不当作当前方法的相同指纹复验。

### E12

**许可、来源与现有治理边界。**

- [本地 LICENSE](../../LICENSE) / [固定 LICENSE](https://github.com/JadeSnow7/web-studio-lab/blob/2466936454658153e47a430ce1da853826f69f69/LICENSE)：Apache License 2.0。
- [固定 README 的来源边界](https://github.com/JadeSnow7/web-studio-lab/blob/2466936454658153e47a430ce1da853826f69f69/README.md)：独立历史、未迁入上游代码、迁移时保留来源与许可的原则。
- [本地 .gitignore](../../.gitignore) / [固定 .gitignore](https://github.com/JadeSnow7/web-studio-lab/blob/2466936454658153e47a430ce1da853826f69f69/.gitignore)：运行记录、构建、环境与常见凭据排除规则。
- [上游固定提交](https://github.com/JadeSnow7/Web-Studio/tree/f377db874f0ecba3390804146776b5e5786d2f86)：仅作 README 指明的参考来源，不借用其能力作为 Lab 运行证明。

E01 的目录快照中没有 CONTRIBUTING、安全流程、CI workflow 或独立第三方许可清单。当前不据此宣称成熟治理、团队分工、社区规模或依赖安全审计已完成。

### E13

**赛事条款与报名状态。**

[2026 上海开源软件应用创新大赛官网](https://www.oschina.net/os2026/)，核验日期 2026-10-07。

- 本轮官方页面搜索索引支持：作品材料截止为 10 月 16 日 24:00；组委会审核后发报名确认邮件；收到确认后按指引提交完整可运行代码的仓库链接、介绍文档（推荐 PDF）和核心功能演示视频链接。
- 四项维度及权重采用本次任务提供的 2026-10-07 核验记录：技术创新 30%、场景落地 30%、开源治理 20%、长期发展 20%。直接页面抓取本轮未取得赛事正文，不声称保存了官网完整快照；正式提交前再核对官网或确认邮件。
- 未访问报名确认邮件，不把公开仓库、稿件、合并 PR 或其他赛事登记当作本赛事报名证明。
- 官网所列截止未在已取得条款中明确时区。源稿按北京时间安排准备工作，实际要求以确认邮件或主办方通知为准。

## 后续证据更新规则

1. 在独立产品实现完成后引用新的真实运行目录、产品提交与版本；不要更改当前或历史实现前回执。
2. 只有全部检查实际执行并通过后，才能新增“VS001 固定场景通过”的描述；保持结论范围与场景一致。
3. 分别补充演示视频的可访问链接、对应提交/run、启动说明、正式 PDF 和实际报名信息，不以概念图或合成样本替代。
4. 本文与投稿稿不进入 `baselineFingerprint` 的文件集合；新增这些文档不应改变现有基准指纹。
